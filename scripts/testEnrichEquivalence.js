// Verifies enrichCandidateBatched (one Multicall3 batch, 2.2) produces the SAME
// debt asset / collateral / debt amount as the original serial path
// (getPrimaryDebtPosition + getPrimaryCollateral) on real on-chain addresses.
//
// Read-only. No transactions. Uses the local active-debt index for sample users.
// Usage: node scripts/testEnrichEquivalence.js [chainKey] [count]
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const {
  enrichCandidateBatched,
  getReservesListCached,
  getPrimaryDebtPosition,
  getPrimaryCollateral,
} = require("../aaveHelpers");

const chainKey = process.argv[2] || "avalanche";
const count = parseInt(process.argv[3] || "8", 10);

function loadSampleUsers(key) {
  const dir = process.env.BORROWER_STORE_DIR || path.join(__dirname, "..", "data");
  for (const file of [`active-debt-${key}.json`, `watchlist-${key}.json`, `borrowers-${key}.json`]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const arr = j.active || j.watch || j.borrowers || [];
      if (arr.length) return arr.slice(0, count);
    } catch (_) {}
  }
  return [];
}

(async () => {
  const chainConfig = getChainConfig(chainKey);
  const provider = createProvider(chainConfig);
  const users = loadSampleUsers(chainConfig.key);
  if (!users.length) {
    console.error(`No sample users found for ${chainKey}. Run the bot once to build a store.`);
    process.exit(1);
  }

  // Pin BOTH paths to the same block height. Variable debt accrues interest every
  // block, so two unpinned live reads legitimately differ in the last few digits
  // of debtAmount (same as the documented streaming-sweep test). Pinning isolates
  // the actual logic (debt-asset + collateral SELECTION) from accrual noise.
  const blockTag = await provider.getBlockNumber();
  const origCall = provider.call.bind(provider);
  provider.call = (tx, _bt) => origCall(tx, blockTag);
  console.log(`Testing enrichment equivalence on ${users.length} ${chainConfig.name} users @ block ${blockTag}...\n`);

  const reserves = await getReservesListCached(provider, chainConfig);
  let mismatches = 0;

  for (const user of users) {
    const batched = await enrichCandidateBatched(user, provider, chainConfig, reserves);

    // Old serial path:
    const debtPos = await getPrimaryDebtPosition(user, provider, chainConfig);
    const hasDebt = debtPos.debtAmount.gt(ethers.constants.Zero);
    const collateral = hasDebt ? await getPrimaryCollateral(user, provider, chainConfig) : null;
    const serial = hasDebt && collateral
      ? {
          debtAsset: debtPos.debtAsset,
          debtAmount: debtPos.debtAmount,
          collateralAsset: collateral,
        }
      : null;

    const bothNull = !batched && !serial;
    const debtMatch = batched && serial &&
      batched.debtAsset.toLowerCase() === serial.debtAsset.toLowerCase() &&
      batched.debtAmount.eq(serial.debtAmount);
    const collMatch = batched && serial &&
      batched.collateralAsset.toLowerCase() === serial.collateralAsset.toLowerCase();

    const ok = bothNull || (debtMatch && collMatch);
    if (!ok) mismatches++;

    console.log(`${ok ? "✅" : "❌"} ${user}`);
    if (!ok) {
      console.log(`   batched:`, batched && {
        debtAsset: batched.debtAsset,
        debtAmount: batched.debtAmount.toString(),
        collateralAsset: batched.collateralAsset,
      });
      console.log(`   serial: `, serial && {
        debtAsset: serial.debtAsset,
        debtAmount: serial.debtAmount.toString(),
        collateralAsset: serial.collateralAsset,
      });
    }
  }

  console.log(`\n${mismatches === 0 ? "✅ ALL MATCH" : `❌ ${mismatches} MISMATCH(ES)`} (${users.length} users)`);
  // Give the provider a beat, then exit (some providers keep the loop alive).
  process.exit(mismatches === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(2);
});
