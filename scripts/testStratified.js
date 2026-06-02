require("dotenv").config();
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getUnhealthyPositions } = require("../aaveHelpers");
const { loadWatchlist } = require("../src/borrowerStore");

(async () => {
  const key = process.argv[2] || "avalanche";
  // Use a modest backfill so this test is quick but realistic.
  process.env.AVALANCHE_BORROW_BACKFILL_BLOCKS = process.env.AVALANCHE_BORROW_BACKFILL_BLOCKS || "300000";
  process.env.FULL_SWEEP_EVERY_N = "3"; // force a full sweep again soon
  const c = getChainConfig(key);
  const provider = createProvider(c);

  console.log("\n=== CYCLE 1 (expect FULL sweep + backfill) ===");
  let t = Date.now();
  await getUnhealthyPositions(provider, c);
  console.log(`cycle1 total ${Date.now()-t}ms`);
  let wl = loadWatchlist(c.key);
  console.log(`watchlist after c1: ${wl.watch.size}, cyclesSinceFull=${wl.cyclesSinceFullSweep}`);

  console.log("\n=== CYCLE 2 (expect watchlist-only sweep, faster) ===");
  t = Date.now();
  await getUnhealthyPositions(provider, c);
  console.log(`cycle2 total ${Date.now()-t}ms`);
  wl = loadWatchlist(c.key);
  console.log(`watchlist after c2: ${wl.watch.size}, cyclesSinceFull=${wl.cyclesSinceFullSweep}`);
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
