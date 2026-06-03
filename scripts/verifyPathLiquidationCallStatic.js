// GOLD-STANDARD pre-deploy verification (A–C):
// Virtually deploy the NEW path-aware contract (correct V3 router immutable) via
// eth_call state-override and callStatic triggerLiquidationWithPath against a
// REAL, currently-liquidatable watchlist target on live chain state — WITHOUT
// broadcasting anything. Proves the swap branch that reverts on the live (V2)
// contract now succeeds with the V3 router + off-chain path.
//
// How it works around constructor/immutables:
//  1. Simulate contract creation: eth_call with to=null, data = creationBytecode
//     + abi(pool, v3Router). The node runs the constructor and returns the
//     CONSTRUCTED runtime bytecode (immutables — aavePool/netSwapRouter — baked
//     in correctly). This is the exact code that would be deployed.
//  2. State-override that runtime code at a scratch address, and set storage
//     slot 0 (owner) to OWNER_ADDR so the onlyOwner gate passes.
//  3. Find a real liquidatable target from the live watchlist (HF<1, debt>=floor)
//     and resolve its collateral/debt + off-chain V3 path.
//  4. callStatic triggerLiquidationWithPath(...) from OWNER_ADDR with state
//     overrides. Success => the full flash-loan→liquidationCall→swap→repay path
//     works with the V3 router. Compare against the SAME call WITHOUT the path
//     (on-chain self-resolve) to confirm both succeed.
//
// Read-only (eth_call). No keys, no broadcast.
// Usage: CHAINS=base OWNER_ADDR=0x... node scripts/verifyPathLiquidationCallStatic.js

const fs = require("fs");
const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { resolveSwapPath, enrichCandidateBatched, getReservesListCached, resolveChainMinDebtUsd } = require("../aaveHelpers");
const { aggregate3InBatches } = require("../src/multicall");

const art = require("../artifacts/contracts/AaveLiquidatorSwapRouter02.sol/AaveLiquidatorSwapRouter02.json");
const SCRATCH = "0x00000000000000000000000000000000DeaD0001";
const POOL_ACCT_IFACE = new ethers.utils.Interface([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

function ownerSlotValue(ownerAddr) {
  return ethers.utils.hexZeroPad(ethers.utils.getAddress(ownerAddr).toLowerCase(), 32);
}

async function constructedRuntimeCode(provider, poolAddr, routerAddr) {
  const factory = new ethers.ContractFactory(art.abi, art.bytecode);
  const deployTx = factory.getDeployTransaction(poolAddr, routerAddr);
  // eth_call with no `to` runs the creation code (constructor) and returns the
  // runtime code with immutables resolved.
  const code = await provider.call({ data: deployTx.data });
  if (!code || code === "0x") throw new Error("constructor sim returned empty code");
  return code;
}

async function findLiquidatableTarget(cfg, provider) {
  const wl = JSON.parse(fs.readFileSync(`data/droplet/watchlist-${cfg.key}.json`, "utf8"));
  const users = (wl.watch || []).slice(0, parseInt(process.env.SCAN_LIMIT || "1200", 10));
  const floorUsd = resolveChainMinDebtUsd(cfg);
  // FAST: one Multicall3 batch of getUserAccountData over the whole watchlist to
  // find HF<1 + debt>=floor candidates, then enrich only those (serial RPC only
  // for the handful that qualify).
  const calls = users.map((u) => ({
    target: cfg.pool, allowFailure: true,
    callData: POOL_ACCT_IFACE.encodeFunctionData("getUserAccountData", [u]),
  }));
  const raw = await aggregate3InBatches(provider, calls, 300);
  const reserves = await getReservesListCached(provider, cfg);
  const candidates = [];
  for (let i = 0; i < users.length; i++) {
    const e = raw[i];
    if (!e || !e.success || !e.returnData || e.returnData === "0x") continue;
    let d; try { d = POOL_ACCT_IFACE.decodeFunctionResult("getUserAccountData", e.returnData); } catch (_) { continue; }
    const hf = parseFloat(ethers.utils.formatUnits(d.healthFactor, 18));
    const debtUsd = parseFloat(ethers.utils.formatUnits(d.totalDebtBase, 8));
    if (hf > 0 && hf < 1.0 && debtUsd >= floorUsd) candidates.push({ user: users[i], hf, debtUsd });
  }
  candidates.sort((a, b) => a.hf - b.hf); // lowest HF first
  console.log(`  watchlist scanned=${users.length}, HF<1 & debt>=$${floorUsd}: ${candidates.length}`);
  for (const cand of candidates) {
    const enr = await enrichCandidateBatched(cand.user, provider, cfg, reserves);
    if (!enr) continue;
    if (enr.collateralAsset.toLowerCase() === enr.debtAsset.toLowerCase()) continue;
    const path = await resolveSwapPath(provider, cfg, enr.collateralAsset, enr.debtAsset);
    return { ...cand, ...enr, path };
  }
  return null;
}

async function callStaticTrigger(provider, code, ownerAddr, args, withPath) {
  const iface = new ethers.utils.Interface(art.abi);
  const data = withPath
    ? iface.encodeFunctionData("triggerLiquidationWithPath", [args.debtAsset, args.debtToCover, args.user, args.collateralAsset, 0, args.path])
    : iface.encodeFunctionData("triggerLiquidation", [args.debtAsset, args.debtToCover, args.user, args.collateralAsset]);
  const overrides = {
    [SCRATCH]: { code, stateDiff: { "0x0000000000000000000000000000000000000000000000000000000000000000": ownerSlotValue(ownerAddr) } },
  };
  try {
    await provider.send("eth_call", [{ from: ownerAddr, to: SCRATCH, data }, "latest", overrides]);
    return { ok: true };
  } catch (e) {
    const msg = (e.error && e.error.message) || e.data || e.message || "revert";
    return { ok: false, reason: String(msg).slice(0, 200) };
  }
}

async function main() {
  const ownerAddr = process.env.OWNER_ADDR;
  if (!ownerAddr) throw new Error("set OWNER_ADDR=<bot wallet> (the contract owner that would send liquidations)");
  for (const cfg of getSelectedChainConfigs()) {
    const provider = new ethers.providers.JsonRpcProvider(cfg.rpcUrl);
    console.log(`\n================ ${cfg.key} ================`);
    console.log(`  V3 router (chains.js): ${cfg.swapRouter}`);
    let code;
    try { code = await constructedRuntimeCode(provider, cfg.pool, cfg.swapRouter); }
    catch (e) { console.log(`  ❌ could not build constructed code: ${e.message}`); continue; }
    console.log(`  constructed runtime code: ${code.length} hex chars`);

    const target = await findLiquidatableTarget(cfg, provider);
    if (!target) { console.log(`  ⚠️ no currently-liquidatable (HF<1, debt>=floor) watchlist target found to test`); continue; }
    const debtToCover = target.debtAmount; // full debt; contract handles close factor at liquidationCall
    console.log(`  target ${target.user} HF=${target.hf.toFixed(4)} debt≈$${target.debtUsd.toFixed(2)}`);
    console.log(`    ${target.debtSymbol} debt, collateral ${target.collateralAsset.slice(0,10)}, path ${target.path === "0x" ? "0x(self-resolve)" : target.path.slice(0,24)+"…"}`);

    const args = { debtAsset: target.debtAsset, debtToCover, user: target.user, collateralAsset: target.collateralAsset, path: target.path };
    const noPath = await callStaticTrigger(provider, code, ownerAddr, args, false);
    console.log(`  callStatic triggerLiquidation (on-chain resolve): ${noPath.ok ? "✅ OK" : "❌ " + noPath.reason}`);
    if (target.path !== "0x") {
      const withPath = await callStaticTrigger(provider, code, ownerAddr, args, true);
      console.log(`  callStatic triggerLiquidationWithPath (3.3):     ${withPath.ok ? "✅ OK" : "❌ " + withPath.reason}`);
    }
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
