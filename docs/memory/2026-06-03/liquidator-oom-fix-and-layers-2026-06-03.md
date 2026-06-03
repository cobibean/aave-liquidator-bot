# Aave Liquidator — OOM Fix + Active-Debt Index + Per-Chain Floors — 2026-06-03

Audience: the next agent. This records what was changed, why, what is now live on
the droplet, and what to watch for. Pairs with the situation report at
`docs/liquidator-situation-report-2026-06-03.md` and the prior runtime memory at
`docs/memory/2026-06-02/liquidator-droplet-runtime-memory-2026-06-02.md`.

## Headline

The bot was LIVE (`TEST_MODE=false`) but had made **0 liquidation attempts** —
not for lack of targets, but because it was **crash-looping**. Root cause: Base's
full health-factor sweep of ~210k borrowers exhausted Node's V8 heap. Fixed by
streaming the sweep, then added an active-debt index and per-chain debt floors.
All three changes are deployed to droplet `liquidator-solo-1` and confirmed
healthy (`restarts=0`, memory flat ~600–670 MB, no OOM).

## Verified root cause (don't re-litigate)

- All 5 chains run in ONE Node process (`Promise.all(chainConfigs.map(runChainBot))`).
- `getUserHealthFactorsBatched` + `aggregate3InBatches` built THREE full-size
  arrays at once for Base (210k encoded calls + 210k raw multicall results + 210k
  decoded objects) → blew V8's ~2006 MB heap (`FATAL ERROR: ...heap out of memory`;
  `oomkilled=false` → it's the V8 ceiling, NOT the docker cgroup limit).
- Base logged `FULL HF sweep of 210921` but NEVER a `swept ... HFs` completion;
  `watchlist-base.json` was never written → every restart re-attempted the same
  doomed 210k sweep. Crash-looped 27×/12h, restartCount hit 37. Base's OOM killed
  the 4 healthy chains too (collateral damage of the shared process).
- Reproduced locally at Base's exact scale: `scripts/probeStreamMemory.js`
  (stub provider, no RPC) at N=210000 under `--max-old-space-size=1900` →
  materialized path OOMs at ~1897 MB; streaming completes in ~34s, peak heap ~130 MB.

## What changed (code)

### Layer 1 — streaming HF sweep (the crash fix)
- `src/multicall.js`: added `aggregate3Streaming(provider, calls, batchSize, onBatch)`
  + `aggregate3Once` helper. Fetches one batch, hands it to `onBatch`, discards it
  before the next. `aggregate3InBatches` (the old materialize-all path) is kept for
  `scripts/testBatchedHf.js` and as the equivalence reference.
- `aaveHelpers.js`: factored decode into `decodeAccountData(user, entry)`; added
  `sweepHealthFactorsStreaming(users, provider, chainConfig, onUser, opts)` which
  folds one decoded `{user, healthFactor, totalDebtUsd}` at a time (peak heap
  O(batchSize), independent of borrower count). `getUnhealthyPositions` rewritten
  to fold into `nextWatch` Set + `candidates[]` during the stream instead of
  building a 210k `hfResults` array.
- Full-sweep checkpoint: `opts.onBatchDone` persists the partial watchlist every
  `SWEEP_CHECKPOINT_BATCHES=50` batches with `cyclesSinceFullSweep = fullSweepEveryN`
  — so a crash mid-sweep keeps wallets found so far BUT still forces a fresh full
  sweep next start (no empty-file restart loop, no stale-partial trap). Only a clean
  completion resets the counter to 0.
- `Dockerfile`: `CMD ["node", "--max-old-space-size=1536", "bot.js"]` (belt-and-
  suspenders; streaming is the real fix). NOTE: `docker exec ... node -e` reports
  `heapLimitMB 2006` because that spawns a fresh node WITHOUT the flag; the bot
  process (PID 1) does have it.

### Layer 2 — active-debt index
- `src/borrowerStore.js`: `loadActiveDebt`/`saveActiveDebt` →
  `active-debt-<chain>.json` `{active: Set, warmSweepsSinceCold}`.
- `getUnhealthyPositions` now a THREE-TIER sweep state machine (was 2-tier):
  - **watchlist** (every cycle): HF < `WATCHLIST_HF`=1.25 AND debt ≥ chain floor.
  - **WARM** (every `FULL_SWEEP_EVERY_N`=20 cycles, or watchlist empty): sweeps only
    the active-debt index ∪ this cycle's new borrowers — NOT all 210k.
  - **COLD** (every `COLD_SWEEP_EVERY_N`=8 warm sweeps, or index empty): sweeps the
    ENTIRE borrower set; rebuilds the index. Only the COLD sweep pays the full cost.
- Index maintenance rule: only COLD can DROP a wallet (it's the only sweep that can
  tell "repaid" from "not in this sweep set"). WARM/watchlist sweeps only UNION new
  debt-holders in (never prune — absence just means not-swept / transient failed
  read). Watchlist cycles skip the index write unless they actually add a wallet
  (so Base's index isn't rewritten every 15s for nothing).
- Effect: Base's recurring "full" sweep shrinks from ~210k → ~few-thousand
  (only wallets currently carrying debt).

### Layer 3 — per-chain debt floors (practice mode REMOVED)
- `aaveHelpers.js`: `resolveChainMinDebtUsd(chainConfig)` → `<CHAIN>_MIN_DEBT_USD`
  → global `MIN_DEBT_USD` → `$100`. A malformed/negative per-chain value falls
  through to the global, not the hardcoded default.
- Practice mode was BUILT then REMOVED at user request (unneeded complexity). The
  per-hour attempt cap (`canAttemptOnChain`/`recordAttemptOnChain`/
  `PRACTICE_MODE_CHAINS`/`PRACTICE_MAX_ATTEMPTS_PER_HOUR`) is GONE from `bot.js`
  and `.env.example`. The per-chain floor mechanism stayed (it's decoupled and
  cheap). Do NOT re-add practice mode unless explicitly asked.

## Live droplet state (liquidator-solo-1, 165.227.191.252, 4 GB)

- `TEST_MODE=false`, `CHAINS=plasma,arbitrum,base,avalanche,optimism`.
- `.env` floors: `AVALANCHE_MIN_DEBT_USD=10`, `OPTIMISM_MIN_DEBT_USD=10`,
  others use the global `$100`. `COLD_SWEEP_EVERY_N=8`. User chose to keep avax/op
  at `$10` UNCAPPED — accepts unbounded failed-tx gas; each attempt is still
  callStatic + on-chain minProfit gated, so it won't knowingly lose money.
- `.env` backups on the droplet: `.env.bak.layer23.*` (before adding L2/L3 keys),
  `.env.bak.rmpractice.*` (before stripping practice keys).
- Confirmed live: COLD/WARM/watchlist sweep logging, active-debt index populating
  (plasma 159, optimism 273, avalanche 523, arbitrum ~1187), `restarts=0`,
  `oomkilled=false`, no main-loop errors, avax/op logging `above $10 debt`,
  base/arb/plasma `above $100 debt`.
- Data lives in the named docker volume `aave-liquidator-bot_liquidator-data`
  (→ `/app/data`). rsync deploys MUST exclude `data` and `.env`.

## Deploy flow used (repeat this)

```bash
# from local repo, key path comes from .env DROPLET_SSH_KEY_PATH (job_hunter key)
rsync -az --delete \
  --exclude .env --exclude node_modules --exclude data --exclude .git \
  --exclude graphify-out --exclude artifacts --exclude .local-logs \
  --exclude '.bot-test-loop.pid' --exclude .DS_Store --exclude '.env.bak.*' \
  -e "ssh -i ~/.ssh/job_hunter_do_ed25519" \
  ./ root@165.227.191.252:/opt/aave-liquidator-bot/
ssh -i ~/.ssh/job_hunter_do_ed25519 root@165.227.191.252 \
  'cd /opt/aave-liquidator-bot && docker compose up -d --build'
```
Always dry-run first (`rsync -azn --itemize-changes ...`), back up `.env` before
editing it, and confirm `TEST_MODE` intentionally before restarting.

## Verification performed (all green)

- `scripts/testStreamingSweep.js <chain>` — streaming sweep is BYTE-IDENTICAL to
  the materialized path when block-pinned (0 mismatches arb/op/avax, across batch
  boundaries). Unpinned "mismatches" were just per-block interest accrual between
  two live reads — NOT a bug. Keep block-pinning if you re-test.
- `scripts/probeStreamMemory.js streaming|materialized <N>` — the OOM repro + fix proof.
- `scripts/testActiveDebtSweeps.js <chain>` — drives 10 real cycles, asserts the
  exact sequence COLD,wl,wl,WARM,wl,wl,WARM,wl,wl,COLD + persisted index/counters.
  (Sets env BEFORE requiring aaveHelpers — borrowerStore reads BORROWER_STORE_DIR
  at module load.)
- Full bot E2E in `TEST_MODE=true` on Avalanche: clean pipeline, COLD→WARM→watchlist
  visible, `$10` floor active, no errors.

## WATCH FOR (next agent)

1. **First real liquidation attempt.** Look for `🔥 Found liquidatable` →
   `✅ pre-check passed` → `✅ TX sent: 0x...` → `🎉 Successful liquidation`. This
   will be the FIRST-EVER live `executeOperation` (flash loan → liquidate → swap →
   repay) — unproven in practice. It reverts safely if unprofitable (downside =
   failed-tx gas). Watch for tx failures / revert reasons on the first few.
2. **Wallet gas** on each chain (avax/op especially, now uncapped at $10 floor).
   Gas was thin (~0.0024 ETH each on arb/base/op) as of 2026-06-02.
3. **Base COLD sweep duration** over public RPC (~15 min for 210k). It no longer
   crashes, but if it's too slow, the active-debt WARM sweep should dominate; verify
   Base actually produces a `swept ... HFs` completion line and a non-empty watchlist.
4. **The second droplet `liquidator-solo-2`** (142.93.73.24, ID 574871163): idle
   duplicate from yesterday's migration, NOT running the bot, tailscale-locked.
   User said they'd delete it themselves: `doctl compute droplet delete 574871163`.
   Confirm it's gone; never run a 2nd live instance on the same wallet.
5. **A stray "practice mode" agent.** Another agent claimed to disable practice mode
   but its change never landed on the local repo OR solo-1. If it's still running it
   may try to deploy a stale build — make sure it's stopped. This session's removal
   is the source of truth.

## Not done / open

- **Code is UNCOMMITTED.** All Layer 1+2+3 changes are modified files on `main` in
  the local working tree, deployed to the droplet but never committed to git. The
  droplet has no git repo, so the working tree is the only copy. Commit it.
  Changed: `aaveHelpers.js`, `bot.js`, `Dockerfile`, `src/multicall.js`,
  `src/borrowerStore.js`, `.env.example`. New: `scripts/probeStreamMemory.js`,
  `scripts/testStreamingSweep.js`, `scripts/testActiveDebtSweeps.js`.
- Re-run the 16-hour / multi-day liquidation coverage diagnostic against the
  now-healthy bot before any chain-selection (e.g. dropping Plasma) decisions.
