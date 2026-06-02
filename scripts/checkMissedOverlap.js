require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getBorrowersFromBorrowEvents } = require("../aaveHelpers");

// For a given chain: get the recent-Borrow candidate set the bot would scan,
// then get the users actually liquidated recently, and report overlap.
const LIQ_ABI = ["event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)"];

(async () => {
  const key = process.argv[2] || "arbitrum";
  const chainConfig = getChainConfig(key);
  const provider = createProvider(chainConfig);
  const current = await provider.getBlockNumber();

  // Our bot's candidate set (recent Borrow events, same window as config)
  const botBorrowers = new Set(await getBorrowersFromBorrowEvents(provider, chainConfig));

  // Users actually liquidated in the last ~12h
  const pool = new ethers.Contract(chainConfig.pool, LIQ_ABI, provider);
  const window = key === "arbitrum" ? 172800 : 21600;
  const from = Math.max(current - window, 0);
  const chunk = chainConfig.borrowScanChunkSize || 10000;
  const liquidatedUsers = new Set();
  for (let s = from; s <= current; s += chunk) {
    const e = Math.min(s + chunk - 1, current);
    const evs = await pool.queryFilter(pool.filters.LiquidationCall(), s, e).catch(() => []);
    evs.forEach((ev) => liquidatedUsers.add(ev.args.user.toLowerCase()));
  }

  let inBotSet = 0;
  const missed = [];
  for (const u of liquidatedUsers) {
    if (botBorrowers.has(u)) inBotSet++;
    else missed.push(u);
  }

  console.log(JSON.stringify({
    chain: key,
    botCandidateCount: botBorrowers.size,
    liquidatedUserCount: liquidatedUsers.size,
    liquidatedUsersAlsoInBotCandidateSet: inBotSet,
    liquidatedUsersBotWouldNeverHaveSeen: missed.length,
  }, null, 2));
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
