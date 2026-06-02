require("dotenv").config();
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getUnhealthyPositions } = require("../aaveHelpers");
const { loadBorrowerSet, saveBorrowerSet } = require("../src/borrowerStore");

(async () => {
  const key = "avalanche";
  process.env.BORROW_BACKFILL_FROM_DEPLOYMENT = "false";
  process.env.AVALANCHE_BORROW_BACKFILL_BLOCKS = "300000";
  process.env.CHECKPOINT_EVERY_CHUNKS = "5";
  const c = getChainConfig(key);
  const provider = createProvider(c);
  const head = await provider.getBlockNumber();

  // Simulate an INTERRUPTED backfill: cursor partway, NOT done, with a couple borrowers.
  const partialCursor = head - 150000; // halfway through a 300k window
  saveBorrowerSet(c.key, new Set(["0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]), null, { backfillCursor: partialCursor, backfillDone: false });
  console.log(`Seeded interrupted backfill: cursor=${partialCursor}, head≈${head}, backfillDone=false`);

  console.log("=== Run cycle: expect RESUME from cursor (not full BACKFILL, not incremental) ===");
  await getUnhealthyPositions(provider, c);
  const s = loadBorrowerSet(c.key);
  console.log(`state after: borrowers=${s.borrowers.size} backfillDone=${s.backfillDone} cursor=${s.backfillCursor}`);
  console.log(s.borrowers.has("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef") ? "✅ preserved pre-existing borrower (didn't wipe)" : "❌ lost pre-existing borrower");
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
