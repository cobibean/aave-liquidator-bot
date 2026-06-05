const { redact, redactObject } = require("./redact");

const KNOWN_CHAINS = [
  { key: "plasma", name: "Plasma Mainnet", aliases: ["plasma"] },
  { key: "arbitrum", name: "Arbitrum One", aliases: ["arbitrum", "arb"] },
  { key: "base", name: "Base", aliases: ["base"] },
  { key: "avalanche", name: "Avalanche C-Chain", aliases: ["avalanche", "avax"] },
  { key: "optimism", name: "Optimism", aliases: ["optimism", "op"] },
  { key: "ethereum", name: "Ethereum Mainnet", aliases: ["ethereum", "mainnet"] },
  { key: "linea", name: "Linea", aliases: ["linea"] },
  { key: "polygon", name: "Polygon PoS", aliases: ["polygon"] },
  { key: "metis", name: "Metis Andromeda", aliases: ["metis"] },
];

function parseLogText(text, options = {}) {
  const now = options.now || new Date();
  const result = {
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

  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim() !== "");
  let cycleLiquidatableTotal = 0;
  let flameLiquidatableCount = 0;
  const defaultChain = findChain(options.defaultChainKey || "");

  for (const rawLine of lines) {
    const { at, message } = splitDockerTimestamp(redact(rawLine));
    if (at && (!result.lastLogAt || at > result.lastLogAt)) {
      result.lastLogAt = at;
    }

    parseStartingLine(message, result);

    const chain = findChain(message) || defaultChain;
    if (chain) {
      ensureChain(result, chain);
      parseChainLine(message, at, chain, result);
    }

    parseMetricLine(message, at, chain, result);
    parseCandidateLine(message, at, chain, result);

    if (/Found liquidatable position:/i.test(message)) {
      flameLiquidatableCount += 1;
      const detail = parseLiquidatableLine(message);
      if (detail) {
        result.borrowers.push({
          at,
          chain: chain?.key || null,
          stage: "liquidatable",
          ...detail,
        });
      }
      addEvent(result, {
        at,
        type: "liquidatable",
        chain: chain?.key || null,
        message: detail?.user ? `Liquidatable position found: ${shortAddress(detail.user)}` : "Liquidatable position found",
        details: detail,
      });
    }

    const cycleMatch = message.match(/Found\s+(\d+)\s+liquidatable positions(?:\s+\(cycle\s+(\d+)ms\))?/i);
    if (cycleMatch) {
      const count = Number.parseInt(cycleMatch[1], 10);
      cycleLiquidatableTotal += count;
      if (count > 0) {
        addEvent(result, {
          at,
          type: "liquidatable",
          chain: chain?.key || null,
          message: `${count} liquidatable position${count === 1 ? "" : "s"} found`,
        });
      }
    }

    if (/Attempting liquidation with:/i.test(message)) {
      result.activity.liquidationAttempts += 1;
      addEvent(result, { at, type: "attempt", chain: chain?.key || null, message: "Liquidation attempt started" });
    }

    if (/TX sent:/i.test(message)) {
      result.activity.txsSent += 1;
      addEvent(result, { at, type: "tx_sent", chain: chain?.key || null, message: "Transaction sent" });
    }

    if (/Successful liquidation:/i.test(message)) {
      result.activity.successfulLiquidations += 1;
      addEvent(result, { at, type: "success", chain: chain?.key || null, message: "Liquidation succeeded" });
    }

    if (/Liquidation TX failed on-chain|Liquidation failed:|Transaction was replaced/i.test(message)) {
      result.activity.failedTxs += 1;
      addEvent(result, { at, type: "tx_failed", chain: chain?.key || null, message: summarizeMessage(message) });
    }

    if (/Error in main loop:/i.test(message)) {
      result.activity.mainLoopErrors += 1;
      addEvent(result, { at, type: "main_loop_error", chain: chain?.key || null, message: summarizeMessage(message) });
    }
  }

  result.activity.liquidatableDetections = Math.max(cycleLiquidatableTotal, flameLiquidatableCount);
  result.activity.newestNotableEvent = newestEvent(result.events);
  result.inferredChains = Array.from(new Set(result.inferredChains));

  return result;
}

function parseStartingLine(message, result) {
  const match = message.match(/Starting Aave Liquidator Bot on (.+?)(?:\.\.\.|$)/i);
  if (!match) return;

  for (const part of match[1].split(",")) {
    const chain = findChain(part.trim());
    if (chain) {
      ensureChain(result, chain);
      result.inferredChains.push(chain.key);
    }
  }
}

function parseChainLine(message, at, chain, result) {
  const state = ensureChain(result, chain);

  const found = message.match(/Found\s+(\d+)\s+liquidatable positions(?:\s+\(cycle\s+(\d+)ms\))?/i);
  if (found) {
    state.latestLiquidatablePositions = Number.parseInt(found[1], 10);
    state.latestLiquidatableAt = at;
    if (found[2]) {
      state.latestCycleDurationMs = Number.parseInt(found[2], 10);
    }
  }

  const sweepStart = message.match(/(COLD|WARM|watchlist)\s+HF sweep of\s+(\d+)\s+\(known\s+(\d+),\s+active-debt\s+(\d+),\s+watch\s+(\d+),\s+cyclesSinceFull\s+(\d+),\s+warmSinceCold\s+(\d+)/i);
  if (sweepStart) {
    state.latestSweep = {
      ...(state.latestSweep || {}),
      type: sweepStart[1].toUpperCase() === "WATCHLIST" ? "watchlist" : sweepStart[1].toUpperCase(),
      sweepCount: Number.parseInt(sweepStart[2], 10),
      knownBorrowers: Number.parseInt(sweepStart[3], 10),
      activeDebtCount: Number.parseInt(sweepStart[4], 10),
      watchlistCount: Number.parseInt(sweepStart[5], 10),
      cyclesSinceFull: Number.parseInt(sweepStart[6], 10),
      warmSweepsSinceCold: Number.parseInt(sweepStart[7], 10),
      at,
    };
  }

  const sweepDone = message.match(/swept\s+(\d+)\s+HFs in\s+(\d+)ms;\s+(\d+)\s+below\s+([0-9.]+),\s+(\d+)\s+above\s+\$?([0-9.]+)\s+debt;\s+watchlist now\s+(\d+)(?:,\s+near\s+(\d+))?/i);
  if (sweepDone) {
    state.latestSweep = {
      ...(state.latestSweep || {}),
      sweepCount: Number.parseInt(sweepDone[1], 10),
      durationMs: Number.parseInt(sweepDone[2], 10),
      belowThreshold: Number.parseInt(sweepDone[3], 10),
      threshold: Number.parseFloat(sweepDone[4]),
      candidatesAboveDebt: Number.parseInt(sweepDone[5], 10),
      minDebtUsd: Number.parseFloat(sweepDone[6]),
      watchlistCount: Number.parseInt(sweepDone[7], 10),
      nearCount: sweepDone[8] ? Number.parseInt(sweepDone[8], 10) : state.latestSweep?.nearCount ?? null,
      at,
    };
  }

  const knownBorrowers = message.match(/:\s+(\d+)\s+known borrowers\s+\(\+(\d+)\s+new this scan\)/i);
  if (knownBorrowers) {
    state.borrowerLogCount = Number.parseInt(knownBorrowers[1], 10);
    state.newBorrowersLastScan = Number.parseInt(knownBorrowers[2], 10);
    state.backfillStatus = "incremental";
  }

  const backfillComplete = message.match(/BACKFILL complete.*?(\d+)\s+known borrowers/i);
  if (backfillComplete) {
    state.borrowerLogCount = Number.parseInt(backfillComplete[1], 10);
    state.backfillStatus = "done";
  }

  if (/BACKFILL Borrow scan|RESUME Borrow scan/i.test(message)) {
    state.backfillStatus = "backfilling";
  }

  if (/incremental Borrow scan/i.test(message)) {
    state.backfillStatus = "incremental";
  }

  if (/Error in main loop:|Borrow scan failed|Failed to read|Failed to fetch|Liquidation failed:|Liquidation TX failed/i.test(message)) {
    state.latestError = {
      at,
      summary: summarizeMessage(message),
    };
  }
}

function parseMetricLine(message, at, chain, result) {
  const marker = "📊 METRIC ";
  const index = message.indexOf(marker);
  if (index === -1) return;

  const fields = parseMetricFields(message.slice(index + marker.length));
  const ev = fields.ev;
  if (!ev) return;

  const record = {
    at,
    chain: fields.chain || chain?.key || null,
    ...fields,
  };
  delete record.ev;
  normalizeMetricNumbers(record);

  if (ev === "sweep") {
    result.metrics.sweeps.push(record);
    const metricChain = record.chain ? findChain(record.chain) : chain;
    if (metricChain) {
      const state = ensureChain(result, metricChain);
      state.latestSweep = {
        ...(state.latestSweep || {}),
        type: record.type || state.latestSweep?.type || null,
        sweepCount: record.swept ?? state.latestSweep?.sweepCount ?? null,
        durationMs: record.sweepMs ?? state.latestSweep?.durationMs ?? null,
        belowThreshold: record.below ?? state.latestSweep?.belowThreshold ?? null,
        candidatesAboveDebt: record.candidates ?? state.latestSweep?.candidatesAboveDebt ?? null,
        watchlistCount: record.watch ?? state.latestSweep?.watchlistCount ?? null,
        nearCount: record.near ?? state.latestSweep?.nearCount ?? null,
        at,
      };
    }
    addEvent(result, {
      at,
      type: "sweep",
      chain: record.chain,
      message: `${record.type || "sweep"} swept ${numberText(record.swept)} users in ${numberText(record.sweepMs)}ms`,
      details: record,
    });
    return;
  }

  if (ev === "attempt") {
    result.metrics.attempts.push(record);
    addEvent(result, {
      at,
      type: `attempt_${record.outcome || "unknown"}`,
      chain: record.chain,
      message: attemptMessage(record),
      details: record,
    });
  }
}

function parseMetricFields(text) {
  const fields = {};
  for (const part of String(text || "").trim().split(/\s+/)) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    fields[key] = redact(value);
  }
  return fields;
}

function normalizeMetricNumbers(record) {
  const numericKeys = [
    "swept",
    "sweepMs",
    "below",
    "candidates",
    "watch",
    "near",
    "hf",
    "decideMs",
    "deliverMs",
    "detectBlock",
    "minedBlock",
    "blockLag",
    "gasUsed",
    "nonce",
    "prioGwei",
    "estGasNative",
  ];

  for (const key of numericKeys) {
    if (record[key] === undefined) continue;
    const value = Number(record[key]);
    if (Number.isFinite(value)) record[key] = value;
  }
}

function parseCandidateLine(message, at, chain, result) {
  const candidate = message.match(/👀\s+(0x[a-fA-F0-9]{40}):\s+HF\s+([0-9.]+),\s+~\$([0-9.]+)\s+total debt;\s+primary\s+([0-9.]+)\s+([A-Za-z0-9._-]+)/);
  if (candidate) {
    const detail = {
      user: candidate[1],
      healthFactor: Number.parseFloat(candidate[2]),
      totalDebtUsd: Number.parseFloat(candidate[3]),
      primaryDebt: Number.parseFloat(candidate[4]),
      debtSymbol: candidate[5],
    };
    result.borrowers.push({
      at,
      chain: chain?.key || null,
      stage: "candidate",
      ...detail,
    });
    addEvent(result, {
      at,
      type: "candidate",
      chain: chain?.key || null,
      message: `${shortAddress(detail.user)} HF ${detail.healthFactor.toFixed(4)} debt ~$${Math.round(detail.totalDebtUsd)}`,
      details: detail,
    });
    return;
  }

  const health = message.match(/Health factor for\s+(0x[a-fA-F0-9]{40}):\s+([0-9.]+)/i);
  if (health) {
    result.borrowers.push({
      at,
      chain: chain?.key || null,
      stage: "health_check",
      user: health[1],
      healthFactor: Number.parseFloat(health[2]),
    });
  }

  const precheckFailed = message.match(/pre-check failed for\s+(0x[a-fA-F0-9]{40}).*?skipping\s+\((.+)\)/i);
  if (precheckFailed) {
    addEvent(result, {
      at,
      type: "precheck_failed",
      chain: chain?.key || null,
      message: `${shortAddress(precheckFailed[1])} pre-check failed`,
      details: {
        user: precheckFailed[1],
        reason: summarizeMessage(precheckFailed[2]),
      },
    });
  }

  const precheckPassed = message.match(/pre-check passed for\s+(0x[a-fA-F0-9]{40})/i);
  if (precheckPassed) {
    addEvent(result, {
      at,
      type: "precheck_passed",
      chain: chain?.key || null,
      message: `${shortAddress(precheckPassed[1])} pre-check passed`,
      details: { user: precheckPassed[1] },
    });
  }

  const floor = message.match(/min-profit floor\s+([0-9.]+)\s+([A-Za-z0-9._-]+)/i);
  if (floor) {
    addEvent(result, {
      at,
      type: "min_profit_floor",
      chain: chain?.key || null,
      message: `Min-profit floor ${floor[1]} ${floor[2]}`,
      details: {
        amount: Number.parseFloat(floor[1]),
        symbol: floor[2],
      },
    });
  }
}

function parseLiquidatableLine(message) {
  const match = message.match(/Found liquidatable position:\s+(0x[a-fA-F0-9]{40})\s+\|\s+HF:\s+([0-9.]+)\s+\|\s+Debt:\s+([0-9.]+)\s+([A-Za-z0-9._-]+)/i);
  if (!match) return null;
  return {
    user: match[1],
    healthFactor: Number.parseFloat(match[2]),
    primaryDebt: Number.parseFloat(match[3]),
    debtSymbol: match[4],
  };
}

function ensureChain(result, chain) {
  if (!result.chains[chain.key]) {
    result.chains[chain.key] = {
      key: chain.key,
      name: chain.name,
      latestLiquidatablePositions: null,
      latestLiquidatableAt: null,
      latestCycleDurationMs: null,
      borrowerLogCount: null,
      newBorrowersLastScan: null,
      backfillStatus: "unknown",
      latestSweep: null,
      latestError: null,
    };
  }
  result.inferredChains.push(chain.key);
  return result.chains[chain.key];
}

function findChain(text) {
  const normalized = normalize(text);
  return KNOWN_CHAINS.find((chain) => {
    const names = [chain.key, chain.name, ...chain.aliases].map(normalize);
    return names.some((name) => {
      if (normalized === name) return true;
      return normalized.includes(`${name}:`) || normalized.includes(`${name} `) || normalized.includes(` ${name}`);
    });
  }) || null;
}

function splitDockerTimestamp(line) {
  const match = String(line).match(/^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s+(.*)$/);
  if (!match) {
    return { at: null, message: line };
  }
  return { at: match[1], message: match[2] };
}

function addEvent(result, event) {
  result.events.push({
    at: event.at || null,
    type: event.type,
    chain: event.chain,
    message: redact(event.message),
    details: redactObject(event.details || null),
  });
}

function attemptMessage(record) {
  const user = record.user ? `${shortAddress(record.user)} ` : "";
  const outcome = record.outcome || "unknown";
  if (record.tx) return `${user}${outcome} ${shortHash(record.tx)}`;
  if (record.reason) return `${user}${outcome}: ${summarizeMessage(record.reason)}`;
  return `${user}${outcome}`;
}

function shortAddress(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function shortHash(value) {
  const text = String(value || "");
  return text.length > 14 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text;
}

function numberText(value) {
  return Number.isFinite(value) ? String(value) : "-";
}

function newestEvent(events) {
  if (events.length === 0) return null;
  return events.reduce((latest, event) => {
    if (!latest) return event;
    if (!latest.at) return event;
    if (!event.at) return latest;
    return event.at >= latest.at ? event : latest;
  }, null);
}

function summarizeMessage(message) {
  return redact(String(message).replace(/\s+/g, " ").trim()).slice(0, 220);
}

function normalize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

module.exports = {
  KNOWN_CHAINS,
  findChain,
  parseLogText,
  splitDockerTimestamp,
};
