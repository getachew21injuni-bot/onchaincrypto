import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adjustWalletBalance } from "../workers/wallet-api/src/admin-wallet.js";

const env = { FIREBASE_PROJECT_ID: "onchaincrypto-d976b", FIREBASE_SERVICE_ACCOUNT: "{test}" };
const existing = {
  fields: {
    uid: { stringValue: "customer-1" },
    status: { stringValue: "active" },
    migrationStatus: { stringValue: "verified" },
    schemaVersion: { integerValue: "1" },
    version: { integerValue: "7" },
    balances: { mapValue: { fields: { USDT: { stringValue: "20500" }, BTC: { stringValue: "0.25" } } } }
  }
};
function json(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
function firestoreHarness({ account = existing } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value.endsWith(":beginTransaction")) return json({ transaction: "admin-test-tx" });
    if (value.endsWith(":batchGet")) {
      const name = JSON.parse(options.body).documents[0];
      if (name.includes("/operationKeys/")) return json([{ missing: { name } }]);
      if (account) return json([{ found: { ...account, name } }]);
      return json([{ missing: { name } }]);
    }
    if (value.endsWith(":commit")) return json({ commitTime: "2026-11-08T11:00:00Z" });
    if (value.endsWith(":rollback")) return json({});
    throw new Error("Unexpected Firestore request " + value);
  };
  return { calls, fetchImpl };
}
const admin = { uid: "admin-1", admin: true };
const request = {
  targetUid: "customer-1", asset: "USDT", amount: "250",
  reason: "Approved customer credit", operationId: "admin_operation_123456"
};
const dependencies = db => ({
  firestoreDependencies: { getAccessToken: async () => "test-token", fetchImpl: db.fetchImpl }
});

describe("admin wallet adjustments", () => {
  it("requires a verified admin claim before opening a Firestore transaction", async () => {
    const db = firestoreHarness();
    await assert.rejects(() => adjustWalletBalance({
      admin: { uid: "admin-1", admin: false }, body: request, env, dependencies: dependencies(db)
    }), error => error.code === "ADMIN_REQUIRED" && error.status === 403);
    assert.equal(db.calls.length, 0);
  });

  it("credits the cloud wallet and appends an immutable ledger record atomically", async () => {
    const db = firestoreHarness();
    const result = await adjustWalletBalance({ admin, body: request, env, dependencies: dependencies(db) });
    assert.equal(result.balance, "20750");
    assert.equal(result.version, 8);
    const commit = db.calls.find(call => call.url.endsWith(":commit"));
    assert.ok(commit);
    const writes = JSON.parse(commit.options.body).writes;
    assert.equal(writes.length, 3);
    const accountWrite = writes.find(write => write.update?.name.includes("/walletAccounts/"));
    assert.equal(accountWrite.update.fields.balances.mapValue.fields.USDT.stringValue, "20750");
    const ledgerWrite = writes.find(write => write.update?.name.includes("/walletLedger/"));
    assert.equal(ledgerWrite.update.fields.adminUid.stringValue, "admin-1");
    assert.equal(ledgerWrite.update.fields.balanceBefore.stringValue, "20500");
    assert.equal(ledgerWrite.update.fields.balanceAfter.stringValue, "20750");
    assert.equal(ledgerWrite.update.fields.reason.stringValue, request.reason);
    assert.equal(writes.filter(write => write.update?.name.includes("/operationKeys/")).length, 1);
  });

  it("rejects a debit that would make a customer balance negative", async () => {
    const db = firestoreHarness();
    await assert.rejects(() => adjustWalletBalance({
      admin, body: { ...request, amount: "-20501" }, env, dependencies: dependencies(db)
    }), error => error.code === "NEGATIVE_BALANCE" && error.status === 409);
    assert.equal(db.calls.some(call => call.url.endsWith(":commit")), false);
  });

  it("can provision a new verified wallet without importing or changing legacy balances", async () => {
    const db = firestoreHarness({ account: null });
    const result = await adjustWalletBalance({
      admin, body: { ...request, targetUid: "new-customer", amount: "100" },
      env, dependencies: dependencies(db)
    });
    assert.equal(result.balance, "100");
    const commit = db.calls.find(call => call.url.endsWith(":commit"));
    const writes = JSON.parse(commit.options.body).writes;
    const accountWrite = writes.find(write => write.update?.name.includes("/walletAccounts/"));
    assert.equal(accountWrite.currentDocument.exists, false);
    assert.equal(accountWrite.update.fields.migrationStatus.stringValue, "verified");
    assert.equal(accountWrite.update.fields.balances.mapValue.fields.USDT.stringValue, "100");
  });
});
