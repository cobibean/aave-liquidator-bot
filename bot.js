require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const {
  getUnhealthyPositions,
  getUserHealthFactor,
  getUserHealthFactorsBatched,
  enrichCandidateBatched,
  getReservesListCached,
  resolveChainMinDebtUsd,
  resolveSwapPath,
  mapWithConcurrency,
} = require("./aaveHelpers");
const { getSelectedChainConfigs } = require("./src/chains");
const { getTransactionOverrides } = require("./src/gas");
const { createProvider, createBlockProvider } = require("./src/provider");
const { loadHot } = require("./src/borrowerStore");
const { NonceManager, maxInFlight } = require("./src/nonceManager");
const { compactRevertReason } = require("./src/aaveErrorDecoder");
const metrics = require("./src/metrics");

const requiredEnv = ["PRIVATE_KEY"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnv.join(", ")}`);
}

const testMode = process.env.TEST_MODE !== "false";
const chainConfigs = getSelectedChainConfigs();

// Load the hardened liquidator ABI (superset: includes triggerLiquidation,
// triggerLiquidationWithMinProfit, minProfit, etc.). All currently-deployed
// contracts expose at least the 4-arg triggerLiquidation; hardened chains
// (chainConfig.hardenedLiquidator) also support the per-call profit floor.
const liquidatorArtifact = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "artifacts/contracts/AaveLiquidatorSwapRouter02.sol/AaveLiquidatorSwapRouter02.json"),
    "utf-8"
  )
);
const aaveLiquidatorABI = liquidatorArtifact.abi;

const AAVE_ORACLE_ABI = ["function getAssetPrice(address asset) view returns (uint256)"];

// Short-TTL cache for Aave oracle prices (native + debt asset), per chain+asset.
// Chainlink feeds move on heartbeats (minutes) + deviation thresholds, so a few
// seconds of staleness is safe and removes 2 oracle reads from nearly every
// liquidation attempt in a burst. Default 5s; tune with ORACLE_PRICE_TTL_MS.
const oraclePriceCache = new Map(); // `${chainKey}:${asset}` -> { price, fetchedAt }
const ORACLE_PRICE_TTL_MS = parseInt(process.env.ORACLE_PRICE_TTL_MS || "5000", 10);
const lastTriggerScanLogAt = new Map();
const precheckFailureUntil = new Map();
// Users whose precheck failed with MustNotLeaveDust while HF was still above
// Aave's full-close threshold (the "dead zone"): a partial leaves dust and a
// full close isn't permitted yet, so NOBODY can liquidate them until HF drops
// below the threshold. We park them on a long (structural) backoff and re-arm
// them the instant a fresh sweep HF crosses below the threshold. Map value is
// the HF we last saw them armed at (for logging / debugging only).
const precheckArmedDeadzone = new Map();

function shouldLogTriggerScan(chainKey, foundLiquidatable) {
  if (foundLiquidatable) return true;
  const intervalMs = parseInt(process.env.TRIGGER_SCAN_LOG_INTERVAL_MS || "60000", 10);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false;
  const now = Date.now();
  const last = lastTriggerScanLogAt.get(chainKey) || 0;
  if (now - last < intervalMs) return false;
  lastTriggerScanLogAt.set(chainKey, now);
  return true;
}

// Backoff after a precheck fail. TRANSIENT (price wobble, momentary heal,
// profit-floor miss) may flip to winnable on the very next sweep, so it gets a
// short window. STRUCTURAL fails (healthy HF, zero debt, dust dead zone) cannot
// become winnable without a material on-chain state change, so re-simulating
// them every 30s just burns CPU + RPC — they get a long window instead. This is
// the fix for the overnight spin (1,433/1,856 precheck_fails were one of three
// structurally-doomed positions retried every 30s).
function precheckCooldownMs(kind) {
  const envName = kind === "structural"
    ? "PRECHECK_STRUCTURAL_COOLDOWN_MS"
    : "PRECHECK_FAIL_COOLDOWN_MS";
  const fallback = kind === "structural" ? "1800000" : "30000"; // 30min vs 30s
  const value = parseInt(process.env[envName] || fallback, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function precheckCooldownKey(chainKey, user) {
  return `${chainKey || "default"}:${String(user).toLowerCase()}`;
}

function isPrecheckCoolingDown(chainKey, user) {
  const until = precheckFailureUntil.get(precheckCooldownKey(chainKey, user)) || 0;
  if (until <= Date.now()) return false;
  return true;
}

function rememberPrecheckFailure(chainKey, user, kind = "transient") {
  const ms = precheckCooldownMs(kind);
  if (ms > 0) precheckFailureUntil.set(precheckCooldownKey(chainKey, user), Date.now() + ms);
}

function clearPrecheckFailure(chainKey, user) {
  const key = precheckCooldownKey(chainKey, user);
  precheckFailureUntil.delete(key);
  precheckArmedDeadzone.delete(key);
}

// Classify a precheck failure so we can pick the right backoff. STRUCTURAL =
// cannot win without a state change (healthy, no debt, or dust dead zone).
// Everything else is TRANSIENT. `hf` is the sweep-measured health factor.
function classifyPrecheckFailure(reason, hf) {
  const r = String(reason || "").toLowerCase();
  // Healed / never was unhealthy.
  if (Number.isFinite(hf) && hf > 1.0) return "structural";
  if (r.includes("healthfactornotbelowthreshold")) return "structural";
  // Nothing to liquidate.
  if (r.includes("no collateral received") || r.includes("debt below")) return "structural";
  // Dust dead zone: a partial leaves dust and full-close isn't allowed until HF
  // crosses the close-factor threshold. Unwinnable by anyone until then.
  if (r.includes("mustnotleavedust") && Number.isFinite(hf) && hf > closeFactorHfThreshold()) {
    return "structural";
  }
  return "transient";
}

// Aave's full-close (100%) health-factor threshold. Below it a single
// liquidationCall may take the entire debt (bypassing the dust check); above
// it Aave caps a call at the 50% default close factor. Reuse the same env that
// drives the partial-vs-full ladder decision so they never disagree.
function closeFactorHfThreshold() {
  const v = parseFloat(process.env.CLOSE_FACTOR_HF_THRESHOLD || "0.95");
  return Number.isFinite(v) ? v : 0.95;
}

function normalizeLiquidationBaskets(position) {
  const primary = {
    debtAsset: position.debtAsset,
    debtAmount: position.debtAmount,
    debtDecimals: position.debtDecimals || 18,
    debtSymbol: position.debtSymbol || "debt asset",
    collateralAsset: position.collateralAsset,
    basketLabel: position.basketLabel || "primary",
  };
  const raw = Array.isArray(position.liquidationBaskets) && position.liquidationBaskets.length > 0
    ? position.liquidationBaskets
    : [primary];
  const seen = new Set();
  const baskets = [];
  for (const basket of [...raw, primary]) {
    if (!basket || !basket.debtAsset || !basket.collateralAsset) continue;
    if (!ethers.BigNumber.isBigNumber(basket.debtAmount) || basket.debtAmount.lte(ethers.constants.Zero)) continue;
    const key = `${basket.debtAsset.toLowerCase()}:${basket.collateralAsset.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    baskets.push({
      debtAsset: basket.debtAsset,
      debtAmount: basket.debtAmount,
      debtDecimals: basket.debtDecimals || primary.debtDecimals,
      debtSymbol: basket.debtSymbol || primary.debtSymbol,
      collateralAsset: basket.collateralAsset,
      basketLabel: basket.basketLabel || `${basket.debtSymbol || primary.debtSymbol}->${basket.collateralAsset.slice(0, 8)}`,
    });
  }
  return baskets;
}

async function getOraclePriceCached(oracle, chainKey, asset) {
  const key = `${chainKey}:${String(asset).toLowerCase()}`;
  const cached = oraclePriceCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ORACLE_PRICE_TTL_MS) {
    return cached.price;
  }
  const price = await oracle.getAssetPrice(asset);
  oraclePriceCache.set(key, { price, fetchedAt: Date.now() });
  return price;
}

// Computes a gas-aware minimum-profit floor in the debt asset's smallest units.
// floor = gasCost(native) × nativeUsd / debtUsd × safetyMultiple, then + a small
// fixed USD margin. Prices come from the Aave oracle (USD, 8 decimals) so no
// extra price dependency. Returns a BigNumber (debt-asset units), or null if it
// can't be computed (caller falls back to the contract's stored minProfit).
async function computeMinProfitUnits({ provider, chainConfig, debtDecimals, estGasUnits, gasPrice }) {
  try {
    if (!chainConfig.priceOracle || !chainConfig.wrappedNative) return null;
    const oracle = new ethers.Contract(chainConfig.priceOracle, AAVE_ORACLE_ABI, provider);
    const chainKey = chainConfig.key || "default";
    const [nativeUsd, debtUsd] = await Promise.all([
      getOraclePriceCached(oracle, chainKey, chainConfig.wrappedNative),
      getOraclePriceCached(oracle, chainKey, chainConfig.debtAssetAddress),
    ]);
    if (debtUsd.isZero()) return null;

    const safetyX100 = Math.round(parseFloat(process.env.PROFIT_SAFETY_MULTIPLE || "2") * 100);
    const marginUsd = parseFloat(process.env.MIN_PROFIT_USD || "1");

    // gasCostUsd8 = gasUnits × gasPrice(wei) × nativeUsd(8dp) / 1e18  (result in 8dp USD)
    const gasCostUsd8 = estGasUnits.mul(gasPrice).mul(nativeUsd).div(ethers.constants.WeiPerEther);
    // Convert 8dp-USD → debt units: × 10^debtDecimals / debtUsd(8dp)
    const tenPowDebt = ethers.BigNumber.from(10).pow(debtDecimals);
    const gasFloorUnits = gasCostUsd8.mul(tenPowDebt).mul(safetyX100).div(100).div(debtUsd);
    const marginUnits = ethers.utils.parseUnits(marginUsd.toString(), debtDecimals);

    return gasFloorUnits.add(marginUnits);
  } catch (_) {
    return null;
  }
}

async function main() {
  console.log(`🚀 Starting Aave Liquidator Bot on ${chainConfigs.map((chain) => chain.name).join(", ")}...`);
  if (testMode) {
    console.log("TEST_MODE is enabled. Liquidations will be logged but not submitted.");
  }

  await Promise.all(chainConfigs.map(runChainBot));
}

async function runChainBot(chainConfig) {
  const provider = createProvider(chainConfig);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const liquidatorAddress = getLiquidatorAddress(chainConfig);
  const aaveLiquidatorContract = liquidatorAddress
    ? new ethers.Contract(liquidatorAddress, aaveLiquidatorABI, wallet)
    : null;

  console.log(`▶️ ${chainConfig.name}: wallet ${wallet.address}`);
  if (!aaveLiquidatorContract) {
    console.warn(`⚠️ ${chainConfig.name}: AAVE_LIQUIDATOR_ADDRESS is not set for this chain.`);
  }

  // Shared per-chain mutex. Both the periodic poll (full/warm/cold sweeps that
  // maintain the watchlist) and the per-block watchlist re-check submit txs and
  // hit the same RPC, so they must never run concurrently on one chain — that
  // could double-submit the same liquidation or stampede the nonce. Whichever
  // grabs the flag first runs; the other skips this tick.
  // One nonce manager per chain/process (3.2): assigns nonces locally so we don't
  // pay a getTransactionCount round-trip per send, and so back-to-back sends to
  // same-block targets don't collide. Only meaningful when a contract+wallet exist.
  const nonceManager = aaveLiquidatorContract ? new NonceManager(wallet, chainConfig.key) : null;
  const ctx = { provider, chainConfig, aaveLiquidatorContract, nonceManager };
  const lock = { inFlight: false };

  // Each cycle does an incremental Borrow scan + a parallel HF sweep, so it is
  // cheap enough to run frequently. The first cycle pays a one-time backfill.
  const cycleMs = parseInt(process.env.SCAN_INTERVAL_MS || "15000", 10);

  // Event-driven triggers (Batch 1.1 + Phase 4). Both re-check ONLY the
  // near-threshold watchlist (cheap), under the shared `lock`, so a position
  // crossing HF<1 is acted on near-instantly instead of up to SCAN_INTERVAL_MS
  // later. The slow poll below keeps maintaining the watchlist. A single WS
  // provider (if a <CHAIN>_WS_URL is configured) is shared by both triggers so
  // we open at most one socket per chain.
  const wantBlockTrigger = process.env.BLOCK_TRIGGER === "true";
  const wantPriceTrigger = process.env.PRICE_TRIGGER === "true" && !!chainConfig.collateralPriceFeed;
  const eventProvider =
    wantBlockTrigger || wantPriceTrigger ? createBlockProvider(chainConfig) || provider : null;
  const usingWs = eventProvider && eventProvider !== provider;

  // Shared watchlist-check runner: whichever trigger fires first grabs the lock;
  // the other skips (the watchlist is the same, so a concurrent re-check is pure
  // waste and risks a double-submit / nonce stampede).
  const triggerWatchlistCheck = async (label, hint) => {
    if (lock.inFlight) return; // a poll or prior trigger is still running
    lock.inFlight = true;
    try {
      await runWatchlistCheck(ctx, hint);
    } catch (error) {
      console.error(`❌ ${chainConfig.name}: ${label} error:`, error.message);
    } finally {
      lock.inFlight = false;
    }
  };

  // 1.1 — per-block watchlist re-check.
  if (wantBlockTrigger) {
    console.log(`🔔 ${chainConfig.name}: per-block watchlist trigger ON (${usingWs ? "WebSocket push" : "HTTP polling"}).`);
    eventProvider.on("block", (blockNumber) => triggerWatchlistCheck(`block-trigger (block ${blockNumber})`, blockNumber));
  }

  // Phase 4 — Chainlink price-update trigger. The Aave oracle source for the
  // volatile collateral (ETH/AVAX/XPL /USD) is a Chainlink proxy; its underlying
  // aggregator emits AnswerUpdated when the price moves — which is the actual
  // cause of an HF dropping below 1. Reacting to that event (rather than only the
  // next block tick) shaves latency and tells us a price just moved, so we
  // re-check the watchlist immediately. WS push where available (free on Alchemy);
  // Plasma (no WS) leans on its per-block trigger instead — we skip the price
  // subscription there since a WS-less aggregator poll would just duplicate it.
  if (wantPriceTrigger) {
    if (!usingWs) {
      console.log(`📈 ${chainConfig.name}: PRICE_TRIGGER requested but no WS endpoint — relying on per-block trigger instead (no separate price subscription).`);
    } else {
      try {
        // The proxy address is stable; resolve the current underlying aggregator
        // (the contract that actually emits AnswerUpdated) at startup.
        const proxy = new ethers.Contract(
          chainConfig.collateralPriceFeed,
          ["function aggregator() view returns (address)", "function description() view returns (string)"],
          eventProvider
        );
        const aggregatorAddr = await proxy.aggregator();
        let desc = "";
        try { desc = await proxy.description(); } catch (_) {}
        const ANSWER_UPDATED = "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)";
        const aggregator = new ethers.Contract(aggregatorAddr, [ANSWER_UPDATED], eventProvider);
        console.log(`📈 ${chainConfig.name}: price-update trigger ON (Chainlink ${desc || "feed"} ${aggregatorAddr}, WebSocket push).`);
        aggregator.on("AnswerUpdated", (current, roundId) =>
          triggerWatchlistCheck(`price-trigger (round ${roundId?.toString?.() || "?"})`, undefined)
        );
      } catch (error) {
        console.error(`❌ ${chainConfig.name}: failed to set up price trigger:`, error.message);
      }
    }
  }

  while (true) {
    const cycleStart = Date.now();
    if (lock.inFlight) {
      // A block-trigger check is mid-flight; skip this poll tick rather than
      // run concurrently. Try again next interval.
      await delay(Math.max(cycleMs, 1000));
      continue;
    }
    lock.inFlight = true;
    try {
      const opportunities = await getUnhealthyPositions(provider, chainConfig);
      console.log(`📌 ${chainConfig.name}: Found ${opportunities.length} liquidatable positions (cycle ${Date.now() - cycleStart}ms).`);

      for (const position of opportunities) {
        await attemptLiquidation(position, ctx);
      }
    } catch (error) {
      console.error(`❌ ${chainConfig.name}: Error in main loop:`, error.message);
    } finally {
      lock.inFlight = false;
    }

    // Keep a steady cadence regardless of how long the cycle took.
    const elapsed = Date.now() - cycleStart;
    await delay(Math.max(cycleMs - elapsed, 1000));
  }
}

// Per-block hot path: re-check ONLY the persisted hot tier (HF close to 1,
// non-dust wallets the sweep already identified). This is intentionally tiny and
// fast — a single Multicall3 read of tens/hundreds of addresses —
// so it can run every block. Anything that crosses HF<1 here is enriched (one
// batched read each, concurrently) and attempted immediately. The full/warm/cold
// sweeps in the poll loop are what keep the hot tier populated; this only reacts.
async function runWatchlistCheck({ provider, chainConfig, aaveLiquidatorContract, nonceManager }, blockNumber) {
  const chainKey = chainConfig.key || "default";
  const { hot } = loadHot(chainKey);
  if (!hot || hot.size === 0) return;

  // Source tag for logs: a block number (per-block trigger) or "price-update"
  // (Chainlink AnswerUpdated trigger, which passes no block number).
  const at = blockNumber != null ? `block ${blockNumber}` : "price-update";
  const threshold = parseFloat(process.env.LIQUIDATION_THRESHOLD || "1.0");
  const minDebtUsd = resolveChainMinDebtUsd(chainConfig);

  const t0 = Date.now();
  const hfs = await getUserHealthFactorsBatched([...hot], provider, chainConfig);
  const liq = hfs
    .filter((h) => Number.isFinite(h.healthFactor) && h.healthFactor < threshold && h.totalDebtUsd >= minDebtUsd)
    .sort((a, b) => a.healthFactor - b.healthFactor);
  const scanMs = Date.now() - t0;
  if (shouldLogTriggerScan(chainKey, liq.length > 0)) {
    metrics.emit("trigger_scan", {
      chain: chainKey,
      source: blockNumber != null ? "block" : "price",
      block: blockNumber,
      hot: hot.size,
      scanMs,
      below: liq.length,
    });
  }

  if (liq.length === 0) {
    if (process.env.VERBOSE_HEALTH_LOGS === "true") {
      console.log(`   ⛓️ ${chainConfig.name}: ${at} hot ${hot.size} clean (${scanMs}ms).`);
    }
    return;
  }

  console.log(`🔔 ${chainConfig.name}: ${at} — ${liq.length} hot position(s) below ${threshold} (${scanMs}ms).`);

  // Enrich the urgent ones concurrently (each a single batched read), then
  // attempt in lowest-HF-first order. attemptLiquidation honors TEST_MODE.
  const reserves = chainConfig.protocolDataProvider
    ? await getReservesListCached(provider, chainConfig)
    : [];
  const minDebtToCover = parseFloat(process.env.MIN_DEBT_TO_COVER || "0.099");

  const enrichConcurrency = parseInt(process.env.TRIGGER_ENRICH_CONCURRENCY || "10", 10);
  const enriched = await mapWithConcurrency(liq, enrichConcurrency, async ({ user, healthFactor, totalDebtUsd }) => {
    let position;
    try {
      position = await enrichCandidateBatched(user, provider, chainConfig, reserves);
    } catch (error) {
      console.warn(`⚠️ ${chainConfig.name}: enrichment failed for ${user}: ${error.message}`);
      return null;
    }
    if (!position) return null;

    const debtInUnits = parseFloat(ethers.utils.formatUnits(position.debtAmount, position.debtDecimals));
    if (debtInUnits < minDebtToCover) return null;

    return { ...position, user, healthFactor, totalDebtUsd };
  });

  for (const position of enriched.filter(Boolean)) {
    await attemptLiquidation(
      position,
      { provider, chainConfig, aaveLiquidatorContract, nonceManager }
    );
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Simulates a liquidation without sending a transaction. Returns
// { ok, reason, estGasCostNative }. ok=false means the tx would revert (skip it).
// This is the bot-side half of the profitability gate; the hardened contract's
// minProfit floor is the on-chain half. Works against both the current and
// hardened contract (both expose triggerLiquidation with the same signature).
async function simulateLiquidation(contract, {
  debtAsset,
  debtToCover,
  user,
  collateralAsset,
  provider,
  chainConfig,
  gasPrice,
  swapPath,
  minProfitForCall,
}) {
  // Mirror the entrypoint we'll actually broadcast so the callStatic gate is a
  // true freshness/profitability check. On path-aware chains with a resolved
  // path, simulate triggerLiquidationWithPath with the same dynamic floor as
  // send; floor 0 still leaves the contract's stored floor in force.
  const profitFloor = minProfitForCall || ethers.constants.Zero;
  const usePath = !!swapPath && swapPath !== "0x" && chainConfig.pathAware &&
    contract.callStatic.triggerLiquidationWithPath;
  try {
    if (usePath) {
      await contract.callStatic.triggerLiquidationWithPath(
        debtAsset, debtToCover, user, collateralAsset, profitFloor, swapPath
      );
    } else if (chainConfig.hardenedLiquidator && minProfitForCall && contract.callStatic.triggerLiquidationWithMinProfit) {
      await contract.callStatic.triggerLiquidationWithMinProfit(
        debtAsset, debtToCover, user, collateralAsset, minProfitForCall
      );
    } else {
      await contract.callStatic.triggerLiquidation(debtAsset, debtToCover, user, collateralAsset);
    }
  } catch (error) {
    const reason = compactRevertReason(error);
    return { ok: false, reason: String(reason).slice(0, 160) };
  }

  // Best-effort gas estimate so we can log/compare cost. Non-fatal if it fails.
  // Reuse the caller's gas price when provided (one round-trip for the whole
  // submit path instead of re-fetching it here).
  let estGasCostNative = null;
  try {
    let gasEstimatePromise;
    if (usePath) {
      gasEstimatePromise = contract.estimateGas.triggerLiquidationWithPath(
        debtAsset, debtToCover, user, collateralAsset, profitFloor, swapPath
      );
    } else if (chainConfig.hardenedLiquidator && minProfitForCall && contract.estimateGas.triggerLiquidationWithMinProfit) {
      gasEstimatePromise = contract.estimateGas.triggerLiquidationWithMinProfit(
        debtAsset, debtToCover, user, collateralAsset, minProfitForCall
      );
    } else {
      gasEstimatePromise = contract.estimateGas.triggerLiquidation(debtAsset, debtToCover, user, collateralAsset);
    }

    const [gasEstimate, livePrice] = await Promise.all([
      gasEstimatePromise,
      gasPrice ? Promise.resolve(gasPrice) : provider.getGasPrice(),
    ]);
    estGasCostNative = ethers.utils.formatEther(gasEstimate.mul(livePrice));
  } catch (_) {
    // estimateGas can fail even when callStatic passes (e.g. gas heuristics);
    // don't block on it — the callStatic success is the real gate.
  }

  return { ok: true, reason: "ok", estGasCostNative };
}

function pushDebtToCoverOption(options, seen, label, amount, debtDecimals, minDebtToCoverRaw) {
  if (!amount || !ethers.BigNumber.isBigNumber(amount) || amount.lte(ethers.constants.Zero)) return;
  if (minDebtToCoverRaw && amount.lt(minDebtToCoverRaw)) return;
  const key = amount.toString();
  if (seen.has(key)) return;
  seen.add(key);
  options.push({
    label,
    amount,
    display: ethers.utils.formatUnits(amount, debtDecimals),
  });
}

function buildDebtToCoverOptions({ debtAmount, debtDecimals, healthFactor }) {
  const options = [];
  const seen = new Set();
  let minDebtToCoverRaw = null;
  try {
    minDebtToCoverRaw = ethers.utils.parseUnits(process.env.MIN_DEBT_TO_COVER || "0.099", debtDecimals);
  } catch (_) {
    minDebtToCoverRaw = null;
  }

  const closeFactorThreshold = closeFactorHfThreshold();
  if (Number.isFinite(healthFactor) && healthFactor > closeFactorThreshold) {
    pushDebtToCoverOption(options, seen, "partial-50", debtAmount.div(2), debtDecimals, minDebtToCoverRaw);
  }

  // Aave v3-origin may reject a nominal 50% partial with MustNotLeaveDust. A
  // near-full amount is still capped by Aave's close factor when full close is
  // not allowed, but it lets small/dust-sensitive positions clear when allowed.
  pushDebtToCoverOption(options, seen, "full+1wei", debtAmount.add(1), debtDecimals, minDebtToCoverRaw);
  pushDebtToCoverOption(options, seen, "full", debtAmount, debtDecimals, minDebtToCoverRaw);
  pushDebtToCoverOption(options, seen, "full+0.01pct", debtAmount.mul(10001).div(10000), debtDecimals, minDebtToCoverRaw);
  pushDebtToCoverOption(options, seen, "partial-25", debtAmount.div(4), debtDecimals, minDebtToCoverRaw);
  pushDebtToCoverOption(options, seen, "partial-10", debtAmount.div(10), debtDecimals, minDebtToCoverRaw);
  pushDebtToCoverOption(options, seen, "partial-5", debtAmount.div(20), debtDecimals, minDebtToCoverRaw);

  try {
    pushDebtToCoverOption(options, seen, "one-unit", ethers.utils.parseUnits("1", debtDecimals), debtDecimals, minDebtToCoverRaw);
  } catch (_) {
    // Ignore unusual decimal metadata; the main raw-size options still apply.
  }

  return options;
}

async function selectLiquidationVariant({
  contract,
  debtAsset,
  debtAmount,
  debtDecimals,
  debtSymbol,
  user,
  collateralAsset,
  provider,
  chainConfig,
  healthFactor,
  gasPrice,
  swapPath,
  minProfitForCall,
}) {
  const options = buildDebtToCoverOptions({ debtAmount, debtDecimals, healthFactor });
  const failures = [];

  for (const option of options) {
    const check = await simulateLiquidation(contract, {
      debtAsset,
      debtToCover: option.amount,
      user,
      collateralAsset,
      provider,
      chainConfig,
      gasPrice,
      swapPath,
      minProfitForCall,
    });
    if (check.ok) {
      return {
        ok: true,
        debtToCover: option.amount,
        label: option.label,
        display: `${option.display} ${debtSymbol}`,
        check,
        failures,
      };
    }
    failures.push(`${option.label}:${check.reason}`);

    // Keep trying the bounded ladder. Aave v3-origin dust checks, accrued
    // interest, collateral exhaustion, and min-profit floors can each make a
    // different size valid, so one failed over-cover should not hide exact full
    // or a smaller partial that would pass.
  }

  return {
    ok: false,
    reason: failures[0] ? failures[0].split(":").slice(1).join(":") : "no precheck variants",
    failures,
  };
}


async function attemptLiquidation(position, {
  provider,
  chainConfig,
  aaveLiquidatorContract,
  nonceManager,
}) {
  const { user, healthFactor } = position;
  const candidateBaskets = normalizeLiquidationBaskets(position);
  const primaryBasket = candidateBaskets[0];
  if (!primaryBasket) {
    console.warn(`${chainConfig.name}: No liquidation basket available for ${user}; skipping.`);
    return;
  }

  if (!testMode && isPrecheckCoolingDown(chainConfig.key, user)) {
    // Dead-zone re-arm: a position parked on the structural backoff because it
    // was dust-locked above the close-factor threshold becomes winnable the
    // instant its HF crosses below that threshold (Aave then allows a full
    // close, bypassing the dust check). The sweep already re-measured HF for us
    // (no extra RPC), so if a previously-armed user has now crossed, clear the
    // cooldown and fall through to a fresh precheck immediately.
    const cdKey = precheckCooldownKey(chainConfig.key, user);
    const crossed =
      precheckArmedDeadzone.has(cdKey) &&
      Number.isFinite(healthFactor) &&
      healthFactor < closeFactorHfThreshold();
    if (crossed) {
      console.log(
        `🎯 ${chainConfig.name}: armed dead-zone ${user} crossed HF ${healthFactor.toFixed(4)} < ${closeFactorHfThreshold()} — re-arming for full close.`
      );
      clearPrecheckFailure(chainConfig.key, user);
    } else {
      if (process.env.VERBOSE_HEALTH_LOGS === "true") {
        console.log(`⏳ ${chainConfig.name}: pre-check cooldown active for ${user}; skipping this trigger.`);
      }
      return;
    }
  }

  console.log("⚡ Attempting liquidation with:", {
    chain: chainConfig.name,
    user,
    debtAsset: primaryBasket.debtAsset,
    debtAmount: ethers.utils.formatUnits(primaryBasket.debtAmount, primaryBasket.debtDecimals),
    debtSymbol: primaryBasket.debtSymbol,
    collateralAsset: primaryBasket.collateralAsset,
    baskets: candidateBaskets.length,
  });

  // Use the health factor already measured by the sweep (passed through) instead
  // of a fresh getUserAccountData round-trip on the critical path. The callStatic
  // simulation below is the REAL freshness gate: if the position has healed or
  // become non-liquidatable since the sweep, triggerLiquidation reverts and we
  // skip without spending gas. So this HF is only used for the partial-vs-full
  // close-factor decision, where sweep-time HF is plenty accurate. Falls back to
  // a live read only if the caller didn't supply one (e.g. legacy call sites).
  const latestHealthFactor = Number.isFinite(healthFactor)
    ? healthFactor
    : await getUserHealthFactor(user, provider, chainConfig);
  console.log(`${chainConfig.name}: Health factor for ${user}: ${latestHealthFactor}`);
  if (latestHealthFactor > 1.0) {
    console.log(`⏳ Skipping ${user} (HF: ${latestHealthFactor}).`);
    return;
  }

  if (!aaveLiquidatorContract) {
    console.warn(`${chainConfig.name}: No liquidator contract configured; skipping.`);
    return;
  }

  // Bounded in-flight gate (3.2). Skip if we already have MAX_INFLIGHT_TX
  // unconfirmed txs on this chain (default 1 = old one-at-a-time behavior). This
  // is what keeps async submission from nonce-stampeding. TEST_MODE never sends,
  // so it's never gated.
  if (!testMode && nonceManager && nonceManager.atCapacity(maxInFlight())) {
    console.log(`⏸️ ${chainConfig.name}: at in-flight tx cap (${maxInFlight()}); skipping ${user} this pass.`);
    return;
  }

  // METRICS: start the "decide" stopwatch (enrich is already done by the caller;
  // this times sim + floor + send-prep up to broadcast) and record the block we're
  // acting at, so block-lag (detect→send) is visible per attempt.
  const decideT0 = metrics.now();
  let detectBlock = null;
  try { detectBlock = await provider.getBlockNumber(); } catch (_) {}

  // Fetch the live fee data ONCE for the whole submit path (gas was previously
  // fetched up to three times). getFeeData gives us both the legacy gasPrice (for
  // the cost math in computeMinProfitUnits) AND the EIP-1559 fields (base + tip)
  // that getTransactionOverrides uses to bid on inclusion priority (3.1). Thread
  // both through. Non-fatal if it fails — downstream falls back to a fresh read.
  let sharedFeeData = null;
  let sharedGasPrice = null;
  try {
    sharedFeeData = await provider.getFeeData();
    // Effective gas price for cost estimation: prefer the 1559 ceiling we'd
    // actually pay up to (maxFeePerGas), else the legacy gasPrice.
    sharedGasPrice = sharedFeeData.maxFeePerGas || sharedFeeData.gasPrice || null;
  } catch (_) {
    // leave null; helpers will fetch their own.
  }

  const precheckGasPrice = sharedGasPrice || (await provider.getGasPrice());

  // PROFITABILITY PRE-CHECK (defense-in-depth, part 1 of 2).
  // Simulate the whole flash-loan → liquidationCall → swap → repay path with
  // callStatic before spending any gas. If it reverts, the liquidation is not
  // viable right now (no swap route, insufficient collateral, already healed,
  // or — once the hardened contract is deployed — the profit floor isn't met),
  // so we skip instead of burning gas on a guaranteed-failed tx. We also run
  // this in TEST_MODE purely for observability (would it have succeeded?).
  const basketFailures = [];
  let selected = null;
  const minDebtToCover = parseFloat(process.env.MIN_DEBT_TO_COVER || "0.099");

  for (let i = 0; i < candidateBaskets.length; i++) {
    const basket = candidateBaskets[i];
    const {
      debtAsset,
      debtAmount,
      debtDecimals,
      debtSymbol,
      collateralAsset,
      basketLabel,
    } = basket;
    const debtInUnits = parseFloat(ethers.utils.formatUnits(debtAmount, debtDecimals));
    if (debtInUnits < minDebtToCover) {
      basketFailures.push(`${basketLabel}:debt below ${minDebtToCover}`);
      continue;
    }

    // Resolve the V3 swap path off-chain (3.3) for this exact collateral→debt
    // basket. "0x" / failure => contract self-resolves, so this never regresses.
    let basketSwapPath = "0x";
    if (chainConfig.pathAware && collateralAsset.toLowerCase() !== debtAsset.toLowerCase()) {
      try {
        basketSwapPath = await resolveSwapPath(provider, chainConfig, collateralAsset, debtAsset);
      } catch (_) {
        basketSwapPath = "0x";
      }
    }

    const basketMinProfitUnits = await computeMinProfitUnits({
      provider,
      chainConfig,
      debtDecimals,
      estGasUnits: ethers.BigNumber.from(chainConfig.liquidationGasLimit),
      gasPrice: precheckGasPrice,
    });

    const variant = await selectLiquidationVariant({
      contract: aaveLiquidatorContract,
      debtAsset,
      debtAmount,
      debtDecimals,
      debtSymbol,
      user,
      collateralAsset,
      provider,
      chainConfig,
      healthFactor: latestHealthFactor,
      gasPrice: precheckGasPrice,
      swapPath: basketSwapPath,
      minProfitForCall: basketMinProfitUnits,
    });

    if (variant.ok) {
      selected = {
        ...basket,
        swapPath: basketSwapPath,
        minProfitUnits: basketMinProfitUnits,
        variant,
      };
      break;
    }

    basketFailures.push(`${basketLabel}:${variant.reason}`);
    console.log(`🧺 ${chainConfig.name}: basket ${i + 1}/${candidateBaskets.length} failed for ${user} (${basketLabel}: ${variant.reason}).`);
  }

  if (!selected) {
    const reason = basketFailures[0] ? basketFailures[0].split(":").slice(1).join(":") : "no viable basket";
    const kind = classifyPrecheckFailure(reason, latestHealthFactor);
    // Arm dust dead-zone positions: genuinely liquidatable (HF < 1) but blocked
    // by MustNotLeaveDust while still above the close-factor threshold. Tag them
    // so the cooldown gate re-fires the instant their HF crosses below it.
    const dustDeadzone =
      kind === "structural" &&
      String(reason).toLowerCase().includes("mustnotleavedust") &&
      Number.isFinite(latestHealthFactor) &&
      latestHealthFactor < 1.0 &&
      latestHealthFactor > closeFactorHfThreshold();
    const cdKey = precheckCooldownKey(chainConfig.key, user);
    if (dustDeadzone) {
      precheckArmedDeadzone.set(cdKey, latestHealthFactor);
      console.log(
        `🪤 ${chainConfig.name}: armed dead-zone ${user} (HF ${latestHealthFactor.toFixed(4)} > ${closeFactorHfThreshold()}, dust-locked) — backing off until it crosses.`
      );
    }
    console.log(`🛑 ${chainConfig.name}: pre-check failed for ${user} — skipping (${reason}) [${kind}].`);
    rememberPrecheckFailure(chainConfig.key, user, kind);
    metrics.emit("attempt", {
      chain: chainConfig.key, user, hf: latestHealthFactor,
      outcome: "precheck_fail", reason, failKind: kind,
      armedDeadzone: dustDeadzone || undefined,
      variants: basketFailures.join("|").slice(0, 1000),
      decideMs: metrics.since(decideT0), detectBlock,
    });
    return;
  }
  clearPrecheckFailure(chainConfig.key, user);

  const {
    debtAsset,
    debtAmount,
    debtDecimals,
    debtSymbol,
    collateralAsset,
    swapPath,
    minProfitUnits,
    variant,
  } = selected;
  const debtToCover = variant.debtToCover;
  const profitCheck = variant.check;
  console.log(
    `✅ ${chainConfig.name}: pre-check passed for ${user} using ${selected.basketLabel}/${variant.label} (${variant.display})` +
      (profitCheck.estGasCostNative ? ` (est gas ~${profitCheck.estGasCostNative} ${chainConfig.nativeToken})` : "")
  );

  if (testMode) {
    const previewFloor = minProfitUnits;
    console.log("TEST_MODE enabled: pre-check passed but skipping submission.", {
      chain: chainConfig.name,
      user,
      debtToCover: ethers.utils.formatUnits(debtToCover, debtDecimals) + " " + debtSymbol,
      minProfitFloor: previewFloor ? ethers.utils.formatUnits(previewFloor, debtDecimals) + " " + debtSymbol : "n/a",
      hardenedContract: !!chainConfig.hardenedLiquidator,
    });
    // Records that the WHOLE pipeline (detect→decide→callStatic) would have
    // succeeded — the key signal in TEST_MODE that we'd have fired on a real target.
    metrics.emit("attempt", {
      chain: chainConfig.key, user, hf: latestHealthFactor,
      outcome: "testmode_ok", decideMs: metrics.since(decideT0), detectBlock,
      estGasNative: profitCheck.estGasCostNative, pathAware: !!chainConfig.pathAware,
    });
    return;
  }

  try {
    const overrides = await getTransactionOverrides(provider, chainConfig, {
      gasLimit: chainConfig.liquidationGasLimit,
      feeData: sharedFeeData,   // EIP-1559 bid (3.1); helper falls back to legacy if absent
      gasPrice: sharedGasPrice, // legacy fallback; reuse the single fetch
    });

    // Reserve a nonce locally (3.2) so we don't round-trip getTransactionCount on
    // the hot path and so concurrent sends to same-block targets get distinct
    // nonces. We acquire the in-flight slot right before broadcast.
    if (nonceManager) {
      overrides.nonce = await nonceManager.reserve();
    }

    // Compute a gas-aware profit floor and pass it on hardened chains. The
    // contract enforces max(thisFloor, storedMinProfit) and reverts if a bad
    // (e.g. sandwiched) swap can't clear it — so unprofitable liquidations cost
    // nothing beyond the failed-tx gas, and we never sell the bonus at a loss.
    // Cost the floor against the gas price we'd actually pay: the 1559 ceiling
    // (overrides.maxFeePerGas) or the legacy gasPrice, else the shared fetch.
    // A function so we can pick the right entrypoint once and reuse it.
    const broadcast = () => {
      // Path-aware (3.3): pass the off-chain-resolved V3 path so the contract
      // skips on-chain getPool discovery. Only on chains whose deployed contract
      // supports it (pathAware) and when we actually resolved a path; else fall
      // through to the min-profit / 4-arg entrypoints below (empty path == old).
      if (
        chainConfig.pathAware &&
        swapPath && swapPath !== "0x" &&
        aaveLiquidatorContract.triggerLiquidationWithPath
      ) {
        const floorForSend = minProfitUnits || ethers.constants.Zero;
        const floorLabel = minProfitUnits
          ? ethers.utils.formatUnits(minProfitUnits, debtDecimals)
          : "contract-stored";
        console.log(`   ${chainConfig.name}: min-profit floor ${floorLabel} ${debtSymbol} (path-in-calldata)`);
        return aaveLiquidatorContract.triggerLiquidationWithPath(
          debtAsset, debtToCover, user, collateralAsset, floorForSend, swapPath, overrides
        );
      }
      if (chainConfig.hardenedLiquidator && minProfitUnits && aaveLiquidatorContract.triggerLiquidationWithMinProfit) {
        console.log(`   ${chainConfig.name}: min-profit floor ${ethers.utils.formatUnits(minProfitUnits, debtDecimals)} ${debtSymbol}`);
        return aaveLiquidatorContract.triggerLiquidationWithMinProfit(
          debtAsset, debtToCover, user, collateralAsset, minProfitUnits, overrides
        );
      }
      // Arbitrum (old contract) or floor-compute failed: 4-arg path uses the
      // contract's stored minProfit floor.
      return aaveLiquidatorContract.triggerLiquidation(
        debtAsset, debtToCover, user, collateralAsset, overrides
      );
    };

    // Occupy an in-flight slot for the whole submit→confirm lifetime; released
    // when the receipt resolves (sync or async).
    if (nonceManager) nonceManager.acquire();
    let slotReleased = false;
    const releaseSlot = () => {
      if (!slotReleased && nonceManager) { nonceManager.release(); slotReleased = true; }
    };

    // METRICS: decide phase ends at broadcast; deliver phase = broadcast→receipt.
    const decideMs = metrics.since(decideT0);
    const deliverT0 = metrics.now();

    let tx;
    try {
      tx = await broadcast(); // resolves once the tx is broadcast (hash assigned)
    } catch (sendErr) {
      // Broadcast failed: the reserved nonce was NOT consumed, so resync from the
      // chain to avoid a permanent gap, release the slot, and rethrow to the outer
      // handler for logging.
      releaseSlot();
      if (nonceManager) await nonceManager.resync();
      metrics.emit("attempt", {
        chain: chainConfig.key, user, hf: latestHealthFactor, outcome: "send_error",
        reason: sendErr.message, decideMs, detectBlock,
      });
      throw sendErr;
    }

    console.log(`✅ TX sent: ${tx.hash}${overrides.nonce !== undefined ? ` (nonce ${overrides.nonce})` : ""}`);
    metrics.emit("attempt", {
      chain: chainConfig.key, user, hf: latestHealthFactor, outcome: "sent",
      tx: tx.hash, nonce: overrides.nonce, decideMs, detectBlock,
      pathAware: !!chainConfig.pathAware,
      prioGwei: overrides.maxPriorityFeePerGas ? ethers.utils.formatUnits(overrides.maxPriorityFeePerGas, "gwei") : undefined,
    });

    // Confirmation. Default: block on the receipt (the proven path). With
    // ASYNC_SEND=true: don't block — confirm out-of-band so the caller can move
    // to the next same-block target immediately. Either way the in-flight slot is
    // released and, on a confirmation error, the nonce is resynced.
    const confirm = tx
      .wait()
      .then((receipt) => {
        const deliverMs = metrics.since(deliverT0);
        if (receipt.status === 1) {
          console.log(`🎉 Successful liquidation: ${tx.hash}`);
          metrics.emit("attempt", {
            chain: chainConfig.key, user, hf: latestHealthFactor, outcome: "mined",
            tx: tx.hash, deliverMs, detectBlock, minedBlock: receipt.blockNumber,
            blockLag: detectBlock != null ? receipt.blockNumber - detectBlock : undefined,
            gasUsed: receipt.gasUsed && receipt.gasUsed.toString(),
          });
        } else {
          // We only reach the send path after a passing callStatic precheck, so
          // an on-chain revert here is a precheck→mine staleness loss (position
          // healed / state moved in the ~block between sim and inclusion), NOT a
          // bad gate. Tag it so the staleness rate is greppable; per the Issue-2
          // decision we accept these rather than re-simming before broadcast.
          console.warn(`⚠️ Liquidation TX reverted on-chain (precheck-pass staleness): ${tx.hash}`);
          metrics.emit("attempt", {
            chain: chainConfig.key, user, hf: latestHealthFactor, outcome: "reverted",
            staleness: true, afterPrecheckPass: true,
            tx: tx.hash, deliverMs, detectBlock, minedBlock: receipt.blockNumber,
          });
        }
      })
      .catch(async (waitErr) => {
        const deliverMs = metrics.since(deliverT0);
        if (waitErr.code === "TRANSACTION_REPLACED") {
          console.warn(`⚠️ Transaction was replaced: ${waitErr.replacement && waitErr.replacement.hash}`);
          metrics.emit("attempt", { chain: chainConfig.key, user, hf: latestHealthFactor, outcome: "replaced", tx: tx.hash, deliverMs, detectBlock });
        } else {
          // A CALL_EXCEPTION here is the ethers wrapper around the same on-chain
          // revert (the receipt resolves with status 0); treat it as precheck
          // staleness too so both surfaces are counted together.
          const staleness = waitErr.code === "CALL_EXCEPTION" || undefined;
          console.error(`❌ Liquidation confirm failed (${tx.hash}):`, waitErr.message);
          metrics.emit("attempt", { chain: chainConfig.key, user, hf: latestHealthFactor, outcome: "confirm_error", staleness, afterPrecheckPass: true, tx: tx.hash, reason: waitErr.message, deliverMs, detectBlock });
        }
        if (nonceManager) await nonceManager.resync();
      })
      .finally(releaseSlot);

    if (process.env.ASYNC_SEND !== "true") {
      await confirm; // blocking path (default)
    }
    // else: leave `confirm` running in the background; the in-flight cap bounds it.
  } catch (error) {
    if (error.code === "TRANSACTION_REPLACED") {
      console.warn(`⚠️ Transaction was replaced: ${error.replacement && error.replacement.hash}`);
    } else {
      console.error(`❌ Liquidation failed:`, error.message);
    }
  }
}

function getLiquidatorAddress(chainConfig) {
  return (
    process.env[`${chainConfig.key.toUpperCase()}_AAVE_LIQUIDATOR_ADDRESS`] ||
    (!process.env.CHAINS && process.env.AAVE_LIQUIDATOR_ADDRESS) ||
    ""
  );
}


main().catch(console.error);
