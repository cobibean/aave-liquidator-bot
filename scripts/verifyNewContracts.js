require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const ABI = ["function owner() view returns (address)","function aavePool() view returns (address)","function netSwapRouter() view returns (address)","function minProfit() view returns (uint256)"];
// New addresses from the deploy
const NEW = {
  plasma: "0x81f151E54B9578337f95bb84C821b96A73E98194",
  base: "0x049DBB52c1fdf75362Abf4cf2B1e13F82c0e3dC4",
  avalanche: "0x049DBB52c1fdf75362Abf4cf2B1e13F82c0e3dC4",
  optimism: "0x049DBB52c1fdf75362Abf4cf2B1e13F82c0e3dC4",
};
(async () => {
  for (const [key, addr] of Object.entries(NEW)) {
    const c = getChainConfig(key);
    const p = createProvider(c);
    const out = { chain: key, addr };
    try {
      const code = await p.getCode(addr);
      out.hasCode = code !== "0x"; out.codeLen = code.length;
      const k = new ethers.Contract(addr, ABI, p);
      out.owner = await k.owner().catch(e=>`ERR ${e.code}`);
      out.aavePool = await k.aavePool().catch(e=>`ERR ${e.code}`);
      out.minProfit = await k.minProfit().then(v=>v.toString()).catch(e=>`ERR ${e.code}`);
      out.poolMatches = typeof out.aavePool==="string" && out.aavePool.toLowerCase?.()===c.pool.toLowerCase();
    } catch(e){ out.error = e.message; }
    console.log(JSON.stringify(out));
  }
})().then(()=>process.exit(0));
