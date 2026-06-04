require("dotenv").config();
const fs = require("fs");
const path = require("path");

// Verifies the time-based COLD floor (COLD_MAX_AGE_MIN): even when the COUNTER
// cadence would pick a cheap watchlist/warm cycle, a stale active-debt index
// (lastColdAt older than the floor) forces a COLD sweep. This is the fix that
// stops freshly-borrowing whales from sitting COLD-only for ~a day and never
// getting promoted into the tiers the fast triggers watch.
//
// Run: node scripts/testColdTimeFloor.js [chainKey]
const DATA_DIR = path.join("/tmp", `liq-cold-floor-test-${Date.now()}`);
process.env.BORROWER_STORE_DIR = DATA_DIR;
// Counters set so that, by themselves, cycle 2 would be a cheap watchlist cycle
// (not COLD). FULL=20 means cyclesSinceFullSweep won't trip for a long time.
process.env.FULL_SWEEP_EVERY_N = "20";
process.env.COLD_SWEEP_EVERY_N = "8";
// Tiny time floor so the test can age the index past it without real waiting.
process.env.COLD_MAX_AGE_MIN = "1";

const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getUnhealthyPositions } = require("../aaveHelpers");

const key = process.argv[2] || "avalanche";
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

(async () => {
  const c = getChainConfig(key);
  const provider = createProvider(c);
  const cfg = { ...c, borrowBackfillBlocks: 60000 };
  const chainKey = c.key;
  const activePath = path.join(DATA_DIR, `active-debt-${chainKey}.json`);

  const sweepTypes = [];
  const origLog = console.log;
  console.log = (...a) => {
    const m = a.join(" ").match(/(COLD|WARM|watchlist) HF sweep of/);
    if (m) sweepTypes.push(m[1]);
    origLog(...a);
  };

  // Cycle 1: index empty → COLD, builds the index and stamps lastColdAt = now.
  await getUnhealthyPositions(provider, cfg);

  // Age the index: rewrite lastColdAt to 5 minutes ago (> the 1-min floor) while
  // leaving the counters healthy. The COUNTER logic alone would pick watchlist
  // next; only the time floor should now force COLD.
  const idx = readJson(activePath);
  idx.lastColdAt = new Date(Date.now() - 5 * 60_000).toISOString();
  idx.warmSweepsSinceCold = 0; // counters say "not due"
  fs.writeFileSync(activePath, JSON.stringify(idx));
  // Also reset the watchlist's cyclesSinceFullSweep so needFullSweep isn't tripped
  // by the counter path — isolate the time floor as the sole cause of COLD.
  const wlPath = path.join(DATA_DIR, `watchlist-${chainKey}.json`);
  const wl = readJson(wlPath);
  if (wl) { wl.cyclesSinceFullSweep = 0; fs.writeFileSync(wlPath, JSON.stringify(wl)); }

  // Cycle 2: stale index → time floor must force COLD.
  await getUnhealthyPositions(provider, cfg);

  console.log = origLog;

  const fails = [];
  if (sweepTypes[0] !== "COLD") fails.push(`cycle 1 expected COLD (empty index), got ${sweepTypes[0]}`);
  if (sweepTypes[1] !== "COLD") fails.push(`cycle 2 expected COLD (time floor), got ${sweepTypes[1]} — time floor did not fire`);

  // And confirm the floor is a NO-OP when the index is fresh: rewrite lastColdAt
  // to now, reset counters, and verify cycle 3 is NOT forced to COLD.
  const idx2 = readJson(activePath);
  idx2.lastColdAt = new Date().toISOString();
  idx2.warmSweepsSinceCold = 0;
  fs.writeFileSync(activePath, JSON.stringify(idx2));
  const wl2 = readJson(wlPath);
  if (wl2) { wl2.cyclesSinceFullSweep = 0; fs.writeFileSync(wlPath, JSON.stringify(wl2)); }
  sweepTypes.length = 0;
  console.log = (...a) => { const m = a.join(" ").match(/(COLD|WARM|watchlist) HF sweep of/); if (m) sweepTypes.push(m[1]); origLog(...a); };
  await getUnhealthyPositions(provider, cfg);
  console.log = origLog;
  if (sweepTypes[0] === "COLD") fails.push(`fresh index should NOT force COLD, but cycle 3 was COLD`);

  console.log("\n" + (fails.length === 0
    ? "✅ COLD time-floor OK (stale index forces COLD; fresh index does not)"
    : "❌ FAILURES:\n  - " + fails.join("\n  - ")));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(fails.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(1); });
