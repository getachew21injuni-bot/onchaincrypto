# Wallet API v2 — isolated staging implementation

This directory is a separate Worker implementation. It does not replace `workers/wallet-api/index.js` (the existing read-only reconciliation Worker), and it is not wired into the customer website.

## Current routes

- `GET /health`: static mode response only.
- `GET /v1/wallet`: verifies a Firebase ID token and reads only `userTradeState/{authenticated uid}` using the Worker service account.
- `POST /v1/admin/adjust-usdt`: requires a verified Firebase ID token with custom claim `admin: true`, or a verified email in `ADMIN_EMAILS`. Applies a non-zero USDT adjustment to an existing canonical wallet and creates `walletLedger/{requestId}` in one Firestore commit. Uses the wallet document updateTime precondition and ledger create-only precondition. It never creates a missing wallet.

## Important implementation boundary

This is a staged foundation, NOT the completed wallet migration. Buy/sell, timed-trade settlement, conversions, internal transfers, deposit crediting, withdrawal reservation/payout, and their idempotency rules are not implemented here. The customer app still contains browser-side Firestore wallet writes in the migration branch. Do not connect this Worker to the live app, deploy it as the production API, or tighten Firestore rules until every balance-changing path is migrated and tested.

The admin adjustment route is included as a narrowly scoped first write path. Before enabling it, verify that the admin identity and adjustment workflow match the platform's actual authorization policy. A Firebase custom claim is preferred. Email allowlisting is a fallback and requires verified email.

## Cloudflare staging configuration

Create a NEW staging Worker; do not overwrite `onchaincrypto-deposit-verifier` or the existing reconciliation Worker.

Variables:
- `ALLOWED_ORIGINS`: exact staging origin(s), comma-separated. Do not add the production domain during staging.
- `ADMIN_EMAILS`: exact verified admin email(s), comma-separated; use custom admin claims where possible.

Secret:
- `FIREBASE_SERVICE_ACCOUNT`: JSON for a dedicated service account in project `onchaincrypto-d976b`. Never commit this JSON or paste it into chat.

IAM:
- This implementation reads and writes Firestore, so the service identity needs the minimum Firestore data read/write permissions required by the Firestore REST API. Do not reuse a broadly privileged key without reviewing its IAM roles first. Prefer a dedicated service account and a narrowly scoped custom role. Do not grant Project Editor or Owner.

## Data contract

Canonical wallet: `userTradeState/{uid}`
- `uid`: string
- `balance`: numeric USDT balance
- `holdings`: map of asset symbols to numeric quantities
- `history`: array (currently retained as stored; no client-supplied history is accepted by the adjustment route)
- `updatedAt`: timestamp

Adjustment ledger: `walletLedger/{requestId}`
- request ID is unique and create-only
- records UID, type, asset, amount, before/after USDT balances, reason, actor UID/email, and timestamp

Do not assume a missing wallet means zero. The API returns 404 and does not seed it. Do not reconcile profile/demo balances automatically. Existing conflicting records require a separately reviewed migration.

## Validation still required before any deployment

1. Run syntax and unit tests against this file in a Worker-compatible runtime.
2. Add tests for expired/forged tokens, non-admin access, missing wallet, negative resulting balance, duplicate request ID, concurrent wallet update, and atomic failure.
3. Confirm Firestore REST commit precondition behavior in a staging Firebase project/database.
4. Confirm Firestore field types and all existing wallet document shapes.
5. Implement server-side operation handlers for every balance-changing workflow.
6. Replace every customer and admin browser-side balance write with API calls.
7. Only after all paths are migrated, change Firestore rules to deny direct client writes to `userTradeState`.
8. Reconcile existing balances and ledgers with human review; never auto-select or overwrite a disputed balance.
9. Obtain explicit deployment approval before deploying anything.
