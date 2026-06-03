const { ethers } = require("ethers");

// Multicall3 is deployed at the same canonical address on every chain we run
// (verified on plasma/arbitrum/base/avalanche/optimism). It lets us collapse
// hundreds of getUserAccountData reads into a handful of RPC round-trips,
// which is the difference between a multi-minute HF sweep and a few seconds.
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
];

function getMulticall(provider) {
  return new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
}

// Calls aggregate3 on a single slice, returning { success, returnData } in
// input order. If the whole batch reverts (e.g. RPC payload too big), every
// entry is marked failed so the caller can decide how to handle the gap.
async function aggregate3Once(multicall, slice) {
  try {
    return await multicall.callStatic.aggregate3(slice);
  } catch (error) {
    return slice.map(() => ({ success: false, returnData: "0x" }));
  }
}

// Streams aggregate3 over `calls` in batches of `batchSize`, invoking
// `onBatch(batchResults, startIndex)` for each batch and DISCARDING the batch
// before fetching the next. This is the memory-safe path for very large call
// sets (e.g. Base's ~210k borrowers): peak heap is O(batchSize), not O(calls).
// `onBatch` may be async and is awaited. Returns nothing — the caller folds
// each batch's results into its own accumulators.
async function aggregate3Streaming(provider, calls, batchSize, onBatch) {
  const multicall = getMulticall(provider);
  for (let i = 0; i < calls.length; i += batchSize) {
    const slice = calls.slice(i, i + batchSize);
    const batchResults = await aggregate3Once(multicall, slice);
    await onBatch(batchResults, i);
  }
}

// Runs aggregate3 over `calls` in batches of `batchSize`, allowing individual
// calls to fail (allowFailure=true) so one bad address can't sink the batch.
// Returns a flat array of { success, returnData } in input order. NOTE: this
// materializes ALL results in memory — use aggregate3Streaming for large sets.
async function aggregate3InBatches(provider, calls, batchSize = 300) {
  const multicall = getMulticall(provider);
  const results = [];

  for (let i = 0; i < calls.length; i += batchSize) {
    const slice = calls.slice(i, i + batchSize);
    const batchResults = await aggregate3Once(multicall, slice);
    results.push(...batchResults);
  }

  return results;
}

module.exports = {
  MULTICALL3_ADDRESS,
  getMulticall,
  aggregate3InBatches,
  aggregate3Streaming,
};
