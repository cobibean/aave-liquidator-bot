#!/usr/bin/env node
/**
 * Validate that recent liquidation victims on a chain are NORMAL non-dust positions
 * (real debt repaid), not thin-liquidity traps. READ-ONLY.
 *
 * Reads the most recent N LiquidationCall events, decodes debtToCover +
 * liquidatedCollateralAmount, and resolves the debt asset's symbol/decimals so we can
 * print a human-readable repaid amount.
 *
 * Usage: node scripts/probeVictimSizes.js <chain> [count]
 */
const { ethers } = require("ethers");

const TOPIC_LIQ = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";
const dataAbi = ["uint256", "uint256", "address", "bool"]; // debtToCover, liqCollateral, liquidator, receiveAToken
const erc20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];

const CHAINS = {
  scroll:  { name: "Scroll",       rpc: "https://rpc.scroll.io",       pool: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe", blockSec: 3 },
  gnosis:  { name: "Gnosis Chain", rpc: "https://rpc.gnosischain.com", pool: "0xb50201558B00496A145fE76f7424749556E326D8", blockSec: 5 },
};

async function getRecentLogs(provider, pool, head, blocksBack) {
  const out = [];
  let chunk = 2000;
  let start = head - blocksBack;
  while (start <= head) {
    const end = Math.min(start + chunk - 1, head);
    try {
      const logs = await provider.getLogs({ address: pool, topics: [TOPIC_LIQ], fromBlock: start, toBlock: end });
      out.push(...logs);
      start = end + 1;
    } catch {
      if (chunk > 1) { chunk = Math.floor(chunk / 2); continue; }
      start = end + 1;
    }
  }
  return out;
}

(async () => {
  const chain = process.argv[2];
  const count = Number(process.argv[3] || 8);
  const c = CHAINS[chain];
  if (!c) { console.log("unknown chain; use scroll|gnosis"); process.exit(1); }
  const provider = new ethers.providers.JsonRpcProvider({ url: c.rpc, timeout: 20000 });
  const head = await provider.getBlockNumber();
  const blocksBack = Math.floor((7 * 24 * 3600) / c.blockSec);
  const logs = await getRecentLogs(provider, c.pool, head, blocksBack);
  logs.sort((a, b) => b.blockNumber - a.blockNumber);
  const recent = logs.slice(0, count);

  const tokenCache = {};
  async function tokenMeta(addr) {
    const k = addr.toLowerCase();
    if (tokenCache[k]) return tokenCache[k];
    try {
      const t = new ethers.Contract(addr, erc20, provider);
      const [sym, dec] = await Promise.all([t.symbol(), t.decimals()]);
      return (tokenCache[k] = { sym, dec });
    } catch {
      return (tokenCache[k] = { sym: addr.slice(0, 8), dec: 18 });
    }
  }

  console.log(`\n=== ${c.name}: last ${recent.length} liquidation victims (debt repaid) ===\n`);
  for (const log of recent) {
    const debtAsset = "0x" + log.topics[2].slice(26);
    const user = "0x" + log.topics[3].slice(26);
    const [debtToCover, liqColl] = ethers.utils.defaultAbiCoder.decode(dataAbi, log.data);
    const meta = await tokenMeta(debtAsset);
    const repaid = Number(ethers.utils.formatUnits(debtToCover, meta.dec));
    console.log(
      `block ${log.blockNumber}  user ${user.slice(0, 10)}  repaid ${repaid.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${meta.sym}` +
      `  ${repaid >= 100 ? "" : "  <-- DUST (<100)"}`
    );
  }
  console.log("");
})();
