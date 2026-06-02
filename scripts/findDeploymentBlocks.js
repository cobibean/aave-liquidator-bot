require("dotenv").config();
const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { createProvider } = require("../src/provider");

// Binary-search the first block where the Pool contract has code = deployment block.
async function firstCodeBlock(provider, address, head) {
  let lo = 0, hi = head, firstWithCode = head;
  // ensure it has code at head
  if ((await provider.getCode(address, head)) === "0x") return null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let code = "0x";
    try { code = await provider.getCode(address, mid); } catch (e) { /* some RPCs prune old state */ }
    if (code && code !== "0x") { firstWithCode = mid; hi = mid - 1; }
    else { lo = mid + 1; }
  }
  return firstWithCode;
}

(async () => {
  for (const c of getSelectedChainConfigs()) {
    try {
      const provider = createProvider(c);
      const head = await provider.getBlockNumber();
      const dep = await firstCodeBlock(provider, c.pool, head);
      console.log(`${c.key.padEnd(10)} pool=${c.pool} deploymentBlock≈${dep} (head ${head}, depth ${dep!=null?head-dep:"?"} blocks)`);
    } catch (e) {
      console.log(`${c.key.padEnd(10)} ERR ${e.message}`);
    }
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
