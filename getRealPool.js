require("dotenv").config();
const { ethers } = require("ethers");

async function getAavePoolFromProvider() {
    if (!process.env.POOL_ADDRESSES_PROVIDER) {
        console.error("❌ POOL_ADDRESSES_PROVIDER is not set in your .env file!");
        return;
    }

    const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);

    // ABI to call `getPool()` on PoolAddressesProvider
    const poolProviderAbi = [
        "function getPool() public view returns (address)"
    ];

    const poolProviderContract = new ethers.Contract(
        process.env.POOL_ADDRESSES_PROVIDER, // This should be the Aave PoolAddressesProvider
        poolProviderAbi,
        provider
    );

    try {
        const realPoolAddress = await poolProviderContract.getPool();
        console.log(`✅ Real Aave Pool Contract Address: ${realPoolAddress}`);
        return realPoolAddress;
    } catch (error) {
        console.error("❌ Failed to fetch Aave Pool address from provider:", error);
    }
}

getAavePoolFromProvider();