# Read-only wallet reconciliation Worker

This Worker is for a separate staging deployment. It authenticates a Firebase administrator, reads selected Firestore records, and returns a compact reconciliation report. It does not call Firestore create, update, delete, or commit endpoints and does not return raw wallet history or transaction documents.

## Required Cloudflare configuration

Set these on the staging Worker only:

- `FIREBASE_PROJECT_ID`: `onchaincrypto-d976b` (plain-text variable; the source currently pins this project ID and verifies the service-account project).
- `FIREBASE_SERVICE_ACCOUNT`: service-account JSON as a Worker secret. Never put this value in source control, browser code, or chat.
- `ADMIN_EMAILS`: comma-separated, exact administrator email addresses. An email is accepted only when the Firebase ID token says `email_verified: true`. A Firebase custom claim `admin: true` is also accepted.
- `ALLOWED_ORIGINS`: exact comma-separated staging origins only. Do not add the live website unless there is a deliberate, separately approved reason.

The source currently uses the fixed project ID `onchaincrypto-d976b`; the `FIREBASE_PROJECT_ID` variable is informational until the source is deliberately changed to read it.

## Service-account permissions

Use a dedicated service account for this Worker. Grant the least privilege needed for reading Firestore (prefer the Firestore/Datastore Viewer role). Do not grant editor/owner permissions. If the account currently has broader permissions, reduce them before adding its key to the staging Worker. The source makes read requests only, but IAM read-only permissions provide an additional safeguard.

## Routes

- `GET /health`: returns only a small health/mode response; it does not test Google credentials or Firestore access.
- `POST /admin/reconcile`: requires `Authorization: Bearer <Firebase ID token>` and JSON body `{"uid":"target-user-uid"}`. It returns balances, timestamps, ledger continuity checks, and evidence counts.

The target UID can differ from the signed-in administrator UID only when the verified token is authorized as an administrator.

## Data sources and limits

Reads:
- `users/{uid}`
- `userTradeState/{uid}`
- `demoTransactions` filtered by `uid`
- `demoAssetTransactions` filtered by `uid`
- `internalTransfers` filtered by `senderUid` and `recipientUid`
- `depositRequests` and `withdrawRequests` filtered by `uid`
- `internalTransferRequests` filtered by sender and recipient UID

Each collection query is capped at 500 records. The response explicitly warns that older records may be omitted. Request documents and asset-ledger counts are context only; they are not treated as completed balance changes. A balance difference does not establish which balance is correct.

## Safety

- No balances are selected, merged, seeded, adjusted, or modified.
- No client-supplied balance, PnL, trade result, or adjustment is accepted.
- Do not publish restrictive Firestore rules or migrate frontend writes as part of this read-only audit.
- Do not deploy this code to the existing `onchaincrypto-deposit-verifier` Worker.
- Keep the staging Worker separate and verify code before adding credentials.
- Never paste a Firebase ID token, service-account JSON, or private key into chat.

## Tests

Run:

```sh
npm run test:reconciliation
```

The unit tests use synthetic fixtures only and do not read or write Firebase data.
