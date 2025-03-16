# Aave Liquidator Bot for Metis

A bot that monitors Aave positions on Metis network and executes liquidations when positions become unhealthy.

## Features

- Monitors Aave borrowers via The Graph API
- Calculates health factors for all borrowers
- Identifies liquidatable positions
- Executes flash loan liquidations via smart contract

## Setup

1. Clone the repository
2. Copy `.env.example` to `.env` and fill in your configuration
3. Install dependencies: `npm install`
4. Run the bot: `node bot.js`

## Configuration

The bot requires the following environment variables:

- `RPC_URL`: Metis RPC endpoint
- `PRIVATE_KEY`: Your wallet private key
- `AAVE_LIQUIDATOR_ADDRESS`: Address of the deployed liquidator contract
- `POOL_ADDRESS`: Aave Pool contract address
- `POOL_ADDRESSES_PROVIDER`: Aave Pool Addresses Provider
- `DEBT_ASSET_ADDRESS`: Address of the debt asset (USDC)
- `LIQUIDATION_THRESHOLD`: Health factor threshold for liquidation (e.g., 1.0)

## ⚠️ Disclaimer

This is an experimental project - use at your own risk. This bot interacts with real DeFi protocols and can execute liquidations with financial consequences. Never use private keys with real funds for testing. 