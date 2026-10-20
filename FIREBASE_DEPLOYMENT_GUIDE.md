# Finish deploying the OnChainCrypto Firebase backend

The GitHub build check passing means the TypeScript compiles. It does **not** mean the Firebase backend has been deployed.

## One-time account setup (the account owner must do this)

1. Open https://console.firebase.google.com/project/onchaincrypto-d976b/overview and confirm you are signed in to the correct Google account.
2. Open **Project settings** (gear icon) > **Service accounts**.
3. Generate a private key for a dedicated service account only if you have permission and understand that it grants backend deployment access. Keep the downloaded JSON private. Never commit it to this repository or paste it into a chat.
4. Open https://github.com/getachew21injuni-bot/onchaincrypto/settings/secrets/actions
5. Choose **New repository secret**.
   - Name: `FIREBASE_SERVICE_ACCOUNT_ONCHAINCRYPTO`
   - Secret: paste the *entire contents* of the downloaded service-account JSON file into GitHub's secret field, then save.
6. In Firebase Console, check whether Cloud Functions deployment requires switching the project to the Blaze billing plan. Review Firebase pricing and set a budget alert before enabling billing. Do not enable billing unless you accept possible charges.
7. Open https://github.com/getachew21injuni-bot/onchaincrypto/actions/workflows/deploy-firebase.yml
8. Click **Run workflow** > choose **main** > **Run workflow**.
9. Open the run and check each step. A green check means the deployment command completed; a red X means open the failed step and read its error.

## Important limitations

- The deployment workflow deploys Cloud Functions and Firestore rules/indexes only.
- The callable support function currently requires a signed-in user and Firebase App Check. The frontend must be configured with a real App Check web site key before support calls can work.
- The support function stores tickets in Firestore; it does not email the support mailbox yet.
- The public website still uses demo-only balances/trades. Do not accept real deposits, promise withdrawals, or represent demo trading as real trading.
- This starter is not a production cryptocurrency exchange. A real exchange needs a secure ledger, transaction reconciliation, withdrawal approvals and monitoring, key management, abuse controls, legal/compliance review, and independent security testing.
- Never put private keys, seed phrases, exchange API secrets, passwords, or service-account JSON in website code or ordinary Git files.
