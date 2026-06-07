# Proposal — Re-point the Liquidator: Escape the OEV Pack

**Date:** 2026-06-06 · **Author:** Claude (research + live-verified) · **Status:** DRAFT for decision
**Decision frame chosen by operator:** rank *everything* (Aave thin-chains + non-Aave forks), optimize for **highest probability of landing real liquidations** (not max-$, not pure capability-building).

> Companion to the SITREP (same session). The SITREP established **the bot works, the
> market won't pay it** — across 859 on-chain liquidations the bot won 0, never even
> broadcast a tx, because every winnable liquidation is taken in-block by a searcher
> pack. This proposal answers: *where do we point it instead?*

---

## 1. The real root cause (this reframes everything)

The reason we win 0 is **not** chain-specific and **not** a bug. It is the **oracle
mechanism**, and it's the same on every chain we run:

- Aave (and Compound forks) mark health factors off a **push oracle** (Chainlink on our
  L2s). A position only becomes liquidatable **the instant a new oracle price lands
  on-chain.**
- Pro searchers **backrun the oracle update**: they watch the incoming price report and
  place their `liquidationCall` in the **same block**, immediately after it. This is
  called **OEV — Oracle Extractable Value.**
- On Ethereum mainnet, Chainlink now *sells* this as a product (**SVR — Smart Value
  Recapture**): searchers bid in a private auction to backrun the oracle, and have
  already processed >$32M in liquidations / recaptured >$1.1M. Moonwell (a Compound fork
  on Base/Optimism) **enabled Chainlink OEV wrapper contracts in Feb 2026.** The game is
  being formalized and sold.

**Our architecture cannot play this game.** We poll blocks over HTTP every ~10s, then
run discover→simulate→send sequentially. By the time we *see* HF<1, the oracle-update
block is already mined with someone else's liquidation in it. We are a lap behind by
design. This is exactly why `bot-base/opt/avax` found **0** liquidatable positions in
11h while 859 liquidations happened around us — every one resolved in the oracle block.

**Implication for "switch chains":**
- Switching to **another Aave chain** = **same OEV game**, just different competitors.
  Worth it *only* if that chain's pack is thin/absent.
- Switching to a **different ecosystem with a different oracle** (esp. one with **no
  OEV-auction infrastructure built yet**) = the field is **genuinely more open**, because
  there's no formalized backrun market and possibly few/no searchers at all.

This is why the operator's instinct — *go outside the Aave/Chainlink mainstream, find
diamonds in the rough* — is mechanically correct, not just vibes. The thinner the
searcher presence AND the less OEV tooling exists, the more a "slow" poll-bot can win.

---

## 2. What actually makes a venue winnable for *us*

Ranking criterion (in priority order, given "land real liquidations"):

1. **Searcher density / OEV tooling** — is there a pro pack backrunning the oracle? Is
   there a Chainlink-SVR / OEV-auction wired up? *Fewer = better.* (Dominant factor.)
2. **Liquidation cadence** — does the venue produce a steady trickle of liquidatable
   positions, or is it dead? (Need *some* flow, but we don't need much — even 1–2
   winnable/week beats today's 0.)
3. **Integration cost** — Aave chain (config-only) vs Compound fork (new contract +
   adapter). *Lower = faster to a verdict.*
4. **Borrowed TVL** — sizes the $ per win. Secondary, because a small win we *land* beats
   a big win we *lose*.
5. **Docs quality / our familiarity** — operator values Aave's clear docs; Compound V2
   is equally well-documented (it's the most-forked lending design in DeFi).

---

## 3. Candidate venues — ranked

Hard numbers are live as of 2026-06-06 (DeFiLlama + chain docs); "winnability" is my
estimate and **must be validated by the §6 probe before any build.**

### Tier A — best probability of landing real liquidations

| # | Venue | Protocol type | Borrowed (liquidatable) | Oracle | OEV pack? | Integration | Why it ranks here |
|---|-------|---------------|------------------------|--------|-----------|-------------|-------------------|
| **A1** | **Kinetic on Flare** | Compound V2 fork | **~$12.2M** (of $34M TVL) | **FTSOv2** (push, ~1.8s/block) | **None known** — no Chainlink-SVR on Flare | New contract + adapter (1–2 wks) | **Different oracle + no OEV auction = the cleanest open field.** Flare chain TVL is *growing* on XRPFi ($457M). Compound `liquidateBorrow` is dead-simple. This is the "diamond in the rough." |
| **A2** | **Aave V3 on Gnosis** | Aave V3 (our code!) | small (~$56M supply, low borrow) | Chainlink | likely thin | **Config-only (hours)** | Cheapest possible test of "thin Aave chain." If a pack isn't there, we win with code we already trust. Near-zero effort to *find out*. |

### Tier B — viable, more competitive or more work

| # | Venue | Protocol type | Borrowed | Oracle | OEV pack? | Integration | Notes |
|---|-------|---------------|----------|--------|-----------|-------------|-------|
| B1 | Aave V3 on Scroll / Celo / Soneium | Aave V3 (our code) | small–mid | Chainlink | unknown | Config-only | Same "thin Aave chain" bet as Gnosis; probe to pick the thinnest. |
| B2 | Venus (BNB Chain) | Compound V2 fork | huge (~$4.2B TVL) | Chainlink/Pyth + resilient feeds | **Heavy** | New adapter | Biggest Compound-fork pool, but BNB is a mature MEV battlefield. High $, low win-prob. Against our chosen goal. |
| B3 | Moonwell (Base/Opt) | Compound V2 fork | mid | Chainlink **+ OEV wrappers (since Feb 2026)** | **Yes, formalized** | New adapter | Explicitly wired OEV auctions — *avoid*, same trap as Aave-Base. |
| B4 | Silo / Euler V2 (Sonic, Arb) | isolated-market | $410M / $880M | mixed | growing | New adapter (non-trivial, novel design) | Newer designs, less forked tooling; higher build risk. Park for later. |

### Tier C — explicitly de-prioritized
- **Ethereum mainnet Aave** — true paid orderflow exists (Flashbots/SVR) but it's the
  *most* contested venue on earth and requires paid infra to play. Against "land real
  liquidations cheaply." Revisit only if we want the max-$ game later.
- **Staying on Base** — operator's read is correct: Base is Coinbase's chain and the
  pack (`0x919bb308…` won 3/3 in the last hour, cross-chain pro) is almost certainly
  privileged/colocated. **Recommend dropping Base** (see §7).

---

## 4. Recommendation

**Two-track, sequenced to get a real verdict fastest and cheapest:**

**Track 1 (this week, ~hours): Probe + pivot the Aave fleet to thin chains.**
Drop Base. Stand up **Gnosis** (A2) — and one of Scroll/Celo/Soneium — using
**config-only** changes to `src/chains.js` (these slots already exist; Ethereum/Linea/
Polygon/Metis are pre-defined, so the pattern is proven). Run the §6 winnability probe on
each *before* committing a container. This costs almost nothing and either (a) lands us
our first win on code we trust, or (b) proves the OEV pack is everywhere in Aave-land,
which is itself the decisive data point for going all-in on Track 2.

**Track 2 (1–2 weeks, the real bet): Build the Kinetic/Flare adapter (A1).**
This is where the field is genuinely open — different oracle (FTSOv2, not Chainlink),
**no OEV auction infrastructure**, growing ecosystem, simple Compound `liquidateBorrow`.
This is the "diamond in the rough" the operator wants. It's a real build (new solidity
contract, new helpers, FTSO price adapter) but it's the move most likely to actually
break the 0-win streak, because we'd be early to an under-farmed market rather than late
to a saturated one.

**Why both, in this order:** Track 1 is so cheap it's irresponsible *not* to run it first
— it might just work, and either way it tells us whether "thin Aave chain" is a real
escape or a mirage. Track 2 is the higher-conviction play but costs real engineering, so
we de-risk it with Track 1's signal first.

---

## 5. Honest risks & unknowns (do not skip)

- **Kinetic is small and softening.** Borrowed ~$12.2M, protocol revenue ~$170K/yr and
  recent fees declining (7-day fees dropped sharply). The liquidation flow may be a
  *trickle*. We must confirm there *are* periodic liquidations there before building —
  an open field with no game happening is still 0 wins. **§6 probe gates this.**
- **OEV may already be on Flare and just undocumented.** "No SVR on Flare" is from
  absence of evidence. A local searcher could already backrun FTSO updates. The probe
  (watch who wins Kinetic liquidations) settles it.
- **FTSO read-path needs verification.** FTSOv2 block-latency feeds are a **push** model,
  readable on-chain via `FtsoV2Interface` (per Flare dev docs); confirmed update cadence
  ~1.8s/block, free to read. I have **not** yet pulled the exact getter signatures
  (`getFeedById` etc.) or confirmed our bot can read the *same* value Kinetic reads in
  the same block — that's a first-task spike in the build, not a settled fact.
- **Compound-fork liquidation differs from Aave.** `liquidateBorrow(borrower,
  repayAmount, cTokenCollateral)` against cTokens; **no `flashLoanSimple` on the lending
  side** — we'd need a separate flash-loan source (e.g. a DEX/balancer flash) or to fund
  repays from our own capital. This is the meat of the new contract and the main effort
  driver. Our existing `AaveLiquidatorSwapRouter02.sol` is **100% Aave-coupled**
  (`flashLoanSimple` + `liquidationCall`) and cannot be reused as-is.
- **The OEV problem follows us if we stay push-oracle.** Even on Flare, we're still
  reacting to oracle updates. We win only if *no one faster is doing the same there yet.*
  The durable fix to actually *compete* (vs. exploit a gap) is to react in-block to the
  oracle update ourselves — out of scope here (operator chose "land liquidations" over
  "build OEV capability"), but it's the real endgame if a venue turns competitive.

---

## 6. The probe (DO THIS before any build — settles winnability per venue)

For each candidate venue, before writing a line of integration code, run a **read-only
win-rate probe** (same idea as our existing `winscan-runner`, pointed at the new venue):

1. **Find the pool/comptroller + liquidation event signature.**
   - Aave chains (Gnosis/Scroll/Celo): reuse winscan — `LiquidationCall` topic
     `0xe413a3…`, point at that chain's Pool. *Zero new code.*
   - Kinetic/Flare: find the comptroller, get the `LiquidateBorrow` event signature
     (Compound V2 standard), scan Flare RPC.
2. **Scan ~7 days of liquidation events** and tabulate: total liquidations, distinct
   liquidator addresses, and **concentration** (does 1 pack win >70%? → contested. Many
   one-off addresses / low volume of pro repeats? → open).
3. **Verdict per venue:**
   - *Open + has flow* → **build/point here.** (This is the green light.)
   - *Contested pack* → skip (same trap as Base).
   - *Open but ~0 flow* → note and deprioritize (no game to win).
4. **Cross-check** at least one recently-liquidated borrower was a *normal*, non-dust
   position (real $, not a thin-liquidity trap like our Arbitrum `0x9647`).

**Gate:** no integration build starts until a venue shows **open + real flow** in the
probe. This is the discipline that was missing before (we built, then discovered the
market was contested). Probe first, build second.

---

## 7. Concrete next actions

1. **[done this session]** Killed the two zombie `bot-arbitrum-run` containers (one
   nonce-holder per wallet restored).
2. **[propose now] Drop Base** from the live fleet (stop+remove `bot-base`, comment its
   compose block like Plasma was). Frees CPU; it's a proven dead end. Keep the data/config.
3. **[Track 1, hours] Probe Gnosis + Scroll/Celo/Soneium** with winscan (read-only).
   Pick the thinnest. If thin → add via `src/chains.js` config + one container, run live.
4. **[Track 2, 1–2 wks] Kinetic/Flare spike:** (a) confirm FTSO read-path + same-block
   price; (b) confirm Compound `liquidateBorrow` flow + a flash-loan source on Flare;
   (c) probe Kinetic liquidation flow/concentration. If green on all three → build the
   `KineticLiquidator` contract + helpers adapter.
5. **Keep the winscan tripwire running** on whatever we deploy — the success metric is
   unchanged: **OURS > 0, on a standalone non-pack liquidation.** That single event is
   the whole point.

---

## 8. Appendix — sources

- OEV / Chainlink SVR (the mechanism we lose to): https://blog.chain.link/chainlink-svr-analysis/ ,
  https://docs.chain.link/data-feeds/svr-feeds
- Moonwell OEV wrappers enabled Feb 2026 (Compound fork joining the OEV game):
  https://www.theblock.co/post/390302/
- Flare FTSOv2 (push oracle, ~1.8s/block, free, `FtsoV2Interface`):
  https://dev.flare.network/ftso/overview , https://dev.flare.network/ftso/feeds/
- Kinetic (Compound V2 fork on Flare): https://docs.kinetic.market/liquidity-market/protocol-parameters ,
  https://defillama.com/protocol/kinetic (TVL $34M / borrowed $12.2M)
- Aave V3 21-chain footprint (thin-chain candidates): https://aave.com/docs/resources/changelog
- Compound V2 liquidation interface (`liquidateBorrow`, close factor, incentive):
  https://docs.compound.finance/v2/comptroller/
- Venus / Benqi / Silo / Euler comps: https://defillama.com/protocol/venus , https://defillama.com/protocol/benqi
