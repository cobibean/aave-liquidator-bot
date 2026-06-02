require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
// Re-implement the same formula inline to sanity-check magnitudes per chain.
const ORACLE = ["function getAssetPrice(address) view returns (uint256)"];
(async () => {
  for (const k of ["arbitrum","base","optimism","avalanche","plasma"]) {
    const c = getChainConfig(k);
    const p = createProvider(c);
    const oracle = new ethers.Contract(c.priceOracle, ORACLE, p);
    const gasPrice = await p.getGasPrice();
    const [nativeUsd, debtUsd] = await Promise.all([oracle.getAssetPrice(c.wrappedNative), oracle.getAssetPrice(c.debtAssetAddress)]);
    const estGas = ethers.BigNumber.from(c.liquidationGasLimit);
    const debtDecimals = 6;
    const safetyX100 = 200, marginUsd = 1;
    const gasCostUsd8 = estGas.mul(gasPrice).mul(nativeUsd).div(ethers.constants.WeiPerEther);
    const tenPow = ethers.BigNumber.from(10).pow(debtDecimals);
    const gasFloorUnits = gasCostUsd8.mul(tenPow).mul(safetyX100).div(100).div(debtUsd);
    const marginUnits = ethers.utils.parseUnits(marginUsd.toString(), debtDecimals);
    const floor = gasFloorUnits.add(marginUnits);
    console.log(k.padEnd(10), "gasPrice="+ethers.utils.formatUnits(gasPrice,"gwei")+"gwei",
      "gasCostUSD=$"+ethers.utils.formatUnits(gasCostUsd8,8),
      "→ minProfitFloor=$"+ethers.utils.formatUnits(floor, debtDecimals));
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
