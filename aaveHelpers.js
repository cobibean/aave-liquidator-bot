const { ethers } = require('ethers');
const fetch = require("node-fetch");
const { loadBorrowerSet, saveBorrowerSet, loadWatchlist, saveWatchlist } = require("./src/borrowerStore");
const { aggregate3InBatches } = require("./src/multicall");

// Interface used to encode/decode getUserAccountData calls for Multicall3.
const POOL_IFACE = new ethers.utils.Interface([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

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

  return users.map((user, i) => {
    const entry = raw[i];
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
  });
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
        getAssetMetadata(debtAssetAddress, provider, chainConfig),
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

    const reserves = await getReservesList(provider, chainConfig);
    const debtPositions = [];

    for (const asset of reserves) {
      try {
        const [reserveData, metadata] = await Promise.all([
          getUserReserveData(asset, userAddress, provider, chainConfig),
          getAssetMetadata(asset, provider, chainConfig),
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
    const fullSweepEveryN = parseInt(process.env.FULL_SWEEP_EVERY_N || "20", 10);
    const minDebtUsd = parseFloat(process.env.MIN_DEBT_USD || "100");
    const chainKey = chainConfig.key || "default";

    // Phase 1: STRATIFIED + BATCHED health-factor sweep.
    //
    // Checking every borrower every cycle does not scale — a full sweep of
    // Base's ~6.6k borrowers took ~17 min on the droplet. Instead:
    //   - Every cycle: sweep only the "watchlist" (wallets last seen with
    //     HF < WATCHLIST_HF) — small and fast, this is where liquidations come from.
    //   - Every FULL_SWEEP_EVERY_N cycles (or when the watchlist is empty/first
    //     run): sweep the full borrower set to refresh the watchlist.
    // All reads go through Multicall3 so even the full sweep is a few RPC calls.
    const { watch, cyclesSinceFullSweep } = loadWatchlist(chainKey);
    const doFullSweep = watch.size === 0 || cyclesSinceFullSweep >= fullSweepEveryN;

    // On a watchlist cycle, also include any borrowers discovered THIS cycle by
    // the incremental scan — otherwise a freshly-opened risky position would not
    // be health-checked until the next full sweep (up to FULL_SWEEP_EVERY_N cycles).
    const newThisScan = borrowers.newThisScan instanceof Set ? borrowers.newThisScan : new Set();
    const sweepSet = doFullSweep
      ? borrowers
      : borrowers.filter((b) => {
          const key = b.toLowerCase();
          return watch.has(key) || newThisScan.has(key);
        });
    if (!doFullSweep && newThisScan.size > 0) {
      console.log(`   ↳ ${chainConfig.name}: +${newThisScan.size} newly-discovered borrower(s) added to this sweep.`);
    }

    console.log(
      `✅ ${chainConfig.name}: ${doFullSweep ? "FULL" : "watchlist"} HF sweep of ${sweepSet.length}` +
        ` (known ${borrowers.length}, watch ${watch.size}, cyclesSinceFull ${cyclesSinceFullSweep}).`
    );

    const t0 = Date.now();
    const hfResults = await getUserHealthFactorsBatched(sweepSet, provider, chainConfig);

    // Rebuild the watchlist from this sweep. On a full sweep this is the new
    // truth. On a watchlist-only sweep we keep wallets that are still near
    // threshold (drop any that recovered) — the next full sweep re-adds new ones.
    // Watchlist membership also requires non-dust debt (>= minDebtUsd): there's
    // no point re-checking a $5 position every cycle when we'd never liquidate it.
    // This keeps the hot path small even when the borrower set is huge (measured:
    // unfiltered watchlist was 1,340 on Arbitrum; debt-filtered it is far smaller).
    const nextWatch = new Set();
    for (const { user, healthFactor, totalDebtUsd } of hfResults) {
      if (Number.isFinite(healthFactor) && healthFactor < watchlistHf && totalDebtUsd >= minDebtUsd) {
        nextWatch.add(user.toLowerCase());
      }
    }
    if (!doFullSweep) {
      // Preserve watchlist members we didn't just re-check (shouldn't happen,
      // sweepSet == watch here, but be safe) so we don't silently forget them.
      for (const w of watch) {
        if (!sweepSet.includes(w) && !nextWatch.has(w)) nextWatch.add(w);
      }
    }
    saveWatchlist(chainKey, nextWatch, doFullSweep ? 0 : cyclesSinceFullSweep + 1);

    // Keep only genuinely-unhealthy positions and attempt the most urgent
    // (lowest HF) first — those are the ones a competing bot is also racing for.
    // Apply the USD dust floor HERE using totalDebtBase from the same sweep: most
    // real liquidations are sub-$100 dust where gas exceeds the bonus, so we drop
    // them before doing any expensive per-user enrichment.
    const candidates = hfResults
      .filter((entry) => Number.isFinite(entry.healthFactor) && entry.healthFactor < threshold)
      .filter((entry) => entry.totalDebtUsd >= minDebtUsd)
      .sort((a, b) => a.healthFactor - b.healthFactor);

    const belowThreshold = hfResults.filter((e) => Number.isFinite(e.healthFactor) && e.healthFactor < threshold).length;
    console.log(`✅ ${chainConfig.name}: swept ${sweepSet.length} HFs in ${Date.now() - t0}ms; ${belowThreshold} below ${threshold}, ${candidates.length} above $${minDebtUsd} debt; watchlist now ${nextWatch.size}.`);

    // Phase 2: enrich only the unhealthy, non-dust candidates (debt + collateral
    // lookups are heavier, so we do them on the short list, in priority order).
    const minDebtToCover = parseFloat(process.env.MIN_DEBT_TO_COVER || "0.099");
    const unhealthyPositions = [];

    for (const { user, healthFactor, totalDebtUsd } of candidates) {
      const debtPosition = await getPrimaryDebtPosition(user, provider, chainConfig);
      const debtAsset = debtPosition.debtAsset;
      const debtAmount = debtPosition.debtAmount;

      console.log(`👀 ${user}: HF ${healthFactor.toFixed(4)}, ~$${totalDebtUsd.toFixed(0)} total debt; primary ${ethers.utils.formatUnits(debtAmount, debtPosition.debtDecimals)} ${debtPosition.debtSymbol}`);
      if (debtAmount.eq(ethers.constants.Zero)) {
        console.log(`⚠️ Skipping ${user}: No remaining debt.`);
        continue;
      }

      // Secondary per-asset floor (token units) as a backstop.
      const debtInUnits = parseFloat(ethers.utils.formatUnits(debtAmount, debtPosition.debtDecimals));
      if (debtInUnits < minDebtToCover) {
        console.log(`⚠️ Skipping ${user}: Debt too small (${debtInUnits} ${debtPosition.debtSymbol} < ${minDebtToCover}).`);
        continue;
      }

      const collateralAsset = await getPrimaryCollateral(user, provider, chainConfig);
      if (!collateralAsset) {
        console.warn(`⚠️ Skipping ${user}: No valid collateral.`);
        continue;
      }

      unhealthyPositions.push({
        user,
        debtAsset,
        debtAmount,
        debtDecimals: debtPosition.debtDecimals,
        debtSymbol: debtPosition.debtSymbol,
        collateralAsset,
        healthFactor,
        totalDebtUsd,
      });

      console.log(`🔥 Found liquidatable position: ${user} | HF: ${healthFactor} | Debt: ${ethers.utils.formatUnits(debtAmount, debtPosition.debtDecimals)} ${debtPosition.debtSymbol}`);
    }

    console.log(`📌 Found ${unhealthyPositions.length} liquidatable positions.`);
    return unhealthyPositions;
  }

async function getReservesList(provider, chainConfig = {}) {
    const pool = new ethers.Contract(getPoolAddress(chainConfig), POOL_ABI, provider);
    return pool.getReservesList();
}

async function getUserReservePositions(userAddress, provider, chainConfig = {}) {
    const reserves = await getReservesList(provider, chainConfig);
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
  
  module.exports = {
    getUnhealthyPositions,
    getUserHealthFactor,
    getUserHealthFactorsBatched,
    getDebtAmount,
    getDebtPosition,
    getDebtPositions,
    getPrimaryDebtPosition,
    getBorrowers,
    getBorrowersFromBorrowEvents,
    getBorrowersFromSubgraph,
    getReservesList,
    getPrimaryCollateral,
    // ...other exports as needed
  };
