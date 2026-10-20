# OnChainCrypto

OnChainCrypto is currently a **public demo website** for viewing public crypto-market data and trying simulated trades. It is not a live cryptocurrency exchange.

## Open the website

- Live demo: https://getachew21injuni-bot.github.io/onchaincrypto/
- Repository: https://github.com/getachew21injuni-bot/onchaincrypto

## Current status

- GitHub Pages website: published.
- Firebase Authentication UI: configured in the website; verify it in the live site before relying on it.
- Cloud Functions source: present in `functions/src/index.ts`.
- Backend build check: has passed.
- Firebase backend deployment: **not confirmed deployed**.
- Support contact: `onchaincryptosupport@gmail.com` is configured as a mailto address; create the mailbox before relying on it.
- Real-money deposits, withdrawals, custody, and trading: **not implemented**. Balances and trades in the prototype are simulated and browser-local.

## Security warning — required before deployment

A Firebase service-account private key was pasted into a chat. Treat that key as compromised:

1. Open [Google Cloud Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=onchaincrypto-d976b).
2. Select the service account `firebase-adminsdk-fbsvc@onchaincrypto-d976b.iam.gserviceaccount.com` and open **Keys**.
3. Delete/revoke the exposed key by its key ID. Do not delete the service account itself.
4. Generate a replacement key only after revoking the exposed one. Keep the JSON file private. Never paste it into chat or commit it to GitHub.

## Deploy the Firebase backend

Follow [FIREBASE_DEPLOYMENT_GUIDE.md](FIREBASE_DEPLOYMENT_GUIDE.md). The short version:

1. Review Firebase billing and possible charges before enabling paid services.
2. Add a fresh service-account JSON as a GitHub Actions repository secret named `FIREBASE_SERVICE_ACCOUNT_ONCHAINCRYPTO` at [Repository Actions secrets](https://github.com/getachew21injuni-bot/onchaincrypto/settings/secrets/actions). Paste the JSON only into GitHub's secret form—not into a chat or source file.
3. Run [Deploy Firebase Backend](https://github.com/getachew21injuni-bot/onchaincrypto/actions/workflows/deploy-firebase.yml).
4. Check the workflow run for a successful result.
5. Configure Firebase App Check for the website before calling the support function. The support function currently stores tickets in Firestore and does not send email notifications.

## Local Windows setup

See [INSTALL_BACKEND_WINDOWS.md](INSTALL_BACKEND_WINDOWS.md) for beginner setup instructions and [BACKEND_SETUP.md](BACKEND_SETUP.md) for the backend overview.

## Never commit secrets

Never put service-account JSON, private keys, passwords, wallet recovery phrases, or exchange API secrets in this repository or website code. Do not collect users' wallet seed phrases. Do not accept real deposits until payment monitoring, ledger accounting, reconciliation, withdrawal controls, compliance review, and independent security testing are complete.
