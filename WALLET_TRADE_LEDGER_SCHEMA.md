# Wallet and trade ledgers — schema proposal

Status: design only. This file does not create Firestore collections or write production data.

## Collections

Firestore creates a collection when its first document is written. The two collections below are intentionally separate:

- `walletLedger/{entryId}`
- `tradeLedger/{tradeId}`

Both are append-only. A correction is a new compensating entry; old ledger rows are never edited or deleted.

## Wallet ledger document

Required fields:

- `uid`: Firebase Auth UID derived from the verified ID token, never from client input.
- `operationId`: client-generated UUID used as the idempotency key; unique per user and operation.
- `type`: one of `deposit_credit`, `withdrawal_debit`, `transfer_in`, `transfer_out`, `trade_settlement`, `conversion`, `admin_adjustment`, `reversal`.
- `asset`: normalized asset symbol, for example `USDT`, `BTC`, `XAU`.
- `amount`: positive decimal string in the asset's smallest supported precision; never use floating-point arithmetic for ledger calculations.
- `direction`: `credit` or `debit`.
- `balanceBefore`, `balanceAfter`: decimal strings for the affected asset.
- `status`: `posted` only after the atomic commit; pending requests are stored separately until approved.
- `createdAt`: Firestore server timestamp.
- `source`: trusted server-defined source such as `worker`, `admin_review`, or `trade_engine`.
- `relatedId`: optional related request/trade ID.
- `metadata`: allowlisted, non-secret details only.

## Trade ledger document

Required fields:

- `uid`: derived from the verified Firebase ID token.
- `operationId`: idempotency key.
- `symbol`: canonical market pair.
- `side`: `buy` or `sell`.
- `orderType`: initially `market` or `limit` only if implemented and supported.
- `quantity`, `price`, `grossAmount`, `fee`, `netAmount`: decimal strings, not JavaScript floating-point values.
- `quoteSource`, `quoteTimestamp`: server-validated pricing provenance.
- `status`: `filled`, `rejected`, or `cancelled`; only completed fills affect wallet balances.
- `createdAt`: Firestore server timestamp.
- `settlementWalletEntryIds`: IDs of the wallet ledger entries created in the same atomic operation.
- `metadata`: allowlisted, non-secret details only.

## Balance and idempotency documents

- `walletAccounts/{uid}` (or a carefully versioned subcollection) stores authoritative per-user, per-asset available balances as decimal strings and a schema version.
- `operationKeys/{uid_operationId}` stores the result reference for idempotency. A retry with the same key returns the original result and must not post a second ledger entry.
- Existing `users/{uid}`, `demoTransactions`, and `demoAssetTransactions` remain untouched during the initial rollout. A separate reconciliation report maps old records to proposed cloud balances before any cutover.

## Atomic operation contract

For a wallet operation, the Worker must in one Firestore transaction:

1. Verify the Firebase ID token signature, issuer, audience, expiry, and UID.
2. Validate request shape, account state, asset precision, amount, authorization, and idempotency key.
3. Read the idempotency record and current wallet account.
4. Reject insufficient funds or invalid state without writing.
5. Write the updated account balance, immutable wallet ledger entry, and idempotency result together.

For a trade fill, the Worker must additionally validate the market quote and trade limits, then atomically write the updated asset balances, immutable trade ledger entry, corresponding wallet ledger settlement entries, and idempotency result. If any write fails, none of the transaction commits.

## Security boundaries

- Browser clients may read only their own ledger/account documents; they cannot create, update, or delete ledger entries or balances.
- Only the authenticated Worker service identity may write ledger and balance documents. Firestore Security Rules must explicitly deny client writes to these collections.
- Admin adjustments must use a separate authorized Worker route, verify admin claims server-side, require a reason, and create an immutable ledger entry.
- Do not store passwords, OTPs, access tokens, private keys, seed phrases, or service-account JSON in any ledger document.
- Do not use wildcard CORS in production; allow only the actual application origins.
- Do not store a floating-point balance as the authoritative amount.

## Rollout and acceptance checks

1. Implement schema validation and Worker handlers without changing existing frontend wallet behavior.
2. Test in an isolated test account/project: duplicate operation, simultaneous trades, insufficient funds, invalid asset/precision, expired token, cross-user access, Worker timeout/retry, and Firestore transaction failure.
3. Run a read-only reconciliation against existing account balances and transaction history. No automatic winner is selected when sources disagree.
4. Verify the same balance and ledger history on two separate devices.
5. Only after test evidence and explicit approval, cut over one test account, then stage production rollout.

No production collection is populated, no old record is migrated or deleted, and no production service is deployed by this schema proposal.
