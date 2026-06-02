require("dotenv").config();
const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { createProvider } = require("../src/provider");
const APROV = ["function getPriceOracle() view returns (address)"];
const ORACLE = ["function getAssetPrice(address) view returns (uint256)","function BASE_CURRENCY_UNIT() view returns (uint256)"];
// Wrapped-native per chain (well-known)
const WNATIVE = {
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
  base: "0x4200000000000000000000000000000000000006",     // WETH
  optimism: "0x4200000000000000000000000000000000000006", // WETH
  avalanche: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX
  plasma: "0x6100E367285b01F48D07953803A2d8dCA5D19873",    // WXPL (from router WETH9 earlier)
};
(async () => {
  for (const c of getSelectedChainConfigs()) {
    const out = { chain: c.key };
    try {
      const p = createProvider(c);
      const ap = new ethers.Contract(c.poolAddressesProvider, APROV, p);
      const oracleAddr = await ap.getPriceOracle();
      out.oracle = oracleAddr;
      const o = new ethers.Contract(oracleAddr, ORACLE, p);
      out.baseUnit = (await o.BASE_CURRENCY_UNIT().catch(()=>"?")).toString();
      const wn = WNATIVE[c.key];
      out.wnative = wn;
      out.nativeUsd = ethers.utils.formatUnits(await o.getAssetPrice(wn), 8);
      out.debtUsd = ethers.utils.formatUnits(await o.getAssetPrice(c.debtAssetAddress), 8);
    } catch(e){ out.error = e.message; }
    console.log(JSON.stringify(out));
  }
})().then(()=>process.exit(0));
