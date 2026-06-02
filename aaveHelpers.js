const { ethers } = require('ethers');
const fetch = require("node-fetch");
const { loadBorrowerSet, saveBorrowerSet } = require("./src/borrowerStore");

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
async function scanBorrowRange(pool, fromBlock, toBlock, chunkSize, target, label) {
    let added = 0;
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
            }
            target.add(key);
          }
        }
      } catch (error) {
        console.warn(`⚠️ ${label}: Borrow scan failed for blocks ${startBlock}-${endBlock}: ${error.message}`);
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

    const { borrowers, lastScannedBlock } = loadBorrowerSet(chainKey);

    let fromBlock;
    if (lastScannedBlock && lastScannedBlock <= currentBlock) {
      // Incremental: only the new blocks. Re-scan the last chunk too, in case
      // the previous run stopped mid-chunk or a reorg shuffled recent blocks.
      fromBlock = Math.max(lastScannedBlock - chunkSize, 0);
      console.log(`🔁 ${chainConfig.name}: incremental Borrow scan ${fromBlock} → ${currentBlock} (known borrowers: ${borrowers.size}).`);
    } else {
      // First run (or stale/empty store): deep backfill.
      const backfill = chainConfig.borrowBackfillBlocks || chainConfig.borrowScanBlocks || 100000;
      fromBlock = Math.max(currentBlock - backfill, 0);
      const chunks = Math.ceil((currentBlock - fromBlock) / chunkSize);
      console.log(`📚 ${chainConfig.name}: BACKFILL Borrow scan ${fromBlock} → ${currentBlock} (~${chunks} chunks, one-time).`);
    }

    const added = await scanBorrowRange(pool, fromBlock, currentBlock, chunkSize, borrowers, chainConfig.name || "Aave");
    saveBorrowerSet(chainKey, borrowers, currentBlock);

    console.log(`✅ ${chainConfig.name}: ${borrowers.size} known borrowers (+${added} new this scan).`);
    return Array.from(borrowers);
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
    const concurrency = parseInt(process.env.HF_CHECK_CONCURRENCY || "25", 10);

    // Phase 1: check every known borrower's health factor in parallel batches.
    // This is the hot path — it runs every cycle over the full borrower set —
    // so it must not be a sequential per-wallet RPC loop.
    console.log(`✅ Checking ${borrowers.length} health factors (concurrency ${concurrency})...`);
    const t0 = Date.now();
    const hfResults = await mapWithConcurrency(borrowers, concurrency, async (user) => ({
      user,
      healthFactor: await getUserHealthFactor(user, provider, chainConfig),
    }));

    // Keep only genuinely-unhealthy positions and attempt the most urgent
    // (lowest HF) first — those are the ones a competing bot is also racing for.
    const candidates = hfResults
      .filter((entry) => Number.isFinite(entry.healthFactor) && entry.healthFactor < threshold)
      .sort((a, b) => a.healthFactor - b.healthFactor);

    console.log(`✅ Scanned ${borrowers.length} HFs in ${Date.now() - t0}ms; ${candidates.length} below ${threshold}.`);

    // Phase 2: enrich only the unhealthy candidates (debt + collateral lookups
    // are heavier, so we do them on the short list, in priority order).
    const minDebtToCover = parseFloat(process.env.MIN_DEBT_TO_COVER || "0.099");
    const unhealthyPositions = [];

    for (const { user, healthFactor } of candidates) {
      const debtPosition = await getPrimaryDebtPosition(user, provider, chainConfig);
      const debtAsset = debtPosition.debtAsset;
      const debtAmount = debtPosition.debtAmount;

      console.log(`👀 Checking debt for ${user}: ${ethers.utils.formatUnits(debtAmount, debtPosition.debtDecimals)} ${debtPosition.debtSymbol}`);
      if (debtAmount.eq(ethers.constants.Zero)) {
        console.log(`⚠️ Skipping ${user}: No remaining debt.`);
        continue;
      }

      // Skip positions with debt under the configured human-unit amount.
      const debtInUnits = parseFloat(ethers.utils.formatUnits(debtAmount, debtPosition.debtDecimals));
      if (debtInUnits < minDebtToCover) {
        console.log(`⚠️ Skipping ${user}: Debt too small (${debtInUnits} ${debtPosition.debtSymbol} < ${minDebtToCover} ${debtPosition.debtSymbol}).`);
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
