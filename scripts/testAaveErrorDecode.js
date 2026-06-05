const { decodeAaveError, compactRevertReason } = require("../src/aaveErrorDecoder");

const cases = [
  [{ data: "0x930bb771" }, "HealthFactorNotBelowThreshold"],
  [{ error: { data: "0x930bb771000000" } }, "HealthFactorNotBelowThreshold"],
  [{ data: "0xb629b0e4" }, "MustNotLeaveDust"],
  [{ data: "0x2c5211c6" }, "InvalidAmount"],
  [{
    data: "0x08c379a00000000000000000000000000000000000000000000000000000000000000020" +
      "000000000000000000000000000000000000000000000000000000000000001470726f66697420666c6f6f72206e6f74206d6574000000000000000000000000",
  }, "profit floor not met"],
  [{ message: "execution reverted: Too_little_received" }, "Too_little_received"],
  [{ data: "0xdeadbeef" }, "UnknownRevertSelector(0xdeadbeef)"],
];

const fails = [];
for (const [input, expected] of cases) {
  const actual = decodeAaveError(input);
  if (actual !== expected) fails.push(`decode ${JSON.stringify(input)} expected ${expected}, got ${actual}`);
}

const compact = compactRevertReason({ data: "0x930bb771", message: "call revert exception" });
if (compact !== "HealthFactorNotBelowThreshold") {
  fails.push(`compact reason expected HealthFactorNotBelowThreshold, got ${compact}`);
}

console.log(fails.length === 0 ? "✅ Aave error decoder OK" : "❌ FAILURES:\n  - " + fails.join("\n  - "));
process.exit(fails.length === 0 ? 0 : 1);
