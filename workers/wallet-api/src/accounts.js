import { withFirestoreTransaction } from "./firestore-rest.js";

function fieldString(field) {
  return typeof field?.stringValue === "string" ? field.stringValue : undefined;
}
export async function readWalletAccount(user, env, dependencies = {}) {
  return withFirestoreTransaction(env, async tx => {
    const account = await tx.get("walletAccounts", user.uid);
    if (!account) return { status: "not_migrated", balances: {} };
    const fields = account.fields || {};
    if (fieldString(fields.uid) !== user.uid ||
        fieldString(fields.status) !== "active" ||
        fieldString(fields.migrationStatus) !== "verified" ||
        Number(fields.schemaVersion?.integerValue) !== 1) {
      return { status: "verification_required", balances: {} };
    }
    const raw = fields.balances?.mapValue?.fields || {};
    const balances = {};
    for (const [asset, value] of Object.entries(raw)) {
      if (typeof value.stringValue !== "string" || !/^(?:0|[1-9][0-9]{0,11})(?:[.][0-9]{1,8})?$/.test(value.stringValue)) {
        const error = new Error("Cloud wallet balance data needs administrator review.");
        error.status = 503; error.code = "WALLET_DATA_INVALID"; throw error;
      }
      balances[asset] = value.stringValue;
    }
    return { status: "active", balances, version: Number(fields.version?.integerValue || 0) };
  }, 3, dependencies);
}
