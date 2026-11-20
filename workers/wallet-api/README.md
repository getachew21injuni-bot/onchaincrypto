# Read-only wallet reconciliation helper

This module is deliberately read-only. It accepts already-authorized Firestore records and creates a comparison report; it does not connect to Firestore, update documents, choose a canonical balance, or infer a deposit from a request.

## Data to collect for one UID

Collect through an authenticated administrator-only backend read (not from the browser):
- `users/{uid}` — `demoBalanceUSDT`, `demoBalanceUpdatedAt`, `demoAssetBalances`, `adminUpdatedAt`, `adminUpdatedBy`
- `userTradeState/{uid}` — `balance`, `holdings`, `history`, `updatedAt`
- `demoTransactions` filtered by `uid`
- `demoAssetTransactions` filtered by `uid`
- `internalTransfers` where `senderUid == uid` OR `recipientUid == uid`
- `internalTransferRequests` where sender or recipient matches (requests are context only)
- `depositRequests` and `withdrawRequests` filtered by `uid` (requests are not completed ledger entries)

Also inspect any separate admin adjustment records and any trade ledger collection that exists in the project. Do not assume a collection is complete merely because it exists.

## Report interpretation

- `canonicalMinusProfileUSDT` is a comparison only; it does not declare the canonical wallet correct.
- A continuity break means adjacent balance snapshots do not join. It may indicate missing entries, independent edits, or mixed balance sources.
- Missing snapshots cannot be reconstructed safely from amounts alone.
- Pending/approved request documents are not proof of chain settlement or external payout.
- Never add the two balances together. Never automatically copy one into the other.

## Run tests

`npm test`

The unit tests use synthetic fixtures only. They do not read or write production Firestore data.
