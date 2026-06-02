require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("./src/chains");
const { createProvider } = require("./src/provider");

async function getAavePoolFromProvider() {
    const chainConfig = getChainConfig(process.env.CHAIN || "arbitrum");

    const provider = createProvider(chainConfig);

    // ABI to call `getPool()` on PoolAddressesProvider
    const poolProviderAbi = [
        "function getPool() public view returns (address)"
    ];

    const poolProviderContract = new ethers.Contract(
        chainConfig.poolAddressesProvider,
        poolProviderAbi,
        provider
    );

    try {
        const realPoolAddress = await poolProviderContract.getPool();
        console.log(`✅ ${chainConfig.name} Aave Pool Contract Address: ${realPoolAddress}`);
        return realPoolAddress;
    } catch (error) {
        console.error("❌ Failed to fetch Aave Pool address from provider:", error);
    }
}

getAavePoolFromProvider();
