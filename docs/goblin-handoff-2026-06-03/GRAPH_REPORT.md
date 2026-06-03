# Graph Report - /Users/cobibean/Documents/liquidator(s()  (2026-06-02)

## Corpus Check
- Corpus is ~21,621 words - fits in a single context window. You may not need a graph.

## Summary
- 473 nodes · 763 edges · 38 communities (34 shown, 4 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 26 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Liquidation Discovery Core|Liquidation Discovery Core]]
- [[_COMMUNITY_Aave Helper Internals|Aave Helper Internals]]
- [[_COMMUNITY_Runtime Operations Docs|Runtime Operations Docs]]
- [[_COMMUNITY_Borrower State Management|Borrower State Management]]
- [[_COMMUNITY_Deployment Probe Scripts|Deployment Probe Scripts]]
- [[_COMMUNITY_Package Dependencies|Package Dependencies]]
- [[_COMMUNITY_Bot Liquidation Loop|Bot Liquidation Loop]]
- [[_COMMUNITY_Droplet Room Checks|Droplet Room Checks]]
- [[_COMMUNITY_Pool Event Utilities|Pool Event Utilities]]
- [[_COMMUNITY_Multi Chain Smoke Tests|Multi Chain Smoke Tests]]
- [[_COMMUNITY_Graphify Corpus Metadata|Graphify Corpus Metadata]]
- [[_COMMUNITY_Liquidation Preflight|Liquidation Preflight]]
- [[_COMMUNITY_Multicall Profit Scripts|Multicall Profit Scripts]]
- [[_COMMUNITY_Arbitrum Deployment|Arbitrum Deployment]]
- [[_COMMUNITY_Liquidator Deployment|Liquidator Deployment]]
- [[_COMMUNITY_Legacy Liquidator Artifact|Legacy Liquidator Artifact]]
- [[_COMMUNITY_SwapRouter Artifact|SwapRouter Artifact]]
- [[_COMMUNITY_Swap Router Interface|Swap Router Interface]]
- [[_COMMUNITY_Chain Configuration|Chain Configuration]]
- [[_COMMUNITY_Droplet Capacity Monitoring|Droplet Capacity Monitoring]]
- [[_COMMUNITY_Oracle Probes|Oracle Probes]]
- [[_COMMUNITY_Missed Liquidation Probe|Missed Liquidation Probe]]
- [[_COMMUNITY_Contract Compilation|Contract Compilation]]
- [[_COMMUNITY_Coverage Probe|Coverage Probe]]
- [[_COMMUNITY_Deployed Contract Probe|Deployed Contract Probe]]
- [[_COMMUNITY_New Contract Verification|New Contract Verification]]
- [[_COMMUNITY_Arbitrum Deploy Probe|Arbitrum Deploy Probe]]
- [[_COMMUNITY_Deployment Block Finder|Deployment Block Finder]]
- [[_COMMUNITY_Base Currency Probe|Base Currency Probe]]
- [[_COMMUNITY_Router WETH Probe|Router WETH Probe]]
- [[_COMMUNITY_Batched HF Test|Batched HF Test]]
- [[_COMMUNITY_Minimum Profit Test|Minimum Profit Test]]
- [[_COMMUNITY_Multicall Acceleration|Multicall Acceleration]]
- [[_COMMUNITY_Legacy Debug Artifact|Legacy Debug Artifact]]
- [[_COMMUNITY_Claude Permissions|Claude Permissions]]
- [[_COMMUNITY_Router Debug Artifact|Router Debug Artifact]]
- [[_COMMUNITY_Gas Snapshot|Gas Snapshot]]

## God Nodes (most connected - your core abstractions)
1. `createProvider()` - 42 edges
2. `getChainConfig()` - 26 edges
3. `getSelectedChainConfigs()` - 17 edges
4. `getBorrowersFromBorrowEvents()` - 16 edges
5. `getUnhealthyPositions()` - 16 edges
6. `getUserHealthFactor()` - 13 edges
7. `loadBorrowerSet()` - 11 edges
8. `smokeChain()` - 10 edges
9. `getDebtPosition()` - 8 edges
10. `scripts` - 8 edges

## Surprising Connections (you probably didn't know these)
- `Live Mode Safety` --conceptually_related_to--> `attemptLiquidation`  [INFERRED]
  AGENTS.md → bot.js
- `Flash Loan Liquidation Flow` --conceptually_related_to--> `AaveLiquidatorSwapRouter02 Contract Artifact`  [EXTRACTED]
  README.md → artifacts/contracts/AaveLiquidatorSwapRouter02.sol/AaveLiquidatorSwapRouter02.json
- `liquidator-data Volume` --shares_data_with--> `Borrower Store State`  [INFERRED]
  docker-compose.yml → aaveHelpers.js
- `Chainlink Price-Feed Trigger` --conceptually_related_to--> `Borrower Discovery`  [INFERRED]
  docs/event-driven-triggers.md → aaveHelpers.js
- `Liquidator Field Guide` --references--> `Profitability Gate`  [EXTRACTED]
  docs/liquidator-bot-overview.html → bot.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Liquidation Runtime Flow** — aavehelpers_getUnhealthyPositions, bot_attemptLiquidation, bot_simulateLiquidation, bot_computeMinProfitUnits, artifact_aaveLiquidatorSwapRouter02 [EXTRACTED 1.00]
- **Borrower State Persistence** — aavehelpers_getBorrowersFromBorrowEvents, aavehelpers_borrower_store_state, docker_compose_liquidator_data_volume [INFERRED 0.86]
- **Droplet Production Operations** — agents_digitalocean_droplet_runtime, agents_docker_compose_runtime, docker_compose_aave_liquidator_service, docs_migration_single_live_instance_rule, agents_live_mode_safety [EXTRACTED 1.00]
- **Droplet Room Monitoring SSH Fallback** — checkDropletRoom_dropletRoomCheck, checkDropletRoom_checkRoomViaMonitoring, checkDropletRoom_checkRoomOverSsh, checkDropletRoom_remoteRoomScript, checkDropletRoom_parseSshRoomOutput [EXTRACTED 1.00]
- **Deployment Readiness And Profit Floor** — compileContracts_swapRouter02Artifact, deployLiquidator_multiChainDeploy, deployArbitrumHardened_arbitrumHardenedDeploy, setMinProfit_minProfitFloorSetter, liquidationPreflight_preflightFlow, multiChainSmoke_smokeFlow, probeDeployedContract_contractVariantProbe [INFERRED 0.82]
- **Borrower Discovery Coverage Diagnostics** — recentLiquidations_realityCheck, checkMissedOverlap_recentBorrowOverlap, diagnoseScan_healthFactorDistribution, testDiscovery_backfillIncrementalValidation, probeDeepCoverage_borrowCoverageDepth, probeMeaningfulCoverage_sizeableLiquidationCoverage, probeMissedUsers_recentlyLiquidatedCurrentState [INFERRED 0.86]
- **Borrower Backfill Resume Flow** — testResumable_resumableBackfillCycleTest, testResume2_interruptedBackfillResumeTest, borrowerStore_borrowerDiscoveryState, borrowerStore_loadBorrowerSet, borrowerStore_saveBorrowerSet, aaveHelpers_getUnhealthyPositions [INFERRED 0.88]
- **Stratified Watchlist Sweep Flow** — testStratified_stratifiedSweepCycleTest, borrowerStore_watchlistState, borrowerStore_loadWatchlist, borrowerStore_saveWatchlist, aaveHelpers_getUnhealthyPositions [INFERRED 0.78]
- **Chain RPC Provider Resolution Flow** — chains_getChainConfig, chains_applyEnvOverrides, chains_resolveRpcUrls, provider_createProvider, provider_getRpcUrls, provider_fallbackRpcProvider [INFERRED 0.86]

## Communities (38 total, 4 thin omitted)

### Community 0 - "Liquidation Discovery Core"
Cohesion: 0.06
Nodes (45): getBorrowersFromBorrowEvents(), getUnhealthyPositions(), scanBorrowRange(), { createProvider }, ERC20, { ethers }, { getChainConfig }, LIQ (+37 more)

### Community 1 - "Aave Helper Internals"
Cohesion: 0.07
Nodes (41): { aggregate3InBatches }, BORROW_EVENT_ABI, ERC20_METADATA_ABI, { ethers }, fetch, getAssetMetadata(), getBorrowers(), getBorrowersFromSubgraph() (+33 more)

### Community 2 - "Runtime Operations Docs"
Cohesion: 0.07
Nodes (35): Borrower Discovery, Borrower Store State, getBorrowersFromBorrowEvents, getPrimaryCollateral, getPrimaryDebtPosition, getUnhealthyPositions, getUserHealthFactorsBatched, scanBorrowRange (+27 more)

### Community 3 - "Borrower State Management"
Cohesion: 0.10
Nodes (29): getUnhealthyPositions, Borrower Store Data Directory, Atomic JSON Persistence, Borrower Discovery State, loadBorrowerSet, loadWatchlist, saveBorrowerSet, saveWatchlist (+21 more)

### Community 4 - "Deployment Probe Scripts"
Cohesion: 0.09
Nodes (27): Recent Borrow Versus Liquidation Overlap Probe, SwapRouter02 Hardhat Artifact Generation, Arbitrum Hardened SwapRouter02 Deploy Flow, Per-Chain Deployment Handler, Liquidator Address Resolution, Liquidator Artifact Selection, Multi-Chain Liquidator Deploy Flow, Borrower Discovery Health Factor Distribution (+19 more)

### Community 5 - "Package Dependencies"
Cohesion: 0.08
Nodes (24): author, dependencies, @aave/contract-helpers, @aave/core-v3, dotenv, ethers, node-fetch, tree (+16 more)

### Community 6 - "Bot Liquidation Loop"
Cohesion: 0.13
Nodes (18): AAVE_ORACLE_ABI, attemptLiquidation(), chainConfigs, computeMinProfitUnits(), { createProvider }, delay(), { ethers }, fs (+10 more)

### Community 7 - "Droplet Room Checks"
Cohesion: 0.20
Nodes (18): buildRemoteRoomScript(), bytesToMb(), checkRoomOverSsh(), checkRoomViaMonitoring(), { execFileSync }, fetch, fetchDroplets(), fetchJson() (+10 more)

### Community 8 - "Pool Event Utilities"
Cohesion: 0.18
Nodes (14): checkBorrowEvents(), { createProvider }, { ethers }, { getChainConfig }, { createProvider }, { ethers }, getAavePoolFromProvider(), { getChainConfig } (+6 more)

### Community 9 - "Multi Chain Smoke Tests"
Cohesion: 0.21
Nodes (13): getReservesList(), ADDRESSES_PROVIDER_ABI, { createProvider, getRpcUrls }, { ethers }, {
  getBorrowersFromBorrowEvents,
  getReservesList,
  getUserHealthFactor,
}, { getGasSnapshot }, getLiquidatorAddress(), { getSelectedChainConfigs } (+5 more)

### Community 10 - "Graphify Corpus Metadata"
Cohesion: 0.14
Nodes (13): files, code, document, image, paper, video, graphifyignore_patterns, needs_graph (+5 more)

### Community 11 - "Liquidation Preflight"
Cohesion: 0.21
Nodes (13): compactError(), { createProvider }, { ethers }, expectStaticRevert(), {
  getBorrowersFromBorrowEvents,
  getPrimaryDebtPosition,
  getPrimaryCollateral,
  getUserHealthFactor,
}, getLiquidatorAddress(), { getSelectedChainConfigs }, loadLiquidatorArtifact() (+5 more)

### Community 12 - "Multicall Profit Scripts"
Cohesion: 0.15
Nodes (10): { createProvider }, { ethers }, { getSelectedChainConfigs }, ABI, { createProvider }, { ethers }, { getChainConfig }, { getTransactionOverrides } (+2 more)

### Community 13 - "Arbitrum Deployment"
Cohesion: 0.27
Nodes (8): { createProvider }, { ethers }, { getChainConfig }, { getTransactionOverrides }, loadArtifact(), main(), { ethers }, getTransactionOverrides()

### Community 14 - "Liquidator Deployment"
Cohesion: 0.29
Nodes (9): { createProvider }, { ethers }, getLiquidatorAddress(), { getSelectedChainConfigs }, { getTransactionOverrides }, handleChain(), loadLiquidatorArtifact(), main() (+1 more)

### Community 15 - "Legacy Liquidator Artifact"
Cohesion: 0.22
Nodes (8): abi, bytecode, contractName, deployedBytecode, deployedLinkReferences, _format, linkReferences, sourceName

### Community 16 - "SwapRouter Artifact"
Cohesion: 0.22
Nodes (8): abi, bytecode, contractName, deployedBytecode, deployedLinkReferences, _format, linkReferences, sourceName

### Community 17 - "Swap Router Interface"
Cohesion: 0.22
Nodes (8): abi, bytecode, contractName, deployedBytecode, deployedLinkReferences, _format, linkReferences, sourceName

### Community 18 - "Chain Configuration"
Cohesion: 0.39
Nodes (8): applyEnvOverrides(), CHAIN_CONFIGS, DEFAULT_CHAIN_KEYS, normalizeChainKey(), normalizeRpcUrls(), parsePositiveInt(), parseRpcUrls(), resolveRpcUrls()

### Community 19 - "Droplet Capacity Monitoring"
Cohesion: 0.25
Nodes (8): Check Room Over SSH, Check Room Via DigitalOcean Monitoring, DigitalOcean Droplet Room Check, Fetch DigitalOcean Droplets, Fetch Latest Droplet Metric, Monitoring Then SSH Room Fallback, Parse SSH Room Output, Remote Room Shell Script

### Community 20 - "Oracle Probes"
Cohesion: 0.29
Nodes (6): APROV, { createProvider }, { ethers }, { getSelectedChainConfigs }, ORACLE, WNATIVE

### Community 21 - "Missed Liquidation Probe"
Cohesion: 0.33
Nodes (5): { createProvider }, { ethers }, { getBorrowersFromBorrowEvents }, { getChainConfig }, LIQ_ABI

### Community 22 - "Contract Compilation"
Cohesion: 0.33
Nodes (4): contracts, fs, path, solc

### Community 23 - "Coverage Probe"
Cohesion: 0.33
Nodes (5): BORROW, { createProvider }, { ethers }, { getChainConfig }, LIQ

### Community 24 - "Deployed Contract Probe"
Cohesion: 0.33
Nodes (4): ABI, { createProvider }, { ethers }, { getSelectedChainConfigs }

### Community 25 - "New Contract Verification"
Cohesion: 0.33
Nodes (5): ABI, { createProvider }, { ethers }, { getChainConfig }, NEW

### Community 26 - "Arbitrum Deploy Probe"
Cohesion: 0.40
Nodes (4): ABI, { createProvider }, { ethers }, { getChainConfig }

### Community 27 - "Deployment Block Finder"
Cohesion: 0.40
Nodes (3): { createProvider }, { ethers }, { getSelectedChainConfigs }

### Community 28 - "Base Currency Probe"
Cohesion: 0.40
Nodes (4): { createProvider }, { ethers }, { getChainConfig }, POOL

### Community 29 - "Router WETH Probe"
Cohesion: 0.40
Nodes (4): ABI, { createProvider }, { ethers }, { getSelectedChainConfigs }

### Community 30 - "Batched HF Test"
Cohesion: 0.40
Nodes (4): aave, { createProvider }, { getBorrowersFromBorrowEvents, getUserHealthFactor }, { getChainConfig }

### Community 31 - "Minimum Profit Test"
Cohesion: 0.40
Nodes (4): { createProvider }, { ethers }, { getChainConfig }, ORACLE

### Community 32 - "Multicall Acceleration"
Cohesion: 0.50
Nodes (4): Multicall3 Canonical Address, aggregate3InBatches, getMulticall, Health Factor Sweep Acceleration

## Knowledge Gaps
- **250 isolated node(s):** `allow`, `code`, `document`, `paper`, `image` (+245 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createProvider()` connect `Pool Event Utilities` to `Liquidation Discovery Core`, `Aave Helper Internals`, `Bot Liquidation Loop`, `Multi Chain Smoke Tests`, `Liquidation Preflight`, `Multicall Profit Scripts`, `Arbitrum Deployment`, `Liquidator Deployment`, `Oracle Probes`, `Missed Liquidation Probe`, `Coverage Probe`, `Deployed Contract Probe`, `New Contract Verification`, `Arbitrum Deploy Probe`, `Deployment Block Finder`, `Base Currency Probe`, `Router WETH Probe`, `Batched HF Test`, `Minimum Profit Test`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Why does `getChainConfig()` connect `Pool Event Utilities` to `Liquidation Discovery Core`, `Aave Helper Internals`, `Multicall Profit Scripts`, `Arbitrum Deployment`, `Chain Configuration`, `Missed Liquidation Probe`, `Coverage Probe`, `New Contract Verification`, `Arbitrum Deploy Probe`, `Base Currency Probe`, `Batched HF Test`, `Minimum Profit Test`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `getSelectedChainConfigs()` connect `Liquidator Deployment` to `Liquidation Discovery Core`, `Aave Helper Internals`, `Bot Liquidation Loop`, `Multi Chain Smoke Tests`, `Liquidation Preflight`, `Multicall Profit Scripts`, `Chain Configuration`, `Oracle Probes`, `Deployed Contract Probe`, `Deployment Block Finder`, `Router WETH Probe`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **What connects `allow`, `code`, `document` to the rest of the system?**
  _250 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Liquidation Discovery Core` be split into smaller, more focused modules?**
  _Cohesion score 0.057329462989840346 - nodes in this community are weakly interconnected._
- **Should `Aave Helper Internals` be split into smaller, more focused modules?**
  _Cohesion score 0.07342995169082125 - nodes in this community are weakly interconnected._
- **Should `Runtime Operations Docs` be split into smaller, more focused modules?**
  _Cohesion score 0.07226890756302522 - nodes in this community are weakly interconnected._