# Wallet API v2 — isolated staging implementation

This Worker is a staged replacement candidate for OnChainSpro's wallet mutation backend. It is the only wallet mutation service in this migration branch. The older `workers/wallet-api` service is now read-only reconciliation against the same canonical wallet and ledger; it is not a second balance writer and should be retired after the v2 staging cutover. It is deliberately isolated from production: it has its own Wrangler name and is not wired to the live customer or admin pages. It does not overwrite `onchaincrypto-deposit-verifier` or `workers/wallet-api/index.js`.

## Implemented routes

- `GET /health`: reports staged mode only.
- `GET /v1/wallet`: verifies a Firebase ID token and reads only `userTradeState/{authenticated uid}`. A missing wallet returns 404; it is never seeded.
- `GET /v1/quick-trade/active`: recovers the signed-in user's active server-side timed trade after refresh/reconnect.
- `POST /v1/wallet/order`: server-priced Buy/Sell and Buy & Hold orders. The Worker computes quantity and price and updates the canonical wallet and ledger.
- `POST /v1/wallet/convert`: server-priced asset conversion with the existing 0.1% fee. The Worker calculates output and updates the canonical wallet and ledger.
- `POST /v1/quick-trade/start`: server validates balance, trade level, controls and entry price, then creates a server-owned active trade.
- `POST /v1/quick-trade/settle`: server enforces expiry, obtains its own exit quote, computes P/L, updates the wallet, records the result and closes the active trade. Client-supplied P/L and prices are not accepted.
- `POST /v1/admin/adjust-usdt`: verified admin adjustment against an existing canonical wallet. Uses a wallet update-time precondition and create-only `walletLedger/{requestId}`.
- `POST /v1/admin/review-request`: admin approves/rejects a pending deposit or withdrawal request. Approval changes the canonical wallet, request status, and append-only `walletLedger` record in one Firestore commit. It records an internal account adjustment only; it does not verify an on-chain deposit or pay an external withdrawal.
- `POST /v1/admin/adjust-assets`: atomically applies an admin deposit/withdrawal adjustment across one or more assets, creates one append-only ledger row per asset, and writes a user notification.
- `POST /v1/admin/review-transfer`: admin approves/rejects an internal USDT transfer. Approval atomically debits and credits the two canonical wallets, updates the pending request, creates the `internalTransfers` business record, and creates sender/recipient entries in `walletLedger`.

All admin routes require a Firebase ID token with `admin: true`, or a verified email included in the Worker's `ADMIN_EMAILS` variable. All wallet updates use Firestore update-time preconditions. Ledger writes are create-only, so duplicate request IDs cannot silently apply a second credit/debit.

## Cutover prerequisites — do not connect to production

Customer and admin wallet mutation paths in the current branch have been switched to the trusted Worker, and `userTradeState/{uid}` is client-read-only in the branch's Firestore rules. Customer deposit/withdrawal request submission and internal-transfer request creation remain client writes to request documents only; they do not change balances. External deposit verification and actual blockchain withdrawal payout are not implemented by these account-adjustment routes.

The frontend Worker URL is intentionally not configured yet. Until the Worker is deployed to Cloudflare staging and its URL is set in `window.ONCHAINSPRO_WALLET_API_URL`, wallet-changing actions fail closed. Do not deploy the read-only wallet rules to production before the Worker is available and the frontend points to it.

## Cloudflare staging configuration

The isolated Wrangler config names this Worker `onchainspro-wallet-api-v2` and uses `workers_dev = true`. It has no production route or custom-domain binding.

For a later staging deployment, configure:
- `ALLOWED_ORIGINS`: only the exact staging website origin(s).
- `ADMIN_EMAILS`: exact verified admin email(s), if custom Firebase admin claims are not used.
- Secret `FIREBASE_SERVICE_ACCOUNT`: a dedicated service-account JSON for project `onchaincrypto-d976b`.

Never commit or paste the service-account JSON into GitHub or chat. Grant the service account only the Firestore data permissions required by the Worker. Do not grant Project Editor or Owner. Do not reuse a broad production secret without reviewing its IAM permissions.

Staging deployment commands, to be run only after the backend and frontends are complete and tested:

```sh
cd workers/wallet-api-v2
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
npx wrangler deploy
```

These commands have not been run. No Cloudflare Worker has been deployed by this change.

## Canonical wallet and ledger contract

Canonical wallet: `userTradeState/{uid}`
- `uid`: string
- `balance`: numeric USDT balance
- `holdings`: map of asset symbols to quantities
- `history`: retained snapshot history (legacy display contract)
- `updatedAt`: timestamp

Append-only wallet ledger: `walletLedger/{transactionId}`
- Records UID, operation type, asset, amount, before/after balances, actor, request ID and timestamp.
- IDs are deterministic for admin request reviews and transfer legs; writes are create-only.

The Worker never reads `users/{uid}.demoBalanceUSDT` or local storage as a wallet source. It never creates a missing wallet and never reconciles conflicting balances automatically. Existing conflicting wallet/profile values and legacy history collections must be preserved until separately reviewed.

## Quick Trade rules to enforce when implemented

- Quick Trade settles internal account P/L in USDT; it does not place external exchange orders or send blockchain funds.
- The browser must never submit an authoritative outcome or P/L.
- Admin-configured trade controls must be evaluated server-side.
- The previously specified inactivity behavior (10 minutes inactive: 25% win / 75% loss) must only be implemented if confirmed as part of the current product logic; it must not be guessed.
- Every result must be auditable with the applied control, stake, trusted quote/reference, result and before/after balances.
- Holdings remain per-asset quantities. USDT-equivalent valuations must use a trusted quote source, not browser prices.

## Validation status

Unit tests have been added for Firestore value encoding/decoding, document ID validation, admin authorization decisions, wallet update preconditions and create-only ledger writes.

Run from the repository root:

```sh
npm run test:wallet-api-v2
```

The tests have been added but have not yet been executed in this environment. They are unit tests for serialization, authorization and write preconditions, not end-to-end Firestore or Cloudflare integration tests. Before deployment, still test forged/expired tokens, role enforcement, duplicate requests, missing wallet documents, concurrent wallet writes, Firestore REST preconditions, atomic failure behavior, and real staging data shapes.
