// Probe the REAL collateral->debt swap pairs the bot would actually need.
//
// For each chain: take the live watchlist (HF<1.25 + debt>=floor wallets — the
// actual near-liquidation set), resolve each wallet's primary collateral + primary
// debt exactly as enrichCandidateBatched does (largest usage-enabled aToken =>
// collateral; preferred-or-largest debt). Tally distinct (collateral,debt) pairs.
// Then, for each distinct pair, check whether the PROPOSED V3 factory has a pool
// for the swap the contract would build (direct at any fee tier, else 2-hop via
// WNATIVE) — mirroring AaveLiquidatorSwapRouter02._resolveSwapPath. Also report
// whether a V2 pair exists (informational, for the multi-venue decision).
//
// Read-only. Uses the droplet-copied watchlists in data/droplet/.

const fs = require("fs");
const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { aggregate3InBatches } = require("../src/multicall");

const FEE_TIERS = [100, 500, 3000, 10000];
const DP_IFACE = new ethers.utils.Interface([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);
const POOL_IFACE = new ethers.utils.Interface([
  "function getReservesList() view returns (address[])",
]);
const ERC20_IFACE = new ethers.utils.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const V2_FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const ROUTER_ABI = ["function factory() view returns (address)"];

// Proposed correct V3 router+factory per chain (verified by probeSwapVenue.js).
const PROPOSED_V3 = {
  arbitrum: { router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984" },
  optimism: { router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984" },
  base: { router: "0x2626664c2603336E57B271c5C0b26F421741e481", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" },
  avalanche: { router: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE", factory: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD" },
  // plasma already V3-correct; use the configured router/factory.
  plasma: { router: "0x807F4E281B7A3B324825C64ca53c69F0b418dE40", factory: "0xcb2436774C3e191c85056d248EF4260ce5f27A9D" },
  // Scroll: official Uniswap V3 (deployments list). Verifying collateral coverage before send-enabling.
  scroll: { router: "0xfC30937f5cDe93Df8d48aCAF7e6f5D8D8A31F636", factory: "0x70C62C8b8e801124A4Aa81ce07b637A3e83cb919" },
};

// Limit how many watchlist wallets to resolve per chain (lowest-HF would be ideal
// but the watchlist isn't HF-sorted; sample the head, which is large enough to
// surface the collateral mix). Override with PROBE_LIMIT.
const LIMIT = parseInt(process.env.PROBE_LIMIT || "400", 10);

function provFor(cfg) {
  return new ethers.providers.JsonRpcProvider(cfg.rpcUrl);
}

const metaCache = new Map();
async function meta(provider, asset) {
  const k = asset.toLowerCase();
  if (metaCache.has(k)) return metaCache.get(k);
  let symbol = "?", decimals = 18;
  try { symbol = await new ethers.Contract(asset, ERC20_IFACE, provider).symbol(); } catch (_) {}
  try { decimals = await new ethers.Contract(asset, ERC20_IFACE, provider).decimals(); } catch (_) {}
  const m = { symbol, decimals };
  metaCache.set(k, m);
  return m;
}

async function resolvePairsForChain(cfg, provider, users) {
  const dp = cfg.protocolDataProvider;
  const pool = new ethers.Contract(cfg.pool, POOL_IFACE, provider);
  const reserves = await pool.getReservesList();
  const preferredDebt = (cfg.debtAssetAddress || "").toLowerCase();

  // Build one big multicall: reserves x users of getUserReserveData.
  const calls = [];
  for (const user of users) {
    for (const asset of reserves) {
      calls.push({
        target: dp,
        allowFailure: true,
        callData: DP_IFACE.encodeFunctionData("getUserReserveData", [asset, user]),
      });
    }
  }
  const raw = await aggregate3InBatches(provider, calls, 300);

  // pairKey "collat|debt" -> { collat, debt, count }
  const pairs = new Map();
  let idx = 0;
  for (let u = 0; u < users.length; u++) {
    let preferredDebtEntry = null, bestDebtEntry = null, bestCollateral = null;
    for (let r = 0; r < reserves.length; r++) {
      const asset = reserves[r];
      const entry = raw[idx++];
      if (!entry || !entry.success || !entry.returnData || entry.returnData === "0x") continue;
      let d;
      try { d = DP_IFACE.decodeFunctionResult("getUserReserveData", entry.returnData); } catch (_) { continue; }
      const debt = d.currentStableDebt.add(d.currentVariableDebt);
      if (debt.gt(0)) {
        if (asset.toLowerCase() === preferredDebt) preferredDebtEntry = { asset, debt };
        else if (!bestDebtEntry || debt.gt(bestDebtEntry.debt)) bestDebtEntry = { asset, debt };
      }
      if (d.currentATokenBalance.gt(0) && d.usageAsCollateralEnabled &&
          (!bestCollateral || d.currentATokenBalance.gt(bestCollateral.balance))) {
        bestCollateral = { asset, balance: d.currentATokenBalance };
      }
    }
    const chosenDebt = preferredDebtEntry || bestDebtEntry;
    if (!chosenDebt || !bestCollateral) continue;
    const collat = bestCollateral.asset.toLowerCase();
    const debt = chosenDebt.asset.toLowerCase();
    if (collat === debt) continue; // no swap needed
    const key = `${collat}|${debt}`;
    if (!pairs.has(key)) pairs.set(key, { collat, debt, count: 0 });
    pairs.get(key).count++;
  }
  return pairs;
}

async function v3PoolExists(provider, factory, a, b) {
  const c = new ethers.Contract(factory, V3_FACTORY_ABI, provider);
  for (const fee of FEE_TIERS) {
    try {
      const p = await c.getPool(a, b, fee);
      if (p && p !== ethers.constants.AddressZero) return fee;
    } catch (_) {}
  }
  return 0;
}

async function v2PairExists(provider, factory, a, b) {
  try {
    const c = new ethers.Contract(factory, V2_FACTORY_ABI, provider);
    const p = await c.getPair(a, b);
    return p && p !== ethers.constants.AddressZero ? p : null;
  } catch (_) { return null; }
}

async function main() {
  const cfgs = getSelectedChainConfigs();
  for (const cfg of cfgs) {
    const key = cfg.key;
    const provider = provFor(cfg);
    const wl = JSON.parse(fs.readFileSync(`data/droplet/watchlist-${key}.json`, "utf8"));
    const users = (wl.watch || []).slice(0, LIMIT);
    const wnative = (cfg.wrappedNative || "").toLowerCase();
    console.log(`\n================ ${key} ================`);
    console.log(`watchlist total=${wl.count}, resolving first ${users.length}`);

    let pairs;
    try {
      pairs = await resolvePairsForChain(cfg, provider, users);
    } catch (e) {
      console.log(`  ERROR resolving pairs: ${e.message}`);
      continue;
    }

    const sorted = [...pairs.values()].sort((a, b) => b.count - a.count);
    console.log(`  distinct collateral->debt pairs needing swap: ${sorted.length}`);

    const prop = PROPOSED_V3[key];
    const v3Factory = prop ? prop.factory : null;
    // V2 factory of the CURRENTLY configured router (informational).
    let v2Factory = null;
    try { v2Factory = await new ethers.Contract(cfg.swapRouter, ROUTER_ABI, provider).factory(); } catch (_) {}

    for (const p of sorted) {
      const cm = await meta(provider, p.collat);
      const dm = await meta(provider, p.debt);
      // direct V3
      const directFee = v3Factory ? await v3PoolExists(provider, v3Factory, p.collat, p.debt) : 0;
      let route = directFee ? `V3 direct fee=${directFee}` : null;
      if (!route && v3Factory && wnative && p.collat !== wnative && p.debt !== wnative) {
        const f1 = await v3PoolExists(provider, v3Factory, p.collat, wnative);
        const f2 = await v3PoolExists(provider, v3Factory, wnative, p.debt);
        if (f1 && f2) route = `V3 2-hop via WNATIVE (${f1},${f2})`;
      }
      // V2 fallback info
      let v2info = "";
      if (!route && v2Factory) {
        const direct2 = await v2PairExists(provider, v2Factory, p.collat, p.debt);
        if (direct2) v2info = ` | V2 direct pair EXISTS`;
        else if (wnative && p.collat !== wnative && p.debt !== wnative) {
          const a = await v2PairExists(provider, v2Factory, p.collat, wnative);
          const b = await v2PairExists(provider, v2Factory, wnative, p.debt);
          if (a && b) v2info = ` | V2 2-hop via WNATIVE exists`;
        }
      }
      const status = route ? `✅ ${route}` : `❌ NO V3 PATH${v2info}`;
      console.log(`    [${String(p.count).padStart(4)}] ${cm.symbol}(${p.collat.slice(0,8)}) -> ${dm.symbol}(${p.debt.slice(0,8)})  ${status}`);
    }
  }
  console.log("\nDONE");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
