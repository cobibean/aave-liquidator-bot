const statusEls = {
  refreshLabel: document.querySelector("#refresh-label"),
  botDot: document.querySelector("#bot-dot"),
  botStatus: document.querySelector("#bot-status"),
  botSubtitle: document.querySelector("#bot-subtitle"),
  modeValue: document.querySelector("#mode-value"),
  modeCaption: document.querySelector("#mode-caption"),
  restartValue: document.querySelector("#restart-value"),
  uptimeValue: document.querySelector("#uptime-value"),
  lastLogValue: document.querySelector("#last-log-value"),
  lastRefreshValue: document.querySelector("#last-refresh-value"),
  fleetCount: document.querySelector("#fleet-count"),
  containers: document.querySelector("#containers"),
  activityWindow: document.querySelector("#activity-window"),
  newestEvent: document.querySelector("#newest-event"),
  chains: document.querySelector("#chains"),
  warnings: document.querySelector("#warnings"),
  radarTotal: document.querySelector("#radar-total"),
  radar: document.querySelector("#opportunity-radar"),
  pipelineTotal: document.querySelector("#pipeline-total"),
  pipelineSummary: document.querySelector("#pipeline-summary"),
  pipelineLatencies: document.querySelector("#pipeline-latencies"),
  pipelineTable: document.querySelector("#pipeline-table"),
  missedFeed: document.querySelector("#missed-feed"),
  gasPanel: document.querySelector("#gas-panel"),
  watchlistQuality: document.querySelector("#watchlist-quality"),
  chainSla: document.querySelector("#chain-sla"),
  eventStream: document.querySelector("#event-stream"),
  borrowerDetails: document.querySelector("#borrower-details"),
  routerHealth: document.querySelector("#router-health"),
  historyPanel: document.querySelector("#history-panel"),
  instrumentationGaps: document.querySelector("#instrumentation-gaps"),
  deploymentPanel: document.querySelector("#deployment-panel"),
  winscanStatus: document.querySelector("#winscan-status"),
  winscanMeta: document.querySelector("#winscan-meta"),
  winscanOnchain: document.querySelector("#winscan-onchain"),
  winscanOurs: document.querySelector("#winscan-ours"),
  winscanTable: document.querySelector("#winscan-table"),
  winscanHistory: document.querySelector("#winscan-history"),
};

const metricEls = {
  detections: document.querySelector("#metric-detections"),
  attempts: document.querySelector("#metric-attempts"),
  txs: document.querySelector("#metric-txs"),
  success: document.querySelector("#metric-success"),
  failed: document.querySelector("#metric-failed"),
  errors: document.querySelector("#metric-errors"),
};

document.querySelector("#refresh-button").addEventListener("click", loadStatus);
document.querySelector("#load-logs").addEventListener("click", loadRawLogs);
document.querySelector("#download-logs").addEventListener("click", downloadLogs);
document.querySelector("#run-winscan").addEventListener("click", requestWinScan);
document.querySelector("#refresh-winscan").addEventListener("click", loadWinScan);

loadStatus();
loadWinScan();
setInterval(loadStatus, 60 * 1000);
setInterval(loadWinScan, 60 * 1000);

async function loadStatus() {
  statusEls.refreshLabel.textContent = "Refreshing";
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    renderStatus(status);
  } catch (error) {
    renderStatusError(error);
  }
}

function renderStatus(status) {
  const container = status.container || {};
  const containers = status.containers || [];
  const warnings = status.warnings || [];
  const critical = warnings.some((warning) => warning.level === "critical");
  const expectedCount = container.expectedCount || containers.length || 1;
  const runningCount = container.runningCount ?? (container.running ? expectedCount : 0);

  statusEls.botDot.className = `dot ${container.running ? (critical ? "dot-yellow" : "dot-green") : "dot-red"}`;
  statusEls.botStatus.textContent = containers.length > 1
    ? container.running
      ? "Fleet is running"
      : "Fleet needs attention"
    : container.running
      ? "Bot is running"
      : container.state === "missing"
        ? "Bot container is missing"
        : "Bot is not running";
  statusEls.botSubtitle.textContent = [
    containers.length > 1
      ? `${runningCount}/${expectedCount} containers running`
      : `Container: ${container.name || "unknown"}`,
    chainText(container.chains),
  ].filter(Boolean).join(" | ");

  statusEls.modeValue.textContent = modeText(container.testMode);
  statusEls.modeCaption.textContent = container.testMode === false
    ? "Live mode can submit real liquidation transactions."
    : container.testMode === "mixed"
      ? "Containers are not all using the same TEST_MODE."
    : "No other environment values are exposed.";

  statusEls.restartValue.textContent = numberOrDash(container.restartCount);
  statusEls.uptimeValue.textContent = container.uptimeSeconds
    ? `${containers.length > 1 ? "Shortest uptime" : "Uptime"} ${formatDuration(container.uptimeSeconds)}`
    : startedText(container.startedAt);
  statusEls.lastLogValue.textContent = ageText(container.lastLogAt);
  statusEls.lastRefreshValue.textContent = `Refreshed ${formatTime(status.refreshedAt)}`;
  statusEls.refreshLabel.textContent = `Last refresh ${formatTime(status.refreshedAt)}`;
  statusEls.fleetCount.textContent = containers.length > 1
    ? `${runningCount}/${expectedCount} running`
    : "1 container";

  const activity = status.activity || {};
  statusEls.activityWindow.textContent = `${activity.window || "recent"} window`;
  metricEls.detections.textContent = numberOrZero(activity.liquidatableDetections);
  metricEls.attempts.textContent = numberOrZero(activity.liquidationAttempts);
  metricEls.txs.textContent = numberOrZero(activity.txsSent);
  metricEls.success.textContent = numberOrZero(activity.successfulLiquidations);
  metricEls.failed.textContent = numberOrZero(activity.failedTxs);
  metricEls.errors.textContent = numberOrZero(activity.mainLoopErrors);
  statusEls.newestEvent.textContent = activity.newestNotableEvent
    ? `${formatTime(activity.newestNotableEvent.at)} - ${activity.newestNotableEvent.message}`
    : "No liquidations attempted recently.";

  renderContainers(containers);
  renderChains(status.chains || []);
  renderWarnings(warnings);
  renderInsights(status.insights || {});
}

function renderStatusError(error) {
  statusEls.botDot.className = "dot dot-red";
  statusEls.botStatus.textContent = "Monitor needs attention";
  statusEls.botSubtitle.textContent = error.message || "Unable to load status.";
  statusEls.refreshLabel.textContent = "Refresh failed";
}

async function loadWinScan() {
  try {
    const response = await fetch("/api/winscan");
    const result = await response.json();
    renderWinScan(result);
    return result;
  } catch (error) {
    statusEls.winscanStatus.textContent = "load failed";
    statusEls.winscanMeta.textContent = error.message || "Unable to load win scan.";
    return null;
  }
}

// Ask the runner to scan now, then poll the latest until the timestamp advances
// (the runner picks up the request within its poll interval and writes a fresh
// result). The monitor itself never runs the scan — it only requests it.
async function requestWinScan() {
  const button = document.querySelector("#run-winscan");
  const before = await loadWinScan();
  const beforeAt = before?.latest?.scannedAt || null;
  button.disabled = true;
  statusEls.winscanStatus.textContent = "requested";
  statusEls.winscanMeta.textContent = "Scan requested — waiting for the runner…";
  try {
    const response = await fetch("/api/winscan/run", { method: "POST" });
    if (!response.ok && response.status !== 202) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (HTTP ${response.status})`);
    }
    // Poll up to ~90s for a newer result.
    const deadline = Date.now() + 90 * 1000;
    while (Date.now() < deadline) {
      await sleep(3000);
      const latest = await loadWinScan();
      const at = latest?.latest?.scannedAt || null;
      if (at && at !== beforeAt) {
        statusEls.winscanStatus.textContent = "fresh";
        return;
      }
    }
    statusEls.winscanMeta.textContent = "Still waiting for the runner — it may be busy; this view auto-refreshes.";
  } catch (error) {
    statusEls.winscanStatus.textContent = "request failed";
    statusEls.winscanMeta.textContent = error.message || "Unable to request a scan.";
  } finally {
    button.disabled = false;
  }
}

function renderWinScan(result) {
  if (!result || !result.available || !result.latest) {
    statusEls.winscanStatus.textContent = "no scan yet";
    statusEls.winscanMeta.textContent = result?.error === "missing"
      ? "The winscan runner has not produced a result yet."
      : result?.error || "No scan available.";
    statusEls.winscanOnchain.textContent = "-";
    statusEls.winscanOurs.textContent = "-";
    statusEls.winscanTable.innerHTML = tableHtml(["Chain", "On-chain", "OURS"], [], "No scan data.");
    statusEls.winscanHistory.innerHTML = tableHtml(["Time", "On-chain", "OURS"], [], "No history yet.");
    return;
  }

  const latest = result.latest;
  if (latest.error) {
    statusEls.winscanStatus.textContent = "last run errored";
    statusEls.winscanMeta.textContent = `${latest.error} (${ageText(latest.scannedAt)})`;
  } else {
    const won = Number(latest.ourTotal) > 0;
    statusEls.winscanStatus.textContent = won ? "WON ✓" : "0 wins";
    statusEls.winscanStatus.className = `pill ${won ? "pill-good" : ""}`;
    statusEls.winscanMeta.textContent =
      `${latest.hours}h window · ${ageText(latest.scannedAt)} · auto-refresh every ${latest.intervalMin || 30}min`;
  }

  statusEls.winscanOnchain.textContent = numberOrDash(latest.grandTotal);
  statusEls.winscanOurs.textContent = numberOrDash(latest.ourTotal);
  statusEls.winscanOurs.parentElement.classList.toggle("winscan-won", Number(latest.ourTotal) > 0);

  const rows = (latest.chains || []).map((c) =>
    c.error
      ? [c.name || c.key, `ERROR: ${c.error}`, "-"]
      : [c.name || c.key, numberOrDash(c.total), numberOrDash(c.ours)]
  );
  statusEls.winscanTable.innerHTML = tableHtml(["Chain", "On-chain", "OURS"], rows, "No chains scanned.");

  const history = (result.history || []).slice().reverse();
  const histRows = history.map((h) => [
    formatTime(h.scannedAt),
    numberOrDash(h.grandTotal),
    numberOrDash(h.ourTotal),
  ]);
  statusEls.winscanHistory.innerHTML = tableHtml(["Time", "On-chain", "OURS"], histRows, "No history yet.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderContainers(containers) {
  statusEls.containers.innerHTML = "";
  if (!containers.length) {
    const empty = document.createElement("article");
    empty.className = "card";
    empty.innerHTML = "<strong>No containers reported</strong><p class=\"muted\">The monitor has not returned Docker container details.</p>";
    statusEls.containers.appendChild(empty);
    return;
  }

  for (const container of containers) {
    const card = document.createElement("article");
    card.className = "card container-card";
    card.innerHTML = `
      <div class="container-top">
        <div>
          <h3></h3>
          <p class="muted"></p>
        </div>
        <span class="pill"></span>
      </div>
      <div class="container-facts">
        ${factHtml("Mode", modeText(container.testMode))}
        ${factHtml("Restarts", numberOrDash(container.restartCount))}
        ${factHtml("Uptime", container.uptimeSeconds ? formatDuration(container.uptimeSeconds) : "-")}
        ${factHtml("Last log", ageText(container.lastLogAt))}
      </div>
    `;
    card.querySelector("h3").textContent = container.name || "unknown";
    card.querySelector(".muted").textContent = chainText(container.chains) || "No chain env reported";
    const pill = card.querySelector(".pill");
    pill.textContent = container.running ? "running" : container.state || "unknown";
    pill.classList.add(container.running ? "pill-good" : "pill-bad");
    statusEls.containers.appendChild(card);
  }
}

function renderChains(chains) {
  statusEls.chains.innerHTML = "";
  for (const chain of chains) {
    const card = document.createElement("article");
    card.className = "card chain-card";

    const latestError = chain.latestError?.summary || "No recent error";
    const backfill = chain.backfillStatus === "done"
      ? "Backfill done"
      : chain.backfillStatus === "incremental"
        ? "Incremental scan"
        : chain.backfillStatus === "backfilling"
          ? "Backfill running"
          : "Unknown";

    card.innerHTML = `
      <div class="chain-top">
        <h3></h3>
        <span class="pill"></span>
      </div>
      <div class="chain-facts">
        ${factHtml("Liquidatable now", numberOrDash(chain.latestLiquidatablePositions))}
        ${factHtml("Latest cycle", chain.latestCycleDurationMs ? `${chain.latestCycleDurationMs}ms` : "-")}
        ${factHtml("Borrower store", numberOrDash(chain.borrowerStoreCount))}
        ${factHtml("Backfill", backfill)}
        ${factHtml("Active debt", numberOrDash(chain.activeDebtCount))}
        ${factHtml("Watchlist", numberOrDash(chain.watchlistCount))}
        ${factHtml("Latest sweep", sweepText(chain.latestSweep))}
        ${factHtml("Latest error", latestError)}
      </div>
    `;
    card.querySelector("h3").textContent = chain.name;
    card.querySelector(".pill").textContent = chain.dataAvailable ? "data mounted" : "data missing";
    statusEls.chains.appendChild(card);
  }
}

function renderWarnings(warnings) {
  statusEls.warnings.innerHTML = "";
  if (!warnings.length) {
    const empty = document.createElement("div");
    empty.className = "warning";
    empty.innerHTML = "<strong>No attention needed</strong><span class=\"muted\">No recent warnings from the monitor.</span>";
    statusEls.warnings.appendChild(empty);
    return;
  }

  for (const warning of warnings) {
    const item = document.createElement("div");
    item.className = `warning ${warning.level || "warning"}`;
    item.innerHTML = `<strong>${warning.level === "critical" ? "Needs attention" : "Watch"}</strong><span></span>`;
    item.querySelector("span").textContent = warning.message;
    statusEls.warnings.appendChild(item);
  }
}

function renderInsights(insights) {
  renderOpportunityRadar(insights.opportunityRadar || {});
  renderPipeline(insights.pipeline || {});
  renderMisses(insights.missed || {});
  renderGasPanel(insights.gas || []);
  renderWatchlistQuality(insights.watchlistQuality || []);
  renderChainSla(insights.chainSla || []);
  renderEventStream(insights.eventStream || []);
  renderBorrowerDetails(insights.borrowerDetails || []);
  renderRouterHealth(insights.routerHealth || []);
  renderHistory(insights.history || []);
  renderInstrumentationGaps(insights.instrumentationGaps || []);
  renderDeployment(insights.deployment || {});
}

function renderOpportunityRadar(radar) {
  const totals = radar.totals || {};
  statusEls.radarTotal.textContent = `${numberOrZero(totals.liquidatable)} liquidatable`;
  statusEls.radar.innerHTML = "";

  for (const row of radar.rows || []) {
    const max = Math.max(1, ...(row.buckets || []).map((bucket) => Number(bucket.count) || 0));
    const card = document.createElement("article");
    card.className = "card radar-card";
    card.innerHTML = `
      <div class="chain-top">
        <h3>${escapeHtml(row.name || row.chain || "chain")}</h3>
        <span class="pill">${escapeHtml(numberOrDash(row.totalTracked))} known</span>
      </div>
      <div class="radar-bars">
        ${(row.buckets || []).map((bucket) => `
          <div class="bar-row ${escapeHtml(bucket.tone || "muted")}">
            <span>${escapeHtml(bucket.label)}</span>
            <div class="bar-track"><div style="width:${barWidth(bucket.count, max)}%"></div></div>
            <strong>${escapeHtml(numberOrZero(bucket.count))}</strong>
          </div>
        `).join("")}
      </div>
      <p class="muted">Data age ${ageTextFromMs(row.dataFreshnessMs)}</p>
    `;
    statusEls.radar.appendChild(card);
  }
}

function renderPipeline(pipeline) {
  const summary = pipeline.summary || {};
  const latencies = pipeline.latencies || {};
  statusEls.pipelineTotal.textContent = `${numberOrZero(summary.total)} attempts`;
  statusEls.pipelineSummary.innerHTML = [
    statChip("Sent", summary.sent),
    statChip("Mined", summary.mined),
    statChip("Precheck failed", summary.precheckFailed),
    statChip("Send errors", summary.sendErrors),
    statChip("Reverted", summary.reverted),
  ].join("");
  statusEls.pipelineLatencies.innerHTML = [
    statChip("Decide", msText(latencies.latestDecideMs)),
    statChip("Deliver", msText(latencies.latestDeliverMs)),
    statChip("Block lag", numberOrDash(latencies.latestBlockLag)),
  ].join("");

  statusEls.pipelineTable.innerHTML = tableHtml(
    ["Time", "Chain", "Outcome", "HF", "Decide", "Deliver", "Lag", "Priority", "Tx"],
    (pipeline.latestAttempts || []).map((attempt) => [
      formatTime(attempt.at),
      attempt.chain || "-",
      attempt.outcome || "-",
      decimalText(attempt.hf, 4),
      msText(attempt.decideMs),
      msText(attempt.deliverMs),
      numberOrDash(attempt.blockLag),
      gweiText(attempt.prioGwei),
      shortHash(attempt.tx),
    ]),
    "No liquidation attempts in this window."
  );
}

function renderMisses(missed) {
  const rows = missed.items || [];
  statusEls.missedFeed.innerHTML = `
    ${tableHtml(
      ["Time", "Chain", "Outcome", "Likely cause", "Borrower", "Tx"],
      rows.map((item) => [
        formatTime(item.at),
        item.chain || "-",
        item.outcome || "-",
        item.likelyCause || item.reason || "-",
        shortAddress(item.user),
        shortHash(item.tx),
      ]),
      "No missed or failed opportunities detected in this window."
    )}
    <p class="muted panel-note">${escapeHtml(missed.note || "")}</p>
  `;
}

function renderGasPanel(rows) {
  statusEls.gasPanel.innerHTML = "";
  for (const row of rows) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="chain-top">
        <h3>${escapeHtml(row.name || row.chain)}</h3>
        <span class="pill">${escapeHtml(row.nativeToken || "-")}</span>
      </div>
      <div class="chain-facts compact">
        ${factHtml("Gas limit", numberOrDash(row.liquidationGasLimit))}
        ${factHtml("Latest priority", gweiText(row.latestPriorityGwei))}
        ${factHtml("Gas used", numberOrDash(row.latestGasUsed))}
        ${factHtml("Est gas cost", nativeText(row.latestEstimatedGasNative, row.nativeToken))}
        ${factHtml("Profit safety", numberOrDash(row.profitSafetyMultiple))}
        ${factHtml("Max tip", row.maxPriorityFeeGwei ? `${row.maxPriorityFeeGwei} gwei` : "-")}
      </div>
      <p class="muted">${escapeHtml(row.walletGasNote || "")}</p>
    `;
    statusEls.gasPanel.appendChild(card);
  }
}

function renderWatchlistQuality(rows) {
  statusEls.watchlistQuality.innerHTML = "";
  for (const row of rows) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="chain-top">
        <h3>${escapeHtml(row.name || row.chain)}</h3>
        <span class="pill">${escapeHtml(row.latestSweepType || "unknown")}</span>
      </div>
      <div class="chain-facts compact">
        ${factHtml("Watchlist", numberOrDash(row.watchlist))}
        ${factHtml("Near tier", numberOrDash(row.near))}
        ${factHtml("Active debt", numberOrDash(row.activeDebt))}
        ${factHtml("Watch coverage", percentText(row.watchCoveragePct))}
        ${factHtml("Near coverage", percentText(row.nearCoveragePct))}
        ${factHtml("Sweep size", numberOrDash(row.latestSweepSize))}
        ${factHtml("Sweep time", msText(row.latestSweepMs))}
        ${factHtml("Cold counter", numberOrDash(row.warmSweepsSinceCold))}
      </div>
      <p class="muted">Watch ${ageTextFromMs(row.watchlistAgeMs)} | Near ${ageTextFromMs(row.nearAgeMs)} | Active ${ageTextFromMs(row.activeDebtAgeMs)}</p>
    `;
    statusEls.watchlistQuality.appendChild(card);
  }
}

function renderChainSla(rows) {
  statusEls.chainSla.innerHTML = "";
  for (const row of rows) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="chain-top">
        <h3>${escapeHtml(row.name || row.chain)}</h3>
        <span class="pill ${row.status === "healthy" ? "pill-good" : "pill-bad"}">${escapeHtml(row.status || "unknown")}</span>
      </div>
      <div class="chain-facts compact">
        ${factHtml("Log age", ageTextFromMs(row.logAgeMs))}
        ${factHtml("Cycle", msText(row.latestCycleMs))}
        ${factHtml("Sweep", msText(row.latestSweepMs))}
        ${factHtml("Restarts", numberOrDash(row.restartCount))}
      </div>
      <p class="muted">${escapeHtml(row.latestError || "No recent error")}</p>
    `;
    statusEls.chainSla.appendChild(card);
  }
}

function renderEventStream(events) {
  statusEls.eventStream.innerHTML = tableHtml(
    ["Time", "Chain", "Type", "Message"],
    events.map((event) => [
      formatTime(event.at),
      event.chain || "-",
      event.type || "-",
      event.message || "-",
    ]),
    "No notable events in this window."
  );
}

function renderBorrowerDetails(rows) {
  statusEls.borrowerDetails.innerHTML = tableHtml(
    ["Time", "Chain", "Borrower", "Stage", "HF", "Debt"],
    rows.map((row) => [
      formatTime(row.at),
      row.chain || "-",
      shortAddress(row.user),
      row.stage || "-",
      decimalText(row.healthFactor, 4),
      debtText(row),
    ]),
    "No per-borrower detail observed in this window."
  );
}

function renderRouterHealth(rows) {
  statusEls.routerHealth.innerHTML = "";
  for (const row of rows) {
    const ok = row.readiness === "ready";
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="chain-top">
        <h3>${escapeHtml(row.name || row.chain)}</h3>
        <span class="pill ${ok ? "pill-good" : "pill-bad"}">${escapeHtml(row.readiness || "check")}</span>
      </div>
      <div class="chain-facts compact">
        ${factHtml("Chain ID", numberOrDash(row.chainId))}
        ${factHtml("Pool", yesNo(row.hasPool))}
        ${factHtml("Oracle", yesNo(row.hasOracle))}
        ${factHtml("Router", yesNo(row.hasRouter))}
        ${factHtml("Hardened", yesNo(row.hardenedLiquidator))}
        ${factHtml("Path-aware", yesNo(row.pathAware))}
      </div>
      <p class="muted">${escapeHtml(row.note || "")}</p>
    `;
    statusEls.routerHealth.appendChild(card);
  }
}

function renderHistory(buckets) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.sweeps + bucket.attempts + bucket.failures));
  statusEls.historyPanel.innerHTML = `
    <div class="history-bars">
      ${buckets.map((bucket) => `
        <div class="history-bucket">
          <div class="history-stack" title="${escapeHtml(historyTitle(bucket))}">
            <span class="sweeps" style="height:${barWidth(bucket.sweeps, max)}%"></span>
            <span class="attempts" style="height:${barWidth(bucket.attempts, max)}%"></span>
            <span class="failures" style="height:${barWidth(bucket.failures, max)}%"></span>
          </div>
          <small>${escapeHtml(hourLabel(bucket.start))}</small>
        </div>
      `).join("")}
    </div>
    <div class="legend">
      <span><i class="legend-sweeps"></i>Sweeps</span>
      <span><i class="legend-attempts"></i>Attempts</span>
      <span><i class="legend-failures"></i>Failures</span>
    </div>
  `;
}

function renderInstrumentationGaps(gaps) {
  statusEls.instrumentationGaps.innerHTML = "";
  for (const gap of gaps) {
    const item = document.createElement("div");
    item.className = "warning";
    item.innerHTML = `<strong>${escapeHtml(gap.feature)}</strong><span>${escapeHtml(gap.status)} - ${escapeHtml(gap.detail)}</span>`;
    statusEls.instrumentationGaps.appendChild(item);
  }
}

function renderDeployment(deployment) {
  statusEls.deploymentPanel.innerHTML = tableHtml(
    ["Key", "Value"],
    [
      ["Service", deployment.service || "-"],
      ["Node", deployment.runtime || "-"],
      ["Mode", deployment.nodeEnv || "-"],
      ["Listen", `${deployment.listenHost || "-"}:${deployment.listenPort || "-"}`],
      ["Fleet", `${deployment.fleetState || "-"} ${deployment.fleetRunning || ""}`],
      ["Containers", (deployment.containerNames || []).join(", ") || "-"],
    ],
    "Deployment data unavailable."
  );
}

async function loadRawLogs() {
  const output = document.querySelector("#raw-logs");
  output.textContent = "Loading raw logs...";
  try {
    const response = await fetch(logsUrl());
    const payload = await response.json();
    output.textContent = payload.lines?.length ? payload.lines.join("\n") : "No raw log lines matched.";
  } catch (error) {
    output.textContent = `Unable to load raw logs: ${error.message}`;
  }
}

async function downloadLogs() {
  const response = await fetch(`${logsUrl()}&format=text`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "liquidator-logs.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function logsUrl() {
  const params = new URLSearchParams({
    since: document.querySelector("#logs-since").value,
    filter: document.querySelector("#logs-filter").value,
    limit: document.querySelector("#logs-limit").value,
  });
  return `/api/logs?${params.toString()}`;
}

function factHtml(label, value) {
  return `<div class="fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? "-"))}</strong></div>`;
}

function tableHtml(headers, rows, emptyText) {
  if (!rows.length) {
    return `<div class="empty-panel">${escapeHtml(emptyText)}</div>`;
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>${row.map((cell) => `<td>${escapeHtml(cell ?? "-")}</td>`).join("")}</tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function statChip(label, value) {
  return `<div class="stat-chip"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? "-"))}</strong></div>`;
}

function barWidth(value, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(4, Math.min(100, (numeric / Math.max(1, max)) * 100));
}

function msText(value) {
  return Number.isFinite(value) ? `${value}ms` : "-";
}

function gweiText(value) {
  return Number.isFinite(value) ? `${decimalText(value, 3)} gwei` : "-";
}

function nativeText(value, symbol) {
  return Number.isFinite(value) ? `${decimalText(value, 6)} ${symbol || ""}`.trim() : "-";
}

function percentText(value) {
  return Number.isFinite(value) ? `${decimalText(value, 1)}%` : "-";
}

function decimalText(value, digits) {
  return Number.isFinite(value) ? Number(value).toFixed(digits).replace(/\.?0+$/, "") : "-";
}

function debtText(row) {
  if (Number.isFinite(row.totalDebtUsd)) return `~$${Math.round(row.totalDebtUsd)}`;
  if (Number.isFinite(row.primaryDebt)) return `${decimalText(row.primaryDebt, 4)} ${row.debtSymbol || ""}`.trim();
  return "-";
}

function shortAddress(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text || "-";
}

function shortHash(value) {
  const text = String(value || "");
  return text.length > 14 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text || "-";
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function ageTextFromMs(ms) {
  if (!Number.isFinite(ms)) return "-";
  return `${formatDuration(Math.floor(ms / 1000))} ago`;
}

function historyTitle(bucket) {
  return `${formatTime(bucket.start)}: sweeps ${bucket.sweeps}, attempts ${bucket.attempts}, failures ${bucket.failures}, avg sweep ${msText(bucket.avgSweepMs)}`;
}

function hourLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString([], { hour: "numeric" });
}

function sweepText(sweep) {
  if (!sweep) return "-";
  const type = sweep.type || "sweep";
  const duration = sweep.durationMs ? ` in ${sweep.durationMs}ms` : "";
  return `${type} ${numberOrDash(sweep.sweepCount)} HFs${duration}`;
}

function chainText(chains) {
  return Array.isArray(chains) && chains.length ? `Chains: ${chains.join(", ")}` : "";
}

function modeText(value) {
  if (value === false) return "LIVE";
  if (value === true) return "TEST_MODE true";
  if (value === "mixed") return "Mixed";
  return "Unknown";
}

function startedText(startedAt) {
  return startedAt ? `Started ${formatTime(startedAt)}` : "Uptime unavailable";
}

function ageText(iso) {
  if (!iso) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  return `${formatDuration(seconds)} ago`;
}

function formatDuration(totalSeconds) {
  const seconds = Number(totalSeconds);
  if (!Number.isFinite(seconds)) return "-";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function numberOrDash(value) {
  return Number.isFinite(value) ? String(value) : "-";
}

function numberOrZero(value) {
  return Number.isFinite(value) ? String(value) : "0";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
