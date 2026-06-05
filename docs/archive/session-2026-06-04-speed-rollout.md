# Session recap — 2026-06-04: latency rollout (WARM fix + per-block + Chainlink price trigger)

> **⚠️ SUPERSEDED — DO NOT TRUST THE ROOT-CAUSE CLAIM BELOW.** This recap concludes
> the miss was a *"submission-speed race, not a discovery gap."* **That conclusion was
> REVERSED on 2026-06-05:** the bot was in fact NOT firing at all (0 attempts) because
> at-risk whales sat in the COLD-only tier (COLD ran ~once/17h) — a discovery/coverage
> gap, not a latency race. See **`docs/liquidator-situation-report-2026-06-05.md`** for
> the current, authoritative state. The per-block/price-trigger/WARM-chunking work
> described here did ship and is live; only the *diagnosis* of why we lose was wrong.
> Kept for the command snippets + shipped-changes record.

Status at session close: **all changes live on the `liquidator-solo-1` droplet, code committed + pushed to `origin/main` (`396b6f9`).** TEST_MODE=false (live money) throughout. No incidents.

## What prompted this

Routine check-in. On-chain audit found **383 Aave liquidations across our 5 markets in 12h, of which we won 0.** Root cause: it's a **submission-speed race, not a discovery gap** — on Base, 123/123 liquidated borrowers were already in our tracked set with real (non-dust) debt ($15k–$19k each); we just never reacted in time. Winners are bundle-submitting MEV searchers (vanity addrs `0x8888…`, `0xa00003…`, `0xf00003…`). Arbitrum had a secondary discovery gap (only 50/127 tracked — likely the 366-day backfill cap).

Audit method (repeatable): scan each chain's Aave Pool for `LiquidationCall` topic `0xe413a321…` via the droplet's Alchemy RPCs, run from inside a bot container at `/app` (ethers v5; `CHAIN_CONFIGS` is a keyed object). Script approach in `/tmp/missed_liq_scan.js` on the droplet.

## What shipped (all default-off / behavior-preserving)

1. **WARM-sweep chunking** (`aaveHelpers.js`, `WARM_SWEEP_SLICES`). Base's WARM tier swept all ~60,793 active-debt wallets in one cycle (90s–454s, starving the every-cycle watchlist). Now slices the index into rotating parts (one per cycle) + the hot tiers. **LIVE on Base, slices=10:** 60,793→~10,500/cycle, 90s–454s→~17s. State machine intact.

2. **Per-block watchlist trigger** (`BLOCK_TRIGGER`, was Arbitrum-only). **Now LIVE on all 5 chains.** Re-checks the watchlist every block (~1–2s) instead of the 15s poll. WS-push on the 4 Alchemy chains, HTTP-poll on Plasma. The doc's "private RPC blocker" was already resolved — Alchemy private RPCs were live on 4/5 chains.

3. **Chainlink price-update trigger** (`PRICE_TRIGGER`, new — Phase 4 free slice). Subscribes to `AnswerUpdated` on each chain's volatile-collateral Chainlink aggregator (ETH/AVAX/USD) and fires a watchlist re-check on price moves (the cause of HF<1). **LIVE on the 4 WS chains** (base/arbitrum/optimism/avalanche). Plasma stays per-block-only (no free WS). $0: Alchemy WS is the same key (https→wss); Chainlink reads/events are free.

Code: `bot.js` (shared `eventProvider` = one WS socket/chain + `triggerWatchlistCheck` under one `lock.inFlight`), `src/chains.js` (`collateralPriceFeed` per chain). Committed `396b6f9`.

## Deploy mechanics (for the next agent)

- One container per chain (`bot-<chain>`), shared image + `.env` + `liquidator-data` volume. Per-chain knobs go in that service's compose `environment:` block; recreate with `docker compose up -d bot-<chain>` (env-only) or `--build` (code change).
- Code deploy = rsync to `/opt/aave-liquidator-bot/` → `docker compose up -d --build`. Data volume (`/app/data`) survives.
- Compose/env changes are **droplet-only, not in git** (hold the Alchemy key in WS URLs). Backups at `/opt/aave-liquidator-bot/docker-compose.yml.bak.*`.
- The local repo also has an **unrelated, pre-existing `monitor/` dashboard rework + docker-compose.yml/.env.example/README** uncommitted — NOT touched this session, not mine. Leave it or commit separately after review.

## Open items / where to look next

- **WS reliability — needs an overnight.** ethers v5 `WebSocketProvider` does NOT auto-reconnect. A silent drop falls back to the 15s poll (degraded, never zero). 30-min canary was clean but that only rules out immediate drops. If drops prove frequent over an overnight, add a reconnect/heartbeat wrapper before trusting WS. (Overnight check scheduled.)
- **Win-rate — unproven.** Still 0 wins, but per-block has only been live ~1.5h in a quiet market. Judge over a busy overnight (re-run the LiquidationCall scan, look for our wallet `0x40aBdc50…` in the liquidator list).
- **Deliberately NOT done (Phase 4 part 3, paid):** mempool/bundle (Flashbots-style) submission — the only thing that wins *contested same-block* races. Needs paid infra + a relay; deferred until there's evidence we win the slower/uncontested liquidations first.
- **Secondary:** Arbitrum discovery gap (backfill cap) — widen if we start competing there.

## Honest expectation

The free latency stack (per-block + price triggers) should start catching **uncontested / slower** liquidations — going from 0 to nonzero. It will NOT beat same-block bundle searchers; that's the paid Phase-4-part-3 work. So the open question for the next session is genuinely: *do the free triggers win enough to justify paid infra, or is it best to let it sit?*

## Morning check — run this cold (no Claude needed)

The win-rate scan is saved on the droplet at `/opt/aave-liquidator-bot/scripts/liquidationWinScan.js`. Run it from inside a bot container (inherits the Alchemy RPC env + node_modules):

```bash
ssh -i ~/.ssh/job_hunter_do_ed25519 root@165.227.191.252 \
  'docker cp /opt/aave-liquidator-bot/scripts/liquidationWinScan.js bot-arbitrum:/app/_winscan.js && \
   docker exec -w /app -e SCAN_HOURS=17 -e SCAN_CHAINS=plasma,arbitrum,base,avalanche,optimism bot-arbitrum node /app/_winscan.js; \
   docker exec bot-arbitrum rm -f /app/_winscan.js'
```

Look for `OURS: >0` or our wallet `0x40abdc50e3b619d072754a767578ee2a4a4f954d` in any liquidator list = **first win**. Baseline: prior overnight was ~383/12h on-chain, 0 wins.

WS-reliability check (per WS chain — confirm the socket didn't silently die):
```bash
# error scan (ignore block-number false positives — grep whole words):
ssh -i ~/.ssh/job_hunter_do_ed25519 root@165.227.191.252 \
  'for c in bot-base bot-arbitrum bot-optimism bot-avalanche; do echo "== $c =="; \
   docker logs --since 17h $c 2>&1 | grep -iE "ECONNRESET|socket hang up|connection closed|code: 1006|failed to set up price|reconnect"; done'
# live-socket probe (Base shown; expect ~5 blocks in 10s):
ssh -i ~/.ssh/job_hunter_do_ed25519 root@165.227.191.252 \
  'docker exec bot-base node -e "const{ethers}=require(\"ethers\");const w=new ethers.providers.WebSocketProvider(process.env.BASE_WS_URL,8453);let n=0;w.on(\"block\",()=>n++);setTimeout(()=>{console.log(\"WS blocks/10s:\",n,n>0?\"ALIVE\":\"DEAD\");process.exit(0)},10000)"'
```

Decision the next session faces: **do the free triggers win enough to justify paid Phase-4-part-3 (bundle/mempool) infra, or is it best to let it sit?**

See memory: `liquidator-missed-liquidations-rootcause`, `liquidator-warm-sweep-chunking`, `liquidator-speed-plan-state`, `liquidator-chainlink-trigger-feasibility`, `liquidator-project-facts`.
