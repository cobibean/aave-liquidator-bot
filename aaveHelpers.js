const { ethers } = require('ethers');
const fetch = require("node-fetch");
const { loadBorrowerSet, saveBorrowerSet, loadWatchlist, saveWatchlist, loadNear, saveNear, loadActiveDebt, saveActiveDebt } = require("./src/borrowerStore");
const { aggregate3InBatches, aggregate3Streaming } = require("./src/multicall");
const metrics = require("./src/metrics");

// Interface used to encode/decode getUserAccountData calls for Multicall3.
const POOL_IFACE = new ethers.utils.Interface([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

// Interface for ProtocolDataProvider.getUserReserveData, used to batch a user's
// per-reserve debt/collateral reads into ONE Multicall3 round-trip during
// enrichment (instead of one serial RPC call per reserve, per candidate).
const DATA_PROVIDER_IFACE = new ethers.utils.Interface([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);

// Per-chain caches for rarely-changing reads, so enrichment doesn't re-fetch
// them once per candidate during a race. Keyed by chain. Reserves list changes
// only when Aave lists/drops a reserve; ERC-20 symbol/decimals are immutable.
const reservesListCache = new Map(); // chainKey -> { reserves, fetchedAt }
const assetMetaCache = new Map(); // `${chainKey}:${asset.toLowerCase()}` -> { symbol, decimals }
const RESERVES_CACHE_TTL_MS = parseInt(process.env.RESERVES_CACHE_TTL_MS || "300000", 10); // 5 min

const DEFAULT_SUBGRAPH_URL = "https://metisapi.0xgraph.xyz/subgraphs/name/aave/protocol-v3-metis";
const BORROW_EVENT_ABI = [
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"
];
const POOL_ABI = [
  "function getReservesList() view returns (address[])",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];
const PROTOCOL_DATA_PROVIDER_ABI = [
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)"
];
const ERC20_METADATA_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

function logVerbose(...args) {
  if (process.env.VERBOSE_HEALTH_LOGS === "true") {
    console.log(...args);
  }
}

// Runs `worker` over `items` with a bounded number of concurrent calls.
// Used so health-factor checks across hundreds/thousands of borrowers happen
// in parallel (a few dozen at a time) instead of one slow RPC round-trip at a
// time, while staying under public-RPC rate limits. Results preserve input order.
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) {
        return;
      }
      results[current] = await worker(items[current], current);
    }
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: limit }, runner));
  return results;
}

// Reads health factors for many users in a few RPC round-trips via Multicall3,
// instead of one getUserAccountData call per user. Returns [{ user, healthFactor }]
// in input order. Users with no debt return a huge HF (Aave returns max uint256);
// failed/undecodable calls return Infinity so they're treated as healthy/skip.
async function getUserHealthFactorsBatched(users, provider, chainConfig = {}) {
  const poolAddress = getPoolAddress(chainConfig);
  if (!poolAddress || users.length === 0) {
    return users.map((user) => ({ user, healthFactor: 999 }));
  }

  const callData = POOL_IFACE.encodeFunctionData("getUserAccountData", [users[0]]);
  void callData; // (per-user calldata built below; this validates the signature once)

  const calls = users.map((user) => ({
    target: poolAddress,
    allowFailure: true,
    callData: POOL_IFACE.encodeFunctionData("getUserAccountData", [user]),
  }));

  const batchSize = parseInt(process.env.MULTICALL_BATCH_SIZE || "300", 10);
  const raw = await aggregate3InBatches(provider, calls, batchSize);

  return users.map((user, i) => decodeAccountData(user, raw[i]));
}

// Decodes one Multicall3 getUserAccountData entry into { user, healthFactor,
// totalDebtUsd }. A missing/failed/empty entry (no debt, bad address, reverted
// call) yields a huge HF + zero debt so it's treated as healthy/skip. Shared by
// both the materialized (getUserHealthFactorsBatched) and streaming sweep paths.
function decodeAccountData(user, entry) {
  if (!entry || !entry.success || !entry.returnData || entry.returnData === "0x") {
    return { user, healthFactor: Infinity, totalDebtUsd: 0 };
  }
  try {
    const decoded = POOL_IFACE.decodeFunctionResult("getUserAccountData", entry.returnData);
    const hf = parseFloat(ethers.utils.formatUnits(decoded.healthFactor, 18));
    // Aave v3 base currency is USD with 8 decimals (verified on-chain).
    const totalDebtUsd = parseFloat(ethers.utils.formatUnits(decoded.totalDebtBase, 8));
    return {
      user,
      healthFactor: Number.isFinite(hf) ? hf : Infinity,
      totalDebtUsd: Number.isFinite(totalDebtUsd) ? totalDebtUsd : 0,
    };
  } catch (error) {
    return { user, healthFactor: Infinity, totalDebtUsd: 0 };
  }
}

// Memory-safe health-factor sweep for large borrower sets. Encodes one batch of
// getUserAccountData calls at a time, fetches it via Multicall3, decodes it, and
// hands each decoded { user, healthFactor, totalDebtUsd } to `onUser` — then
// DISCARDS the batch before building the next. Peak heap is O(batchSize) rather
// than O(users), which is what lets Base's ~210k-borrower full sweep complete
// instead of exhausting V8's heap. Returns the number of users swept.
//
// opts.onBatchDone(usersSweptSoFar) — optional, awaited after each batch. Lets a
// long full sweep checkpoint progress (e.g. persist the partial watchlist) so a
// mid-sweep crash resumes near where it stopped instead of restarting from zero.
async function sweepHealthFactorsStreaming(users, provider, chainConfig, onUser, opts = {}) {
  const poolAddress = getPoolAddress(chainConfig);
  if (!poolAddress || users.length === 0) {
    for (const user of users) onUser({ user, healthFactor: 999, totalDebtUsd: 0 });
    return users.length;
  }

  const batchSize = parseInt(process.env.MULTICALL_BATCH_SIZE || "300", 10);
  const onBatchDone = typeof opts.onBatchDone === "function" ? opts.onBatchDone : null;

  // Build the full call list once (each entry is small per-user calldata), then
  // stream it through Multicall3 one batch at a time. aggregate3Streaming fetches
  // a batch, hands us its results, and discards them before the next — so the
  // only large structures alive are `calls` (input) and `users` (the caller's
  // borrower list); the heavy decoded results never accumulate.
  const calls = users.map((user) => ({
    target: poolAddress,
    allowFailure: true,
    callData: POOL_IFACE.encodeFunctionData("getUserAccountData", [user]),
  }));

  await aggregate3Streaming(provider, calls, batchSize, async (batchResults, startIndex) => {
    for (let j = 0; j < batchResults.length; j++) {
      const user = users[startIndex + j];
      onUser(decodeAccountData(user, batchResults[j]));
    }
    if (onBatchDone) await onBatchDone(startIndex + batchResults.length);
  });

  return users.length;
}

// ABI for Aave's UI Pool Data Provider (if needed for other functions)
const UI_POOL_DATA_PROVIDER_ABI = [
    {
        "inputs": [
            {
                "internalType": "contract IEACAggregatorProxy",
                "name": "_networkBaseTokenPriceInUsdProxyAggregator",
                "type": "address"
            },
            {
                "internalType": "contract IEACAggregatorProxy",
                "name": "_marketReferenceCurrencyPriceInUsdProxyAggregator",
                "type": "address"
            }
        ],
        "stateMutability": "nonpayable",
        "type": "constructor"
    },
    {
        "inputs": [],
        "name": "ETH_CURRENCY_UNIT",
        "outputs": [
            {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "MKR_ADDRESS",
        "outputs": [
            {
                "internalType": "address",
                "name": "",
                "type": "address"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "_bytes32",
                "type": "bytes32"
            }
        ],
        "name": "bytes32ToString",
        "outputs": [
            {
                "internalType": "string",
                "name": "",
                "type": "string"
            }
        ],
        "stateMutability": "pure",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "contract IPoolAddressesProvider",
                "name": "provider",
                "type": "address"
            }
        ],
        "name": "getEModes",
        "outputs": [
            {
                "components": [
                    {
                        "internalType": "uint8",
                        "name": "id",
                        "type": "uint8"
                    },
                    {
                        "components": [
                            {
                                "internalType": "uint16",
                                "name": "ltv",
                                "type": "uint16"
                            },
                            {
                                "internalType": "uint16",
                                "name": "liquidationThreshold",
                                "type": "uint16"
                            },
                            {
                                "internalType": "uint16",
                                "name": "liquidationBonus",
                                "type": "uint16"
                            },
                            {
                                "internalType": "uint128",
                                "name": "collateralBitmap",
                                "type": "uint128"
                            },
                            {
                                "internalType": "string",
                                "name": "label",
                                "type": "string"
                            },
                            {
                                "internalType": "uint128",
                                "name": "borrowableBitmap",
                                "type": "uint128"
                            }
                        ],
                        "internalType": "struct DataTypes.EModeCategory",
                        "name": "eMode",
                        "type": "tuple"
                    }
                ],
                "internalType": "struct IUiPoolDataProviderV3.Emode[]",
                "name": "",
                "type": "tuple[]"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "contract IPoolAddressesProvider",
                "name": "provider",
                "type": "address"
            }
        ],
        "name": "getReservesData",
        "outputs": [
            {
                "components": [
                    {
                        "internalType": "address",
                        "name": "underlyingAsset",
                        "type": "address"
                    },
                    {
                        "internalType": "string",
                        "name": "name",
                        "type": "string"
                    },
                    {
                        "internalType": "string",
                        "name": "symbol",
                        "type": "string"
                    },
                    {
                        "internalType": "uint256",
                        "name": "decimals",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "baseLTVasCollateral",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "reserveLiquidationThreshold",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "reserveLiquidationBonus",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "reserveFactor",
                        "type": "uint256"
                    },
                    {
                        "internalType": "bool",
                        "name": "usageAsCollateralEnabled",
                        "type": "bool"
                    },
                    {
                        "internalType": "bool",
                        "name": "borrowingEnabled",
                        "type": "bool"
                    },
                    {
                        "internalType": "bool",
                        "name": "isActive",
                        "type": "bool"
                    },
                    {
                        "internalType": "bool",
                        "name": "isFrozen",
                        "type": "bool"
                    },
                    {
                        "internalType": "uint128",
                        "name": "liquidityIndex",
                        "type": "uint128"
                    },
                    {
                        "internalType": "uint128",
                        "name": "variableBorrowIndex",
                        "type": "uint128"
                    },
                    {
                        "internalType": "uint128",
                        "name": "liquidityRate",
                        "type": "uint128"
                    },
                    {
                        "internalType": "uint128",
                        "name": "variableBorrowRate",
                        "type": "uint128"
                    },
                    {
                        "internalType": "uint40",
                        "name": "lastUpdateTimestamp",
                        "type": "uint40"
                    },
                    {
                        "internalType": "address",
                        "name": "aTokenAddress",
                        "type": "address"
                    },
                    {
                        "internalType": "address",
                        "name": "variableDebtTokenAddress",
                        "type": "address"
                    },
                    {
                        "internalType": "address",
                        "name": "interestRateStrategyAddress",
                        "type": "address"
                    },
                    {
                        "internalType": "uint256",
                        "name": "availableLiquidity",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "totalScaledVariableDebt",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "priceInMarketReferenceCurrency",
                        "type": "uint256"
                    },
                    {
                        "internalType": "address",
                        "name": "priceOracle",
                        "type": "address"
                    },
                    {
                        "internalType": "uint256",
                        "name": "variableRateSlope1",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "variableRateSlope2",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "baseVariableBorrowRate",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "optimalUsageRatio",
                        "type": "uint256"
                    },
                    {
                        "internalType": "bool",
                        "name": "isPaused",
                        "type": "bool"
                    },
                    {
                        "internalType": "bool",
                        "name": "isSiloedBorrowing",
                        "type": "bool"
                    },
                    {
                        "internalType": "uint128",
                        "name": "accruedToTreasury",
                        "type": "uint128"
                    },
                    {
                        "internalType": "uint128",
                        "name": "unbacked",
                        "type": "uint128"
                    },
                    {
                        "internalType": "uint128",
                        "name": "isolationModeTotalDebt",
                        "type": "uint128"
                    },
                    {
                        "internalType": "bool",
                        "name": "flashLoanEnabled",
                        "type": "bool"
                    },
                    {
                        "internalType": "uint256",
                        "name": "debtCeiling",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "debtCeilingDecimals",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "borrowCap",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "supplyCap",
                        "type": "uint256"
                    },
                    {
                        "internalType": "bool",
                        "name": "borrowableInIsolation",
                        "type": "bool"
                    },
                    {
                        "internalType": "bool",
                        "name": "virtualAccActive",
                        "type": "bool"
                    },
                    {
                        "internalType": "uint128",
                        "name": "virtualUnderlyingBalance",
                        "type": "uint128"
                    }
                ],
                "internalType": "struct IUiPoolDataProviderV3.AggregatedReserveData[]",
                "name": "",
                "type": "tuple[]"
            },
            {
                "components": [
                    {
                        "internalType": "uint256",
                        "name": "marketReferenceCurrencyUnit",
                        "type": "uint256"
                    },
                    {
                        "internalType": "int256",
                        "name": "marketReferenceCurrencyPriceInUsd",
                        "type": "int256"
                    },
                    {
                        "internalType": "int256",
                        "name": "networkBaseTokenPriceInUsd",
                        "type": "int256"
                    },
                    {
                        "internalType": "uint8",
                        "name": "networkBaseTokenPriceDecimals",
                        "type": "uint8"
                    }
                ],
                "internalType": "struct IUiPoolDataProviderV3.BaseCurrencyInfo",
                "name": "",
                "type": "tuple"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "contract IPoolAddressesProvider",
                "name": "provider",
                "type": "address"
            }
        ],
        "name": "getReservesList",
        "outputs": [
            {
                "internalType": "address[]",
                "name": "",
                "type": "address[]"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "contract IPoolAddressesProvider",
                "name": "provider",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "user",
                "type": "address"
            }
        ],
        "name": "getUserReservesData",
        "outputs": [
            {
                "components": [
                    {
                        "internalType": "address",
                        "name": "underlyingAsset",
                        "type": "address"
                    },
                    {
                        "internalType": "uint256",
                        "name": "scaledATokenBalance",
                        "type": "uint256"
                    },
                    {
                        "internalType": "bool",
                        "name": "usageAsCollateralEnabledOnUser",
                        "type": "bool"
                    },
                    {
                        "internalType": "uint256",
                        "name": "scaledVariableDebt",
                        "type": "uint256"
                    }
                ],
                "internalType": "struct IUiPoolDataProviderV3.UserReserveData[]",
                "name": "",
                "type": "tuple[]"
            },
            {
                "internalType": "uint8",
                "name": "",
                "type": "uint8"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "marketReferenceCurrencyPriceInUsdProxyAggregator",
        "outputs": [
            {
                "internalType": "contract IEACAggregatorProxy",
                "name": "",
                "type": "address"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "networkBaseTokenPriceInUsdProxyAggregator",
        "outputs": [
            {
                "internalType": "contract IEACAggregatorProxy",
                "name": "",
                "type": "address"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    }
];

async function getBorrowersFromSubgraph(chainConfig = {}) {
    const query = `
    {
      borrows(first: 1000, orderBy: timestamp, orderDirection: desc) {
        user {
          id  # Borrower's wallet address
        }
      }
    }`;

    const response = await fetch(getSubgraphUrl(chainConfig), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });

    const data = await response.json();

    console.log("📜 Raw Borrower Data from Subgraph:", JSON.stringify(data, null, 2));

    if (!data || !data.data || !data.data.borrows) {
        console.error("❌ Error: Unexpected response format from The Graph.");
        return [];
    }

    // Extract unique borrowers
    const uniqueBorrowers = new Set();
    data.data.borrows.forEach(borrow => {
        if (borrow.user && borrow.user.id) {
            uniqueBorrowers.add(borrow.user.id.toLowerCase()); // Normalize case
        }
    });

    console.log(`✅ Found ${uniqueBorrowers.size} unique borrowers.`);
    return Array.from(uniqueBorrowers);
}

// Scans a [fromBlock, toBlock] range for Borrow events in chunks and adds
// every borrower into `target`. Returns the number of new addresses added.
// `checkpoint(lastCompletedBlock)` is called every CHECKPOINT_EVERY_CHUNKS so a
// long backfill persists progress and can resume after an interruption.
// `newKeys` (optional Set) collects addresses that were not already in `target`
// — used so the caller can health-check freshly-discovered borrowers this cycle.
async function scanBorrowRange(pool, fromBlock, toBlock, chunkSize, target, label, checkpoint, newKeys) {
    let added = 0;
    let chunkIndex = 0;
    const checkpointEvery = parseInt(process.env.CHECKPOINT_EVERY_CHUNKS || "25", 10);
    const totalChunks = Math.ceil((toBlock - fromBlock + 1) / chunkSize);

    for (let startBlock = fromBlock; startBlock <= toBlock; startBlock += chunkSize) {
      const endBlock = Math.min(startBlock + chunkSize - 1, toBlock);
      try {
        const events = await pool.queryFilter(pool.filters.Borrow(), startBlock, endBlock);
        for (const event of events) {
          const borrower = event.args.onBehalfOf || event.args.user;
          if (borrower && borrower !== ethers.constants.AddressZero) {
            const key = borrower.toLowerCase();
            if (!target.has(key)) {
              added++;
              if (newKeys) newKeys.add(key);
            }
            target.add(key);
          }
        }
      } catch (error) {
        console.warn(`⚠️ ${label}: Borrow scan failed for blocks ${startBlock}-${endBlock}: ${error.message}`);
      }

      chunkIndex++;
      if (checkpoint && chunkIndex % checkpointEvery === 0) {
        // endBlock is fully scanned at this point; persist it as the resume point.
        checkpoint(endBlock);
        if (totalChunks > checkpointEvery) {
          console.log(`   …${label}: backfill ${chunkIndex}/${totalChunks} chunks (${target.size} borrowers so far)`);
        }
      }
    }
    return added;
}

// Backfill-aware borrower discovery.
//
// The original implementation only scanned the last `borrowScanBlocks` of
// Borrow events every cycle. Liquidatable positions are almost always AGED
// positions (price drift / interest accrual), not fresh borrows, so that
// candidate set systematically missed the wallets most likely to be
// underwater (measured: 35 of 36 Arbitrum liquidations were invisible to it).
//
// Now: on first run we backfill `borrowBackfillBlocks` of history (deep,
// one-time), persist the borrower set, and on every subsequent run only scan
// the new blocks since `lastScannedBlock`. The persisted set keeps growing and
// the per-cycle cost stays tiny.
async function getBorrowersFromBorrowEvents(provider, chainConfig = {}) {
    const poolAddress = getPoolAddress(chainConfig);
    const pool = new ethers.Contract(poolAddress, BORROW_EVENT_ABI, provider);
    const currentBlock = await provider.getBlockNumber();
    const chunkSize = chainConfig.borrowScanChunkSize || 10000;
    const chainKey = chainConfig.key || "default";

    const state = loadBorrowerSet(chainKey);
    const { borrowers } = state;

    if (!state.backfillDone) {
      // DEEP BACKFILL (one-time, resumable). Floor is the pool deployment block
      // (captures ALL historical borrowers — the aged positions that actually
      // get liquidated), BUT never deeper than borrowBackfillBlocks, which acts
      // as a max-depth cap. On chains with very long histories + slow public RPCs
      // (Avalanche/Optimism), a ~366-day cap finishes in minutes instead of ~30h
      // while still covering every still-active borrower. Set
      // BORROW_BACKFILL_FROM_DEPLOYMENT=false to ignore the deployment block entirely.
      const fromDeployment = process.env.BORROW_BACKFILL_FROM_DEPLOYMENT !== "false";
      const capDepth = chainConfig.borrowBackfillBlocks || chainConfig.borrowScanBlocks || 100000;
      const windowFloor = Math.max(currentBlock - capDepth, 0);
      const floor = (fromDeployment && Number.isFinite(chainConfig.deploymentBlock))
        ? Math.max(chainConfig.deploymentBlock, windowFloor) // deployment, but capped to the window
        : windowFloor;

      // Resume from where a prior interrupted backfill left off.
      const fromBlock = Number.isFinite(state.backfillCursor)
        ? Math.max(state.backfillCursor + 1, floor)
        : floor;
      const chunks = Math.ceil((currentBlock - fromBlock) / chunkSize);
      const resuming = Number.isFinite(state.backfillCursor);
      console.log(`📚 ${chainConfig.name}: ${resuming ? "RESUME" : "BACKFILL"} Borrow scan ${fromBlock} → ${currentBlock} (~${chunks} chunks, one-time).`);

      const added = await scanBorrowRange(
        pool, fromBlock, currentBlock, chunkSize, borrowers, chainConfig.name || "Aave",
        (checkpointBlock) => saveBorrowerSet(chainKey, borrowers, null, { backfillCursor: checkpointBlock, backfillDone: false })
      );
      // Backfill reached head: mark done and record head as the incremental anchor.
      saveBorrowerSet(chainKey, borrowers, currentBlock, { backfillCursor: currentBlock, backfillDone: true });
      console.log(`✅ ${chainConfig.name}: BACKFILL complete — ${borrowers.size} known borrowers (+${added} new).`);
      return Array.from(borrowers);
    }

    // INCREMENTAL: backfill is done, only scan new blocks since last head.
    // Re-scan the last chunk too, in case a prior run stopped mid-chunk or a
    // reorg shuffled recent blocks.
    const anchor = Number.isFinite(state.lastScannedBlock) ? state.lastScannedBlock : currentBlock;
    const fromBlock = Math.max(anchor - chunkSize, 0);
    console.log(`🔁 ${chainConfig.name}: incremental Borrow scan ${fromBlock} → ${currentBlock} (known borrowers: ${borrowers.size}).`);

    const newThisScan = new Set();
    const added = await scanBorrowRange(pool, fromBlock, currentBlock, chunkSize, borrowers, chainConfig.name || "Aave", null, newThisScan);
    saveBorrowerSet(chainKey, borrowers, currentBlock, { backfillCursor: currentBlock, backfillDone: true });

    console.log(`✅ ${chainConfig.name}: ${borrowers.size} known borrowers (+${added} new this scan).`);
    // Expose the freshly-discovered addresses (as a property on the returned
    // array, so existing array callers are unaffected) so getUnhealthyPositions
    // can health-check them THIS cycle instead of waiting for the next full sweep.
    const result = Array.from(borrowers);
    result.newThisScan = newThisScan;
    return result;
}

async function getBorrowers(provider, chainConfig = {}) {
    if (chainConfig.subgraphUrl && chainConfig.borrowerSource === "subgraph") {
      return getBorrowersFromSubgraph(chainConfig);
    }

    return getBorrowersFromBorrowEvents(provider, chainConfig);
}

// Fetch user debt, collateral, and health factor

// Get user's health factor from the Aave contract
async function getUserHealthFactor(userAddress, provider, chainConfig = {}) {
    const poolAddress = getPoolAddress(chainConfig);
    if (!poolAddress) {
        console.error("POOL_ADDRESS not set in environment variables");
        return 999;
    }

    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    try {
        const data = await pool.getUserAccountData(userAddress);
        const healthFactor = parseFloat(ethers.utils.formatUnits(data.healthFactor, 18));
        logVerbose(`Health factor for ${userAddress}: ${healthFactor}`);
        return healthFactor;
    } catch (error) {
        console.error(`Health factor check failed for ${userAddress}:`, error.message);
        return 999; // Return high HF to skip invalid users
    }
}


// Get user's primary collateral.
async function getPrimaryCollateral(userAddress, provider, chainConfig = {}) {
    if (chainConfig.protocolDataProvider) {
      const positions = await getUserReservePositions(userAddress, provider, chainConfig);
      const collateralPositions = positions
        .filter((position) => position.currentATokenBalance.gt(ethers.constants.Zero) && position.usageAsCollateralEnabled)
        .sort((left, right) => {
          if (left.currentATokenBalance.eq(right.currentATokenBalance)) return 0;
          return left.currentATokenBalance.gt(right.currentATokenBalance) ? -1 : 1;
        });

      if (collateralPositions.length > 0) {
        const collateral = collateralPositions[0];
        console.log(`✅ Found collateral: ${collateral.asset}`);
        return collateral.asset;
      }

      console.warn(`⚠️ Warning: User ${userAddress} has no valid collateral.`);
      return null;
    }

    const query = `
    {
      userReserves(where: { user: "${userAddress.toLowerCase()}" }) {
        reserve {
          underlyingAsset
          symbol
        }
        scaledATokenBalance  # Represents the user's supplied balance
        scaledVariableDebt   # Represents the user's debt balance
      }
    }`;

    try {
        console.log(`🔎 Fetching collateral for ${userAddress}...`); // 🛠 Debug log

        const response = await fetch(getSubgraphUrl(chainConfig), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
        });

        const data = await response.json();
        console.log(`📜 Raw response for ${userAddress}:`, JSON.stringify(data, null, 2)); // 🛠 Debug log

        if (!data.data || data.data.userReserves.length === 0) {
            console.warn(`⚠️ Warning: No collateral found for user ${userAddress}`);
            return null;
        }

        // Find the first asset that has a positive balance (i.e., collateral)
        for (const reserve of data.data.userReserves) {
            if (ethers.BigNumber.from(reserve.scaledATokenBalance).gt(ethers.constants.Zero)) {
                console.log(`✅ Found collateral: ${reserve.reserve.symbol} (${reserve.reserve.underlyingAsset})`);
                return reserve.reserve.underlyingAsset;
            }
        }

        console.warn(`⚠️ Warning: User ${userAddress} has no valid collateral.`);
        return null;
    } catch (error) {
        console.error(`❌ Failed to fetch collateral for ${userAddress}:`, error.message);
        return null;
    }
}

// Get user's debt position for the configured debt asset.
async function getDebtPosition(userAddress, provider, debtAssetAddress, chainConfig = {}) {
    debtAssetAddress = debtAssetAddress || chainConfig.debtAssetAddress || process.env.DEBT_ASSET_ADDRESS;
    if (!debtAssetAddress) {
      console.warn("DEBT_ASSET_ADDRESS is not set. Skipping debt lookup.");
      return {
        debtAsset: null,
        debtAmount: ethers.constants.Zero,
        debtSymbol: "unknown",
        debtDecimals: 18,
      };
    }

    console.log(`🔍 Fetching debt for ${userAddress} on asset ${debtAssetAddress}...`);

    if (chainConfig.protocolDataProvider) {
      const [reserveData, metadata] = await Promise.all([
        getUserReserveData(debtAssetAddress, userAddress, provider, chainConfig),
        getAssetMetadataCached(debtAssetAddress, provider, chainConfig),
      ]);
      const debtAmount = reserveData.currentStableDebt.add(reserveData.currentVariableDebt);

      if (debtAmount.lte(ethers.constants.Zero)) {
        console.warn(`⚠️ No positive ${metadata.symbol} debt found for ${userAddress}`);
        return {
          debtAsset: debtAssetAddress,
          debtAmount: ethers.constants.Zero,
          debtSymbol: metadata.symbol,
          debtDecimals: metadata.decimals,
        };
      }

      console.log(
        `💰 ${metadata.symbol} debt for ${userAddress}: ${ethers.utils.formatUnits(debtAmount, metadata.decimals)}`
      );
      return {
        debtAsset: debtAssetAddress,
        debtAmount,
        debtSymbol: metadata.symbol,
        debtDecimals: metadata.decimals,
      };
    }
  
    const query = `
    {
      userReserves(where: { user: "${userAddress}" }) {
        reserve {
          underlyingAsset
          symbol
          decimals
        }
        currentTotalDebt
      }
    }`;
  
    const response = await fetch(getSubgraphUrl(chainConfig), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
  
    const data = await response.json();
    console.log(`📜 Raw debt response for ${userAddress}:`, JSON.stringify(data, null, 2));
  
    if (!data.data.userReserves.length) {
      console.warn(`⚠️ No debt found for ${userAddress}`);
      return {
        debtAsset: debtAssetAddress,
        debtAmount: ethers.constants.Zero,
        debtSymbol: "unknown",
        debtDecimals: 18,
      };
    }

    const targetReserve = data.data.userReserves.find((reserve) => {
      return reserve.reserve.underlyingAsset.toLowerCase() === debtAssetAddress.toLowerCase();
    });

    if (!targetReserve) {
      console.warn(`⚠️ No matching debt reserve found for ${userAddress}`);
      return {
        debtAsset: debtAssetAddress,
        debtAmount: ethers.constants.Zero,
        debtSymbol: "unknown",
        debtDecimals: 18,
      };
    }

    const debtAmount = ethers.BigNumber.from(targetReserve.currentTotalDebt);
    const decimals = Number(targetReserve.reserve.decimals);
    if (debtAmount.lte(ethers.constants.Zero)) {
      console.warn(`⚠️ No positive ${targetReserve.reserve.symbol} debt found for ${userAddress}`);
      return {
        debtAsset: debtAssetAddress,
        debtAmount: ethers.constants.Zero,
        debtSymbol: targetReserve.reserve.symbol,
        debtDecimals: decimals,
      };
    }

    console.log(
      `💰 ${targetReserve.reserve.symbol} debt for ${userAddress}: ${ethers.utils.formatUnits(debtAmount, decimals)}`
    );
    return {
      debtAsset: debtAssetAddress,
      debtAmount,
      debtSymbol: targetReserve.reserve.symbol,
      debtDecimals: decimals,
    };
  }

async function getPrimaryDebtPosition(userAddress, provider, chainConfig = {}) {
    const preferredDebtAsset = chainConfig.debtAssetAddress || process.env.DEBT_ASSET_ADDRESS;

    if (preferredDebtAsset) {
      const preferredDebt = await getDebtPosition(userAddress, provider, preferredDebtAsset, chainConfig);
      if (preferredDebt.debtAmount.gt(ethers.constants.Zero)) {
        return preferredDebt;
      }
    }

    const debtPositions = await getDebtPositions(userAddress, provider, chainConfig);
    if (debtPositions.length === 0) {
      return {
        debtAsset: preferredDebtAsset || null,
        debtAmount: ethers.constants.Zero,
        debtSymbol: "unknown",
        debtDecimals: 18,
      };
    }

    return debtPositions[0];
}

async function getDebtPositions(userAddress, provider, chainConfig = {}) {
    if (!chainConfig.protocolDataProvider) {
      const fallbackDebt = await getDebtPosition(
        userAddress,
        provider,
        chainConfig.debtAssetAddress || process.env.DEBT_ASSET_ADDRESS,
        chainConfig
      );
      return fallbackDebt.debtAmount.gt(ethers.constants.Zero) ? [fallbackDebt] : [];
    }

    const reserves = await getReservesListCached(provider, chainConfig);
    const debtPositions = [];

    for (const asset of reserves) {
      try {
        const [reserveData, metadata] = await Promise.all([
          getUserReserveData(asset, userAddress, provider, chainConfig),
          getAssetMetadataCached(asset, provider, chainConfig),
        ]);
        const debtAmount = reserveData.currentStableDebt.add(reserveData.currentVariableDebt);

        if (debtAmount.gt(ethers.constants.Zero)) {
          debtPositions.push({
            debtAsset: asset,
            debtAmount,
            debtSymbol: metadata.symbol,
            debtDecimals: metadata.decimals,
            debtInUnits: Number.parseFloat(ethers.utils.formatUnits(debtAmount, metadata.decimals)),
          });
        }
      } catch (error) {
        console.warn(`⚠️ Failed to fetch debt reserve ${asset} for ${userAddress}: ${error.message}`);
      }
    }

    return debtPositions.sort((left, right) => right.debtInUnits - left.debtInUnits);
}

// Get user's debt amount for the configured debt asset.
async function getDebtAmount(userAddress, provider, debtAssetAddress, chainConfig = {}) {
    const debtPosition = await getDebtPosition(userAddress, provider, debtAssetAddress, chainConfig);
    return debtPosition.debtAmount;
  }

// Fetch users who have borrowed from a specific reserve
async function getReserveUsers(reserveAddress, chainConfig = {}) {
    const query = `
    {
      borrows(where: { reserve: "${reserveAddress.toLowerCase()}" }, first: 1000) {
        user {
          id
        }
      }
    }`;

    try {
        console.log(`🔎 Fetching borrowers for reserve: ${reserveAddress}...`); // 🛠 Debug log

        const response = await fetch(getSubgraphUrl(chainConfig), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
        });

        const data = await response.json();
        console.log(`📜 Raw response for ${reserveAddress}:`, JSON.stringify(data, null, 2)); // 🛠 Debug log

        if (!data.data || data.data.borrows.length === 0) {
            console.warn(`⚠️ Warning: No borrowers found for reserve ${reserveAddress}`);
            return [];
        }

        // Extract borrower addresses
        const borrowers = data.data.borrows.map(b => b.user.id);
        console.log(`✅ Found ${borrowers.length} borrowers for ${reserveAddress}`);
        return borrowers;
    } catch (error) {
        console.error(`❌ Failed to fetch borrowers for ${reserveAddress}:`, error.message);
        return [];
    }
}

async function getUnhealthyPositions(provider, chainConfig = {}) {
    console.log(`🔎 Fetching borrowers for ${chainConfig.name || "configured Aave market"}...`);

    const borrowers = await getBorrowers(provider, chainConfig);
    if (borrowers.length === 0) {
      console.warn("⚠️ No borrowers found.");
      return [];
    }

    const threshold = parseFloat(process.env.LIQUIDATION_THRESHOLD || "1.0");
    const watchlistHf = parseFloat(process.env.WATCHLIST_HF || "1.25");
    // NEAR_HF (≥ watchlistHf) defines a wider mid-tier swept EVERY cycle: non-dust
    // wallets in the 1.25–1.5 band that would otherwise only be re-checked on the
    // slow full/warm sweep, and so could cross to liquidation unseen between them.
    // Per-chain overridable (<CHAIN>_NEAR_HF). Set ≤ watchlistHf to disable the tier.
    const nearHf = resolveChainNearHf(chainConfig, watchlistHf);
    const fullSweepEveryN = parseInt(process.env.FULL_SWEEP_EVERY_N || "8", 10);
    const coldSweepEveryN = parseInt(process.env.COLD_SWEEP_EVERY_N || "4", 10);
    // Time-based COLD floor (minutes). COLD is the ONLY sweep that promotes a
    // newly-borrowing whale (in the known set but no debt at last cold) into the
    // active-debt/warm tier the fast triggers actually watch. Counter-based
    // cadence alone let COLD go ~a full day between runs once warm slicing slowed
    // how fast warmSweepsSinceCold accrues — so freshly-risky whales were never
    // re-checked and we never fired. This guarantees COLD runs at least every
    // COLD_MAX_AGE_MIN regardless of the counters. 0 disables the time floor.
    const coldMaxAgeMin = parseInt(process.env.COLD_MAX_AGE_MIN || "30", 10);
    // WARM_SWEEP_SLICES (per-chain <CHAIN>_WARM_SWEEP_SLICES): split the warm
    // active-debt sweep into this many rotating slices, one slice per warm cycle,
    // so a large index (Base's ~60k) doesn't stall a single cycle for 90s–7min and
    // starve the every-cycle watchlist/near tiers. 1 = legacy single-cycle warm
    // sweep. Each slice still unions its debt-holders into the index (warm never
    // prunes — only COLD does), so N slices cover the whole index across N cycles,
    // equivalent to one big warm sweep, just spread out. The hot watchlist∪near∪new
    // tiers are added to EVERY warm slice, so detection of at-risk wallets is never
    // delayed by slicing.
    const chainEnvKey = (chainConfig.key || "").toUpperCase();
    const warmSweepSlices = Math.max(
      1,
      parseInt(
        (chainEnvKey && process.env[`${chainEnvKey}_WARM_SWEEP_SLICES`]) || process.env.WARM_SWEEP_SLICES || "1",
        10
      ) || 1
    );
    const minDebtUsd = resolveChainMinDebtUsd(chainConfig);
    const chainKey = chainConfig.key || "default";

    // Phase 1: STRATIFIED + BATCHED health-factor sweep, three tiers by cost.
    //
    // Checking every ever-borrowed wallet every cycle does not scale (Base has
    // ~210k ever-borrowed, but only a few thousand carry debt right now). All
    // reads go through Multicall3 and STREAM batch-by-batch (flat heap), so the
    // tiers are about RPC time, not memory:
    //   - WATCHLIST (every cycle): wallets last seen with HF < WATCHLIST_HF and
    //     non-dust debt — tiny, fast; this is where liquidations actually come from.
    //   - WARM / "full" (every FULL_SWEEP_EVERY_N cycles, or watchlist empty):
    //     the active-debt index (wallets observed with totalDebtBase > 0). This
    //     refreshes the watchlist from the only wallets that could ever be
    //     liquidatable, at a fraction of the all-borrower cost.
    //   - COLD (every COLD_SWEEP_EVERY_N warm sweeps, or index empty): the entire
    //     borrower set. The only sweep that pays the full ~210k cost; it rebuilds
    //     the active-debt index to catch wallets that took on debt without a
    //     Borrow event we'd see incrementally.
    const { watch, cyclesSinceFullSweep } = loadWatchlist(chainKey);
    const { near } = loadNear(chainKey);
    const { active, warmSweepsSinceCold, lastColdAt } = loadActiveDebt(chainKey);

    // On a watchlist/warm cycle, also include borrowers discovered THIS cycle by
    // the incremental Borrow scan — a freshly-opened risky position should be
    // health-checked now, not delayed up to FULL_SWEEP_EVERY_N cycles.
    const newThisScan = borrowers.newThisScan instanceof Set ? borrowers.newThisScan : new Set();

    // COLD is also forced when the active-debt index is older than COLD_MAX_AGE_MIN,
    // so a stale index (and the whales that borrowed since) can't linger unseen
    // between counter-driven cold sweeps. A never-run index (lastColdAt null) and a
    // failed timestamp parse both read as stale → due now.
    const coldAgeMs = lastColdAt ? Date.now() - Date.parse(lastColdAt) : Infinity;
    const coldStale = coldMaxAgeMin > 0 && !(coldAgeMs >= 0 && coldAgeMs < coldMaxAgeMin * 60_000);
    const needFullSweep = watch.size === 0 || cyclesSinceFullSweep >= fullSweepEveryN || coldStale;
    const doColdSweep =
      (needFullSweep && (active.size === 0 || warmSweepsSinceCold >= coldSweepEveryN)) ||
      (coldStale && active.size > 0);
    const doWarmSweep = needFullSweep && !doColdSweep;
    const sweepType = doColdSweep ? "COLD" : doWarmSweep ? "WARM" : "watchlist";

    let sweepSet;
    if (doColdSweep) {
      sweepSet = borrowers;
    } else if (doWarmSweep) {
      // WARM = re-scan the active-debt index to catch wallets that crossed toward
      // liquidation since the last full sweep. On a large index (Base ~60k) doing
      // it all in one cycle stalls 90s–7min and starves the every-cycle tiers, so
      // optionally take one rotating slice of the index per warm cycle. Across
      // `warmSweepSlices` warm cycles every wallet is covered; since warm only
      // UNIONS into the index (never prunes — only COLD prunes), a sliced pass is
      // equivalent to one big warm sweep, just spread out.
      let warmSlice = active;
      if (warmSweepSlices > 1 && active.size > 0) {
        // Deterministic, stable rotation: sort the index and walk contiguous slices
        // indexed by warmSweepsSinceCold, so successive warm cycles cover disjoint
        // parts and wrap cleanly. (Sorting ~60k strings is sub-ms vs the RPC sweep.)
        const ordered = Array.from(active).sort();
        const sliceIdx = warmSweepsSinceCold % warmSweepSlices;
        const per = Math.ceil(ordered.length / warmSweepSlices);
        warmSlice = ordered.slice(sliceIdx * per, sliceIdx * per + per);
      }
      // Always union the hot every-cycle tiers (watchlist ∪ near ∪ freshly-
      // discovered) so slicing never delays detection of an at-risk wallet, and so
      // nextWatch/nextNear stay authoritative for the wallets they must own.
      const warmSet = new Set(warmSlice);
      for (const w of watch) warmSet.add(w);
      for (const n of near) warmSet.add(n);
      for (const b of newThisScan) warmSet.add(b);
      sweepSet = Array.from(warmSet);
    } else {
      // Every-cycle (watchlist) sweep: the hot watchlist UNION the wider non-dust
      // "near" mid-tier UNION freshly-discovered borrowers. Including `near` is the
      // fix for the watchlist-gap: a non-dust wallet in the 1.25–1.5 band is now
      // re-checked every cycle, so if it drops below 1.0 between full sweeps we see
      // it the cycle it crosses instead of waiting up to FULL_SWEEP_EVERY_N cycles.
      sweepSet = borrowers.filter((b) => {
        const key = b.toLowerCase();
        return watch.has(key) || near.has(key) || newThisScan.has(key);
      });
    }
    if (!doColdSweep && newThisScan.size > 0) {
      console.log(`   ↳ ${chainConfig.name}: +${newThisScan.size} newly-discovered borrower(s) added to this sweep.`);
    }

    console.log(
      `✅ ${chainConfig.name}: ${sweepType} HF sweep of ${sweepSet.length}` +
        ` (known ${borrowers.length}, active-debt ${active.size}, watch ${watch.size},` +
        ` cyclesSinceFull ${cyclesSinceFullSweep}, warmSinceCold ${warmSweepsSinceCold}).`
    );

    const t0 = Date.now();

    // STREAMING fold: instead of materializing one { user, hf, debt } object per
    // borrower (fatal on Base's ~210k set — three full-size arrays at once blew
    // V8's heap), the sweep hands us one decoded result at a time and we fold it
    // straight into the only things we keep: the next watchlist and the unhealthy
    // candidate list. Both stay tiny (near-threshold-with-debt wallets are a few
    // hundred; HF<1-with-debt candidates are typically single digits), so peak
    // heap is O(batchSize + watchlist + candidates), independent of borrower count.
    //
    //   nextWatch  — wallets still near threshold (HF < WATCHLIST_HF) AND carrying
    //                non-dust debt (>= minDebtUsd). On a full sweep this is the new
    //                truth; on a watchlist-only sweep, recovered wallets drop out
    //                and the next full sweep re-adds new ones. We never re-check a
    //                $5 position every cycle when we'd never liquidate it.
    //   candidates — genuinely-unhealthy (HF < threshold), non-dust positions to
    //                enrich + attempt, sorted lowest-HF-first (most urgent / most
    //                contested) below.
    const nextWatch = new Set();
    const nextNear = new Set(); // wider non-dust mid-tier (HF < nearHf), swept every cycle
    const candidates = [];
    let belowThreshold = 0;
    // Active-debt wallets observed THIS sweep (totalDebtUsd > 0). On a cold sweep
    // this becomes the new active-debt index (the truth for "who has debt"); on a
    // warm sweep it's used to prune wallets that fully repaid.
    const nextActive = new Set();

    // On a long full sweep (Base ~210k cold), persist the partial watchlist every
    // N batches so a crash/restart mid-sweep keeps the near-threshold wallets
    // found so far instead of leaving an empty file — which is exactly what
    // trapped Base in a restart loop (watchlist-base.json never existed). We
    // checkpoint with cyclesSinceFullSweep = fullSweepEveryN so a partial sweep is
    // treated as INCOMPLETE and redone next start; only the clean post-sweep save
    // resets to 0. Watchlist cycles are tiny and skip checkpointing. Progress logs
    // gated by VERBOSE_HEALTH_LOGS.
    const checkpointEveryBatches = parseInt(process.env.SWEEP_CHECKPOINT_BATCHES || "50", 10);
    const batchSize = parseInt(process.env.MULTICALL_BATCH_SIZE || "300", 10);
    let lastCheckpointBatch = 0;

    await sweepHealthFactorsStreaming(
      sweepSet,
      provider,
      chainConfig,
      ({ user, healthFactor, totalDebtUsd }) => {
        if (!Number.isFinite(healthFactor)) return;
        if (totalDebtUsd > 0) {
          nextActive.add(user.toLowerCase());
        }
        if (totalDebtUsd >= minDebtUsd) {
          const key = user.toLowerCase();
          if (healthFactor < watchlistHf) nextWatch.add(key);
          // The near tier is the wider band (watchlistHf ≤ HF < nearHf, plus it
          // also includes everything in the watchlist band). Anything non-dust
          // under nearHf is worth re-checking every cycle.
          if (healthFactor < nearHf) nextNear.add(key);
          // Fix 2: a freshly-discovered borrower with real debt enters the
          // every-cycle near tier regardless of HF, so a wallet that opens
          // healthy (e.g. HF 1.4) is still re-checked every cycle for its first
          // window instead of dropping to COLD-only and going unseen when a price
          // move pushes it under 1.0. It ages out of `near` naturally once it
          // recovers above nearHf on a later sweep (nextNear is authoritative).
          if (newThisScan.has(key)) nextNear.add(key);
        }
        if (healthFactor < threshold) {
          belowThreshold++;
          if (totalDebtUsd >= minDebtUsd) {
            candidates.push({ user, healthFactor, totalDebtUsd });
          }
        }
      },
      {
        onBatchDone: needFullSweep
          ? (sweptSoFar) => {
              const batchNum = Math.ceil(sweptSoFar / batchSize);
              if (sweptSoFar < sweepSet.length && batchNum - lastCheckpointBatch >= checkpointEveryBatches) {
                lastCheckpointBatch = batchNum;
                saveWatchlist(chainKey, nextWatch, fullSweepEveryN);
                saveNear(chainKey, nextNear);
                logVerbose(`   …${chainConfig.name}: ${sweepType} checkpoint ${sweptSoFar}/${sweepSet.length} (watch ${nextWatch.size}, near ${nextNear.size}, active ${nextActive.size}).`);
              }
            }
          : undefined,
      }
    );

    if (!needFullSweep) {
      // Watchlist cycle: preserve watchlist members we didn't just re-check
      // (shouldn't happen — sweepSet ⊇ watch here — but be safe).
      for (const w of watch) {
        if (!nextWatch.has(w)) nextWatch.add(w);
      }
    }
    saveWatchlist(chainKey, nextWatch, needFullSweep ? 0 : cyclesSinceFullSweep + 1);

    // Persist the near mid-tier. On every cycle type, `near` members are part of
    // sweepSet (watchlist cycle) or a superset (warm/cold), so nextNear is
    // authoritative — recovered wallets correctly drop out, still-near ones stay.
    // Only write when it changed, to avoid rewriting a multi-thousand-entry file
    // every 15s when nothing moved.
    if (!setsEqual(nextNear, near)) {
      saveNear(chainKey, nextNear);
    }

    // Maintain the active-debt index. Only the COLD sweep — which reads every
    // borrower — can authoritatively DROP a wallet (it's the only sweep that can
    // distinguish "repaid" from "not in this sweep set"). Warm/watchlist sweeps
    // only UNION newly-seen-with-debt wallets in; they never prune, because a
    // wallet absent from nextActive on those sweeps just wasn't swept (or had a
    // transient failed read), not necessarily debt-free. This keeps the index
    // from eroding to the hot subset between cold sweeps.
    //   COLD: replace with the complete truth; reset the cold-sweep counter.
    //   WARM: union in new debt holders; bump warmSweepsSinceCold toward the next
    //         cold sweep that will prune.
    //   WATCHLIST: union in new debt holders (e.g. a new borrower); counter unchanged.
    if (doColdSweep) {
      // COLD is the authoritative rebuild — stamp it so the time-based floor
      // measures freshness from this moment.
      saveActiveDebt(chainKey, nextActive, 0, new Date().toISOString());
    } else {
      // Union new debt holders into the index. Warm sweeps always persist (the
      // counter advances); watchlist cycles persist only when they actually add
      // a wallet, so we don't rewrite Base's multi-thousand-entry index every
      // cycle for no change. Carry lastColdAt forward unchanged — only COLD
      // refreshes it.
      const merged = new Set(active);
      let added = 0;
      for (const a of nextActive) { if (!merged.has(a)) { merged.add(a); added++; } }
      if (doWarmSweep) {
        saveActiveDebt(chainKey, merged, warmSweepsSinceCold + 1, lastColdAt);
      } else if (added > 0) {
        saveActiveDebt(chainKey, merged, warmSweepsSinceCold, lastColdAt);
      }
    }

    // Attempt the most urgent (lowest HF) first — those are the ones a competing
    // bot is also racing for.
    candidates.sort((a, b) => a.healthFactor - b.healthFactor);

    console.log(`✅ ${chainConfig.name}: swept ${sweepSet.length} HFs in ${Date.now() - t0}ms; ${belowThreshold} below ${threshold}, ${candidates.length} above $${minDebtUsd} debt; watchlist now ${nextWatch.size}, near ${nextNear.size}.`);
    metrics.emit("sweep", {
      chain: chainConfig.key, type: sweepType, swept: sweepSet.length,
      sweepMs: Date.now() - t0, below: belowThreshold, candidates: candidates.length,
      watch: nextWatch.size, near: nextNear.size,
    });

    // Phase 2: enrich only the unhealthy, non-dust candidates (debt + collateral
    // lookups are heavier, so we do them on the short list, in priority order).
    //
    // Each candidate's per-reserve debt/collateral reads are collapsed into ONE
    // Multicall3 batch (enrichCandidateBatched), and candidates are enriched
    // CONCURRENTLY (mapWithConcurrency) instead of one-at-a-time. When several
    // positions go liquidatable in the same block, "found N → ready on all N" is
    // near-instant rather than N serial chains of RPC calls — the lowest-HF
    // target (the one every bot is racing for) is no longer stuck behind the
    // enrichment of the ones below it. Results are reassembled in the original
    // lowest-HF-first priority order.
    const minDebtToCover = parseFloat(process.env.MIN_DEBT_TO_COVER || "0.099");
    const enrichConcurrency = parseInt(process.env.ENRICH_CONCURRENCY || "10", 10);
    const reserves = chainConfig.protocolDataProvider
      ? await getReservesListCached(provider, chainConfig)
      : [];

    const enriched = await mapWithConcurrency(candidates, enrichConcurrency, async ({ user, healthFactor, totalDebtUsd }) => {
      let position;
      try {
        position = await enrichCandidateBatched(user, provider, chainConfig, reserves);
      } catch (error) {
        console.warn(`⚠️ Enrichment failed for ${user}: ${error.message}`);
        return null;
      }
      if (!position) {
        // No remaining debt or no valid collateral — mirrors the prior skips.
        console.log(`⚠️ Skipping ${user}: no remaining debt or no valid collateral.`);
        return null;
      }

      const { debtAsset, debtAmount, debtDecimals, debtSymbol, collateralAsset } = position;
      console.log(`👀 ${user}: HF ${healthFactor.toFixed(4)}, ~$${totalDebtUsd.toFixed(0)} total debt; primary ${ethers.utils.formatUnits(debtAmount, debtDecimals)} ${debtSymbol}`);

      // Secondary per-asset floor (token units) as a backstop.
      const debtInUnits = parseFloat(ethers.utils.formatUnits(debtAmount, debtDecimals));
      if (debtInUnits < minDebtToCover) {
        console.log(`⚠️ Skipping ${user}: Debt too small (${debtInUnits} ${debtSymbol} < ${minDebtToCover}).`);
        return null;
      }

      console.log(`🔥 Found liquidatable position: ${user} | HF: ${healthFactor} | Debt: ${ethers.utils.formatUnits(debtAmount, debtDecimals)} ${debtSymbol}`);
      return {
        user,
        debtAsset,
        debtAmount,
        debtDecimals,
        debtSymbol,
        collateralAsset,
        healthFactor,
        totalDebtUsd,
      };
    });

    // candidates was already sorted lowest-HF-first; mapWithConcurrency preserves
    // input order, so filtering nulls keeps that priority ordering.
    const unhealthyPositions = enriched.filter(Boolean);

    console.log(`📌 Found ${unhealthyPositions.length} liquidatable positions.`);
    return unhealthyPositions;
  }

async function getReservesList(provider, chainConfig = {}) {
    const pool = new ethers.Contract(getPoolAddress(chainConfig), POOL_ABI, provider);
    return pool.getReservesList();
}

// Cached reserves list. The set of reserves changes only when Aave governance
// lists/drops one, so re-fetching it for every candidate during a liquidation
// race is wasted round-trips. Cached per chain with a long TTL; refreshes lazily.
async function getReservesListCached(provider, chainConfig = {}) {
    const chainKey = chainConfig.key || "default";
    const cached = reservesListCache.get(chainKey);
    if (cached && Date.now() - cached.fetchedAt < RESERVES_CACHE_TTL_MS) {
      return cached.reserves;
    }
    const reserves = await getReservesList(provider, chainConfig);
    reservesListCache.set(chainKey, { reserves, fetchedAt: Date.now() });
    return reserves;
}

// Cached ERC-20 metadata (symbol/decimals are immutable). The configured debt
// asset short-circuits without an RPC call (matches getAssetMetadata's behavior).
async function getAssetMetadataCached(asset, provider, chainConfig = {}) {
    const chainKey = chainConfig.key || "default";
    const cacheKey = `${chainKey}:${asset.toLowerCase()}`;
    const cached = assetMetaCache.get(cacheKey);
    if (cached) return cached;
    const meta = await getAssetMetadata(asset, provider, chainConfig);
    assetMetaCache.set(cacheKey, meta);
    return meta;
}

// Enriches ONE candidate (debt + collateral) using a single Multicall3 batch of
// getUserReserveData across all reserves, instead of one serial RPC per reserve.
// Returns { debtAsset, debtAmount, debtDecimals, debtSymbol, collateralAsset } or
// null if the user has no positive debt or no valid collateral. `reserves` is the
// (cached) reserves list, passed in so a batch of candidates shares one fetch.
//
// Debt selection mirrors getPrimaryDebtPosition: prefer the chain's configured
// debt asset if the user owes it, else the largest debt position. Collateral
// selection mirrors getPrimaryCollateral: the largest aToken balance with
// usageAsCollateralEnabled. Both are derived from the SAME batched read.
async function enrichCandidateBatched(user, provider, chainConfig, reserves) {
    if (!chainConfig.protocolDataProvider || !Array.isArray(reserves) || reserves.length === 0) {
      // No data provider (subgraph-only chain) or no reserves — fall back to the
      // original serial path so behavior is preserved on those configs.
      const debtPosition = await getPrimaryDebtPosition(user, provider, chainConfig);
      if (debtPosition.debtAmount.lte(ethers.constants.Zero)) return null;
      const collateralAsset = await getPrimaryCollateral(user, provider, chainConfig);
      if (!collateralAsset) return null;
      return {
        debtAsset: debtPosition.debtAsset,
        debtAmount: debtPosition.debtAmount,
        debtDecimals: debtPosition.debtDecimals,
        debtSymbol: debtPosition.debtSymbol,
        collateralAsset,
      };
    }

    const dpAddress = chainConfig.protocolDataProvider;
    const calls = reserves.map((asset) => ({
      target: dpAddress,
      allowFailure: true,
      callData: DATA_PROVIDER_IFACE.encodeFunctionData("getUserReserveData", [asset, user]),
    }));

    const batchSize = parseInt(process.env.MULTICALL_BATCH_SIZE || "300", 10);
    const raw = await aggregate3InBatches(provider, calls, batchSize);

    const preferredDebt = (chainConfig.debtAssetAddress || process.env.DEBT_ASSET_ADDRESS || "").toLowerCase();
    let preferredDebtEntry = null; // { asset, debtAmount }
    let bestDebtEntry = null; // largest non-preferred debt as fallback
    let bestCollateral = null; // { asset, balance }

    for (let i = 0; i < reserves.length; i++) {
      const asset = reserves[i];
      const entry = raw[i];
      if (!entry || !entry.success || !entry.returnData || entry.returnData === "0x") continue;
      let decoded;
      try {
        decoded = DATA_PROVIDER_IFACE.decodeFunctionResult("getUserReserveData", entry.returnData);
      } catch (_) {
        continue;
      }

      const debtAmount = decoded.currentStableDebt.add(decoded.currentVariableDebt);
      if (debtAmount.gt(ethers.constants.Zero)) {
        if (asset.toLowerCase() === preferredDebt) {
          preferredDebtEntry = { asset, debtAmount };
        } else if (!bestDebtEntry || debtAmount.gt(bestDebtEntry.debtAmount)) {
          bestDebtEntry = { asset, debtAmount };
        }
      }

      if (
        decoded.currentATokenBalance.gt(ethers.constants.Zero) &&
        decoded.usageAsCollateralEnabled &&
        (!bestCollateral || decoded.currentATokenBalance.gt(bestCollateral.balance))
      ) {
        bestCollateral = { asset, balance: decoded.currentATokenBalance };
      }
    }

    const chosenDebt = preferredDebtEntry || bestDebtEntry;
    if (!chosenDebt) return null; // no positive debt
    if (!bestCollateral) return null; // no valid collateral

    const meta = await getAssetMetadataCached(chosenDebt.asset, provider, chainConfig);
    return {
      debtAsset: chosenDebt.asset,
      debtAmount: chosenDebt.debtAmount,
      debtDecimals: meta.decimals,
      debtSymbol: meta.symbol,
      collateralAsset: bestCollateral.asset,
    };
}

async function getUserReservePositions(userAddress, provider, chainConfig = {}) {
    const reserves = await getReservesListCached(provider, chainConfig);
    const positions = [];

    for (const asset of reserves) {
      try {
        const reserveData = await getUserReserveData(asset, userAddress, provider, chainConfig);
        positions.push({
          asset,
          ...reserveData,
        });
      } catch (error) {
        console.warn(`⚠️ Failed to fetch reserve data for ${userAddress} on ${asset}: ${error.message}`);
      }
    }

    return positions;
}

async function getUserReserveData(asset, userAddress, provider, chainConfig = {}) {
    const dataProvider = new ethers.Contract(
      chainConfig.protocolDataProvider,
      PROTOCOL_DATA_PROVIDER_ABI,
      provider
    );
    const data = await dataProvider.getUserReserveData(asset, userAddress);

    return {
      currentATokenBalance: data.currentATokenBalance,
      currentStableDebt: data.currentStableDebt,
      currentVariableDebt: data.currentVariableDebt,
      principalStableDebt: data.principalStableDebt,
      scaledVariableDebt: data.scaledVariableDebt,
      stableBorrowRate: data.stableBorrowRate,
      liquidityRate: data.liquidityRate,
      stableRateLastUpdated: data.stableRateLastUpdated,
      usageAsCollateralEnabled: data.usageAsCollateralEnabled,
    };
}

async function getAssetMetadata(asset, provider, chainConfig = {}) {
    if (asset.toLowerCase() === (chainConfig.debtAssetAddress || "").toLowerCase()) {
      return {
        symbol: chainConfig.debtSymbol || "debt asset",
        decimals: 6,
      };
    }

    const token = new ethers.Contract(asset, ERC20_METADATA_ABI, provider);
    const [symbol, decimals] = await Promise.all([
      token.symbol().catch(() => "asset"),
      token.decimals().catch(() => 18),
    ]);

    return {
      symbol,
      decimals: Number(decimals),
    };
}

function getPoolAddress(chainConfig = {}) {
    return chainConfig.pool || process.env.POOL_ADDRESS;
}

function getSubgraphUrl(chainConfig = {}) {
    return chainConfig.subgraphUrl || process.env.SUBGRAPH_URL || DEFAULT_SUBGRAPH_URL;
}

// Per-chain USD debt floor for what's worth liquidating, used both as the
// watchlist/candidate dust filter and (via the bot) the practice-mode gate.
// Resolution: <CHAIN>_MIN_DEBT_USD env override → global MIN_DEBT_USD → $100.
// Lets cheap chains (Avalanche/Optimism) work smaller positions without lowering
// the floor on Base/Arbitrum, where gas makes small liquidations unprofitable.
function resolveChainMinDebtUsd(chainConfig = {}) {
    const key = (chainConfig.key || "").toUpperCase();
    // Try per-chain, then global, then default — each only if it parses to a
    // valid non-negative number, so a malformed per-chain override falls through
    // to the global rather than silently snapping to the hardcoded default.
    const candidates = [key ? process.env[`${key}_MIN_DEBT_USD`] : undefined, process.env.MIN_DEBT_USD, "100"];
    for (const raw of candidates) {
      if (raw === undefined || raw === null || raw === "") continue;
      const v = parseFloat(raw);
      if (Number.isFinite(v) && v >= 0) return v;
    }
    return 100;
}

// Per-chain near-tier HF ceiling: <CHAIN>_NEAR_HF → NEAR_HF → default 1.8.
// Floored at `watchlistHf` so the near tier is never narrower than the watchlist
// (≤ watchlistHf effectively disables the extra mid-tier — watch already covers it).
// Default widened 1.5 → 1.8 (Fix 3): wallets in the 1.5–1.8 band can cross to
// liquidation in a single volatile move, so re-checking them every cycle (instead
// of only on the slow warm/cold sweep) closes the window where a healthy-ish whale
// drops under 1.0 unseen. The near tier is still debt-floored, so this only widens
// the set of *non-dust* wallets watched — cost scales with real positions, not the
// 210k borrower set.
function resolveChainNearHf(chainConfig = {}, watchlistHf = 1.25) {
    const key = (chainConfig.key || "").toUpperCase();
    const candidates = [key ? process.env[`${key}_NEAR_HF`] : undefined, process.env.NEAR_HF, "1.8"];
    for (const raw of candidates) {
      if (raw === undefined || raw === null || raw === "") continue;
      const v = parseFloat(raw);
      if (Number.isFinite(v) && v > 0) return Math.max(v, watchlistHf);
    }
    return Math.max(1.8, watchlistHf);
}

// Cheap Set equality (used to skip rewriting the near file when unchanged).
function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Off-chain V3 swap-path resolver (task 3.3)
//
// Builds the standard packed V3 path the contract's exactInput consumes: a DIRECT
// pool across the common fee tiers [100,500,3000,10000], else a 2-HOP via each
// intermediate (the contract seeds wrappedNative; the deploy script adds
// chainConfig.swapIntermediates). Returns packed bytes
// (tokenIn|fee|tokenOut or tokenIn|fee1|mid|fee2|tokenOut), or "0x" if no path is
// found (caller then lets the contract self-resolve / skips).
//
// IMPORTANT: this is STRICTLY BETTER than the contract's on-chain _findFeeTier,
// which returns the FIRST tier where getPool != 0 — even if that pool has ZERO
// liquidity (verified on Base: e.g. cbETH/USDC, weETH/USDC, WETH/GHO all have an
// empty 100bps pool, so the on-chain path would route through a dead pool and
// revert). Off-chain we additionally read pool.liquidity() and pick the tier with
// the MOST current-tick liquidity, skipping empty pools. Passing this path in
// calldata is what makes those liquidations executable at all. The contract still
// enforces the profit floor at amountOutMinimum, so a path that can't fill the
// size reverts cheaply.
//
// Read-only; results cached per (chain, tokenIn, tokenOut). The factory is read
// once per chain from the configured swapRouter.
// ---------------------------------------------------------------------------
const V3_FACTORY_IFACE = new ethers.utils.Interface([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);
const V3_POOL_LIQ_IFACE = new ethers.utils.Interface([
  "function liquidity() view returns (uint128)",
]);
const ROUTER_FACTORY_IFACE = new ethers.utils.Interface([
  "function factory() view returns (address)",
]);
const COMMON_FEE_TIERS = [100, 500, 3000, 10000]; // matches contract constructor
const factoryAddrCache = new Map(); // chainKey -> factory address (or null)
const poolFeeCache = new Map(); // `${chainKey}:${a}:${b}` -> fee (0 = none, cached)

async function getRouterFactory(provider, chainConfig) {
  const key = chainConfig.key || "default";
  if (factoryAddrCache.has(key)) return factoryAddrCache.get(key);
  let factory = null;
  try {
    const router = new ethers.Contract(chainConfig.swapRouter, ROUTER_FACTORY_IFACE, provider);
    factory = await router.factory();
  } catch (_) {
    factory = null;
  }
  factoryAddrCache.set(key, factory);
  return factory;
}

// Returns the common fee tier whose pool has the MOST current-tick liquidity for
// (a,b) — skipping tiers with no pool or zero liquidity — or 0 if none usable.
async function findFeeTier(provider, chainConfig, factory, a, b) {
  const key = `${chainConfig.key || "default"}:${a.toLowerCase()}:${b.toLowerCase()}`;
  if (poolFeeCache.has(key)) return poolFeeCache.get(key);
  const f = new ethers.Contract(factory, V3_FACTORY_IFACE, provider);
  let bestFee = 0;
  let bestLiq = ethers.constants.Zero;
  for (const fee of COMMON_FEE_TIERS) {
    let pool;
    try {
      pool = await f.getPool(a, b, fee);
    } catch (_) {
      // V2 factory or unsupported selector — treat as no pool at this tier.
      continue;
    }
    if (!pool || pool === ethers.constants.AddressZero) continue;
    let liq;
    try {
      liq = await new ethers.Contract(pool, V3_POOL_LIQ_IFACE, provider).liquidity();
    } catch (_) {
      continue; // not a readable V3 pool
    }
    if (liq.gt(bestLiq)) { bestLiq = liq; bestFee = fee; }
  }
  poolFeeCache.set(key, bestFee);
  return bestFee;
}

function packPath(parts) {
  // parts: [token, fee, token, fee, token, ...] — tokens as 20-byte addrs, fees
  // as uint24. ethers.utils.solidityPack == abi.encodePacked.
  const types = parts.map((_, i) => (i % 2 === 0 ? "address" : "uint24"));
  return ethers.utils.solidityPack(types, parts);
}

// Resolve the packed V3 path for collateral->debt. Returns "0x" if unresolved.
async function resolveSwapPath(provider, chainConfig, tokenIn, tokenOut) {
  if (!tokenIn || !tokenOut || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return "0x";
  const factory = await getRouterFactory(provider, chainConfig);
  if (!factory) return "0x";

  const directFee = await findFeeTier(provider, chainConfig, factory, tokenIn, tokenOut);
  if (directFee !== 0) return packPath([tokenIn, directFee, tokenOut]);

  // 2-hop via intermediates: contract seeds wrappedNative, deploy adds
  // swapIntermediates. Dedupe and skip if intermediate == in/out (contract does).
  const intermediates = [];
  for (const t of [chainConfig.wrappedNative, ...(chainConfig.swapIntermediates || [])]) {
    if (!t) continue;
    const lc = t.toLowerCase();
    if (lc === tokenIn.toLowerCase() || lc === tokenOut.toLowerCase()) continue;
    if (!intermediates.some((x) => x.toLowerCase() === lc)) intermediates.push(t);
  }
  for (const mid of intermediates) {
    const firstFee = await findFeeTier(provider, chainConfig, factory, tokenIn, mid);
    if (firstFee === 0) continue;
    const secondFee = await findFeeTier(provider, chainConfig, factory, mid, tokenOut);
    if (secondFee === 0) continue;
    return packPath([tokenIn, firstFee, mid, secondFee, tokenOut]);
  }
  return "0x";
}

  module.exports = {
    getUnhealthyPositions,
    resolveSwapPath,
    getUserHealthFactor,
    getUserHealthFactorsBatched,
    sweepHealthFactorsStreaming,
    getDebtAmount,
    getDebtPosition,
    getDebtPositions,
    getPrimaryDebtPosition,
    getBorrowers,
    getBorrowersFromBorrowEvents,
    getBorrowersFromSubgraph,
    getReservesList,
    getReservesListCached,
    getPrimaryCollateral,
    enrichCandidateBatched,
    resolveChainMinDebtUsd,
    // ...other exports as needed
  };
