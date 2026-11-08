import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeStandardTrade } from "../workers/wallet-api/src/trades.js";
import { getTrustedQuote } from "../workers/wallet-api/src/quotes.js";

const env = { FIREBASE_PROJECT_ID: "onchaincrypto-d976b", FIREBASE_SERVICE_ACCOUNT: "{test}" };
const account = {
  name: "projects/onchaincrypto-d976b/databases/(default)/documents/walletAccounts/user-1",
  fields: {
    uid: { stringValue: "user-1" }, status: { stringValue: "active" },
    migrationStatus: { stringValue: "verified" }, schemaVersion: { integerValue: "1" },
    version: { integerValue: "4" },
    balances: { mapValue: { fields: {
      USDT: { stringValue: "500.00" }, BTC: { stringValue: "0.25" }
    } } }
  }
};
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function firestoreHarness(accountDoc = account) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url); calls.push({ url: u, options });
    if (u.endsWith(":beginTransaction")) return json({ transaction: "test-tx" });
    if (u.endsWith(":batchGet")) {
      const requested = JSON.parse(options.body).documents[0];
      if (requested.endsWith("/operationKeys/")) return json([{ missing: { name: requested } }]);
      if (requested.includes("/operationKeys/")) return json([{ missing: { name: requested } }]);
      return json([{ found: accountDoc }]);
    }
    if (u.endsWith(":commit")) return json({ commitTime: "2026-11-08T10:00:00Z", writeResults: [] });
    if (u.endsWith(":rollback")) return json({});
    throw new Error("Unexpected Firestore request " + u);
  };
  return { calls, fetchImpl };
}
const operationId = "operation_123456789012";

describe("standard buy/sell settlement", () => {
  it("atomically debits USDT, credits BTC, and creates both ledgers", async () => {
    const db = firestoreHarness();
    const result = await executeStandardTrade({
      user: { uid: "user-1" }, env,
      body: { side: "buy", symbol: "BTC", quoteAmount: "100", operationId },
      dependencies: {
        getQuote: async () => ({ symbol: "BTC", pair: "BTCUSDT", price: "50000.00", source: "test", quotedAt: "2026-11-08T10:00:00Z" }),
        firestoreDependencies: { getAccessToken: async () => "test-token", fetchImpl: db.fetchImpl }
      }
    });
    assert.equal(result.status, "filled");
    assert.equal(result.quantity, "0.002");
    const commit = db.calls.find(call => call.url.endsWith(":commit"));
    assert.ok(commit);
    const writes = JSON.parse(commit.options.body).writes;
    assert.equal(writes.length, 5);
    const accountWrite = writes.find(write => write.update?.name.includes("/walletAccounts/"));
    const balances = accountWrite.update.fields.balances.mapValue.fields;
    assert.equal(balances.USDT.stringValue, "400");
    assert.equal(balances.BTC.stringValue, "0.252");
    assert.equal(accountWrite.updateTransforms[0].setToServerValue, "REQUEST_TIME");
    assert.equal(writes.filter(write => write.update?.name.includes("/walletLedger/")).length, 2);
    assert.equal(writes.filter(write => write.update?.name.includes("/tradeLedger/")).length, 1);
    assert.equal(writes.filter(write => write.update?.name.includes("/operationKeys/")).length, 1);
    const idempotencyWrite = writes.find(write => write.update?.name.includes("/operationKeys/"));
    const savedResult = idempotencyWrite.update.fields.result.mapValue.fields;
    assert.equal(savedResult.price.stringValue, "50000");
    assert.equal(savedResult.balances.mapValue.fields.USDT.stringValue, "400");
    assert.equal(savedResult.balances.mapValue.fields.BTC.stringValue, "0.252");
  });

  it("rejects insufficient USDT without committing a balance change", async () => {
    const db = firestoreHarness();
    await assert.rejects(() => executeStandardTrade({
      user: { uid: "user-1" }, env,
      body: { side: "buy", symbol: "BTC", quoteAmount: "600", operationId },
      dependencies: {
        getQuote: async () => ({ price: "50000", source: "test", quotedAt: "2026-11-08T10:00:00Z" }),
        firestoreDependencies: { getAccessToken: async () => "test-token", fetchImpl: db.fetchImpl }
      }
    }), error => error.code === "INSUFFICIENT_FUNDS" && error.status === 409);
    assert.equal(db.calls.some(call => call.url.endsWith(":commit")), false);
    assert.equal(db.calls.some(call => call.url.endsWith(":rollback")), true);
  });

  it("refuses accounts that have not been reconciled and verified", async () => {
    const unverified = structuredClone(account);
    unverified.fields.migrationStatus.stringValue = "pending";
    const db = firestoreHarness(unverified);
    await assert.rejects(() => executeStandardTrade({
      user: { uid: "user-1" }, env,
      body: { side: "buy", symbol: "BTC", quoteAmount: "100", operationId },
      dependencies: {
        getQuote: async () => ({ price: "50000", source: "test", quotedAt: "2026-11-08T10:00:00Z" }),
        firestoreDependencies: { getAccessToken: async () => "test-token", fetchImpl: db.fetchImpl }
      }
    }), error => error.code === "ACCOUNT_NOT_VERIFIED");
    assert.equal(db.calls.some(call => call.url.endsWith(":commit")), false);
  });
});

describe("trusted market quote", () => {
  it("accepts the Binance XAUT/USDT ticker and rejects unsupported XAU", async () => {
    const goodFetch = async url => {
      const pair = new URL(url).searchParams.get("symbol");
      return json({ symbol: pair, price: pair === "XAUTUSDT" ? "2500.25" : "50000.12" });
    };
    const quote = await getTrustedQuote("BTC", goodFetch);
    assert.equal(quote.price, "50000.12");
    const goldQuote = await getTrustedQuote("XAUT", goodFetch);
    assert.equal(goldQuote.pair, "XAUTUSDT");
    assert.equal(goldQuote.price, "2500.25");
    await assert.rejects(() => getTrustedQuote("XAU", goodFetch), error => error.code === "UNSUPPORTED_ASSET");
  });

  it("requires a 500 USDT minimum for XAUT gold trades", async () => {
    const db = firestoreHarness();
    await assert.rejects(() => executeStandardTrade({
      user: { uid: "user-1" }, env,
      body: { side: "buy", symbol: "XAUT", quoteAmount: "499.99", operationId },
      dependencies: {
        getQuote: async () => ({ symbol: "XAUT", pair: "XAUTUSDT", price: "2500", source: "test", quotedAt: "2026-11-08T10:00:00Z" }),
        firestoreDependencies: { getAccessToken: async () => "test-token", fetchImpl: db.fetchImpl }
      }
    }), error => error.code === "MINIMUM_TRADE");
    assert.equal(db.calls.some(call => call.url.endsWith(":commit")), false);
  });
});
