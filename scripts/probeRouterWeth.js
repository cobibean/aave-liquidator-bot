require("dotenv").config();
const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { createProvider } = require("../src/provider");
const ABI = ["function WETH9() view returns (address)","function factory() view returns (address)"];
(async () => {
  for (const c of getSelectedChainConfigs()) {
    const out = { chain: c.key, router: c.swapRouter };
    try {
      const p = createProvider(c);
      const r = new ethers.Contract(c.swapRouter, ABI, p);
      out.WETH9 = await r.WETH9().catch(e => `REVERT (${e.code||"err"})`);
      out.factory = await r.factory().catch(e => `REVERT`);
    } catch (e) { out.error = e.message; }
    console.log(JSON.stringify(out));
  }
})().then(()=>process.exit(0));
