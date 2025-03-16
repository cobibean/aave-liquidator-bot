- [ ] **Critical Changes**
  - [ ] Remove hardcoded USDC address from `aaveHelpers.js`
  - [ ] Add `DEBT_ASSET_ADDRESS` to `.env`
  - [ ] Verify `AAVE_LIQUIDATOR_ADDRESS` is correct for Metis mainnet

- [ ] **Security Verification**
  - [ ] Run: `git grep -E '0x[0-9a-fA-F]{40}'` (check for other hardcoded addresses)
  - [ ] Run: `git grep -E '[1-9A-HJ-NP-Za-km-z]{32,}'` (check for base58 private keys)
  - [ ] Check shell history for accidental secret exposure
  - [ ] Confirm `.env` is in both `.gitignore` and `.cursorignore`

- [ ] **Documentation**
  - [ ] Add `SECURITY.md` with warnings
  - [ ] Create/update `.env.example` with required variables
  - [ ] Add MIT License file
  - [ ] Add disclaimer to README: "Experimental project - use at your own risk"

- [ ] **Final Checks**
  - [ ] Test fresh clone with `cp .env.example .env` flow
  - [ ] Verify bot runs without real private key in dev mode
  - [ ] Consider adding `truffle-hygiene` or `git-secrets` for ongoing checks
