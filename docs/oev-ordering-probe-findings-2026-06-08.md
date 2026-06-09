# OEV-Ordering Probe — Findings (2026-06-08)

**Read-only probe** (`scripts/probeOevOrdering.js` + ad-hoc block inspection) run live against
Arbitrum to settle the question behind the "build OEV capability" decision: *when a
liquidation is won on these L2s, is it an in-block oracle backrun (OEV — a game we could build
for) or a latency race in the blocks after the update (a speed problem)?*

This **overturns the central mechanical premise of `proposal-chain-switch-2026-06-06.md`**,
which assumed every winnable liquidation is taken in the same block as the oracle update.

## Headline result (Arbitrum, 7-day window, 1,247 real liquidations)

Block-distance from each liquidation to the nearest **preceding** WETH/USD oracle update
(aggregator `0xa5E1a36938769cbd5a26f5e19D8FCB379f597c83`, `AnswerUpdated`):

| Distance | Liqs | % | Interpretation |
|---|---|---|---|
| Same block | 1 | **0.1%** | true in-block OEV backrun |
| ≤1 block | 2 | 0.2% | |
| ≤5 blocks (~1.3s) | 7 | 0.6% | |
| **≤20 blocks (~5s)** | **796** | **63.8%** | the real "fast race" |
| ≤230 blocks (~1 update cycle) | 1,217 | 97.6% | |
| **median** | **11 blocks ≈ 3s** | | |

**Conclusion: in-block OEV is NOT the game on Arbitrum.** Only 0.1% of liquidations are
same-block backruns. The winning pattern is a **~3-second latency race in the blocks after a
price update** — a price lands, and the winner's `liquidationCall` arrives a median of 11
blocks (~3s) later, with ~64% inside 5s.

Mechanically why: Arbitrum's sequencer exposes **no public mempool**, so the oracle-update tx
cannot be backrun in-block by anyone (the winners aren't doing it either). The contest is
purely about who reacts to the *landed* price fastest.

WETH price update cadence on Arbitrum: ~every 58s / ~230 blocks (9,179 updates / 7d).

## Winner concentration (is it a closed monopoly or a contestable pack?)

50 distinct winners over 7d; 35 distinct in the fast race (≤20 blocks).

Fast-race (the 796 winnable liqs) leaderboard:
- `0xd12810b1…` 27.5%
- `0x8888888881f14c72…` 26.1%  (vanity-prefix pro searcher)
- `0x9f836649…` 12.7%
- then a long tail (5%, 4.8%, 4.6%, 2.6%, 2.0%, …)

**Read:** contestable pack, not a colocated monopoly. No one owns the sequencer. BUT the top
two pros take ~54% of the fast race, and they win a 3-second race repeatedly — they are
fast, full-time, and tuned.

## What this means for "build OEV capability"

The chosen direction (react in-block to the oracle) would be **over-engineering for the 0.1%
case**. The actual winnable game is a **speed problem**, not an auction-access problem:

1. The bot polls every ~10s. Winners land ~3s after the update. **We lose by our poll
   interval**, not by an OEV auction we can't access. A 10s poll can't win a 3s race.
2. The fix is **event-driven price reaction**: subscribe to the oracle update (or per-block
   head) and run detect→simulate→send the instant a price lands, not on a 10s cadence.
   Partial machinery already exists (`PRICE_TRIGGER` / `BLOCK_TRIGGER` per prior work).
3. This is buildable on **existing funded L2 infra** (Arb/Opt/Avax send-capable contracts) —
   no Flare rebuild required to *test the hypothesis*.

## Honest caveats / unknowns

- **Probed Arbitrum only.** Optimism/Avalanche may differ (different sequencer, cadence,
  pack). Re-run the probe there before generalizing.
- **The pack is real and fast.** Even with event-driven triggers, beating sub-3s pros
  repeatedly is not guaranteed. The win bar is "land before the median pro," and the top two
  are very fast. This buys a *shot*, not a sure thing.
- **Distance ≠ causation.** "Nearest preceding update" is a proxy; some liqs are triggered by
  collateral-asset moves (we keyed on WETH as collateral, the dominant case) or interest
  accrual, not the WETH feed. The 0.1% same-block figure is robust regardless; the 3s median
  is a good-faith estimate of the race length.
- **Economics still apply.** Winning the race only pays if the swap clears the profit floor
  (cf. the Arbitrum `0x9647` thin-liquidity trap). Latency wins nothing on unprofitable liqs.

## Recommended next step (cheap, decisive)

Before any contract work: **re-run the probe on Optimism + Avalanche**, then **A/B test
event-driven trigger latency** — measure our own detect→simulate→send wall-clock on a live
price update and compare to the 3s median. If we can get under ~3s end-to-end on existing
infra, the latency-race hypothesis is winnable and worth building. If we're stuck above ~5s
even event-driven, the pros are out of reach and the kill decision stands.
