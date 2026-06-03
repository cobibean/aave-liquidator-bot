const { ethers } = require("ethers");

// Builds the tx overrides for a liquidation. Prefers EIP-1559
// (maxFeePerGas / maxPriorityFeePerGas) so we can outbid competitors on
// INCLUSION PRIORITY when our tx and theirs target the same position in the same
// block — a flat legacy gasPrice can't win that auction. Falls back to legacy
// gasPrice on chains/RPCs that don't expose a 1559 fee market.
//
// Priority fee = max(networkTip × PRIORITY_FEE_MULTIPLE, MIN_PRIORITY_FEE_GWEI).
// maxFeePerGas = baseFee × BASE_FEE_MULTIPLE + priorityFee, so we stay includable
// even if the base fee climbs over the next few blocks. Overpaying gas to win is
// correct on a profitable liquidation (the bonus dwarfs gas), and we never
// knowingly lose money: the contract's minProfit floor already budgets
// PROFIT_SAFETY_MULTIPLE × gas and the callStatic gate reverts unprofitable txs.
//
// options.feeData  — pre-fetched provider.getFeeData() (avoids a round-trip on
//                    the hot path; 2.1 fetches it once and threads it through).
// options.gasPrice — legacy fallback gas price (BigNumber) if feeData is absent.
// options.legacy   — force legacy gasPrice mode (e.g. a chain that misreports 1559).
async function getTransactionOverrides(provider, chainConfig, options = {}) {
  const gasLimit = options.gasLimit || chainConfig.liquidationGasLimit;
  const bumpGwei = chainConfig.gasPriceBumpGwei || "0";
  const bump = ethers.utils.parseUnits(bumpGwei, "gwei");

  const forceLegacy = options.legacy === true || chainConfig.forceLegacyGas === true;
  const feeData = options.feeData || (forceLegacy ? null : await safeFeeData(provider));

  // EIP-1559 path: requires a base fee (lastBaseFeePerGas) AND a 1559-style
  // maxFeePerGas from the node. If either is missing, fall back to legacy.
  const baseFee = feeData && feeData.lastBaseFeePerGas;
  const supports1559 = !forceLegacy && feeData && feeData.maxFeePerGas && baseFee;

  if (supports1559) {
    const priorityMultX100 = Math.round(parseFloat(process.env.PRIORITY_FEE_MULTIPLE || "1.5") * 100);
    const baseMultX100 = Math.round(parseFloat(process.env.BASE_FEE_MULTIPLE || "2") * 100);
    const minTip = ethers.utils.parseUnits(process.env.MIN_PRIORITY_FEE_GWEI || "0", "gwei");

    // Network's suggested tip (fall back to a small slice of base fee if the
    // node returns no priority component), scaled up, floored, plus any
    // per-chain bump.
    const networkTip = feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(0)
      ? feeData.maxPriorityFeePerGas
      : baseFee.div(10);
    let priorityFee = networkTip.mul(priorityMultX100).div(100).add(bump);
    if (priorityFee.lt(minTip)) priorityFee = minTip;

    const maxFeePerGas = baseFee.mul(baseMultX100).div(100).add(priorityFee);

    return {
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
    };
  }

  // Legacy fallback.
  const gasPrice = options.gasPrice || (feeData && feeData.gasPrice) || (await provider.getGasPrice());
  return {
    gasLimit,
    gasPrice: gasPrice.add(bump),
  };
}

// getFeeData can throw on flaky RPCs; never let that sink the submit path.
async function safeFeeData(provider) {
  try {
    return await provider.getFeeData();
  } catch (_) {
    return null;
  }
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
