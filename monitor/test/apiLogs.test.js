const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { createApp } = require("../src/server");

test("raw logs endpoint returns redacted logs only when requested", async () => {
  const privateKey = `0x${"b".repeat(64)}`;
  const token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN123456";
  const dockerClient = {
    getContainerLogs: async () => ({
      ok: true,
      text: [
        `2026-06-03T15:00:00.000000000Z PRIVATE_KEY=${privateKey}`,
        `2026-06-03T15:00:01.000000000Z Authorization: Bearer ${token}`,
        "2026-06-03T15:00:02.000000000Z Base: Found 0 liquidatable positions (cycle 25ms).",
      ].join("\n"),
    }),
  };

  const app = createApp({ dockerClient });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/logs?since=1h&limit=10`);
    const payload = await response.json();
    const body = JSON.stringify(payload);

    assert.equal(payload.lineCount, 3);
    assert.equal(body.includes(privateKey), false);
    assert.equal(body.includes(token), false);
    assert.equal(body.includes("[REDACTED"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
