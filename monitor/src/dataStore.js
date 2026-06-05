const fs = require("fs");
const path = require("path");

class DataStoreReader {
  constructor({
    dataDir = process.env.MONITOR_BORROWER_DATA_DIR || path.join(__dirname, "..", "..", "data"),
    // The win-scan request marker is written to a SEPARATE control directory so
    // the (read-only) borrower data mount stays read-only on the live box. The
    // winscan-runner watches this dir. Defaults to dataDir when unset (local dev /
    // single-volume layouts), which keeps tests and the repo-root layout working.
    controlDir = process.env.MONITOR_WINSCAN_CONTROL_DIR || null,
  } = {}) {
    this.dataDir = dataDir;
    this.controlDir = controlDir || dataDir;
  }

  readForChains(chains) {
    const result = {
      readable: true,
      dataDir: this.dataDir,
      error: null,
      chains: {},
    };

    if (!this.dataDir || !fs.existsSync(this.dataDir)) {
      result.readable = false;
      result.error = `Borrower data directory not found at ${this.dataDir}`;
      return result;
    }

    for (const chain of chains) {
      result.chains[chain.key] = {
        borrowerStore: this.readBorrowers(chain.key),
        activeDebt: this.readCountedFile(`active-debt-${chain.key}.json`, "active"),
        watchlist: this.readCountedFile(`watchlist-${chain.key}.json`, "watch"),
        near: this.readCountedFile(`near-${chain.key}.json`, "near"),
      };
    }

    return result;
  }

  readBorrowers(chainKey) {
    const read = this.readJson(`borrowers-${chainKey}.json`);
    if (!read.ok) {
      return { exists: false, count: null, backfillDone: null, updatedAt: null, error: read.error };
    }

    const parsed = read.value;
    return {
      exists: true,
      count: countFrom(parsed, "borrowers"),
      backfillDone: Boolean(parsed.backfillDone),
      backfillCursor: Number.isFinite(parsed.backfillCursor) ? parsed.backfillCursor : null,
      lastScannedBlock: Number.isFinite(parsed.lastScannedBlock) ? parsed.lastScannedBlock : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      error: null,
    };
  }

  readCountedFile(fileName, arrayKey) {
    const read = this.readJson(fileName);
    if (!read.ok) {
      return { exists: false, count: null, updatedAt: null, error: read.error };
    }

    return {
      exists: true,
      count: countFrom(read.value, arrayKey),
      updatedAt: typeof read.value.updatedAt === "string" ? read.value.updatedAt : null,
      cyclesSinceFullSweep: Number.isFinite(read.value.cyclesSinceFullSweep) ? read.value.cyclesSinceFullSweep : null,
      warmSweepsSinceCold: Number.isFinite(read.value.warmSweepsSinceCold) ? read.value.warmSweepsSinceCold : null,
      error: null,
    };
  }

  readJson(fileName) {
    const fullPath = path.join(this.dataDir, fileName);
    try {
      return { ok: true, value: JSON.parse(fs.readFileSync(fullPath, "utf8")) };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { ok: false, error: "missing" };
      }
      return { ok: false, error: error.message };
    }
  }

  // Latest win-rate scan result + rolling history written by the winscan-runner
  // service. Returns a stable shape even when the files are absent (runner not
  // deployed yet) so the dashboard can render an empty/"no scan yet" state.
  readWinScan() {
    const latest = this.readJson("winscan-latest.json");
    const history = this.readJson("winscan-history.json");
    return {
      available: latest.ok,
      latest: latest.ok ? latest.value : null,
      history: history.ok && Array.isArray(history.value?.entries) ? history.value.entries : [],
      error: latest.ok ? null : latest.error,
    };
  }

  // Drop an on-demand scan request marker on the shared volume. The winscan-runner
  // watches for this file and runs immediately, then clears it. The monitor never
  // runs the scan itself — it only asks. Returns { ok, requestedAt | error }.
  requestWinScan() {
    const requestedAt = new Date().toISOString();
    const fullPath = path.join(this.controlDir, "winscan-request.json");
    try {
      if (!this.controlDir || !fs.existsSync(this.controlDir)) {
        return { ok: false, error: `Control directory not found at ${this.controlDir}` };
      }
      const tmp = `${fullPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ requestedAt }));
      fs.renameSync(tmp, fullPath);
      return { ok: true, requestedAt };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

function countFrom(value, arrayKey) {
  if (Number.isFinite(value?.count)) {
    return value.count;
  }
  if (Array.isArray(value?.[arrayKey])) {
    return value[arrayKey].length;
  }
  return null;
}

module.exports = {
  DataStoreReader,
};
