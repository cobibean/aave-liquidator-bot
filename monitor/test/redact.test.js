const assert = require("node:assert/strict");
const test = require("node:test");
const { redact, redactObject } = require("../src/redact");

test("redacts obvious secrets and long secret-looking strings", () => {
  const privateKey = `0x${"a".repeat(64)}`;
  const apiToken = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN123456";
  const input = [
    `PRIVATE_KEY=${privateKey}`,
    `Authorization: Bearer ${apiToken}`,
    `https://rpc.example.test/path?api_key=${apiToken}`,
    `https://user:${apiToken}@rpc.example.test`,
  ].join("\n");

  const output = redact(input);

  assert.equal(output.includes(privateKey), false);
  assert.equal(output.includes(apiToken), false);
  assert.match(output, /\[REDACTED/);
});

test("redacts nested string values", () => {
  const value = redactObject({
    safe: "ok",
    nested: {
      auth: "Authorization: Basic abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
    },
  });

  assert.equal(value.safe, "ok");
  assert.equal(value.nested.auth.includes("abcdefghijklmnopqrstuvwxyz"), false);
});
