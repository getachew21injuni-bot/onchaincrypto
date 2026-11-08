# OnChainCrypto Wallet API (isolated development worker)

This is a separate Worker from the existing production `onchaincrypto-deposit-verifier`.
It must be deployed as a new, non-production Cloudflare Worker for testing only after its
transaction engine and test suite are complete.

## Current stage

- Restricts browser origins to the current Firebase Hosting origins and the planned custom domain.
- Verifies Firebase ID tokens using Google's published Secure Token signing keys.
- Exposes a health endpoint.
- Defines wallet operation and trade execution routes, but both fail closed with
  `BACKEND_NOT_READY`. They do not write Firestore or alter balances.
- Does not change the existing deposit-verifier Worker.

## Required runtime settings

- `FIREBASE_PROJECT_ID`: `onchaincrypto-d976b`.
- `FIREBASE_SERVICE_ACCOUNT`: existing service-account JSON as an encrypted Cloudflare secret.
  Never paste the secret into chat or commit it to GitHub.

## Next implementation stage

Implement service-account OAuth token exchange and Firestore REST transaction handling.
The wallet operation must atomically write the authoritative wallet account, immutable
wallet ledger row, and idempotency record. Trade settlement must atomically write the
account changes, trade ledger row, wallet settlement rows, and idempotency record.

Before any production use, add automated tests for token verification, cross-user isolation,
duplicate idempotency keys, concurrent balance changes, insufficient funds, malformed
amounts, and Firestore transaction failures.

No Firestore collection is created by this scaffold. No balance or history is migrated.
No existing Worker, frontend, Firestore rules, or production service is changed.
