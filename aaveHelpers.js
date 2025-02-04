const { ethers } = require('ethers');
const fetch = require("node-fetch");

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

async function getBorrowersFromSubgraph() {
    const query = `
    {
      borrows(first: 1000, orderBy: timestamp, orderDirection: desc) {
        user {
          id  # Borrower's wallet address
        }
      }
    }`;

    const response = await fetch("https://metisapi.0xgraph.xyz/subgraphs/name/aave/protocol-v3-metis", {
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

// Fetch user debt, collateral, and health factor
async function getUserDebtAndHealthFactor(userAddress) {
    const query = `
    {
      userReserves(where: { user: "${userAddress}", currentTotalDebt_gt: "0" }) {
        reserve {
          symbol
          id
        }
        currentTotalDebt
      }
    }`;

    const response = await fetch("https://metisapi.0xgraph.xyz/subgraphs/name/aave/protocol-v3-metis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });

    const data = await response.json();
    if (!data.data.userReserves.length) return null; // Skip if no active debt

    return {
        user: userAddress,
        debtAssets: data.data.userReserves.map(reserve => ({
            token: reserve.reserve.symbol,
            debtAmount: reserve.currentTotalDebt
        }))
    };
}

// Get user's health factor from the Aave contract
async function getUserHealthFactor(userAddress, provider) {
    const poolAddress = process.env.POOL_ADDRESS;
    if (!poolAddress) {
        console.error("POOL_ADDRESS not set in environment variables");
        return 999;
    }

    const aavePoolABI = [
        "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
    ];

    const pool = new ethers.Contract(poolAddress, aavePoolABI, provider);
    try {
        const data = await pool.getUserAccountData(userAddress);
        const healthFactor = parseFloat(ethers.utils.formatUnits(data.healthFactor, 18));
        console.log(`Health factor for ${userAddress}: ${healthFactor}`);
        return healthFactor;
    } catch (error) {
        console.error(`Health factor check failed for ${userAddress}:`, error.message);
        return 999; // Return high HF to skip invalid users
    }
}



async function getUnhealthyPositions(provider) {
    console.log("🔎 Fetching borrowers from The Graph...");
    
    const borrowers = await getBorrowersFromSubgraph();
    if (borrowers.length === 0) {
        console.warn("⚠️ No borrowers found in The Graph.");
        return [];
    }

    console.log(`✅ Checking health factors for ${borrowers.length} borrowers...`);
    
    const unhealthyPositions = [];

    for (const user of borrowers) {
        const healthFactor = await getUserHealthFactor(user, provider);
        
        if (healthFactor < parseFloat(process.env.LIQUIDATION_THRESHOLD)) {
            // Find debt asset and amount
            const debtAsset = "0xEA32A96608495e54156Ae48931A7c20f0dcc1a21"; // Placeholder
            const debtAmount = await getDebtAmount(user, debtAsset, provider);

            console.log(`👀 Checking debt for ${user}: ${ethers.utils.formatUnits(debtAmount, 6)} USDC`);
            
            if (debtAmount.eq(ethers.constants.Zero)) {
                console.log(`⚠️ Skipping ${user}: No remaining debt.`);
                continue; // Skip users with 0 debt
            }

            const collateralAsset = await getPrimaryCollateral(user);
            if (!collateralAsset) {
                console.warn(`⚠️ Skipping ${user}: No valid collateral.`);
                continue;
            }

            unhealthyPositions.push({
                user,
                debtAsset,
                debtAmount,
                collateralAsset
            });

            console.log(`🔥 Found liquidatable position: ${user} | HF: ${healthFactor} | Debt: ${ethers.utils.formatUnits(debtAmount, 6)} USDC`);
        }
    }

    console.log(`📌 Found ${unhealthyPositions.length} liquidatable positions.`);
    return unhealthyPositions;
}

// Get user's primary collateral (placeholder, improve later)
async function getPrimaryCollateral(userAddress) {
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

        const response = await fetch("https://metisapi.0xgraph.xyz/subgraphs/name/aave/protocol-v3-metis", {
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

// Get user's debt amount
async function getDebtAmount(userAddress, provider) {
    console.log(`🔍 Fetching debt for ${userAddress}...`);

    const query = `
    {
      userReserves(where: { user: "${userAddress}" }) {
        reserve {
          symbol
        }
        currentTotalDebt
      }
    }`;

    const response = await fetch("https://metisapi.0xgraph.xyz/subgraphs/name/aave/protocol-v3-metis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });

    const data = await response.json();
    console.log(`📜 Raw debt response for ${userAddress}:`, JSON.stringify(data, null, 2));

    if (!data.data.userReserves.length) {
        console.warn(`⚠️ No debt found for ${userAddress}`);
        return ethers.constants.Zero;
    }

    // ✅ **SUM ALL DEBT POSITIONS**
    const totalDebt = data.data.userReserves.reduce((sum, reserve) => {
        return sum.add(ethers.BigNumber.from(reserve.currentTotalDebt));
    }, ethers.constants.Zero);

    console.log(`💰 Total debt for ${userAddress}: ${ethers.utils.formatUnits(totalDebt, 6)} USDC`);
    return totalDebt;
}

// Fetch users who have borrowed from a specific reserve
async function getReserveUsers(reserveAddress) {
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

        const response = await fetch("https://metisapi.0xgraph.xyz/subgraphs/name/aave/protocol-v3-metis", {
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

module.exports = {
    getUnhealthyPositions,
    getUserHealthFactor,
    getDebtAmount,
    getBorrowersFromSubgraph,
    getUserDebtAndHealthFactor,
    getPrimaryCollateral,
    getReserveUsers  // <-- Make sure this is included!
};