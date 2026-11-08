import {
  withFirestoreTransaction, firestoreString, firestoreInteger
} from "./firestore-rest.js";

const SCALE = 100000000n;

function fail(message, status = 400, code = "INVALID_REQUEST") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}
function parseAmount(value) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?$/.test(value) || value === "-0") {
    fail("Enter a valid balance change with up to 8 decimal places.");
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const units = BigInt(whole) * SCALE + BigInt((fraction + "00000000").slice(0, 8));
  return negative ? -units : units;
}
function formatAmount(units) {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  const formatted = fraction ? `${whole}.${fraction}` : String(whole);
  return negative ? `-${formatted}` : formatted;
}
function stringField(field) {
  return typeof field?.stringValue === "string" ? field.stringValue : undefined;
}
function balancesMap(balances) {
  const fields = {};
  for (const [asset, amount] of Object.entries(balances)) fields[asset] = firestoreString(amount);
  return { mapValue: { fields } };
}
async function idempotencyKey(adminUid, operationId) {
  const bytes = new TextEncoder().encode("admin-wallet:" + adminUid + ":" + operationId);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function timestampTransform(fieldPath) {
  return { fieldPath, setToServerValue: "REQUEST_TIME" };
}

export async function adjustWalletBalance({ admin, body, env, dependencies = {} }) {
  if (!admin || admin.admin !== true || typeof admin.uid !== "string" || !admin.uid) {
    fail("Administrator authorization is required.", 403, "ADMIN_REQUIRED");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid wallet adjustment request.");
  const targetUid = body.targetUid;
  const asset = typeof body.asset === "string" ? body.asset.toUpperCase() : "";
  const operationId = body.operationId;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (typeof targetUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(targetUid)) fail("A valid customer account is required.");
  if (!/^[A-Z0-9]{2,12}$/.test(asset)) fail("Invalid asset symbol.");
  if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(operationId)) fail("A valid unique operation ID is required.");
  if (reason.length < 5 || reason.length > 300) fail("Enter an adjustment reason (5–300 characters).");
  const delta = parseAmount(body.amount);
  if (delta === 0n) fail("The balance change cannot be zero.");

  const keyId = await idempotencyKey(admin.uid, operationId);
  const ledgerId = crypto.randomUUID();
  return withFirestoreTransaction(env, async tx => {
    const prior = await tx.get("operationKeys", keyId);
    if (prior) {
      const fields = prior.fields || {};
      if (stringField(fields.type) !== "admin_balance_adjustment" ||
          stringField(fields.targetUid) !== targetUid ||
          stringField(fields.asset) !== asset ||
          stringField(fields.amount) !== formatAmount(delta)) {
        fail("This operation ID was already used for a different adjustment.", 409, "IDEMPOTENCY_CONFLICT");
      }
      return {
        replayed: true,
        ledgerId: stringField(fields.ledgerId),
        targetUid, asset,
        balance: stringField(fields.balanceAfter)
      };
    }

    const account = await tx.get("walletAccounts", targetUid);
    let balances = {};
    let version = 0;
    if (account) {
      const fields = account.fields || {};
      if (stringField(fields.uid) !== targetUid ||
          stringField(fields.status) !== "active" ||
          stringField(fields.migrationStatus) !== "verified" ||
          Number(fields.schemaVersion?.integerValue) !== 1) {
        fail("This customer's cloud wallet is not verified. No balance was changed.", 409, "ACCOUNT_NOT_VERIFIED");
      }
      const raw = fields.balances?.mapValue?.fields || {};
      for (const [symbol, field] of Object.entries(raw)) {
        if (typeof field.stringValue !== "string" ||
            !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?$/.test(field.stringValue)) {
          fail("The customer's existing wallet needs administrator review.", 409, "WALLET_DATA_INVALID");
        }
        balances[symbol] = field.stringValue;
      }
      version = Number(fields.version?.integerValue || 0);
    }

    const before = parseAmount(balances[asset] || "0");
    const after = before + delta;
    if (after < 0n) fail("This adjustment would make the balance negative.", 409, "NEGATIVE_BALANCE");
    balances[asset] = formatAmount(after);

    const accountFields = {
      uid: firestoreString(targetUid),
      status: firestoreString("active"),
      migrationStatus: firestoreString("verified"),
      schemaVersion: firestoreInteger(1),
      balances: balancesMap(balances),
      version: firestoreInteger(version + 1)
    };
    if (account) {
      tx.update("walletAccounts", targetUid, accountFields,
        ["status", "migrationStatus", "schemaVersion", "balances", "version"],
        [timestampTransform("updatedAt")]);
    } else {
      tx.create("walletAccounts", targetUid, accountFields, [timestampTransform("createdAt"), timestampTransform("updatedAt")]);
    }

    tx.create("walletLedger", ledgerId, {
      uid: firestoreString(targetUid),
      asset: firestoreString(asset),
      amount: firestoreString(formatAmount(delta < 0n ? -delta : delta)),
      direction: firestoreString(delta > 0n ? "credit" : "debit"),
      balanceBefore: firestoreString(formatAmount(before)),
      balanceAfter: firestoreString(formatAmount(after)),
      type: firestoreString("admin_balance_adjustment"),
      status: firestoreString("posted"),
      source: firestoreString("admin"),
      adminUid: firestoreString(admin.uid),
      reason: firestoreString(reason),
      operationId: firestoreString(operationId)
    }, [timestampTransform("createdAt")]);

    tx.create("operationKeys", keyId, {
      uid: firestoreString(admin.uid),
      type: firestoreString("admin_balance_adjustment"),
      targetUid: firestoreString(targetUid),
      asset: firestoreString(asset),
      amount: firestoreString(formatAmount(delta)),
      reason: firestoreString(reason),
      ledgerId: firestoreString(ledgerId),
      balanceAfter: firestoreString(formatAmount(after))
    }, [timestampTransform("createdAt")]);

    return { replayed: false, ledgerId, targetUid, asset, balance: formatAmount(after), version: version + 1 };
  }, 3, dependencies.firestoreDependencies || {});
}
