require("dotenv").config();
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getBorrowersFromBorrowEvents } = require("../aaveHelpers");
const aave = require("../aaveHelpers");

// Equivalence check: the new memory-safe sweepHealthFactorsStreaming must
// produce exactly the same per-user { healthFactor, totalDebtUsd } as the
// materialized getUserHealthFactorsBatched it replaces in getUnhealthyPositions.
// Run: node scripts/testStreamingSweep.js [chainKey] [sampleSize]
(async () => {
  const key = process.argv[2] || "avalanche";
  const sampleSize = parseInt(process.argv[3] || "120", 10);
  const c = getChainConfig(key);
  const provider = createProvider(c);

  const borrowers = (await getBorrowersFromBorrowEvents(provider, { ...c, borrowBackfillBlocks: 40000 })).slice(0, sampleSize);
  console.log(`Sampled ${borrowers.length} borrowers on ${c.name}`);

  // Pin both reads to ONE block. Aave debt accrues interest every block, so two
  // reads taken seconds apart (different block heights) legitimately differ by
  // ~1e-8 — that's accrual, not a decode bug. Pinning the blockTag makes the two
  // paths read identical chain state, so any remaining diff is a real code bug.
  const pinnedBlock = await provider.getBlockNumber();
  const realCall = provider.call.bind(provider);
  provider.call = (tx, blockTag) => realCall(tx, blockTag == null || blockTag === "latest" ? pinnedBlock : blockTag);
  console.log(`Pinned both reads to block ${pinnedBlock}`);

  // Materialized (old path).
  const batched = await aave.getUserHealthFactorsBatched(borrowers, provider, c);
  const byUser = new Map(batched.map((r) => [r.user, r]));

  // Streaming (new path) — fold into a map the same way getUnhealthyPositions does.
  const streamed = new Map();
  const sweptCount = await aave.sweepHealthFactorsStreaming(borrowers, provider, c, ({ user, healthFactor, totalDebtUsd }) => {
    streamed.set(user, { healthFactor, totalDebtUsd });
  });

  let mism = 0;
  if (sweptCount !== borrowers.length) {
    console.log(`❌ swept count ${sweptCount} != input ${borrowers.length}`);
    mism++;
  }
  for (const user of borrowers) {
    const b = byUser.get(user);
    const s = streamed.get(user);
    if (!s) { console.log(`❌ ${user.slice(0,10)}.. missing from stream`); mism++; continue; }
    // Block-pinned, so reads should be bit-identical; allow only float-parse noise.
    const hfMatch = (b.healthFactor === s.healthFactor) ||
      (b.healthFactor > 1e6 && s.healthFactor > 1e6) ||
      (Number.isFinite(b.healthFactor) && Number.isFinite(s.healthFactor) && Math.abs(b.healthFactor - s.healthFactor) < 1e-12);
    const debtMatch = Math.abs((b.totalDebtUsd || 0) - (s.totalDebtUsd || 0)) < 1e-6;
    if (!hfMatch || !debtMatch) {
      console.log(`❌ ${user.slice(0,10)}.. batched={hf:${b.healthFactor},debt:${b.totalDebtUsd}} stream={hf:${s.healthFactor},debt:${s.totalDebtUsd}}`);
      mism++;
    }
  }

  console.log(`Compared ${borrowers.length} users. Mismatches: ${mism}`);
  console.log(mism === 0 ? "✅ streaming sweep matches materialized batched" : "❌ mismatch detected");
  process.exit(mism === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
