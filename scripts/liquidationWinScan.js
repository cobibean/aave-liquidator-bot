// Scan Aave V3 Pool LiquidationCall events over the last N hours on each live chain.
// ethers v5. Run inside a bot container to inherit the working Alchemy RPC env.
//
// Usable two ways:
//   - CLI:    node scripts/liquidationWinScan.js   (env: SCAN_HOURS, SCAN_CHAINS)
//   - module: const { runWinScan } = require("./scripts/liquidationWinScan");
//             const result = await runWinScan({ hours, chains });
// The module form returns a structured result (and prints nothing) so the
// winscan-runner service and the monitor can consume it; the CLI form prints the
// same human-readable report the droplet morning-check relies on.
const { ethers } = require("ethers");

// Resolve the bot's chain configs from either the container layout (/app/src) or
// a relative path when run from the repo root.
function loadChainConfigs() {
  for (const p of ["/app/src/chains.js", "../src/chains", "./src/chains"]) {
    try {
      return require(p).CHAIN_CONFIGS || {};
    } catch (_) {
      // try next layout
    }
  }
  return {};
}

const TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";
const OUR_WALLET = "0x40abdc50e3b619d072754a767578ee2a4a4f954d";
const BLOCKTIME = { plasma: 1, arbitrum: 0.25, base: 2, avalanche: 2, optimism: 2 };

function rpcFor(key, c) {
  const U = key.toUpperCase();
  // prefer plural override list, then singular, then config default
  const urls = process.env[`${U}_RPC_URLS`];
  if (urls) return urls.split(",")[0].trim();
  if (process.env[`${U}_RPC_URL`]) return process.env[`${U}_RPC_URL`];
  return c.rpcUrl;
}

// Scan one chain. Returns a structured per-chain result (never throws — chain
// errors are captured into the result so one bad RPC doesn't sink the whole run).
async function scanChain(key, cfg, hours) {
  const c = cfg[key];
  if (!c) return { key, name: key, error: `no config for ${key}` };
  const url = rpcFor(key, c);
  const provider = new ethers.providers.JsonRpcProvider(url);
  try {
    const head = await provider.getBlockNumber();
    const bt = BLOCKTIME[key] || 2;
    const span = Math.ceil((hours * 3600) / bt);
    const from = Math.max(0, head - span);
    const CHUNK = 9000;
    let total = 0;
    const liquidators = {};
    const samples = [];
    for (let start = from; start <= head; start += CHUNK) {
      const end = Math.min(start + CHUNK - 1, head);
      let logs = [];
      try {
        logs = await provider.getLogs({ address: c.pool, topics: [TOPIC], fromBlock: start, toBlock: end });
      } catch (e) {
        for (let s2 = start; s2 <= end; s2 += 1500) {
          try {
            const l = await provider.getLogs({ address: c.pool, topics: [TOPIC], fromBlock: s2, toBlock: Math.min(s2 + 1499, end) });
            logs.push(...l);
          } catch (e2) {
            /* skip subrange */
          }
        }
      }
      for (const lg of logs) {
        total++;
        const data = lg.data.slice(2);
        const liq = ("0x" + data.slice(2 * 64, 3 * 64).slice(24)).toLowerCase();
        liquidators[liq] = (liquidators[liq] || 0) + 1;
        if (samples.length < 4) {
          samples.push({ block: lg.blockNumber, tx: lg.transactionHash, liquidator: liq, user: "0x" + lg.topics[3].slice(26) });
        }
      }
    }
    const ours = liquidators[OUR_WALLET] || 0;
    const topLiquidators = Object.entries(liquidators)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([address, count]) => ({ address, count, ours: address === OUR_WALLET }));
    return {
      key,
      name: c.name,
      pool: c.pool,
      rpcHost: url.replace(/(https?:\/\/[^/]+\/).*/, "$1***"),
      fromBlock: from,
      headBlock: head,
      spanBlocks: span,
      total,
      ours,
      topLiquidators,
      samples,
    };
  } catch (e) {
    return { key, name: c.name || key, error: e.message };
  }
}

// Run the full multi-chain scan. Pure data — no console output.
async function runWinScan({ hours, chains } = {}) {
  const cfg = loadChainConfigs();
  const h = Number(hours || process.env.SCAN_HOURS || 12);
  const live = (chains || process.env.SCAN_CHAINS || "plasma,arbitrum,base,avalanche,optimism")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const results = [];
  for (const key of live) {
    results.push(await scanChain(key, cfg, h));
  }

  const grandTotal = results.reduce((sum, r) => sum + (Number.isFinite(r.total) ? r.total : 0), 0);
  const ourTotal = results.reduce((sum, r) => sum + (Number.isFinite(r.ours) ? r.ours : 0), 0);
  return {
    scannedAt: new Date().toISOString(),
    hours: h,
    ourWallet: OUR_WALLET,
    chains: results,
    grandTotal,
    ourTotal,
  };
}

// Print the human-readable report (the format the droplet morning-check expects).
function printReport(result) {
  for (const r of result.chains) {
    console.log(`\n===== ${r.name} (${r.key}) =====`);
    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
      continue;
    }
    console.log(`  rpc: ${r.rpcHost}`);
    console.log(`  window: blocks ${r.fromBlock}..${r.headBlock} (~${result.hours}h, ${r.spanBlocks} blocks)  pool=${r.pool}`);
    console.log(`  TOTAL LiquidationCall events: ${r.total}   (OURS: ${r.ours})`);
    if (r.topLiquidators.length) {
      console.log("  top liquidators:");
      r.topLiquidators.forEach((t) => console.log(`    ${t.address}  ${t.count}${t.ours ? "  <-- US" : ""}`));
    }
    r.samples.forEach((s) => console.log(`  sample: blk ${s.block} user ${s.user} liq ${s.liquidator} tx ${s.tx}`));
  }
  console.log("\n=========== SUMMARY ===========");
  for (const r of result.chains) {
    if (r.error) console.log(`  ${r.name.padEnd(22)} ERROR: ${r.error}`);
    else console.log(`  ${r.name.padEnd(22)} on-chain=${String(r.total).padStart(4)}  ours=${r.ours}`);
  }
  console.log(`  ${"TOTAL".padEnd(22)} on-chain=${String(result.grandTotal).padStart(4)}  ours=${result.ourTotal}`);
}

module.exports = { runWinScan, scanChain, printReport, OUR_WALLET };

// CLI entrypoint.
if (require.main === module) {
  runWinScan()
    .then((result) => printReport(result))
    .catch((e) => {
      console.error("winscan failed:", e.message);
      process.exit(1);
    });
}
