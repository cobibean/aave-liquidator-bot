# Event-driven triggers — design & recommendation

Status: **design only** (not yet implemented). Current bot polls every `SCAN_INTERVAL_MS`
(15s) and runs a stratified Multicall3 health-factor sweep. This document lays out how to
react faster to compete with adjacent-block MEV liquidators.

## Problem

A position crosses HF < 1 and is liquidated within ~1 block (≈0.25–2s on these L2s).
A 15s poll can miss the entire window. The winners we observed (vanity-address MEV bots
landing in the same/adjacent block) react per-block or faster.

## Options, ranked by value/effort for THIS setup

### 1. Per-block watchlist re-check  ← recommended first step
Subscribe to new blocks and re-check only the **watchlist** (near-threshold wallets,
HF < `WATCHLIST_HF`) on every block, instead of every 15s.

- The watchlist already exists (built by the stratified sweep) and is small (tens–hundreds),
  so a Multicall3 sweep of it per block is cheap (~100–300ms).
- Keep the full-set sweep on its slower cadence (`FULL_SWEEP_EVERY_N`) to refresh the watchlist.
- Reaction time drops from 15s to ~1 block.

Sketch:
```js
provider.on("block", async (blockNumber) => {
  if (inFlight) return;            // skip if a check is still running
  inFlight = true;
  try {
    const watch = loadWatchlist(chainKey).watch;
    const hfs = await getUserHealthFactorsBatched([...watch], provider, chainConfig);
    const liq = hfs.filter(h => h.healthFactor < 1 && h.totalDebtUsd >= MIN_DEBT_USD)
                   .sort((a,b) => a.healthFactor - b.healthFactor);
    for (const c of liq) await attemptLiquidation(/* enrich + submit */);
  } finally { inFlight = false; }
});
```
Caveats: public RPCs may rate-limit `eth_blockNumber`/`getLogs` under per-block load
(Arbitrum's already flaky — see below). Add backoff and an `inFlight` guard. Consider a
WebSocket RPC where available for push-based block events instead of polling.

### 2. Chainlink price-feed update triggers  ← precise, more work
HFs drop because a collateral/borrow **price** moved. Aave reads Chainlink feeds; subscribing
to `AnswerUpdated(int256,uint256,uint256)` on the relevant aggregators tells you *exactly*
when to re-check, and which reserves are affected.

- Map: reserve → Aave price source (`AaveOracle.getSourceOfAsset`) → Chainlink aggregator.
- On an `AnswerUpdated`, re-check borrowers holding that asset as collateral/debt.
- More plumbing (feed discovery, reserve→borrower index) but the most signal-efficient trigger.

### 3. Mempool / pending-tx watching  ← needs better infra
To truly race (back-run the oracle update tx in the same block, or compete on the liquidation
itself) you need mempool access and likely private-orderflow / bundle submission (Flashbots-style)
on chains that support it. Public RPCs don't expose the mempool usefully. Out of scope until
the bot runs against a dedicated node and a bundle relay.

## Infra prerequisites (apply to all of the above)
- **Private RPCs** (Alchemy/Infura/QuickNode), especially WebSocket endpoints for push events.
  The public RPCs already throttle the heavy historical backfill and **fail Arbitrum's
  contract-creation tx** ("processing response error") — they will not sustain per-block load
  across 5 chains.
- Per-chain processes or workers so one chain's load doesn't starve the others' event loop.
  **DONE (2026-06-03, speed task 1.3):** each chain now runs in its own container/process/heap
  (compose services `bot-<chain>`), so this no longer applies — the single-process serialization
  that caused the ~17-min full-sweep incident is gone.

## Recommendation
Implement **(1) per-block watchlist re-check** behind a flag (`BLOCK_TRIGGER=true`), default off,
once private/WS RPCs are in place. **STATUS (2026-06-03): BUILT and deployed (speed task 1.1),
still OFF** — it reuses the existing watchlist + Multicall3 sweep and runs alongside the poll with
a shared in-flight guard; `src/provider.js` has the WebSocket branch (1.2). Flip `BLOCK_TRIGGER=true`
once private/WS RPCs (`<CHAIN>_WS_URL`) are configured. Defer (2) and (3) until there's evidence the
bot is winning sizeable liquidations and the infra (private nodes, bundle relay) is funded.
