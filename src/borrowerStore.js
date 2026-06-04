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

function nearPath(chainKey) {
  return path.join(DATA_DIR, `near-${chainKey}.json`);
}

function activeDebtPath(chainKey) {
  return path.join(DATA_DIR, `active-debt-${chainKey}.json`);
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

// "near" set = a WIDER mid-tier than the watchlist: wallets carrying non-dust
// debt AND HF below NEAR_HF (e.g. 1.5, vs the watchlist's 1.25). It's swept EVERY
// cycle along with the watchlist, so a wallet that drops from the 1.25–1.5 band
// straight into liquidation BETWEEN the slow full/warm sweeps is still caught the
// cycle it crosses — closing the "watchlist-gap" loss (wallets in our store but
// not in the hot set when they crossed). It stays small (~thousands, not the
// ~60k active-debt index) precisely because it's debt-floored: dust is excluded.
// Rebuilt by the COLD/WARM sweeps (same stream as the watchlist).
function loadNear(chainKey) {
  try {
    const raw = fs.readFileSync(nearPath(chainKey), "utf-8");
    const parsed = JSON.parse(raw);
    return { near: new Set((parsed.near || []).map((a) => a.toLowerCase())) };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`⚠️ Failed to read near set for ${chainKey}: ${error.message}`);
    }
    return { near: new Set() };
  }
}

function saveNear(chainKey, near) {
  ensureDir();
  const payload = {
    chainKey,
    updatedAt: new Date().toISOString(),
    count: near.size,
    near: Array.from(near),
  };
  const finalPath = nearPath(chainKey);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload));
  fs.renameSync(tmpPath, finalPath);
}

// Active-debt index = the subset of known borrowers observed carrying debt
// (totalDebtBase > 0) in the last cold sweep, plus newly-discovered borrowers.
// The expensive "full" health-factor sweep iterates THIS set instead of every
// ever-borrowed wallet (Base: ~few thousand with debt vs ~210k ever-borrowed),
// which is what keeps the full sweep fast enough to run often. A periodic cold
// sweep of the entire borrower set rebuilds it to catch wallets that took on
// debt without re-emitting a Borrow event we'd otherwise see incrementally.
//   warmSweepsSinceCold — how many warm (active-debt) sweeps since the last cold
//     (all-borrower) sweep; drives when the next cold sweep is due.
function loadActiveDebt(chainKey) {
  try {
    const raw = fs.readFileSync(activeDebtPath(chainKey), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      active: new Set((parsed.active || []).map((a) => a.toLowerCase())),
      warmSweepsSinceCold: Number.isFinite(parsed.warmSweepsSinceCold) ? parsed.warmSweepsSinceCold : 0,
      // When the last COLD (all-borrower) sweep completed. Used as a time-based
      // floor so COLD can't go stale even if the cycle counters drift (e.g. warm
      // slicing slows how fast warmSweepsSinceCold accrues). null = never/unknown,
      // which the caller treats as "due now".
      lastColdAt: typeof parsed.lastColdAt === "string" ? parsed.lastColdAt : null,
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`⚠️ Failed to read active-debt index for ${chainKey}: ${error.message}`);
    }
    return { active: new Set(), warmSweepsSinceCold: 0, lastColdAt: null };
  }
}

// lastColdAt: ISO timestamp of the COLD sweep that produced this index, or
// undefined to leave it unchanged from what the caller knows. Only COLD sweeps
// pass a fresh value; warm/watchlist persists carry the prior one forward so the
// time-based floor measures from the last *cold* rebuild, not the last write.
function saveActiveDebt(chainKey, active, warmSweepsSinceCold, lastColdAt) {
  ensureDir();
  const payload = {
    chainKey,
    updatedAt: new Date().toISOString(),
    warmSweepsSinceCold,
    lastColdAt: lastColdAt || null,
    count: active.size,
    active: Array.from(active),
  };
  const finalPath = activeDebtPath(chainKey);
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
  loadNear,
  saveNear,
  loadActiveDebt,
  saveActiveDebt,
};
