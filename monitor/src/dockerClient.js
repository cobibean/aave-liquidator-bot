const fs = require("fs");
const http = require("http");
const { redact } = require("./redact");

const DEFAULT_SOCKET = "/var/run/docker.sock";
const SAFE_ENV_KEYS = new Set([
  "TEST_MODE",
  "CHAINS",
  "BLOCK_TRIGGER",
  "ASYNC_SEND",
  "MAX_INFLIGHT_TX",
  "VERBOSE_HEALTH_LOGS",
  "LIQUIDATION_THRESHOLD",
  "MIN_DEBT_USD",
  "WATCHLIST_HF",
  "NEAR_HF",
  "FULL_SWEEP_EVERY_N",
  "COLD_SWEEP_EVERY_N",
  "SCAN_INTERVAL_MS",
  "PRIORITY_FEE_MULTIPLE",
  "BASE_FEE_MULTIPLE",
  "MIN_PRIORITY_FEE_GWEI",
  "MAX_PRIORITY_FEE_GWEI",
  "PROFIT_SAFETY_MULTIPLE",
  "MIN_PROFIT_USD",
]);

class DockerClient {
  constructor({
    socketPath = process.env.DOCKER_SOCKET || DEFAULT_SOCKET,
    containerName = process.env.MONITOR_BOT_CONTAINER || "bot-base",
  } = {}) {
    this.socketPath = socketPath;
    this.containerName = containerName;
  }

  async inspectContainer(name = this.containerName) {
    if (!this.hasSocket()) {
      return {
        ok: false,
        missing: false,
        error: `Docker socket not found at ${this.socketPath}`,
      };
    }

    const response = await this.requestBuffer(`/containers/${encodeURIComponent(name)}/json`);
    if (response.statusCode === 404) {
      return { ok: false, missing: true, error: `Container ${name} not found` };
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        ok: false,
        missing: false,
        error: `Docker inspect failed with HTTP ${response.statusCode}`,
      };
    }

    try {
      const body = JSON.parse(response.body.toString("utf8"));
      return {
        ok: true,
        raw: body,
        container: normalizeInspect(body, name),
      };
    } catch (error) {
      return { ok: false, missing: false, error: `Docker inspect JSON parse failed: ${error.message}` };
    }
  }

  async getContainerLogs(name = this.containerName, { sinceSeconds, tail = 5000 } = {}) {
    if (!this.hasSocket()) {
      return {
        ok: false,
        text: "",
        error: `Docker socket not found at ${this.socketPath}`,
      };
    }

    const params = new URLSearchParams({
      stdout: "1",
      stderr: "1",
      timestamps: "1",
      tail: String(tail),
    });
    if (Number.isFinite(sinceSeconds)) {
      params.set("since", String(Math.floor(Date.now() / 1000 - sinceSeconds)));
    }

    const response = await this.requestBuffer(`/containers/${encodeURIComponent(name)}/logs?${params.toString()}`);
    if (response.statusCode === 404) {
      return { ok: false, text: "", missing: true, error: `Container ${name} not found` };
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        ok: false,
        text: "",
        error: `Docker logs failed with HTTP ${response.statusCode}`,
      };
    }

    return {
      ok: true,
      text: redact(decodeDockerLogBuffer(response.body)),
    };
  }

  hasSocket() {
    try {
      return fs.existsSync(this.socketPath);
    } catch (_) {
      return false;
    }
  }

  requestBuffer(path) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method: "GET",
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
        }
      );
      req.on("error", reject);
      req.setTimeout(8000, () => req.destroy(new Error("Docker socket request timed out")));
      req.end();
    });
  }
}

function normalizeInspect(body, fallbackName) {
  const env = {};
  for (const entry of body?.Config?.Env || []) {
    const index = entry.indexOf("=");
    if (index === -1) continue;
    const key = entry.slice(0, index);
    const value = entry.slice(index + 1);
    if (SAFE_ENV_KEYS.has(key)) {
      env[key] = redact(value);
    }
  }

  const state = body?.State || {};
  return {
    id: body?.Id ? String(body.Id).slice(0, 12) : null,
    name: String(body?.Name || fallbackName).replace(/^\//, ""),
    status: state.Status || "unknown",
    running: Boolean(state.Running),
    startedAt: state.StartedAt && !state.StartedAt.startsWith("0001-") ? state.StartedAt : null,
    finishedAt: state.FinishedAt && !state.FinishedAt.startsWith("0001-") ? state.FinishedAt : null,
    restartCount: Number.isFinite(body?.RestartCount) ? body.RestartCount : 0,
    env,
  };
}

function decodeDockerLogBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return "";
  }

  const chunks = [];
  let offset = 0;
  let decodedFrames = 0;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const frameLength = buffer.readUInt32BE(offset + 4);
    if ((streamType !== 1 && streamType !== 2) || frameLength < 0 || offset + 8 + frameLength > buffer.length) {
      break;
    }
    chunks.push(buffer.slice(offset + 8, offset + 8 + frameLength));
    offset += 8 + frameLength;
    decodedFrames++;
  }

  if (decodedFrames > 0 && offset === buffer.length) {
    return Buffer.concat(chunks).toString("utf8");
  }

  return buffer.toString("utf8");
}

module.exports = {
  DockerClient,
  decodeDockerLogBuffer,
  normalizeInspect,
};
