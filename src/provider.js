const { ethers } = require("ethers");

function createProvider(chainConfig) {
  const urls = getRpcUrls(chainConfig);

  if (urls.length === 1) {
    return new ethers.providers.StaticJsonRpcProvider(urls[0], chainConfig.chainId);
  }

  const providers = urls.map((url, index) => ({
    provider: new ethers.providers.StaticJsonRpcProvider(url, chainConfig.chainId),
    priority: index + 1,
    stallTimeout: 2500,
    weight: 1,
  }));

  return new ethers.providers.FallbackProvider(providers, 1);
}

// Returns a WebSocket provider for push-based `block` events if a WS endpoint is
// configured (<CHAIN>_WS_URL, or WS_URL when running a single chain), else null.
//
// We deliberately keep this SEPARATE from the HTTP read provider: batch reads
// (Multicall sweeps, enrichment, callStatic, sends) stay on HTTP where the
// FallbackProvider + retries behave well, while only the per-block trigger uses
// the WS socket for low-latency push notifications. A null return means "no WS
// configured" — the caller falls back to the HTTP provider's polling-based
// `block` events. WS endpoints are the recommended infra for the per-block
// trigger (BLOCK_TRIGGER); public HTTP polling will throttle under per-block load.
function createBlockProvider(chainConfig) {
  const wsUrl = getWsUrl(chainConfig);
  if (!wsUrl) {
    return null;
  }
  return new ethers.providers.WebSocketProvider(wsUrl, chainConfig.chainId);
}

function getWsUrl(chainConfig = {}) {
  const upperKey = String(chainConfig.key || "").toUpperCase();
  const explicitGlobalChain = process.env.CHAIN
    ? String(process.env.CHAIN).toLowerCase().replace(/[\s_-]+/g, "")
    : null;
  const globalOverridesEnabled = !process.env.CHAINS && explicitGlobalChain === chainConfig.key;

  const url =
    (upperKey && process.env[`${upperKey}_WS_URL`]) ||
    (globalOverridesEnabled && process.env.WS_URL) ||
    chainConfig.wsUrl ||
    "";

  const trimmed = String(url).trim();
  return trimmed || null;
}

function getRpcUrls(chainConfig) {
  const urls = chainConfig.rpcUrls || [chainConfig.rpcUrl];
  return [...new Set(urls.map((url) => String(url).trim()).filter(Boolean))];
}

module.exports = {
  createProvider,
  createBlockProvider,
  getRpcUrls,
  getWsUrl,
};
