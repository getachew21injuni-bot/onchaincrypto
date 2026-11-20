# Wallet migration audit

> Chronological note: the initial findings below describe the pre-migration baseline. Later dated sections at the end of this document record the implemented changes and supersede earlier statements about direct browser writes and legacy profile-balance reads.
 — staging only

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


## Backend replacement preparation — 2026-11-20

A separate Cloudflare Worker folder, `workers/wallet-api-v2/`, is being prepared as the replacement wallet API. It has its own `wrangler.toml`; it does not overwrite the existing deposit-verifier Worker or the read-only reconciliation Worker. No Cloudflare deployment has been performed.

Current v2 implementation:
- Authenticated read of `userTradeState/{uid}` only.
- A narrowly scoped administrator USDT adjustment route with an existing-wallet requirement, wallet update-time precondition, and create-only `walletLedger/{requestId}` record.
- Firebase ID-token verification and a dedicated service-account secret contract.
- No automatic profile/demo balance fallback, wallet seeding, or customer-data migration.

Newly documented product rules that the backend must enforce:
- Quick Trade is demo USDT only; simulated profit is not withdrawable.
- Outcome controls are server-side. The browser must not submit a trusted outcome or P/L.
- Admin-configured win/loss percentages and the previously specified 10-minute inactivity rule must be evaluated server-side and written to an auditable ledger.
- Coin quantities must be preserved; USDT-equivalent display valuation must use trusted prices, not browser-supplied prices.

**Still not complete:** customer buy/sell and timed-trade settlement, conversion, deposit crediting, withdrawal reservation/approval/payout, internal transfers, admin approvals/adjustments integration, full client migration, and final read-only Firestore rules. The staged v2 Worker is not yet a full backend replacement and must not be connected to the live frontend or deployed as production.

A syntax-only npm command has been added: `npm run check:wallet-api-v2`. It has not yet been run in this environment. No integration tests have been run. The Worker service account, IAM permissions, exact Firestore schema, price source, and chain payout verification still require staging validation.

No customer Firestore documents, balances, profile fields, or historical ledgers were modified by these GitHub commits. No merge, production deployment, Worker deployment, or Firestore rules deployment was performed.


## Trusted admin wallet routes — implementation update 2026-11-20

The isolated `workers/wallet-api-v2/index.js` now includes these server-side routes:

- `GET /v1/wallet`: authenticated canonical wallet read.
- `POST /v1/admin/adjust-usdt`: idempotent USDT adjustment.
- `POST /v1/admin/adjust-assets`: atomic one-or-many asset adjustment, canonical wallet update, append-only `walletLedger` rows, and a user notification.
- `POST /v1/admin/review-request`: admin approval/rejection for a deposit or withdrawal request. Approval updates the canonical wallet, request status, and wallet ledger atomically.
- `POST /v1/admin/review-transfer`: admin approval/rejection for internal USDT transfers. Approval updates both canonical wallets, request status, transfer record, and both ledger legs atomically.

The customer page's embedded deposit/withdrawal review handler and the Admin dashboard's deposit/withdrawal review, internal transfer approval, and manual finance adjustment handlers now call these Worker routes instead of directly changing wallet balances. The Admin finance history view now reads the canonical `walletLedger` collection. Firestore rules grant users/admins read access to their allowed ledger rows and deny client ledger writes.

A unit-test file and a GitHub Actions workflow were added for Worker primitives. The workflow run has not yet appeared in the repository's Actions API, and tests have not been executed in this environment.

**Still not production-complete:** customer Buy/Sell, Buy & Hold, timed Quick Trade start/settlement, and Convert still contain browser-side wallet mutation paths. Customer internal-transfer request creation remains a direct request-only write (it does not alter balances). Final `userTradeState` client write denial must wait until all customer wallet mutation paths have been moved behind the Worker and tested. The Worker URL is intentionally not configured in either frontend yet; these new admin calls fail closed until Cloudflare staging is deployed and its URL is configured.

No customer balances or Firestore documents were changed. No Firestore rules were deployed. No Cloudflare Worker was deployed. No merge to `main` or production deployment occurred.


## Customer wallet mutation migration — 2026-11-20

The current branch has now moved these customer operations behind `workers/wallet-api-v2`:

- Simple Buy/Sell orders.
- Buy & Hold orders.
- Asset conversion (0.1% fee calculated by the Worker).
- Timed Quick Trade start and settlement. Entry/exit prices, admin outcome mode, expiry and P/L are server-controlled. Active trades are stored in Firestore and can be recovered after refresh.
- The legacy browser functions that wrote complete wallet snapshots and browser-computed Quick Trade results now reject instead of writing.

The Admin dashboard's deposit/withdrawal approvals, internal transfer approvals and manual multi-asset adjustments now call the Worker. The embedded admin request review handler does the same. Admin finance history reads the canonical append-only `walletLedger`.

The branch's Firestore rules now make `userTradeState/{uid}` client-read-only, deny client writes to `walletLedger`, and deny client writes to `internalTransfers`. Legacy profile balance fields and old profile-based internal-transfer checks were removed from the active rules. Existing `users/{uid}` profile documents and historical `demoTransactions` / `demoAssetTransactions` records were not deleted.

**Still required before production cutover:**
1. Run the new unit tests and perform real staging integration tests against a staging Firestore database and Cloudflare Worker.
2. Review the Worker implementation and quote-provider availability/rate limits. CoinGecko and Binance are the current server-side quote sources.
3. Deploy the isolated Worker to Cloudflare staging, configure its service-account secret, exact allowed origins and admin allowlist, then set `window.ONCHAINSPRO_WALLET_API_URL` in both frontend pages.
4. Verify every customer and admin workflow end to end, including retries, concurrent orders, active Quick Trade recovery, admin adjustments, deposit/withdrawal request review and internal transfers.
5. Only after staging verification, plan the coordinated production cutover: Worker first, frontend URL/config, then read-only Firestore rules. Do not deploy the rules alone.
6. External blockchain deposit verification and withdrawal payout are separate systems and are not implemented by these internal account-ledger endpoints.

No customer wallet balances, user profiles or historical records were migrated or changed by these GitHub edits. No Firestore rules were deployed, no Cloudflare Worker was deployed, no merge to `main`, and no Firebase Hosting deployment occurred.


## Legacy reconciliation reader cleanup — 2026-11-20

The existing read-only `workers/wallet-api` reconciliation endpoint was also updated. It no longer reads `users/{uid}.demoBalanceUSDT`, `demoAssetBalances`, `demoTransactions`, or `demoAssetTransactions`. It reads the canonical `userTradeState/{uid}`, `walletLedger`, transfer records and pending request records only. Its report now identifies `userTradeState/{uid}` as the only wallet balance source and groups ledger continuity checks by asset.

This legacy Worker remains read-only; it does not write balances. The new v2 Worker is the sole wallet mutation service in the migration branch. Do not deploy both as competing wallet writers. The legacy reconciliation route may remain temporarily as a read-only audit endpoint until the v2 Worker is staged and the old Cloudflare service is safely retired.
