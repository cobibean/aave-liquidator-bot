# Agent Notes

## Runtime Location

The intended runtime for this project is the DigitalOcean droplet, not a local PM2 process. Local runs are for smoke tests, development, and short dry-run probes only.

Source of truth:
- Droplet identity/access config lives in local `.env`: `DIGITALOCEAN_DROPLET_NAME`, `DIGITALOCEAN_API_TOKEN` or `DO_API_TOKEN`, `DROPLET_SSH_USER`, `DROPLET_SSH_KEY_PATH`, `DROPLET_SSH_PORT`, `DROPLET_APP_DIR`.
- Discover droplet IP, size, and free disk/RAM with `npm run droplet:room`.
- App directory on the droplet defaults to `/opt/aave-liquidator-bot`.
- **Runtime is ONE container PER CHAIN** (since the 1.3 speed change, 2026-06-03):
  `bot-plasma`, `bot-arbitrum`, `bot-base`, `bot-avalanche`, `bot-optimism`, plus a
  `liquidator-monitor`. There is **no longer a single `aave-liquidator` container** —
  any doc/command referencing it is pre-1.3. Each chain runs its own process/heap
  (compose pins `CHAINS=<one>` per service); they share the `.env` and the
  `aave-liquidator-bot_liquidator-data` volume (per-chain store files).
- The bot runs via Docker Compose on the droplet. Host Node/npm/PM2 may be absent and are not required.
- Local PM2 process `aave-liquidator-test`, if present, is only a test artifact. Stop it before reporting production status.

Token-efficient droplet checks (iterate the per-chain containers):

```bash
npm run droplet:room
ssh -i "$DROPLET_SSH_KEY_PATH" -p "${DROPLET_SSH_PORT:-22}" "$DROPLET_SSH_USER@<droplet-ip>"
docker ps --filter name=bot-                       # all chain containers + status
for c in bot-plasma bot-arbitrum bot-base bot-avalanche bot-optimism; do
  docker inspect --format "$c: status={{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}" "$c"
done
docker logs --since 12h --timestamps bot-base       # one chain (repeat per container)
# TEST_MODE / CHAINS are identical across chains except CHAINS (one per container):
docker exec bot-base printenv TEST_MODE VERBOSE_HEALTH_LOGS CHAINS
```

Do not print `.env`, private keys, DigitalOcean tokens, or full Docker env output. Report only whether required secrets are set.

Manual review should summarize counts instead of pasting logs:
- nonzero liquidatable positions
- liquidation attempts
- txs sent
- successful liquidations
- tx failures
- main-loop errors
- latest per-chain liquidatable counts

As of 2026-06-03, the droplet runs the five per-chain containers live with `TEST_MODE=false`, `VERBOSE_HEALTH_LOGS=false`, across `plasma,arbitrum,base,avalanche,optimism`. Speed batches 1–3 are deployed (per-block trigger built but OFF pending WS RPCs; EIP-1559 gas + local nonce active; async send opt-in/off). Actual profitable liquidation execution remains unproven until an unhealthy non-dust borrower appears — AND note the open swap-router correctness bug (the contract swaps via Uniswap V3 but 4 of 5 chains are configured with V2/Sushi routers, so the collateral→debt swap would revert there; a redeploy fix is in progress).

## Droplet Requirements

The droplet needs:
- Docker and Docker Compose. Host Node/npm/PM2 are not required when running via Docker.
- `/opt/aave-liquidator-bot` containing the repo, `.env`, `Dockerfile`, and `docker-compose.yml`.
- `.env` with the wallet `PRIVATE_KEY`, selected `CHAINS`, chain liquidator addresses, and `TEST_MODE` set intentionally.
- Network egress to all configured RPC endpoints and DigitalOcean Monitoring/SSH access for status checks.
- Wallet gas on each live chain the bot monitors.
- At least `DROPLET_MIN_FREE_MB` free disk and `DROPLET_MIN_MEM_AVAILABLE_MB` available RAM. Defaults are 1024 MB disk and 256 MB RAM.
- Docker log rotation enabled in `docker-compose.yml` so logs do not grow unbounded.

## Deployment Notes

Preserve the droplet `.env` AND the data volume when syncing code. Do NOT use
`rsync --delete` (it would wipe droplet-only files like `.env.bak.*` and the
private `ARBITRUM_RPC_URL`). A safe update flow is:

```bash
# back up the live .env first
ssh "$DROPLET_SSH_USER@<droplet-ip>" 'cd /opt/aave-liquidator-bot && cp -a .env .env.bak.$(date +%Y%m%d-%H%M%S)'
# sync code only — exclude secrets, deps, persisted data, and local-only dirs
rsync -az --exclude '.git/' --exclude '.env' --exclude '.env.*' --exclude 'node_modules/' \
  --exclude 'data/' --exclude 'graphify-out/' --exclude 'artifacts/' --exclude 'output/' \
  --exclude '.claude/' --exclude '.playwright-cli/' --exclude '*.log' \
  ./ "$DROPLET_SSH_USER@<droplet-ip>:/opt/aave-liquidator-bot/"
ssh "$DROPLET_SSH_USER@<droplet-ip>" 'cd /opt/aave-liquidator-bot && docker compose up -d --build'
```

Confirm `TEST_MODE` intentionally before restarting. `TEST_MODE=false` submits
real liquidation transactions. The named data volume `aave-liquidator-bot_liquidator-data`
survives rebuilds (do NOT `docker compose down -v`). If the compose *topology*
changes (e.g. service rename), pass `--remove-orphans` to avoid leaving the old
container running — a duplicate process on the same wallet risks double-submits.

## Automation

Codex heartbeat automation `liquidator-droplet-review` is intended to review the droplet every 12 hours and report back in the thread. If checking manually, produce the same concise status summary rather than copying raw logs.

When asked how the liquidator performed, inspect the droplet container logs first. Treat local PM2 status as irrelevant unless the user explicitly asks about a local test run.
