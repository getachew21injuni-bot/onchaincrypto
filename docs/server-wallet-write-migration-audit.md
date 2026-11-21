# Server-authoritative wallet migration audit

Branch: `feature/firestore-server-trades`

## Direct client write paths identified (must migrate before Firestore write rules are tightened)

- `saveState(persistCloud=true)`: writes a local display cache, then delegates to `window.ocPersistTradeState`, which currently calls Firestore `setDoc(userTradeState/{uid}, ...)` directly from the browser.
- `doTrade(side)`: regular spot buy/sell changes `state.balance`, `state.holdings`, and `state.history`, then calls `saveState()`. This is a client-calculated order and wallet mutation.
- `executeBuyHoldOrder(side)`: Buy & Hold order changes the same state and calls `saveState()`.
- `restoreCloudTradeState(user)`: when the cloud wallet document is missing, it can seed from local device state via `window.ocPersistTradeState()`; this is an unsafe migration authority for multi-device accounts and must be replaced by an explicit server-side migration policy.
- `ocApplyAdminDemoBalance(amount)` / `ocApplyAdminDemoAssets(balances)`: apply admin profile values to wallet state and call `saveState()`. The source admin settings are read from the user's Firestore document, but the resulting wallet write is still client-side and must be replaced by a server-authorized operation.

## Required next changes

1. Add authenticated Worker endpoints for server-priced spot Buy/Sell and Buy & Hold order execution. Validate symbol, amount, quote, available USDT/asset holdings, and write wallet plus ledger atomically.
2. Add an admin-only server endpoint for applying demo-balance and asset settings. Authenticate by verified UID and server-side admin allowlist; never accept a client-supplied admin flag.
3. Define a safe missing-wallet migration. Do not automatically upload arbitrary local state. Preserve the current canonical Firestore wallet when present; require an explicit policy for first-time migration/initialization.
4. Update front-end flows to call the Worker, refresh the canonical wallet, and treat localStorage as a non-authoritative cache only.
5. Audit deposit, withdrawal, conversion, and transfer handlers for any direct `userTradeState` writes before rules changes.
6. Add tests for concurrent orders, insufficient balance, invalid symbols, quote failure, idempotency, and admin authorization.
7. Only after all writes are migrated, tighten Firestore rules for wallet/trade collections.

## Status

This audit is committed to the feature branch as documentation only. No production deployment or Firestore rules change was made.

## Additional frontend audit (2026-11-21)

Further inspection of `public/index.html` found these additional wallet-sensitive paths:

- `processDemoRequest(kind, requestId, decision)` runs a browser Firestore transaction for admin deposit/withdrawal approval. It updates `userTradeState/{uid}`, profile balance/asset fields, request status, and demo ledgers. The transaction is atomic at Firestore level, but wallet authority and admin approval are still implemented in the browser; move this operation behind a verified server-side admin endpoint before making wallet documents server-only.
- Withdrawal submission checks the displayed wallet balance and pending withdrawal requests in the browser, then creates `withdrawRequests`. This is a request-only action (no immediate debit), but the reservation check is not a server-enforced atomic reservation; concurrent submissions can over-reserve the same funds.
- Conversion currently changes local displayed balances/history and calls `saveState()`; it is not a server-priced atomic wallet conversion and must be migrated before describing it as a canonical wallet transaction.
- Internal transfer submission creates a pending `internalTransferRequests` record and explicitly does not change balances. The inspected frontend contains request/history listeners but no matching approval executor in this file; locate the actual admin approval path and migrate it before enabling balance transfers.
- Deposit approval copy explicitly states that approval changes the internal account ledger only and does not verify an on-chain deposit. This distinction must remain clear until an independent chain-verification flow is implemented.

## Migration order (updated)

1. Define the canonical wallet schema and server-side transaction/ledger conventions.
2. Migrate spot Buy/Sell and Buy & Hold to authenticated server endpoints with server quotes, atomic wallet updates, idempotency keys, and exposure checks against active Quick Trades.
3. Migrate admin USDT and asset balance changes, including deposit/withdrawal request review, to server-verified admin routes. Preserve pending-request status guards and write request status + wallet + ledger atomically.
4. Migrate conversion and identify/migrate the actual internal-transfer approval handler. Withdrawal requests need server-side reservation checks so multiple pending requests cannot exceed available funds.
5. Replace first-login local-device wallet seeding with an explicit, audited initialization/migration policy. Do not overwrite an existing canonical Firestore wallet.
6. Run end-to-end concurrency, authorization, idempotency, insufficient-balance, and regression tests.
7. Only then tighten Firestore rules and activate the new frontend/Worker together.

No production deployment, merge, or Firestore rules change was made during this audit.
