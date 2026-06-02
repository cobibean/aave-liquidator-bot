require("dotenv").config();
const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { createProvider } = require("../src/provider");

// Probe what's actually deployed at each chain's liquidator address: which
// variant (SwapRouter02 has netSwapRouter()+getCommonFeeTiers()), and whether
// its router matches the chain's configured swapRouter.
const ABI = [
  "function owner() view returns (address)",
  "function aavePool() view returns (address)",
  "function netSwapRouter() view returns (address)",
  "function getCommonFeeTiers() view returns (uint24[])",
  "function minProfit() view returns (uint256)",
];
function liqAddr(c){ return process.env[`${c.key.toUpperCase()}_AAVE_LIQUIDATOR_ADDRESS`] || ""; }

(async () => {
  for (const c of getSelectedChainConfigs()) {
    const addr = liqAddr(c);
    const out = { chain: c.key, addr, configuredRouter: c.swapRouter };
    try {
      const p = createProvider(c);
      const code = await p.getCode(addr);
      out.deployed = code !== "0x";
      const k = new ethers.Contract(addr, ABI, p);
      out.netSwapRouter = await k.netSwapRouter().catch(() => "(no netSwapRouter -> NOT SwapRouter02 variant)");
      out.hasFeeTiers = await k.getCommonFeeTiers().then(() => true).catch(() => false);
      out.hasMinProfit = await k.minProfit().then((v) => v.toString()).catch(() => "(no minProfit -> UNHARDENED)");
      out.routerMatches = typeof out.netSwapRouter === "string" && out.netSwapRouter.toLowerCase?.() === (c.swapRouter||"").toLowerCase();
    } catch (e) { out.error = e.message; }
    console.log(JSON.stringify(out));
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
