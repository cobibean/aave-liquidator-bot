require("dotenv").config();
const { ethers } = require("ethers");
const { getUnhealthyPositions } = require("./aaveHelpers");

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

async function main() {
    console.log("🚀 Starting Aave Liquidator Bot on Metis...");

    while (true) {
        try {
            const opportunities = await getUnhealthyPositions(provider);
            console.log(`📌 Found ${opportunities.length} liquidatable positions.`);

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

async function attemptLiquidation(position) {
  const liquidatorABI = require("./artifacts/contracts/AaveLiquidator.sol/AaveLiquidator.json").abi;
  const liquidator = new ethers.Contract(
      process.env.AAVE_LIQUIDATOR_ADDRESS,
      liquidatorABI,
      wallet
  );

  console.log(`⚡ Attempting liquidation with:`, {
      debtAsset: position.debtAsset,
      debtAmount: position.debtAmount.toString(),
      user: position.user,
      collateral: position.collateralAsset
  });

  // Check for missing or undefined values
  if (!position.debtAsset || !position.debtAmount || !position.user || !position.collateralAsset) {
      console.error("❌ Skipping liquidation due to missing data:", position);
      return;
  }

  // **🚨 Ensure debt and collateral are different**
  if (position.debtAsset.toLowerCase() === position.collateralAsset.toLowerCase()) {
      console.error(`❌ Skipping liquidation: Debt and collateral are the same for user ${position.user}`);
      return;
  }

  try {
      const tx = await liquidator.triggerLiquidation(
          position.debtAsset,
          position.debtAmount,
          position.user,
          position.collateralAsset,
          {
              gasLimit: 1_000_000,
              gasPrice: await getOptimizedGasPrice()
          }
      );

      console.log(`✅ TX sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`🎉 Liquidation success! Gas used: ${receipt.gasUsed}`);

  } catch (error) {
      console.error(`❌ Liquidation failed:`, error.message);
  }
}

async function getOptimizedGasPrice() {
    const currentGas = await provider.getGasPrice();
    return currentGas.mul(120).div(100); // Add 20% buffer
}

main().catch(console.error);