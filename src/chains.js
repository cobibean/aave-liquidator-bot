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
    // Chainlink XPL/USD proxy (Aave oracle source for native collateral) — PRICE_TRIGGER feed.
    // Plasma has no free WS; PRICE_TRIGGER falls back to polling this feed on the block loop.
    collateralPriceFeed: "0xF932477C37715aE6657Ab884414Bd9876FE3f750",
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
    borrowBackfillBlocks: 500_000_000, // max-depth cap; > deployment depth (~463M) so Arbitrum backfills fully
    deploymentBlock: 7_742_429, // Aave v3 Pool first code block (binary-searched)
    priceOracle: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    // Chainlink ETH/USD proxy (Aave oracle source for WETH collateral). The
    // PRICE_TRIGGER subscribes to AnswerUpdated on its underlying aggregator()
    // (resolved at runtime) to react to the price move that drives HF<1.
    collateralPriceFeed: "0xbD41b1548a5A06544cBcf87c0c54864312842C00",
    // Uniswap V3 SwapRouter02 (factory 0x1F98431c8aD98523631AE4a59f267346ea31F984).
    // Was a SushiSwap V2 router (0x1b02dA8C…) — the V3-only contract's swap reverted.
    // 100% real-collateral V3 coverage verified (scripts/probeCollateralVenues.js).
    swapRouter: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    liquidatorArtifact: "AaveLiquidatorSwapRouter02",
    hardenedLiquidator: true, // hardened contract deployed 2026-06-02 (via private RPC)
    pathAware: true, // V3 path-aware contract 0x81f151E5… deployed 2026-06-03 (1559 capped-fee)
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
    // Chainlink ETH/USD proxy (Aave oracle source for WETH collateral) — PRICE_TRIGGER feed.
    collateralPriceFeed: "0x9dA00D23465282005DB222a441a663eE7B9dfCc8",
    hardenedLiquidator: true, // deployed contract supports triggerLiquidationWithMinProfit
    // Uniswap V3 SwapRouter02 (factory 0x33128a8fC17869897dcE68Ed026d694621f6FDfD).
    // Was a V2 router (0x4752ba5d…) — the V3-only contract's swap reverted.
    // 100% real-collateral V3 coverage verified (scripts/probeCollateralVenues.js).
    swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
    liquidatorArtifact: "AaveLiquidatorSwapRouter02",
    pathAware: true, // V3 path-aware contract 0x81f151E5… deployed 2026-06-03
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
    borrowBackfillBlocks: 200_000_000, // max-depth cap; > deployment depth (~148M) so Optimism backfills fully
    deploymentBlock: 4_365_693, // Aave v3 Pool first code block (binary-searched)
    priceOracle: "0xD81eb3728a631871a7eBBaD631b5f424909f0c77",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    // Chainlink ETH/USD proxy (Aave oracle source for WETH collateral) — PRICE_TRIGGER feed.
    collateralPriceFeed: "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
    hardenedLiquidator: true, // deployed contract supports triggerLiquidationWithMinProfit
    // Uniswap V3 SwapRouter02 (factory 0x1F98431c8aD98523631AE4a59f267346ea31F984).
    // Was a V2 router (0x4A7b5Da6…) — the V3-only contract's swap reverted.
    // 100% real-collateral V3 coverage verified (scripts/probeCollateralVenues.js).
    swapRouter: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    liquidatorArtifact: "AaveLiquidatorSwapRouter02",
    pathAware: true, // V3 path-aware contract 0x81f151E5… deployed 2026-06-03
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
    borrowBackfillBlocks: 100_000_000, // max-depth cap; > deployment depth (~75M) so Avalanche backfills fully
    deploymentBlock: 11_970_506, // Aave v3 Pool first code block (binary-searched)
    priceOracle: "0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C",
    wrappedNative: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    // Chainlink AVAX/USD proxy (Aave oracle source for WAVAX collateral) — PRICE_TRIGGER feed.
    collateralPriceFeed: "0x0A77230d17318075983913bC2145DB16C7366156",
    hardenedLiquidator: true, // deployed contract supports triggerLiquidationWithMinProfit
    // Uniswap V3 SwapRouter02 (factory 0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD).
    // Was a SushiSwap V2 router (0x1b02da8c…) — the V3-only contract's swap reverted.
    // ~99% real-collateral V3 coverage verified (only WETH.e→GHO lacks a path).
    swapRouter: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
    liquidatorArtifact: "AaveLiquidatorSwapRouter02",
    pathAware: true, // V3 path-aware contract 0x81f151E5… deployed 2026-06-03
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
  // --- Track-1 thin-chain additions (2026-06-06) ---
  // Probed (scripts/probeChainWinnability.js, 7d): OPEN field + real non-dust flow.
  // Scroll: 123 liqs/7d, 13 distinct liquidators, top 41% (vs Base's single-pack 100%);
  //   104 distinct victims (real borrower churn). Sample victims repaid $143–$1,804 USDC.
  // Running DETECTION-ONLY for now: NO liquidator address set → bot builds tiers + feeds
  //   winscan but does not send. Send-capability = fast-follow (fund gas + deploy the
  //   AaveLiquidatorSwapRouter02 contract + verify the swapRouter below via
  //   probeCollateralVenues.js). See docs/proposal-chain-switch-2026-06-06.md.
  scroll: {
    key: "scroll",
    name: "Scroll",
    chainId: 534352,
    nativeToken: "ETH",
    rpcUrl: "https://rpc.scroll.io",
    rpcUrls: ["https://rpc.scroll.io", "https://scroll.drpc.org"],
    poolAddressesProvider: "0x69850D0B276776781C063771b161bd8894BCdD04",
    pool: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe",
    protocolDataProvider: "0xBEa2B648f05887eCbF1d115da8b7E4A317975A51",
    debtAssetAddress: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", // USDC (native)
    debtSymbol: "USDC",
    gasPriceBumpGwei: "0",
    liquidationGasLimit: 2_000_000,
    borrowScanBlocks: 120_000,
    borrowScanChunkSize: 10_000,
    borrowBackfillBlocks: 40_000_000, // max-depth cap; > deployment depth (~31M) so Scroll backfills fully
    deploymentBlock: 2_618_764, // Aave v3 Pool first code block (binary-searched, public RPC)
    priceOracle: "0x04421D8C506E2fA2371a08EfAaBf791F624054F3",
    wrappedNative: "0x5300000000000000000000000000000000000004",
    // Uniswap V3 SwapRouter02 on Scroll (official deployments list; factory
    // 0x70C62C8b8e801124A4Aa81ce07b637A3e83cb919). VERIFIED 2026-06-07 via
    // probeCollateralVenues.js: 100% V3 coverage of the live collateral set
    // (WETH/wstETH/weETH -> USDC all have direct or 2-hop-via-WETH pools).
    swapRouter: "0xfc30937f5cDe93Df8d48aCAF7e6f5D8D8A31F636",
    liquidatorArtifact: "AaveLiquidatorSwapRouter02",
    hardenedLiquidator: true, // supports triggerLiquidationWithMinProfit
    pathAware: true, // V3 path-aware contract deployed 2026-06-07 at 0x6ba5901f… (SCROLL_AAVE_LIQUIDATOR_ADDRESS)
  },
  // Gnosis: 35 liqs/7d, 6 distinct liquidators, top 40% (most fragmented field probed);
  //   30 distinct victims. Sample victims repaid $963–$1,476 (EURe / USDC.e / WXDAI).
  // DETECTION-ONLY: Gnosis has NO clean Uniswap V3 (Honeyswap/Balancer ecosystem) — the
  //   swapRouter is intentionally LEFT BLANK until a working V3-style venue is verified.
  //   Do NOT enable sends here until that's resolved (a bad router = silent revert on
  //   every liquidation, the documented swap-router-v3-fix failure mode).
  gnosis: {
    key: "gnosis",
    name: "Gnosis Chain",
    chainId: 100,
    nativeToken: "xDAI",
    rpcUrl: "https://rpc.gnosischain.com",
    rpcUrls: ["https://rpc.gnosischain.com", "https://gnosis.drpc.org"],
    poolAddressesProvider: "0x36616cf17557639614c1cdDb356b1B83fc0B2132",
    pool: "0xb50201558B00496A145fE76f7424749556E326D8",
    protocolDataProvider: "0xF1F5acB596568895393cB5E4D0452D6592A2fA70",
    debtAssetAddress: "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0", // USDC.e (most-seen debt in probe)
    debtSymbol: "USDC.e",
    gasPriceBumpGwei: "0",
    liquidationGasLimit: 2_000_000,
    borrowScanBlocks: 120_000,
    borrowScanChunkSize: 10_000,
    borrowBackfillBlocks: 30_000_000, // max-depth cap; > deployment depth (~16M from floor) so Gnosis backfills fully
    deploymentBlock: 30_293_057, // Aave v3 Pool first code block (binary-searched, public RPC)
    priceOracle: "0xeb0a051be10228213BAEb449db63719d6742F7c4",
    wrappedNative: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", // WXDAI
    swapRouter: "", // INTENTIONALLY BLANK — no verified V3 venue on Gnosis yet (detection-only)
    liquidatorArtifact: "AaveLiquidatorSwapRouter02",
    // NOTE: DETECTION-ONLY (no liquidator addr, no swap router).
  },
};

const DEFAULT_CHAIN_KEYS = ["arbitrum", "base", "avalanche", "optimism"];

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
