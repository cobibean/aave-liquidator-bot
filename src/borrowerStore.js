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

function watchlistPath(chainKey) {
  return path.join(DATA_DIR, `watchlist-${chainKey}.json`);
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Returns the persisted discovery state for a chain:
//   borrowers        Set<string>
//   lastScannedBlock number|null  — head reached by the last forward (incremental) scan
//   backfillCursor   number|null  — highest block scanned contiguously from the deep floor
//   backfillDone     bool         — whether the one-time deep backfill has reached head
function loadBorrowerSet(chainKey) {
  try {
    const raw = fs.readFileSync(storePath(chainKey), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      borrowers: new Set((parsed.borrowers || []).map((a) => a.toLowerCase())),
      lastScannedBlock: Number.isFinite(parsed.lastScannedBlock) ? parsed.lastScannedBlock : null,
      backfillCursor: Number.isFinite(parsed.backfillCursor) ? parsed.backfillCursor : null,
      backfillDone: Boolean(parsed.backfillDone),
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`⚠️ Failed to read borrower store for ${chainKey}: ${error.message}`);
    }
    return { borrowers: new Set(), lastScannedBlock: null, backfillCursor: null, backfillDone: false };
  }
}

// Persists atomically (write temp, then rename) so a crash mid-write can't
// corrupt the store and force a full re-backfill. `meta` carries the backfill
// resume state; omitted fields are left undefined (treated as not-backfilled).
function saveBorrowerSet(chainKey, borrowers, lastScannedBlock, meta = {}) {
  ensureDir();
  const payload = {
    chainKey,
    lastScannedBlock,
    backfillCursor: Number.isFinite(meta.backfillCursor) ? meta.backfillCursor : null,
    backfillDone: Boolean(meta.backfillDone),
    updatedAt: new Date().toISOString(),
    count: borrowers.size,
    borrowers: Array.from(borrowers),
  };
  const finalPath = storePath(chainKey);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload));
  fs.renameSync(tmpPath, finalPath);
}

// Watchlist = the near-threshold wallets (HF below WATCHLIST_HF) that the
// stratified sweep re-checks every cycle, plus a cycle counter so we know when
// to do the next full-set sweep. Persisted so a restart doesn't reset the
// stratification (otherwise we'd re-do a full sweep on every restart).
function loadWatchlist(chainKey) {
  try {
    const raw = fs.readFileSync(watchlistPath(chainKey), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      watch: new Set((parsed.watch || []).map((a) => a.toLowerCase())),
      cyclesSinceFullSweep: Number.isFinite(parsed.cyclesSinceFullSweep)
        ? parsed.cyclesSinceFullSweep
        : 0,
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`⚠️ Failed to read watchlist for ${chainKey}: ${error.message}`);
    }
    return { watch: new Set(), cyclesSinceFullSweep: 0 };
  }
}

function saveWatchlist(chainKey, watch, cyclesSinceFullSweep) {
  ensureDir();
  const payload = {
    chainKey,
    updatedAt: new Date().toISOString(),
    cyclesSinceFullSweep,
    count: watch.size,
    watch: Array.from(watch),
  };
  const finalPath = watchlistPath(chainKey);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload));
  fs.renameSync(tmpPath, finalPath);
}

module.exports = {
  DATA_DIR,
  loadBorrowerSet,
  saveBorrowerSet,
  loadWatchlist,
  saveWatchlist,
};
