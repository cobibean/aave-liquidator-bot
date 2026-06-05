require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const SMOKE_DATA_DIR = process.env.SMOKE_USE_REAL_STORE === "true"
  ? null
  : path.join("/tmp", `liq-smoke-${Date.now()}`);
if (SMOKE_DATA_DIR) {
  process.env.BORROWER_STORE_DIR = SMOKE_DATA_DIR;
  process.env.BORROW_BACKFILL_FROM_DEPLOYMENT = "false";
}

const { getSelectedChainConfigs } = require("../src/chains");
const { getGasSnapshot } = require("../src/gas");
const { createProvider, getRpcUrls } = require("../src/provider");
const {
  getBorrowersFromBorrowEvents,
  getReservesList,
  getUserHealthFactor,
} = require("../aaveHelpers");

const ADDRESSES_PROVIDER_ABI = ["function getPool() view returns (address)"];
const TEST_WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY || "";

async function main() {
  try {
    const chains = getSelectedChainConfigs(process.env.SMOKE_CHAINS || "arbitrum,base,avalanche,optimism");
    const results = [];

    for (const chainConfig of chains) {
      results.push(await smokeChain(chainConfig));
    }

    console.log("Multi-chain smoke summary", JSON.stringify(results, null, 2));

    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0) {
      throw new Error(`Smoke failed on: ${failed.map((result) => result.chain).join(", ")}`);
    }
  } finally {
    if (SMOKE_DATA_DIR) fs.rmSync(SMOKE_DATA_DIR, { recursive: true, force: true });
  }
}

async function smokeChain(chainConfig) {
  const result = {
    chain: chainConfig.key,
    name: chainConfig.name,
    ok: false,
  };

  try {
    const provider = createProvider(chainConfig);
    const gas = await getGasSnapshot(provider, chainConfig);
    if (gas.chainId !== chainConfig.chainId) {
      throw new Error(`Expected chain ${chainConfig.chainId}, got ${gas.chainId}`);
    }

    const addressesProvider = new ethers.Contract(
      chainConfig.poolAddressesProvider,
      ADDRESSES_PROVIDER_ABI,
      provider
    );
    const pool = await addressesProvider.getPool();
    if (pool.toLowerCase() !== chainConfig.pool.toLowerCase()) {
      throw new Error(`Provider pool ${pool} does not match configured pool ${chainConfig.pool}`);
    }

    const reserves = await getReservesList(provider, chainConfig);
    const smokeBlocks = parsePositiveInt(
      process.env.SMOKE_BORROW_SCAN_BLOCKS,
      Math.min(chainConfig.borrowScanBlocks || 60000, 60000)
    );
    const borrowers = await getBorrowersFromBorrowEvents(provider, {
      ...chainConfig,
      borrowScanBlocks: smokeBlocks,
      borrowBackfillBlocks: parsePositiveInt(process.env.SMOKE_BORROW_BACKFILL_BLOCKS, smokeBlocks),
    });
    const sampledBorrowers = borrowers.slice(0, 5);
    const healthFactors = [];

    for (const borrower of sampledBorrowers) {
      const healthFactor = await getUserHealthFactor(borrower, provider, chainConfig);
      healthFactors.push({ borrower, healthFactor });
    }

    const wallet = TEST_WALLET_PRIVATE_KEY
      ? new ethers.Wallet(TEST_WALLET_PRIVATE_KEY, provider)
      : null;
    const balance = wallet ? await provider.getBalance(wallet.address) : null;
    const liquidatorAddress = getLiquidatorAddress(chainConfig);
    const liquidatorCode = liquidatorAddress ? await provider.getCode(liquidatorAddress) : "0x";

    result.ok = true;
    result.chainId = gas.chainId;
    result.blockNumber = gas.blockNumber;
    result.nativeToken = chainConfig.nativeToken;
    result.rpcUrls = getRpcUrls(chainConfig);
    result.gasPriceGwei = gas.gasPriceGwei;
    result.estimatedDeployCost = `${gas.estimates.deployCostNative} ${chainConfig.nativeToken}`;
    result.estimatedLiquidationGasCap = `${gas.estimates.liquidationCostNative} ${chainConfig.nativeToken}`;
    result.pool = pool;
    result.reserveCount = reserves.length;
    result.recentBorrowers = borrowers.length;
    result.sampledHealthFactors = healthFactors;
    result.wallet = wallet
      ? {
          address: wallet.address,
          balance: `${ethers.utils.formatEther(balance)} ${chainConfig.nativeToken}`,
        }
      : null;
    result.liquidator = liquidatorAddress
      ? {
          address: liquidatorAddress,
          deployed: liquidatorCode !== "0x",
        }
      : null;

    console.log(`${chainConfig.name} smoke ok`, JSON.stringify(result, null, 2));
  } catch (error) {
    result.error = error.message;
    console.error(`${chainConfig.name} smoke failed:`, error.message);
  }

  return result;
}

function getLiquidatorAddress(chainConfig) {
  return (
    process.env[`${chainConfig.key.toUpperCase()}_AAVE_LIQUIDATOR_ADDRESS`] ||
    (!process.env.CHAINS && process.env.CHAIN === chainConfig.key && process.env.AAVE_LIQUIDATOR_ADDRESS) ||
    ""
  );
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Multi-chain smoke failed:", error.message);
    process.exit(1);
  });
