# Aave Liquidator — V2→V3 Swap-Router Fix + Task 3.3 (Path-in-Calldata) — 2026-06-03

Audience: the next agent. Records what was broken, what changed, what is now LIVE
on the droplet, the gotchas hit, and what to watch for. Pairs with the plan at
`docs/swap-router-v3-fix-plan.md` and the prior memory
`docs/memory/2026-06-03/liquidator-oom-fix-and-layers-2026-06-03.md`.

## Headline

The on-chain collateral→debt swap in `executeOperation` would REVERT on 4 of 5
chains. The contract `AaveLiquidatorSwapRouter02.sol` is Uniswap-V3-only
(`factory.getPool` + `exactInput`), but `src/chains.js` had **V2/SushiSwap
routers** configured on arbitrum/base/avalanche/optimism. Their factories expose
`getPair(a,b)` (V2), not `getPool(a,b,fee)` (V3) → the swap branch could never
execute there. Verified live. This is why no live `executeOperation` had ever
succeeded on those chains.

FIXED: pointed `swapRouter` at the correct V3 SwapRouter02 per chain and
REDEPLOYED the contract (netSwapRouter is immutable). Bundled task 3.3
(off-chain-resolved swap path passed in calldata). **All 4 chains are now LIVE on
the new V3 path-aware contract `0x81f151E54B9578337f95bb84C821b96A73E98194`**
(same CREATE address per chain — same deployer + nonce). Plasma was already a V3
fork and is unchanged.

## Verified root cause (don't re-litigate)

- `_findFeeTier` calls `netSwapRouter.factory().getPool(tokenIn,tokenOut,fee)` and
  the swap is `netSwapRouter.exactInput({path,...})` — both V3-only.
- On-chain proof (`scripts/probeSwapVenue.js`): the OLD configured routers'
  factories REVERT on `getPool` (or have no pool) while V2 `getPair` returns real
  pairs. The old deployed Base contract `0x049DBB52…` had V2 router `0x4752ba5D…`
  immutable; a full-flow callStatic of its swap reverted "Invalid params".
- Real collateral coverage (`scripts/probeCollateralVenues.js`, resolving each
  live-watchlist user's actual collateral→debt pair): the proposed V3 routers
  cover 100% (arb/base/op) / ~99% (avax — only WETH.e→GHO, 1 wallet, lacks a path)
  of real pairs.

## Verified correct V3 SwapRouter02 + factory (per chain)

- arbitrum/optimism: router `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`
- base:      router `0x2626664c2603336E57B271c5C0b26F421741e481`, factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`
- avalanche: router `0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE`, factory `0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD`
The canonical V3 factory `0x1F98431c8a` is NOT universal — base/avalanche differ.
Each V3 router exposes `WETH9()` returning the correct WNATIVE, so the contract
constructor auto-seeds WNATIVE as a 2-hop intermediate (no setIntermediateTokens
needed).

## What changed (code) — committed `910ef3b` + `5e61c69`, pushed to origin/main

### Contract (task 3.3, additive + backward-compatible)
- Added `triggerLiquidationWithPath(debtAsset,debtAmount,user,collateral,minProfitForCall,bytes swapPath)`.
- `_triggerLiquidation` now carries an optional path; flash-loan params became a
  4-field tuple `(user, collateral, floor, bytes swapPath)`.
- `executeOperation` decodes the 4-field tuple and uses the supplied path when
  non-empty, else on-chain `_resolveSwapPath`. EMPTY path = old behavior (no
  regression). 4-arg `triggerLiquidation` + 5-arg `triggerLiquidationWithMinProfit`
  unchanged. Compiles clean (`npm run compile`, viaIR).

### chains.js
- `swapRouter` → V3 on arbitrum/base/avalanche/optimism. `pathAware: true` on all
  four (flag the bot keys off to use the path entrypoint). Plasma `pathAware`
  absent/false (unchanged).

### bot.js + aaveHelpers.js
- `resolveSwapPath(provider, chainConfig, tokenIn, tokenOut)` (aaveHelpers,
  exported): builds the packed V3 path off-chain.
- `attemptLiquidation` resolves the path on `pathAware` chains and threads it into
  BOTH `simulateLiquidation` (the callStatic gate now mirrors the entrypoint it
  will broadcast) and `broadcast()` (`triggerLiquidationWithPath`). "0x"/failure ⇒
  contract self-resolves.

### LIQUIDITY-AWARE RESOLVER (important correctness win)
The contract's naive `_findFeeTier` returns the FIRST tier where `getPool != 0` —
even if that pool has ZERO liquidity. Verified on Base: cbETH/USDC, weETH/USDC,
WETH/GHO, EURC/USDC all have an EMPTY 100bps pool, so the naive path routes
through a dead pool and REVERTS. Proof via real `exactInput` dry-run
(`scripts/verifyExactInputCallStatic.js`, state-override balances): naive = 2 OK /
3 fail on Base; after fix = **5 OK / 0 fail** (WETH→USDC now via 3000bps, WETH→GHO
via 10000). So `resolveSwapPath.findFeeTier` reads `pool.liquidity()` and picks the
highest-liquidity tier, skipping empties → path-in-calldata is STRICTLY better than
the contract's on-chain resolution.

### Scripts
- New verify/probe (read-only): `probeSwapVenue.js`, `probeCollateralVenues.js`,
  `testSwapPathEquivalence.js`, `verifySwapLegWorks.js`,
  `verifyExactInputCallStatic.js`, `verifyPathLiquidationCallStatic.js`,
  `verifyPathAtHistoricalLiquidation.js`.
- `deployLiquidator.js` + `setMinProfit.js`: now pass `legacy: true` for these
  non-competitive txs (env `DEPLOY_USE_1559=true` to opt back). `setMinProfit.js`
  gained a generic `<CHAIN>_LIQUIDATOR_OVERRIDE` and its `NEW` map now points at
  the V3 redeploy address (was STALE old addresses for avax/op — a trap).
- New `deployArbitrumV3.js`: 1559 capped-fee deploy for Arbitrum (see gotcha).

## What is LIVE on the droplet (solo-1, 165.227.191.252, /opt/aave-liquidator-bot)

All deployed by wallet `0x40aBdc50e3B619D072754a767578EE2a4a4F954d`, minProfit $1
(1000000, 6dp; the bot adds a per-call $1 + 2×gasUSD floor on top via
triggerLiquidationWithMinProfit/WithPath). TEST_MODE=false throughout.

| chain     | new contract  | deploy tx (block)            | router  | pathAware |
|-----------|---------------|------------------------------|---------|-----------|
| base      | 0x81f151E5…   | 0x218d02c4 (46868520)        | V3      | true      |
| avalanche | 0x81f151E5…   | 0xb3e0196f (87114769)        | V3      | true      |
| optimism  | 0x81f151E5…   | 0x940ad5bc (152464462)       | V3      | true      |
| arbitrum  | 0x81f151E5…   | 0x1b85c93a (469772671)       | V3      | true      |
| plasma    | (unchanged)   | —                            | V3 fork | false     |

Fleet at handoff: 6 containers (bot-base/avalanche/optimism/arbitrum/plasma +
liquidator-monitor) running, restarts=0, oom=false, host mem ~1156/3915MB.
.env backups: `.env.bak.{basev3,avaxv3,opv3,arbv3}.20260603-*`. Per-chain debt
floors preserved (AVALANCHE_MIN_DEBT_USD=10, OPTIMISM_MIN_DEBT_USD=10).

Rollback (any chain): set `<CHAIN>_AAVE_LIQUIDATOR_ADDRESS=0x049DBB52c1fdf75362Abf4cf2B1e13F82c0e3dC4`
in droplet .env + recreate that container. (Old contracts still on-chain. Note:
arbitrum's pre-cutover address was ALSO `0x049DBB52…` with V2 router `0x1b02dA8C…`,
not the `0x6ba5…` mentioned in older memory.)

## Per-chain deploy/cutover flow used (repeat for any future redeploy)

1. Dry-run: `FORCE_DEPLOY=true DEPLOY_CHAINS=<chain> CHAINS=<chain> node scripts/deployLiquidator.js` (no broadcast — confirms router/pool/owner, gas, balance).
2. Verify the V3 router exposes `WETH9()` → correct WNATIVE (auto-seed intermediate).
3. Broadcast: add `DEPLOY=true`. Script self-verifies netSwapRouter/pool/owner + sets intermediates.
4. `SET_MIN_PROFIT_UNITS=1000000 node scripts/setMinProfit.js <chain>` (confirm on-chain via a SECOND read — the script's own post-tx read often lags and shows $0.0 falsely).
5. Droplet: back up .env, set `<CHAIN>_AAVE_LIQUIDATOR_ADDRESS`, set `pathAware: true` in chains.js, rsync (incl artifacts/ — see gotcha), recreate ONLY `bot-<chain>` (`docker compose up -d --build bot-<chain>`).
6. Verify: container running, restarts=0, oom=false, TEST_MODE=false, container ABI has triggerLiquidationWithPath, pathAware=true, no errors.

## GOTCHAS (these cost real time — read before redeploying)

1. **Dockerfile bakes code via `COPY . .` and runs NO compile step**; `.dockerignore`
   does NOT exclude `artifacts/`. So the freshly-compiled artifact (with the new
   ABI) MUST be rsync'd, and the container MUST be rebuilt (`--build`), or the bot
   silently runs the OLD ABI and never calls the path entrypoint. For one-off
   container runs of a NEW host script, volume-mount it (`-v host:/app/...:ro`) —
   the image won't have it.
2. **Deploy/admin gas guard**: `getTransactionOverrides` (3.1 path) sets
   maxFeePerGas ~2 gwei (a liquidation PRIORITY bid). The node's intrinsic-cost
   guard checks `gasLimit × maxFeePerGas` and rejected deploys with "insufficient
   funds for intrinsic transaction cost" on thin balances even though actual cost
   is pennies. Fixed by using legacy gas for deploys/admin (Arbitrum excepted).
3. **ARBITRUM is special**: legacy contract-creation → `processing response error`
   on Nitro even via the private Alchemy RPC (`eth_call` + `estimateGas` BOTH
   succeed; the failure is at `eth_sendRawTransaction`; nonce/balance UNCHANGED so
   nothing is wasted). FIX = deploy as an EIP-1559 typed tx. But 1559 with the
   default 2gwei bid re-trips the intrinsic guard. SOLUTION: `deployArbitrumV3.js`
   caps maxFeePerGas at 0.5 gwei (~25× the ~0.02 gwei base fee; worst-case
   ~0.00109 ETH < balance) and aborts if worst-case > balance. Arbitrum has no
   `node`/`node_modules` on the HOST (container-only) and `ARBITRUM_RPC_URL` lives
   only in the droplet .env → run the deploy via a one-off container:
   `docker compose run --rm --no-deps -v /opt/.../scripts/deployArbitrumV3.js:/app/scripts/deployArbitrumV3.js:ro -e CHAIN=arbitrum -e DEPLOY=true --entrypoint node bot-arbitrum scripts/deployArbitrumV3.js`.
4. **setMinProfit / post-tx reads lag**: the script printed `0 -> 0` on success
   multiple times; always confirm with a second independent read (ideally two RPCs).
5. **rsync `--delete`** is used; it's safe here (verified .env/.env.bak.*/data-volume
   survive — data is the named volume `aave-liquidator-bot_liquidator-data`, outside
   the app dir), but be deliberate.

## What to watch / still open

- **First 🔥/✅ TX** on any V3 chain = the first-ever successful live
  `executeOperation` (flashloan→liquidate→swap→repay). The swap now works; the old
  V2 contract always reverted. No liquidatable (HF<1, debt≥floor) targets existed
  on any watchlist at handoff (Base liquidations are mostly same-block/atomic), so
  it'll fire when a real one appears.
- **Base liquidation priority tip looks high**: ~2.25 gwei vs ~0.006 gwei base fee
  (~375×) — likely overpaying on every live liquidation. Review per-chain
  `PRIORITY_FEE_MULTIPLE` / `MIN_PRIORITY_FEE_GWEI` in `src/gas.js`.
- **Plasma**: its contract at `0x81f151E5…` is the OLDER hardened one (may lack the
  3.3 entrypoint), but `pathAware=false` so the bot never calls the path entrypoint
  there — safe. Plasma's Pendle PT-* tokens + GHO-as-debt collateral have NO
  Uniswap-V3 liquidity → those liquidations revert safely (callStatic+minProfit
  gate; failed-tx gas only). Unlocking them needs separate Pendle-AMM integration.
- **Git**: `910ef3b` + `5e61c69` on main, PUSHED to origin
  (github.com:cobibean/aave-liquidator-bot).
