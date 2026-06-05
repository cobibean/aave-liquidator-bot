const { ethers } = require("ethers");

const SELECTOR_NAMES = {
  "0x930bb771": "HealthFactorNotBelowThreshold",
  "0x979b5ce8": "CollateralCannotBeLiquidated",
  "0x4323a555": "NotEnoughLiquidity",
  "0x91037009": "PriceOracleSentinelCheckFailed",
  "0xf0788fb2": "NoDebtOfSelectedType",
  "0x3653732b": "SpecifiedCurrencyNotBorrowedByUser",
  "0x34477cc0": "NotEnoughCollateral",
  "0xb629b0e4": "MustNotLeaveDust",
  "0x2c5211c6": "InvalidAmount",
};

const ERROR_STRING_SELECTOR = "0x08c379a0";

function findHexSelector(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const direct = value.match(/^0x[0-9a-fA-F]{8}/);
    if (direct) return direct[0].toLowerCase();
    const embedded = value.match(/0x[0-9a-fA-F]{8}/);
    return embedded ? embedded[0].toLowerCase() : null;
  }
  if (typeof value === "object") {
    return (
      findHexSelector(value.data) ||
      findHexSelector(value.error && value.error.data) ||
      findHexSelector(value.error && value.error.message) ||
      findHexSelector(value.body) ||
      findHexSelector(value.message)
    );
  }
  return null;
}

function normalizeKnownText(text) {
  if (!text) return null;
  if (String(text).includes("Too_little_received")) return "Too_little_received";
  return null;
}

function decodeAaveError(error) {
  const knownText =
    normalizeKnownText(error && error.reason) ||
    normalizeKnownText(error && error.errorName) ||
    normalizeKnownText(error && error.message) ||
    normalizeKnownText(error && error.error && error.error.message);
  if (knownText) return knownText;

  const selector = findHexSelector(error);
  if (!selector) return null;
  if (selector === ERROR_STRING_SELECTOR) {
    const data =
      findHexData(error && error.data) ||
      findHexData(error && error.error && error.error.data) ||
      findHexData(error && error.body) ||
      findHexData(error && error.message);
    const decoded = decodeErrorString(data);
    return decoded || "Error(string)";
  }
  return SELECTOR_NAMES[selector] || `UnknownRevertSelector(${selector})`;
}

function findHexData(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const direct = value.match(/^0x[0-9a-fA-F]+/);
    if (direct) return direct[0];
    const embedded = value.match(/0x[0-9a-fA-F]{8,}/);
    return embedded ? embedded[0] : null;
  }
  if (typeof value === "object") {
    return (
      findHexData(value.data) ||
      findHexData(value.error && value.error.data) ||
      findHexData(value.body) ||
      findHexData(value.message)
    );
  }
  return null;
}

function decodeErrorString(data) {
  if (!data || typeof data !== "string" || !data.toLowerCase().startsWith(ERROR_STRING_SELECTOR)) return null;
  try {
    const encoded = `0x${data.slice(10)}`;
    const [reason] = ethers.utils.defaultAbiCoder.decode(["string"], encoded);
    return reason || null;
  } catch (_) {
    return null;
  }
}

function compactRevertReason(error) {
  return (
    decodeAaveError(error) ||
    error?.reason ||
    error?.errorName ||
    error?.error?.message ||
    error?.message ||
    "revert"
  );
}

module.exports = {
  decodeAaveError,
  compactRevertReason,
};
