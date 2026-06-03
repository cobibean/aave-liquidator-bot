const DURATION_RE = /^(\d+)\s*([smhd])$/i;

function parseDuration(value, fallbackMs) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallbackMs;
  }

  const match = value.trim().match(DURATION_RE);
  if (!match) {
    return fallbackMs;
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * multipliers[unit];
}

function parseSince(value, fallback = "1h", max = "24h") {
  const fallbackMs = parseDuration(fallback, 60 * 60 * 1000);
  const maxMs = parseDuration(max, 24 * 60 * 60 * 1000);
  const parsed = parseDuration(value, fallbackMs);
  return Math.max(60 * 1000, Math.min(parsed, maxMs));
}

function clampInt(value, { fallback, min, max }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function secondsSince(iso, now = new Date()) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
}

module.exports = {
  clampInt,
  parseDuration,
  parseSince,
  secondsSince,
  toIso,
};
