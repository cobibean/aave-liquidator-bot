const CHAIN_CONFIGS = {
  ethereum: {
    key: "ethereum",
    name: "Ethereum Mainnet",
    chainId: 1,
    nativeToken: "ETH",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    rpcUrls: ["https://ethereum-rpc.publicnode.com"],
    poolAddressesProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    protocolDataProvider: "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD",
    debtAssetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    debtSymbol: "USDC",
    gasPriceBumpGwei: "0",
    liquidationGasLimit: 2_000_000,
    borrowScanBlocks: 1_000,
    borrowScanChunkSize: 1_000,
    swapRouter: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  },
  plasma: {
    key: "plasma",
    name: "Plasma Mainnet",
    chainId: 9745,
    nativeToken: "XPL",
    rpcUrl: "https://rpc.plasma.to",
    rpcUrls: ["https://rpc.plasma.to"],
    poolAddressesProvider: "0x061D8e131F26512348ee5FA42e2DF1bA9d6505E9",
    pool: "0x925a2A7214Ed92428B5b1B090F80b25700095e12",
    protocolDataProvider: "0xf2D6E38B407e31E7E7e4a16E6769728b76c7419F",
    debtAssetAddress: "0xC4374775489CB9C56003BF2C9b12495fC64F0771",
    debtSymbol: "USDT",
    gasPriceBumpGwei: "0",
    liquidationGasLimit: 2_000_000,
    borrowScanBlocks: 10_000,
    borrowScanChunkSize: 10_000,
    borrowBackfillBlocks: 30_000_000, // max-depth cap; > deployment depth (~23M) so Plasma backfills fully
    deploymentBlock: 489_197, // Aave v3 Pool first code block (binary-searched)
    priceOracle: "0x33E0b3fc976DC9C516926BA48CfC0A9E10a2aAA5",
    wrappedNative: "0x6100E367285b01F48D07953803A2d8dCA5D19873",
    hardenedLiquidator: true, // deployed contract supports triggerLiquidationWithMinProfit
    swapRouter: "0x807F4E281B7A3B324825C64ca53c69F0b418dE40",
    swapIntermediates: ["0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb"],
    liquidatorArtifact: "AaveLiquidatorSwapRouter02",
  },
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    nativeToken: "ETH",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    rpcUrls: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
    poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    protocolDataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
    debtAssetAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    debtSymbol: "USDC",
    gasPriceBumpGwei: "0.01",
    liquidationGasLimit: 2_000_000,
    borrowScanBlocks: 300_000,
    borrowScanChunkSize: 25_000,
    borrowBackfillBlocks: 130_000_000, // max-depth cap; > deployment depth (~43M) so Arbitrum backfills fully
    deploymentBlock: 426_768_359, // Aave v3 Pool first code block (binary-searched)
    priceOracle: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    swapRouter: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    liquidatorArtifact: "AaveLiquidatorSwapRouter02",
    hardenedLiquidator: true, // hardened contract deployed 2026-06-02 (via private RPC)
  },
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    nativeToken: "ETH",
    rpcUrl: "https://mainnet.base.org",
    rpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    poolAddressesProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    protocolDataProvider: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
    debtAssetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    debtSymbol: "USDC",
    gasPriceBumpGwei: "0",
    liquidationGasLimit: 2_000_000,
    borrowScanBlocks: 120_000,
    borrowScanChunkSize: 10_000,
    borrowBackfillBlocks: 50_000_000, // max-depth cap; > deployment depth (~44M) so Base backfills fully
    deploymentBlock: 2_357_134, // Aave v3 Pool first code block (binary-searched)
    priceOracle: "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    hardenedLiquidator: true, // deployed contract supports triggerLiquidationWithMinProfit
    swapRouter: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
    liquidatorArtifact: "AaveLiquidatorSwapRouter02",
  },
  optimism: {
    key: "optimism",
    name: "Optimism",
    chainId: 10,
    nativeToken: "ETH",
    rpcUrl: "https://mainnet.optimism.io",
    rpcUrls: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
    poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    protocolDataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
    debtAssetAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    debtSymbol: "USDC",
    gasPriceBumpGwei: "0",
    liquidationGasLimit: 2_000_000,
    borrowScanBlocks: 250_000,
    borrowScanChunkSize: 5_000,
    borrowBackfillBlocks: 15_811_200, // ~366-day cap @ ~2s blocks (full deployment ~148M is ~30h on public RPC)
    deploymentBlock: 4_365_693, // Aave v3 Pool first code block (binary-searched)
    priceOracle: "0xD81eb3728a631871a7eBBaD631b5f424909f0c77",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    hardenedLiquidator: true, // deployed contract supports triggerLiquidationWithMinProfit
    swapRouter: "0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2",
    liquidatorArtifact: "AaveLiquidatorSwapRouter02",
  },
  linea: {
    key: "linea",
    name: "Linea",
    chainId: 59144,
    nativeToken: "ETH",
    rpcUrl: "https://rpc.linea.build",
    rpcUrls: ["https://rpc.linea.build", "https://linea-rpc.publicnode.com"],
    poolAddressesProvider: "0x89502c3731F69DDC95B65753708A07F8Cd0373F4",
    pool: "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac",
    protocolDataProvider: "0x47cd4b507B81cB831669c71c7077f4daF6762FF4",
    debtAssetAddress: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    debtSymbol: "USDC",
    gasPriceBumpGwei: "0",
    liquidationGasLimit: 2_000_000,
    borrowScanBlocks: 10_000,
    borrowScanChunkSize: 10_000,
    swapRouter: "",
  },
  polygon: {
    key: "polygon",
    name: "Polygon PoS",
    chainId: 137,
    nativeToken: "POL",
    rpcUrl: "https://polygon-bor-rpc.publicnode.com",
    rpcUrls: ["https://polygon-bor-rpc.publicnode.com"],
    poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    protocolDataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
    debtAssetAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    debtSymbol: "USDC",
    gasPriceBumpGwei: "0",
    liquidationGasLimit: 2_000_000,
    borrowScanBlocks: 1_000,
    borrowScanChunkSize: 1_000,
    swapRouter: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  },
  avalanche: {
    key: "avalanche",
    name: "Avalanche C-Chain",
    chainId: 43114,
    nativeToken: "AVAX",
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    rpcUrls: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"],
    poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    protocolDataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
    debtAssetAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    debtSymbol: "USDC",
    gasPriceBumpGwei: "0",
    liquidationGasLimit: 2_000_000,
    borrowScanBlocks: 40_000,
    borrowScanChunkSize: 2_000,
    borrowBackfillBlocks: 15_811_200, // ~366-day cap @ ~2s blocks (full deployment ~75M is ~30h on public RPC)
    deploymentBlock: 11_970_506, // Aave v3 Pool first code block (binary-searched)
    priceOracle: "0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C",
    wrappedNative: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    hardenedLiquidator: true, // deployed contract supports triggerLiquidationWithMinProfit
    swapRouter: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    liquidatorArtifact: "AaveLiquidatorSwapRouter02",
  },
  metis: {
    key: "metis",
    name: "Metis Andromeda",
    chainId: 1088,
    nativeToken: "METIS",
    rpcUrl: "https://andromeda.metis.io/?owner=1088",
    rpcUrls: ["https://andromeda.metis.io/?owner=1088", "https://metis-rpc.publicnode.com"],
    subgraphUrl: "https://metisapi.0xgraph.xyz/subgraphs/name/aave/protocol-v3-metis",
    poolAddressesProvider: "0xB9FABd7500B2C6781c35Dd48d54f81fc2299D7AF",
    pool: "0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57",
    protocolDataProvider: "0x602BeF1d4c381e5a29f0C562A310416A73D8Be19",
    debtAssetAddress: "0xEA32A96608495e54156Ae48931A7c20f0dcc1a21",
    debtSymbol: "m.USDC",
    gasPriceBumpGwei: "0",
    liquidationGasLimit: 2_000_000,
    borrowScanBlocks: 500_000,
    borrowScanChunkSize: 20_000,
    swapRouter: "",
  },
};

const DEFAULT_CHAIN_KEYS = ["plasma", "arbitrum", "base", "avalanche", "optimism"];

function getChainConfig(key) {
  const normalizedKey = normalizeChainKey(key || process.env.CHAIN || "arbitrum");
  const config = CHAIN_CONFIGS[normalizedKey];

  if (!config) {
    throw new Error(`Unsupported chain "${key}". Supported chains: ${Object.keys(CHAIN_CONFIGS).join(", ")}`);
  }

  return applyEnvOverrides(config);
}

function getSelectedChainConfigs(value = process.env.CHAINS || process.env.CHAIN || DEFAULT_CHAIN_KEYS.join(",")) {
  return value
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)
    .map(getChainConfig);
}

function normalizeChainKey(key) {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

function applyEnvOverrides(config) {
  const upperKey = config.key.toUpperCase();
  const explicitGlobalChain = process.env.CHAIN ? normalizeChainKey(process.env.CHAIN) : null;
  const globalOverridesEnabled = !process.env.CHAINS && explicitGlobalChain === config.key;
  const rpcUrls = resolveRpcUrls(config, upperKey, globalOverridesEnabled);

  return {
    ...config,
    rpcUrl: rpcUrls[0],
    rpcUrls,
    pool: process.env[`${upperKey}_POOL_ADDRESS`] || (globalOverridesEnabled && process.env.POOL_ADDRESS) || config.pool,
    poolAddressesProvider:
      process.env[`${upperKey}_POOL_ADDRESSES_PROVIDER`] ||
      (globalOverridesEnabled && process.env.POOL_ADDRESSES_PROVIDER) ||
      config.poolAddressesProvider,
    protocolDataProvider:
      process.env[`${upperKey}_PROTOCOL_DATA_PROVIDER`] ||
      (globalOverridesEnabled && process.env.PROTOCOL_DATA_PROVIDER) ||
      config.protocolDataProvider,
    debtAssetAddress:
      process.env[`${upperKey}_DEBT_ASSET_ADDRESS`] ||
      (globalOverridesEnabled && process.env.DEBT_ASSET_ADDRESS) ||
      config.debtAssetAddress,
    subgraphUrl:
      process.env[`${upperKey}_SUBGRAPH_URL`] ||
      (globalOverridesEnabled && process.env.SUBGRAPH_URL) ||
      config.subgraphUrl,
    gasPriceBumpGwei:
      process.env[`${upperKey}_GAS_PRICE_BUMP_GWEI`] ||
      process.env.GAS_PRICE_BUMP_GWEI ||
      config.gasPriceBumpGwei,
    liquidationGasLimit: parsePositiveInt(
      process.env[`${upperKey}_LIQUIDATION_GAS_LIMIT`] || process.env.LIQUIDATION_GAS_LIMIT,
      config.liquidationGasLimit
    ),
    borrowScanBlocks: parsePositiveInt(
      process.env[`${upperKey}_BORROW_SCAN_BLOCKS`] || process.env.BORROW_SCAN_BLOCKS,
      config.borrowScanBlocks
    ),
    borrowScanChunkSize: parsePositiveInt(
      process.env[`${upperKey}_BORROW_SCAN_CHUNK_SIZE`] || process.env.BORROW_SCAN_CHUNK_SIZE,
      config.borrowScanChunkSize
    ),
    borrowBackfillBlocks: parsePositiveInt(
      process.env[`${upperKey}_BORROW_BACKFILL_BLOCKS`] || process.env.BORROW_BACKFILL_BLOCKS,
      config.borrowBackfillBlocks || config.borrowScanBlocks
    ),
  };
}

function resolveRpcUrls(config, upperKey, globalOverridesEnabled) {
  const explicitList =
    parseRpcUrls(process.env[`${upperKey}_RPC_URLS`]) ||
    (globalOverridesEnabled && parseRpcUrls(process.env.RPC_URLS));
  if (explicitList) {
    return explicitList;
  }

  const defaultUrls = normalizeRpcUrls(config.rpcUrls || [config.rpcUrl]);
  const primaryOverride =
    process.env[`${upperKey}_RPC_URL`] || (globalOverridesEnabled && process.env.RPC_URL);

  if (!primaryOverride) {
    return defaultUrls;
  }

  return normalizeRpcUrls([primaryOverride, ...defaultUrls]);
}

function parseRpcUrls(value) {
  if (!value) {
    return null;
  }

  const urls = normalizeRpcUrls(value.split(","));
  return urls.length > 0 ? urls : null;
}

function normalizeRpcUrls(urls) {
  return [...new Set(urls.map((url) => String(url).trim()).filter(Boolean))];
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  CHAIN_CONFIGS,
  DEFAULT_CHAIN_KEYS,
  getChainConfig,
  getSelectedChainConfigs,
};
