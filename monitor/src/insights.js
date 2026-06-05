const { getSafeChainMetadata } = require("./chainMetadata");

const LOSING_OUTCOMES = new Set([
  "precheck_fail",
  "send_error",
  "reverted",
  "replaced",
  "confirm_error",
]);

function buildInsights({ container = {}, containers = [], chains = [], parsed = {}, warnings = [], now = new Date() }) {
  const eventStream = latest(parsed.events || [], 40);
  const attempts = latest(parsed.metrics?.attempts || [], 30);
  const sweeps = latest(parsed.metrics?.sweeps || [], 60);
  const containerByChain = mapContainersByChain(containers);

  return {
    opportunityRadar: buildOpportunityRadar(chains),
    pipeline: buildPipeline(attempts),
    missed: buildMissedFeed({ attempts, activity: parsed.activity || {} }),
    gas: buildGasPanel({ chains, attempts, containerByChain }),
    watchlistQuality: buildWatchlistQuality(chains),
    chainSla: buildChainSla({ chains, containers: containerByChain, now }),
    eventStream,
    borrowerDetails: buildBorrowerDetails({ borrowers: parsed.borrowers || [], attempts }),
    routerHealth: buildRouterHealth(chains),
    history: buildHistory({ attempts, sweeps, now }),
    alerts: buildAlerts({ warnings, chains, containers, now }),
    deployment: buildDeployment({ container, containers }),
    instrumentationGaps: buildInstrumentationGaps(),
  };
}

function buildOpportunityRadar(chains) {
  const rows = chains.map((chain) => {
    const liquidatable = finiteOrZero(chain.latestLiquidatablePositions);
    const watchlist = finiteOrZero(chain.watchlistCount);
    const near = finiteOrZero(chain.nearCount);
    const activeDebt = finiteOrZero(chain.activeDebtCount);
    const known = finiteOrZero(chain.borrowerStoreCount);

    const watchOnly = Math.max(0, watchlist - liquidatable);
    const nearOnly = Math.max(0, near - watchlist);
    const activeOnly = Math.max(0, activeDebt - near);
    const knownOnly = Math.max(0, known - activeDebt);

    return {
      chain: chain.key,
      name: chain.name,
      latestLiquidatable: nullableNumber(chain.latestLiquidatablePositions),
      buckets: [
        { label: "HF < 1.00", count: liquidatable, tone: "danger" },
        { label: "1.00-1.25 watch", count: watchOnly, tone: "hot" },
        { label: "1.25-1.50 near", count: nearOnly, tone: "warm" },
        { label: "Active debt", count: activeOnly, tone: "cool" },
        { label: "Known only", count: knownOnly, tone: "muted" },
      ],
      totalTracked: known,
      dataFreshnessMs: minPositive([
        ageMs(chain.borrowerStoreUpdatedAt),
        ageMs(chain.watchlistUpdatedAt),
        ageMs(chain.nearUpdatedAt),
        ageMs(chain.activeDebtUpdatedAt),
      ]),
    };
  });

  return {
    rows,
    totals: {
      liquidatable: sum(rows, (row) => row.buckets[0].count),
      watchlist: sum(chains, (chain) => finiteOrZero(chain.watchlistCount)),
      near: sum(chains, (chain) => finiteOrZero(chain.nearCount)),
      activeDebt: sum(chains, (chain) => finiteOrZero(chain.activeDebtCount)),
      knownBorrowers: sum(chains, (chain) => finiteOrZero(chain.borrowerStoreCount)),
    },
    note: "Buckets are derived from persisted watch/near/active-debt stores plus the latest sweep result.",
  };
}

function buildPipeline(attempts) {
  const byOutcome = countBy(attempts, (attempt) => attempt.outcome || "unknown");
  const latestAttempts = attempts.slice(0, 12).map((attempt) => ({
    at: attempt.at,
    chain: attempt.chain,
    user: attempt.user || null,
    outcome: attempt.outcome || "unknown",
    hf: nullableNumber(attempt.hf),
    decideMs: nullableNumber(attempt.decideMs),
    deliverMs: nullableNumber(attempt.deliverMs),
    detectBlock: nullableNumber(attempt.detectBlock),
    minedBlock: nullableNumber(attempt.minedBlock),
    blockLag: nullableNumber(attempt.blockLag),
    prioGwei: nullableNumber(attempt.prioGwei),
    tx: attempt.tx || null,
    reason: attempt.reason || null,
  }));

  return {
    latestAttempts,
    summary: {
      total: attempts.length,
      sent: byOutcome.sent || 0,
      mined: byOutcome.mined || 0,
      precheckFailed: byOutcome.precheck_fail || 0,
      sendErrors: byOutcome.send_error || 0,
      reverted: byOutcome.reverted || 0,
      confirmErrors: byOutcome.confirm_error || 0,
      replaced: byOutcome.replaced || 0,
      testModeOk: byOutcome.testmode_ok || 0,
    },
    latencies: {
      latestDecideMs: firstNumber(attempts, "decideMs"),
      latestDeliverMs: firstNumber(attempts, "deliverMs"),
      latestBlockLag: firstNumber(attempts, "blockLag"),
    },
  };
}

function buildMissedFeed({ attempts, activity }) {
  const items = attempts
    .filter((attempt) => LOSING_OUTCOMES.has(attempt.outcome))
    .slice(0, 20)
    .map((attempt) => ({
      at: attempt.at,
      chain: attempt.chain,
      user: attempt.user || null,
      outcome: attempt.outcome,
      likelyCause: likelyMissCause(attempt),
      reason: attempt.reason || null,
      tx: attempt.tx || null,
    }));

  const detections = finiteOrZero(activity.liquidatableDetections);
  const attemptsCount = finiteOrZero(activity.liquidationAttempts);
  if (detections > attemptsCount) {
    items.unshift({
      at: activity.newestNotableEvent?.at || null,
      chain: activity.newestNotableEvent?.chain || null,
      user: null,
      outcome: "detected_not_attempted",
      likelyCause: "Detected aggregate exceeded attempts in this log window.",
      reason: `${detections} detection(s), ${attemptsCount} attempt(s). Per-borrower attribution needs richer candidate IDs.`,
      tx: null,
    });
  }

  return {
    items,
    note: items.length
      ? "This feed uses our own failed/precheck outcomes. Competitor winner attribution needs a chain liquidation feed."
      : "No missed or failed opportunities detected in the current log window.",
  };
}

function buildGasPanel({ chains, attempts, containerByChain }) {
  return chains.map((chain) => {
    const metadata = getSafeChainMetadata(chain.key);
    const latestAttempt = attempts.find((attempt) => attempt.chain === chain.key) || null;
    const env = containerByChain[chain.key]?.env || {};

    return {
      chain: chain.key,
      name: chain.name,
      nativeToken: metadata.nativeToken,
      debtSymbol: metadata.debtSymbol,
      liquidationGasLimit: metadata.liquidationGasLimit,
      gasPriceBumpGwei: metadata.gasPriceBumpGwei,
      latestPriorityGwei: nullableNumber(latestAttempt?.prioGwei),
      latestGasUsed: nullableNumber(latestAttempt?.gasUsed),
      latestEstimatedGasNative: nullableNumber(latestAttempt?.estGasNative),
      minProfitUsd: env.MIN_PROFIT_USD || null,
      profitSafetyMultiple: env.PROFIT_SAFETY_MULTIPLE || null,
      priorityFeeMultiple: env.PRIORITY_FEE_MULTIPLE || null,
      maxPriorityFeeGwei: env.MAX_PRIORITY_FEE_GWEI || null,
      walletGasStatus: "not_instrumented",
      walletGasNote: "Needs a read-only balance probe; the monitor does not expose wallet or private-key data.",
    };
  });
}

function buildWatchlistQuality(chains) {
  return chains.map((chain) => {
    const activeDebt = finiteOrZero(chain.activeDebtCount);
    const watchlist = finiteOrZero(chain.watchlistCount);
    const near = finiteOrZero(chain.nearCount);
    return {
      chain: chain.key,
      name: chain.name,
      watchlist,
      near,
      activeDebt,
      knownBorrowers: nullableNumber(chain.borrowerStoreCount),
      watchCoveragePct: pct(watchlist, activeDebt),
      nearCoveragePct: pct(near, activeDebt),
      cyclesSinceFullSweep: nullableNumber(chain.cyclesSinceFullSweep),
      warmSweepsSinceCold: nullableNumber(chain.warmSweepsSinceCold),
      latestSweepType: chain.latestSweep?.type || null,
      latestSweepMs: nullableNumber(chain.latestSweep?.durationMs),
      latestSweepSize: nullableNumber(chain.latestSweep?.sweepCount),
      watchlistAgeMs: ageMs(chain.watchlistUpdatedAt),
      nearAgeMs: ageMs(chain.nearUpdatedAt),
      activeDebtAgeMs: ageMs(chain.activeDebtUpdatedAt),
    };
  });
}

function buildChainSla({ chains, containers, now }) {
  return chains.map((chain) => {
    const runtime = containers[chain.key] || {};
    const logAgeMs = ageMs(runtime.lastLogAt, now);
    const cycleMs = nullableNumber(chain.latestCycleDurationMs);
    const sweepMs = nullableNumber(chain.latestSweep?.durationMs);
    const status = !runtime.running
      ? "down"
      : logAgeMs !== null && logAgeMs > 30 * 60 * 1000
        ? "stale"
        : "healthy";

    return {
      chain: chain.key,
      name: chain.name,
      status,
      container: runtime.name || null,
      running: Boolean(runtime.running),
      restartCount: nullableNumber(runtime.restartCount),
      logAgeMs,
      latestCycleMs: cycleMs,
      latestSweepMs: sweepMs,
      latestError: chain.latestError?.summary || null,
    };
  });
}

function buildBorrowerDetails({ borrowers, attempts }) {
  const rows = [];
  const seen = new Set();

  for (const item of latest(borrowers, 80)) {
    const key = `${item.chain || "unknown"}:${String(item.user || "").toLowerCase()}`;
    if (!item.user || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      at: item.at,
      chain: item.chain,
      user: item.user,
      stage: item.stage,
      healthFactor: nullableNumber(item.healthFactor),
      totalDebtUsd: nullableNumber(item.totalDebtUsd),
      primaryDebt: nullableNumber(item.primaryDebt),
      debtSymbol: item.debtSymbol || null,
    });
  }

  for (const attempt of attempts) {
    const key = `${attempt.chain || "unknown"}:${String(attempt.user || "").toLowerCase()}`;
    if (!attempt.user || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      at: attempt.at,
      chain: attempt.chain,
      user: attempt.user,
      stage: `attempt_${attempt.outcome || "unknown"}`,
      healthFactor: nullableNumber(attempt.hf),
      totalDebtUsd: null,
      primaryDebt: null,
      debtSymbol: null,
    });
  }

  return rows.slice(0, 20);
}

function buildRouterHealth(chains) {
  return chains.map((chain) => {
    const metadata = getSafeChainMetadata(chain.key);
    const readiness = [
      metadata.hasRouter,
      metadata.hardenedLiquidator,
      metadata.hasPool,
      metadata.hasOracle,
    ].every(Boolean)
      ? "ready"
      : "check";

    return {
      chain: chain.key,
      name: chain.name,
      chainId: metadata.chainId,
      readiness,
      hasPool: metadata.hasPool,
      hasOracle: metadata.hasOracle,
      hasRouter: metadata.hasRouter,
      hardenedLiquidator: metadata.hardenedLiquidator,
      pathAware: metadata.pathAware,
      preflightStatus: "config_only",
      note: "Live path/callStatic preflight is performed by the bot on candidates; monitor shows safe config readiness.",
    };
  });
}

function buildHistory({ attempts, sweeps, now }) {
  const bucketMs = 60 * 60 * 1000;
  const bucketCount = 12;
  const end = floorTime(now, bucketMs) + bucketMs;
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const start = end - (bucketCount - index) * bucketMs;
    return {
      start: new Date(start).toISOString(),
      end: new Date(start + bucketMs).toISOString(),
      sweeps: 0,
      attempts: 0,
      sent: 0,
      mined: 0,
      failures: 0,
      avgSweepMs: null,
      _sweepTotalMs: 0,
    };
  });

  for (const sweep of sweeps) {
    const bucket = bucketFor(sweep.at, buckets);
    if (!bucket) continue;
    bucket.sweeps += 1;
    if (Number.isFinite(sweep.sweepMs)) {
      bucket._sweepTotalMs += sweep.sweepMs;
      bucket.avgSweepMs = Math.round(bucket._sweepTotalMs / bucket.sweeps);
    }
  }

  for (const attempt of attempts) {
    const bucket = bucketFor(attempt.at, buckets);
    if (!bucket) continue;
    bucket.attempts += 1;
    if (attempt.outcome === "sent") bucket.sent += 1;
    if (attempt.outcome === "mined") bucket.mined += 1;
    if (LOSING_OUTCOMES.has(attempt.outcome)) bucket.failures += 1;
  }

  return buckets.map(({ _sweepTotalMs, ...bucket }) => bucket);
}

function buildAlerts({ warnings, chains, containers, now }) {
  const alerts = warnings.map((warning) => ({
    level: warning.level || "warning",
    title: warning.level === "critical" ? "Needs attention" : "Watch",
    message: warning.message,
    code: warning.code,
  }));

  for (const container of containers) {
    if (container.running && ageMs(container.lastLogAt, now) > 30 * 60 * 1000) {
      alerts.push({
        level: "warning",
        title: "Stale logs",
        message: `${container.name} has not emitted a recent log line.`,
        code: `stale_${container.name}`,
      });
    }
  }

  for (const chain of chains) {
    if (!chain.dataAvailable) {
      alerts.push({
        level: "warning",
        title: "Missing data",
        message: `${chain.name} has no mounted borrower/watchlist data yet.`,
        code: `missing_data_${chain.key}`,
      });
    }
  }

  return alerts;
}

function buildDeployment({ container, containers }) {
  return {
    service: "liquidator-monitor",
    runtime: process.version,
    nodeEnv: process.env.NODE_ENV || "development",
    listenHost: process.env.HOST || process.env.MONITOR_HOST || "0.0.0.0",
    listenPort: process.env.PORT || process.env.MONITOR_PORT || "3000",
    fleetState: container.state || "unknown",
    fleetRunning: `${container.runningCount ?? 0}/${container.expectedCount ?? containers.length}`,
    containerNames: containers.map((item) => item.name),
  };
}

function buildInstrumentationGaps() {
  return [
    {
      feature: "Wallet gas balance",
      status: "needs_read_only_probe",
      detail: "The monitor intentionally does not read PRIVATE_KEY. Add a public wallet address balance probe per chain.",
    },
    {
      feature: "Competitor winner attribution",
      status: "needs_chain_event_feed",
      detail: "Requires indexing Aave liquidation events and cross-referencing our attempt metrics.",
    },
    {
      feature: "Per-borrower HF buckets",
      status: "needs_persisted_hf_snapshot",
      detail: "Current stores persist address sets, not exact HF distributions. The radar uses watch/near/active tiers.",
    },
  ];
}

function likelyMissCause(attempt) {
  switch (attempt.outcome) {
    case "precheck_fail":
      return "Bot saw a candidate but callStatic rejected it before gas spend.";
    case "send_error":
      return "Broadcast failed before the tx entered the mempool.";
    case "reverted":
      return "Tx landed but reverted on-chain.";
    case "replaced":
      return "Nonce was replaced before confirmation.";
    case "confirm_error":
      return "Tx broadcast succeeded, but confirmation failed.";
    default:
      return "Unknown";
  }
}

function mapContainersByChain(containers) {
  const map = {};
  for (const container of containers || []) {
    for (const chain of container.chains || []) {
      map[chain] = container;
    }
  }
  return map;
}

function latest(items, limit) {
  return [...items]
    .sort((a, b) => timeValue(b.at) - timeValue(a.at))
    .slice(0, limit);
}

function bucketFor(iso, buckets) {
  const time = timeValue(iso);
  if (!Number.isFinite(time)) return null;
  return buckets.find((bucket) => time >= timeValue(bucket.start) && time < timeValue(bucket.end)) || null;
}

function floorTime(date, bucketMs) {
  return Math.floor(new Date(date).getTime() / bucketMs) * bucketMs;
}

function timeValue(iso) {
  const value = new Date(iso || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function ageMs(iso, now = new Date()) {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return null;
  return Math.max(0, new Date(now).getTime() - value);
}

function minPositive(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? Math.min(...finite) : null;
}

function sum(items, mapper) {
  return items.reduce((total, item) => total + finiteOrZero(mapper(item)), 0);
}

function countBy(items, mapper) {
  return items.reduce((counts, item) => {
    const key = mapper(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function pct(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((value / total) * 1000) / 10;
}

function firstNumber(items, key) {
  const item = items.find((entry) => Number.isFinite(entry[key]));
  return item ? item[key] : null;
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function nullableNumber(value) {
  return Number.isFinite(value) ? value : null;
}

module.exports = {
  buildInsights,
};
