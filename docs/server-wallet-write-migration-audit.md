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