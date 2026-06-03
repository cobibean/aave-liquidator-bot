// Verify the off-chain resolveSwapPath (aaveHelpers, task 3.3) produces a packed
// path whose ENCODING matches the contract's _resolveSwapPath format, while
// (intentionally) choosing a BETTER fee tier than the contract's naive
// first-existing-pool _findFeeTier.
//
// NOTE (post liquidity-aware upgrade): the off-chain resolver now skips
// zero-liquidity pools and picks the highest-liquidity tier, so it is DELIBERATELY
// NOT byte-equal to the naive reference where the naive tier is a dead pool. A
// "mismatch" reported here is therefore EXPECTED and GOOD when the naive tier had
// no liquidity. The authoritative correctness check is the actual swap dry-run in
// scripts/verifyExactInputCallStatic.js (does the resolved path execute?). This
// test stays useful as a structural/encoding check and to surface where off-chain
// diverges from naive (each divergence should be a dead-pool avoidance).
//
// Read-only. Run per chain, e.g.:  CHAINS=base node scripts/testSwapPathEquivalence.js

const fs = require("fs");
const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { resolveSwapPath } = require("../aaveHelpers");
const { aggregate3InBatches } = require("../src/multicall");

const FEE_TIERS = [100, 500, 3000, 10000];
const DP_IFACE = new ethers.utils.Interface([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);
const POOL_IFACE = new ethers.utils.Interface(["function getReservesList() view returns (address[])"]);
const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const ROUTER_ABI = ["function factory() view returns (address)"];
const LIMIT = parseInt(process.env.PROBE_LIMIT || "120", 10);

// Reference re-implementation of the contract's _findFeeTier / _resolveSwapPath.
async function refFindFeeTier(factoryC, a, b) {
  for (const fee of FEE_TIERS) {
    try {
      const p = await factoryC.getPool(a, b, fee);
      if (p && p !== ethers.constants.AddressZero) return fee;
    } catch (_) {}
  }
  return 0;
}
function refPack(parts) {
  const types = parts.map((_, i) => (i % 2 === 0 ? "address" : "uint24"));
  return ethers.utils.solidityPack(types, parts);
}
async function refResolvePath(factoryC, chainConfig, tokenIn, tokenOut) {
  const directFee = await refFindFeeTier(factoryC, tokenIn, tokenOut);
  if (directFee !== 0) return refPack([tokenIn, directFee, tokenOut]);
  const intermediates = [];
  for (const t of [chainConfig.wrappedNative, ...(chainConfig.swapIntermediates || [])]) {
    if (!t) continue;
    const lc = t.toLowerCase();
    if (lc === tokenIn.toLowerCase() || lc === tokenOut.toLowerCase()) continue;
    if (!intermediates.some((x) => x.toLowerCase() === lc)) intermediates.push(t);
  }
  for (const mid of intermediates) {
    const f1 = await refFindFeeTier(factoryC, tokenIn, mid);
    if (f1 === 0) continue;
    const f2 = await refFindFeeTier(factoryC, mid, tokenOut);
    if (f2 === 0) continue;
    return refPack([tokenIn, f1, mid, f2, tokenOut]);
  }
  return "0x"; // contract reverts("no v3 path"); off-chain returns 0x => self-resolve
}

async function realPairs(cfg, provider, users) {
  const dp = cfg.protocolDataProvider;
  const pool = new ethers.Contract(cfg.pool, POOL_IFACE, provider);
  const reserves = await pool.getReservesList();
  const preferredDebt = (cfg.debtAssetAddress || "").toLowerCase();
  const calls = [];
  for (const user of users) for (const asset of reserves) {
    calls.push({ target: dp, allowFailure: true, callData: DP_IFACE.encodeFunctionData("getUserReserveData", [asset, user]) });
  }
  const raw = await aggregate3InBatches(provider, calls, 300);
  const pairs = new Map();
  let idx = 0;
  for (let u = 0; u < users.length; u++) {
    let pref = null, best = null, coll = null;
    for (let r = 0; r < reserves.length; r++) {
      const asset = reserves[r];
      const e = raw[idx++];
      if (!e || !e.success || !e.returnData || e.returnData === "0x") continue;
      let d; try { d = DP_IFACE.decodeFunctionResult("getUserReserveData", e.returnData); } catch (_) { continue; }
      const debt = d.currentStableDebt.add(d.currentVariableDebt);
      if (debt.gt(0)) {
        if (asset.toLowerCase() === preferredDebt) pref = { asset, debt };
        else if (!best || debt.gt(best.debt)) best = { asset, debt };
      }
      if (d.currentATokenBalance.gt(0) && d.usageAsCollateralEnabled && (!coll || d.currentATokenBalance.gt(coll.balance)))
        coll = { asset, balance: d.currentATokenBalance };
    }
    const debt = pref || best;
    if (!debt || !coll || coll.asset.toLowerCase() === debt.asset.toLowerCase()) continue;
    const key = `${coll.asset.toLowerCase()}|${debt.asset.toLowerCase()}`;
    if (!pairs.has(key)) pairs.set(key, { collat: coll.asset, debt: debt.asset });
  }
  return [...pairs.values()];
}

async function main() {
  const cfgs = getSelectedChainConfigs();
  let totalChecked = 0, totalMismatch = 0;
  for (const cfg of cfgs) {
    const provider = new ethers.providers.JsonRpcProvider(cfg.rpcUrl);
    const wl = JSON.parse(fs.readFileSync(`data/droplet/watchlist-${cfg.key}.json`, "utf8"));
    const users = (wl.watch || []).slice(0, LIMIT);
    const pairs = await realPairs(cfg, provider, users);
    let factory;
    try { factory = await new ethers.Contract(cfg.swapRouter, ROUTER_ABI, provider).factory(); } catch (e) {
      console.log(`\n${cfg.key}: router.factory() failed (${e.code || e.message}) — V2 router still configured? Skipping.`);
      continue;
    }
    const factoryC = new ethers.Contract(factory, V3_FACTORY_ABI, provider);
    console.log(`\n================ ${cfg.key} (factory ${factory}) ================`);
    let mism = 0;
    for (const p of pairs) {
      const off = (await resolveSwapPath(provider, cfg, p.collat, p.debt)).toLowerCase();
      const ref = (await refResolvePath(factoryC, cfg, p.collat, p.debt)).toLowerCase();
      totalChecked++;
      const ok = off === ref;
      if (!ok) { mism++; totalMismatch++; }
      const tag = ok ? "✅" : "❌ MISMATCH";
      console.log(`  ${tag} ${p.collat.slice(0,8)}->${p.debt.slice(0,8)}  off=${off === "0x" ? "0x(self-resolve)" : off.slice(0,20)+"…"}  ref=${ref === "0x" ? "0x" : ref.slice(0,20)+"…"}`);
    }
    console.log(`  ${cfg.key}: ${pairs.length} pairs, ${mism} mismatches`);
  }
  console.log(`\nTOTAL: ${totalChecked} pairs checked, ${totalMismatch} mismatches`);
  if (totalMismatch > 0) process.exitCode = 1;
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
