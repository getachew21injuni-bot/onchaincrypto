import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  withFirestoreTransaction,
  firestoreString,
  firestoreInteger,
  firestoreTimestamp
} from "../workers/wallet-api/src/firestore-rest.js";

const env = {
  FIREBASE_PROJECT_ID: "onchaincrypto-d976b",
  FIREBASE_SERVICE_ACCOUNT: "{encrypted-secret-placeholder}"
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Firestore REST transaction primitives", () => {
  it("reads and commits writes under one Firestore transaction", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith(":beginTransaction")) return jsonResponse({ transaction: "tx-test" });
      if (String(url).endsWith(":batchGet")) {
        return jsonResponse([{ missing: { name: "projects/onchaincrypto-d976b/databases/(default)/documents/walletAccounts/test-user" } }]);
      }
      if (String(url).endsWith(":commit")) return jsonResponse({ writeResults: [], commitTime: "2026-11-08T00:00:00Z" });
      throw new Error("Unexpected Firestore request: " + url);
    };

    const result = await withFirestoreTransaction(env, async tx => {
      assert.equal(await tx.get("walletAccounts", "test-user"), null);
      tx.create("walletAccounts", "test-user", { uid: firestoreString("test-user") });
      return "committed";
    }, 3, { getAccessToken: async () => "test-access-token", fetchImpl });

    assert.equal(result, "committed");
    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /:beginTransaction$/);
    assert.match(calls[1].url, /:batchGet$/);
    assert.match(calls[2].url, /:commit$/);
    const commitBody = JSON.parse(calls[2].options.body);
    assert.equal(commitBody.transaction, "tx-test");
    assert.equal(commitBody.writes.length, 1);
    assert.deepEqual(commitBody.writes[0].currentDocument, { exists: false });
  });

  it("rolls back a read-only transaction without committing writes", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(String(url));
      if (String(url).endsWith(":beginTransaction")) return jsonResponse({ transaction: "tx-read-only" });
      if (String(url).endsWith(":rollback")) return jsonResponse({});
      throw new Error("Unexpected Firestore request: " + url);
    };
    const result = await withFirestoreTransaction(env, async () => "no-change", 3, {
      getAccessToken: async () => "test-access-token",
      fetchImpl
    });
    assert.equal(result, "no-change");
    assert.equal(calls.length, 2);
    assert.match(calls[1], /:rollback$/);
  });

  it("encodes typed values without converting money to floating point", () => {
    assert.deepEqual(firestoreString("123.4500"), { stringValue: "123.4500" });
    assert.deepEqual(firestoreInteger(7), { integerValue: "7" });
    assert.throws(() => firestoreInteger(1.5), /integer/);
    assert.equal(typeof firestoreTimestamp().timestampValue, "string");
  });
});
