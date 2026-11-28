# OnChainSpro Wallet API v2

This is a separate Cloudflare Worker. It does not replace or modify `onchaincrypto-deposit-verifier`.

## Scope

- Authenticates Firebase ID tokens.
- Reads the existing canonical wallet at `userTradeState/{uid}`.
- Reads append-only wallet activity from `walletLedger`.
- Performs server-priced wallet buy/sell orders and asset conversions.
- Supports administrator deposit/withdrawal request review, internal transfers, and audited asset adjustments.
- Uses Firestore update-time preconditions and create-only ledger records to reduce duplicate or conflicting balance mutations.

## Explicit exclusions

This Worker has **no Quick Trade routes or Quick Trade settlement code**. Do not route existing Quick Trade start/settlement calls to this Worker. The user's established investment/settlement workflow remains separate and unchanged.

This Worker does not automatically monitor or independently verify on-chain deposits and does not broadcast/pay external blockchain withdrawals. For a customer deposit, an administrator must independently inspect the transaction on the correct blockchain explorer (asset/token, network, destination, amount and confirmations) before entering a review note and approving it. The approval credits the internal wallet once; it is not proof supplied by the Worker that the blockchain transfer is valid. Keep the existing `onchaincrypto-deposit-verifier` Worker unchanged.

## Cloudflare setup

Worker name: `onchainspro-wallet-api-v2`

Set the non-secret variable:
- `ALLOWED_ORIGINS`: exact website origins listed in `wrangler.toml`.

Add secret through Cloudflare Dashboard or Wrangler:
- `FIREBASE_SERVICE_ACCOUNT`: service-account JSON for project `onchaincrypto-d976b`.

Optional variable:
- `ADMIN_EMAILS`: comma-separated exact, verified administrator email addresses, only if Firebase custom admin claims are not used.

Never paste service-account JSON into GitHub, source code, or chat. Use a dedicated service account with only the Firestore data permissions required (normally the Firestore/Datastore user role); do not grant Project Editor or Owner.

## Routes

- `GET /health`
- `GET /v1/wallet`
- `GET /v1/wallet/ledger`
- `POST /v1/wallet/order`
- `POST /v1/wallet/convert`
- `POST /v1/wallet/deposit-request` — authenticated customer submission; the Worker validates the admin-published asset/network/address, creates one pending request per network/TXID, and never credits the balance.
- `POST /v1/admin/review-request` — verified admin approval/rejection; approval atomically updates the existing canonical wallet, request status, append-only wallet ledger, user notification and admin audit record. Deposit approval requires an admin verification note.
- `POST /v1/admin/review-transfer`
- `POST /v1/admin/adjust-assets`
- `POST /v1/admin/adjust-usdt`

All routes except `/health` require a valid Firebase ID token. Admin routes require `admin: true` in Firebase custom claims or a verified email listed in `ADMIN_EMAILS`.

## Deployment

Do not deploy or connect this Worker to the live app until the code and existing Firestore data shape have been reviewed and tested.

From this folder:

```sh
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
npx wrangler deploy
```

The deployment command creates/updates only `onchainspro-wallet-api-v2`; it does not change the existing deposit-verification Worker.

## Data safety

Canonical wallet: `userTradeState/{uid}`. The Worker never creates a missing wallet and never reads `users/{uid}.demoBalanceUSDT` or browser local storage as a balance source. It preserves the current wallet balance, holdings, and history when updating.

Ledger: `walletLedger/{transactionId}`, append-only and create-only.

Before production connection, reconcile any duplicate or conflicting historical balance sources. Test token verification, admin permissions, duplicate request IDs, concurrent writes, Firestore permissions, and the live app's exact request/response contract. Withdrawal approval in this Worker is an internal account adjustment only; it does not send blockchain funds.
