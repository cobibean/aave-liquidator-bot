#!/usr/bin/env node

require("dotenv").config();

const { execFileSync } = require("child_process");
const fetch = require("node-fetch");

const DIGITALOCEAN_API_URL = "https://api.digitalocean.com/v2";

async function main() {
  const apiToken = readEnv("DIGITALOCEAN_API_TOKEN", readEnv("DO_API_TOKEN"));
  const dropletName = readEnv("DIGITALOCEAN_DROPLET_NAME", readEnv("DO_DROPLET_NAME"));

  if (!apiToken || !dropletName) {
    throw new Error(
      "Set DIGITALOCEAN_API_TOKEN and DIGITALOCEAN_DROPLET_NAME in .env, then run npm run droplet:room."
    );
  }

  const droplets = await fetchDroplets(apiToken);
  const droplet = droplets.find((item) => item.name === dropletName);

  if (!droplet) {
    const names = droplets.map((item) => item.name).sort();
    throw new Error(
      `No visible DigitalOcean droplet named "${dropletName}". Visible droplets: ${names.join(", ") || "(none)"}`
    );
  }

  const publicIpv4 = getPublicIpv4(droplet);
  const minFreeMb = parsePositiveInt(readEnv("DROPLET_MIN_FREE_MB"), 1024);
  const minMemAvailableMb = parsePositiveInt(readEnv("DROPLET_MIN_MEM_AVAILABLE_MB"), 256);
  const monitoringRoom = await checkRoomViaMonitoring(apiToken, droplet, minFreeMb, minMemAvailableMb);
  const sshRoom = monitoringRoom.checked
    ? null
    : checkRoomOverSsh(droplet, publicIpv4, minFreeMb, minMemAvailableMb, monitoringRoom.reason);
  const provisioned = {
    diskGb: droplet.disk,
    memoryMb: droplet.memory,
    vcpus: droplet.vcpus,
  };

  const report = {
    droplet: {
      id: droplet.id,
      name: droplet.name,
      status: droplet.status,
      region: droplet.region && droplet.region.slug,
      sizeSlug: droplet.size_slug,
      image: droplet.image && (droplet.image.slug || droplet.image.name),
      publicIpv4,
    },
    provisioned,
    room: monitoringRoom.checked ? monitoringRoom : sshRoom,
  };

  console.log("DigitalOcean droplet room check");
  console.log(JSON.stringify(report, null, 2));

  if (report.room.checked && report.room.hasRoom === false) {
    process.exitCode = 1;
  }
}

async function fetchDroplets(apiToken) {
  const droplets = [];
  let url = `${DIGITALOCEAN_API_URL}/droplets?per_page=200`;

  while (url) {
    const body = await fetchJson(url, apiToken);
    droplets.push(...(body.droplets || []));
    url = body.links && body.links.pages && body.links.pages.next ? body.links.pages.next : "";
  }

  return droplets;
}

async function fetchJson(url, apiToken) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "User-Agent": "aave-liquidator-bot/droplet-room-check",
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = body.message || body.id || text || response.statusText;
    throw new Error(`DigitalOcean API error ${response.status}: ${message}`);
  }

  return body;
}

async function checkRoomViaMonitoring(apiToken, droplet, minFreeMb, minMemAvailableMb) {
  try {
    const [filesystemFree, memoryAvailable] = await Promise.all([
      fetchLatestDropletMetric(apiToken, droplet.id, "filesystem_free", (result) => {
        const mountpoint = result.metric && result.metric.mountpoint;
        return mountpoint === "/";
      }),
      fetchLatestDropletMetric(apiToken, droplet.id, "memory_available"),
    ]);

    if (!filesystemFree && !memoryAvailable) {
      return {
        checked: false,
        reason: "DigitalOcean monitoring returned no filesystem or memory samples.",
      };
    }

    const diskAvailableMb = filesystemFree ? bytesToMb(filesystemFree.value) : null;
    const memoryAvailableMb = memoryAvailable ? bytesToMb(memoryAvailable.value) : null;
    const diskOk = diskAvailableMb === null || diskAvailableMb >= minFreeMb;
    const memoryOk = memoryAvailableMb === null || memoryAvailableMb >= minMemAvailableMb;

    return {
      checked: true,
      source: "digitalocean-monitoring",
      minFreeMb,
      minMemAvailableMb,
      hasRoom: diskOk && memoryOk,
      disk: {
        mount: filesystemFree && filesystemFree.metric && filesystemFree.metric.mountpoint,
        availableMb: diskAvailableMb,
        sampledAt: filesystemFree && new Date(filesystemFree.timestamp * 1000).toISOString(),
      },
      memory: {
        availableMb: memoryAvailableMb,
        sampledAt: memoryAvailable && new Date(memoryAvailable.timestamp * 1000).toISOString(),
      },
    };
  } catch (error) {
    return {
      checked: false,
      reason: `DigitalOcean monitoring unavailable: ${error.message}`,
    };
  }
}

async function fetchLatestDropletMetric(apiToken, dropletId, metricName, preferResult = null) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 30 * 60;
  const params = new URLSearchParams({
    host_id: String(dropletId),
    start: String(start),
    end: String(end),
  });
  const body = await fetchJson(
    `${DIGITALOCEAN_API_URL}/monitoring/metrics/droplet/${metricName}?${params.toString()}`,
    apiToken
  );
  const results = body.data && Array.isArray(body.data.result) ? body.data.result : [];
  const candidates = preferResult ? results.filter(preferResult) : results;
  const preferred = candidates.length > 0 ? candidates : results;
  const latest = preferred
    .map((result) => {
      const value = getLatestMetricValue(result.values);
      return value
        ? {
            metric: result.metric || {},
            timestamp: value.timestamp,
            value: value.value,
          }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  return latest || null;
}

function getLatestMetricValue(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  for (let index = values.length - 1; index >= 0; index -= 1) {
    const sample = values[index];
    const timestamp = Number(sample && sample[0]);
    const value = Number(sample && sample[1]);

    if (Number.isFinite(timestamp) && Number.isFinite(value)) {
      return { timestamp, value };
    }
  }

  return null;
}

function checkRoomOverSsh(droplet, publicIpv4, minFreeMb, minMemAvailableMb, fallbackReason) {
  const sshKeyPath = readEnv("DROPLET_SSH_KEY_PATH");
  const sshHost = readEnv("DROPLET_SSH_HOST", publicIpv4);

  if (!sshKeyPath) {
    return {
      checked: false,
      reason:
        fallbackReason ||
        "Set DROPLET_SSH_KEY_PATH to measure actual free disk and memory. API data only shows provisioned size.",
    };
  }

  if (!sshHost) {
    return {
      checked: false,
      reason: "No public IPv4 address found. Set DROPLET_SSH_HOST to override.",
    };
  }

  const sshUser = readEnv("DROPLET_SSH_USER", "root");
  const sshPort = readEnv("DROPLET_SSH_PORT", "22");
  const appDir = readEnv("DROPLET_APP_DIR", "/opt/aave-liquidator-bot");
  const remoteScript = buildRemoteRoomScript(appDir);
  const stdout = execFileSync(
    "ssh",
    [
      "-i",
      sshKeyPath,
      "-p",
      String(sshPort),
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=accept-new",
      `${sshUser}@${sshHost}`,
      "sh",
      "-s",
    ],
    {
      encoding: "utf8",
      input: remoteScript,
      timeout: 20_000,
    }
  );

  const parsed = parseSshRoomOutput(stdout);
  const diskOk = parsed.disk.availableMb >= minFreeMb;
  const memoryOk = parsed.memory.availableMb === null || parsed.memory.availableMb >= minMemAvailableMb;

  return {
    checked: true,
    source: "ssh",
    host: sshHost,
    user: sshUser,
    minFreeMb,
    minMemAvailableMb,
    hasRoom: diskOk && memoryOk,
    disk: parsed.disk,
    memory: parsed.memory,
    appDir: {
      path: appDir,
      sizeMb: parsed.appDirSizeMb,
    },
    runtime: parsed.runtime,
  };
}

function buildRemoteRoomScript(appDir) {
  return [
    "set -e",
    'echo "__DF__"',
    "df -Pm / | tail -1",
    'echo "__FREE__"',
    'if command -v free >/dev/null 2>&1; then free -m | awk \'/^Mem:/ {available=($7==""?$4:$7); print $2, $3, available}\'; else echo "unknown unknown unknown"; fi',
    'echo "__APPDIR__"',
    `APP_DIR=${shellQuote(appDir)}`,
    'if [ -d "$APP_DIR" ]; then du -sm "$APP_DIR" 2>/dev/null | awk \'{print $1}\'; else echo "missing"; fi',
    'echo "__NODE__"',
    'if command -v node >/dev/null 2>&1; then node -v; else echo "missing"; fi',
    'echo "__PM2__"',
    'if command -v pm2 >/dev/null 2>&1; then pm2 -v; else echo "missing"; fi',
  ].join("\n");
}

function parseSshRoomOutput(stdout) {
  const dfLine = getSectionLine(stdout, "__DF__");
  const freeLine = getSectionLine(stdout, "__FREE__");
  const appDirLine = getSectionLine(stdout, "__APPDIR__");
  const nodeLine = getSectionLine(stdout, "__NODE__");
  const pm2Line = getSectionLine(stdout, "__PM2__");

  return {
    disk: parseDfLine(dfLine),
    memory: parseFreeLine(freeLine),
    appDirSizeMb: appDirLine === "missing" ? null : parsePositiveInt(appDirLine, null),
    runtime: {
      node: nodeLine,
      pm2: pm2Line,
    },
  };
}

function parseDfLine(line) {
  const parts = line.trim().split(/\s+/);

  if (parts.length < 6) {
    throw new Error(`Could not parse df output: ${line}`);
  }

  return {
    filesystem: parts[0],
    totalMb: Number(parts[1]),
    usedMb: Number(parts[2]),
    availableMb: Number(parts[3]),
    usedPercent: parts[4],
    mount: parts.slice(5).join(" "),
  };
}

function parseFreeLine(line) {
  const parts = line.trim().split(/\s+/);

  if (parts.length < 3 || parts.includes("unknown")) {
    return {
      totalMb: null,
      usedMb: null,
      availableMb: null,
    };
  }

  return {
    totalMb: Number(parts[0]),
    usedMb: Number(parts[1]),
    availableMb: Number(parts[2]),
  };
}

function getSectionLine(stdout, marker) {
  const lines = stdout.split(/\r?\n/);
  const index = lines.indexOf(marker);

  if (index === -1 || index + 1 >= lines.length) {
    throw new Error(`Missing SSH output marker ${marker}`);
  }

  return lines[index + 1].trim();
}

function getPublicIpv4(droplet) {
  const addresses = droplet.networks && droplet.networks.v4 ? droplet.networks.v4 : [];
  const address = addresses.find((item) => item.type === "public");
  return address ? address.ip_address : "";
}

function readEnv(name, fallback = "") {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bytesToMb(value) {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

main().catch((error) => {
  console.error("Droplet room check failed:", error.message);
  process.exitCode = 1;
});
