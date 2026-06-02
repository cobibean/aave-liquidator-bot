const fs = require("fs");
const path = require("path");

// Persists the set of known borrowers per chain so we don't have to re-scan
// the full Borrow-event history every cycle. The candidate set is the single
// biggest driver of whether we ever see a liquidatable position, so it must
// be complete (built once from a deep backfill) and cheap to update
// (incremental scans of only-new blocks thereafter).

const DATA_DIR = process.env.BORROWER_STORE_DIR || path.join(__dirname, "..", "data");

function storePath(chainKey) {
  return path.join(DATA_DIR, `borrowers-${chainKey}.json`);
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Returns { borrowers: Set<string>, lastScannedBlock: number|null }.
function loadBorrowerSet(chainKey) {
  try {
    const raw = fs.readFileSync(storePath(chainKey), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      borrowers: new Set((parsed.borrowers || []).map((a) => a.toLowerCase())),
      lastScannedBlock: Number.isFinite(parsed.lastScannedBlock) ? parsed.lastScannedBlock : null,
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`⚠️ Failed to read borrower store for ${chainKey}: ${error.message}`);
    }
    return { borrowers: new Set(), lastScannedBlock: null };
  }
}

// Persists atomically (write temp, then rename) so a crash mid-write can't
// corrupt the store and force a full re-backfill.
function saveBorrowerSet(chainKey, borrowers, lastScannedBlock) {
  ensureDir();
  const payload = {
    chainKey,
    lastScannedBlock,
    updatedAt: new Date().toISOString(),
    count: borrowers.size,
    borrowers: Array.from(borrowers),
  };
  const finalPath = storePath(chainKey);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload));
  fs.renameSync(tmpPath, finalPath);
}

module.exports = {
  DATA_DIR,
  loadBorrowerSet,
  saveBorrowerSet,
};
