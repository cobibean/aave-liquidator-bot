require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");

const BORROW = ["event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"];
const LIQ = ["event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)"];

// For one chain: how does Borrow-event coverage of recently-liquidated users
// grow as we deepen the backfill window? Answers whether Borrow-from-deployment
// is sufficient (vs needing debt-token mints).
(async () => {
  const key = process.argv[2] || "optimism";
  const c = getChainConfig(key);
  const provider = createProvider(c);
  const head = await provider.getBlockNumber();
  const chunk = c.borrowScanChunkSize || 5000;

  // Recently liquidated users (~12h)
  const liqWindow = 21600;
  const pool = new ethers.Contract(c.pool, LIQ, provider);
  const liquidated = new Set();
  for (let s = head - liqWindow; s <= head; s += chunk) {
    const e = Math.min(s + chunk - 1, head);
    const evs = await pool.queryFilter(pool.filters.LiquidationCall(), s, e).catch(() => []);
    evs.forEach(ev => liquidated.add(ev.args.user.toLowerCase()));
  }
  console.log(`${c.name}: ${liquidated.size} unique users liquidated in last ~12h`);

  // Borrowers across increasing depths
  const borrowPool = new ethers.Contract(c.pool, BORROW, provider);
  const depths = [250000, 1296000, 5000000, 12000000]; // ~6d, 30d, ~115d, ~280d at 2s
  const found = new Set();
  let scannedFrom = head;
  for (const depth of depths) {
    const target = Math.max(head - depth, 0);
    // scan the new (deeper) slice [target, scannedFrom)
    for (let s = target; s < scannedFrom; s += chunk) {
      const e = Math.min(s + chunk - 1, scannedFrom - 1);
      const evs = await borrowPool.queryFilter(borrowPool.filters.Borrow(), s, e).catch(() => []);
      evs.forEach(ev => { const b = (ev.args.onBehalfOf||ev.args.user); if (b) found.add(b.toLowerCase()); });
    }
    scannedFrom = target;
    let covered = 0; for (const u of liquidated) if (found.has(u)) covered++;
    const pct = liquidated.size ? Math.round(covered/liquidated.size*1000)/10 : 0;
    console.log(`  depth ${depth.toString().padStart(9)} blocks (~${Math.round(depth/43200)}d): borrowers=${found.size.toString().padStart(6)} coverage=${pct}% (${covered}/${liquidated.size})`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
