require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const POOL = ["function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"];
// The big Optimism whale from earlier: 0xbf0aE1aAE3D3018B3f311620FA512d7498eAD8B7 (~51k USDC debt)
(async () => {
  const c = getChainConfig("optimism");
  const provider = createProvider(c);
  const pool = new ethers.Contract(c.pool, POOL, provider);
  const u = "0xbf0aE1aAE3D3018B3f311620FA512d7498eAD8B7";
  const d = await pool.getUserAccountData(u);
  console.log("raw totalDebtBase:", d.totalDebtBase.toString());
  console.log("as 8-decimals (USD):", ethers.utils.formatUnits(d.totalDebtBase, 8));
  console.log("totalCollateralBase as 8dp:", ethers.utils.formatUnits(d.totalCollateralBase, 8));
  console.log("HF:", ethers.utils.formatUnits(d.healthFactor, 18));
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
