#!/usr/bin/env node
/**
 * Track-1 winnability probe (READ-ONLY).
 *
 * For each candidate Aave V3 chain: scan recent `LiquidationCall` events, tabulate
 * total liquidations, distinct liquidators, and concentration (does one pack win the
 * majority?). This tells us whether a poll-and-react bot has a thin enough field to win.
 *
 * No keys, no sends, no writes to live data. Public RPCs. Chunks getLogs and
 * auto-splits on range-limit errors.
 *
 * Usage: node scripts/probeChainWinnability.js [days]   (default 7)
 */
const { ethers } = require("ethers");

// Aave V3 LiquidationCall(collateralAsset, debtAsset, user, debtToCover, liquidatedCollateralAmount, liquidator, receiveAToken)
// collateralAsset, debtAsset, user are indexed; liquidator is NOT indexed (it's in data).
const TOPIC_LIQ = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";

// Decoder for the non-indexed data portion: debtToCover(uint256), liquidatedCollateralAmount(uint256), liquidator(address), receiveAToken(bool)
const dataAbi = ["uint256", "uint256", "address", "bool"];

const CHAINS = {
  gnosis:  { name: "Gnosis Chain", rpc: "https://rpc.gnosischain.com", pool: "0xb50201558B00496A145fE76f7424749556E326D8", blockSec: 5 },
  scroll:  { name: "Scroll",       rpc: "https://rpc.scroll.io",       pool: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe", blockSec: 3 },
  celo:    { name: "Celo",         rpc: "https://forno.celo.org",      pool: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402", blockSec: 5 },
  soneium: { name: "Soneium",      rpc: "https://rpc.soneium.org",     pool: "0xDd3d7A7d03D9fD9ef45f3E587287922eF65CA38B", blockSec: 2 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getLogsChunked(provider, address, fromBlock, toBlock, initialChunk) {
  const out = [];
  let chunk = initialChunk;
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      const logs = await provider.getLogs({ address, topics: [TOPIC_LIQ], fromBlock: start, toBlock: end });
      out.push(...logs);
      start = end + 1;
      // gently grow back toward the initial chunk after a success
      if (chunk < initialChunk) chunk = Math.min(initialChunk, chunk * 2);
    } catch (e) {
      const msg = (e && (e.body || e.message || "")).toString().toLowerCase();
      const rangeProblem = /range|too many|limit|exceed|block range|response size|10000|larger than/.test(msg);
      if (chunk > 1 && (rangeProblem || true)) {
        // halve and retry the same start
        chunk = Math.max(1, Math.floor(chunk / 2));
        await sleep(150);
        continue;
      }
      // chunk already 1 and still failing — skip this block to make progress
      start = end + 1;
    }
  }
  return out;
}

async function probeChain(key) {
  const c = CHAINS[key];
  const provider = new ethers.providers.JsonRpcProvider({ url: c.rpc, timeout: 20000 });
  const days = Number(process.argv[2] || 7);
  let head, fromBlock;
  try {
    head = await provider.getBlockNumber();
  } catch (e) {
    return { key, name: c.name, error: `head fetch failed: ${e.message}` };
  }
  const blocksBack = Math.floor((days * 24 * 3600) / c.blockSec);
  fromBlock = Math.max(0, head - blocksBack);
  // initial chunk sized to ~stay under common 10k log-range caps; public nodes vary
  const initialChunk = 2000;

  const t0 = Date.now();
  const logs = await getLogsChunked(provider, c.pool, fromBlock, head, initialChunk);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  const byLiquidator = {};
  const byUser = {};
  for (const log of logs) {
    let liquidator;
    try {
      const decoded = ethers.utils.defaultAbiCoder.decode(dataAbi, log.data);
      liquidator = decoded[2].toLowerCase();
    } catch {
      liquidator = "decode_error";
    }
    const user = "0x" + log.topics[3].slice(26).toLowerCase();
    byLiquidator[liquidator] = (byLiquidator[liquidator] || 0) + 1;
    byUser[user] = (byUser[user] || 0) + 1;
  }

  const total = logs.length;
  const liquidators = Object.entries(byLiquidator).sort((a, b) => b[1] - a[1]);
  const topShare = total ? ((liquidators[0]?.[1] || 0) / total) : 0;
  const top3Share = total ? (liquidators.slice(0, 3).reduce((s, x) => s + x[1], 0) / total) : 0;
  const distinctLiquidators = liquidators.length;
  const distinctVictims = Object.keys(byUser).length;

  return {
    key, name: c.name, days, fromBlock, head, blocksScanned: head - fromBlock, elapsed,
    total, distinctLiquidators, distinctVictims, topShare, top3Share,
    top: liquidators.slice(0, 5).map(([a, n]) => ({ a, n, pct: ((n / total) * 100).toFixed(0) })),
  };
}

(async () => {
  console.log(`\n=== Track-1 Winnability Probe (${process.argv[2] || 7}d, READ-ONLY) ===\n`);
  const results = [];
  for (const key of Object.keys(CHAINS)) {
    process.stdout.write(`probing ${CHAINS[key].name} ... `);
    try {
      const r = await probeChain(key);
      results.push(r);
      if (r.error) { console.log(`ERROR: ${r.error}`); continue; }
      console.log(`done (${r.total} liqs, ${r.elapsed}s)`);
    } catch (e) {
      console.log(`FATAL: ${e.message}`);
      results.push({ key, name: CHAINS[key].name, error: e.message });
    }
  }

  console.log(`\n${"=".repeat(78)}\nRESULTS\n${"=".repeat(78)}`);
  for (const r of results) {
    console.log(`\n## ${r.name}`);
    if (r.error) { console.log(`   ERROR: ${r.error}`); continue; }
    console.log(`   window: last ${r.days}d  (${r.blocksScanned.toLocaleString()} blocks, scan ${r.elapsed}s)`);
    console.log(`   total liquidations:   ${r.total}`);
    console.log(`   distinct liquidators: ${r.distinctLiquidators}`);
    console.log(`   distinct victims:     ${r.distinctVictims}`);
    console.log(`   top liquidator share: ${(r.topShare * 100).toFixed(0)}%   top-3 share: ${(r.top3Share * 100).toFixed(0)}%`);
    if (r.top.length) {
      console.log(`   leaderboard:`);
      for (const t of r.top) console.log(`     ${t.a}  ${t.n}  (${t.pct}%)`);
    }
    // verdict heuristic
    let verdict;
    if (r.total === 0) verdict = "DEAD — no liquidation flow to win (deprioritize)";
    else if (r.topShare > 0.7) verdict = "CONTESTED — one pack dominates (skip, same trap as Base)";
    else if (r.top3Share > 0.85 && r.distinctLiquidators < 5) verdict = "CONTESTED — tight pack (likely skip)";
    else if (r.total < 5) verdict = "THIN FLOW — open field but very few events (low priority, watch)";
    else verdict = "OPEN + FLOW — candidate to deploy (validate a sample victim is non-dust)";
    console.log(`   >>> VERDICT: ${verdict}`);
  }
  console.log("");
})();
