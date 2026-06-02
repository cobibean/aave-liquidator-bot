require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const ABI = ["function owner() view returns (address)","function aavePool() view returns (address)","function minProfit() view returns (uint256)"];
(async () => {
  const c = getChainConfig("arbitrum");
  const p = createProvider(c);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, p);
  const nonce = await p.getTransactionCount(wallet.address);
  const pendingNonce = await p.getTransactionCount(wallet.address, "pending");
  console.log("wallet:", wallet.address, "nonce:", nonce, "pendingNonce:", pendingNonce);
  // The other chains landed at 0x049D... — check if arbitrum has code there too.
  const candidates = ["0x049DBB52c1fdf75362Abf4cf2B1e13F82c0e3dC4"];
  // Also compute the address for nonce-1 (the deploy nonce) in case it landed.
  for (let n = Math.max(nonce-2,0); n <= nonce; n++) {
    candidates.push(ethers.utils.getContractAddress({ from: wallet.address, nonce: n }));
  }
  for (const addr of [...new Set(candidates)]) {
    const code = await p.getCode(addr);
    const out = { addr, hasCode: code !== "0x" };
    if (out.hasCode) {
      const k = new ethers.Contract(addr, ABI, p);
      out.aavePool = await k.aavePool().catch(()=>"ERR");
      out.minProfit = await k.minProfit().then(v=>v.toString()).catch(()=>"ERR(no minProfit=old contract)");
      out.poolMatches = out.aavePool?.toLowerCase?.()===c.pool.toLowerCase();
    }
    console.log(JSON.stringify(out));
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
