require("dotenv").config();

const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { createProvider } = require("../src/provider");
const {
  getBorrowersFromBorrowEvents,
  getPrimaryDebtPosition,
  getPrimaryCollateral,
  getUserHealthFactor,
} = require("../aaveHelpers");

const POOL_ABI = [
  "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)",
];

const MAX_BORROWERS_TO_SCAN = Number.parseInt(process.env.PREFLIGHT_MAX_BORROWERS || "40", 10);

async function main() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY is required");
  }

  const chains = getSelectedChainConfigs(process.env.PREFLIGHT_CHAINS || process.env.CHAINS);
  const results = [];

  for (const chainConfig of chains) {
    results.push(await preflightChain(chainConfig));
  }

  console.log("Liquidation preflight summary", JSON.stringify(results, null, 2));

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new Error(`Preflight failed on: ${failed.map((result) => result.chain).join(", ")}`);
  }
}

async function preflightChain(chainConfig) {
  const provider = createProvider(chainConfig);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const liquidatorAddress = getLiquidatorAddress(chainConfig);
  const artifact = loadLiquidatorArtifact(chainConfig);
  const result = {
    chain: chainConfig.key,
    name: chainConfig.name,
    artifact: artifact.contractName,
    ok: false,
    liquidatorAddress,
  };

  try {
    if (!liquidatorAddress) {
      throw new Error("liquidator address is not configured");
    }

    const code = await provider.getCode(liquidatorAddress);
    if (code === "0x") {
      throw new Error("liquidator address has no deployed code");
    }

    const contract = new ethers.Contract(liquidatorAddress, artifact.abi, wallet);
    const [owner, aavePool, router] = await Promise.all([
      contract.owner(),
      contract.aavePool(),
      contract.netSwapRouter(),
    ]);
    result.owner = owner;
    result.pool = aavePool;
    result.router = router;

    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(`owner mismatch: ${owner}`);
    }
    if (aavePool.toLowerCase() !== chainConfig.pool.toLowerCase()) {
      throw new Error(`pool mismatch: ${aavePool}`);
    }
    if (router.toLowerCase() !== chainConfig.swapRouter.toLowerCase()) {
      throw new Error(`router mismatch: ${router}`);
    }

    const candidate = await findPreflightCandidate(provider, chainConfig);
    result.candidate = serializeCandidate(candidate);

    const pool = new ethers.Contract(chainConfig.pool, POOL_ABI, wallet);
    const directPoolError = await expectStaticRevert(() =>
      pool.callStatic.liquidationCall(
        candidate.collateralAsset,
        candidate.debtAsset,
        candidate.user,
        candidate.debtToCover,
        false
      )
    );
    const liquidatorError = await expectStaticRevert(() =>
      contract.callStatic.triggerLiquidation(
        candidate.debtAsset,
        candidate.debtToCover,
        candidate.user,
        candidate.collateralAsset
      )
    );

    result.directPoolStaticRevert = directPoolError;
    result.liquidatorStaticRevert = liquidatorError;

    result.ok = Boolean(directPoolError) && Boolean(liquidatorError);
    if (!result.ok) {
      throw new Error("expected both direct pool and liquidator static calls to revert on healthy borrower");
    }
  } catch (error) {
    result.error = error.reason || error.message;
  }

  console.log(`${chainConfig.name} liquidation preflight`, JSON.stringify(result, null, 2));
  return result;
}

async function findPreflightCandidate(provider, chainConfig) {
  const borrowers = await getBorrowersFromBorrowEvents(provider, chainConfig);
  const candidates = borrowers.slice(0, MAX_BORROWERS_TO_SCAN);

  for (const user of candidates) {
    const healthFactor = await getUserHealthFactor(user, provider, chainConfig);
    if (healthFactor <= 1) {
      continue;
    }

    const debtPosition = await getPrimaryDebtPosition(user, provider, chainConfig);
    if (debtPosition.debtAmount.lte(ethers.constants.Zero)) {
      continue;
    }

    const collateralAsset = await getPrimaryCollateral(user, provider, chainConfig);
    if (!collateralAsset) {
      continue;
    }

    const oneUnit = ethers.utils.parseUnits("1", debtPosition.debtDecimals);
    const debtToCover = debtPosition.debtAmount.lt(oneUnit) ? debtPosition.debtAmount : oneUnit;

    return {
      user,
      healthFactor,
      debtAsset: debtPosition.debtAsset,
      debtAmount: debtPosition.debtAmount,
      debtToCover,
      debtSymbol: debtPosition.debtSymbol,
      debtDecimals: debtPosition.debtDecimals,
      collateralAsset,
    };
  }

  throw new Error(`no healthy borrower with ${chainConfig.debtSymbol} debt found in recent events`);
}

async function expectStaticRevert(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return compactError(error);
  }
}

function compactError(error) {
  const message = error.reason || error.error?.message || error.message || String(error);
  return message.replace(/\n/g, " ").slice(0, 300);
}

function serializeCandidate(candidate) {
  return {
    user: candidate.user,
    healthFactor: candidate.healthFactor,
    debtAsset: candidate.debtAsset,
    debtToCover: ethers.utils.formatUnits(candidate.debtToCover, candidate.debtDecimals),
    debtSymbol: candidate.debtSymbol,
    collateralAsset: candidate.collateralAsset,
  };
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
  console.error("Liquidation preflight failed:", error.message);
  process.exitCode = 1;
});
