require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getTransactionOverrides } = require("../src/gas");
const ABI = ["function setMinProfit(uint256) external","function minProfit() view returns (uint256)","function owner() view returns (address)"];

// Sets a conservative stored minProfit floor (in debt-asset smallest units).
// Debt assets are 6-decimal USD stables here, so $2 = 2_000_000.
// Addresses of the contracts to set the floor on. Override a single chain's
// target via <CHAIN>_LIQUIDATOR_OVERRIDE env (used during the V3 redeploy so we
// point at the NEW per-chain contract without editing this file each time).
// V3 path-aware redeploy 2026-06-03: same CREATE address on each chain (same
// deployer+nonce). arbitrum pending (still on old contract until its V3 deploy).
const NEW = {
  plasma: "0x81f151E54B9578337f95bb84C821b96A73E98194",
  base: "0x81f151E54B9578337f95bb84C821b96A73E98194",
  avalanche: "0x81f151E54B9578337f95bb84C821b96A73E98194",
  optimism: "0x81f151E54B9578337f95bb84C821b96A73E98194",
};
// Any chain's target can be overridden via <CHAIN>_LIQUIDATOR_OVERRIDE env, so a
// redeploy can point at the NEW contract without editing this file.
function targetFor(key) {
  return process.env[`${key.toUpperCase()}_LIQUIDATOR_OVERRIDE`] || NEW[key];
}
const FLOOR = process.env.SET_MIN_PROFIT_UNITS || "2000000"; // $2 at 6 decimals

(async () => {
  const only = process.argv[2];
  for (const key of Object.keys(NEW)) {
    if (only && key !== only) continue;
    const addr = targetFor(key);
    const c = getChainConfig(key);
    const p = createProvider(c);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, p);
    const k = new ethers.Contract(addr, ABI, wallet);
    console.log(`${key}: target ${addr}`);
    try {
      const before = (await k.minProfit()).toString();
      // Non-competitive admin tx — use legacy (base) gas, not the liquidation
      // priority bid (which can trip the intrinsic-cost guard on a thin balance).
      const overrides = await getTransactionOverrides(p, c, { gasLimit: 80000, legacy: process.env.DEPLOY_USE_1559 !== "true" });
      const tx = await k.setMinProfit(FLOOR, overrides);
      const rc = await tx.wait();
      const after = (await k.minProfit()).toString();
      console.log(`${key}: minProfit ${before} -> ${after} (tx ${tx.hash}, status ${rc.status})`);
    } catch(e) {
      console.log(`${key}: ERROR ${e.reason||e.message}`);
    }
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
