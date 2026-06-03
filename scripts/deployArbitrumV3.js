// One-off Arbitrum deploy of the V3 path-aware AaveLiquidatorSwapRouter02 using
// EXPLICITLY-CAPPED EIP-1559 fees. Arbitrum Nitro prefers 1559 typed txs (legacy
// contract-creation triggered "processing response error" on broadcast even
// though eth_call/estimateGas succeed). We cap maxFeePerGas low enough that the
// node's intrinsic-cost guard (gasLimit × maxFeePerGas) fits a thin balance,
// while staying far above the ~0.02 gwei base fee so it mines promptly.
//
// SAFETY: aborts before broadcast if gasLimit × maxFeePerGas > balance (so we
// never hit the intrinsic-cost rejection), and verifies immutables after.
// Must run where ARBITRUM_RPC_URL (private) + PRIVATE_KEY are set (droplet
// container). Reads CHAIN=arbitrum config.
//
// Usage (in container): node scripts/deployArbitrumV3.js
//   env: DEPLOY=true to broadcast (else dry-run), MAX_FEE_GWEI (default 0.5),
//        PRIORITY_FEE_GWEI (default 0.02)

require("dotenv").config();
const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");

const art = require("../artifacts/contracts/AaveLiquidatorSwapRouter02.sol/AaveLiquidatorSwapRouter02.json");

async function main() {
  const cfg = getChainConfig("arbitrum");
  const url = process.env.ARBITRUM_RPC_URL;
  if (!url) throw new Error("ARBITRUM_RPC_URL not set (private RPC required)");
  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY not set");

  const provider = new ethers.providers.JsonRpcProvider(url);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);

  const router = cfg.swapRouter;
  const pool = cfg.pool;
  console.log("Arbitrum V3 deploy");
  console.log("  wallet:", wallet.address, "router:", router, "pool:", pool);

  const deployTx = factory.getDeployTransaction(pool, router);
  const [balance, gasEstimate, feeData, net] = await Promise.all([
    provider.getBalance(wallet.address),
    wallet.estimateGas(deployTx),
    provider.getFeeData(),
    provider.getNetwork(),
  ]);
  if (net.chainId !== cfg.chainId) throw new Error(`wrong chain: got ${net.chainId}, want ${cfg.chainId}`);

  const gasLimit = gasEstimate.mul(12).div(10); // 20% buffer
  const maxFeePerGas = ethers.utils.parseUnits(process.env.MAX_FEE_GWEI || "0.5", "gwei");
  const maxPriorityFeePerGas = ethers.utils.parseUnits(process.env.PRIORITY_FEE_GWEI || "0.02", "gwei");

  const worstCaseCost = gasLimit.mul(maxFeePerGas); // intrinsic-cost guard uses this
  const expectedCost = gasLimit.mul(feeData.lastBaseFeePerGas || feeData.gasPrice || maxPriorityFeePerGas);
  console.log("  balance:", ethers.utils.formatEther(balance), "ETH");
  console.log("  baseFee:", feeData.lastBaseFeePerGas && ethers.utils.formatUnits(feeData.lastBaseFeePerGas, "gwei"), "gwei");
  console.log("  gasLimit:", gasLimit.toString(), "maxFeePerGas:", ethers.utils.formatUnits(maxFeePerGas, "gwei"), "gwei");
  console.log("  worst-case (guard) cost:", ethers.utils.formatEther(worstCaseCost), "ETH");
  console.log("  expected actual cost:   ", ethers.utils.formatEther(expectedCost), "ETH");

  if (worstCaseCost.gte(balance)) {
    console.error(`ABORT: worst-case cost (${ethers.utils.formatEther(worstCaseCost)}) >= balance (${ethers.utils.formatEther(balance)}). ` +
      `Lower MAX_FEE_GWEI or top up the wallet. Need >= ${ethers.utils.formatEther(worstCaseCost)} ETH.`);
    process.exit(2);
  }

  if (process.env.DEPLOY !== "true") {
    console.log("DRY RUN ok (set DEPLOY=true to broadcast).");
    return;
  }

  console.log("Broadcasting 1559 deploy...");
  const contract = await factory.deploy(pool, router, {
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  console.log("  tx:", contract.deployTransaction.hash);
  const receipt = await contract.deployTransaction.wait();
  console.log("  status:", receipt.status, "block:", receipt.blockNumber, "addr:", contract.address);

  // Verify immutables.
  const c = new ethers.Contract(contract.address, art.abi, provider);
  const [ap, nr, ow, ints] = await Promise.all([
    c.aavePool(), c.netSwapRouter(), c.owner(), c.getIntermediateTokens(),
  ]);
  console.log("  verify: aavePool", ap, "match", ap.toLowerCase() === pool.toLowerCase());
  console.log("  verify: netSwapRouter", nr, "match", nr.toLowerCase() === router.toLowerCase());
  console.log("  verify: owner", ow, "match", ow.toLowerCase() === wallet.address.toLowerCase());
  console.log("  verify: intermediates", ints);
  console.log(`\nARBITRUM_AAVE_LIQUIDATOR_ADDRESS=${contract.address}`);
}

main().catch((e) => { console.error("FATAL", (e.error && e.error.message) || e.message); process.exit(1); });
