const { ethers } = require("ethers");

// Per-chain numeric env resolver: <CHAIN>_<NAME> → <NAME> → fallback.
// Mirrors resolveChainMinDebtUsd so gas knobs can be tuned per chain.
function resolveChainNum(chainConfig, name, fallback) {
  const key = (chainConfig.key || "").toUpperCase();
  const candidates = [key ? process.env[`${key}_${name}`] : undefined, process.env[name]];
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === "") continue;
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return fallback;
}

// Builds the tx overrides for a liquidation. Prefers EIP-1559
// (maxFeePerGas / maxPriorityFeePerGas) so we can outbid competitors on
// INCLUSION PRIORITY when our tx and theirs target the same position in the same
// block — a flat legacy gasPrice can't win that auction. Falls back to legacy
// gasPrice on chains/RPCs that don't expose a 1559 fee market.
//
// PRIORITY FEE is driven by the BASE FEE (the real congestion signal on these
// L2s), NOT the node's suggested tip — every node here returns a flat ~1.5 gwei
// "suggestion" regardless of load, so tip×mult overpaid ~2.25 gwei on a ~0.01–0.28
// gwei base fee. Instead:
//   priorityFee = clamp(baseFee × PRIORITY_FEE_MULTIPLE,
//                       floor MIN_PRIORITY_FEE_GWEI, cap MAX_PRIORITY_FEE_GWEI) + bump
// so the tip scales with congestion, collapses to a small floor when the chain is
// quiet (still out-tipping lazy bots), and can't exceed the cap on a base-fee
// spike. maxFeePerGas = baseFee × BASE_FEE_MULTIPLE + priorityFee (headroom for
// base climbing over the next blocks). Overpaying to win is fine on a profitable
// liquidation — the minProfit floor budgets PROFIT_SAFETY_MULTIPLE × gas and the
// callStatic gate reverts unprofitable txs — but we no longer overpay needlessly.
// All four knobs are per-chain overridable (<CHAIN>_PRIORITY_FEE_MULTIPLE, etc.).
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
    const priorityMult = resolveChainNum(chainConfig, "PRIORITY_FEE_MULTIPLE", 3); // × base fee
    const baseMultX100 = Math.round(resolveChainNum(chainConfig, "BASE_FEE_MULTIPLE", 2) * 100);
    const floorTip = gweiToWei(resolveChainNum(chainConfig, "MIN_PRIORITY_FEE_GWEI", 0.05));
    const capTip = gweiToWei(resolveChainNum(chainConfig, "MAX_PRIORITY_FEE_GWEI", 2.25));

    // Base-fee-driven tip, clamped to [floor, cap], plus any per-chain bump.
    let priorityFee = baseFee.mul(Math.round(priorityMult * 100)).div(100);
    if (priorityFee.lt(floorTip)) priorityFee = floorTip;
    if (capTip.gt(0) && priorityFee.gt(capTip)) priorityFee = capTip;
    priorityFee = priorityFee.add(bump);

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

// Parse a gwei float (e.g. 0.05) to a wei BigNumber, tolerating sub-gwei values.
function gweiToWei(gwei) {
  // parseUnits needs a string; clamp to 9 decimals (1 gwei = 1e9 wei).
  const fixed = Number(gwei).toFixed(9);
  return ethers.utils.parseUnits(fixed, "gwei");
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
