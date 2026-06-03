// DETERMINISTIC gold-standard verification: prove the NEW V3 path-aware contract
// would have successfully executed a REAL liquidation that actually happened —
// and that the OLD (V2-router) contract reverts on the same one.
//
// Method:
//  1. Scan recent LiquidationCall events on the chain (real liquidations).
//  2. For one event, pick the block JUST BEFORE it (B-1): the victim was
//     provably liquidatable there with that exact collateral/debt.
//  3. Virtually deploy (via eth_call constructor sim) BOTH:
//       - NEW contract with the V3 router from chains.js
//       - OLD contract with the deployed V2 router (read from the live contract)
//     and callStatic triggerLiquidation / triggerLiquidationWithPath at block B-1
//     with owner storage overridden. The flash-loan→liquidationCall→swap→repay
//     path runs against real historical state.
//  Expected: OLD reverts in the swap branch; NEW succeeds (and WithPath succeeds).
//
// Read-only (eth_call at a historical block). No keys, no broadcast.
// Usage: CHAINS=base OWNER_ADDR=0x.. node scripts/verifyPathAtHistoricalLiquidation.js

const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { resolveSwapPath } = require("../aaveHelpers");

const art = require("../artifacts/contracts/AaveLiquidatorSwapRouter02.sol/AaveLiquidatorSwapRouter02.json");
const SCRATCH = "0x00000000000000000000000000000000DeaD0001";
const LIQ_IFACE = new ethers.utils.Interface([
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
]);
const OLD_ABI = ["function netSwapRouter() view returns (address)"];
const ACCT_IFACE = new ethers.utils.Interface([
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 healthFactor)",
]);

// HF (1e18) of `user` at `blockTag`.
async function hfAt(provider, pool, user, blockTag) {
  const r = await provider.call({ to: pool, data: ACCT_IFACE.encodeFunctionData("getUserAccountData", [user]) }, blockTag);
  return ACCT_IFACE.decodeFunctionResult("getUserAccountData", r)[5];
}

function ownerSlot(addr) { return ethers.utils.hexZeroPad(ethers.utils.getAddress(addr).toLowerCase(), 32); }

async function constructedCode(provider, pool, router, blockTag) {
  const f = new ethers.ContractFactory(art.abi, art.bytecode);
  const tx = f.getDeployTransaction(pool, router);
  const code = await provider.call({ data: tx.data }, blockTag);
  if (!code || code === "0x") throw new Error("ctor sim empty");
  return code;
}

async function callStatic(provider, code, owner, blockTag, fn, params) {
  const iface = new ethers.utils.Interface(art.abi);
  const data = iface.encodeFunctionData(fn, params);
  const slot0 = "0x" + "0".repeat(64);
  const overrides = { [SCRATCH]: { code, stateDiff: { [slot0]: ownerSlot(owner) } } };
  try {
    await provider.send("eth_call", [{ from: owner, to: SCRATCH, data }, blockTag, overrides]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e.error && e.error.message) || e.data || e.message || "revert").slice(0, 180) };
  }
}

async function findRecentLiquidation(cfg, provider, minDebtRaw) {
  const pool = new ethers.Contract(cfg.pool, LIQ_IFACE, provider);
  const head = await provider.getBlockNumber();
  const span = parseInt(process.env.LIQ_SCAN_BLOCKS || "20000", 10);
  const chunk = parseInt(process.env.LIQ_SCAN_CHUNK || "2000", 10);
  for (let end = head; end > head - span; end -= chunk) {
    const start = Math.max(end - chunk + 1, head - span);
    let logs = [];
    try { logs = await pool.queryFilter(pool.filters.LiquidationCall(), start, end); } catch (_) { continue; }
    // Prefer non-dust, where debtAsset == chain's configured debt (so flashloan
    // asset matches) and collateral != debt (a swap is actually needed).
    logs.reverse();
    for (const log of logs) {
      const a = log.args;
      if (a.collateralAsset.toLowerCase() === a.debtAsset.toLowerCase()) continue;
      if (a.debtAsset.toLowerCase() !== (cfg.debtAssetAddress || "").toLowerCase()) continue;
      if (minDebtRaw && a.debtToCover.lt(minDebtRaw)) continue;
      // Require the victim to be liquidatable (HF<1) at B-1 so our simulation
      // block reflects a genuinely-liquidatable state (same-block liquidations
      // where HF only crosses 1.0 AT block B fail liquidationCall at B-1).
      let hfPrev;
      try { hfPrev = await hfAt(provider, cfg.pool, a.user, log.blockNumber - 1); } catch (_) { continue; }
      if (hfPrev.gte(ethers.utils.parseUnits("1", 18))) continue;
      return { log, hfPrev, ...a };
    }
  }
  return null;
}

async function main() {
  const owner = process.env.OWNER_ADDR;
  if (!owner) throw new Error("set OWNER_ADDR");
  for (const cfg of getSelectedChainConfigs()) {
    const provider = new ethers.providers.JsonRpcProvider(cfg.rpcUrl);
    console.log(`\n================ ${cfg.key} ================`);
    // min debt ~ $50 worth in debt-asset units (debt is usually USDC/USDT 6dp).
    const minDebtRaw = ethers.utils.parseUnits(process.env.MIN_DEBT_TOKENS || "50", 6);
    let liq;
    try { liq = await findRecentLiquidation(cfg, provider, minDebtRaw); }
    catch (e) { console.log(`  scan failed: ${e.message}`); continue; }
    if (!liq) { console.log(`  no suitable recent LiquidationCall (debtAsset==configured, collat!=debt, >=$50) found`); continue; }

    const B = liq.log.blockNumber;
    const at = B - 1; // provably liquidatable just before the real liquidation
    console.log(`  real LiquidationCall @block ${B} tx ${liq.log.transactionHash.slice(0,18)}…`);
    console.log(`    user ${liq.user}  collat ${liq.collateralAsset.slice(0,10)} -> debt ${liq.debtAsset.slice(0,10)}  debtToCover=${ethers.utils.formatUnits(liq.debtToCover,6)} (assuming 6dp)`);
    console.log(`    HF at B-1 = ${ethers.utils.formatUnits(liq.hfPrev, 18)} (liquidatable)`);
    console.log(`    simulating at block ${at} (B-1)`);

    // OLD deployed contract's V2 router (immutable) — read from the live contract.
    let oldRouter = null;
    const deployed = process.env[`${cfg.key.toUpperCase()}_DEPLOYED`] || liq.liquidator; // not reliable; require explicit
    try {
      // best-effort: read from the known deployed address via env, else skip OLD test
      const addr = process.env[`${cfg.key.toUpperCase()}_AAVE_LIQUIDATOR_ADDRESS`];
      if (addr) oldRouter = await new ethers.Contract(addr, OLD_ABI, provider).netSwapRouter();
    } catch (_) {}

    const path = await resolveSwapPath(provider, cfg, liq.collateralAsset, liq.debtAsset);
    console.log(`    off-chain V3 path: ${path === "0x" ? "0x(self-resolve)" : path.slice(0,28)+"…"}`);

    const params4 = [liq.debtAsset, liq.debtToCover, liq.user, liq.collateralAsset];
    const paramsPath = [liq.debtAsset, liq.debtToCover, liq.user, liq.collateralAsset, 0, path];

    if (oldRouter) {
      const oldCode = await constructedCode(provider, cfg.pool, oldRouter, at);
      const oldRes = await callStatic(provider, oldCode, owner, at, "triggerLiquidation", params4);
      console.log(`  OLD contract (V2 router ${oldRouter.slice(0,10)}): ${oldRes.ok ? "✅ OK (unexpected)" : "❌ reverts — " + oldRes.reason}`);
    } else {
      console.log(`  (skipped OLD-router test — no deployed address in local env)`);
    }

    const newCode = await constructedCode(provider, cfg.pool, cfg.swapRouter, at);
    const newSelf = await callStatic(provider, newCode, owner, at, "triggerLiquidation", params4);
    console.log(`  NEW contract (V3 router) triggerLiquidation (self-resolve): ${newSelf.ok ? "✅ OK" : "❌ " + newSelf.reason}`);
    if (path !== "0x") {
      const newPath = await callStatic(provider, newCode, owner, at, "triggerLiquidationWithPath", paramsPath);
      console.log(`  NEW contract (V3 router) triggerLiquidationWithPath (3.3):  ${newPath.ok ? "✅ OK" : "❌ " + newPath.reason}`);
    }
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
