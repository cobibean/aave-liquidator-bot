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

async function attemptLiquidation(user, debtAsset, debtAmount, collateral) {
  console.log(`⚡ Attempting liquidation with:`, { debtAsset, debtAmount, user, collateral });

  // Re-check user health factor before proceeding
  const latestHealthFactor = await getUserHealthFactor(user);
  if (latestHealthFactor > 1.0) {
      console.log(`⏳ Skipping ${user}, already liquidated (HF: ${latestHealthFactor}).`);
      return;
  }

  // Fetch current gas price and add priority fee
  const gasPrice = await provider.getGasPrice();
  const maxPriorityFee = ethers.utils.parseUnits("2", "gwei"); // Adjust for Metis network

  // Prepare transaction
  const tx = {
      to: aaveLiquidatorContract.address,
      data: aaveLiquidatorContract.interface.encodeFunctionData("liquidate", [
          debtAsset,
          debtAmount,
          user,
          collateral,
      ]),
      gasLimit: ethers.utils.hexlify(1_000_000), // Adjust if needed
      gasPrice: gasPrice.add(maxPriorityFee), // Add a boost to priority
  };

  try {
      // Send transaction
      const transactionResponse = await signer.sendTransaction(tx);
      console.log(`✅ TX sent: ${transactionResponse.hash}`);

      // Wait for transaction receipt
      const receipt = await transactionResponse.wait();
      if (receipt.status === 1) {
          console.log(`🎉 Successful liquidation: ${transactionResponse.hash}`);
      } else {
          console.log(`⚠️ Liquidation failed on-chain: ${transactionResponse.hash}`);
      }
  } catch (error) {
      if (error.code === "TRANSACTION_REPLACED") {
          console.log(`⚠️ Transaction was replaced: ${error.replacement.hash}`);
      } else {
          console.error(`❌ Liquidation failed:`, error.message);
      }
  }
}

main().catch(console.error);