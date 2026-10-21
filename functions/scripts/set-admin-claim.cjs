#!/usr/bin/env node
// Run only from a trusted administrator's computer or Cloud Shell.
// Uses Application Default Credentials; never download or commit a service-account key.
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const uid = process.argv[2];
if (!uid || !/^[A-Za-z0-9:_-]{10,150}$/.test(uid)) {
  console.error("Usage: node functions/scripts/set-admin-claim.cjs FIREBASE_USER_UID");
  process.exit(2);
}

async function main() {
  initializeApp({
    credential: applicationDefault(),
    projectId: "onchaincrypto-d976b",
  });
  const auth = getAuth();
  const user = await auth.getUser(uid);
  const claims = { ...(user.customClaims || {}), admin: true };
  await auth.setCustomUserClaims(uid, claims);
  console.log("Admin claim assigned to UID:", uid);
  console.log("Next: sign out of the website, sign back in, then reload the admin page.");
  console.log("Only run this for an account you are authorized to administer.");
}
main().catch((error) => {
  console.error("Could not set admin claim:", error.message || error);
  process.exit(1);
});
