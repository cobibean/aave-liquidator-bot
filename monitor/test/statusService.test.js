const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DataStoreReader } = require("../src/dataStore");
const { createStatusService } = require("../src/statusService");

const sampleLog = fs.readFileSync(path.join(__dirname, "fixtures", "sample.txt"), "utf8");

test("summarizes container, logs, and read-only borrower data", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquidator-monitor-"));
  fs.writeFileSync(
    path.join(dataDir, "borrowers-base.json"),
    JSON.stringify({ count: 210921, backfillDone: true, updatedAt: "2026-06-03T15:14:00.000Z" })
  );
  fs.writeFileSync(
    path.join(dataDir, "borrowers-avalanche.json"),
    JSON.stringify({ count: 523, backfillDone: true, updatedAt: "2026-06-03T15:15:06.000Z" })
  );
  fs.writeFileSync(
    path.join(dataDir, "active-debt-avalanche.json"),
    JSON.stringify({ count: 500, updatedAt: "2026-06-03T15:15:06.000Z" })
  );
  fs.writeFileSync(
    path.join(dataDir, "watchlist-avalanche.json"),
    JSON.stringify({ count: 4, updatedAt: "2026-06-03T15:15:08.000Z" })
  );
  fs.writeFileSync(
    path.join(dataDir, "near-avalanche.json"),
    JSON.stringify({ count: 7, updatedAt: "2026-06-03T15:15:08.000Z" })
  );

  const dockerClient = {
    inspectContainer: async () => ({
      ok: true,
      container: {
        name: "aave-liquidator",
        status: "running",
        running: true,
        startedAt: "2026-06-03T14:00:00.000Z",
        restartCount: 1,
        env: {
          TEST_MODE: "false",
          CHAINS: "base,avalanche",
        },
      },
    }),
    getContainerLogs: async () => ({ ok: true, text: sampleLog }),
  };

  const service = createStatusService({
    dockerClient,
    dataReader: new DataStoreReader({ dataDir }),
    containerNames: ["aave-liquidator"],
    now: () => new Date("2026-06-03T15:16:00.000Z"),
  });

  const status = await service.getStatus();

  assert.equal(status.container.running, true);
  assert.equal(status.container.testMode, false);
  assert.deepEqual(status.container.chains, ["base", "avalanche"]);
  assert.equal(status.activity.liquidatableDetections, 2);
  assert.equal(status.chains.find((chain) => chain.key === "base").borrowerStoreCount, 210921);
  assert.equal(status.chains.find((chain) => chain.key === "avalanche").activeDebtCount, 500);
  assert.equal(status.chains.find((chain) => chain.key === "avalanche").nearCount, 7);
  assert.equal(status.insights.opportunityRadar.totals.liquidatable, 2);
  assert.equal(status.insights.pipeline.summary.total, 3);
  assert.equal(status.insights.missed.items.some((item) => item.outcome === "precheck_fail"), true);
  assert.equal(status.warnings.some((warning) => warning.code === "main_loop_errors"), true);
});

test("summarizes the per-chain container fleet by default", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquidator-monitor-"));
  for (const chain of ["plasma", "arbitrum", "base", "avalanche", "optimism"]) {
    fs.writeFileSync(
      path.join(dataDir, `borrowers-${chain}.json`),
      JSON.stringify({ count: 10, backfillDone: true, updatedAt: "2026-06-03T15:14:00.000Z" })
    );
  }

  const chainByContainer = {
    "bot-plasma": "plasma",
    "bot-arbitrum": "arbitrum",
    "bot-base": "base",
    "bot-avalanche": "avalanche",
    "bot-optimism": "optimism",
  };
  const dockerClient = {
    inspectContainer: async (name) => ({
      ok: true,
      container: {
        name,
        status: "running",
        running: true,
        startedAt: "2026-06-03T14:00:00.000Z",
        restartCount: name === "bot-base" ? 1 : 0,
        env: {
          TEST_MODE: "false",
          CHAINS: chainByContainer[name],
        },
      },
    }),
    getContainerLogs: async (name) => ({
      ok: true,
      text: `2026-06-03T15:15:00.000000000Z ${chainByContainer[name]}: Found 0 liquidatable positions (cycle 25ms).`,
    }),
  };

  const service = createStatusService({
    dockerClient,
    dataReader: new DataStoreReader({ dataDir }),
    now: () => new Date("2026-06-03T15:16:00.000Z"),
  });

  const status = await service.getStatus();

  assert.equal(status.container.name, "liquidator fleet");
  assert.equal(status.container.running, true);
  assert.equal(status.container.runningCount, 5);
  assert.equal(status.container.restartCount, 1);
  assert.equal(status.containers.length, 5);
  assert.deepEqual(status.container.chains, ["plasma", "arbitrum", "base", "avalanche", "optimism"]);
});
