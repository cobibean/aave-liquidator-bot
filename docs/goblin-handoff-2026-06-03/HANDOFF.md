# Flash-Loan Liquidator Handoff

Prepared: 2026-06-03 UTC

## Status

Blocked / unsafe to claim production runtime verified.

The dedicated host `liquidator-solo-2` at `100.119.53.21` is reachable over the tailnet through `knwldg`, but no liquidator runtime was found there. The host appears to be a fresh baseline droplet: no Node/npm, no Docker, no PM2, no obvious repo under `/opt`, `/root`, `/home`, `/srv`, and no matching liquidator process.

No live liquidation, transfer, approval, swap, contract write, or transaction broadcast was triggered during this inspection.

## Runtime

Expected repo/runtime from local project docs:

- Repo/app path when deployed: `/opt/aave-liquidator-bot`
- Docker Compose service/container: `aave-liquidator`
- Compose env file: `/opt/aave-liquidator-bot/.env`
- Main entrypoint: `bot.js`
- Package main: `bot.js`
- Docker log rotation in local compose: `json-file`, `max-size=10m`, `max-file=3`

Dedicated host observation:

- Host checked: `root@100.119.53.21`
- Hostname returned: `liquidator-solo-2`
- Access path used: `ssh knwldg`, then `ssh -i /root/.ssh/knwldg_tailnet_ed25519 root@100.119.53.21`
- Node/npm/PM2/Docker: not installed
- Repo candidates: none found under expected locations
- Matching files/directories: none found for project-specific `aave` or `liquidator` paths
- Matching processes: none
- Matching systemd units: none
- Matching containers: Docker not installed
- App logs: unavailable because no app runtime/container/service was found

## Safety / Secrets

No secret values are included here. Only paths and variable names are listed.

Config/env paths checked on the dedicated host:

- `/opt/aave-liquidator-bot/.env`: not found
- Other expected app env files under `/opt`, `/root`, `/home`, `/srv`: not found

Important env/config variable names from source:

- Required signer secret: `PRIVATE_KEY`
- Runtime mode: `TEST_MODE`
- Chain selection: `CHAINS`, `CHAIN`
- Liquidator addresses: `<CHAIN>_AAVE_LIQUIDATOR_ADDRESS`, `AAVE_LIQUIDATOR_ADDRESS`
- RPC overrides: `<CHAIN>_RPC_URLS`, `<CHAIN>_RPC_URL`, `RPC_URLS`, `RPC_URL`
- Aave/config overrides: `<CHAIN>_POOL_ADDRESS`, `<CHAIN>_POOL_ADDRESSES_PROVIDER`, `<CHAIN>_PROTOCOL_DATA_PROVIDER`, `<CHAIN>_DEBT_ASSET_ADDRESS`, `<CHAIN>_SUBGRAPH_URL`
- Gas/scan overrides: `<CHAIN>_GAS_PRICE_BUMP_GWEI`, `GAS_PRICE_BUMP_GWEI`, `<CHAIN>_LIQUIDATION_GAS_LIMIT`, `LIQUIDATION_GAS_LIMIT`, `<CHAIN>_BORROW_SCAN_BLOCKS`, `BORROW_SCAN_BLOCKS`, `<CHAIN>_BORROW_SCAN_CHUNK_SIZE`, `BORROW_SCAN_CHUNK_SIZE`, `<CHAIN>_BORROW_BACKFILL_BLOCKS`, `BORROW_BACKFILL_BLOCKS`
- Strategy/loop controls: `SCAN_INTERVAL_MS`, `PROFIT_SAFETY_MULTIPLE`, `MIN_PROFIT_USD`, `LIQUIDATION_THRESHOLD`, `WATCHLIST_HF`, `FULL_SWEEP_EVERY_N`, `MIN_DEBT_USD`, `MIN_DEBT_TO_COVER`, `BORROW_BACKFILL_FROM_DEPLOYMENT`, `CHECKPOINT_EVERY_CHUNKS`, `VERBOSE_HEALTH_LOGS`
- Preflight controls: `PREFLIGHT_MAX_BORROWERS`, `PREFLIGHT_CHAINS`

## Old Host Check

Host checked: `root@100.79.13.59`

Result:

- The host at `100.79.13.59` returned hostname `job-hunter`, not `hermes-fleet-1`.
- Docker is installed there, but no matching `aave`, `liquidator`, or liquidator-bot container was found.
- PM2 is not installed.
- No matching systemd service was found.
- No matching `aave`, `liquidator`, `liquidation`, or `bot.js` process was found.
- No unrelated Hermes/job-hunter services were stopped or modified.

Conclusion: no duplicate liquidator runtime was found on the old host address checked.

## Graphify Architecture Context for Goblin

Graph location in local repo:

- `/Users/cobibean/Documents/liquidator(s()/graphify-out`

Included copied graph files in this package:

- `GRAPH_REPORT.md`
- `graph.json`
- `graph.html`

Graphify report highlights:

- Graphify corpus: 473 nodes, 763 edges, 38 communities.
- Extraction mix: 97% `EXTRACTED`, 3% `INFERRED`, 0% `AMBIGUOUS`.
- Main graph hubs: `createProvider()`, `getChainConfig()`, `getSelectedChainConfigs()`, `getBorrowersFromBorrowEvents()`, `getUnhealthyPositions()`, `getUserHealthFactor()`, `loadBorrowerSet()`.
- Major communities include Liquidation Discovery Core, Aave Helper Internals, Runtime Operations Docs, Borrower State Management, Bot Liquidation Loop, Chain Configuration, Liquidation Preflight, Liquidator Deployment, and Droplet operations.

Architecture notes:

- `bot.js` loads `.env`, requires `PRIVATE_KEY`, chooses chain configs, creates a provider, creates an `ethers.Wallet`, and starts one async loop per selected chain.
- `TEST_MODE` defaults to enabled unless `TEST_MODE` is exactly `false`; transaction submission only occurs after the test-mode guard.
- The runtime loop calls `getUnhealthyPositions()`, then calls `attemptLiquidation()` for each returned opportunity.
- Borrower discovery is event/backfill aware: it backfills Borrow events once, persists borrower state, then scans incrementally.
- Health factor sweeps are stratified: full sweeps refresh the watchlist, while normal cycles focus on watchlisted or newly discovered borrowers.
- Candidate selection filters by health factor, total debt USD, token debt floor, and collateral availability before attempting liquidation.
- Before any transaction-send branch, the bot rechecks health factor and runs `callStatic.triggerLiquidation(...)` as a profitability/viability pre-check.
- The live send path builds gas overrides, computes a gas-aware minimum-profit floor, and then calls either `triggerLiquidationWithMinProfit(...)` or the older `triggerLiquidation(...)` path.
- `src/provider.js` builds `StaticJsonRpcProvider` for one URL or an `ethers.providers.FallbackProvider` when multiple RPC URLs are configured.
- `scripts/liquidationPreflight.js` is a dry/static-call oriented verification path: it checks owner/pool/router and expects direct/liquidator static calls on a healthy borrower to revert.

Risk paths to verify against source before any live action:

- Signing and wallet creation: `bot.js`, `new ethers.Wallet(process.env.PRIVATE_KEY, provider)`
- Live mode gate: `bot.js`, `process.env.TEST_MODE !== "false"`
- Transaction construction/submission: `bot.js`, `attemptLiquidation()`
- Static-call pre-check: `bot.js`, `simulateLiquidation()`
- Gas override and liquidation gas limit: `src/gas.js`, `getTransactionOverrides()`
- Config/env loading and overrides: `bot.js`, `src/chains.js`, `src/provider.js`
- Liquidator address resolution: `bot.js`, `scripts/liquidationPreflight.js`
- Borrower state persistence: `src/borrowerStore.js`
- Borrower discovery and candidate selection: `aaveHelpers.js`, `getBorrowersFromBorrowEvents()`, `getUnhealthyPositions()`
- Deployment/preflight scripts: `scripts/deployLiquidator.js`, `scripts/liquidationPreflight.js`

Recommended Graphify queries for Goblin:

- `graphify query "What are the main runtime entrypoints?"`
- `graphify query "Trace liquidation execution from opportunity detection to transaction submission." --dfs`
- `graphify query "What modules touch wallet signing, private keys, RPC submission, or config loading?"`
- `graphify query "What is the dry-run or simulation path?"`
- `graphify query "How do chain env overrides flow into provider creation and transaction submission?" --dfs`
- `graphify query "Where is borrower state persisted and how does backfill resume?"`
- `graphify query "Which scripts can deploy contracts or change on-chain settings?"`

Safety line:
Goblin should use the Graphify graph as a map, not as proof: verify graph-derived claims against source files before changing runtime behavior or approving any live financial action.

## Handoff Package

Package path:

- `/Users/cobibean/Documents/liquidator(s()/docs/goblin-handoff-2026-06-03`

Included files:

- `HANDOFF.md`
- `GRAPH_REPORT.md`
- `graph.json`
- `graph.html`
- `checksums.sha256`

Graph artifact sizes/checksums copied from `graphify-out`:

- `GRAPH_REPORT.md`: 15,303 bytes, SHA256 `904b6e5d5b87a1092f4f1ad1b5dd0caae513ded09f43014349369bee36010e05`
- `graph.json`: 388,567 bytes, SHA256 `aef16c3aa2232b286501f110ae30b594a75ac3eea000c4d6d2abda6f35c06255`
- `graph.html`: 382,823 bytes, SHA256 `9b78b1839719cdf7d6576900d0c4faa8c420b9c19eebbac49155b2b918277f59`

## Next Step

Provision or sync the liquidator repo onto `liquidator-solo-2`, install the intended runtime manager, put the redacted `.env` in the expected location, and start only one instance in `TEST_MODE=true` first. After that, rerun this inspection and only consider live mode after the host, service, logs, wallet ownership, and static-call preflight all verify cleanly.
