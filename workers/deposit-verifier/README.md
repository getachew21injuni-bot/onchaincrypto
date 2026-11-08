# OnChainCrypto Deposit Verifier Worker

This directory contains the existing Cloudflare Worker source supplied from the deployed
`onchaincrypto-deposit-verifier` service.

## Current behavior

- Handles CORS preflight requests.
- Exposes a `GET /health` status response.
- Reports whether `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT` are configured.
- Other paths return a configuration-in-progress response.

## Required Cloudflare settings

Configure these in the Cloudflare Worker dashboard as runtime variables/secrets.
Never commit their values to this repository:

- `FIREBASE_PROJECT_ID` — plain variable.
- `FIREBASE_SERVICE_ACCOUNT` — encrypted secret.

## Safety

This is a source-control copy of the current Worker, not a wallet backend.
It does not authenticate Firebase users, read/write Firestore wallet balances,
process deposits/withdrawals, execute trades, or maintain a transaction ledger.

Do not deploy this source over the production Worker as part of the wallet migration.
Extend and test it on an isolated Worker or test environment first. Production deployment
requires a separate explicit approval.
