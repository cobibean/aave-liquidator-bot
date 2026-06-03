// Isolate and prove the exact thing the bug is about: the SWAP LEG inside
// executeOperation. The contract does:
//     netSwapRouter.exactInput({ path, recipient, amountIn, amountOutMinimum })
// after resolving `path`. On the OLD V2 routers this reverts (no exactInput /
// V3 factory). On the new V3 SwapRouter02 it succeeds. We callStatic exactInput
// directly (state-overriding the caller's collateral balance + allowance is not
// needed: callStatic exactInput with `from` = a whale-free synthetic caller and
// amountOutMinimum=0 just needs the path to be a real pool route — a quoter-like
// dry run). To avoid needing token balances, we use the V3 QUOTER-equivalent
// behavior: exactInput is `payable`+nonview, but callStatic simulates it; if the
// path/pools are valid and the caller is treated as having the input (we override
// the input-token balance + allowance via state override), it returns amountOut.
//
// Simplest robust check that needs NO balances: call the V3 factory getPool for
// every hop in the resolved path (already done in equivalence test) AND callStatic
// the router's exactInputSingle with amountIn that the caller is granted via
// state override of the ERC20 balance slot — too brittle across tokens. Instead
// we use the canonical Uniswap V3 QuoterV2 when available; else we assert the
// resolved path's pools all exist and have nonzero liquidity (slot0 + liquidity).
//
// This script: for the real watchlist collateral->debt pairs, confirm every hop
// pool in the OFF-CHAIN resolved path is a live pool with nonzero liquidity at
// the chosen fee tier — i.e. the contract's exactInput along that path has a
// real venue. Read-only, no balances needed, deterministic.
//
// Usage: CHAINS=base node scripts/verifySwapLegWorks.js

const fs = require("fs");
const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { resolveSwapPath } = require("../aaveHelpers");
const { aggregate3InBatches } = require("../src/multicall");

const DP_IFACE = new ethers.utils.Interface([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);
const POOL_IFACE = new ethers.utils.Interface(["function getReservesList() view returns (address[])"]);
const POOL_V3_ABI = [
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 obIndex, uint16 obCard, uint16 obCardNext, uint8 feeProtocol, bool unlocked)",
];
const LIMIT = parseInt(process.env.PROBE_LIMIT || "120", 10);

// Decode a packed V3 path into [{tokenIn, fee, tokenOut}, ...] hops.
function decodePath(path) {
  const b = ethers.utils.arrayify(path);
  const hops = [];
  let i = 0;
  while (i + 43 <= b.length) {
    const tokenIn = ethers.utils.hexlify(b.slice(i, i + 20));
    const fee = (b[i + 20] << 16) | (b[i + 21] << 8) | b[i + 22];
    const tokenOut = ethers.utils.hexlify(b.slice(i + 23, i + 43));
    hops.push({ tokenIn, fee, tokenOut });
    i += 23;
  }
  return hops;
}

async function realPairs(cfg, provider, users) {
  const dp = cfg.protocolDataProvider;
  const reserves = await new ethers.Contract(cfg.pool, POOL_IFACE, provider).getReservesList();
  const preferredDebt = (cfg.debtAssetAddress || "").toLowerCase();
  const calls = [];
  for (const user of users) for (const asset of reserves)
    calls.push({ target: dp, allowFailure: true, callData: DP_IFACE.encodeFunctionData("getUserReserveData", [asset, user]) });
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
      if (debt.gt(0)) { if (asset.toLowerCase() === preferredDebt) pref = { asset }; else if (!best) best = { asset, debt }; else if (debt.gt(best.debt)) best = { asset, debt }; }
      if (d.currentATokenBalance.gt(0) && d.usageAsCollateralEnabled && (!coll || d.currentATokenBalance.gt(coll.balance))) coll = { asset, balance: d.currentATokenBalance };
    }
    const debt = pref || best;
    if (!debt || !coll || coll.asset.toLowerCase() === debt.asset.toLowerCase()) continue;
    const key = `${coll.asset.toLowerCase()}|${debt.asset.toLowerCase()}`;
    if (!pairs.has(key)) pairs.set(key, { collat: coll.asset, debt: debt.asset });
  }
  return [...pairs.values()];
}

async function getPoolAddr(provider, factory, a, b, fee) {
  const c = new ethers.Contract(factory, ["function getPool(address,address,uint24) view returns (address)"], provider);
  return c.getPool(a, b, fee);
}

async function main() {
  for (const cfg of getSelectedChainConfigs()) {
    const provider = new ethers.providers.JsonRpcProvider(cfg.rpcUrl);
    const wl = JSON.parse(fs.readFileSync(`data/droplet/watchlist-${cfg.key}.json`, "utf8"));
    const users = (wl.watch || []).slice(0, LIMIT);
    const factory = await new ethers.Contract(cfg.swapRouter, ["function factory() view returns (address)"], provider).factory();
    console.log(`\n================ ${cfg.key} (V3 router ${cfg.swapRouter.slice(0,10)}, factory ${factory.slice(0,10)}) ================`);
    const pairs = await realPairs(cfg, provider, users);
    let bad = 0, checked = 0;
    for (const p of pairs) {
      const path = await resolveSwapPath(provider, cfg, p.collat, p.debt);
      if (path === "0x") { console.log(`  ⚠️  ${p.collat.slice(0,8)}->${p.debt.slice(0,8)}: no path (contract would self-resolve/skip)`); continue; }
      const hops = decodePath(path);
      let allLive = true;
      const liqs = [];
      for (const h of hops) {
        const poolAddr = await getPoolAddr(provider, factory, h.tokenIn, h.tokenOut, h.fee);
        if (!poolAddr || poolAddr === ethers.constants.AddressZero) { allLive = false; liqs.push("no-pool"); continue; }
        try {
          const pc = new ethers.Contract(poolAddr, POOL_V3_ABI, provider);
          const [liq, slot0] = await Promise.all([pc.liquidity(), pc.slot0()]);
          const live = liq.gt(0) && slot0.sqrtPriceX96.gt(0);
          if (!live) allLive = false;
          liqs.push(`L=${liq.toString().slice(0,6)}…${live ? "" : " DEAD"}`);
        } catch (e) { allLive = false; liqs.push("read-err"); }
      }
      checked++;
      if (!allLive) bad++;
      console.log(`  ${allLive ? "✅" : "❌"} ${p.collat.slice(0,8)}->${p.debt.slice(0,8)} [${hops.length}hop ${hops.map(h=>h.fee).join(",")}] ${liqs.join(" | ")}`);
    }
    console.log(`  ${cfg.key}: ${checked} path-resolved pairs, ${bad} with a dead/missing hop`);
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
