require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const {
  BACKFILL_VERSION,
  DATA_DIR,
  loadBorrowerSet,
  saveBorrowerSet,
  loadActiveDebt,
  saveActiveDebt,
} = require("../src/borrowerStore");

const BORROW_EVENT_ABI = [
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
];

function parseArgs(argv) {
  const chain = argv[2];
  const flags = new Set(argv.slice(3));
  if (!chain) {
    throw new Error("Usage: node scripts/deepBackfillBorrowers.js <chain> --from-deployment --merge --mark-cold-stale");
  }
  return {
    chain,
    fromDeployment: flags.has("--from-deployment"),
    merge: flags.has("--merge"),
    markColdStale: flags.has("--mark-cold-stale"),
  };
}

function atomicWriteJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (_) { return null; }
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function statePath(chainKey) {
  return path.join(DATA_DIR, "backfill", `borrowers-${chainKey}.json`);
}

function checkpoint(file, payload) {
  atomicWriteJson(file, {
    ...payload,
    updatedAt: new Date().toISOString(),
    count: payload.borrowers.length,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryBorrowEvents(pool, startBlock, endBlock, minChunkSize, stats) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await pool.queryFilter(pool.filters.Borrow(), startBlock, endBlock);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(250 * attempt);
      }
    }
  }

  const width = endBlock - startBlock + 1;
  if (width > minChunkSize) {
    const mid = startBlock + Math.floor(width / 2) - 1;
    stats.splits++;
    const left = await queryBorrowEvents(pool, startBlock, mid, minChunkSize, stats);
    const right = await queryBorrowEvents(pool, mid + 1, endBlock, minChunkSize, stats);
    return left.concat(right);
  }

  throw lastError;
}

async function main() {
  const opts = parseArgs(process.argv);
  const cfg = getChainConfig(opts.chain);
  const provider = createProvider(cfg);
  const head = await provider.getBlockNumber();
  const floor = opts.fromDeployment && Number.isFinite(cfg.deploymentBlock)
    ? cfg.deploymentBlock
    : Math.max(head - (cfg.borrowBackfillBlocks || cfg.borrowScanBlocks || 100000), 0);
  const source = opts.fromDeployment ? "deployment" : "window";
  const chunkSize = parsePositiveInt(process.env.DEEP_BACKFILL_CHUNK_BLOCKS, cfg.borrowScanChunkSize || 10000);
  const minChunkSize = parsePositiveInt(process.env.DEEP_BACKFILL_MIN_CHUNK_BLOCKS, cfg.borrowScanChunkSize || 10000);
  const checkpointEvery = parsePositiveInt(process.env.CHECKPOINT_EVERY_CHUNKS, 25);
  const file = statePath(cfg.key);
  const previous = readJson(file);
  const canResume =
    previous &&
    previous.chainKey === cfg.key &&
    previous.floor === floor &&
    previous.source === source &&
    previous.version === BACKFILL_VERSION &&
    Array.isArray(previous.borrowers);

  const borrowers = new Set(canResume ? previous.borrowers.map((a) => a.toLowerCase()) : []);
  let fromBlock = canResume && Number.isFinite(previous.lastCompletedBlock)
    ? previous.lastCompletedBlock + 1
    : floor;
  const pool = new ethers.Contract(cfg.pool, BORROW_EVENT_ABI, provider);
  let chunks = 0;
  let added = 0;
  const stats = { splits: 0 };

  console.log(`${cfg.name}: deep Borrow backfill ${fromBlock} → ${head} (floor ${floor}, source ${source}, chunk ${chunkSize}, minChunk ${minChunkSize}, existing checkpoint ${borrowers.size})`);

  for (let start = fromBlock; start <= head; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, head);
    try {
      const events = await queryBorrowEvents(pool, start, end, minChunkSize, stats);
      for (const event of events) {
        const borrower = event.args.onBehalfOf || event.args.user;
        if (!borrower || borrower === ethers.constants.AddressZero) continue;
        const key = borrower.toLowerCase();
        if (!borrowers.has(key)) added++;
        borrowers.add(key);
      }
    } catch (error) {
      checkpoint(file, {
        chainKey: cfg.key,
        floor,
        source,
        version: BACKFILL_VERSION,
        lastCompletedBlock: Math.max(start - 1, floor - 1),
        failedRange: [start, end],
        headBlock: head,
        borrowers: Array.from(borrowers),
      });
      throw new Error(`${cfg.name}: Borrow scan failed for blocks ${start}-${end}: ${error.message}`);
    }

    chunks++;
    if (chunks % checkpointEvery === 0 || end === head) {
      checkpoint(file, {
        chainKey: cfg.key,
        floor,
        source,
        version: BACKFILL_VERSION,
        lastCompletedBlock: end,
        headBlock: head,
        chunkSize,
        minChunkSize,
        splits: stats.splits,
        borrowers: Array.from(borrowers),
      });
      console.log(`   ${cfg.name}: checkpoint ${end}/${head}, checkpoint borrowers=${borrowers.size}, splits=${stats.splits}`);
    }
  }

  if (!opts.merge) {
    console.log(`${cfg.name}: backfill scan complete, merge skipped (--merge not set). checkpoint=${file}`);
    return;
  }

  const live = loadBorrowerSet(cfg.key);
  const merged = new Set(live.borrowers);
  for (const borrower of borrowers) merged.add(borrower);
  saveBorrowerSet(cfg.key, merged, head, {
    backfillCursor: head,
    backfillDone: true,
    backfillFloorBlock: floor,
    backfillSource: source,
    backfillVersion: BACKFILL_VERSION,
  });
  console.log(`${cfg.name}: merged borrower store ${live.borrowers.size} → ${merged.size} (+${merged.size - live.borrowers.size}, checkpoint added ${added}).`);

  if (opts.markColdStale) {
    const active = loadActiveDebt(cfg.key);
    saveActiveDebt(cfg.key, active.active, active.warmSweepsSinceCold, null);
    console.log(`${cfg.name}: marked active-debt cold timestamp stale so next bot cycle forces COLD.`);
  }
}

main().catch((error) => {
  console.error("deep backfill failed:", error.message);
  process.exit(1);
});
