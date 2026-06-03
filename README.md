# Aave Liquidator Bot

A bot that monitors Aave positions across configured Aave V3 markets and executes liquidations when positions become unhealthy, helping to maintain the health of the protocol while creating profit opportunities.

## Overview

This bot continuously monitors Aave borrowers on configured networks, identifies positions that have fallen below the health factor threshold, and executes liquidations using flash loans. The default config targets high-TVL Aave V3 markets outside Ethereum mainnet and Linea: Plasma, Arbitrum, Base, Avalanche, and Optimism. Optional configs also exist for Ethereum, Linea, Polygon, and Metis.

## Features

- **Real-time Monitoring**: Scans recent Aave Borrow events and checks positions on-chain
- **Health Factor Calculation**: Computes health factors for monitored accounts
- **Liquidation Automation**: Automatically executes liquidations when profitable
- **Flash Loan Integration**: Uses flash loans to minimize capital requirements
- **Configurable Settings**: Adjust thresholds and parameters via environment variables
- **Detailed Logging**: Comprehensive logging for monitoring and debugging

## How It Works

1. The bot scans recent Aave Borrow events for active borrowers
2. It calculates health factors for each borrower
3. When it identifies positions below the liquidation threshold, it triggers the liquidation process
4. The liquidation is executed using a flash loan to borrow the required debt asset
5. The collateral is received, swapped (if necessary), and the flash loan is repaid
6. Any profit remains in the liquidator's wallet

## Prerequisites

- Node.js (v14+)
- npm or yarn
- A wallet funded with each selected chain's gas token
- Basic understanding of DeFi liquidations

## Installation

1. Clone the repository:
```bash
git clone https://github.com/cobibean/aave-liquidator-bot.git
cd aave-liquidator-bot
```

2. Install dependencies:
```bash
npm install
```

3. Create your environment file:
```bash
cp .env.example .env
```

## Smart Contract

This bot interacts with a custom AaveLiquidator smart contract that handles the flash loan and liquidation process. The contract code is maintained in a separate repository at:

[https://github.com/cobibean/flashloan-smart-contracts](https://github.com/cobibean/flashloan-smart-contracts)

The compiled contract artifacts are included in this repository under the `artifacts/` directory. Plasma uses the local `AaveLiquidatorSwapRouter02` variant because its Uniswap router exposes V3 `exactInput`/`exactInputSingle` routing instead of the older V2-style `swapExactTokensForTokens` shape.

## Configuration

Edit your `.env` file with the following parameters:

```
# Chain Selection
CHAINS=plasma,arbitrum,base,avalanche,optimism

# Per-chain Liquidator Contracts
PLASMA_AAVE_LIQUIDATOR_ADDRESS=0x...
ARBITRUM_AAVE_LIQUIDATOR_ADDRESS=0x...
BASE_AAVE_LIQUIDATOR_ADDRESS=0x...
AVALANCHE_AAVE_LIQUIDATOR_ADDRESS=0x...
OPTIMISM_AAVE_LIQUIDATOR_ADDRESS=0x...

# Bot Configuration
LIQUIDATION_THRESHOLD=1.0      # Health factor threshold for liquidation
MIN_DEBT_TO_COVER=0.099
GAS_PRICE_BUMP_GWEI=0

# Security
PRIVATE_KEY=                   # Your wallet private key

# Optional
TEST_MODE=true                 # Set to false for actual liquidations
VERBOSE_HEALTH_LOGS=false      # Set true for per-borrower health factor logs
```

Default gas tokens:

- Plasma: XPL
- Arbitrum: ETH
- Base: ETH
- Avalanche C-Chain: AVAX
- Optimism: ETH

RPC fallbacks are configured in code for public smoke tests. Override them per chain with `ARBITRUM_RPC_URLS=https://...,...` or set a single-chain `RPC_URLS` when using `CHAIN=...`.

## Usage

Run the bot:

```bash
node bot.js
```

Run the five-chain read-only smoke test:

```bash
npm test
```

Run static liquidation preflight against real recent borrowers:

```bash
npm run preflight:liquidation
```

Check whether the configured DigitalOcean droplet has deployment room:

```bash
npm run droplet:room
```

Set `DIGITALOCEAN_API_TOKEN` and `DIGITALOCEAN_DROPLET_NAME` in `.env` first. The checker uses DigitalOcean Monitoring for actual free disk/RAM when available, and can fall back to SSH if `DROPLET_SSH_KEY_PATH` is set.

Estimate or deploy the compiled liquidator artifact:

```bash
npm run compile
npm run deploy:liquidator
DEPLOY_CHAINS=base,avalanche,optimism DEPLOY=true npm run deploy:liquidator
```

Run one chain only:

```bash
SMOKE_CHAINS=arbitrum npm run smoke:chains
CHAIN=arbitrum node bot.js
```

For production use, consider using a process manager like PM2:

```bash
npm install -g pm2
pm2 start bot.js --name "aave-liquidator"
pm2 logs aave-liquidator
```

Or run it with Docker Compose:

```bash
docker compose up -d --build
docker compose logs -f aave-liquidator
```

## Monitoring

The bot outputs detailed logs showing:
- Borrowers being monitored
- Health factors being calculated
- Liquidation opportunities identified
- Execution of liquidations
- Profits from successful liquidations

### Private monitor dashboard

This repo includes a small Express dashboard in `monitor/` for a human-readable
operator view. It summarizes the `aave-liquidator` Docker container, recent bot
logs, liquidation activity, per-chain borrower progress, and warnings. Raw logs
are hidden on initial page load and are fetched only when the Raw logs controls
are used.

Security model:

- The dashboard is designed for private Tailscale access only.
- Docker Compose binds it to `127.0.0.1:8787` on the droplet by default.
- Do not expose it with public Tailscale Funnel or an unauthenticated public
  reverse proxy.
- The monitor mounts `/var/run/docker.sock` to inspect the bot container and
  read Docker logs. Docker socket access is powerful host access even when the
  mount is marked read-only.
- The Compose service runs the monitor container as root so it can read the
  Docker socket on typical Linux hosts. Treat access to the dashboard as access
  to a privileged operational surface.
- The bot data volume is mounted read-only at `/bot-data`.
- The monitor only reports whitelisted env values: `TEST_MODE` and `CHAINS`.
  It never returns the full container environment.
- Log output is redacted before returning from the API, but redaction is a
  safety net, not a reason to expose the dashboard publicly.

Run locally:

```bash
npm install --prefix monitor
npm run monitor:start
```

Open `http://127.0.0.1:8787`. If Docker or the bot container is unavailable, the
monitor starts anyway and shows degraded or missing-container status.

Run tests for the monitor:

```bash
npm run monitor:test
```

Run on the droplet with Docker Compose:

```bash
cd /opt/aave-liquidator-bot
docker compose up -d --build liquidator-monitor
docker compose ps liquidator-monitor
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/status
```

Expose privately with Tailscale Serve:

```bash
tailscale serve --bg --https=443 127.0.0.1:8787
tailscale serve status
```

Do not enable Tailscale Funnel for this service.

## Security Considerations

Please refer to the [SECURITY.md](SECURITY.md) file for important security information.

## ⚠️ Disclaimer

This is an experimental project - use at your own risk. This bot interacts with real DeFi protocols and can execute liquidations with financial consequences. Never use private keys with real funds for testing.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. 
