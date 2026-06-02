require("dotenv").config();

const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { loadBorrowerSet } = require("../src/borrowerStore");
const { getUnhealthyPositions } = require("../aaveHelpers");

// Reality check for the liquidator's discovery.
//
// Ground truth = Aave's LiquidationCall events (who actually got liquidated).
// We compare those users against our PERSISTED borrower store to answer the
// only question that matters: "after the backfill, are the wallets that get
// liquidated actually in the candidate set we scan every cycle?"
//
// Success metric: a high share of recently-liquidated wallets are present in
// the store. (Pre-fix this was ~3% on Arbitrum; the backfill should make it
// high.) We also time one live scan cycle per chain.

const LIQUIDATION_ABI = [
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
];

// Roughly how many blocks ~12h is, per chain (block times differ a lot).
const APPROX_BLOCKS_12H = {
  plasma: 43200,
  arbitrum: 172800,
  base: 21600,
  optimism: 21600,
  avalanche: 17280,
};

// Set TIME_CYCLE=false to skip the live getUnhealthyPositions timing (faster).
const TIME_CYCLE = process.env.TIME_CYCLE !== "false";

async function scanLiquidatedUsers(provider, chainConfig, current) {
  const window = Math.min(APPROX_BLOCKS_12H[chainConfig.key] || 50000, 200000);
  const fromBlock = Math.max(current - window, 0);
  const chunk = chainConfig.borrowScanChunkSize || 10000;
  const pool = new ethers.Contract(chainConfig.pool, LIQUIDATION_ABI, provider);

  const users = new Set();
  let count = 0;
  let partialError = null;
  for (let start = fromBlock; start <= current; start += chunk) {
    const end = Math.min(start + chunk - 1, current);
    try {
      const found = await pool.queryFilter(pool.filters.LiquidationCall(), start, end);
      for (const ev of found) {
        count++;
        users.add(ev.args.user.toLowerCase());
      }
    } catch (e) {
      partialError = e.message;
    }
  }
  return { window, liquidationCount: count, uniqueLiquidatedUsers: users, partialError };
}

async function main() {
  const chains = getSelectedChainConfigs(process.env.DIAG_CHAINS || process.env.CHAINS);
  const summary = [];

  for (const chainConfig of chains) {
    const out = { chain: chainConfig.key, name: chainConfig.name };
    try {
      const provider = createProvider(chainConfig);
      const current = await provider.getBlockNumber();

      // Snapshot the persisted store BEFORE any scan this script triggers, so
      // coverage reflects the real backfill state, not a side effect of this run.
      const store = loadBorrowerSet(chainConfig.key);
      out.storeBorrowers = store.borrowers.size;
      out.storeLastScannedBlock = store.lastScannedBlock;
      out.storeStale = store.lastScannedBlock ? current - store.lastScannedBlock : null;

      const { window, liquidationCount, uniqueLiquidatedUsers, partialError } =
        await scanLiquidatedUsers(provider, chainConfig, current);

      out.currentBlock = current;
      out.windowBlocks = window;
      out.liquidationCount = liquidationCount;
      out.uniqueLiquidatedUsers = uniqueLiquidatedUsers.size;
      if (partialError) out.partialError = partialError;

      // The success metric: overlap between liquidated users and our store.
      let covered = 0;
      const missed = [];
      for (const u of uniqueLiquidatedUsers) {
        if (store.borrowers.has(u)) covered++;
        else missed.push(u);
      }
      out.liquidatedUsersInStore = covered;
      out.liquidatedUsersMissed = missed.length;
      out.coveragePct =
        uniqueLiquidatedUsers.size > 0
          ? Math.round((covered / uniqueLiquidatedUsers.size) * 1000) / 10
          : null;
      out.sampleMissed = missed.slice(0, 5);

      // Time one real discovery cycle (incremental scan + parallel HF sweep).
      if (TIME_CYCLE) {
        const t0 = Date.now();
        const positions = await getUnhealthyPositions(provider, chainConfig);
        out.cycleMs = Date.now() - t0;
        out.liquidatablePositionsNow = positions.length;
      }
    } catch (err) {
      out.error = err.message;
    }
    summary.push(out);
    console.log(JSON.stringify(out, null, 2));
  }

  // Compact verdict line per chain + overall.
  console.log("\n=== REALITY CHECK SUMMARY ===");
  let totalLiq = 0;
  let totalCovered = 0;
  for (const s of summary) {
    if (s.error) {
      console.log(`${s.chain.padEnd(10)} ERROR: ${s.error}`);
      continue;
    }
    totalLiq += s.uniqueLiquidatedUsers || 0;
    totalCovered += s.liquidatedUsersInStore || 0;
    const cov = s.coveragePct === null ? "n/a (no liquidations in window)" : `${s.coveragePct}%`;
    const cycle = s.cycleMs !== undefined ? `${s.cycleMs}ms` : "skipped";
    console.log(
      `${s.chain.padEnd(10)} store=${String(s.storeBorrowers).padEnd(6)} ` +
        `liquidated=${String(s.uniqueLiquidatedUsers).padEnd(4)} ` +
        `coverage=${String(cov).padEnd(8)} cycle=${cycle}`
    );
  }
  const overall = totalLiq > 0 ? Math.round((totalCovered / totalLiq) * 1000) / 10 : null;
  console.log(
    `\nOVERALL coverage: ${overall === null ? "n/a" : overall + "%"} ` +
      `(${totalCovered}/${totalLiq} recently-liquidated wallets present in stores)`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
