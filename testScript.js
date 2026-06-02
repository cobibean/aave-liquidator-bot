// testContracts.js
require('dotenv').config();
const { ethers } = require('ethers');
const { getChainConfig } = require('./src/chains');
const { createProvider } = require('./src/provider');

async function verifyPool() {
  const chainConfig = getChainConfig(process.env.CHAIN || 'arbitrum');
  const provider = createProvider(chainConfig);
  
  // 1. Check Pool Addresses Provider
  const addressesProviderABI = ['function getPool() view returns (address)'];
  const addressesProvider = new ethers.Contract(
    chainConfig.poolAddressesProvider,
    addressesProviderABI,
    provider
  );
  
  const poolAddress = await addressesProvider.getPool();
  console.log(`${chainConfig.name} actual Pool Address:`, poolAddress);
}

verifyPool().catch(console.error);
