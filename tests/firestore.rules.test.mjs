import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc
} from "firebase/firestore";

const projectId = "demo-onchaincrypto-rules-test";
const adminEmail = "getachew21.inj.uni@gmail.com";
let testEnv;

before(async () => {
  const rules = await readFile("firestore.rules", "utf8");
  testEnv = await initializeTestEnvironment({ projectId, firestore: { rules } });
});

after(async () => { await testEnv?.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "users/sender"), { uid: "sender", adminAssigned: true, demoBalanceUSDT: 100, accountStatus: "active" });
    await setDoc(doc(db, "users/recipient"), { uid: "recipient", adminAssigned: true, demoBalanceUSDT: 20, accountStatus: "active" });
    await setDoc(doc(db, "userDirectory/sender"), { uid: "sender", displayName: "Sender" });
    await setDoc(doc(db, "userDirectory/recipient"), { uid: "recipient", displayName: "Recipient" });
  });
});

function adminDb() {
  return testEnv.authenticatedContext("admin", { email: adminEmail, email_verified: true }).firestore();
}

async function createRequest(amount = 12.5) {
  const db = testEnv.authenticatedContext("sender").firestore();
  const requestRef = doc(collection(db, "internalTransferRequests"));
  await assertSucceeds(setDoc(requestRef, {
    senderUid: "sender", recipientUid: "recipient", asset: "USDT", amount,
    senderName: "Sender", recipientName: "Recipient", status: "pending",
    createdAt: serverTimestamp()
  }));
  return requestRef.id;
}

async function approveRequest(requestId, amount = 12.5) {
  const db = adminDb();
  const requestRef = doc(db, "internalTransferRequests", requestId);
  const senderRef = doc(db, "users/sender");
  const recipientRef = doc(db, "users/recipient");
  const transferRef = doc(collection(db, "internalTransfers"));
  await runTransaction(db, async (tx) => {
    const [requestSnap, senderSnap, recipientSnap] = await Promise.all([
      tx.get(requestRef), tx.get(senderRef), tx.get(recipientRef)
    ]);
    assert.equal(requestSnap.data().status, "pending");
    const senderBefore = senderSnap.data().demoBalanceUSDT;
    const recipientBefore = recipientSnap.data().demoBalanceUSDT;
    const senderAfter = senderBefore - amount;
    const recipientAfter = recipientBefore + amount;
    tx.update(senderRef, {
      demoBalanceUSDT: senderAfter, demoBalanceUpdatedAt: serverTimestamp(),
      demoBalanceLastTransferId: transferRef.id
    });
    tx.update(recipientRef, {
      demoBalanceUSDT: recipientAfter, demoBalanceUpdatedAt: serverTimestamp(),
      demoBalanceLastTransferId: transferRef.id
    });
    tx.set(transferRef, {
      senderUid: "sender", recipientUid: "recipient", asset: "USDT", amount,
      senderBefore, senderAfter, recipientBefore, recipientAfter,
      senderName: "Sender", recipientName: "Recipient",
      createdAt: serverTimestamp(), transferRequestId: requestId, approvedBy: adminEmail
    });
    tx.update(requestRef, {
      status: "approved", reviewedAt: serverTimestamp(), reviewedBy: adminEmail,
      transferId: transferRef.id
    });
  });
  return transferRef.id;
}

describe("admin-approved internal USDT transfer security", () => {
  it("lets a customer submit a pending request without reading the recipient wallet", async () => {
    const requestId = await createRequest();
    const db = testEnv.authenticatedContext("sender").firestore();
    const request = await assertSucceeds(getDoc(doc(db, "internalTransferRequests", requestId)));
    assert.equal(request.data().status, "pending");
    await assertFails(getDoc(doc(db, "users/recipient")));
    await assertFails(getDocs(collection(db, "userDirectory")));
  });

  it("blocks customer approval and direct wallet balance changes", async () => {
    const requestId = await createRequest();
    const db = testEnv.authenticatedContext("sender").firestore();
    await assertFails(updateDoc(doc(db, "internalTransferRequests", requestId), { status: "approved" }));
    await assertFails(updateDoc(doc(db, "users/sender"), { demoBalanceUSDT: 999 }));
  });

  it("allows the admin to approve once with atomic balances and immutable ledger", async () => {
    const requestId = await createRequest();
    const transferId = await approveRequest(requestId);
    const db = adminDb();
    const [sender, recipient, request, ledger] = await Promise.all([
      getDoc(doc(db, "users/sender")), getDoc(doc(db, "users/recipient")),
      getDoc(doc(db, "internalTransferRequests", requestId)),
      getDoc(doc(db, "internalTransfers", transferId))
    ]);
    assert.equal(sender.data().demoBalanceUSDT, 87.5);
    assert.equal(recipient.data().demoBalanceUSDT, 32.5);
    assert.equal(request.data().status, "approved");
    assert.equal(request.data().transferId, transferId);
    assert.equal(ledger.data().transferRequestId, requestId);
    assert.equal(ledger.data().amount, 12.5);
    await assertFails(updateDoc(doc(db, "internalTransfers", transferId), { amount: 999 }));
    await assertFails(updateDoc(doc(db, "internalTransferRequests", requestId), { status: "rejected" }));
  });

  it("rejects approval when the sender balance is insufficient", async () => {
    const requestId = await createRequest(101);
    const db = adminDb();
    const requestRef = doc(db, "internalTransferRequests", requestId);
    const senderRef = doc(db, "users/sender");
    const recipientRef = doc(db, "users/recipient");
    const transferRef = doc(collection(db, "internalTransfers"));
    await assertFails(runTransaction(db, async (tx) => {
      const [request, sender, recipient] = await Promise.all([
        tx.get(requestRef), tx.get(senderRef), tx.get(recipientRef)
      ]);
      const before = sender.data().demoBalanceUSDT;
      const recipientBefore = recipient.data().demoBalanceUSDT;
      tx.update(senderRef, { demoBalanceUSDT: before - 101, demoBalanceUpdatedAt: serverTimestamp(), demoBalanceLastTransferId: transferRef.id });
      tx.update(recipientRef, { demoBalanceUSDT: recipientBefore + 101, demoBalanceUpdatedAt: serverTimestamp(), demoBalanceLastTransferId: transferRef.id });
      tx.set(transferRef, {
        senderUid: "sender", recipientUid: "recipient", asset: "USDT", amount: 101,
        senderBefore: before, senderAfter: before - 101, recipientBefore,
        recipientAfter: recipientBefore + 101, senderName: "Sender", recipientName: "Recipient",
        createdAt: serverTimestamp(), transferRequestId: requestId, approvedBy: adminEmail
      });
      tx.update(requestRef, { status: "approved", reviewedAt: serverTimestamp(), reviewedBy: adminEmail, transferId: transferRef.id });
    }));
  });

  it("rejects forged requests and prevents ledger-only transfers", async () => {
    const db = testEnv.authenticatedContext("sender").firestore();
    await assertFails(setDoc(doc(collection(db, "internalTransferRequests")), {
      senderUid: "someone-else", recipientUid: "recipient", asset: "USDT", amount: 1,
      senderName: "Fake", recipientName: "Recipient", status: "pending", createdAt: serverTimestamp()
    }));
    const admin = adminDb();
    await assertFails(setDoc(doc(collection(admin, "internalTransfers")), {
      senderUid: "sender", recipientUid: "recipient", asset: "USDT", amount: 10,
      senderBefore: 100, senderAfter: 90, recipientBefore: 20, recipientAfter: 30,
      senderName: "Sender", recipientName: "Recipient", createdAt: serverTimestamp(),
      transferRequestId: "missing-request", approvedBy: adminEmail
    }));
  });
});


describe("per-account trade wallet persistence", () => {
  it("allows a member to save and reload only their own trade balance, holdings and history", async () => {
    const db = testEnv.authenticatedContext("wallet-owner").firestore();
    const walletRef = doc(db, "userTradeState/wallet-owner");
    const snapshot = {
      uid: "wallet-owner",
      balance: 20500,
      holdings: { USDT: 20500, BTC: 0.01 },
      history: [{ id: "trade-1", type: "quick-result", pnl: 125, status: "win" }],
      updatedAt: serverTimestamp()
    };
    await assertSucceeds(setDoc(walletRef, snapshot));
    await assertSucceeds(updateDoc(walletRef, {
      balance: 20625,
      history: [...snapshot.history, { id: "trade-2", type: "quick-result", pnl: 125, status: "win" }],
      updatedAt: serverTimestamp()
    }));
    const restored = await assertSucceeds(getDoc(walletRef));
    assert.equal(restored.data().balance, 20625);
    assert.equal(restored.data().history.length, 2);
    await assertFails(getDoc(doc(testEnv.authenticatedContext("another-member").firestore(), "userTradeState/wallet-owner")));
  });

  it("rejects another user's wallet writes, negative balances and oversized history", async () => {
    const ownerDb = testEnv.authenticatedContext("wallet-owner").firestore();
    const otherDb = testEnv.authenticatedContext("another-member").firestore();
    const walletRef = doc(ownerDb, "userTradeState/wallet-owner");
    await assertFails(setDoc(doc(otherDb, "userTradeState/wallet-owner"), {
      uid: "wallet-owner", balance: 500, holdings: {}, history: [], updatedAt: serverTimestamp()
    }));
    await assertFails(setDoc(walletRef, {
      uid: "wallet-owner", balance: -1, holdings: {}, history: [], updatedAt: serverTimestamp()
    }));
    await assertFails(setDoc(walletRef, {
      uid: "wallet-owner", balance: 100, holdings: {},
      history: Array.from({ length: 301 }, (_, i) => ({ id: String(i) })),
      updatedAt: serverTimestamp()
    }));
  });
});


describe("per-account profile avatar storage", () => {
  it("allows an account to save its own avatar and blocks changes to another profile", async () => {
    const ownerDb = testEnv.authenticatedContext("sender").firestore();
    const otherDb = testEnv.authenticatedContext("recipient").firestore();
    const avatar = "data:image/jpeg;base64,ZmFrZS1hdmF0YXI=";
    await assertSucceeds(updateDoc(doc(ownerDb, "users/sender"), {
      avatarDataUrl: avatar,
      updatedAt: serverTimestamp()
    }));
    const saved = await assertSucceeds(getDoc(doc(ownerDb, "users/sender")));
    assert.equal(saved.data().avatarDataUrl, avatar);
    await assertFails(updateDoc(doc(otherDb, "users/sender"), {
      avatarDataUrl: "data:image/jpeg;base64,b3RoZXI=",
      updatedAt: serverTimestamp()
    }));
  });
});
