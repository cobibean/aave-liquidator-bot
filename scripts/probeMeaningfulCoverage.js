require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { loadBorrowerSet } = require("../src/borrowerStore");

const LIQ = ["event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)"];
const ERC20 = ["function decimals() view returns (uint8)","function symbol() view returns (string)"];

// Bucket recent liquidations by USD-ish debtToCover size, and report how many
// were SIZEABLE vs dust. debtToCover is in the debt asset's units; for stables
// (most debt here) units≈USD. We approximate: treat 6-decimals as USD stables.
(async () => {
  const key = process.argv[2] || "optimism";
  const minUsd = parseFloat(process.argv[3] || "100");
  const c = getChainConfig(key);
  const provider = createProvider(c);
  const head = await provider.getBlockNumber();
  const chunk = c.borrowScanChunkSize || 5000;
  const window = key === "arbitrum" ? 172800 : 21600;
  const pool = new ethers.Contract(c.pool, LIQ, provider);

  const decCache = {};
  async function dec(addr){ const a=addr.toLowerCase(); if(decCache[a]==null){ try{ decCache[a]=await new ethers.Contract(addr,ERC20,provider).decimals(); }catch(e){ decCache[a]=18; } } return decCache[a]; }

  const evs = [];
  for (let s = head - window; s <= head; s += chunk) {
    const e = Math.min(s + chunk - 1, head);
    evs.push(...await pool.queryFilter(pool.filters.LiquidationCall(), s, e).catch(()=>[]));
  }

  const store = loadBorrowerSet(c.key);
  let dust=0, sizeable=0, sizeableCovered=0;
  const sizeableUsers = new Set(), sizeableCoveredUsers = new Set();
  for (const ev of evs) {
    const d = await dec(ev.args.debtAsset);
    const amt = parseFloat(ethers.utils.formatUnits(ev.args.debtToCover, d));
    if (amt >= minUsd) {
      sizeable++; const u = ev.args.user.toLowerCase(); sizeableUsers.add(u);
      if (store.borrowers.has(u)) sizeableCoveredUsers.add(u);
    } else dust++;
  }
  for (const u of sizeableUsers) if (store.borrowers.has(u)) sizeableCovered++;
  console.log(`${c.name}: ${evs.length} liquidations | dust(<${minUsd})=${dust} | sizeable(>=${minUsd})=${sizeable} (unique users ${sizeableUsers.size})`);
  console.log(`  store=${store.borrowers.size} borrowers | SIZEABLE coverage=${sizeableUsers.size?Math.round(sizeableCoveredUsers.size/sizeableUsers.size*1000)/10:"n/a"}% (${sizeableCoveredUsers.size}/${sizeableUsers.size} sizeable users in store)`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
