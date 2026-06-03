# Swap-router V3 correctness fix + task 3.3 (path-in-calldata)

Status: PLAN — no contract change or deploy broadcast yet. Live-money system
(`liquidator-solo-1`, TEST_MODE=false, one container per chain).

## Problem (verified on-chain 2026-06-03)

`contracts/AaveLiquidatorSwapRouter02.sol` is Uniswap-V3-only: `_findFeeTier`
calls `factory.getPool(tokenIn,tokenOut,fee)` and the swap uses
`netSwapRouter.exactInput({path,...})`. But `src/chains.js` configured
**V2/SushiSwap routers** on arbitrum/base/avalanche/optimism, whose factories
expose `getPair(a,b)`, not `getPool(a,b,fee)`. So `executeOperation`'s swap
branch reverts on all 4 (verified: `getPool` reverts / pools absent; V2
`getPair` returns real pairs). Plasma's configured router IS a real V3 fork.

### Verification artifacts
- `scripts/probeSwapVenue.js` — proves configured factory is V2 vs V3 + that the
  proposed V3 routers have WNATIVE/USDC pools at all tiers.
- `scripts/probeCollateralVenues.js` — resolves each live-watchlist user's real
  primary collateral→debt pair (same logic as `enrichCandidateBatched`) and
  checks V3 pool existence at the proposed factory (direct + 2-hop via WNATIVE).

### Real-collateral coverage at proposed V3 venue (from live droplet watchlists)
| chain     | router (proposed)                          | factory (verified)                         | coverage |
|-----------|--------------------------------------------|--------------------------------------------|----------|
| arbitrum  | 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 | 0x1F98431c8aD98523631AE4a59f267346ea31F984 | 100% (28/28) |
| base      | 0x2626664c2603336E57B271c5C0b26F421741e481 | 0x33128a8fC17869897dcE68Ed026d694621f6FDfD | 100% (19/19) |
| optimism  | 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 | 0x1F98431c8aD98523631AE4a59f267346ea31F984 | 100% (21/21) |
| avalanche | 0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE | 0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD | ~99% (only WETH.e→GHO, 1 wallet, lacks a path) |

Plasma: contract already V3-correct; its swappable stable/LST collateral has V3
pools (USDe↔USDT0, sUSDe→USDT0, syrupUSDT→USDT0, weETH→WETH). Pendle PT-* tokens
and GHO-as-debt have NO Uniswap-V3 liquidity — left as-is (those liquidations
revert safely under callStatic+minProfit; failed-tx gas only). NOT fixed here.

## Decisions (user, 2026-06-03)
1. Fix arb/base/avax/optimism via **V3 redeploy** (netSwapRouter is immutable).
2. **Leave Plasma as-is.**
3. **Bundle task 3.3** (off-chain-resolved path in calldata) into the same redeploy.

---

## Part A — Contract change (task 3.3, additive & backward-compatible)

Add an OPTIONAL path-in-calldata route to `AaveLiquidatorSwapRouter02.sol`. Empty
path ⇒ existing on-chain `_resolveSwapPath` fallback, so behavior is unchanged
unless the bot supplies a path.

- New entrypoint `triggerLiquidationWithPath(debtAsset, debtAmount, targetUser,
  collateralAsset, minProfitForCall, bytes swapPath)`: encodes `swapPath` into
  the flash-loan `params` alongside the existing `(targetUser, collateralAsset,
  floor)`.
- `executeOperation` decodes the optional path; if `swapPath.length > 0` use it
  directly in `exactInput`, else call `_resolveSwapPath` as today.
- Keep `triggerLiquidation` (4-arg) and `triggerLiquidationWithMinProfit` (5-arg)
  unchanged so the bot's current call sites + callStatic gate still work.
- Path validity: contract must still enforce `amountOutMinimum = requiredBalance
  - debtBalance` (the profit floor at the swap boundary) regardless of who chose
  the path — a bad/bogus path just reverts cheaply. (No new trust surface: the
  bot is `onlyOwner`; the path only changes routing, not the floor.)

Recompile: `npm run compile`. Must stay clean.

## Part B — chains.js router addresses
Update `swapRouter` for the 4 chains to the verified V3 SwapRouter02 (table
above). Plasma unchanged. (No `factory` field exists in config — the contract
reads `netSwapRouter.factory()` at runtime, so updating the router address is
sufficient; the verified factories above are just confirmation that
`router.factory()` returns a V3 factory with the needed pools.)

## Part C — bot.js off-chain path resolver (3.3)
- Add a helper that, given (collateralAsset, debtAsset, chain), resolves the V3
  fee tier(s) off-chain via `factory.getPool` (read path, cached) and encodes the
  same packed path the contract would (`abi.encodePacked` equivalent:
  tokenIn|fee|tokenOut, or tokenIn|fee1|WNATIVE|fee2|tokenOut for 2-hop).
- In `attemptLiquidation`'s `broadcast()`: on chains with the new contract
  (gate on a new `chainConfig.pathAware === true` flag set after redeploy), call
  `triggerLiquidationWithPath(..., swapPath)`; else fall back to the existing
  `triggerLiquidationWithMinProfit` / `triggerLiquidation`. Empty/failed
  resolution ⇒ pass `0x` so the contract self-resolves (no regression).
- `simulateLiquidation` callStatic must mirror the entrypoint actually used (add
  a path-aware callStatic variant) so the pre-check stays a true gate.

## Part D — Per-chain redeploy flow (live money — coordinate before each broadcast)
For EACH of base, avalanche, optimism, then arbitrum (arbitrum LAST, needs the
private RPC `ARBITRUM_RPC_URL` that lives only in the droplet .env):
1. `DEPLOY` dry-run first (`deployLiquidator.js` without `DEPLOY=true`) — confirm
   router/pool/owner, gas estimate, balance.
2. Broadcast deploy (`DEPLOY=true DEPLOY_CHAINS=<chain>`). Script verifies
   `netSwapRouter == chains.js swapRouter`, pool, owner, sets intermediates.
3. `setMinProfit` on the new contract (match current $2 floor / per-chain).
4. Update `<CHAIN>_AAVE_LIQUIDATOR_ADDRESS` in the **droplet** .env (back it up
   first), set the chain's `pathAware`/`hardenedLiquidator` flags in chains.js,
   redeploy code to droplet (rsync, exclude .env/data/node_modules), recreate
   ONLY that chain's container (`docker compose up -d --build bot-<chain>`).
5. Verify: container restarts=0, oom=false, TEST_MODE=false preserved, and a
   callStatic of a real watchlist target now PASSES the swap branch (was
   reverting). Watch for the first 🔥/✅ TX.

Arbitrum: deploy via private RPC (public RPCs fail contract-creation — verified
again here: reads work, creation doesn't). Set `pathAware`/`hardenedLiquidator`
once its hardened+V3 contract lands.

Rollback per chain: restore previous `<CHAIN>_AAVE_LIQUIDATOR_ADDRESS` from the
.env backup + recreate the container (old contracts still exist on-chain).

## Sync note
The LOCAL repo `.env` has STALE liquidator addresses (all 0x6ba5… except
plasma); the DROPLET .env has the current hardened ones. Only the droplet .env
matters for the live bot. Do not copy the local .env to the droplet.

## Parts A–C: BUILT & VERIFIED LOCALLY 2026-06-03 (not yet deployed)
- **A (contract):** added `triggerLiquidationWithPath(...,bytes swapPath)`;
  `_triggerLiquidation` carries an optional path; `executeOperation` decodes a
  4-field params tuple `(user, collateral, floor, bytes path)` and uses the
  supplied path when non-empty, else on-chain `_resolveSwapPath`. 4-arg and
  5-arg entrypoints unchanged. Compiles clean (viaIR).
- **B (chains.js):** swapRouter updated to the verified V3 SwapRouter02 on
  arbitrum/base/optimism/avalanche; each gets `pathAware: false` (flip true after
  its redeploy). Plasma unchanged.
- **C (bot.js + aaveHelpers):** `resolveSwapPath` resolves the packed V3 path
  off-chain; `attemptLiquidation` resolves it on pathAware chains and threads it
  into both the callStatic gate (`simulateLiquidation` now mirrors the entrypoint)
  and `broadcast()` (`triggerLiquidationWithPath`). "0x"/failure ⇒ contract
  self-resolves (no regression).

### KEY FINDING — dead-pool tiers (drove a resolver upgrade)
Several real pairs have a V3 pool at a low fee tier that is EMPTY (zero current
liquidity): on Base, cbETH/USDC, weETH/USDC, WETH/GHO, EURC/USDC all have an
empty 100bps (or 500bps) pool. The contract's on-chain `_findFeeTier` (and the
naive first-existing-pool logic) would route through these dead pools and REVERT.
Proven by `scripts/verifyExactInputCallStatic.js`: with naive tier selection the
swap leg was 2 OK / 3 fail on Base (WETH, USDC, EURC reverted). **Fix:**
`resolveSwapPath.findFeeTier` now reads `pool.liquidity()` and picks the
highest-liquidity tier, skipping empties. Re-run: **5 OK / 0 fail** — WETH→USDC
now routes via 3000 (was empty 100), WETH→GHO via 10000. This makes
path-in-calldata STRICTLY better than on-chain resolution and is itself a reason
to prefer the path-aware entrypoint.

### Verification artifacts (all read-only, no broadcast)
- `scripts/verifyExactInputCallStatic.js` — state-override balance/allowance, then
  callStatic the V3 router `exactInput` on the resolved path. GROUND TRUTH that
  the swap leg executes. Base: 5/5 testable collaterals OK after the fix.
- `scripts/verifySwapLegWorks.js` — every hop in the resolved path is a live pool
  (liquidity + slot0). Surfaced the dead-pool issue.
- `scripts/testSwapPathEquivalence.js` — structural/encoding check; off-chain now
  intentionally diverges from naive where naive picks a dead pool.
- `scripts/verifyPathLiquidationCallStatic.js` /
  `verifyPathAtHistoricalLiquidation.js` — virtual-deploy (eth_call constructor
  sim + owner-slot override) full-flow callStatic. Confirmed the OLD deployed Base
  contract has the V2 router immutable and its swap reverts ("Invalid params").
  Full-flow against a currently-liquidatable victim wasn't runnable (no HF<1
  watchlist target right now; Base liquidations are same-block/atomic), so the
  swap-leg `exactInput` dry-run is the operative swap proof.

## Pre-deploy gate
- Contract compiles clean; new path round-trips (off-chain encoded path ==
  on-chain `_resolveSwapPath` output for sample pairs — add an equivalence test).
- callStatic of `triggerLiquidationWithPath` against a real watchlist target
  succeeds on a fork/live read BEFORE going live.
- User explicitly approves each broadcast.
