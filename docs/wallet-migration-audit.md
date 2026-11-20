# Wallet migration audit — staging only

## Safety constraints
- This branch is `fix/canonical-wallet-worker-migration`.
- Do not deploy, merge, publish Firestore rules, or change production balances as part of this work.
- Preserve every existing wallet/profile balance and historical record. No automatic migration, reset, seed, merge, or overwrite.
- Do not let browser local storage or browser-supplied trade results become an authoritative balance source.

## Existing data conflict requiring reconciliation
The previously inspected account has:
- `userTradeState/{uid}.balance`: 61,430.07 USDT
- `users/{uid}.demoBalanceUSDT`: 55,182.14 USDT
- Difference: 6,247.93 USDT

These values are conflicting records, not proof that either value is correct. Preserve both until the complete ledger and admin activity are reconciled. Do not use either field to overwrite the other.

## Confirmed frontend write paths in public/index.html
1. `window.ocPersistTradeState` writes `userTradeState/{uid}` directly with `setDoc(..., {merge:true})`.
2. `restoreCloudTradeState` reads `userTradeState`, but when that document is missing it can seed it from local state and/or `users.demoBalanceUSDT`. This is unsafe for a migration because a missing canonical document must fail closed, not infer a balance.
3. `syncAdminDemoBalance` listens to `users/{uid}` and copies changed `demoBalanceUSDT` into client wallet state through `ocApplyAdminDemoBalance`. This creates a competing balance source.
4. `ocApplyAdminDemoBalance` changes client state and calls `saveState()`.
5. `executeBuyHoldOrder` mutates balance and holdings in the browser, then persists the entire wallet state.
6. Timed trade settlement sends browser-computed `adjustment` and `resultRecord` to `ocCommitQuickTradeResult`. Browser-calculated PnL/outcome cannot be trusted by a wallet backend.
7. `processDemoRequest` is a client Firestore transaction that approves deposits/withdrawals and writes wallet/profile balances and ledgers.
8. The app contains an old local-storage migration block that subtracts 10,000 from `state.balance` for browsers carrying `oc_demo_credit_10000_v1`. This must be reviewed and removed safely as part of migration; do not execute it against real wallet state.

## Security rules status
The current `userTradeState/{uid}` rules allow owners to create/update their own balance, holdings, and history. This is not safe for a canonical wallet. The final rule should make client access read-only, with all mutations performed by a trusted backend service account. Do not publish that rule change until every frontend write path has been migrated and tested, otherwise current wallet actions will break.

## Required migration sequence
1. Build a read-only reconciliation/audit path that can compare profile balance, canonical balance, and ledger evidence without modifying any documents.
2. Define and test a single canonical wallet document and append-only ledger contract. Missing or inconsistent records must fail closed.
3. Implement authenticated Cloudflare Worker endpoints with Firebase ID-token verification, server-side admin authorization, Firestore REST transactions/preconditions, idempotency, and append-only ledger entries.
4. Migrate each frontend mutation path to Worker calls. Remove competing profile-balance synchronization and local-storage seeding/subtraction behavior without changing existing displayed funds.
5. Migrate admin approvals, internal transfers, trades, buys/sells/conversions, and withdrawals to the same backend ledger.
6. Update Firestore rules and tests only after all client writes are gone.
7. Test duplicate requests, concurrent spends, invalid tokens, non-admin access, missing wallet docs, offline/reconnect behavior, and multiple devices.
8. Review the complete staging diff and test results. Production merge/deploy requires separate explicit approval.

## Current state
This audit records verified code paths only. It does not change user data, published rules, or the live platform. No wallet migration or balance correction is performed by this document.

## Staged implementation status — review only, not production-ready

The current branch now contains a first frontend/admin source-of-truth pass:

- `public/index.html` no longer initializes the customer wallet from `localStorage.oc_demo_state`, subtracts the old local $10,000 grant, or imports balances from `users.demoBalanceUSDT` / `users.demoAssetBalances`.
- Customer wallet loading now reads `userTradeState/{uid}` only. A missing or unconfirmed Firestore wallet fails closed; it is not silently created or seeded from another source.
- The in-app admin user balance panel reads the canonical wallet only.
- `public/admin.html` deposit/withdrawal approvals, manual admin balance adjustments, internal transfer approvals, and dashboard totals now target `userTradeState/{uid}`.
- The destructive admin wallet-reset control was removed from the finance screen.
- Firestore rules in this branch allow the verified admin role to write canonical wallet documents so these staged admin flows can be tested. Account owners still have write permission because existing customer trade flows still write from the browser.

**Remaining production blockers:**

- The customer browser still writes wallet state directly through `ocPersistTradeState`, buy/sell actions, and timed trade settlement. A customer can therefore still tamper with their own wallet document under the current rules.
- The Cloudflare Worker remains read-only reconciliation code. It is not yet a trusted wallet mutation API.
- Conversions, other customer balance-changing paths, and all admin balance operations must be moved behind authenticated, idempotent server-side ledger operations before owner write access is removed.
- Missing or conflicting legacy records still require a reviewed reconciliation/migration. This code does not migrate or change Firestore customer data.

Do not merge or deploy this branch, deploy its Firestore rules, or treat its balances as production-safe until those blockers are completed and tested. No Firestore customer balance documents were changed by these GitHub edits.
