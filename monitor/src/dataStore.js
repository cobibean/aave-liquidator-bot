const fs = require("fs");
const path = require("path");

class DataStoreReader {
  constructor({
    dataDir = process.env.MONITOR_BORROWER_DATA_DIR || path.join(__dirname, "..", "..", "data"),
  } = {}) {
    this.dataDir = dataDir;
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
