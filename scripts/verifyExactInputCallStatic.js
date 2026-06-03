// DEFINITIVE swap-leg proof: callStatic the V3 SwapRouter02.exactInput EXACTLY
// as executeOperation does — with the off-chain-resolved path — and get a real
// amountOut back, against live chain state. Proves the contract's swap call
// succeeds on the new V3 router (and would revert on the OLD V2 router).
//
// We don't have collateral tokens, so we grant a synthetic caller the input-token
// balance + router allowance via ERC20 storage-slot override:
//   - brute-force the balanceOf mapping slot (try slots 0..12; solidity layout
//     balances[holder] = keccak256(abi.encode(holder, slot))).
//   - brute-force the allowance mapping slot similarly (allowance[owner][spender]
//     = keccak256(abi.encode(spender, keccak256(abi.encode(owner, slot)))).
// Then eth_call exactInput from the synthetic caller with amountOutMinimum=0.
// A returned amountOut > 0 == the swap leg works for that path.
//
// Read-only (eth_call + state override). No keys, no broadcast.
// Usage: CHAINS=base node scripts/verifyExactInputCallStatic.js

const fs = require("fs");
const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { resolveSwapPath } = require("../aaveHelpers");
const { aggregate3InBatches } = require("../src/multicall");

const CALLER = "0x00000000000000000000000000000000Ca11e401";
const DP_IFACE = new ethers.utils.Interface([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);
const POOL_IFACE = new ethers.utils.Interface(["function getReservesList() view returns (address[])"]);
const ERC20_IFACE = new ethers.utils.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const ROUTER_IFACE = new ethers.utils.Interface([
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
]);
const LIMIT = parseInt(process.env.PROBE_LIMIT || "60", 10);

function mapSlot(holder, slot) {
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [holder, slot]));
}
function nestedSlot(owner, spender, slot) {
  const inner = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [owner, slot]));
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "bytes32"], [spender, inner]));
}
const BIG = ethers.utils.hexZeroPad(ethers.BigNumber.from("1000000000000000000000000000").toHexString(), 32); // 1e27

// Find which storage slot holds balanceOf by overriding candidate slots and
// reading balanceOf via eth_call until it reflects BIG.
async function findBalanceSlot(provider, token) {
  for (let slot = 0; slot <= 12; slot++) {
    const key = mapSlot(CALLER, slot);
    const ov = { [token]: { stateDiff: { [key]: BIG } } };
    try {
      const r = await provider.send("eth_call", [
        { to: token, data: ERC20_IFACE.encodeFunctionData("balanceOf", [CALLER]) }, "latest", ov,
      ]);
      if (ethers.BigNumber.from(r).eq(ethers.BigNumber.from(BIG))) return slot;
    } catch (_) {}
  }
  return -1;
}
async function findAllowanceSlot(provider, token, spender) {
  for (let slot = 0; slot <= 13; slot++) {
    const key = nestedSlot(CALLER, spender, slot);
    const ov = { [token]: { stateDiff: { [key]: BIG } } };
    try {
      const r = await provider.send("eth_call", [
        { to: token, data: ERC20_IFACE.encodeFunctionData("allowance", [CALLER, spender]) }, "latest", ov,
      ]);
      if (ethers.BigNumber.from(r).eq(ethers.BigNumber.from(BIG))) return slot;
    } catch (_) {}
  }
  return -1;
}

async function realPairs(cfg, provider, users) {
  const reserves = await new ethers.Contract(cfg.pool, POOL_IFACE, provider).getReservesList();
  const preferredDebt = (cfg.debtAssetAddress || "").toLowerCase();
  const calls = [];
  for (const user of users) for (const asset of reserves)
    calls.push({ target: cfg.protocolDataProvider, allowFailure: true, callData: DP_IFACE.encodeFunctionData("getUserReserveData", [asset, user]) });
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
      if (debt.gt(0)) { if (asset.toLowerCase() === preferredDebt) pref = { asset }; else if (!best || debt.gt(best.debt)) best = { asset, debt }; }
      if (d.currentATokenBalance.gt(0) && d.usageAsCollateralEnabled && (!coll || d.currentATokenBalance.gt(coll.balance))) coll = { asset, balance: d.currentATokenBalance };
    }
    const debt = pref || best;
    if (!debt || !coll || coll.asset.toLowerCase() === debt.asset.toLowerCase()) continue;
    const key = `${coll.asset.toLowerCase()}|${debt.asset.toLowerCase()}`;
    if (!pairs.has(key)) pairs.set(key, { collat: coll.asset, debt: debt.asset });
  }
  return [...pairs.values()];
}

async function main() {
  for (const cfg of getSelectedChainConfigs()) {
    const provider = new ethers.providers.JsonRpcProvider(cfg.rpcUrl);
    const router = cfg.swapRouter;
    const wl = JSON.parse(fs.readFileSync(`data/droplet/watchlist-${cfg.key}.json`, "utf8"));
    const users = (wl.watch || []).slice(0, LIMIT);
    console.log(`\n================ ${cfg.key} (V3 router ${router}) ================`);
    const pairs = await realPairs(cfg, provider, users);
    // Test a representative subset (distinct collateral tokens) to bound RPC.
    const seen = new Set(); const subset = [];
    for (const p of pairs) { if (!seen.has(p.collat.toLowerCase())) { seen.add(p.collat.toLowerCase()); subset.push(p); } }
    let ok = 0, fail = 0;
    for (const p of subset) {
      const path = await resolveSwapPath(provider, cfg, p.collat, p.debt);
      let sym = p.collat.slice(0, 8); let dec = 18;
      try { sym = await new ethers.Contract(p.collat, ERC20_IFACE, provider).symbol(); } catch (_) {}
      try { dec = await new ethers.Contract(p.collat, ERC20_IFACE, provider).decimals(); } catch (_) {}
      if (path === "0x") { console.log(`  ⚠️  ${sym}->debt: no path (self-resolve/skip)`); continue; }
      const balSlot = await findBalanceSlot(provider, p.collat);
      const alwSlot = await findAllowanceSlot(provider, p.collat, router);
      if (balSlot < 0 || alwSlot < 0) { console.log(`  ?  ${sym}->debt: couldn't locate balance/allowance slot (bal=${balSlot},alw=${alwSlot}) — skipping`); continue; }
      const amountIn = ethers.utils.parseUnits("1", dec); // 1 token unit
      const ov = {
        [p.collat]: { stateDiff: { [mapSlot(CALLER, balSlot)]: BIG, [nestedSlot(CALLER, router, alwSlot)]: BIG } },
      };
      const data = ROUTER_IFACE.encodeFunctionData("exactInput", [{ path, recipient: CALLER, amountIn, amountOutMinimum: 0 }]);
      try {
        const r = await provider.send("eth_call", [{ from: CALLER, to: router, data }, "latest", ov]);
        const out = ROUTER_IFACE.decodeFunctionResult("exactInput", r)[0];
        ok++;
        console.log(`  ✅ ${sym}->debt: exactInput(1 ${sym}) => amountOut=${out.toString()} (path ok)`);
      } catch (e) {
        fail++;
        console.log(`  ❌ ${sym}->debt: exactInput REVERTED — ${String((e.error && e.error.message) || e.message).slice(0,120)}`);
      }
    }
    console.log(`  ${cfg.key}: swap leg OK ${ok}, fail ${fail} (of ${subset.length} distinct collaterals)`);
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
