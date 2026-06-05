# Liquidator docs — start here

If you are a fresh agent taking over, **read these in order:**

1. **`liquidator-situation-report-2026-06-05.md`** — THE current handoff. State of the
   system, what's fixed/proven, and the one open question (does the bot actually detect +
   attempt live at-risk whales, or is Base just fully contested?). Start here.
2. `memory/2026-06-05/coverage-gap-fix-and-open-detection-question-2026-06-05.md` — durable
   memory for the 2026-06-05 work (companion to #1).
3. Repo root `AGENTS.md` / `README.md` — up-to-date deploy/inspect commands.

## Current as of 2026-06-05
- **4 chains:** base, arbitrum, optimism, avalanche. (Plasma was REMOVED.)
- Live on droplet `liquidator-solo-1` (`165.227.191.252`), **TEST_MODE=false (real money)**,
  one container per chain + `winscan-runner` + `liquidator-monitor`.
- Active code branch: `fix/coverage-gap-cold-cadence` (pushed, unmerged).

## Reference docs (current-ish, narrower scope)
- `event-driven-triggers.md` — design notes for per-block / price triggers (these shipped).
- `swap-router-v3-fix-plan.md` — the V2→V3 swap-router fix (shipped; plan kept for record).
- `liquidator-bot-overview.html` — field guide; **partially stale** (says 5 chains/Plasma).
- `liquidator-speed-optimizations.html` — speed plan (some shipped, some superseded).

## Historical / superseded — do NOT use as current truth
- `liquidator-situation-report-2026-06-03.md` — two iterations old; most issues fixed.
- `MIGRATION-HANDOFF.md` — the droplet migration (DONE); describes the old single-container model.
- `archive/session-2026-06-04-speed-rollout.md` — its root-cause claim ("speed race not
  discovery") was **REVERSED** on 2026-06-05. Kept only for shipped-changes + command snippets.

## Dated memory archives
`memory/<date>/` holds point-in-time memory entries. They are historical record — accurate
for their date, not necessarily for today.
