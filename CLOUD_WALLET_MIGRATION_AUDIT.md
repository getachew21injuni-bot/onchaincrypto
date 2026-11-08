# Cloud wallet migration — audit and safe implementation plan

Status: preparation only. This branch is not deployed. No customer data, balances, Firestore rules, or production services have been changed.

## Audit findings (2026-11-08)

- `public/index.html` initializes wallet state from `localStorage.oc_demo_state` with `balance`, `holdings`, and `history`.
- `saveState()` writes that state back to local storage. Trade execution currently mutates this in-memory state and then calls `saveState()`; the browser is therefore still authoritative for those displayed balances and trade records.
- Activity history is stored in `localStorage.oc_activity_history`.
- Conversion history is stored in `localStorage.oc_convert_history`; conversion execution mutates local wallet state and saves it locally.
- A legacy routine removes an old $10,000 credit from local browser state when `oc_demo_credit_10000_v1` is present. This must be audited and retired only after a safe, user-approved reconciliation; it must not run against migrated cloud balances.
- Firestore currently stores some administrator balance fields under `users/{uid}`. A client-side `onSnapshot` reads those fields and applies them to the displayed local wallet. This is not a complete cloud wallet or a customer trade ledger.
- Existing `demoTransactions` and `demoAssetTransactions` collections record administrator deposit/withdrawal adjustments. Existing entries must be preserved and included in migration/reconciliation.
- Firestore rules permit the verified administrator to update selected balance fields. Customer browser code must not be granted arbitrary balance-write permission.
- Existing Cloudflare Worker source/configuration is not present in this repository. The repository contains no wallet-worker endpoint or Wrangler configuration. The currently connected GitHub repository therefore cannot establish the deployed Worker routes, bindings, or secrets.

## Required design

1. Treat Firebase Auth UID as the permanent owner key.
2. Make a trusted Cloudflare Worker the only writer for wallet-changing operations. Verify the Firebase ID token on every request; never trust a UID supplied by the browser.
3. Commit balance changes and immutable ledger entries atomically in Firestore. Use idempotency keys to prevent duplicate trade, conversion, deposit, withdrawal, and retry operations.
4. Validate asset, side, quantity, amount, price source, account status, minimums, available funds, and allowed precision on the server. Client-supplied balances are never accepted.
5. Read the authoritative wallet from Firestore on sign-in and subscribe to cloud changes. Local storage may be retained temporarily as a display cache only; it must never authorize or calculate a committed balance.
6. Show a success notification only after the Worker confirms the Firestore commit. Pending, rejected, and failed operations must remain distinct.
7. Keep market cache, watchlist, and UI preferences local. Never store passwords, verification codes, private keys, recovery phrases, or service-account secrets in browser storage or public source.

## Safe rollout sequence

- Phase A: obtain and inspect the deployed Cloudflare Worker source/configuration and identify the exact Firebase project, Worker URL, bindings, and secrets. Do not expose secret values in GitHub or chat.
- Phase B: document the current wallet schemas and take a verified backup/export of Firestore records and a local-state export for each test account. Do not alter the old $10,000 cleanup marker during backup.
- Phase C: implement and test Worker endpoints and Firestore transaction rules in an isolated test project/account. Test concurrent writes, duplicate requests, retries, insufficient balances, invalid values, and cross-user access.
- Phase D: build a dry-run reconciliation that compares existing local state, `users/{uid}`, `demoTransactions`, and `demoAssetTransactions`. Report discrepancies; do not choose or overwrite a balance automatically.
- Phase E: switch one test account to cloud reads/writes, verify the same state on two devices, then expand gradually. Keep a rollback path and retain legacy records.
- Phase F: only after test evidence and explicit approval, deploy the frontend and production Worker. Firebase Hosting-only deployment does not deploy the Worker or Firestore rules.

## Cost and deployment boundary

- No Firebase billing-plan change is part of this plan.
- Firestore reads/writes and Cloudflare Worker requests are still subject to their respective quotas and pricing.
- No Firebase Functions deployment is proposed.
- No production deployment, Firestore rules change, balance migration, or deletion is authorized by this preparation document.
