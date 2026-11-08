# OnChainCrypto — Complete Windows Backend Setup

This guide is for a beginner using Windows 10/11. The backend starter files are already in this GitHub repository, but **the backend is not deployed yet**. Follow the steps in order.

## 1. Download and install Node.js

1. Open the official page: https://nodejs.org/en/download
2. Download the current **LTS** Windows Installer (.msi). On most Windows computers, choose **x64**.
3. Open the downloaded installer. Click Next, accept the license, keep the default options, and click Install.
4. Finish the installer. Close and reopen Command Prompt.

Verify installation: open Start, type **Command Prompt**, open it, and run these one at a time:

```bash
node -v
npm -v
```

Both commands should print version numbers. If Windows says a command is not recognized, restart the computer and try again.

## 2. Download this GitHub project

Open https://github.com/getachew21injuni-bot/onchaincrypto
1. Click the green **Code** button.
2. Choose **Download ZIP**.
3. Open your Downloads folder and extract the ZIP (right-click → Extract All).
4. Open the extracted project folder. It should contain `index.html`, `firebase.json`, `firestore.rules`, and a `functions` folder.

## 3. Install Firebase CLI

In Command Prompt, run:

```bash
npm install -g firebase-tools
firebase --version
```

Official CLI documentation: https://firebase.google.com/docs/cli

## 4. Open Command Prompt in the project folder

In File Explorer, open the extracted project folder. Click the address bar, type `cmd`, and press Enter. This opens Command Prompt in that folder.

Run the following commands one at a time:

```bash
npm install --prefix functions
npm run --prefix functions build
firebase login
firebase use onchaincrypto-d976b
```

For `firebase login`, a browser window will open. Sign in with the Google account that owns or has permission to manage the Firebase project.

If the build command reports errors, stop and share the full error text before deploying.

## 5. Check Firebase project setup

Open https://console.firebase.google.com/ and select project **onchaincrypto-d976b**.

- Confirm you have permission to manage the project.
- Create/enable **Cloud Firestore** using the Firebase Console.
- Review current billing requirements and estimated costs before enabling billing. Cloud Functions deployment may require the Blaze pay-as-you-go plan. Do not upgrade until you understand the possible charges.
- Configure **Firebase App Check** for the web app using the official instructions: https://firebase.google.com/docs/app-check/web/recaptcha-provider

The callable support function enforces App Check. Do not deploy it for public use until App Check is configured and the frontend is ready to send valid App Check tokens.

## 6. Deploy only after checks pass

From the project folder, deploy Firestore rules first:

```bash
firebase deploy --only firestore:rules
```

Then deploy the function:

```bash
firebase deploy --only functions
```

If the CLI asks to enable APIs or set up billing, read the prompt and costs carefully. Stop if anything is unclear.

## 7. Important: what is and isn't working

Included in the repository:
- Firebase Cloud Function starter named `createSupportTicket`.
- Authentication check and input validation in the function.
- Firestore rules that deny direct browser reads/writes by default.
- App Check enforcement in the callable function.

Not yet completed:
- The Support form on the website is not connected to this function.
- The function saves support tickets to Firestore; it does not send email notifications.
- No real-money deposits, withdrawals, custody, live trading, or secure customer ledger is implemented.
- A successful build/deployment is not proof of a complete security audit.

## Security rules for this project

- Never upload service-account JSON files, private keys, wallet seed phrases, exchange API secrets, or passwords to GitHub or website JavaScript.
- Do not treat browser/localStorage demo balances as real money.
- Do not accept real deposits or allow withdrawals/live orders until payment verification, a server-side ledger, access controls, fraud monitoring, backups, logging, legal/compliance review, and independent security testing are completed.
- Test using a test account only.

## Official links

- Node.js: https://nodejs.org/en/download
- Firebase Console: https://console.firebase.google.com/
- Firebase CLI: https://firebase.google.com/docs/cli
- Firebase App Check: https://firebase.google.com/docs/app-check/web/recaptcha-provider
- Firebase Functions: https://firebase.google.com/docs/functions
