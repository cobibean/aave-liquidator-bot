require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("./src/chains");
const { createProvider } = require("./src/provider");

async function checkBorrowEvents() {
    const chainConfig = getChainConfig(process.env.CHAIN || "arbitrum");
    const provider = createProvider(chainConfig);

    // Aave v3 Pool Borrow event ABI
    const poolAbi = [
        "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"
    ];

    const pool = new ethers.Contract(chainConfig.pool, poolAbi, provider);

    const currentBlock = await provider.getBlockNumber();
    const fromBlock = currentBlock - chainConfig.borrowScanBlocks;
    const toBlock = currentBlock;

    console.log(`🔎 Scanning ${chainConfig.name} for Borrow events from block ${fromBlock} to ${toBlock}...`);

    try {
        const events = await pool.queryFilter(pool.filters.Borrow(), fromBlock, toBlock);
        console.log(`✅ Found ${events.length} Borrow events`);

        if (events.length > 0) {
            events.forEach((event, index) => {
                console.log(`🔹 Borrower ${index + 1}: ${event.args.onBehalfOf} - Reserve: ${event.args.reserve} - Amount: ${event.args.amount.toString()}`);
            });
        } else {
            console.log("⚠️ No Borrow events detected in this range. Try increasing the block range further.");
        }
    } catch (error) {
        console.error("❌ Error fetching Borrow events:", error);
    }
}

checkBorrowEvents();
