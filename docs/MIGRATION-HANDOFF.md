# Handoff: migrate the Aave liquidator bot to its own DigitalOcean droplet

You are taking over an operations task. An Aave V3 liquidation bot currently runs on a
**shared** DigitalOcean droplet that is overloaded (load ~23 on 2 vCPUs, 0 free swap,
~108 MB free RAM) because other `hermes-fleet` services share the box. The bot itself is
healthy and **LIVE** (submitting real transactions). Your job: stand up a **new, dedicated**
droplet, move the bot there with its state intact, cut over cleanly, and update the docs.

You have the user's DigitalOcean API token and SSH key (in the repo `.env`; see below).

---

## ⚠️ READ FIRST — the rules that prevent losing money

1. **The bot is LIVE (`TEST_MODE=false`).** It liquidates real Aave positions with a real
   wallet. Treat the wallet key and `.env` as production secrets.
2. **NEVER run two instances at once.** Both old and new containers running against the same
   wallet = nonce collisions and possibly double liquidations. The cutover must be:
   **stop old → start new** (never both live). It is fine for the old one to keep running
   *until* the new one is verified, but stop the old one BEFORE starting the new one.
3. **Migrate the `data/` borrower stores.** The bot persists its discovered-borrower sets in
   a Docker volume. Base alone has ~210,000 borrowers from a from-deployment backfill that
   took hours. If you start fresh without the data, every chain re-backfills from scratch
   (slow, and hammers public RPCs). COPY THE VOLUME DATA OVER.
4. **`.env` holds secrets — never commit it, never paste its values into logs/chat.** It is
   gitignored. Includes `PRIVATE_KEY`, an Alchemy `ARBITRUM_RPC_URL` (contains an API key),
   the DO token, and SSH creds.
5. **Keep `TEST_MODE=false`** on the new box (it's intentionally live). Confirm it explicitly
   before declaring done.
6. Provision **only what's needed** — do not over-buy. Sizing guidance below.

---

## Current state (source of truth)

- **Old droplet:** `hermes-fleet-1`, `s-2vcpu-4gb`, region `nyc3`, IP `159.65.248.219`
  (shared with other workloads — that's the problem we're solving).
- **App dir:** `/opt/aave-liquidator-bot` — a git checkout of
  `git@github.com:cobibean/aave-liquidator-bot.git`, branch `main` (HEAD was commit `51d14d4`).
- **Runtime:** Docker Compose. Container name `aave-liquidator`. Image built from the repo
  `Dockerfile` (`node:20-bookworm-slim`, `CMD ["node","bot.js"]`).
- **Persisted state:** Docker named volume `aave-liquidator-bot_liquidator-data` mounted at
  `/app/data` (files `borrowers-<chain>.json`, `watchlist-<chain>.json`).
- **Chains (all 5 LIVE, hardened contracts deployed, `minProfit=$2`):** plasma, arbitrum,
  base, avalanche, optimism. Discovery backfills are DONE on all 5.
- **Our footprint on the box:** container uses ~1.56 GiB RAM and ~57% of one vCPU. Modest.
- The repo `.env` on the **local/dev** machine that this handoff ships with contains the DO
  token (`DIGITALOCEAN_API_TOKEN`) and SSH key path (`DROPLET_SSH_KEY_PATH`,
  `/Users/cobibean/.ssh/job_hunter_do_ed25519`). The **droplet's** `.env` is the live one to
  migrate (it additionally has the chain liquidator addresses + `ARBITRUM_RPC_URL`).

### Right-sizing the new droplet
The bot is one Node process running 5 chains. ~1.56 GiB RAM is the working set, with spikes
during the periodic full health-factor sweep (Base has ~210k borrowers). Recommended:
- **`s-2vcpu-4gb`** (same size, but DEDICATED — no other workloads) is the safe default and
  matches current usage with headroom. Do NOT undersize to 1 vCpu/1GB — the Base full sweep
  will thrash.
- Optional: `s-2vcpu-8gb` for comfortable headroom if the user wants margin. Don't go bigger.
- Region: `nyc3` (same as now) is fine; any region with good RPC latency works.
- Image: Ubuntu 24.04 LTS x64. Enable backups optional.

---

## Steps

### 1. Provision the new droplet
- Use the DO API (token in `.env` as `DIGITALOCEAN_API_TOKEN`) or `doctl`.
- Create a droplet, suggested name **`liquidator-solo-1`**, size `s-2vcpu-4gb`, Ubuntu 24.04,
  region `nyc3`, with the user's existing SSH key added (so you can log in). Find the SSH key
  fingerprint/id via the DO API (`/v2/account/keys`) — reuse the key already on `hermes-fleet-1`.
- Wait for `status=active`, grab the public IPv4.

### 2. Prep the new box
SSH in (`ssh -i <key> root@<new-ip>`), then:
```bash
apt-get update && apt-get install -y docker.io docker-compose-plugin rsync
systemctl enable --now docker
mkdir -p /opt/aave-liquidator-bot
```

### 3. Move the code + secrets + DATA
From your machine (or directly old→new):
```bash
# code: pull fresh from git on the new box (cleanest), OR rsync from old box
ssh root@<new-ip> 'cd /opt/aave-liquidator-bot && git clone git@github.com:cobibean/aave-liquidator-bot.git . || git pull'
# (if no git creds on the box, rsync the repo from the old box instead, excluding node_modules/.git)

# .env (LIVE secrets) — copy from OLD droplet to NEW, never through a committed file:
scp -3 root@159.65.248.219:/opt/aave-liquidator-bot/.env root@<new-ip>:/opt/aave-liquidator-bot/.env
# verify it landed and still has TEST_MODE=false and the ARBITRUM_RPC_URL line.

# DATA volume (the borrower stores) — copy the files, then they'll seed the new volume:
ssh root@159.65.248.219 'docker run --rm -v aave-liquidator-bot_liquidator-data:/d -v /root:/out alpine tar czf /out/liqdata.tgz -C /d .'
scp -3 root@159.65.248.219:/root/liqdata.tgz root@<new-ip>:/root/liqdata.tgz
# on the NEW box, after `docker compose up -d` creates the volume (step 4), or pre-create it:
ssh root@<new-ip> 'docker volume create aave-liquidator-bot_liquidator-data && docker run --rm -v aave-liquidator-bot_liquidator-data:/d -v /root:/in alpine sh -c "tar xzf /in/liqdata.tgz -C /d"'
```

### 4. Start the new bot — but coordinate the cutover to avoid double-running
```bash
# A) Build the new one but DON'T let it run live yet — verify config first:
ssh root@<new-ip> 'cd /opt/aave-liquidator-bot && grep TEST_MODE .env && ls -la'
# B) STOP THE OLD BOT (critical — never two live at once):
ssh root@159.65.248.219 'cd /opt/aave-liquidator-bot && docker compose down'
# C) START THE NEW BOT:
ssh root@<new-ip> 'cd /opt/aave-liquidator-bot && docker compose up -d --build'
```

### 5. Verify the new box is healthy and live
```bash
ssh root@<new-ip> '
  docker inspect --format "status={{.State.Status}} restarts={{.RestartCount}}" aave-liquidator
  docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" aave-liquidator | grep ^TEST_MODE   # must be false
  # confirm stores migrated (counts should match old: base ~210k, arbitrum ~13.8k, optimism ~12.2k, avalanche ~4.7k, plasma ~4.3k):
  for c in plasma arbitrum base avalanche optimism; do docker exec aave-liquidator sh -c "grep -oE \"\\\"(count|backfillDone)\\\":[^,}]+\" /app/data/borrowers-$c.json | tr \"\n\" \" \"; echo \" <- $c\"; done
  # confirm it resumes INCREMENTAL (not a fresh BACKFILL — that means data didn’t migrate):
  docker logs --since 3m aave-liquidator | grep -E "incremental|BACKFILL" | head
  free -m | grep Mem   # should have plenty of free RAM now (dedicated box)
'
```
- ✅ Pass = container running, `TEST_MODE=false`, store counts match, logs say `incremental`
  (NOT `BACKFILL ... one-time`), RAM healthy.
- ❌ If logs show `BACKFILL` from a deployment block, the data didn't migrate — fix the volume
  copy before leaving it (otherwise it re-backfills for hours).

### 6. Decommission / update docs
- Once the new box is verified live for ~15–30 min with no errors and the old one stopped:
  optionally `doctl compute droplet delete hermes-fleet-1` **ONLY IF** the user confirms no
  other services on it are needed (it had other `hermes-fleet` workloads — DO NOT delete it
  without explicit confirmation; just leaving our container `down` there is fine).
- **Update documentation** in the repo (commit + push to `main`):
  - `AGENTS.md` — change the droplet name/IP references from `hermes-fleet-1` /
    `159.65.248.219` to the new droplet, and the `DIGITALOCEAN_DROPLET_NAME`.
  - `docs/liquidator-bot-overview.html` — the "Running & operating it" section names
    `hermes-fleet-1`; update to the new droplet.
  - The local dev `.env` (NOT committed) — update `DIGITALOCEAN_DROPLET_NAME` to the new name
    so `npm run droplet:room` and the team's tooling target the new box.
  - Note in the commit that the bot moved to a dedicated droplet and why (shared-box overload).

---

## Acceptance criteria
- New dedicated droplet running the bot, `TEST_MODE=false`, container healthy, 0 crash-loops.
- Borrower stores migrated (counts match; logs show `incremental`, not a fresh backfill).
- Old droplet's `aave-liquidator` container stopped (`docker compose down`); old droplet itself
  left intact unless the user says to delete it.
- Exactly ONE bot instance live against the wallet at all times during cutover.
- Docs updated (AGENTS.md, the HTML overview, dev `.env` droplet name) and pushed to `main`.
- Secrets never committed or printed.

## Useful context / gotchas
- Repo path on the dev machine has literal parens: `~/Documents/liquidator(s()` — quote it.
- Wallet (owner of all liquidators): `0x40aBdc50e3B619D072754a767578EE2a4a4F954d`.
- Liquidator contracts: plasma `0x81f151E54B9578337f95bb84C821b96A73E98194`; arbitrum/base/
  avalanche/optimism all `0x049DBB52c1fdf75362Abf4cf2B1e13F82c0e3dC4`. All have `minProfit=2000000` ($2, 6dp).
- Arbitrum MUST use its Alchemy `ARBITRUM_RPC_URL` (public RPCs reject its txs) — it's in the
  migrated `.env`; don't drop it.
- Health checks while running: `docker logs -f aave-liquidator | grep -E "🔥|TX sent|Successful|failed"`.
- Rollback if the new box misbehaves: `docker compose down` on new, `docker compose up -d` on
  old (back to the shared box) — still only ever ONE live.
