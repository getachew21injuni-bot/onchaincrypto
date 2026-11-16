# OnChainSpro Admin API (Cloudflare Worker)

This is a separate server-side endpoint for the admin dashboard's protected member deletion action. It does not use Firebase Cloud Functions, Cloud Build, or Artifact Registry.

## What it does

- Verifies the Firebase ID token signature and claims.
- Allows only the verified administrator email `getachew21.inj.uni@gmail.com`.
- Requires a sign-in within the previous 10 minutes and the exact typed confirmation `DELETE`.
- Blocks deletion of administrator accounts and the currently signed-in administrator.
- Disables the target account before cleanup.
- Pseudonymizes the account UID on the existing financial collections while preserving financial values and timestamps.
- Removes profile/KYC/broker onboarding records, support tickets/messages, and notifications.
- Moves the `userTradeState` snapshot to a pseudonymous document ID, preserving the wallet snapshot.
- Deletes the Firebase Authentication account only after the Firestore cleanup succeeds.
- Writes a start/completion/failure record to `adminAuditLogs`.

The worker intentionally preflights record counts before disabling the account. It refuses unusually large cleanup jobs instead of risking a partial one-request cleanup.

## Cloudflare setup

1. In Cloudflare, create a new Worker named `onchaincrypto-admin-api`.
2. Deploy `worker.js` as the Worker entry point. You can paste the file into the dashboard editor or deploy it with Wrangler.
3. In **Settings → Variables and Secrets**, add a **Secret** named `FIREBASE_SERVICE_ACCOUNT`.
4. Set its value to the JSON contents of the Firebase service-account key. The key must remain a Cloudflare Secret; never commit it to GitHub or paste it into chat. You may use the existing service-account key already held by the `onchaincrypto-deposit-verifier` Worker, but first confirm that its service account has the permissions below.
5. Deploy the Worker after adding the secret.
6. Confirm `GET https://<your-worker-subdomain>.workers.dev/health` returns `{"ok":true,"service":"onchainspro-admin-api"}`.

## Required Google Cloud IAM permissions

The service account in the secret needs:
- **Firebase Authentication Admin** (`roles/firebaseauth.admin`) to look up, disable, and delete Firebase Authentication users.
- **Cloud Datastore User** (`roles/datastore.user`) to query and update Firestore documents.

The Identity Toolkit API and Cloud Firestore API must be enabled. This design does not deploy Cloud Functions and does not require Artifact Registry or Cloud Build. IAM role changes may require a project owner.

## Cloudflare plan note

The Worker is designed for a low-volume admin action and uses bounded batches. Cloudflare's Free Workers plan has request, CPU-time, and subrequest limits; an unusually large account cleanup may be rejected safely. Do not enable paid billing just for this Worker unless Cloudflare's own usage limits require it.

## Frontend integration

After the Worker is deployed, use its exact `workers.dev` URL in the admin dashboard as `ADMIN_DELETE_API_URL`, ending with `/admin/delete-user`. The dashboard must send the current administrator's Firebase ID token in the Authorization header and send only the selected UID plus typed confirmation in the JSON body. Do not put the service-account key in the website.
