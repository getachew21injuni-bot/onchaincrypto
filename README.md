# OnChainCrypto

A static demo website for viewing public crypto-market data and testing simulated trades. **This repository is not a live cryptocurrency exchange.**

## Live sites

- **Firebase Hosting:** https://onchaincrypto-d976b.firebaseapp.com
- **GitHub Pages:** https://getachew21injuni-bot.github.io/onchaincrypto/
- **GitHub repository:** https://github.com/getachew21injuni-bot/onchaincrypto

## Repository layout

| Path | Purpose | Editing guidance |
| --- | --- | --- |
| `public/index.html` | Main website served by Firebase Hosting | Update this file for Firebase site changes. |
| `index.html` | Main website served by GitHub Pages | Keep its intended Pages-specific content in sync with shared UI changes. Do not assume it is byte-for-byte identical to `public/index.html`. |
| `public/admin.html`, `public/admin-dashboard.html` | Admin pages served by Firebase | Update the public copy when changing Firebase admin pages. |
| `admin.html`, `admin-dashboard.html` | Root admin-page copies | Update when the corresponding GitHub Pages version should change. |
| `public/support-chat.js`, `public/support-admin.js` | Support UI scripts for Firebase Hosting | Update the public versions for Firebase changes. |
| `support-chat.js`, `support-admin.js` | Root support-script copies | Keep aligned with shared support changes intended for GitHub Pages. |
| `functions/src/index.ts` | Firebase Cloud Functions source | Build with `npm --prefix functions run build`. |
| `functions/scripts/` | Backend administration scripts | Never commit credentials or private keys. |
| `firestore.rules`, `firestore.indexes.json` | Firestore security rules and indexes | Review security rules carefully before deployment. |
| `firebase.json`, `.firebaserc` | Firebase project and Hosting configuration | Check these before changing deployment behavior. |
| `.github/workflows/` | Automated checks and deployment workflows | Use the automatic Hosting workflow for normal site updates; use manual workflows only when deliberately deploying a specific service. |
| `README.md`, `*_GUIDE.md`, `BACKEND_SETUP.md` | Setup and maintenance documentation | Update docs when the deployment process changes. |

## Deployment workflow map

- **Website (Firebase Hosting):** `.github/workflows/hosting-only.yml` runs on pushes to `main` and can be started manually.
- **Website (GitHub Pages):** GitHub Pages builds and publishes the root site separately.
- **Backend build check:** `.github/workflows/backend-check.yml` compiles the Functions source; it does not deploy it.
- **Backend deployment:** `.github/workflows/deploy-firebase.yml` deploys Cloud Functions and Firestore rules/indexes when backend-related files change, or when manually started.
- **Firestore rules-only deployment:** `.github/workflows/deploy-firestore-only.yml` is manual-only to avoid overlapping automatic backend deployments.
- **Manual Hosting alternatives:** `deploy-hosting.yml` and `firebase-deploy.yml` are retained for manual use. Prefer the standard Hosting workflow for ordinary website updates.

After each change, check the relevant GitHub Actions run. Do not assume a commit is live until the deployment run finishes successfully. Hard-refresh the site with **Ctrl + Shift + R** after deployment.

## Current status and limitations

- Public market data and simulated trade UI are intended for demo use.
- Firebase Authentication UI is present; test sign-in on the live site before relying on it.
- Cloud Functions source is present, but backend deployment must be verified in GitHub Actions.
- Support contact shown in the app: `onchaincryptosupport@gmail.com`. Create and test this mailbox before relying on it.
- Real-money deposits, withdrawals, custody, and live exchange execution are **not implemented**. Balances and trades in the prototype are simulated and browser-local.

## Security: rotate any exposed service-account key

If a Firebase service-account private key was ever pasted into a chat, ticket, or other shared place, treat it as compromised:

1. Open [Google Cloud Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=onchaincrypto-d976b).
2. Select `firebase-adminsdk-fbsvc@onchaincrypto-d976b.iam.gserviceaccount.com` and open **Keys**.
3. Revoke/delete only the exposed key by its key ID. Do not delete the service account itself.
4. If needed, create a replacement key and store it only as the GitHub Actions secret `FIREBASE_SERVICE_ACCOUNT_ONCHAINCRYPTO`. Never paste it into chat or commit it to this repository.

## Guides

- [Firebase deployment guide](FIREBASE_DEPLOYMENT_GUIDE.md)
- [Backend setup overview](BACKEND_SETUP.md)
- [Windows installation guide](INSTALL_BACKEND_WINDOWS.md)

## Safe development checklist

- Keep API keys, service-account JSON, passwords, private keys, wallet recovery phrases, and exchange secrets out of source files and commits.
- Never ask users for wallet seed phrases.
- Do not describe demo balances as real funds.
- Before accepting real deposits, require payment monitoring, ledger accounting, reconciliation, withdrawal controls, compliance review, and independent security testing.
- Make the smallest targeted change possible, run the backend build check when backend files change, and confirm deployment status before telling users an update is live.
