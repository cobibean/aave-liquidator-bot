const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join("/tmp", `liq-backfill-meta-test-${Date.now()}`);
process.env.BORROWER_STORE_DIR = DATA_DIR;

const { BACKFILL_VERSION, loadBorrowerSet, saveBorrowerSet } = require("../src/borrowerStore");
const { borrowerBackfillIsCurrent } = require("../aaveHelpers");

const chainKey = "unit";
const borrowers = new Set(["0x0000000000000000000000000000000000000001"]);
const plan = { floor: 100, source: "deployment", version: BACKFILL_VERSION };
const fails = [];

saveBorrowerSet(chainKey, borrowers, 200, { backfillCursor: 200, backfillDone: true });
let state = loadBorrowerSet(chainKey);
if (borrowerBackfillIsCurrent(state, plan)) {
  fails.push("missing metadata should not be current");
}

saveBorrowerSet(chainKey, borrowers, 200, {
  backfillCursor: 200,
  backfillDone: true,
  backfillFloorBlock: 150,
  backfillSource: "deployment",
  backfillVersion: BACKFILL_VERSION,
});
state = loadBorrowerSet(chainKey);
if (borrowerBackfillIsCurrent(state, plan)) {
  fails.push("floor above desired floor should not be current");
}

saveBorrowerSet(chainKey, borrowers, 200, {
  backfillCursor: 200,
  backfillDone: true,
  backfillFloorBlock: 100,
  backfillSource: "deployment",
  backfillVersion: BACKFILL_VERSION,
});
state = loadBorrowerSet(chainKey);
if (!borrowerBackfillIsCurrent(state, plan)) {
  fails.push("matching metadata should be current");
}

if (state.backfillFloorBlock !== 100 || state.backfillSource !== "deployment" || state.backfillVersion !== BACKFILL_VERSION) {
  fails.push("metadata did not round-trip through borrower store");
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(fails.length === 0 ? "✅ Backfill metadata OK" : "❌ FAILURES:\n  - " + fails.join("\n  - "));
process.exit(fails.length === 0 ? 0 : 1);
