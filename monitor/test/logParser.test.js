const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parseLogText } = require("../src/logParser");

const sampleLog = fs.readFileSync(path.join(__dirname, "fixtures", "sample.txt"), "utf8");

test("parses per-chain progress and liquidation activity", () => {
  const parsed = parseLogText(sampleLog, { now: new Date("2026-06-03T15:16:00.000Z") });

  assert.equal(parsed.lastLogAt, "2026-06-03T15:15:13.000000000Z");
  assert.equal(parsed.chains.base.latestLiquidatablePositions, 0);
  assert.equal(parsed.chains.base.latestCycleDurationMs, 903000);
  assert.equal(parsed.chains.base.latestSweep.durationMs, 902000);
  assert.equal(parsed.chains.avalanche.latestLiquidatablePositions, 2);
  assert.equal(parsed.chains.avalanche.latestSweep.nearCount, 7);
  assert.equal(parsed.chains.avalanche.borrowerLogCount, 523);
  assert.equal(parsed.chains.avalanche.backfillStatus, "incremental");
  assert.equal(parsed.activity.liquidatableDetections, 2);
  assert.equal(parsed.activity.liquidationAttempts, 1);
  assert.equal(parsed.activity.txsSent, 1);
  assert.equal(parsed.activity.successfulLiquidations, 1);
  assert.equal(parsed.activity.mainLoopErrors, 1);
  assert.equal(parsed.metrics.sweeps.length, 1);
  assert.equal(parsed.metrics.sweeps[0].near, 7);
  assert.equal(parsed.metrics.attempts.length, 3);
  assert.equal(parsed.metrics.attempts.find((item) => item.outcome === "mined").blockLag, 1);
  assert.equal(parsed.borrowers.some((item) => item.stage === "candidate" && item.user === "0x1111111111111111111111111111111111111111"), true);
  assert.equal(parsed.chains.arbitrum.latestError.summary.includes("token="), true);
  assert.equal(parsed.chains.arbitrum.latestError.summary.includes("abcdefghijklmnopqrstuvwxyz"), false);
});
