require("dotenv").config();

const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { getTransactionOverrides } = require("../src/gas");
const { createProvider } = require("../src/provider");

const deployEnabled = process.env.DEPLOY === "true";
const forceDeploy = process.env.FORCE_DEPLOY === "true";
const allowZeroRouter = process.env.ALLOW_ZERO_ROUTER === "true";
const privateKey = process.env.PRIVATE_KEY || "";

async function main() {
  if (!privateKey) {
    throw new Error("PRIVATE_KEY is required");
  }

  const chains = getSelectedChainConfigs(process.env.DEPLOY_CHAINS || process.env.CHAINS);
  const results = [];

  for (const chainConfig of chains) {
    results.push(await handleChain(chainConfig));
  }

  console.log("Deploy summary", JSON.stringify(results, null, 2));

  const readyLines = results
    .filter((result) => result.deployedAddress)
    .map((result) => `${result.chain.toUpperCase()}_AAVE_LIQUIDATOR_ADDRESS=${result.deployedAddress}`);

  if (readyLines.length > 0) {
    console.log("Env lines:");
    for (const line of readyLines) {
      console.log(line);
    }
  }
}

async function handleChain(chainConfig) {
  const provider = createProvider(chainConfig);
  const wallet = new ethers.Wallet(privateKey, provider);
  const liquidatorArtifact = loadLiquidatorArtifact(chainConfig);
  const factory = new ethers.ContractFactory(liquidatorArtifact.abi, liquidatorArtifact.bytecode, wallet);
  const existingAddress = getLiquidatorAddress(chainConfig);
  const result = {
    chain: chainConfig.key,
    name: chainConfig.name,
    artifact: liquidatorArtifact.contractName,
    nativeToken: chainConfig.nativeToken,
    wallet: wallet.address,
    pool: chainConfig.pool,
    router: chainConfig.swapRouter || ethers.constants.AddressZero,
    swapIntermediates: chainConfig.swapIntermediates || [],
    deployEnabled,
    ok: false,
  };

  try {
    const [balance, gasPrice] = await Promise.all([
      provider.getBalance(wallet.address),
      provider.getGasPrice(),
    ]);
    result.balance = `${ethers.utils.formatEther(balance)} ${chainConfig.nativeToken}`;
    result.gasPriceGwei = ethers.utils.formatUnits(gasPrice, "gwei");

    if (!chainConfig.swapRouter && !allowZeroRouter) {
      result.skipReason = "swapRouter is not configured";
      return result;
    }

    if (existingAddress && !forceDeploy) {
      const code = await provider.getCode(existingAddress);
      result.existingAddress = existingAddress;
      result.existingDeployed = code !== "0x";
      result.ok = result.existingDeployed;
      result.skipReason = result.existingDeployed
        ? "existing liquidator address is already deployed"
        : "existing liquidator address has no code; set FORCE_DEPLOY=true to replace";
      return result;
    }

    const deployTx = factory.getDeployTransaction(chainConfig.pool, result.router);
    const gasEstimate = await wallet.estimateGas(deployTx);
    const gasLimit = gasEstimate.mul(12).div(10);
    const deployCost = gasLimit.mul(gasPrice);
    result.deployGasEstimate = gasEstimate.toString();
    result.deployGasLimit = gasLimit.toString();
    result.deployCost = `${ethers.utils.formatEther(deployCost)} ${chainConfig.nativeToken}`;
    result.hasEnoughForDeploy = balance.gte(deployCost);

    if (!deployEnabled) {
      result.ok = true;
      result.skipReason = "dry run; set DEPLOY=true to send deployment transactions";
      return result;
    }

    if (!result.hasEnoughForDeploy) {
      result.skipReason = "insufficient gas balance";
      return result;
    }

    // Deploys are NOT competitive same-block txs, so use legacy (base) gas rather
    // than the liquidation EIP-1559 priority bid. The priority bid (PRIORITY_FEE_
    // MULTIPLE × networkTip) inflates maxFeePerGas to ~2+ gwei, and the node's
    // intrinsic-cost guard (gasLimit × maxFeePerGas) can then exceed a thin gas
    // balance even though the actual deploy costs a fraction of that. Legacy mode
    // pays the real base price (e.g. ~0.006 gwei on Base). Set DEPLOY_USE_1559=true
    // to opt back into the priority path.
    const useLegacyGas = process.env.DEPLOY_USE_1559 !== "true";
    const overrides = await getTransactionOverrides(provider, chainConfig, { gasLimit, legacy: useLegacyGas });
    const contract = await factory.deploy(chainConfig.pool, result.router, overrides);
    result.deployTxHash = contract.deployTransaction.hash;
    result.deployedAddress = contract.address;

    const receipt = await contract.deployTransaction.wait();
    result.receiptStatus = receipt.status;
    result.blockNumber = receipt.blockNumber;
    result.gasUsed = receipt.gasUsed.toString();
    const paidGasPrice =
      receipt.effectiveGasPrice || contract.deployTransaction.gasPrice || contract.deployTransaction.maxFeePerGas;
    result.actualDeployCost = paidGasPrice
      ? `${ethers.utils.formatEther(receipt.gasUsed.mul(paidGasPrice))} ${chainConfig.nativeToken}`
      : null;

    if (chainConfig.swapIntermediates?.length && contract.interface.functions["setIntermediateTokens(address[])"]) {
      const setIntermediatesOverrides = await getTransactionOverrides(provider, chainConfig, {
        gasLimit: 200_000,
        legacy: useLegacyGas,
      });
      const setIntermediatesTx = await contract.setIntermediateTokens(
        chainConfig.swapIntermediates,
        setIntermediatesOverrides
      );
      result.setIntermediatesTxHash = setIntermediatesTx.hash;
      const setIntermediatesReceipt = await setIntermediatesTx.wait();
      result.setIntermediatesStatus = setIntermediatesReceipt.status;
    }

    const deployed = new ethers.Contract(contract.address, liquidatorArtifact.abi, provider);
    const [aavePool, netSwapRouter, owner] = await Promise.all([
      deployed.aavePool(),
      deployed.netSwapRouter(),
      deployed.owner(),
    ]);

    result.verified = {
      aavePool,
      netSwapRouter,
      owner,
      poolMatches: aavePool.toLowerCase() === chainConfig.pool.toLowerCase(),
      routerMatches: netSwapRouter.toLowerCase() === result.router.toLowerCase(),
      ownerMatches: owner.toLowerCase() === wallet.address.toLowerCase(),
    };
    if (deployed.interface.functions["getIntermediateTokens()"]) {
      result.verified.intermediateTokens = await deployed.getIntermediateTokens();
    }
    result.ok = result.receiptStatus === 1 && Object.values(result.verified).slice(3).every(Boolean);
  } catch (error) {
    result.error = error.reason || error.message;
  }

  return result;
}

function loadLiquidatorArtifact(chainConfig) {
  if (chainConfig.liquidatorArtifact === "AaveLiquidatorSwapRouter02") {
    return require("../artifacts/contracts/AaveLiquidatorSwapRouter02.sol/AaveLiquidatorSwapRouter02.json");
  }

  return require("../artifacts/contracts/AaveLiquidator.sol/AaveLiquidator.json");
}

function getLiquidatorAddress(chainConfig) {
  return (
    process.env[`${chainConfig.key.toUpperCase()}_AAVE_LIQUIDATOR_ADDRESS`] ||
    (!process.env.CHAINS && process.env.AAVE_LIQUIDATOR_ADDRESS) ||
    ""
  );
}

main().catch((error) => {
  console.error("Deploy failed:", error.message);
  process.exitCode = 1;
});
