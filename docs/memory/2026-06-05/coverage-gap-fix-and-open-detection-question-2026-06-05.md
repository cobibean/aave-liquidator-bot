# Aave Liquidator — Coverage-Gap Fix + the Open Detection Question — 2026-06-05

Companion to `docs/liquidator-situation-report-2026-06-05.md` (the full handoff).
This is the durable memory entry for the 2026-06-05 work.

## Session summary

- Diagnosed why the bot won 0 of 383+ on-chain liquidations: at-risk whales sat in
  the COLD-only tier; COLD ran ~once/17h, so they were never promoted into the
  watched tiers and the bot never even attempted them. NOT a submission-speed race —
  the bot never entered the race.
- Shipped a 3-part fix (commit `606c26b`, branch `fix/coverage-gap-cold-cadence`,
  live on all 4 chains, pushed to origin, unmerged):
  1. **COLD time-floor** `COLD_MAX_AGE_MIN` (default 30) — forces COLD when the
     active-debt index is older than the floor, immune to cycle-counter drift.
     `borrowerStore` now tracks/returns `lastColdAt`; only COLD refreshes it.
  2. **Promote-at-discovery** — `newThisScan` borrowers with non-dust debt enter the
     every-cycle `near` tier regardless of HF.
  3. **NEAR_HF** default 1.5 → 1.8.
- Built a **win-rate dashboard feature** (commit `6e70026`): `winscan-runner`
  container scans every 30 min (+ on-demand via a "Run win scan now" button), writes
  results to the shared volume; monitor reads + displays on-chain-vs-OURS per chain.
  Monitor stays read-only on borrower data; writes the on-demand request marker to a
  SEPARATE `winscan-control` volume. See `liquidator-winscan-dashboard` memory.
- Removed Plasma (container + compose `# DISABLED-PLASMA #`; `src/chains.js` kept).

## Verified (first-hand)

- **COLD cadence fix WORKS and held for 24h** — sweeps every ~38–40 min (vs once/17h).
  Tests `scripts/testColdTimeFloor.js` + `testActiveDebtSweeps.js` green.
- Fleet stable 24h, no restarts. Droplet load ~8/4-cores under high-vol sweeps
  (busy not broken; 2.7 GiB free, no OOM).

## The UNRESOLVED question (most important)

Bot still fires 0 liquidations 24h post-fix. Two competing explanations, NOT yet
distinguished with first-hand proof:
- (a) Base flow is fully contested by a searcher pack (539 liqs/24h, 31 winners,
  top 0x8407699e 19%; of 28 standalone liqs, 27 to recurring searchers, 1 one-off) +
  at-risk positions are genuinely sparse (random 6k-borrower sample → 0 with debt
  >$1k; 3k sample → 0 at-risk). ⇒ nothing winnable, free fix at its ceiling.
- (b) Detection still has a hole — the bot doesn't surface live at-risk whales into
  its hot tiers. Suggestive signs: 6/6 recently-liquidated whales were `known` but in
  NO hot tier; active-debt set ~92% dust-debt wallets.

Prior agent (me) leaned (a) but COULD NOT PROVE it — there were ~0 at-risk positions
on-chain to test against at investigation time. **The next agent must run a LIVE-CATCH
test (snapshot tier files to a ring buffer, then on each LiquidationCall check whether
the user was in a hot tier + had HF computed in the block before liquidation) to get a
real verdict.** Until then: do NOT buy paid infra, do NOT declare the fix "done."

## Key code facts for whoever debugs this

- Active-debt index includes ALL `totalDebtUsd > 0` wallets (aaveHelpers.js ~1286) —
  i.e. ANY dust debt, far below the $100 `minDebtUsd` liquidation floor. So a large,
  mostly-dust active set is BY DESIGN, not rot. It wastes WARM-sweep RPC but does not
  miss live whales. To tighten: gate `nextActive` on `>= minDebtUsd` (or a new
  `ACTIVE_DEBT_FLOOR`). Behavior-preserving for ≥$100 detection; cheaper.
- WARM unions into the index, only COLD prunes (rebuilds `nextActive` from scratch).
- Liquidated wallets correctly drop out of tiers post-liquidation (debt repaid), so
  "not in a tier NOW" ≠ "not in a tier BEFORE liquidation." Don't confuse the two.

## Paid tier (user wants priced, for LATER)

No Flashbots-style relay to buy on our L2s (Alchemy private-tx unsupported on Base —
Ethereum-mainnet-only). Real cost ≈ **$5–25/day** low-latency/dedicated RPC (+optional
sequencer colocation), NOT a relay subscription; gas-on-wins is separate + self-funding.
Only ETH-mainnet (not yet configured) has true paid private orderflow. Revisit ONLY
after the live-catch test proves detection works and we see us losing winnable races.

## Next steps

1. Run the live-catch detection test → verdict on (a) vs (b).
2. If (b): fix the detection hole. If (a): decide price-paid-tier vs let-Base-sit vs
   target a quieter chain (arb/op/avax had ~0 post-fix volume — unknown catchable ratio).
3. Decide PR/merge for `fix/coverage-gap-cold-cadence`.
4. Consider replacing removed Plasma with ETH-mainnet + another high-vol L2.
