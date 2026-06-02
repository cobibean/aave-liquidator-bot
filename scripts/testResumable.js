require("dotenv").config();
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getUnhealthyPositions } = require("../aaveHelpers");
const { loadBorrowerSet } = require("../src/borrowerStore");

(async () => {
  const key = "avalanche";
  // Capped window backfill (not from deployment) so the test is quick.
  process.env.BORROW_BACKFILL_FROM_DEPLOYMENT = "false";
  process.env.AVALANCHE_BORROW_BACKFILL_BLOCKS = "300000";
  process.env.CHECKPOINT_EVERY_CHUNKS = "5";
  process.env.MIN_DEBT_USD = "100";
  const c = getChainConfig(key);
  const provider = createProvider(c);

  console.log("=== CYCLE 1: expect BACKFILL, then backfillDone=true ===");
  await getUnhealthyPositions(provider, c);
  let s = loadBorrowerSet(c.key);
  console.log(`state: borrowers=${s.borrowers.size} backfillDone=${s.backfillDone} cursor=${s.backfillCursor} lastScanned=${s.lastScannedBlock}`);

  console.log("\n=== CYCLE 2: expect INCREMENTAL (backfill done) ===");
  await getUnhealthyPositions(provider, c);
  s = loadBorrowerSet(c.key);
  console.log(`state: borrowers=${s.borrowers.size} backfillDone=${s.backfillDone} cursor=${s.backfillCursor}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
