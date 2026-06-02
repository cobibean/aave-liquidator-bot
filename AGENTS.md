# Agent Notes

## Runtime Location

The intended runtime for this project is the DigitalOcean droplet, not a local PM2 process. Local runs are for smoke tests, development, and short dry-run probes only.

Source of truth:
- Droplet identity/access config lives in local `.env`: `DIGITALOCEAN_DROPLET_NAME`, `DIGITALOCEAN_API_TOKEN` or `DO_API_TOKEN`, `DROPLET_SSH_USER`, `DROPLET_SSH_KEY_PATH`, `DROPLET_SSH_PORT`, `DROPLET_APP_DIR`.
- Discover droplet IP, size, and free disk/RAM with `npm run droplet:room`.
- App directory on the droplet defaults to `/opt/aave-liquidator-bot`.
- Runtime container name is `aave-liquidator`.
- The bot runs via Docker Compose on the droplet. Host Node/npm/PM2 may be absent and are not required.
- Local PM2 process `aave-liquidator-test`, if present, is only a test artifact. Stop it before reporting production status.

Token-efficient droplet checks:

```bash
npm run droplet:room
ssh -i "$DROPLET_SSH_KEY_PATH" -p "${DROPLET_SSH_PORT:-22}" "$DROPLET_SSH_USER@<droplet-ip>"
docker ps --filter name=aave-liquidator
docker logs --since 12h --timestamps aave-liquidator
docker inspect --format 'status={{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}}' aave-liquidator
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' aave-liquidator | grep -E '^(TEST_MODE|VERBOSE_HEALTH_LOGS|CHAINS)='
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

As of 2026-06-02, the droplet container was live with `TEST_MODE=false`, `VERBOSE_HEALTH_LOGS=false`, and `CHAINS=plasma,arbitrum,base,avalanche,optimism`. It had no liquidation attempts because no unhealthy positions were found. Actual profitable liquidation execution remains unproven until an unhealthy borrower appears.

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

Preserve the droplet `.env` when syncing code. A safe update flow is:

```bash
rsync -az --delete --exclude .env --exclude node_modules ./ "$DROPLET_SSH_USER@<droplet-ip>:/opt/aave-liquidator-bot/"
ssh "$DROPLET_SSH_USER@<droplet-ip>" 'cd /opt/aave-liquidator-bot && docker compose up -d --build'
```

Confirm `TEST_MODE` intentionally before restarting the container. `TEST_MODE=false` can submit real liquidation transactions.

## Automation

Codex heartbeat automation `liquidator-droplet-review` is intended to review the droplet every 12 hours and report back in the thread. If checking manually, produce the same concise status summary rather than copying raw logs.

When asked how the liquidator performed, inspect the droplet container logs first. Treat local PM2 status as irrelevant unless the user explicitly asks about a local test run.
