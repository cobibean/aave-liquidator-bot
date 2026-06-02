require("dotenv").config();

const { ethers } = require("ethers");
const { getSelectedChainConfigs } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getBorrowersFromBorrowEvents, getUserHealthFactor } = require("../aaveHelpers");

// Reproduces the bot's borrower-discovery + HF path exactly, but reports
// the full health-factor distribution so we can see WHY nothing is caught.
async function main() {
  const chains = getSelectedChainConfigs(process.env.DIAG_CHAINS || process.env.CHAINS);

  for (const chainConfig of chains) {
    const out = { chain: chainConfig.key, name: chainConfig.name };
    try {
      const provider = createProvider(chainConfig);
      const block = await provider.getBlockNumber();
      out.currentBlock = block;
      out.scanWindowBlocks = chainConfig.borrowScanBlocks;

      const t0 = Date.now();
      const borrowers = await getBorrowersFromBorrowEvents(provider, chainConfig);
      out.scanMs = Date.now() - t0;
      out.uniqueBorrowers = borrowers.length;

      // Bucket health factors. HF can be huge (no debt) -> treat as "noDebt".
      const buckets = {
        liquidatable_lt_1: 0,
        risky_1_to_1_05: 0,
        watch_1_05_to_1_25: 0,
        healthy_1_25_to_5: 0,
        veryHealthy_gt_5: 0,
        noDebtOrError: 0,
      };
      const closest = []; // track the lowest HFs we actually see

      for (const user of borrowers) {
        const hf = await getUserHealthFactor(user, provider, chainConfig);
        if (!Number.isFinite(hf) || hf >= 999) {
          buckets.noDebtOrError++;
          continue;
        }
        if (hf < 1) buckets.liquidatable_lt_1++;
        else if (hf < 1.05) buckets.risky_1_to_1_05++;
        else if (hf < 1.25) buckets.watch_1_05_to_1_25++;
        else if (hf < 5) buckets.healthy_1_25_to_5++;
        else buckets.veryHealthy_gt_5++;
        closest.push({ user, hf: Number(hf.toFixed(4)) });
      }

      closest.sort((a, b) => a.hf - b.hf);
      out.buckets = buckets;
      out.lowestTen = closest.slice(0, 10);
    } catch (err) {
      out.error = err.message;
    }
    console.log(JSON.stringify(out, null, 2));
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
