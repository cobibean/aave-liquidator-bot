const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp } = require("../src/server");
const { DataStoreReader } = require("../src/dataStore");

// Docker is irrelevant to the winscan endpoints; stub it so the app boots.
const stubDocker = {
  inspectContainer: async () => ({ ok: false, error: "no docker" }),
  getContainerLogs: async () => ({ ok: false, error: "no docker" }),
};

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "winscan-test-"));
}

async function withServer(dataDir, fn) {
  const app = createApp({
    dockerClient: stubDocker,
    dataReader: new DataStoreReader({ dataDir }),
    containerNames: ["bot-base"],
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /api/winscan reports unavailable when no scan file exists", async () => {
  const dir = tmpDataDir();
  try {
    await withServer(dir, async (base) => {
      const res = await fetch(`${base}/api/winscan`);
      const body = await res.json();
      assert.equal(body.available, false);
      assert.equal(body.error, "missing");
      assert.deepEqual(body.history, []);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/winscan returns the latest scan and history when present", async () => {
  const dir = tmpDataDir();
  try {
    fs.writeFileSync(
      path.join(dir, "winscan-latest.json"),
      JSON.stringify({
        scannedAt: "2026-06-05T00:00:00.000Z",
        hours: 1,
        intervalMin: 30,
        chains: [{ key: "base", name: "Base", total: 7, ours: 2 }],
        grandTotal: 7,
        ourTotal: 2,
      })
    );
    fs.writeFileSync(
      path.join(dir, "winscan-history.json"),
      JSON.stringify({ entries: [{ scannedAt: "2026-06-05T00:00:00.000Z", grandTotal: 7, ourTotal: 2, perChain: [] }] })
    );
    await withServer(dir, async (base) => {
      const res = await fetch(`${base}/api/winscan`);
      const body = await res.json();
      assert.equal(body.available, true);
      assert.equal(body.latest.grandTotal, 7);
      assert.equal(body.latest.ourTotal, 2);
      assert.equal(body.history.length, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/winscan/run writes a request marker for the runner", async () => {
  const dir = tmpDataDir();
  try {
    await withServer(dir, async (base) => {
      const res = await fetch(`${base}/api/winscan/run`, { method: "POST" });
      assert.equal(res.status, 202);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.ok(body.requestedAt);
      assert.ok(fs.existsSync(path.join(dir, "winscan-request.json")), "request marker should exist");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/winscan/run returns 503 when the data dir is unwritable/missing", async () => {
  const dir = path.join(os.tmpdir(), `winscan-missing-${Date.now()}`);
  // Intentionally do NOT create dir.
  await withServer(dir, async (base) => {
    const res = await fetch(`${base}/api/winscan/run`, { method: "POST" });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.error);
  });
});
