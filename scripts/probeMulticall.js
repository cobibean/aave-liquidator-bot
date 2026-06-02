require("dotenv").config();
const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { createProvider } = require("../src/provider");
const MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
(async () => {
  for (const c of getSelectedChainConfigs()) {
    try {
      const p = createProvider(c);
      const code = await p.getCode(MC3);
      console.log(c.key.padEnd(10), code && code !== "0x" ? "✅ Multicall3 present" : "❌ NO CODE at MC3");
    } catch (e) {
      console.log(c.key.padEnd(10), "ERR", e.message);
    }
  }
})().then(() => process.exit(0));
