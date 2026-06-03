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
    now: () => new Date("2026-06-03T15:16:00.000Z"),
  });

  const status = await service.getStatus();

  assert.equal(status.container.running, true);
  assert.equal(status.container.testMode, false);
  assert.deepEqual(status.container.chains, ["base", "avalanche"]);
  assert.equal(status.activity.liquidatableDetections, 2);
  assert.equal(status.chains.find((chain) => chain.key === "base").borrowerStoreCount, 210921);
  assert.equal(status.chains.find((chain) => chain.key === "avalanche").activeDebtCount, 500);
  assert.equal(status.warnings.some((warning) => warning.code === "main_loop_errors"), true);
});
