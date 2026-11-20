# Wallet API v2 — isolated staging implementation

This Worker is a staged replacement candidate for OnChainSpro's wallet mutation backend. It is deliberately isolated from production: it has its own Wrangler name and is not wired to the live customer or admin pages. It does not overwrite `onchaincrypto-deposit-verifier` or `workers/wallet-api/index.js`.

## Implemented routes

- `GET /health`: reports staged mode only.
- `GET /v1/wallet`: verifies a Firebase ID token and reads only `userTradeState/{authenticated uid}`. A missing wallet returns 404; it is never seeded.
- `POST /v1/admin/adjust-usdt`: verified admin adjustment against an existing canonical wallet. Uses a wallet update-time precondition and create-only `walletLedger/{requestId}`.
- `POST /v1/admin/review-request`: admin approves/rejects a pending deposit or withdrawal request. Approval changes the canonical wallet, request status, and append-only `walletLedger` record in one Firestore commit. It records an internal account adjustment only; it does not verify an on-chain deposit or pay an external withdrawal.
- `POST /v1/admin/adjust-assets`: atomically applies an admin deposit/withdrawal adjustment across one or more assets, creates one append-only ledger row per asset, and writes a user notification.
- `POST /v1/admin/review-transfer`: admin approves/rejects an internal USDT transfer. Approval atomically debits and credits the two canonical wallets, updates the pending request, creates the `internalTransfers` business record, and creates sender/recipient entries in `walletLedger`.

All admin routes require a Firebase ID token with `admin: true`, or a verified email included in the Worker's `ADMIN_EMAILS` variable. All wallet updates use Firestore update-time preconditions. Ledger writes are create-only, so duplicate request IDs cannot silently apply a second credit/debit.

## Not yet implemented — do not connect to production

Customer balance-changing paths are not yet migrated. The following still need trusted backend implementations and customer/admin frontend integration:

- Buy/sell and Buy & Hold orders.
- Timed Quick Trade start/settlement. The browser currently computes outcome and P/L; the server must instead own the trade record, trusted market quote, control settings, expiry and settlement.
- Asset conversion and fees.
- Customer deposit/withdrawal request submission and payout verification.
- Customer internal-transfer request creation.
- All remaining admin finance adjustments and request queue UI integration.
- Removal of every browser-side write to `userTradeState/{uid}`.
- Final Firestore rules that allow client reads but deny client wallet writes.

Do not tighten wallet rules before all direct customer/admin write paths have been migrated. Doing so would break existing flows. Do not merge or deploy this branch as a production cutover.

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

- Quick Trade is demo USDT only; simulated profit must not be withdrawable.
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

The tests have been added but have not yet been executed in this environment. They are unit tests for primitives, not end-to-end Firestore or Cloudflare integration tests. Before deployment, still test forged/expired tokens, role enforcement, duplicate requests, missing wallet documents, concurrent wallet writes, Firestore REST preconditions, atomic failure behavior, and real staging data shapes.
