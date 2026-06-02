require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getTransactionOverrides } = require("../src/gas");
const ABI = ["function setMinProfit(uint256) external","function minProfit() view returns (uint256)","function owner() view returns (address)"];

// Sets a conservative stored minProfit floor (in debt-asset smallest units).
// Debt assets are 6-decimal USD stables here, so $2 = 2_000_000.
const NEW = {
  plasma: "0x81f151E54B9578337f95bb84C821b96A73E98194",
  base: "0x049DBB52c1fdf75362Abf4cf2B1e13F82c0e3dC4",
  avalanche: "0x049DBB52c1fdf75362Abf4cf2B1e13F82c0e3dC4",
  optimism: "0x049DBB52c1fdf75362Abf4cf2B1e13F82c0e3dC4",
};
const FLOOR = process.env.SET_MIN_PROFIT_UNITS || "2000000"; // $2 at 6 decimals

(async () => {
  const only = process.argv[2];
  for (const [key, addr] of Object.entries(NEW)) {
    if (only && key !== only) continue;
    const c = getChainConfig(key);
    const p = createProvider(c);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, p);
    const k = new ethers.Contract(addr, ABI, wallet);
    try {
      const before = (await k.minProfit()).toString();
      const overrides = await getTransactionOverrides(p, c, { gasLimit: 80000 });
      const tx = await k.setMinProfit(FLOOR, overrides);
      const rc = await tx.wait();
      const after = (await k.minProfit()).toString();
      console.log(`${key}: minProfit ${before} -> ${after} (tx ${tx.hash}, status ${rc.status})`);
    } catch(e) {
      console.log(`${key}: ERROR ${e.reason||e.message}`);
    }
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
