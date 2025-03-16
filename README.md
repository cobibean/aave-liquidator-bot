# Aave Liquidator Bot for Metis

A bot that monitors Aave positions on Metis network and executes liquidations when positions become unhealthy, helping to maintain the health of the protocol while creating profit opportunities.

## Overview

This bot continuously monitors Aave borrowers on the Metis network, identifies positions that have fallen below the health factor threshold, and executes liquidations using flash loans. It's designed to operate efficiently with minimal configuration, making it accessible for both small and large liquidators.

## Features

- **Real-time Monitoring**: Continuously checks borrower positions via The Graph API
- **Health Factor Calculation**: Computes health factors for monitored accounts
- **Liquidation Automation**: Automatically executes liquidations when profitable
- **Flash Loan Integration**: Uses flash loans to minimize capital requirements
- **Configurable Settings**: Adjust thresholds and parameters via environment variables
- **Detailed Logging**: Comprehensive logging for monitoring and debugging

## How It Works

1. The bot queries Aave's subgraph for recent borrowers
2. It calculates health factors for each borrower
3. When it identifies positions below the liquidation threshold, it triggers the liquidation process
4. The liquidation is executed using a flash loan to borrow the required debt asset
5. The collateral is received, swapped (if necessary), and the flash loan is repaid
6. Any profit remains in the liquidator's wallet

## Prerequisites

- Node.js (v14+)
- npm or yarn
- Metis wallet with METIS for gas
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

The compiled contract artifacts are included in this repository under the `artifacts/` directory.

## Configuration

Edit your `.env` file with the following parameters:

```
# RPC Configuration
RPC_URL=https://andromeda.metis.io/?owner=1088

# Contract Addresses
AAVE_LIQUIDATOR_ADDRESS=0x...  # Your deployed liquidator contract
POOL_ADDRESS=0x...             # Aave Pool contract on Metis
POOL_ADDRESSES_PROVIDER=0x...  # Aave Pool Addresses Provider on Metis
DEBT_ASSET_ADDRESS=0x...       # USDC address on Metis

# Bot Configuration
LIQUIDATION_THRESHOLD=1.0      # Health factor threshold for liquidation

# Security
PRIVATE_KEY=                   # Your wallet private key

# Optional
TEST_MODE=true                 # Set to false for actual liquidations
```

## Usage

Run the bot:

```bash
node bot.js
```

For production use, consider using a process manager like PM2:

```bash
npm install -g pm2
pm2 start bot.js --name "aave-liquidator"
pm2 logs aave-liquidator
```

## Monitoring

The bot outputs detailed logs showing:
- Borrowers being monitored
- Health factors being calculated
- Liquidation opportunities identified
- Execution of liquidations
- Profits from successful liquidations

## Security Considerations

Please refer to the [SECURITY.md](SECURITY.md) file for important security information.

## ⚠️ Disclaimer

This is an experimental project - use at your own risk. This bot interacts with real DeFi protocols and can execute liquidations with financial consequences. Never use private keys with real funds for testing.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. 