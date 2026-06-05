const { DataStoreReader } = require("./dataStore");
const { DockerClient } = require("./dockerClient");
const { buildInsights } = require("./insights");
const { KNOWN_CHAINS, parseLogText } = require("./logParser");
const { redact } = require("./redact");
const { clampInt, parseDuration, secondsSince } = require("./time");

const DEFAULT_STATUS_WINDOW = "12h";
const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_HIGH_RESTARTS = 5;
const DEFAULT_BOT_CONTAINERS = Object.freeze([
  "bot-plasma",
  "bot-arbitrum",
  "bot-base",
  "bot-avalanche",
  "bot-optimism",
]);

function createStatusService(options = {}) {
  const dockerClient = options.dockerClient || new DockerClient();
  const dataReader = options.dataReader || new DataStoreReader();
  const now = options.now || (() => new Date());
  const containerNames = resolveContainerNames(options);

  return {
    async getStatus() {
      const checkedAt = now();
      const errors = [];
      const inspectResults = await Promise.all(
        containerNames.map((name) => safeCall(() => dockerClient.inspectContainer(name)))
      );
      const containers = inspectResults.map((inspect, index) =>
        normalizeContainer(inspect, checkedAt, containerNames[index])
      );

      inspectResults.forEach((inspect, index) => {
        if (!inspect?.ok) {
          errors.push(`${containerNames[index]}: ${inspect?.error || "Unable to inspect Docker container"}`);
        }
      });

      const statusWindowMs = statusWindowDuration();
      const logResults = await Promise.all(
        containerNames.map((name) =>
          safeCall(() =>
            dockerClient.getContainerLogs(name, {
              sinceSeconds: Math.floor(statusWindowMs / 1000),
              tail: clampInt(process.env.MONITOR_STATUS_LOG_TAIL, { fallback: 6000, min: 100, max: 20000 }),
            })
          )
        )
      );

      const parsedByContainer = {};
      logResults.forEach((logs, index) => {
        const name = containerNames[index];
        if (!logs?.ok) {
          errors.push(`${name}: ${logs?.error || "Unable to read Docker logs"}`);
        }
        parsedByContainer[name] = parseLogText(logs?.text || "", {
          now: checkedAt,
          defaultChainKey: containers[index].chains?.[0],
        });
        containers[index].lastLogAt = parsedByContainer[name].lastLogAt;
        containers[index].canReadLogs = Boolean(logs?.ok);
      });

      const parsed = mergeParsedResults(Object.values(parsedByContainer), checkedAt);
      const container = summarizeFleet(containers, parsed, checkedAt);

      const chains = resolveChains(
        containers.flatMap((item) => item.chains || []),
        parsed.inferredChains
      );
      const data = dataReader.readForChains(chains);
      if (!data.readable) {
        errors.push(data.error);
      }

      const chainSummaries = chains.map((chain) =>
        mergeChainSummary(chain, parsed.chains[chain.key], data.chains[chain.key])
      );
      const warnings = buildWarnings({
        container,
        containers,
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
          canReadDocker: inspectResults.every((inspect) => Boolean(inspect?.ok)),
          canReadLogs: containers.every((item) => item.canReadLogs),
          canReadData: data.readable,
          errors: errors.map(redact),
        },
        container,
        activity: {
          window: process.env.MONITOR_STATUS_LOG_WINDOW || DEFAULT_STATUS_WINDOW,
          ...parsed.activity,
        },
        containers,
        chains: chainSummaries,
        warnings,
        insights: buildInsights({
          container,
          containers,
          chains: chainSummaries,
          parsed,
          warnings,
          now: checkedAt,
        }),
      };
    },

    getWinScan() {
      // Read-only: the winscan-runner service produces these files on the shared
      // volume; the monitor never runs the scan itself (keeps it lean + RPC-free).
      const winScan = dataReader.readWinScan();
      return {
        ok: true,
        refreshedAt: now().toISOString(),
        ...winScan,
      };
    },

    requestWinScan() {
      // Write an on-demand scan request marker; the winscan-runner picks it up and
      // runs immediately. The monitor only asks — it does not run the scan.
      const result = dataReader.requestWinScan();
      return { ...result, refreshedAt: now().toISOString() };
    },

    async getRawLogs({ sinceMs, filter = "", limit = 500 } = {}) {
      const safeLimit = clampInt(limit, { fallback: 500, min: 1, max: 2000 });
      const logResults = await Promise.all(
        containerNames.map((name) =>
          safeCall(() =>
            dockerClient.getContainerLogs(name, {
              sinceSeconds: Math.floor((sinceMs || 60 * 60 * 1000) / 1000),
              tail: Math.min(safeLimit * 4, 8000),
            })
          )
        )
      );
      const errors = [];
      const allLines = [];

      logResults.forEach((logs, index) => {
        const name = containerNames[index];
        if (!logs?.ok) {
          errors.push(`${name}: ${logs?.error || "Unable to read Docker logs"}`);
        }
        const prefix = containerNames.length > 1 ? `[${name}] ` : "";
        for (const line of redact(logs?.text || "").split(/\r?\n/)) {
          if (line.trim() !== "") {
            allLines.push(`${prefix}${line}`);
          }
        }
      });

      const filterText = String(filter || "").trim().toLowerCase();
      const lines = allLines
        .filter((line) => !filterText || line.toLowerCase().includes(filterText))
        .slice(-safeLimit);

      return {
        ok: errors.length === 0,
        error: errors.length ? redact(errors.join("; ")) : null,
        containers: containerNames,
        sinceMs,
        limit: safeLimit,
        filter: filterText,
        lineCount: lines.length,
        lines,
      };
    },
  };
}

function resolveContainerNames(options = {}, env = process.env) {
  if (Array.isArray(options.containerNames)) {
    return parseContainerNameList(options.containerNames);
  }
  if (options.containerName) {
    return parseContainerNameList([options.containerName]);
  }

  const plural = parseContainerNameList(env.MONITOR_BOT_CONTAINERS);
  if (plural.length > 0) return plural;

  const singular = parseContainerNameList(env.MONITOR_BOT_CONTAINER);
  if (singular.length > 0) return singular;

  return [...DEFAULT_BOT_CONTAINERS];
}

function parseContainerNameList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(
    new Set(items.map((item) => String(item || "").trim()).filter(Boolean))
  );
}

function statusWindowDuration() {
  return parseDuration(
    process.env.MONITOR_STATUS_LOG_WINDOW || DEFAULT_STATUS_WINDOW,
    parseDuration(DEFAULT_STATUS_WINDOW, 12 * 60 * 60 * 1000)
  );
}

function mergeParsedResults(parsedList, now) {
  const merged = {
    parsedAt: now.toISOString(),
    lastLogAt: null,
    inferredChains: [],
    chains: {},
    metrics: {
      sweeps: [],
      attempts: [],
    },
    activity: {
      liquidatableDetections: 0,
      liquidationAttempts: 0,
      txsSent: 0,
      successfulLiquidations: 0,
      failedTxs: 0,
      mainLoopErrors: 0,
      newestNotableEvent: null,
    },
    borrowers: [],
    events: [],
  };

  for (const parsed of parsedList) {
    if (!parsed) continue;
    if (parsed.lastLogAt && (!merged.lastLogAt || parsed.lastLogAt > merged.lastLogAt)) {
      merged.lastLogAt = parsed.lastLogAt;
    }
    merged.inferredChains.push(...(parsed.inferredChains || []));
    for (const [key, chain] of Object.entries(parsed.chains || {})) {
      merged.chains[key] = mergeChainLogState(merged.chains[key], chain);
    }
    merged.metrics.sweeps.push(...(parsed.metrics?.sweeps || []));
    merged.metrics.attempts.push(...(parsed.metrics?.attempts || []));
    for (const key of [
      "liquidatableDetections",
      "liquidationAttempts",
      "txsSent",
      "successfulLiquidations",
      "failedTxs",
      "mainLoopErrors",
    ]) {
      merged.activity[key] += parsed.activity?.[key] || 0;
    }
    merged.borrowers.push(...(parsed.borrowers || []));
    merged.events.push(...(parsed.events || []));
  }

  merged.inferredChains = Array.from(new Set(merged.inferredChains));
  merged.activity.newestNotableEvent = newestEvent(merged.events);
  merged.events.sort((a, b) => timeValue(a.at) - timeValue(b.at));
  merged.metrics.sweeps.sort((a, b) => timeValue(a.at) - timeValue(b.at));
  merged.metrics.attempts.sort((a, b) => timeValue(a.at) - timeValue(b.at));
  merged.borrowers.sort((a, b) => timeValue(a.at) - timeValue(b.at));

  return merged;
}

function mergeChainLogState(current = {}, incoming = {}) {
  return {
    ...current,
    ...incoming,
    latestSweep: newerByAt(current.latestSweep, incoming.latestSweep),
    latestError: newerByAt(current.latestError, incoming.latestError),
  };
}

function newerByAt(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return timeValue(b.at) >= timeValue(a.at) ? b : a;
}

function newestEvent(events) {
  return (events || []).reduce((latest, event) => {
    if (!latest) return event;
    return timeValue(event.at) >= timeValue(latest.at) ? event : latest;
  }, null);
}

function timeValue(iso) {
  const value = new Date(iso || 0).getTime();
  return Number.isFinite(value) ? value : 0;
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
      lastLogAt: null,
      canReadLogs: false,
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
    lastLogAt: null,
    canReadLogs: false,
    lastRefreshAt: now.toISOString(),
  };
}

function summarizeFleet(containers, parsed, now) {
  if (containers.length === 1) {
    return {
      ...containers[0],
      lastLogAt: containers[0].lastLogAt || parsed.lastLogAt,
      containerCount: 1,
      runningCount: containers[0].running ? 1 : 0,
      expectedCount: 1,
    };
  }

  const runningCount = containers.filter((container) => container.running).length;
  const missingCount = containers.filter((container) => container.state === "missing").length;
  const restartCount = containers.reduce(
    (total, container) => total + (Number.isFinite(container.restartCount) ? container.restartCount : 0),
    0
  );
  const chains = Array.from(new Set(containers.flatMap((container) => container.chains || [])));
  const startedAtValues = containers
    .map((container) => container.startedAt)
    .filter(Boolean)
    .sort();
  const uptimes = containers
    .map((container) => container.uptimeSeconds)
    .filter(Number.isFinite);
  const testMode = summarizeTestMode(containers.map((container) => container.testMode));

  return {
    name: "liquidator fleet",
    state: runningCount === containers.length
      ? "running"
      : missingCount === containers.length
        ? "missing"
        : "degraded",
    running: containers.length > 0 && runningCount === containers.length,
    restartCount,
    startedAt: startedAtValues[0] || null,
    uptimeSeconds: uptimes.length ? Math.min(...uptimes) : null,
    testMode,
    chains,
    lastLogAt: newestIso(containers.map((container) => container.lastLogAt)) || parsed.lastLogAt,
    lastRefreshAt: now.toISOString(),
    containerCount: containers.length,
    runningCount,
    expectedCount: containers.length,
  };
}

function summarizeTestMode(values) {
  const modes = Array.from(new Set(values));
  if (modes.length === 1) return modes[0];
  if (modes.includes("unknown")) return "unknown";
  return "mixed";
}

function newestIso(values) {
  return values.filter(Boolean).sort().at(-1) || null;
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
  const near = data?.near || {};
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
    activeDebtUpdatedAt: activeDebt.updatedAt || null,
    warmSweepsSinceCold: valueOrNull(activeDebt.warmSweepsSinceCold ?? parsed.latestSweep?.warmSweepsSinceCold),
    watchlistCount: valueOrNull(watchlist.count ?? parsed.latestSweep?.watchlistCount),
    watchlistUpdatedAt: watchlist.updatedAt || null,
    cyclesSinceFullSweep: valueOrNull(watchlist.cyclesSinceFullSweep ?? parsed.latestSweep?.cyclesSinceFull),
    nearCount: valueOrNull(near.count ?? parsed.latestSweep?.nearCount),
    nearUpdatedAt: near.updatedAt || null,
    backfillStatus,
    latestSweep: parsed.latestSweep || null,
    latestError: parsed.latestError || null,
    dataAvailable: Boolean(borrowerStore.exists || activeDebt.exists || watchlist.exists || near.exists),
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

function buildWarnings({ container, containers = [], parsed, chains, data, errors, now }) {
  const warnings = [];
  const targets = containers.length ? containers : [container];

  const restartThreshold = clampInt(process.env.MONITOR_HIGH_RESTART_COUNT, {
    fallback: DEFAULT_HIGH_RESTARTS,
    min: 1,
    max: 1000,
  });

  for (const target of targets) {
    if (target.state === "missing") {
      warnings.push({
        level: "critical",
        code: `container_missing_${target.name}`,
        message: `${target.name} container is missing.`,
      });
    } else if (target.state === "unknown") {
      warnings.push({
        level: "warning",
        code: `container_unknown_${target.name}`,
        message: `${target.name} container status is unknown.`,
      });
    } else if (!target.running) {
      warnings.push({
        level: "critical",
        code: `container_not_running_${target.name}`,
        message: `${target.name} container is not running.`,
      });
    }

    if (Number.isFinite(target.restartCount) && target.restartCount >= restartThreshold) {
      warnings.push({
        level: "warning",
        code: `high_restart_count_${target.name}`,
        message: `${target.name} restart count is ${target.restartCount}, which is higher than expected.`,
      });
    }

    if (target.testMode === "unknown") {
      warnings.push({
        level: "warning",
        code: `test_mode_unknown_${target.name}`,
        message: `${target.name} TEST_MODE is missing or unknown.`,
      });
    }
  }

  if (container.testMode === "mixed") {
    warnings.push({ level: "warning", code: "test_mode_mixed", message: "Fleet containers disagree on TEST_MODE." });
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
  for (const target of targets) {
    const lastLogAge = secondsSince(target.lastLogAt, now);
    if (target.running && (lastLogAge === null || lastLogAge > staleSeconds)) {
      warnings.push({
        level: "warning",
        code: `stale_logs_${target.name}`,
        message: `${target.name}: no recent bot logs seen in the last ${staleMinutes} minutes.`,
      });
    }
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
  DEFAULT_BOT_CONTAINERS,
  createStatusService,
  mergeChainSummary,
  parseChains,
  parseContainerNameList,
  parseTestMode,
  resolveContainerNames,
  resolveChains,
};
