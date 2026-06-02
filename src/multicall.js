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

// Runs aggregate3 over `calls` in batches of `batchSize`, allowing individual
// calls to fail (allowFailure=true) so one bad address can't sink the batch.
// Returns a flat array of { success, returnData } in input order.
async function aggregate3InBatches(provider, calls, batchSize = 300) {
  const multicall = getMulticall(provider);
  const results = [];

  for (let i = 0; i < calls.length; i += batchSize) {
    const slice = calls.slice(i, i + batchSize);
    try {
      const batchResults = await multicall.callStatic.aggregate3(slice);
      results.push(...batchResults);
    } catch (error) {
      // If the whole batch reverts (e.g. RPC payload too big), fall back to
      // marking this slice as failed; caller decides how to handle gaps.
      for (let j = 0; j < slice.length; j++) {
        results.push({ success: false, returnData: "0x" });
      }
    }
  }

  return results;
}

module.exports = {
  MULTICALL3_ADDRESS,
  getMulticall,
  aggregate3InBatches,
};
