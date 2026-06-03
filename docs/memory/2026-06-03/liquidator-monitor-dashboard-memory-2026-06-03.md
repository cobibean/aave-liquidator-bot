# Aave Liquidator Monitor Dashboard Memory - 2026-06-03

## Session summary

- Added a private Express-based monitor dashboard under `monitor/`.
- The dashboard summarizes Docker/container state, selected whitelisted env
  values, recent parsed bot logs, per-chain borrower data, liquidation activity,
  and warnings.
- Raw logs are hidden on initial page load and fetched only through the Raw logs
  controls or `GET /api/logs`.
- The monitor degrades cleanly when Docker, the bot container, logs, or borrower
  data are unavailable.

## Decisions made

- Use the Docker Engine API over `/var/run/docker.sock` instead of installing a
  Docker CLI inside the monitor image.
- Keep dependencies minimal: Express only, with Node's built-in test runner.
- Mount bot borrower data read-only at `/bot-data` in Compose.
- Bind the dashboard to host loopback via Compose:
  `127.0.0.1:${MONITOR_PORT:-8787}:8787`.
- Use Tailscale Serve for private access and explicitly avoid Funnel/public
  exposure.
- Redact raw logs and summaries centrally before returning API output. Redaction
  is best-effort and should not be treated as a public-exposure control.
- The monitor Compose service runs as root so it can read the host Docker
  socket on typical Linux hosts.

## Files created or changed

- `monitor/`: new app source, Dockerfile, package files, static UI, and tests.
- `docker-compose.yml`: added `liquidator-monitor` service with Docker socket
  and read-only `liquidator-data` mounts.
- `README.md`: added local, droplet, Tailscale Serve, verification, and security
  instructions for the monitor.
- `.env.example`: added non-secret monitor config.
- `.dockerignore`: excludes monitor node modules, local data, and browser scratch.
- `.gitignore`: excludes `.playwright-cli/`.
- `package.json`: added `monitor:start` and `monitor:test` scripts.

## Commands and verification

- `npm install --prefix monitor` completed with no reported vulnerabilities.
- `npm run monitor:test` passed 5 tests:
  redaction, log parser, status summary, and raw logs endpoint redaction.
- Local monitor smoke:
  `npm run monitor:start`, then `/api/health`, `/api/status`, and `/api/logs`.
  With no local Docker socket, status returned degraded/missing access instead
  of crashing.
- Browser sanity via Playwright:
  desktop page loaded, console clean after favicon patch, raw logs panel was
  closed by default, and 390px mobile width had no horizontal overflow.
- `ruby -e 'require "yaml"; YAML.load_file("docker-compose.yml")'` parsed the
  Compose YAML.
- `docker compose config` could not be run locally because Docker CLI is not
  installed on this machine.

## Known constraints

- Docker socket access is powerful host access even with a read-only mount.
  Keep the monitor bound to loopback and exposed only through private Tailscale.
- The monitor has no authentication layer of its own.
- `GET /api/logs` intentionally exposes redacted raw logs on explicit request;
  do not make it public.
- The parser is tolerant and pattern-based. If bot log wording changes, update
  `monitor/src/logParser.js` and tests.
- Root `npm test` was not run because the existing smoke script can print
  configured RPC URLs from `.env`; monitor verification used `npm run monitor:test`.

## Recommended next work

- On the droplet, run:
  `docker compose up -d --build liquidator-monitor`.
- Verify:
  `curl http://127.0.0.1:8787/api/health` and
  `curl http://127.0.0.1:8787/api/status`.
- Expose privately:
  `tailscale serve --bg --https=443 127.0.0.1:8787`.
- If raw log wording evolves, add fixture lines to `monitor/test/fixtures/sample.txt`.
