// Probe: is each chain's configured swapRouter actually a Uniswap-V3 SwapRouter02
// (factory exposes getPool(a,b,fee)) or a V2/Sushi router (factory exposes
// getPair(a,b))? The deployed AaveLiquidatorSwapRouter02.sol ONLY speaks V3
// (factory.getPool + exactInput), so a V2 router => executeOperation's swap
// branch reverts.
//
// For each configured chain we:
//   1. read swapRouter.factory()
//   2. probe factory.getPool(WNATIVE, USDC, fee) for fee in {100,500,3000,10000}
//   3. probe factory.getPair(WNATIVE, USDC)  (V2)
//   4. repeat (2)+(3) against a PROPOSED V3 router/factory to confirm V3 pools exist
//
// Read-only. No keys needed.

const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");

const FEE_TIERS = [100, 500, 3000, 10000];

const ROUTER_ABI = ["function factory() view returns (address)"];
const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const V2_FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const V2_ROUTER_ABI = ["function factory() view returns (address)"];

// Proposed correct V3 SwapRouter02 + factory per chain (to be confirmed by this
// script). factory left blank => derive from router.factory().
const PROPOSED_V3 = {
  arbitrum: { router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984" },
  optimism: { router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984" },
  base: { router: "0x2626664c2603336E57B271c5C0b26F421741e481", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" },
  avalanche: { router: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE", factory: "" }, // factory unknown, derive
  plasma: { router: "", factory: "" }, // re-verify configured one
};

// USDC per chain (the bot's debt asset). WNATIVE comes from chainConfig.wrappedNative.
const USDC = {
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  plasma: "0xC4374775489CB9C56003BF2C9b12495fC64F0771", // USDT (plasma debt)
};

function provFor(cfg) {
  return new ethers.providers.JsonRpcProvider(cfg.rpcUrl);
}

async function readFactory(provider, router) {
  try {
    const c = new ethers.Contract(router, ROUTER_ABI, provider);
    return await c.factory();
  } catch (e) {
    return `ERR(${(e.reason || e.code || e.message || "").toString().slice(0, 40)})`;
  }
}

async function probeV3(provider, factory, a, b) {
  const c = new ethers.Contract(factory, V3_FACTORY_ABI, provider);
  const out = {};
  for (const fee of FEE_TIERS) {
    try {
      const pool = await c.getPool(a, b, fee);
      out[fee] = pool && pool !== ethers.constants.AddressZero ? pool : "(none)";
    } catch (e) {
      out[fee] = `REVERT(${(e.reason || e.code || "").toString().slice(0, 20)})`;
    }
  }
  return out;
}

async function probeV2(provider, factory, a, b) {
  try {
    const c = new ethers.Contract(factory, V2_FACTORY_ABI, provider);
    const pair = await c.getPair(a, b);
    return pair && pair !== ethers.constants.AddressZero ? pair : "(none)";
  } catch (e) {
    return `REVERT(${(e.reason || e.code || "").toString().slice(0, 20)})`;
  }
}

async function main() {
  const cfgs = getSelectedChainConfigs();
  for (const cfg of cfgs) {
    const key = cfg.key;
    const provider = provFor(cfg);
    const wnative = cfg.wrappedNative;
    const usdc = USDC[key];
    console.log("\n========================================================");
    console.log(`CHAIN: ${key}  (chainId ${cfg.chainId})  rpc=${cfg.rpcUrl}`);
    console.log(`  WNATIVE=${wnative}`);
    console.log(`  USDC/debt=${usdc}`);

    // --- configured router ---
    const configuredRouter = cfg.swapRouter;
    console.log(`\n  [CONFIGURED router in chains.js] ${configuredRouter}`);
    const cfgFactory = await readFactory(provider, configuredRouter);
    console.log(`    router.factory() => ${cfgFactory}`);
    if (cfgFactory.startsWith("0x")) {
      const v3 = await probeV3(provider, cfgFactory, wnative, usdc);
      console.log(`    V3 getPool(WNATIVE,USDC,fee): ${JSON.stringify(v3)}`);
      const v2 = await probeV2(provider, cfgFactory, wnative, usdc);
      console.log(`    V2 getPair(WNATIVE,USDC):     ${v2}`);
    }

    // --- proposed V3 router ---
    const prop = PROPOSED_V3[key] || {};
    if (prop.router) {
      console.log(`\n  [PROPOSED V3 router] ${prop.router}`);
      const propRouterFactory = await readFactory(provider, prop.router);
      console.log(`    router.factory() => ${propRouterFactory}`);
      const factoryToUse = prop.factory || (propRouterFactory.startsWith("0x") ? propRouterFactory : null);
      if (prop.factory && prop.factory.toLowerCase() !== String(propRouterFactory).toLowerCase()) {
        console.log(`    NOTE: proposed factory (${prop.factory}) != router.factory() (${propRouterFactory})`);
      }
      if (factoryToUse) {
        const v3 = await probeV3(provider, factoryToUse, wnative, usdc);
        console.log(`    V3 getPool(WNATIVE,USDC,fee) @${factoryToUse}: ${JSON.stringify(v3)}`);
      }
    } else {
      console.log(`\n  [PROPOSED V3 router] (none specified — re-verify configured)`);
    }
  }
  console.log("\n========================================================\nDONE");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
