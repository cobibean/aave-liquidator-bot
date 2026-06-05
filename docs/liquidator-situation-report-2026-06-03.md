# Liquidator Situation Report - 2026-06-03

> **⚠️ OLD REPORT — read `docs/liquidator-situation-report-2026-06-05.md` instead.**
> This 2026-06-03 brief is two major iterations behind. Most "current behavior"
> issues here (OOM crash-loop, empty watchlists, single-process contention, swap-router
> V2/V3 mismatch) are FIXED. The current open question (does the bot actually detect +
> attempt live at-risk whales, or is Base just fully contested?) is covered only in the
> 2026-06-05 report. Kept for historical context.

Audience: Opus or another senior agent taking over strategy for today's Aave
liquidator updates.

This report combines the live droplet investigation, recent on-chain liquidation
counts, current bot behavior, and the user's proposed direction. Treat it as a
decision brief, not as final strategy.

> **⚠️ SNAPSHOT — partly superseded (updated 2026-06-03 PM).** This brief captured
> the state that *motivated* the speed work; several "current behavior" issues
> below are now FIXED: the full-sweep OOM / crash-loop (streaming sweep, Layer 1),
> empty watchlists, and the single-process contention (each chain now runs in its
> own container — speed task 1.3). Also shipped since: per-block trigger (built,
> OFF), EIP-1559 gas + local nonce (3.1/3.2), batched/parallel enrichment (2.2).
> NEW open issue discovered afterward: the swap-router V2/V3 mismatch (the contract
> swaps via Uniswap V3 but 4 of 5 chains are configured with V2/Sushi routers) —
> redeploy fix in progress. See `docs/liquidator-speed-optimizations.html` and the
> project memory for current status.

## Executive Summary

The bot is live on the DigitalOcean droplet with `TEST_MODE=false`, but it is
not operationally healthy. Docker keeps restarting it, and the dominant failure
is Node heap exhaustion during Base's full health-factor sweep.

The bot made zero liquidation attempts during the reviewed period, even though
there were real Aave liquidations on several configured chains. The main issue
is not that the system knows no borrowers. For meaningful liquidations, many
users were present in the persisted borrower stores, but too few were present in
the hot watchlist scanned every cycle. Base is worse: Base has the liquidated
users in the borrower store, but its watchlist remains empty because the full
sweep crashes before completion.

The current architecture is too dependent on:

- a full all-borrower sweep that does not fit Base's current scale
- a hot watchlist that is refreshed too sparsely for fast HF moves
- a global minimum debt floor that prevents small live liquidation attempts
  that may be useful for proving the execution pipeline
- a strict HF `< 1` candidate threshold, with no pre-liquidation preparation for
  users hovering near liquidation

## Current Production Context

Source of truth is the DigitalOcean droplet, not a local PM2 process.

Runtime facts observed on 2026-06-03:

- Container: `aave-liquidator`
- Runtime mode: `TEST_MODE=false`
- Chains: `plasma,arbitrum,base,avalanche,optimism`
- Docker restart count observed: `34`
- Current failure pattern: starts, reaches `Base: FULL HF sweep of 210921`, then
  Node eventually exits with:
  `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`
- No liquidation attempts, submitted txs, successful liquidations, or tx failures
  were observed in bot logs during the reviewed windows.

The droplet itself had sufficient host resources when checked. The failure is
the Node/V8 heap ceiling and retained JS object volume, not an obvious host RAM
exhaustion event.

## Recent Liquidation Reality Check

The diagnostic compared on-chain Aave `LiquidationCall` events over the last
approximately 16 hours with the bot's persisted borrower stores and hot
watchlists on the droplet.

### All Liquidation Events

| Chain | Events | Unique users | Users in borrower store | Users in watchlist |
| --- | ---: | ---: | ---: | ---: |
| Plasma | 0 | 0 | 0/0 | 0/0 |
| Arbitrum | 36 | 36 | 26/36 | 8/36 |
| Base | 18 | 18 | 18/18 | 0/18 |
| Avalanche | 32 | 32 | 5/32 | 1/32 |
| Optimism | 22 | 22 | 6/22 | 2/22 |

### Actionable-ish Subset

Definition used for triage: HF `< 1.01` one block before the liquidation event
and total debt at or above the current `$100` `MIN_DEBT_USD` floor.

| Chain | Actionable-ish users | In borrower store | In watchlist |
| --- | ---: | ---: | ---: |
| Plasma | 0 | 0 | 0 |
| Arbitrum | 25 | 20 | 8 |
| Base | 6 | 6 | 0 |
| Avalanche | 3 | 3 | 1 |
| Optimism | 6 | 6 | 2 |

Interpretation:

- Borrower discovery is partly working. Across actionable-ish users, the store
  had 29/40.
- Watchlist coverage is poor. Across actionable-ish users, the watchlist had
  only 11/40.
- Base is known but unusable: 18/18 liquidated users were in the store, but 0
  were in the watchlist because the Base full sweep never completes.
- Avalanche and Optimism have many liquidation events, but many are dust. Some
  meaningful small/medium opportunities still existed.

## Why No Attempts Happened

### 1. Base Full Sweep Kills Node

Current Base borrower store size is about 210k. The full HF sweep builds several
large arrays in memory:

- encoded multicall requests for every user
- raw multicall return entries for every user
- decoded `{ user, healthFactor, totalDebtUsd }` objects for every user
- filtered/sorted candidate arrays after that

This was probably acceptable when Base was much smaller. It is not acceptable at
210k borrowers. Because the full sweep never finishes, `watchlist-base.json`
does not get populated, and every restart repeats the same full sweep.

### 2. Normal Cycles Scan the Watchlist, Not the Whole Store

The main loop runs about every 15 seconds by default. In `getUnhealthyPositions`,
the bot loads the chain watchlist and does:

- full sweep if the watchlist is empty
- full sweep if `cyclesSinceFullSweep >= FULL_SWEEP_EVERY_N`
- otherwise, scan only the watchlist plus borrowers discovered in the current
  incremental Borrow-event scan

The watchlist is updated each cycle from the HF results that were actually
scanned. On a watchlist cycle, users outside the watchlist are not rechecked.
That means old borrowers who move from healthy to near-liquidation due to price
changes can be missed until the next full sweep or until they borrow again.

### 3. Liquidation Windows Are Short

Several liquidated users had HF just above 1 one block before the liquidation:
examples included HF around `1.0004`, `1.0010`, `1.0035`, and `1.0045`. These
users may become liquidatable and be claimed by competitors within one or a few
blocks. A 15-second polling loop plus sparse full sweeps will miss many of these
unless the user is already in the hot watchlist.

### 4. The Debt Floor Helps Profitability but Blocks Practice

The current `$100` debt floor is sensible for avoiding obvious dust. But it also
means the bot never tries many small live opportunities on Avalanche and
Optimism. If the immediate goal includes proving transaction construction,
route support, gas behavior, and liquidation execution, a controlled small-debt
mode on selected chains may be useful.

## User Direction To Incorporate

The user wants the next strategy to consider:

1. Fix Base and stop the full HF sweep from killing Node.
2. Rethink sweeping every historical borrower. Prefer current borrowers, users
   with debt, or users with debt above a threshold if we can do that accurately.
3. Understand whether hot-watchlist scanning is the right route and whether
   hotlists are updated every cycle.
4. Be more aggressive around very low HF users instead of only reacting after HF
   is already below 1.
5. Consider lowering filters for smaller positions, possibly only on Avalanche
   and Optimism, so the bot can work out execution kinks on cheaper/smaller
   liquidations.
6. Consider ditching Plasma if recent liquidity/liquidations remain zero, and
   evaluate an alternative smaller chain.

Important protocol note for strategy: Aave liquidation is expected to revert if
HF is above 1. "More aggressive" should not mean blindly submitting live txs for
HF > 1 unless we intentionally accept reverts as a test cost. Better versions of
aggression are: more frequent scanning, pre-enrichment, route preparation,
static-call probes, block-triggered rechecks, and submitting immediately once HF
crosses below 1.

## Strategy Questions For Opus

### Base / Current Borrowers

The likely first fix is to make the HF sweep streaming and chunked:

- do not build all `calls`, `raw`, and decoded `hfResults` arrays for 210k users
- process one multicall batch at a time
- update `nextWatch`, candidate counts, and candidate list incrementally
- discard each batch before moving on
- persist the watchlist at completion, and consider progress checkpoints for
  very large chains

Longer-term, consider replacing "ever borrowed" with an active-debt index:

- Initial pass: stream all known borrowers once and persist only users with
  `totalDebtBase > 0`, plus optionally `totalDebtUsd >= chainMinDebt`.
- Ongoing updates: add users from new Borrow events immediately.
- Drop or deprioritize users when scans show `totalDebtBase == 0`.
- Persist last observed HF/debt/timestamp so the bot can stratify by risk.

Open question: whether an active-debt index can be maintained from Aave events
alone with acceptable correctness. Borrow/Repay/Liquidation events help, but
interest accrual and multi-reserve positions make an account-data read the most
reliable source of "currently has debt."

### Watchlist Design

The hotlist is useful, but it cannot be the only normal scan surface. Candidate
approaches:

- Every cycle: scan hot watchlist plus newly discovered borrowers.
- Every cycle or every few cycles: scan one rotating shard of all active-debt
  borrowers.
- Risk tiers:
  - HF `< 1.01`: every block or every cycle
  - HF `< 1.05`: very frequent
  - HF `< 1.15`: frequent
  - HF `< WATCHLIST_HF`: normal watchlist cadence
  - above threshold but active debt: rotating shard
- Price-triggered rechecks: when oracle/price updates happen, recheck users
  exposed to affected assets.

This likely turns "watchlist" into a broader risk index, not just a set.

### Aggressive Low-HF Mode

For users just above 1:

- Precompute primary debt/collateral and route support before they cross.
- Run `callStatic` or simulation probes, but expect protocol reverts if HF > 1.
- Recheck near-threshold users more frequently than the 15-second loop.
- Submit only when HF is observed below 1, unless a deliberate revert-budget
  experiment is approved.

For users just below 1:

- The bot should not wait for additional confirmation if debt/profit gates pass.
- Sort by lowest HF and largest debt/profit potential.
- Consider per-chain concurrency limits so one chain does not block another.

### Small-Position Practice Mode

Avalanche and Optimism are candidates for a controlled smaller-position mode
because they had recent liquidation events, including many small ones.

Possible implementation:

- add per-chain debt floors, for example `AVALANCHE_MIN_DEBT_USD` and
  `OPTIMISM_MIN_DEBT_USD`
- keep larger floors on Base/Arbitrum
- add a `PRACTICE_MODE_CHAINS=avalanche,optimism` concept if needed
- require profitability and static-call validation unless the user explicitly
  authorizes paying for failed/reverted tests
- cap attempts per hour/day while proving the pipeline

This can help prove execution, but it can also lose money through gas, swaps, or
failed txs. Make the risk explicit.

### Chain Selection

Plasma had 0 liquidation events in the latest 16-hour scan. The user suspects it
may be worth dropping if no recent liquidation activity exists over the last few
days.

Candidate alternatives should be validated rather than guessed. Existing config
already includes some non-active chains such as Linea, Polygon, Metis, and
Ethereum, but "smaller chain" should be chosen by measured liquidation density,
borrower count, RPC reliability, deployed contract support, swap-route support,
gas cost, and wallet gas availability.

## Claims That Must Be Revalidated Before Today's Changes

These claims directly affect decisions and should be rechecked before changing
production behavior.

### Claim: Base OOM Is Still The Active Failure

Validate on the droplet:

```bash
docker inspect --format 'started={{.State.StartedAt}} restarts={{.RestartCount}} status={{.State.Status}}' aave-liquidator
docker logs --since 6h --timestamps aave-liquidator 2>&1 \
  | grep -E 'Base: FULL HF sweep|heap out of memory|Starting Aave'
docker stats --no-stream --format '{{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}}' aave-liquidator
```

Expected if unchanged: repeated `Base: FULL HF sweep of ~210k` followed by Node
heap OOM and container restarts.

### Claim: Base Watchlist Is Empty Because Full Sweep Never Completes

Validate on the droplet without printing secrets:

```bash
docker exec aave-liquidator sh -lc 'ls -lh /app/data/watchlist-base.json /app/data/borrowers-base.json 2>/dev/null || true'
docker exec aave-liquidator node -e '
const fs = require("fs");
for (const f of ["/app/data/borrowers-base.json", "/app/data/watchlist-base.json"]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      console.log(f, { count: j.count, cyclesSinceFullSweep: j.cyclesSinceFullSweep, updatedAt: j.updatedAt });
    } catch (e) {
      console.log(f, e.message);
    }
}
'
```

Expected if unchanged: borrower count around 210k and watchlist count 0 or
missing/stale.

### Claim: Recent Liquidation Counts And Coverage

Rerun the 16-hour event scan before making chain/debt-floor decisions. The
previous run found:

- Plasma: 0 events
- Arbitrum: 36 events
- Base: 18 events
- Avalanche: 32 events
- Optimism: 22 events

The validation script should:

- count Aave `LiquidationCall` events per chain
- compute unique liquidated users
- compare users against `/app/data/borrowers-<chain>.json`
- compare users against `/app/data/watchlist-<chain>.json`
- sample HF and debt at `blockTag = liquidationBlock - 1`
- bucket users by debt floor and HF range

Do not rely on the prior counts if today's chain-selection or debt-floor changes
depend on them.

### Claim: Plasma Should Be Dropped

Do not drop Plasma based only on one 16-hour window. Validate:

- liquidation events over 3 days and 7 days
- total borrower count and active-debt count
- whether our deployed liquidator contract and route support are healthy
- wallet gas and RPC reliability
- opportunity cost versus candidate replacement chains

Drop it only if recent activity remains near-zero and another chain has better
measured opportunity density.

### Claim: Smaller Positions Are Useful For Practice

Before lowering filters, validate per chain:

- average and median gas cost for a liquidation attempt
- whether the deployed contract supports the needed collateral/debt routes
- whether static calls pass for a recent known liquidatable user
- whether the user's wallet has enough native gas
- whether min-profit configuration would block the test anyway
- whether failed attempts are acceptable and capped

Do not globally lower `MIN_DEBT_USD` without per-chain controls.

### Claim: More Aggressive HF Thresholds Will Help

Validate with historical samples:

- for recent liquidated users, measure HF at block - N for N in 1, 5, 10, 30
- determine how often users were already below `WATCHLIST_HF`
- determine how long users stayed in HF `< 1.01`, `< 1.05`, and `< 1.10`
- compare that window with the bot's actual scan cadence and restart windows

If most opportunities move from HF > 1.05 to liquidated within a few blocks,
the fix is likely event/block-triggered rechecks rather than just changing a
static threshold.

## Suggested Next Move

Recommended order for today's work:

1. Patch the HF sweep to stream batches and stop Base from OOMing.
2. Add or validate per-chain debt floors so Avalanche/Optimism can run a
   controlled smaller-position mode without lowering the global floor.
3. Replace watchlist-only normal scanning with watchlist plus rotating shards of
   active-debt borrowers.
4. Add a near-threshold risk index with persisted last HF/debt observations.
5. Re-run 16-hour and multi-day liquidation coverage diagnostics.
6. Decide whether to drop Plasma and which smaller chain to evaluate next based
   on measured activity.

Keep production safety constraints in mind:

- The bot is live. `TEST_MODE=false` can submit real transactions.
- Do not run two live instances with the same wallet.
- Do not print `.env`, private keys, RPC API keys, or full Docker env output.
- Summarize logs and event counts instead of pasting raw logs.
