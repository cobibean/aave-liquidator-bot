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
  activityWindow: document.querySelector("#activity-window"),
  newestEvent: document.querySelector("#newest-event"),
  chains: document.querySelector("#chains"),
  warnings: document.querySelector("#warnings"),
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

loadStatus();
setInterval(loadStatus, 60 * 1000);

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
  const warnings = status.warnings || [];
  const critical = warnings.some((warning) => warning.level === "critical");

  statusEls.botDot.className = `dot ${container.running ? (critical ? "dot-yellow" : "dot-green") : "dot-red"}`;
  statusEls.botStatus.textContent = container.running ? "Bot is running" : container.state === "missing" ? "Bot container is missing" : "Bot is not running";
  statusEls.botSubtitle.textContent = [
    `Container: ${container.name || "unknown"}`,
    chainText(container.chains),
  ].filter(Boolean).join(" | ");

  statusEls.modeValue.textContent = container.testMode === true
    ? "TEST_MODE true"
    : container.testMode === false
      ? "TEST_MODE false"
      : "Unknown";
  statusEls.modeCaption.textContent = container.testMode === false
    ? "Live mode can submit real liquidation transactions."
    : "No other environment values are exposed.";

  statusEls.restartValue.textContent = numberOrDash(container.restartCount);
  statusEls.uptimeValue.textContent = container.uptimeSeconds ? `Uptime ${formatDuration(container.uptimeSeconds)}` : startedText(container.startedAt);
  statusEls.lastLogValue.textContent = ageText(container.lastLogAt);
  statusEls.lastRefreshValue.textContent = `Refreshed ${formatTime(status.refreshedAt)}`;
  statusEls.refreshLabel.textContent = `Last refresh ${formatTime(status.refreshedAt)}`;

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

  renderChains(status.chains || []);
  renderWarnings(warnings);
}

function renderStatusError(error) {
  statusEls.botDot.className = "dot dot-red";
  statusEls.botStatus.textContent = "Monitor needs attention";
  statusEls.botSubtitle.textContent = error.message || "Unable to load status.";
  statusEls.refreshLabel.textContent = "Refresh failed";
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

function sweepText(sweep) {
  if (!sweep) return "-";
  const type = sweep.type || "sweep";
  const duration = sweep.durationMs ? ` in ${sweep.durationMs}ms` : "";
  return `${type} ${numberOrDash(sweep.sweepCount)} HFs${duration}`;
}

function chainText(chains) {
  return Array.isArray(chains) && chains.length ? `Chains: ${chains.join(", ")}` : "";
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
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
