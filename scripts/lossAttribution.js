require("dotenv").config();

// LOSS ATTRIBUTION (read-only, on-demand). For each recently-liquidated Aave
// position, classify WHY we didn't win it using the current borrower/near/watch/hot
// files. This is approximate unless run against pre-liquidation snapshots, because
// users may drop out of hot tiers after another liquidator repays debt.
//
//   WON          — our wallet is the `liquidator` on the LiquidationCall.
//   DETECT loss  — the user was NOT in our persisted borrower store (we never
//                  would have looked at them) → discovery gap.
//   COLD/WARM gap — user was in the store but NOT in near (only slower sweeps).
//   NEAR-only      — user was in near but not watch.
//   WATCH-only     — user was in watch but not hot.
//   HOT race       — user was in hot but a competitor still landed it.
//
// This answers the question that gates Batch 4: are we losing because we don't
// SEE the targets (Detect — needs discovery/coverage work) or because we see them
// but lose the race (Decide/Deliver — needs per-block triggers / faster send /
// gas)? Pre-block-trigger, expect mostly DETECT + same-block atomic. Only invest
// in 4.3 (pre-staging) etc. if DECIDE/DELIVER is where the sizeable losses are.
//
// Usage:
//   node scripts/lossAttribution.js                 # all CHAINS, default window
//   node scripts/lossAttribution.js base            # one chain
//   MIN_DEBT_USD=100 node scripts/lossAttribution.js
//
// Run on the droplet per chain (each container has its own RPC/env):
//   docker exec bot-base node scripts/lossAttribution.js base

const { ethers } = require("ethers");
const { getSelectedChainConfigs, getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { loadBorrowerSet, loadWatchlist, loadNear, loadHot } = require("../src/borrowerStore");
const { resolveChainMinDebtUsd } = require("../aaveHelpers");

const LIQUIDATION_ABI = [
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
];

const APPROX_BLOCKS_12H = {
  plasma: 43200, arbitrum: 172800, base: 21600, optimism: 21600, avalanche: 17280,
};

function ourWallet() {
  try { return new ethers.Wallet(process.env.PRIVATE_KEY).address.toLowerCase(); }
  catch (_) { return null; }
}

async function scanLiquidations(provider, chainConfig, current) {
  const window = Math.min(APPROX_BLOCKS_12H[chainConfig.key] || 50000, 200000);
  const fromBlock = Math.max(current - window, 0);
  const chunk = chainConfig.borrowScanChunkSize || 10000;
  const pool = new ethers.Contract(chainConfig.pool, LIQUIDATION_ABI, provider);
  const events = [];
  for (let start = fromBlock; start <= current; start += chunk) {
    const end = Math.min(start + chunk - 1, current);
    try {
      const found = await pool.queryFilter(pool.filters.LiquidationCall(), start, end);
      for (const ev of found) {
        events.push({
          user: ev.args.user.toLowerCase(),
          liquidator: ev.args.liquidator.toLowerCase(),
          debtToCover: ev.args.debtToCover,
          block: ev.blockNumber,
        });
      }
    } catch (_) {}
  }
  return { window, events };
}

async function classifyChain(chainConfig, liquidatorAddr) {
  const provider = createProvider(chainConfig);
  const current = await provider.getBlockNumber();
  const { window, events } = await scanLiquidations(provider, chainConfig, current);

  const { borrowers } = loadBorrowerSet(chainConfig.key);
  const { watch } = loadWatchlist(chainConfig.key);
  const { near } = loadNear(chainConfig.key);
  const { hot } = loadHot(chainConfig.key);
  const minDebtUsd = resolveChainMinDebtUsd(chainConfig);

  // We only care about SIZEABLE liquidations (dust is economically meaningless and
  // dominated by same-block MEV clusters). debtToCover is in the debt asset's
  // units; for USDC-like 6dp debt this ≈ USD. Filter with a units≈USD heuristic.
  const debtDecimals = 6; // configured debt is USDC/USDT (6dp) on all active chains
  const sizeableEvents = events.filter((e) => {
    const units = parseFloat(ethers.utils.formatUnits(e.debtToCover, debtDecimals));
    return units >= minDebtUsd;
  });

  const buckets = { won: 0, detect: 0, coldWarmGap: 0, nearOnly: 0, watchOnly: 0, hotRace: 0 };
  const examples = { detect: [], coldWarmGap: [], nearOnly: [], watchOnly: [], hotRace: [] };
  for (const e of sizeableEvents) {
    if (liquidatorAddr && e.liquidator === liquidatorAddr) { buckets.won++; continue; }
    if (!borrowers.has(e.user)) {
      buckets.detect++;
      if (examples.detect.length < 3) examples.detect.push(e.user);
    } else if (!near.has(e.user)) {
      buckets.coldWarmGap++;
      if (examples.coldWarmGap.length < 3) examples.coldWarmGap.push(e.user);
    } else if (!watch.has(e.user)) {
      buckets.nearOnly++;
      if (examples.nearOnly.length < 3) examples.nearOnly.push(e.user);
    } else if (!hot.has(e.user)) {
      buckets.watchOnly++;
      if (examples.watchOnly.length < 3) examples.watchOnly.push(e.user);
    } else {
      buckets.hotRace++;
      if (examples.hotRace.length < 3) examples.hotRace.push(e.user);
    }
  }

  return {
    chain: chainConfig.name,
    window,
    storeSize: borrowers.size,
    nearSize: near.size,
    watchSize: watch.size,
    hotSize: hot.size,
    minDebtUsd,
    totalLiquidations: events.length,
    sizeable: sizeableEvents.length,
    buckets,
    examples,
  };
}

async function main() {
  const arg = process.argv[2];
  const chains = arg ? [getChainConfig(arg)] : getSelectedChainConfigs();
  const liquidatorAddr = ourWallet();
  if (!liquidatorAddr) {
    console.log("⚠️ No PRIVATE_KEY — 'won' bucket can't be computed (everything shows as a loss).");
  }

  console.log("LOSS ATTRIBUTION — sizeable liquidations we didn't win, by cause\n");
  for (const cfg of chains) {
    try {
      const r = await classifyChain(cfg, liquidatorAddr);
      const b = r.buckets;
      const lost = b.detect + b.coldWarmGap + b.nearOnly + b.watchOnly + b.hotRace;
      console.log(`━━ ${r.chain} ━━ (last ~${r.window} blocks; store ${r.storeSize}, near ${r.nearSize}, watch ${r.watchSize}, hot ${r.hotSize}, floor $${r.minDebtUsd})`);
      console.log(`   ${r.totalLiquidations} total liquidations, ${r.sizeable} sizeable (≥$${r.minDebtUsd})`);
      console.log(`   WON ${b.won}  |  LOST ${lost}  →  DETECT ${b.detect}  ·  COLD/WARM ${b.coldWarmGap}  ·  NEAR-only ${b.nearOnly}  ·  WATCH-only ${b.watchOnly}  ·  HOT-race ${b.hotRace}`);
      if (b.hotRace > 0) console.log(`     ↳ HOT race (in hot, still lost): ${r.examples.hotRace.join(", ")}`);
      if (b.watchOnly > 0) console.log(`     ↳ WATCH-only (in watch, not hot): ${r.examples.watchOnly.join(", ")}`);
      if (b.nearOnly > 0) console.log(`     ↳ NEAR-only (in near, not watch): ${r.examples.nearOnly.join(", ")}`);
      if (b.coldWarmGap > 0) console.log(`     ↳ COLD/WARM gap (in store, not near): ${r.examples.coldWarmGap.join(", ")}`);
      if (b.detect > 0) console.log(`     ↳ DETECT (never in store): ${r.examples.detect.join(", ")}`);
      console.log("     ↳ Note: current tier files are approximate after liquidation; pre-event snapshots are definitive.");
      console.log("");
    } catch (e) {
      console.log(`━━ ${cfg.name} ━━ ERROR: ${e.message}\n`);
    }
  }
  console.log("Interpretation: DETECT/COLD-WARM/NEAR/WATCH gaps → coverage/tiering work. HOT-race →");
  console.log("speed (faster send / gas / infra) OR unbeatable same-block atomic.");
  console.log("Cross-ref the bot's '📊 METRIC ev=attempt' logs for the named users to confirm.");
  process.exit(0);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
