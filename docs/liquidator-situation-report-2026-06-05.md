# Liquidator Situation Report — 2026-06-05 (post coverage-gap fix, 24h in)

Audience: a fresh senior agent taking over. **Verify everything below independently
— do not inherit the prior agent's conclusions.** This brief is written precisely
because the prior agent (me) twice jumped to a conclusion that later needed walking
back. Your job: prove or disprove the core open question with first-hand evidence,
then plan from there.

> **The one question that matters:** Is the bot firing zero liquidations because
> (a) there is genuinely nothing winnable to fire at (market fully contested +
> sparse at-risk positions), or (b) detection is *still* silently broken and the
> bot doesn't surface live at-risk whales into the tiers it checks? The prior agent
> could not definitively prove (a) over (b), because at the time of investigation
> there were ~0 at-risk debt positions on-chain to test against. **Resolve this with
> a live catch (see "Decisive test" below) before doing anything else.**

---

## 1. System state (verified 2026-06-05 ~20:06 UTC)

- Live, **TEST_MODE=false (real money)**. Droplet `liquidator-solo-1`,
  `165.227.191.252`, `/opt/aave-liquidator-bot`. SSH key `~/.ssh/job_hunter_do_ed25519`.
- Fleet: `bot-base`, `bot-arbitrum`, `bot-optimism`, `bot-avalanche` (Plasma REMOVED
  this cycle), plus `winscan-runner` (new) and `liquidator-monitor`. All up ~21h, **no
  restarts.** Host: 2.7 GiB free, disk 6%.
- **Load avg ~8 on 4 cores** — the 4 bot containers run 28–50% CPU each under
  high-volatility sweeps. Elevated but stable (no OOM, no restarts). "Busy not broken."
  Watch it; if sustained for days, right-size the droplet.
- Wallet `0x40aBdc50e3B619D072754a767578EE2a4a4F954d` (our liquidator sender).
- Code: branch `fix/coverage-gap-cold-cadence`, commits `606c26b` (the fix) +
  `6e70026` (winscan dashboard). **Pushed to origin, NOT merged to main.**

## 2. What was fixed this cycle (and IS verified working)

Original bug: at-risk whales sat in the COLD-only tier; COLD ran ~once/17h, so they
were never promoted into the watched tiers and never attempted. Fix (`606c26b`):
1. **COLD time-floor** — `COLD_MAX_AGE_MIN` (default 30): forces a COLD sweep whenever
   the active-debt index is older than the floor, regardless of cycle counters.
   `borrowerStore` tracks `lastColdAt`. **VERIFIED:** COLD has run every ~38–40 min
   for 24h straight (e.g. 17:39 → 18:19 → 18:58 → 19:37 UTC). Before: once/17h.
2. **Promote-at-discovery** — newly-discovered borrowers with non-dust debt
   (`newThisScan`) get added to the every-cycle `near` tier regardless of HF.
   (aaveHelpers.js ~line 1296–1302.)
3. **Wider NEAR_HF** 1.5 → 1.8.

Tests: `scripts/testColdTimeFloor.js`, `scripts/testActiveDebtSweeps.js` (green).

**This part is solid. The COLD-cadence fix is doing exactly what it should.**

## 3. The 24h result — and why it's ambiguous

Over 24h post-fix on Base: **539 LiquidationCall events, OURS = 0.** 31 unique
winners; top `0x8407699e` (19%), then a pack (`0x00c422fa` 13%, `0xd12810b1` 12%,
`0x919bb3` 11%, `0xaddd8ec` 8%, …). Of 28 temporally-isolated ("standalone")
liqs, **27 went to recurring searchers** (>2 wins/day) and only **1** to a true
one-off address. bot-base logged **0 fires, 0 candidates, 0 "Found liquidatable"**
even during 200+/hr bursts.

**Prior agent's conclusion (TREAT AS A HYPOTHESIS, NOT FACT):** Base flow is owned by
a contested bundle-searcher pack with essentially no uncontested opportunities, so
the *free* fix has hit its ceiling and winning needs paid infra.

**Why that conclusion is NOT yet proven — the user correctly pushed back:**
The "0 fires" could equally be a *still-broken detection path*. The prior agent saw
two things that LOOK like the original bug returning:
- 6/6 recently-liquidated whales were `known=true` but in NO hot tier
  (`active=false, watch=false, near=false`).
- The active-debt set is ~92% wallets with little/no current debt.

Both have **innocent explanations** that the prior agent believes (but did not
fully prove):
- Liquidated whales drop out of `active`/`near` *because they were just liquidated*
  (debt repaid → correctly removed). "Not in a tier now" ≠ "not in a tier before
  liquidation."
- The active-debt index includes anyone with `totalDebtUsd > 0` (aaveHelpers.js
  ~1286), i.e. **any dust debt** — far below the $100 `minDebtUsd` liquidation
  floor. So a large "active" set full of dust-debt wallets is BY DESIGN, not rot.
  It wastes WARM-sweep RPC but does not *miss* live whales.
- A random 6,000-borrower sample found **0 wallets with debt > $1k** right now, and
  a 3,000 sample found **0 at-risk** (HF 1.0–1.15, debt > $1k). So large at-risk
  positions are genuinely sparse at any instant — consistent with "nothing to catch."

**But "I couldn't find an at-risk whale to test against" is the absence of evidence,
not evidence of absence.** The detection path was NOT positively confirmed
end-to-end. That is the gap you must close.

## 4. Decisive test (DO THIS FIRST — it ends the ambiguity)

Catch the bot in the act on a LIVE liquidation, before the position is gone:

1. Stream Base Aave `LiquidationCall` events (topic
   `0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286`, pool
   `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`) in near-real-time.
2. The instant one fires, grab the liquidated `user` (topics[3]) and **immediately**:
   - Was that user in `data/active-debt-base.json` / `watchlist-base.json` /
     `near-base.json` *just before* this block? (You may need to snapshot the tier
     files every minute to a ring buffer so you can look back — current files are
     post-liquidation.)
   - Did bot-base's logs compute an HF for that user in the prior ~2 min?
   - What was their debt + HF in the block BEFORE liquidation (query at
     `blockTag = liqBlock - 1`)? If debt ≥ $100 and HF < 1 and they were NOT in any
     hot tier → **detection IS still broken (a real bug).** If they WERE in a hot
     tier and we just lost the race → detection works, it's a submission-speed loss.
3. Alternative positive test: find a wallet on-chain RIGHT NOW with debt ≥ $100 and
   HF in [1.0, 1.1] (scan the known set via Multicall3 `aggregate3` →
   `getUserAccountData`). If any exist, check whether bot-base has them in a hot
   tier. If a real at-risk whale is absent from all hot tiers → detection bug.
   (Prior agent found zero such whales at 20:00 UTC; retry during volatility.)

**Until this test produces a verdict, do not buy paid infra and do not declare the
free fix "done."**

## 5. Known real inefficiency (low priority, not the main question)

The active-debt index includes all `totalDebtUsd > 0` wallets (dust included), so
WARM sweeps re-check ~60k wallets when only a few thousand carry non-dust debt. This
wastes RPC/CPU (contributes to the load-8 reading) but does NOT cause missed
liquidations. If you want to tighten it: gate `nextActive` on `totalDebtUsd >=
minDebtUsd` (or a separate `ACTIVE_DEBT_FLOOR`) instead of `> 0`. Behavior-preserving
for detection of liquidatable (≥$100) positions; just smaller/cheaper. Verify it
doesn't drop wallets that are dust-now-but-could-grow before changing it.

## 6. Paid bundle/mempool tier — pricing (user asked to keep this on hand)

This is for LATER (only if §4 proves detection works AND we then see us *losing
winnable races*). It is NOT a flat subscription — on our L2s there is no
Flashbots-style relay to buy:
- **Base / Optimism:** no private-mempool relay via Alchemy (verified:
  `alchemy_sendPrivateTransaction` / `getPendingTransactions` return "Unsupported";
  Ethereum-mainnet-only). Winning = sequencer latency + Flashblocks (200ms
  pre-confs). Cost = low-latency/dedicated RPC tier + priority fee per win. No relay
  fee.
- **Arbitrum:** sequencer is FCFS — winning = lowest latency to the sequencer
  (fast/dedicated RPC, maybe colocation), not bundles.
- **Avalanche:** public mempool; no standard pay-for-bundle relay.
- **Realistic recurring cost:** dedicated/low-latency RPC ≈ $50–500/mo (~$2–17/day);
  optional sequencer-adjacent colocation +$50–200/mo. So roughly **$5–25/day infra**,
  NOT a relay subscription. Gas-on-wins is separate and self-funding (only paid when
  you capture a $15k–19k bonus).
- **Only Ethereum mainnet** (not currently a configured chain) has true paid private
  orderflow (Flashbots/MEV-Share). If we add ETH-mainnet, the calculus changes.

## 7. Open threads / housekeeping

- Branch `fix/coverage-gap-cold-cadence` is pushed, unmerged. Decide: PR + merge, or
  keep iterating on the branch.
- Plasma removed (container + compose `# DISABLED-PLASMA #`); `src/chains.js` config
  kept. User wants to later replace it with **Ethereum mainnet + another high-vol L2.**
- Compose/env for `winscan-runner` + the `winscan-control` volume is **droplet-only**
  (holds Alchemy key), not in git. See `liquidator-winscan-dashboard` memory.
- The local repo has uncommitted `.env.example` / `README.md` / `docker-compose.yml`
  changes (pre-existing monitor rework, not this cycle's). Leave or review separately.
- Win-rate dashboard is live at the monitor (`/api/winscan`, "Run win scan now"
  button); `winscan-runner` scans every 30 min. Use it instead of manual scans.

## 8. How to reproduce the key checks (copy-paste)

```bash
# fleet + cadence
ssh -i ~/.ssh/job_hunter_do_ed25519 root@165.227.191.252 \
  'docker ps --format "{{.Names}}\t{{.Status}}"; \
   docker logs --since 3h -t bot-base 2>&1 | grep "COLD HF sweep" | grep -oE "^[0-9-]+T[0-9:]+"'

# latest win-rate (from the runner)
ssh -i ~/.ssh/job_hunter_do_ed25519 root@165.227.191.252 \
  'curl -s http://127.0.0.1:3000/api/winscan | python3 -c "import sys,json;l=json.load(sys.stdin)[\"latest\"];print(l[\"scannedAt\"],l[\"grandTotal\"],l[\"ourTotal\"])"'

# did bot-base fire / find anything (last 3h)?
ssh -i ~/.ssh/job_hunter_do_ed25519 root@165.227.191.252 \
  'docker logs --since 3h bot-base 2>&1 | grep -icE "attemptLiquidation|flashLoan|liquidationCall|Found [1-9][0-9]* liquidatable"'
```
The 24h post-fix analysis + tier-membership probes the prior agent ran are
reproducible by running `node` snippets inside `bot-base` (it has ethers + the
Alchemy RPC env + `/app/data` mounted). See the session transcript for the exact
scripts, or rebuild from the topic/pool constants above.

---

**Bottom line for the next agent:** The COLD-cadence fix works and is stable (24h
proven). The win-rate is 0, and there is a genuine, unresolved fork between "nothing
winnable on Base" and "detection still has a hole." The prior agent leaned toward the
former but could not prove it. **Run the §4 live-catch test, get a real verdict, THEN
decide between (a) tighten/extend detection, (b) price paid infra, or (c) let Base sit
and target a different chain.** Do not skip to the paid tier.
