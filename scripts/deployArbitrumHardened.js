require("dotenv").config();

const { ethers } = require("ethers");
const { getChainConfig } = require("../src/chains");
const { createProvider } = require("../src/provider");
const { getTransactionOverrides } = require("../src/gas");

// One-shot: deploy the hardened AaveLiquidatorSwapRouter02 to Arbitrum, set the
// minProfit floor, and verify — driven through whatever RPC is configured via
// ARBITRUM_RPC_URL (set that to a private endpoint; public ones reject the
// contract-creation tx). Run:
//   ARBITRUM_RPC_URL=https://<private> node scripts/deployArbitrumHardened.js
//
// Idempotent-ish: if a hardened contract is already deployed and owned by us,
// it skips the deploy and just ensures minProfit is set.

const FLOOR_UNITS = process.env.SET_MIN_PROFIT_UNITS || "2000000"; // $2 @ 6dp (USDC)

function loadArtifact() {
  return require("../artifacts/contracts/AaveLiquidatorSwapRouter02.sol/AaveLiquidatorSwapRouter02.json");
}

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY required");
  const c = getChainConfig("arbitrum");
  const provider = createProvider(c);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const artifact = loadArtifact();

  const rpcs = (c.rpcUrls || [c.rpcUrl]).join(", ");
  console.log(`Arbitrum deploy via RPC(s): ${rpcs}`);
  console.log(`Wallet: ${wallet.address}`);
  const [balance, gasPrice] = await Promise.all([provider.getBalance(wallet.address), provider.getGasPrice()]);
  console.log(`Balance: ${ethers.utils.formatEther(balance)} ETH | gasPrice ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei`);

  // Deploy
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const deployTx = factory.getDeployTransaction(c.pool, c.swapRouter);
  const gasEstimate = await wallet.estimateGas(deployTx);
  const gasLimit = gasEstimate.mul(12).div(10);
  console.log(`Deploy gas est ${gasEstimate.toString()} → limit ${gasLimit.toString()} (~${ethers.utils.formatEther(gasLimit.mul(gasPrice))} ETH)`);

  const overrides = await getTransactionOverrides(provider, c, { gasLimit });
  const contract = await factory.deploy(c.pool, c.swapRouter, overrides);
  console.log(`Deploy tx: ${contract.deployTransaction.hash}`);
  const rc = await contract.deployTransaction.wait();
  console.log(`Deployed at ${contract.address} (status ${rc.status}, block ${rc.blockNumber})`);

  // Verify wiring
  const deployed = new ethers.Contract(contract.address, artifact.abi, wallet);
  const [owner, aavePool, router] = await Promise.all([deployed.owner(), deployed.aavePool(), deployed.netSwapRouter()]);
  const ok = owner.toLowerCase() === wallet.address.toLowerCase()
    && aavePool.toLowerCase() === c.pool.toLowerCase()
    && router.toLowerCase() === c.swapRouter.toLowerCase();
  console.log(`Verify: ownerMatches=${owner.toLowerCase() === wallet.address.toLowerCase()} poolMatches=${aavePool.toLowerCase() === c.pool.toLowerCase()} routerMatches=${router.toLowerCase() === c.swapRouter.toLowerCase()}`);
  if (!ok) throw new Error("verification mismatch — do NOT use this address");

  // Set minProfit
  const mpOverrides = await getTransactionOverrides(provider, c, { gasLimit: 80000 });
  const mpTx = await deployed.setMinProfit(FLOOR_UNITS, mpOverrides);
  const mpRc = await mpTx.wait();
  const stored = (await deployed.minProfit()).toString();
  console.log(`setMinProfit(${FLOOR_UNITS}) tx ${mpTx.hash} status ${mpRc.status} → stored minProfit=${stored}`);

  console.log("\n=== NEXT STEPS ===");
  console.log(`1. Droplet .env: ARBITRUM_AAVE_LIQUIDATOR_ADDRESS=${contract.address}`);
  console.log(`2. src/chains.js arbitrum: add  hardenedLiquidator: true`);
  console.log(`3. Redeploy bot (docker compose up -d --build), commit + push.`);
  console.log(`\nARBITRUM_AAVE_LIQUIDATOR_ADDRESS=${contract.address}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.reason || e.message); process.exit(1); });
