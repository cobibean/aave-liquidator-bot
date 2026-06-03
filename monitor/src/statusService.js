const { DataStoreReader } = require("./dataStore");
const { DockerClient } = require("./dockerClient");
const { KNOWN_CHAINS, parseLogText } = require("./logParser");
const { redact } = require("./redact");
const { clampInt, parseDuration, secondsSince } = require("./time");

const DEFAULT_STATUS_WINDOW = "12h";
const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_HIGH_RESTARTS = 5;

function createStatusService({
  dockerClient = new DockerClient(),
  dataReader = new DataStoreReader(),
  now = () => new Date(),
  containerName = process.env.MONITOR_BOT_CONTAINER || "aave-liquidator",
} = {}) {
  return {
    async getStatus() {
      const checkedAt = now();
      const errors = [];
      const inspect = await safeCall(() => dockerClient.inspectContainer(containerName));
      const container = normalizeContainer(inspect, checkedAt, containerName);

      if (!inspect?.ok) {
        errors.push(inspect?.error || "Unable to inspect Docker container");
      }

      const statusWindowMs = parseDuration(
        process.env.MONITOR_STATUS_LOG_WINDOW || DEFAULT_STATUS_WINDOW,
        parseDuration(DEFAULT_STATUS_WINDOW, 12 * 60 * 60 * 1000)
      );
      const logs = await safeCall(() =>
        dockerClient.getContainerLogs(containerName, {
          sinceSeconds: Math.floor(statusWindowMs / 1000),
          tail: clampInt(process.env.MONITOR_STATUS_LOG_TAIL, { fallback: 6000, min: 100, max: 20000 }),
        })
      );
      if (!logs?.ok) {
        errors.push(logs?.error || "Unable to read Docker logs");
      }

      const parsed = parseLogText(logs?.text || "", { now: checkedAt });
      const chains = resolveChains(container.chains, parsed.inferredChains);
      const data = dataReader.readForChains(chains);
      if (!data.readable) {
        errors.push(data.error);
      }

      const chainSummaries = chains.map((chain) =>
        mergeChainSummary(chain, parsed.chains[chain.key], data.chains[chain.key])
      );
      const warnings = buildWarnings({
        container,
        parsed,
        chains: chainSummaries,
        data,
        errors,
        now: checkedAt,
      });

      return {
        ok: errors.length === 0,
        refreshedAt: checkedAt.toISOString(),
        rawLogsHiddenByDefault: true,
        monitor: {
          canReadDocker: Boolean(inspect?.ok),
          canReadLogs: Boolean(logs?.ok),
          canReadData: data.readable,
          errors: errors.map(redact),
        },
        container: {
          ...container,
          lastLogAt: parsed.lastLogAt,
        },
        activity: {
          window: process.env.MONITOR_STATUS_LOG_WINDOW || DEFAULT_STATUS_WINDOW,
          ...parsed.activity,
        },
        chains: chainSummaries,
        warnings,
      };
    },

    async getRawLogs({ sinceMs, filter = "", limit = 500 } = {}) {
      const safeLimit = clampInt(limit, { fallback: 500, min: 1, max: 2000 });
      const logs = await safeCall(() =>
        dockerClient.getContainerLogs(containerName, {
          sinceSeconds: Math.floor((sinceMs || 60 * 60 * 1000) / 1000),
          tail: Math.min(safeLimit * 4, 8000),
        })
      );

      const filterText = String(filter || "").trim().toLowerCase();
      const lines = redact(logs?.text || "")
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .filter((line) => !filterText || line.toLowerCase().includes(filterText))
        .slice(-safeLimit);

      return {
        ok: Boolean(logs?.ok),
        error: logs?.ok ? null : redact(logs?.error || "Unable to read Docker logs"),
        sinceMs,
        limit: safeLimit,
        filter: filterText,
        lineCount: lines.length,
        lines,
      };
    },
  };
}

function normalizeContainer(inspect, now, containerName) {
  if (!inspect?.ok) {
    return {
      name: containerName,
      state: inspect?.missing ? "missing" : "unknown",
      running: false,
      restartCount: null,
      startedAt: null,
      uptimeSeconds: null,
      testMode: "unknown",
      chains: [],
      lastRefreshAt: now.toISOString(),
    };
  }

  const info = inspect.container;
  const testMode = parseTestMode(info.env.TEST_MODE);
  return {
    name: info.name,
    state: info.running ? "running" : info.status || "stopped",
    running: info.running,
    restartCount: info.restartCount,
    startedAt: info.startedAt,
    uptimeSeconds: secondsSince(info.startedAt, now),
    testMode,
    chains: parseChains(info.env.CHAINS),
    lastRefreshAt: now.toISOString(),
  };
}

function parseTestMode(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return "unknown";
}

function parseChains(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function resolveChains(containerChains, inferredChains) {
  const keys = Array.from(new Set([...(containerChains || []), ...(inferredChains || [])]));
  const selected = keys
    .map((key) => KNOWN_CHAINS.find((chain) => chain.key === key))
    .filter(Boolean);

  return selected.length > 0
    ? selected
    : ["plasma", "arbitrum", "base", "avalanche", "optimism"].map((key) =>
        KNOWN_CHAINS.find((chain) => chain.key === key)
      );
}

function mergeChainSummary(chain, parsed = {}, data = {}) {
  const borrowerStore = data?.borrowerStore || {};
  const activeDebt = data?.activeDebt || {};
  const watchlist = data?.watchlist || {};
  const backfillStatus = resolveBackfillStatus(parsed.backfillStatus, borrowerStore);

  return {
    key: chain.key,
    name: chain.name,
    latestLiquidatablePositions: valueOrNull(parsed.latestLiquidatablePositions),
    latestLiquidatableAt: parsed.latestLiquidatableAt || null,
    latestCycleDurationMs: valueOrNull(parsed.latestCycleDurationMs || parsed.latestSweep?.durationMs),
    borrowerStoreCount: valueOrNull(borrowerStore.count ?? parsed.borrowerLogCount),
    borrowerStoreUpdatedAt: borrowerStore.updatedAt || null,
    activeDebtCount: valueOrNull(activeDebt.count ?? parsed.latestSweep?.activeDebtCount),
    watchlistCount: valueOrNull(watchlist.count ?? parsed.latestSweep?.watchlistCount),
    backfillStatus,
    latestSweep: parsed.latestSweep || null,
    latestError: parsed.latestError || null,
    dataAvailable: Boolean(borrowerStore.exists || activeDebt.exists || watchlist.exists),
  };
}

function resolveBackfillStatus(parsedStatus, borrowerStore) {
  if (borrowerStore?.exists && borrowerStore.backfillDone === true) {
    return parsedStatus === "backfilling" ? "backfilling" : "done";
  }
  if (parsedStatus && parsedStatus !== "unknown") {
    return parsedStatus;
  }
  if (borrowerStore?.exists && borrowerStore.backfillDone === false) {
    return "backfilling";
  }
  return "unknown";
}

function buildWarnings({ container, parsed, chains, data, errors, now }) {
  const warnings = [];

  if (container.state === "missing") {
    warnings.push({ level: "critical", code: "container_missing", message: "Bot container is missing." });
  } else if (!container.running) {
    warnings.push({ level: "critical", code: "container_not_running", message: "Bot container is not running." });
  }

  const restartThreshold = clampInt(process.env.MONITOR_HIGH_RESTART_COUNT, {
    fallback: DEFAULT_HIGH_RESTARTS,
    min: 1,
    max: 1000,
  });
  if (Number.isFinite(container.restartCount) && container.restartCount >= restartThreshold) {
    warnings.push({
      level: "warning",
      code: "high_restart_count",
      message: `Restart count is ${container.restartCount}, which is higher than expected.`,
    });
  }

  if (container.testMode === "unknown") {
    warnings.push({ level: "warning", code: "test_mode_unknown", message: "TEST_MODE is missing or unknown." });
  }

  if (parsed.activity.mainLoopErrors > 0) {
    warnings.push({
      level: "warning",
      code: "main_loop_errors",
      message: `${parsed.activity.mainLoopErrors} main-loop error(s) found in recent logs.`,
    });
  }

  if (parsed.activity.failedTxs > 0) {
    warnings.push({
      level: "warning",
      code: "tx_failures",
      message: `${parsed.activity.failedTxs} transaction failure(s) found in recent logs.`,
    });
  }

  const staleMinutes = clampInt(process.env.MONITOR_STALE_LOG_MINUTES, {
    fallback: DEFAULT_STALE_MINUTES,
    min: 5,
    max: 1440,
  });
  const staleSeconds = staleMinutes * 60;
  const lastLogAge = secondsSince(parsed.lastLogAt, now);
  if (container.running && (lastLogAge === null || lastLogAge > staleSeconds)) {
    warnings.push({
      level: "warning",
      code: "stale_logs",
      message: `No recent bot logs seen in the last ${staleMinutes} minutes.`,
    });
  }

  for (const chain of chains) {
    if (chain.backfillStatus === "backfilling" && chain.borrowerStoreCount && chain.borrowerStoreCount > 0) {
      warnings.push({
        level: "warning",
        code: "fresh_backfill",
        message: `${chain.name} is logging a backfill while borrower state already exists.`,
      });
    }
    if (chain.latestError) {
      warnings.push({
        level: "warning",
        code: `chain_error_${chain.key}`,
        message: `${chain.name}: ${chain.latestError.summary}`,
      });
    }
  }

  if (!data.readable) {
    warnings.push({ level: "warning", code: "data_unreadable", message: "Monitor cannot read borrower data." });
  }
  if (errors.length > 0) {
    warnings.push({ level: "warning", code: "monitor_degraded", message: "Monitor is running with degraded access." });
  }

  return dedupeWarnings(warnings).map((warning) => ({
    ...warning,
    message: redact(warning.message),
  }));
}

function dedupeWarnings(warnings) {
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function safeCall(fn) {
  try {
    return await fn();
  } catch (error) {
    return { ok: false, error: redact(error.message || String(error)) };
  }
}

function valueOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

module.exports = {
  createStatusService,
  mergeChainSummary,
  parseChains,
  parseTestMode,
  resolveChains,
};
