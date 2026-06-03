// Memory probe: proves the streaming HF sweep holds flat heap at Base scale
// while the old materialized path's heap grows with borrower count (the OOM).
// No network — a stub Multicall3 returns canned getUserAccountData blobs, so we
// isolate the memory profile of result accumulation, which is the actual killer.
//
// Run BOTH (separate processes so heaps don't pollute each other):
//   node --max-old-space-size=1900 scripts/probeStreamMemory.js materialized 210000
//   node --max-old-space-size=1900 scripts/probeStreamMemory.js streaming   210000
//
// Expectation: materialized either OOMs or shows peak heap scaling with N;
// streaming completes with peak heap roughly constant (~batchSize-bound).
const { ethers } = require("ethers");
const aave = require("../aaveHelpers");

const mode = process.argv[2] || "streaming";
const N = parseInt(process.argv[3] || "210000", 10);

// One realistic getUserAccountData return blob (6 × uint256), reused for every
// call. healthFactor = 2.0 (1e18 scaled ×2), totalDebtBase = $0 → healthy/skip,
// which mirrors the common case and keeps candidate/watch sets empty (the
// streaming path's whole point is that those stay tiny regardless of N).
const IFACE = new ethers.utils.Interface([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);
const RETURN_BLOB = IFACE.encodeFunctionResult("getUserAccountData", [
  ethers.utils.parseUnits("1000", 8), // collateral
  0,                                  // debt = 0 → healthy
  0, 8000, 7500,
  ethers.utils.parseUnits("2", 18),   // HF = 2.0
]);

// Multicall3's aggregate3 ABI return type — used to encode the stub response at
// the provider.call() seam (the layer both sweep paths share via ethers.Contract).
const AGG3_RET = ["tuple(bool success, bytes returnData)[]"];

// A stub provider: getMulticall() builds an ethers.Contract bound to this, and
// .callStatic.aggregate3(slice) ultimately calls provider.call(). We intercept
// there and return canned results, so the probe runs with zero RPC and isolates
// the memory profile of result accumulation.
function makeStubProvider() {
  return {
    // ethers.Contract needs these to construct + dispatch a view call.
    async call(tx) {
      // Decode how many calls were in this batch so we return a matching count.
      const MC3_IFACE = new ethers.utils.Interface([
        "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
      ]);
      const [calls] = MC3_IFACE.decodeFunctionData("aggregate3", tx.data);
      const out = calls.map(() => ({ success: true, returnData: RETURN_BLOB }));
      return ethers.utils.defaultAbiCoder.encode(AGG3_RET, [out]);
    },
    async getNetwork() { return { chainId: 1, name: "probe" }; },
    _isProvider: true,
  };
}

function mb(bytes) { return (bytes / 1048576).toFixed(0); }

(async () => {
  // Synthetic borrower addresses. The address array itself is unavoidable input
  // (both paths receive it); what we're measuring is whether RESULTS accumulate.
  const users = new Array(N);
  for (let i = 0; i < N; i++) {
    users[i] = "0x" + i.toString(16).padStart(40, "0");
  }

  const chainConfig = { pool: "0x0000000000000000000000000000000000000001", name: "Probe" };
  const provider = makeStubProvider();
  let peakHeap = 0;
  const sampleHeap = () => { const h = process.memoryUsage().heapUsed; if (h > peakHeap) peakHeap = h; };
  const interval = setInterval(sampleHeap, 25);

  const t0 = Date.now();
  if (mode === "materialized") {
    const results = await aave.getUserHealthFactorsBatched(users, provider, chainConfig);
    sampleHeap();
    console.log(`materialized: produced ${results.length} results`);
  } else {
    let count = 0;
    await aave.sweepHealthFactorsStreaming(users, provider, chainConfig, () => { count++; });
    sampleHeap();
    console.log(`streaming: folded ${count} results`);
  }
  clearInterval(interval);
  sampleHeap();

  console.log(`mode=${mode} N=${N} elapsedMs=${Date.now() - t0} peakHeapMB=${mb(peakHeap)} rssMB=${mb(process.memoryUsage().rss)}`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
