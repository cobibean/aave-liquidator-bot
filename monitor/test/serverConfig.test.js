const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveListenConfig } = require("../src/server");

test("listen config defaults to direct tailnet-friendly host and port", () => {
  assert.deepEqual(resolveListenConfig({}), {
    host: "0.0.0.0",
    port: 3000,
  });
});

test("HOST and PORT override legacy monitor listen env vars", () => {
  assert.deepEqual(
    resolveListenConfig({
      HOST: "100.69.114.114",
      PORT: "3001",
      MONITOR_HOST: "127.0.0.1",
      MONITOR_PORT: "8787",
    }),
    {
      host: "100.69.114.114",
      port: 3001,
    }
  );
});

test("legacy monitor listen env vars remain supported", () => {
  assert.deepEqual(
    resolveListenConfig({
      MONITOR_HOST: "127.0.0.1",
      MONITOR_PORT: "8787",
    }),
    {
      host: "127.0.0.1",
      port: 8787,
    }
  );
});
