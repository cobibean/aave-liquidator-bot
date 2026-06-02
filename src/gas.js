const { ethers } = require("ethers");

async function getTransactionOverrides(provider, chainConfig, options = {}) {
  const gasLimit = options.gasLimit || chainConfig.liquidationGasLimit;
  const gasPrice = await provider.getGasPrice();
  const bump = ethers.utils.parseUnits(chainConfig.gasPriceBumpGwei || "0", "gwei");

  return {
    gasLimit,
    gasPrice: gasPrice.add(bump),
  };
}

async function getGasSnapshot(provider, chainConfig) {
  const [network, blockNumber, gasPrice, feeData] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    provider.getGasPrice(),
    provider.getFeeData(),
  ]);

  const liquidationGasLimit = ethers.BigNumber.from(chainConfig.liquidationGasLimit);
  const deployGasLimit = ethers.BigNumber.from(1_600_000);

  return {
    chainId: network.chainId,
    blockNumber,
    nativeToken: chainConfig.nativeToken,
    gasPrice,
    gasPriceGwei: ethers.utils.formatUnits(gasPrice, "gwei"),
    feeData: {
      gasPrice: feeData.gasPrice ? ethers.utils.formatUnits(feeData.gasPrice, "gwei") : null,
      maxFeePerGas: feeData.maxFeePerGas ? ethers.utils.formatUnits(feeData.maxFeePerGas, "gwei") : null,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
        ? ethers.utils.formatUnits(feeData.maxPriorityFeePerGas, "gwei")
        : null,
    },
    estimates: {
      deployGasLimit: deployGasLimit.toString(),
      deployCostNative: ethers.utils.formatEther(deployGasLimit.mul(gasPrice)),
      liquidationGasLimit: liquidationGasLimit.toString(),
      liquidationCostNative: ethers.utils.formatEther(liquidationGasLimit.mul(gasPrice)),
    },
  };
}

module.exports = {
  getGasSnapshot,
  getTransactionOverrides,
};
