function loadChainConfigs() {
  for (const path of ["../bot-src/chains", "../../src/chains"]) {
    try {
      return require(path).CHAIN_CONFIGS || {};
    } catch (_) {
      // Try the next known layout.
    }
  }
  return {};
}

const CHAIN_CONFIGS = loadChainConfigs();

function getSafeChainMetadata(chainKey) {
  const config = CHAIN_CONFIGS[chainKey] || {};
  return {
    key: chainKey,
    chainId: config.chainId || null,
    nativeToken: config.nativeToken || null,
    debtSymbol: config.debtSymbol || null,
    liquidationGasLimit: config.liquidationGasLimit || null,
    borrowScanBlocks: config.borrowScanBlocks || null,
    borrowBackfillBlocks: config.borrowBackfillBlocks || null,
    deploymentBlock: config.deploymentBlock || null,
    hasPool: Boolean(config.pool),
    hasOracle: Boolean(config.priceOracle),
    hasRouter: Boolean(config.swapRouter),
    hardenedLiquidator: Boolean(config.hardenedLiquidator),
    pathAware: Boolean(config.pathAware),
    gasPriceBumpGwei: config.gasPriceBumpGwei || "0",
  };
}

module.exports = {
  getSafeChainMetadata,
};
