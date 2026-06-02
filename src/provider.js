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

function getRpcUrls(chainConfig) {
  const urls = chainConfig.rpcUrls || [chainConfig.rpcUrl];
  return [...new Set(urls.map((url) => String(url).trim()).filter(Boolean))];
}

module.exports = {
  createProvider,
  getRpcUrls,
};
