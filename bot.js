require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getUnhealthyPositions, getUserHealthFactor } = require("./aaveHelpers");

// Set up provider and wallet
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Load the Aave Liquidator contract ABI and instantiate the contract
const liquidatorArtifact = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "artifacts/contracts/AaveLiquidator.sol/AaveLiquidator.json"),
    "utf-8"
  )
);
const aaveLiquidatorABI = liquidatorArtifact.abi;
const aaveLiquidatorContract = new ethers.Contract(
  process.env.AAVE_LIQUIDATOR_ADDRESS,
  aaveLiquidatorABI,
  wallet
);

async function main() {
  console.log("🚀 Starting Aave Liquidator Bot on Metis...");

  while (true) {
    try {
      const opportunities = await getUnhealthyPositions(provider);
      console.log(`📌 Found ${opportunities.length} liquidatable positions.`);
      
      // IMPORTANT: Destructure the position object properly when calling attemptLiquidation
      for (const position of opportunities) {
        await attemptLiquidation(position);
      }
      
      await delay(30000); // 30-second cycle
    } catch (error) {
      console.error("❌ Error in main loop:", error.message);
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function attemptLiquidation({ user, debtAsset, debtAmount, collateralAsset }) {
  console.log("⚡ Attempting liquidation with:", {
    user,
    debtAsset,
    debtAmount: ethers.utils.formatUnits(debtAmount, 6),
    collateralAsset
  });

  // Re-check user health factor (pass both user and provider)
  const latestHealthFactor = await getUserHealthFactor(user, provider);
  console.log(`Health factor for ${user}: ${latestHealthFactor}`);
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
    console.log(`Partial liquidation: Only covering 50% of the debt: ${ethers.utils.formatUnits(debtToCover, 6)} USDC`);
  } else {
    console.log(`Full liquidation: Covering full debt: ${ethers.utils.formatUnits(debtToCover, 6)} USDC`);
  }

  try {
    const gasPrice = await provider.getGasPrice();
    const maxPriorityFee = ethers.utils.parseUnits("2", "gwei");

    const tx = await aaveLiquidatorContract.triggerLiquidation(
      debtAsset,
      debtToCover,
      user,
      collateralAsset,
      {
        gasLimit: 2_000_000,
        gasPrice: gasPrice.add(maxPriorityFee)
      }
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


main().catch(console.error);
