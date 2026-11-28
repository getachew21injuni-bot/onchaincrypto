import test from "node:test";
import assert from "node:assert/strict";
import { walletApiInternals as api } from "../workers/onchainspro-wallet-api-v2/index.js";

test("Firestore value encoding preserves wallet numeric and nested types", () => {
  assert.deepEqual(api.toFirestore(12), { integerValue: "12" });
  assert.deepEqual(api.toFirestore(12.5), { doubleValue: 12.5 });
  assert.deepEqual(api.toFirestore({ BTC: 0.25, flags: [true, null] }), {
    mapValue: { fields: {
      BTC: { doubleValue: 0.25 },
      flags: { arrayValue: { values: [{ booleanValue: true }, { nullValue: null }] } }
    } }
  });
});

test("Firestore document decoding handles nested wallet values", () => {
  const decoded = api.fieldsFromFirestore({
    balance: { doubleValue: 100.25 },
    holdings: { mapValue: { fields: { BTC: { doubleValue: 0.01 } } } },
    history: { arrayValue: { values: [{ stringValue: "trade" }] } }
  });
  assert.deepEqual(decoded, { balance: 100.25, holdings: { BTC: 0.01 }, history: ["trade"] });
});

test("document IDs reject path separators and malformed values", () => {
  assert.equal(api.validId("firebase_uid-123"), true);
  assert.equal(api.validId(""), false);
  assert.equal(api.validId("../wallet"), false);
  assert.equal(api.validId("uid/other"), false);
  assert.equal(api.validId("x".repeat(129)), false);
});

test("admin authorization requires custom claim or verified allowlisted email", () => {
  assert.equal(api.isAdmin({}, { admin: true, sub: "uid" }), true);
  assert.equal(api.isAdmin({ ADMIN_EMAILS: "admin@example.com" }, {
    email: "ADMIN@example.com", email_verified: true
  }), true);
  assert.equal(api.isAdmin({ ADMIN_EMAILS: "admin@example.com" }, {
    email: "admin@example.com", email_verified: false
  }), false);
  assert.equal(api.isAdmin({ ADMIN_EMAILS: "admin@example.com" }, {
    email: "other@example.com", email_verified: true
  }), false);
});

test("wallet writes require an updateTime precondition and preserve only the supplied snapshot", () => {
  const write = api.walletWrite("user-1", {}, "2026-11-20T12:00:00Z", 50, { BTC: 0.1 }, []);
  assert.equal(write.currentDocument.updateTime, "2026-11-20T12:00:00Z");
  assert.deepEqual(write.updateMask.fieldPaths, ["uid", "balance", "holdings", "history", "updatedAt"]);
  assert.equal(write.update.fields.balance.integerValue, "50");
  assert.equal(write.update.fields.holdings.mapValue.fields.BTC.doubleValue, 0.1);
});

test("wallet ledger writes are create-only to prevent duplicate transaction IDs", () => {
  const write = api.createLedgerWrite("trade-1", { uid: "user-1", amount: 10, createdAt: { timestampValue: "2026-11-20T12:00:00Z" } });
  assert.equal(write.currentDocument.exists, false);
  assert.equal(write.update.fields.amount.integerValue, "10");
  assert.equal(write.update.fields.createdAt.timestampValue, "2026-11-20T12:00:00Z");
});


test("deposit request IDs are deterministic across hash casing and unique by network", async () => {
  const first = await api.depositRequestId("TRC20", "0xABCDEF1234567890");
  const same = await api.depositRequestId("trc20", "0xabcdef1234567890");
  const otherNetwork = await api.depositRequestId("ERC20", "0xabcdef1234567890");
  assert.equal(first, same);
  assert.notEqual(first, otherNetwork);
  const base58Upper = await api.depositRequestId("Solana", "AbCdEfGh123456789");
  const base58Lower = await api.depositRequestId("Solana", "abcdefGh123456789");
  assert.notEqual(base58Upper, base58Lower);
  assert.match(first, /^dep_[a-f0-9]{64}$/);
});
