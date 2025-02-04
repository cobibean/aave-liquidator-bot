// testContracts.js
require('dotenv').config();
const { ethers } = require('ethers');

async function verifyPool() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
  
  // 1. Check Pool Addresses Provider
  const addressesProviderABI = ['function getPool() view returns (address)'];
  const addressesProvider = new ethers.Contract(
    process.env.POOL_ADDRESSES_PROVIDER,
    addressesProviderABI,
    provider
  );
  
  const poolAddress = await addressesProvider.getPool();
  console.log('Actual Pool Address:', poolAddress);
}

verifyPool().catch(console.error);