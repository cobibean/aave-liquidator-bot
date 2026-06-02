require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getUnhealthyPositions, getUserHealthFactor } = require("./aaveHelpers");
const { getSelectedChainConfigs } = require("./src/chains");
const { getTransactionOverrides } = require("./src/gas");
const { createProvider } = require("./src/provider");

const requiredEnv = ["PRIVATE_KEY"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnv.join(", ")}`);
}

const testMode = process.env.TEST_MODE !== "false";
const chainConfigs = getSelectedChainConfigs();

// Load the Aave Liquidator contract ABI and instantiate the contract
const liquidatorArtifact = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "artifacts/contracts/AaveLiquidator.sol/AaveLiquidator.json"),
    "utf-8"
  )
);
const aaveLiquidatorABI = liquidatorArtifact.abi;

async function main() {
  console.log(`🚀 Starting Aave Liquidator Bot on ${chainConfigs.map((chain) => chain.name).join(", ")}...`);
  if (testMode) {
    console.log("TEST_MODE is enabled. Liquidations will be logged but not submitted.");
  }

  await Promise.all(chainConfigs.map(runChainBot));
}

async function runChainBot(chainConfig) {
  const provider = createProvider(chainConfig);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const liquidatorAddress = getLiquidatorAddress(chainConfig);
  const aaveLiquidatorContract = liquidatorAddress
    ? new ethers.Contract(liquidatorAddress, aaveLiquidatorABI, wallet)
    : null;

  console.log(`▶️ ${chainConfig.name}: wallet ${wallet.address}`);
  if (!aaveLiquidatorContract) {
    console.warn(`⚠️ ${chainConfig.name}: AAVE_LIQUIDATOR_ADDRESS is not set for this chain.`);
  }

  // Each cycle does an incremental Borrow scan + a parallel HF sweep, so it is
  // cheap enough to run frequently. The first cycle pays a one-time backfill.
  const cycleMs = parseInt(process.env.SCAN_INTERVAL_MS || "15000", 10);

  while (true) {
    const cycleStart = Date.now();
    try {
      const opportunities = await getUnhealthyPositions(provider, chainConfig);
      console.log(`📌 ${chainConfig.name}: Found ${opportunities.length} liquidatable positions (cycle ${Date.now() - cycleStart}ms).`);

      for (const position of opportunities) {
        await attemptLiquidation(position, {
          provider,
          chainConfig,
          aaveLiquidatorContract,
        });
      }
    } catch (error) {
      console.error(`❌ ${chainConfig.name}: Error in main loop:`, error.message);
    }

    // Keep a steady cadence regardless of how long the cycle took.
    const elapsed = Date.now() - cycleStart;
    await delay(Math.max(cycleMs - elapsed, 1000));
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function attemptLiquidation({
  user,
  debtAsset,
  debtAmount,
  debtDecimals = 6,
  debtSymbol = "debt asset",
  collateralAsset
}, {
  provider,
  chainConfig,
  aaveLiquidatorContract,
}) {
  console.log("⚡ Attempting liquidation with:", {
    chain: chainConfig.name,
    user,
    debtAsset,
    debtAmount: ethers.utils.formatUnits(debtAmount, debtDecimals),
    debtSymbol,
    collateralAsset
  });

  // Re-check user health factor (pass both user and provider)
  const latestHealthFactor = await getUserHealthFactor(user, provider, chainConfig);
  console.log(`${chainConfig.name}: Health factor for ${user}: ${latestHealthFactor}`);
  if (latestHealthFactor > 1.0) {
    console.log(`⏳ Skipping ${user} (HF: ${latestHealthFactor}).`);
    return;
  }

  // Define a threshold for full vs. partial liquidation.
  // For example, if HF is above 0.95, only 50% of the debt can be liquidated.
  const CLOSE_FACTOR_HF_THRESHOLD = 0.95;
  let debtToCover = debtAmount;
  
  if (latestHealthFactor > CLOSE_FACTOR_HF_THRESHOLD) {
    // Liquidate only 50% of the debt.
    debtToCover = debtAmount.div(2); // BigNumber division (rounding down)
    console.log(`Partial liquidation: Only covering 50% of the debt: ${ethers.utils.formatUnits(debtToCover, debtDecimals)} ${debtSymbol}`);
  } else {
    console.log(`Full liquidation: Covering full debt: ${ethers.utils.formatUnits(debtToCover, debtDecimals)} ${debtSymbol}`);
  }

  if (testMode) {
    console.log("TEST_MODE enabled: skipping transaction submission.", {
      chain: chainConfig.name,
      user,
      debtAsset,
      debtToCover: debtToCover.toString(),
      collateralAsset
    });
    return;
  }

  if (!aaveLiquidatorContract) {
    console.warn(`${chainConfig.name}: No liquidator contract configured; skipping transaction.`);
    return;
  }

  try {
    const overrides = await getTransactionOverrides(provider, chainConfig, {
      gasLimit: chainConfig.liquidationGasLimit,
    });

    const tx = await aaveLiquidatorContract.triggerLiquidation(
      debtAsset,
      debtToCover,
      user,
      collateralAsset,
      overrides
    );

    console.log(`✅ TX sent: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      console.log(`🎉 Successful liquidation: ${tx.hash}`);
    } else {
      console.warn(`⚠️ Liquidation TX failed on-chain: ${tx.hash}`);
    }
  } catch (error) {
    if (error.code === "TRANSACTION_REPLACED") {
      console.warn(`⚠️ Transaction was replaced: ${error.replacement.hash}`);
    } else {
      console.error(`❌ Liquidation failed:`, error.message);
    }
  }
}

function getLiquidatorAddress(chainConfig) {
  return (
    process.env[`${chainConfig.key.toUpperCase()}_AAVE_LIQUIDATOR_ADDRESS`] ||
    (!process.env.CHAINS && process.env.AAVE_LIQUIDATOR_ADDRESS) ||
    ""
  );
}


main().catch(console.error);
