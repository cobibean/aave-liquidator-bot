require("dotenv").config();
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getBorrowersFromBorrowEvents, getUserHealthFactor } = require("../aaveHelpers");
const aave = require("../aaveHelpers");

// Validate the Multicall3 batched HF reads against single-call reads.
(async () => {
  const key = process.argv[2] || "avalanche";
  const c = getChainConfig(key);
  const provider = createProvider(c);

  // Get a small sample of borrowers (use recent window to keep it quick)
  const borrowers = (await getBorrowersFromBorrowEvents(provider, { ...c, borrowBackfillBlocks: 40000 })).slice(0, 30);
  console.log(`Sampled ${borrowers.length} borrowers on ${c.name}`);

  // Batched
  const t0 = Date.now();
  const batched = await aave.getUserHealthFactorsBatched(borrowers, provider, c);
  const batchMs = Date.now() - t0;

  // Spot-check 3 against single-call
  let mism = 0;
  for (let i = 0; i < Math.min(3, borrowers.length); i++) {
    const single = await getUserHealthFactor(borrowers[i], provider, c);
    const b = batched[i].healthFactor;
    const close = (single === b) || (single > 1e6 && b > 1e6) || Math.abs(single - b) < 0.01;
    console.log(`  ${borrowers[i].slice(0,10)}.. single=${single} batched=${b} ${close ? "OK" : "MISMATCH"}`);
    if (!close) mism++;
  }

  const below125 = batched.filter(x => Number.isFinite(x.healthFactor) && x.healthFactor < 1.25).length;
  console.log(`Batched ${borrowers.length} HFs in ${batchMs}ms. Below 1.25: ${below125}. Mismatches: ${mism}`);
  console.log(mism === 0 ? "✅ batched matches single-call" : "❌ mismatch detected");
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
