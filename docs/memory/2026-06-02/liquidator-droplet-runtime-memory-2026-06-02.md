# Aave Liquidator Droplet Runtime Memory - 2026-06-02

## Session summary

- Revived and tested the multi-chain Aave liquidator bot.
- Confirmed the intended production runtime is the DigitalOcean droplet, not local PM2.
- The droplet has an `aave-liquidator` Docker container running from `/opt/aave-liquidator-bot`.
- A local PM2 dry-run process was started during testing, then stopped after confirming the droplet is source of truth.
- Created Codex heartbeat automation `liquidator-droplet-review` to inspect/report the droplet every 12 hours.

## Decisions made

- Use Docker Compose on the droplet for the bot runtime.
- Do not sync logs back over Tailscale yet; Docker log rotation is enough for current volume.
- Treat `TEST_MODE=false` on the droplet as intentional live mode, but verify before restarts because it can submit real transactions.
- Future performance checks should inspect the droplet container first and ignore local PM2 unless explicitly testing locally.

## Files created or changed

- `AGENTS.md`: added droplet runtime, inspection, deployment, and automation notes.
- `Dockerfile`, `docker-compose.yml`, `.dockerignore`: Docker runtime support exists in the project/droplet.
- `scripts/checkDropletRoom.js`: DigitalOcean room/status checker.
- `scripts/multiChainSmoke.js`: exits cleanly after smoke summary.
- `aaveHelpers.js`: multi-chain borrower/debt discovery and quieter health-factor logging.
- `src/chains.js`, `src/provider.js`, `src/gas.js`: multi-chain configuration/provider/gas helpers.
- `contracts/AaveLiquidatorSwapRouter02.sol` and matching artifact: Plasma SwapRouter02-compatible liquidator.

## Source-of-truth docs

- `AGENTS.md`
- `.env.example`
- `README.md`
- `docker-compose.yml`
- `docs/memory/2026-06-02/liquidator-droplet-runtime-memory-2026-06-02.md`

## Commands and verification

- `npm test` passed five-chain smoke for Plasma, Arbitrum, Base, Avalanche, and Optimism.
- `npm run preflight:liquidation` previously passed static liquidation preflight on all five configured chains.
- `npm run droplet:room` verified droplet identity, provisioned resources, free disk, and available RAM.
- Droplet container checks showed:
  - container `aave-liquidator` running
  - restart count `0`
  - `TEST_MODE=false`
  - `VERBOSE_HEALTH_LOGS=false`
  - chains `plasma,arbitrum,base,avalanche,optimism`
  - Docker log size about 2.3 MB after roughly 9 hours
  - no liquidation attempts, txs, failures, or main-loop errors because no unhealthy positions were found

## Known constraints

- Do not print `.env`, private keys, DigitalOcean tokens, or full Docker env output.
- Host Node/npm/PM2 are not required on the droplet; Docker is the runtime.
- The bot is live on the droplet when `TEST_MODE=false`.
- Actual profitable liquidation execution is still unproven until a real unhealthy borrower appears.
- Docker log rotation should remain enabled to cap log growth.
- Plasma uses the SwapRouter02-compatible liquidator variant; some exotic Plasma collateral/debt routes may still need route coverage if a real opportunity appears.

## Open questions

- Whether to add a small monitor frontend/API on the droplet.
- Whether to add alerting when nonzero liquidatable positions or tx attempts appear.
- Whether to broaden route coverage on Plasma before relying on all possible collateral/debt pairs.

## Recommended next work

- Let the droplet continue running for another 10-12 hours and review via the `liquidator-droplet-review` automation.
- Build a tiny monitor endpoint/UI that reads concise Docker/bot status without storing secrets.
- Add a compact log parser script for repeatable droplet summaries.
- If a liquidatable position appears, inspect route support and only then evaluate whether to adjust swaps or gas settings.
