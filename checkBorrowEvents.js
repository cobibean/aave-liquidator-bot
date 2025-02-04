require("dotenv").config();
const { ethers } = require("ethers");

async function checkBorrowEvents() {
    const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);

    // Aave v3 Pool Borrow event ABI
    const poolAbi = [
        "event Borrow(address indexed reserve, address indexed user, uint256 amount, uint256 borrowRateMode, uint256 borrowRate, uint16 referralCode)"
    ];

    const pool = new ethers.Contract(process.env.POOL_ADDRESS, poolAbi, provider);

    const currentBlock = await provider.getBlockNumber();
    const fromBlock = currentBlock - 500000; // Increase to last 500,000 blocks
    const toBlock = currentBlock;

    console.log(`🔎 Scanning for Borrow events from block ${fromBlock} to ${toBlock}...`);

    try {
        const events = await pool.queryFilter(pool.filters.Borrow(), fromBlock, toBlock);
        console.log(`✅ Found ${events.length} Borrow events`);

        if (events.length > 0) {
            events.forEach((event, index) => {
                console.log(`🔹 Borrower ${index + 1}: ${event.args.user} - Reserve: ${event.args.reserve} - Amount: ${ethers.utils.formatUnits(event.args.amount, 18)}`);
            });
        } else {
            console.log("⚠️ No Borrow events detected in this range. Try increasing the block range further.");
        }
    } catch (error) {
        console.error("❌ Error fetching Borrow events:", error);
    }
}

checkBorrowEvents();