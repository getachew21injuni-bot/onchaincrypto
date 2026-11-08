# OnChainCrypto backend starter (not deployed yet)

This repository now contains a Firebase backend scaffold. **Adding these files does not deploy or activate the backend.** The current GitHub Pages website remains a static frontend until the steps below are completed.

## What this scaffold includes
- Firebase Cloud Functions (2nd gen) starter using the Admin SDK.
- A callable `createSupportTicket` function that requires Firebase sign-in, validates inputs and writes a ticket to Firestore.
- App Check enforcement on that function.
- Firestore rules deny direct browser reads and writes by default.
- No payment, custody, live trading, withdrawal or balance-crediting endpoints.

## Before deployment
1. Install Node.js 20 LTS and the Firebase CLI from official sources:
   - https://nodejs.org/en/download
   - https://firebase.google.com/docs/cli
2. Open a terminal in this repository and run:
   ```bash
   npm install --prefix functions
   npm run --prefix functions build
   firebase login
   firebase use onchaincrypto-d976b
   ```
3. In Firebase Console, enable Firestore Database and review the billing plan required for Cloud Functions deployment. Do not change plans without checking the current costs.
4. Configure Firebase App Check for the website and verify it works before deploying functions with enforcement enabled. Official guide: https://firebase.google.com/docs/app-check/web/recaptcha-provider
5. Deploy rules first, then functions:
   ```bash
   firebase deploy --only firestore:rules
   firebase deploy --only functions
   ```
6. Confirm the deployed function and test only with a test account. The support function currently saves tickets; it does **not** send email notifications yet.

## Critical security limitations
- Never put service-account JSON, private keys, SMTP passwords, exchange API secrets, or other server secrets in `index.html`, GitHub Pages, or public GitHub files.
- Do not use browser/localStorage balances as real balances.
- Do not accept deposits or enable withdrawals/live orders until you have a secure ledger, idempotent payment confirmation, access control, fraud monitoring, backups, logging, legal/compliance review and independent security testing.
- Firestore rules deny all direct client access intentionally. Functions using the Admin SDK bypass those rules, so each function must authenticate users and validate inputs.
- App Check is a helpful abuse barrier, not a replacement for authentication, validation or rate limiting.
- For a real exchange, do not store or handle customer funds until qualified security, custody, legal and compliance requirements have been addressed.

## Current state
The website's Support page still opens an email app using `mailto:`. It has not yet been wired to call `createSupportTicket`. The backend scaffold is not live until deployed and tested.
