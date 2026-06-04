require("dotenv").config();
const fs = require("fs");
const path = require("path");

// borrowerStore reads BORROWER_STORE_DIR at module load, so the env MUST be set
// before requiring aaveHelpers (which requires borrowerStore). Same for the
// sweep-interval knobs read inside getUnhealthyPositions.
const DATA_DIR = path.join("/tmp", `liq-active-test-${Date.now()}`);
process.env.BORROWER_STORE_DIR = DATA_DIR;
process.env.FULL_SWEEP_EVERY_N = "2";   // warm/cold every 2 watchlist cycles
process.env.COLD_SWEEP_EVERY_N = "2";   // cold every 2 warm sweeps
process.env.COLD_MAX_AGE_MIN = "0";     // disable the time-based COLD floor so
                                        // this test exercises the COUNTER state
                                        // machine deterministically (all cycles
                                        // run within seconds, which the time floor
                                        // would otherwise force to COLD every cycle).

const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getUnhealthyPositions } = require("../aaveHelpers");

// Drives getUnhealthyPositions through several cycles on a real small chain and
// asserts the three-tier sweep state machine (Layer 2): first cycle COLD (index
// empty) → builds active-debt index, then WARM sweeps until FULL_SWEEP_EVERY_N,
// with WATCHLIST cycles in between, and a COLD sweep again after COLD_SWEEP_EVERY_N
// warm sweeps. Uses a throwaway data dir and tiny FULL/COLD intervals.
//
// Run: node scripts/testActiveDebtSweeps.js [chainKey]
const key = process.argv[2] || "avalanche";

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

(async () => {
  const c = getChainConfig(key);
  const provider = createProvider(c);
  const cfg = { ...c, borrowBackfillBlocks: 60000 };
  const chainKey = c.key;

  // Capture the sweep-type log line each cycle.
  const sweepLog = [];
  const origLog = console.log;
  console.log = (...a) => {
    const s = a.join(" ");
    const m = s.match(/(COLD|WARM|watchlist) HF sweep of (\d+)/);
    if (m) sweepLog.push({ type: m[1], size: parseInt(m[2], 10) });
    origLog(...a);
  };

  // With FULL=2, COLD=2: COLD, wl, wl, WARM, wl, wl, WARM, wl, wl, COLD, ...
  // 10 cycles reaches the 2nd COLD so we observe the full index-rebuild loop.
  const cycles = 10;
  for (let i = 0; i < cycles; i++) {
    await getUnhealthyPositions(provider, cfg);
  }
  console.log = origLog;

  const active = readJson(path.join(DATA_DIR, `active-debt-${chainKey}.json`));
  const watch = readJson(path.join(DATA_DIR, `watchlist-${chainKey}.json`));

  console.log("\n=== sweep sequence ===");
  sweepLog.forEach((s, i) => console.log(`  cycle ${i + 1}: ${s.type} (${s.size})`));
  console.log("active-debt index:", active ? { count: active.count, warmSweepsSinceCold: active.warmSweepsSinceCold } : "MISSING");
  console.log("watchlist:", watch ? { count: watch.count, cyclesSinceFullSweep: watch.cyclesSinceFullSweep } : "MISSING");

  // Assertions. Expected sequence for FULL=2, COLD=2 over 10 cycles:
  //   COLD, wl, wl, WARM, wl, wl, WARM, wl, wl, COLD
  const expected = ["COLD", "watchlist", "watchlist", "WARM", "watchlist", "watchlist", "WARM", "watchlist", "watchlist", "COLD"];
  const fails = [];
  if (sweepLog.length !== cycles) fails.push(`expected ${cycles} sweeps, saw ${sweepLog.length}`);
  const types = sweepLog.map((s) => s.type);
  types.forEach((t, i) => {
    if (expected[i] && t !== expected[i]) fails.push(`cycle ${i + 1}: expected ${expected[i]}, got ${t}`);
  });
  const colds = types.filter((t) => t === "COLD").length;
  const warms = types.filter((t) => t === "WARM").length;
  if (colds !== 2) fails.push(`expected exactly 2 COLD sweeps, saw ${colds}`);
  if (warms !== 2) fails.push(`expected exactly 2 WARM sweeps, saw ${warms}`);
  // A WARM sweep should be no larger than the borrower set, and (once the index
  // is built) typically smaller than a COLD sweep of all borrowers.
  const coldSize = sweepLog.find((s) => s.type === "COLD").size;
  const warmSweep = sweepLog.find((s) => s.type === "WARM");
  if (warmSweep && warmSweep.size > coldSize) fails.push(`WARM sweep (${warmSweep.size}) larger than COLD (${coldSize})`);
  if (!active) fails.push("active-debt index not persisted");

  console.log("\n" + (fails.length === 0 ? "✅ active-debt sweep state machine OK" : "❌ FAILURES:\n  - " + fails.join("\n  - ")));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(fails.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(1); });
