require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getUserHealthFactor, getDebtPositions } = require("../aaveHelpers");

const LIQ = ["event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)"];

// Take a few recently-liquidated users and show their CURRENT state.
// If they currently hold debt, they are real targets we should be able to find.
(async () => {
  const key = process.argv[2] || "optimism";
  const c = getChainConfig(key);
  const provider = createProvider(c);
  const head = await provider.getBlockNumber();
  const chunk = c.borrowScanChunkSize || 5000;
  const pool = new ethers.Contract(c.pool, LIQ, provider);

  // collect last ~2h of liquidations, take 5 distinct users
  const seen = []; const set = new Set();
  for (let s = head - 7200; s <= head && seen.length < 5; s += chunk) {
    const e = Math.min(s + chunk - 1, head);
    const evs = await pool.queryFilter(pool.filters.LiquidationCall(), s, e).catch(()=>[]);
    for (const ev of evs) { const u = ev.args.user.toLowerCase(); if (!set.has(u)) { set.add(u); seen.push({ user: ev.args.user, block: ev.blockNumber }); } }
  }
  console.log(`${c.name}: checking current state of ${seen.length} recently-liquidated users`);
  for (const { user, block } of seen) {
    const hf = await getUserHealthFactor(user, provider, c);
    let debts = [];
    try { debts = await getDebtPositions(user, provider, c); } catch(e) {}
    const debtStr = debts.map(d => `${d.debtInUnits?.toFixed?.(2)} ${d.debtSymbol}`).join(", ") || "none";
    console.log(`  ${user} liq@${block} | nowHF=${hf} | currentDebt=[${debtStr}]`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
