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
} = require("./aaveHelpers");
const { getSelectedChainConfigs } = require("./src/chains");
const { getTransactionOverrides } = require("./src/gas");
const { createProvider, createBlockProvider } = require("./src/provider");
const { loadWatchlist } = require("./src/borrowerStore");

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
  const ctx = { provider, chainConfig, aaveLiquidatorContract };
  const lock = { inFlight: false };

  // Each cycle does an incremental Borrow scan + a parallel HF sweep, so it is
  // cheap enough to run frequently. The first cycle pays a one-time backfill.
  const cycleMs = parseInt(process.env.SCAN_INTERVAL_MS || "15000", 10);

  // Optional per-block watchlist trigger (Batch 1.1). Off by default. When on,
  // re-checks ONLY the near-threshold watchlist every block (cheap), so a
  // position crossing HF<1 is acted on within ~1 block instead of up to
  // SCAN_INTERVAL_MS later. The slow poll below keeps maintaining the watchlist.
  if (process.env.BLOCK_TRIGGER === "true") {
    const blockProvider = createBlockProvider(chainConfig) || provider;
    const usingWs = blockProvider !== provider;
    console.log(`🔔 ${chainConfig.name}: per-block watchlist trigger ON (${usingWs ? "WebSocket push" : "HTTP polling"}).`);
    blockProvider.on("block", async (blockNumber) => {
      if (lock.inFlight) return; // a poll or prior block check is still running
      lock.inFlight = true;
      try {
        await runWatchlistCheck(ctx, blockNumber);
      } catch (error) {
        console.error(`❌ ${chainConfig.name}: block-trigger error (block ${blockNumber}):`, error.message);
      } finally {
        lock.inFlight = false;
      }
    });
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

// Per-block hot path: re-check ONLY the persisted watchlist (near-threshold,
// non-dust wallets the sweep already identified). This is intentionally tiny and
// fast — a single Multicall3 read of tens–hundreds of addresses (~100–300ms) —
// so it can run every block. Anything that crosses HF<1 here is enriched (one
// batched read each, concurrently) and attempted immediately. The full/warm/cold
// sweeps in the poll loop are what keep the watchlist populated; this only reacts.
async function runWatchlistCheck({ provider, chainConfig, aaveLiquidatorContract }, blockNumber) {
  const chainKey = chainConfig.key || "default";
  const { watch } = loadWatchlist(chainKey);
  if (!watch || watch.size === 0) return;

  const threshold = parseFloat(process.env.LIQUIDATION_THRESHOLD || "1.0");
  const minDebtUsd = resolveChainMinDebtUsd(chainConfig);

  const t0 = Date.now();
  const hfs = await getUserHealthFactorsBatched([...watch], provider, chainConfig);
  const liq = hfs
    .filter((h) => Number.isFinite(h.healthFactor) && h.healthFactor < threshold && h.totalDebtUsd >= minDebtUsd)
    .sort((a, b) => a.healthFactor - b.healthFactor);

  if (liq.length === 0) {
    if (process.env.VERBOSE_HEALTH_LOGS === "true") {
      console.log(`   ⛓️ ${chainConfig.name}: block ${blockNumber} watchlist ${watch.size} clean (${Date.now() - t0}ms).`);
    }
    return;
  }

  console.log(`🔔 ${chainConfig.name}: block ${blockNumber} — ${liq.length} watchlist position(s) below ${threshold} (${Date.now() - t0}ms).`);

  // Enrich the urgent ones concurrently (each a single batched read), then
  // attempt in lowest-HF-first order. attemptLiquidation honors TEST_MODE.
  const reserves = chainConfig.protocolDataProvider
    ? await getReservesListCached(provider, chainConfig)
    : [];
  const minDebtToCover = parseFloat(process.env.MIN_DEBT_TO_COVER || "0.099");

  for (const { user, healthFactor, totalDebtUsd } of liq) {
    let position;
    try {
      position = await enrichCandidateBatched(user, provider, chainConfig, reserves);
    } catch (error) {
      console.warn(`⚠️ ${chainConfig.name}: enrichment failed for ${user}: ${error.message}`);
      continue;
    }
    if (!position) continue;

    const debtInUnits = parseFloat(ethers.utils.formatUnits(position.debtAmount, position.debtDecimals));
    if (debtInUnits < minDebtToCover) continue;

    await attemptLiquidation(
      { ...position, user, healthFactor, totalDebtUsd },
      { provider, chainConfig, aaveLiquidatorContract }
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
async function simulateLiquidation(contract, { debtAsset, debtToCover, user, collateralAsset, provider, chainConfig, gasPrice }) {
  try {
    await contract.callStatic.triggerLiquidation(debtAsset, debtToCover, user, collateralAsset);
  } catch (error) {
    const reason = error.reason || error.errorName || error.error?.message || error.message || "revert";
    return { ok: false, reason: String(reason).slice(0, 160) };
  }

  // Best-effort gas estimate so we can log/compare cost. Non-fatal if it fails.
  // Reuse the caller's gas price when provided (one round-trip for the whole
  // submit path instead of re-fetching it here).
  let estGasCostNative = null;
  try {
    const [gasEstimate, livePrice] = await Promise.all([
      contract.estimateGas.triggerLiquidation(debtAsset, debtToCover, user, collateralAsset),
      gasPrice ? Promise.resolve(gasPrice) : provider.getGasPrice(),
    ]);
    estGasCostNative = ethers.utils.formatEther(gasEstimate.mul(livePrice));
  } catch (_) {
    // estimateGas can fail even when callStatic passes (e.g. gas heuristics);
    // don't block on it — the callStatic success is the real gate.
  }

  return { ok: true, reason: "ok", estGasCostNative };
}


async function attemptLiquidation({
  user,
  debtAsset,
  debtAmount,
  debtDecimals = 6,
  debtSymbol = "debt asset",
  collateralAsset,
  healthFactor
}, {
  provider,
  chainConfig,
  aaveLiquidatorContract,
}) {
  console.log("⚡ Attempting liquidation with:", {
    chain: chainConfig.name,
    user,
    debtAsset,
    debtAmount: ethers.utils.formatUnits(debtAmount, debtDecimals),
    debtSymbol,
    collateralAsset
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

  // Define a threshold for full vs. partial liquidation.
  // For example, if HF is above 0.95, only 50% of the debt can be liquidated.
  const CLOSE_FACTOR_HF_THRESHOLD = 0.95;
  let debtToCover = debtAmount;

  if (latestHealthFactor > CLOSE_FACTOR_HF_THRESHOLD) {
    // Liquidate only 50% of the debt.
    debtToCover = debtAmount.div(2); // BigNumber division (rounding down)
    console.log(`Partial liquidation: Only covering 50% of the debt: ${ethers.utils.formatUnits(debtToCover, debtDecimals)} ${debtSymbol}`);
  } else {
    console.log(`Full liquidation: Covering full debt: ${ethers.utils.formatUnits(debtToCover, debtDecimals)} ${debtSymbol}`);
  }

  if (!aaveLiquidatorContract) {
    console.warn(`${chainConfig.name}: No liquidator contract configured; skipping.`);
    return;
  }

  // Fetch the live gas price ONCE for the whole submit path. It was previously
  // fetched up to three times (simulate, floor preview, overrides); thread it
  // through instead. Non-fatal if it fails — downstream falls back to a fresh read.
  let sharedGasPrice = null;
  try {
    sharedGasPrice = await provider.getGasPrice();
  } catch (_) {
    // leave null; helpers will fetch their own.
  }

  // PROFITABILITY PRE-CHECK (defense-in-depth, part 1 of 2).
  // Simulate the whole flash-loan → liquidationCall → swap → repay path with
  // callStatic before spending any gas. If it reverts, the liquidation is not
  // viable right now (no swap route, insufficient collateral, already healed,
  // or — once the hardened contract is deployed — the profit floor isn't met),
  // so we skip instead of burning gas on a guaranteed-failed tx. We also run
  // this in TEST_MODE purely for observability (would it have succeeded?).
  const profitCheck = await simulateLiquidation(aaveLiquidatorContract, {
    debtAsset,
    debtToCover,
    user,
    collateralAsset,
    provider,
    chainConfig,
    gasPrice: sharedGasPrice,
  });
  if (!profitCheck.ok) {
    console.log(`🛑 ${chainConfig.name}: pre-check failed for ${user} — skipping (${profitCheck.reason}).`);
    return;
  }
  console.log(
    `✅ ${chainConfig.name}: pre-check passed for ${user}` +
      (profitCheck.estGasCostNative ? ` (est gas ~${profitCheck.estGasCostNative} ${chainConfig.nativeToken})` : "")
  );

  if (testMode) {
    // Compute (but don't submit) the gas-aware floor for observability.
    const previewFloor = await computeMinProfitUnits({
      provider,
      chainConfig,
      debtDecimals,
      estGasUnits: ethers.BigNumber.from(chainConfig.liquidationGasLimit),
      gasPrice: sharedGasPrice || (await provider.getGasPrice()),
    });
    console.log("TEST_MODE enabled: pre-check passed but skipping submission.", {
      chain: chainConfig.name,
      user,
      debtToCover: ethers.utils.formatUnits(debtToCover, debtDecimals) + " " + debtSymbol,
      minProfitFloor: previewFloor ? ethers.utils.formatUnits(previewFloor, debtDecimals) + " " + debtSymbol : "n/a",
      hardenedContract: !!chainConfig.hardenedLiquidator,
    });
    return;
  }

  try {
    const overrides = await getTransactionOverrides(provider, chainConfig, {
      gasLimit: chainConfig.liquidationGasLimit,
      gasPrice: sharedGasPrice, // reuse the single fetch; helper falls back if null
    });

    // Compute a gas-aware profit floor and pass it on hardened chains. The
    // contract enforces max(thisFloor, storedMinProfit) and reverts if a bad
    // (e.g. sandwiched) swap can't clear it — so unprofitable liquidations cost
    // nothing beyond the failed-tx gas, and we never sell the bonus at a loss.
    const minProfitUnits = await computeMinProfitUnits({
      provider,
      chainConfig,
      debtDecimals,
      estGasUnits: ethers.BigNumber.from(chainConfig.liquidationGasLimit),
      gasPrice: overrides.gasPrice || (await provider.getGasPrice()),
    });

    let tx;
    if (chainConfig.hardenedLiquidator && minProfitUnits && aaveLiquidatorContract.triggerLiquidationWithMinProfit) {
      console.log(`   ${chainConfig.name}: min-profit floor ${ethers.utils.formatUnits(minProfitUnits, debtDecimals)} ${debtSymbol}`);
      tx = await aaveLiquidatorContract.triggerLiquidationWithMinProfit(
        debtAsset,
        debtToCover,
        user,
        collateralAsset,
        minProfitUnits,
        overrides
      );
    } else {
      // Arbitrum (old contract) or floor-compute failed: 4-arg path uses the
      // contract's stored minProfit floor.
      tx = await aaveLiquidatorContract.triggerLiquidation(
        debtAsset,
        debtToCover,
        user,
        collateralAsset,
        overrides
      );
    }

    console.log(`✅ TX sent: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      console.log(`🎉 Successful liquidation: ${tx.hash}`);
    } else {
      console.warn(`⚠️ Liquidation TX failed on-chain: ${tx.hash}`);
    }
  } catch (error) {
    if (error.code === "TRANSACTION_REPLACED") {
      console.warn(`⚠️ Transaction was replaced: ${error.replacement.hash}`);
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
