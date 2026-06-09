#!/usr/bin/env node
/**
 * OEV-ordering probe (READ-ONLY) — the decisive feasibility test for "build OEV capability".
 *
 * The whole project loses because winners place their `liquidationCall` in the SAME block
 * as the oracle price update, right behind it (OEV backrun). This probe settles, per chain,
 * whether that's actually what's happening — and therefore whether reacting in-block to the
 * oracle is the right (and only) way to compete, vs. a pure latency race we can't win on L2.
 *
 * For each chain, for the N most recent real LiquidationCall events:
 *   1. Find the winning liquidation tx + its block + tx-index.
 *   2. Resolve the Chainlink aggregator behind the Aave price of the debt asset
 *      (PriceOracle.getSourceOfAsset -> EACAggregatorProxy.aggregator()).
 *   3. Look for that aggregator's `AnswerUpdated` (or a `transmit` tx to it) in the
 *      SAME block, and measure the tx-index gap (oracle update -> liquidation).
 *
 * Verdict per liquidation:
 *   SAME-BLOCK BACKRUN  : oracle update and liq in same block, liq right after  -> true OEV game.
 *   SAME-BLOCK (other)  : both in block but order/gap not a clean backrun        -> still in-block contest.
 *   NEXT-BLOCK / LATER  : liq is in a block after the oracle update              -> latency race (can't buy on L2).
 *   NO-ORACLE-IN-WINDOW : no matching oracle update found near the liq           -> inconclusive / different trigger.
 *
 * Aggregated, this tells us: is the winnable event taken by an in-block backrun (a game we
 * could build for) or a sequencer-ordering latency race (a game we can't win on these L2s)?
 *
 * No keys, no sends, no writes. Uses the SAME RPCs the bot uses if env is set, else public.
 *
 * Usage: node scripts/probeOevOrdering.js [chainKey] [numLiqs]
 *   e.g. node scripts/probeOevOrdering.js arbitrum 20
 *        node scripts/probeOevOrdering.js all 15
 */
require("dotenv").config();
const { ethers } = require("ethers");

// Aave V3 LiquidationCall — liquidator is in data (non-indexed); collateral/debt/user indexed.
const TOPIC_LIQ = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";
const LIQ_DATA_ABI = ["uint256", "uint256", "address", "bool"]; // debtToCover, liqCollateralAmount, liquidator, receiveAToken

// Chainlink aggregator AnswerUpdated(int256 current, uint256 indexed roundId, uint256 updatedAt)
const TOPIC_ANSWER_UPDATED = "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f";

const POOL_ADDR_PROVIDER = {
  // poolAddressesProvider per chain (Aave V3). Used to resolve PriceOracle.
  arbitrum:  "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
  optimism:  "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
  avalanche: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
};
const POOL = {
  arbitrum:  "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  optimism:  "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  avalanche: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
};
const RPC_PUBLIC = {
  arbitrum:  "https://arb1.arbitrum.io/rpc",
  optimism:  "https://mainnet.optimism.io",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
};
// Prefer the bot's own (often private/Alchemy) RPC if present in env.
function rpcFor(key) {
  const envName = `${key.toUpperCase()}_RPC_URLS`;
  const single = `${key.toUpperCase()}_RPC_URL`;
  const v = (process.env[envName] || "").split(",")[0].trim() || (process.env[single] || "").trim();
  return v || RPC_PUBLIC[key];
}
const BLOCK_SEC = { arbitrum: 0.25, optimism: 2, avalanche: 2 };

const APROV_ABI = ["function getPriceOracle() view returns (address)"];
const ORACLE_ABI = ["function getSourceOfAsset(address asset) view returns (address)"];
const PROXY_ABI  = ["function aggregator() view returns (address)"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getLogsChunked(provider, filter, fromBlock, toBlock, initialChunk) {
  const out = [];
  let chunk = initialChunk;
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      const logs = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
      out.push(...logs);
      start = end + 1;
      if (chunk < initialChunk) chunk = Math.min(initialChunk, chunk * 2);
    } catch (e) {
      if (chunk > 1) { chunk = Math.max(1, Math.floor(chunk / 2)); await sleep(120); continue; }
      start = end + 1;
    }
  }
  return out;
}

async function resolveAggregator(provider, key, debtAsset) {
  try {
    const ap = new ethers.Contract(POOL_ADDR_PROVIDER[key], APROV_ABI, provider);
    const oracleAddr = await ap.getPriceOracle();
    const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, provider);
    const source = await oracle.getSourceOfAsset(debtAsset); // EACAggregatorProxy
    let aggregator = source;
    try {
      const proxy = new ethers.Contract(source, PROXY_ABI, provider);
      aggregator = await proxy.aggregator();
    } catch (_) { /* some sources are the aggregator directly */ }
    return { source, aggregator: aggregator.toLowerCase() };
  } catch (e) {
    return { source: null, aggregator: null, err: e.message };
  }
}

async function probeChain(key, numLiqs) {
  const provider = new ethers.providers.JsonRpcProvider(rpcFor(key));
  const head = await provider.getBlockNumber();
  const blockSec = BLOCK_SEC[key] || 2;
  // Look back ~14 days worth of blocks to find numLiqs recent liquidations.
  const lookbackBlocks = Math.ceil((14 * 24 * 3600) / blockSec);
  const from = Math.max(0, head - lookbackBlocks);
  const chunk = key === "arbitrum" ? 100000 : 20000;

  process.stderr.write(`[${key}] scanning blocks ${from}..${head} for liquidations...\n`);
  const liqLogs = await getLogsChunked(provider, { address: POOL[key], topics: [TOPIC_LIQ] }, from, head, chunk);
  // newest first
  liqLogs.sort((a, b) => (b.blockNumber - a.blockNumber) || (b.transactionIndex - a.transactionIndex));
  const recent = liqLogs.slice(0, numLiqs);

  const aggCache = new Map();
  const results = [];
  for (const log of recent) {
    const [, , liquidator] = ethers.utils.defaultAbiCoder.decode(LIQ_DATA_ABI, log.data);
    const debtAsset = "0x" + log.topics[2].slice(26); // 2nd indexed = debtAsset
    const liqBlock = log.blockNumber;
    const liqIdx = log.transactionIndex;

    if (!aggCache.has(debtAsset)) aggCache.set(debtAsset, await resolveAggregator(provider, key, debtAsset));
    const { aggregator } = aggCache.get(debtAsset);

    let verdict = "NO-ORACLE-IN-WINDOW";
    let detail = {};
    if (aggregator) {
      // Look for an AnswerUpdated from this aggregator in [liqBlock-2, liqBlock].
      const win = await getLogsChunked(
        provider,
        { address: aggregator, topics: [TOPIC_ANSWER_UPDATED] },
        liqBlock - 2, liqBlock, 3
      );
      if (win.length) {
        // closest update at or before the liq
        const sameBlock = win.filter((w) => w.blockNumber === liqBlock);
        if (sameBlock.length) {
          const oIdx = Math.min(...sameBlock.map((w) => w.transactionIndex));
          const gap = liqIdx - oIdx;
          detail = { oracleBlock: liqBlock, oracleIdx: oIdx, liqIdx, gap };
          if (gap >= 0 && gap <= 3) verdict = "SAME-BLOCK BACKRUN";
          else verdict = "SAME-BLOCK (other)";
        } else {
          const prev = win.sort((a, b) => b.blockNumber - a.blockNumber)[0];
          detail = { oracleBlock: prev.blockNumber, liqBlock, blockGap: liqBlock - prev.blockNumber };
          verdict = "NEXT-BLOCK / LATER";
        }
      }
    }
    results.push({ block: liqBlock, tx: log.transactionHash, liquidator: liquidator.toLowerCase(), debtAsset, aggregator, verdict, ...detail });
  }
  return { key, head, scanned: liqLogs.length, analyzed: results.length, results };
}

function summarize(key, results) {
  const counts = {};
  const winners = {};
  for (const r of results) {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    winners[r.liquidator] = (winners[r.liquidator] || 0) + 1;
  }
  const topWinners = Object.entries(winners).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`\n===== ${key} =====`);
  console.log("verdict tally:", counts);
  console.log("top winners:  ", topWinners.map(([a, n]) => `${a.slice(0, 10)}…×${n}`).join("  "));
  for (const r of results) {
    const g = r.gap !== undefined ? ` gap=${r.gap}` : (r.blockGap !== undefined ? ` +${r.blockGap}blk` : "");
    console.log(`  ${r.verdict.padEnd(20)} blk=${r.block} ${r.liquidator.slice(0, 10)}…${g}  ${r.tx}`);
  }
}

(async () => {
  const arg = (process.argv[2] || "all").toLowerCase();
  const numLiqs = parseInt(process.argv[3] || "15", 10);
  const keys = arg === "all" ? ["arbitrum", "optimism", "avalanche"] : [arg];
  for (const key of keys) {
    try {
      const { results, scanned, analyzed } = await probeChain(key, numLiqs);
      process.stderr.write(`[${key}] found ${scanned} liqs in window, analyzing ${analyzed}\n`);
      summarize(key, results);
    } catch (e) {
      console.log(`\n===== ${key} =====\n  ERROR: ${e.message}`);
    }
  }
  process.exit(0);
})();
