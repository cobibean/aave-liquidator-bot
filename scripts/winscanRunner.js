// Periodic win-rate scan service. Runs liquidationWinScan on an interval and
// writes the result to the shared data volume as winscan-latest.json (plus a
// rolling winscan-history.json), where the monitor's DataStoreReader picks it up.
//
// Lives in its own tiny container so the diagnostic never touches the live-money
// trading hot path. Reuses the bot image (ethers + RPC env already present).
//
// Env:
//   WINSCAN_INTERVAL_MIN   how often to scan (default 30)
//   WINSCAN_HOURS          look-back window per scan (default 1)
//   WINSCAN_CHAINS         comma list (default base,arbitrum,optimism,avalanche)
//   WINSCAN_HISTORY_MAX    history entries to keep (default 48 = 24h at 30min)
//   BORROWER_STORE_DIR / MONITOR_BORROWER_DATA_DIR / DATA_DIR  output dir
const fs = require("fs");
const path = require("path");
const { runWinScan } = require("./liquidationWinScan");

const INTERVAL_MIN = Number(process.env.WINSCAN_INTERVAL_MIN || 30);
const HOURS = Number(process.env.WINSCAN_HOURS || 1);
const CHAINS = process.env.WINSCAN_CHAINS || "base,arbitrum,optimism,avalanche";
const HISTORY_MAX = Number(process.env.WINSCAN_HISTORY_MAX || 48);
const DATA_DIR =
  process.env.BORROWER_STORE_DIR ||
  process.env.MONITOR_BORROWER_DATA_DIR ||
  process.env.DATA_DIR ||
  "/app/data";
// On-demand request markers from the dashboard land in a SEPARATE control dir
// (a small volume the monitor can write while the borrower data stays read-only).
// Defaults to DATA_DIR for local/single-volume layouts.
const REQUEST_DIR = process.env.WINSCAN_REQUEST_DIR || DATA_DIR;

const LATEST_PATH = path.join(DATA_DIR, "winscan-latest.json");
const HISTORY_PATH = path.join(DATA_DIR, "winscan-history.json");
const REQUEST_PATH = path.join(REQUEST_DIR, "winscan-request.json");
const REQUEST_POLL_MS = Number(process.env.WINSCAN_REQUEST_POLL_MS || 10000);

function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

// One scan + persist. Returns the result (or null on hard failure) but never
// throws — the loop must survive a bad run.
async function runOnce() {
  const startedAt = new Date().toISOString();
  try {
    const result = await runWinScan({ hours: HOURS, chains: CHAINS });
    result.intervalMin = INTERVAL_MIN;
    result.startedAt = startedAt;
    writeJsonAtomic(LATEST_PATH, result);

    // Append a compact entry to the rolling history (just the totals per chain,
    // so the monitor can chart OURS-over-time without the full per-chain detail).
    const history = readJson(HISTORY_PATH, { entries: [] });
    history.entries = Array.isArray(history.entries) ? history.entries : [];
    history.entries.push({
      scannedAt: result.scannedAt,
      hours: result.hours,
      grandTotal: result.grandTotal,
      ourTotal: result.ourTotal,
      perChain: result.chains.map((c) => ({ key: c.key, total: c.total ?? null, ours: c.ours ?? null, error: c.error || null })),
    });
    if (history.entries.length > HISTORY_MAX) {
      history.entries = history.entries.slice(-HISTORY_MAX);
    }
    history.updatedAt = result.scannedAt;
    writeJsonAtomic(HISTORY_PATH, history);

    console.log(
      `[winscan] ${result.scannedAt} hours=${HOURS} chains=${CHAINS} => grandTotal=${result.grandTotal} ourTotal=${result.ourTotal}`
    );
    return result;
  } catch (e) {
    // Persist a failure marker so the dashboard shows "last run errored" rather
    // than silently going stale.
    const failure = { scannedAt: new Date().toISOString(), startedAt, error: e.message, hours: HOURS, chains: [], grandTotal: null, ourTotal: null };
    try {
      writeJsonAtomic(LATEST_PATH, failure);
    } catch (_) {
      /* ignore write failure */
    }
    console.error(`[winscan] run failed: ${e.message}`);
    return null;
  }
}

// Check for an on-demand request marker dropped by the monitor. If present,
// clear it first (so a run is never double-triggered) then scan. A single
// in-flight guard prevents the request poll and the interval timer from
// overlapping runs.
let scanInFlight = false;

async function guardedRun(reason) {
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    if (reason) console.log(`[winscan] trigger=${reason}`);
    await runOnce();
  } finally {
    scanInFlight = false;
  }
}

function consumeRequest() {
  try {
    if (!fs.existsSync(REQUEST_PATH)) return false;
    fs.unlinkSync(REQUEST_PATH); // clear before running so it fires exactly once
    return true;
  } catch (_) {
    return false;
  }
}

async function main() {
  console.log(
    `[winscan] runner up — every ${INTERVAL_MIN}min, ${HOURS}h window, chains=${CHAINS}, out=${DATA_DIR}, on-demand poll ${REQUEST_POLL_MS}ms`
  );
  // Run immediately on boot, then on the interval.
  await guardedRun("boot");
  setInterval(() => guardedRun("interval"), INTERVAL_MIN * 60 * 1000);
  // Poll for on-demand requests from the dashboard button.
  setInterval(() => {
    if (consumeRequest()) guardedRun("on-demand");
  }, REQUEST_POLL_MS);
}

if (require.main === module) {
  main();
}

module.exports = { runOnce, LATEST_PATH, HISTORY_PATH };
