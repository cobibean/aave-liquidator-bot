require("dotenv").config();

const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getBorrowersFromBorrowEvents, getUnhealthyPositions } = require("../aaveHelpers");
const { loadBorrowerSet } = require("../src/borrowerStore");

// Proves the new discovery mechanism: backfill -> persist -> incremental,
// plus the parallel HF sweep. Run against a single chain.
async function main() {
  const key = process.argv[2] || "optimism";
  const chainConfig = getChainConfig(key);
  const provider = createProvider(chainConfig);

  console.log(`\n=== RUN 1 (expect BACKFILL) on ${chainConfig.name} ===`);
  console.log(`backfillBlocks=${chainConfig.borrowBackfillBlocks}, chunk=${chainConfig.borrowScanChunkSize}`);
  const t1 = Date.now();
  const set1 = await getBorrowersFromBorrowEvents(provider, chainConfig);
  console.log(`RUN 1: ${set1.length} borrowers in ${Date.now() - t1}ms`);

  const persisted = loadBorrowerSet(chainConfig.key);
  console.log(`PERSISTED: ${persisted.borrowers.size} borrowers, lastScannedBlock=${persisted.lastScannedBlock}`);

  console.log(`\n=== RUN 2 (expect INCREMENTAL) ===`);
  const t2 = Date.now();
  const set2 = await getBorrowersFromBorrowEvents(provider, chainConfig);
  console.log(`RUN 2: ${set2.length} borrowers in ${Date.now() - t2}ms (should be MUCH faster than run 1)`);

  console.log(`\n=== Full getUnhealthyPositions (parallel HF sweep) ===`);
  const t3 = Date.now();
  const positions = await getUnhealthyPositions(provider, chainConfig);
  console.log(`Found ${positions.length} liquidatable in ${Date.now() - t3}ms`);
  console.log(JSON.stringify(positions.map((p) => ({ user: p.user, hf: p.healthFactor })), null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
