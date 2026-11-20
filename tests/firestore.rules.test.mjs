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
    await setDoc(doc(db, "users/sender"), { uid: "sender", adminAssigned: true, accountStatus: "active" });
    await setDoc(doc(db, "users/recipient"), { uid: "recipient", adminAssigned: true, accountStatus: "active" });
    await setDoc(doc(db, "userTradeState/sender"), { uid: "sender", balance: 100, holdings: {}, history: [] });
    await setDoc(doc(db, "userTradeState/recipient"), { uid: "recipient", balance: 20, holdings: {}, history: [] });
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

describe("trusted Worker-only internal USDT transfer security", () => {
  it("lets a customer submit a pending request without reading the recipient wallet", async () => {
    const requestId = await createRequest();
    const db = testEnv.authenticatedContext("sender").firestore();
    const request = await assertSucceeds(getDoc(doc(db, "internalTransferRequests", requestId)));
    assert.equal(request.data().status, "pending");
    await assertFails(getDoc(doc(db, "users/recipient")));
    await assertFails(getDoc(doc(db, "userTradeState/recipient")));
    await assertFails(getDocs(collection(db, "userDirectory")));
  });

  it("blocks customers and browser-admins from approving requests or writing either wallet", async () => {
    const requestId = await createRequest();
    const customer = testEnv.authenticatedContext("sender").firestore();
    const admin = adminDb();
    await assertFails(updateDoc(doc(customer, "internalTransferRequests", requestId), { status: "approved" }));
    await assertFails(updateDoc(doc(admin, "internalTransferRequests", requestId), { status: "approved", reviewedAt: serverTimestamp(), reviewedBy: adminEmail }));
    await assertFails(updateDoc(doc(admin, "userTradeState/sender"), { balance: 999 }));
    await assertFails(updateDoc(doc(admin, "userTradeState/recipient"), { balance: 999 }));
    await assertFails(setDoc(doc(admin, "internalTransfers", "browser-forged-transfer"), {
      senderUid: "sender", recipientUid: "recipient", asset: "USDT", amount: 10,
      senderBefore: 100, senderAfter: 90, recipientBefore: 20, recipientAfter: 30,
      senderName: "Sender", recipientName: "Recipient", transferRequestId: requestId
    }));
  });

  it("allows the trusted backend to atomically update canonical wallets and the transfer record", async () => {
    const requestId = await createRequest();
    const transferId = "transfer-" + requestId;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const backend = context.firestore();
      const requestRef = doc(backend, "internalTransferRequests", requestId);
      const senderRef = doc(backend, "userTradeState/sender");
      const recipientRef = doc(backend, "userTradeState/recipient");
      const transferRef = doc(backend, "internalTransfers", transferId);
      await runTransaction(backend, async (tx) => {
        const [request, sender, recipient] = await Promise.all([tx.get(requestRef), tx.get(senderRef), tx.get(recipientRef)]);
        const amount = Number(request.data().amount);
        const senderBefore = Number(sender.data().balance), recipientBefore = Number(recipient.data().balance);
        tx.update(senderRef, { balance: senderBefore - amount });
        tx.update(recipientRef, { balance: recipientBefore + amount });
        tx.set(transferRef, {
          senderUid: "sender", recipientUid: "recipient", asset: "USDT", amount,
          senderBefore, senderAfter: senderBefore - amount, recipientBefore, recipientAfter: recipientBefore + amount,
          transferRequestId: requestId
        });
        tx.update(requestRef, { status: "approved", reviewedBy: adminEmail, transferId });
      });
    });
    const admin = adminDb();
    const [sender, recipient, request, transfer] = await Promise.all([
      getDoc(doc(admin, "userTradeState/sender")), getDoc(doc(admin, "userTradeState/recipient")),
      getDoc(doc(admin, "internalTransferRequests", requestId)), getDoc(doc(admin, "internalTransfers", transferId))
    ]);
    assert.equal(sender.data().balance, 87.5);
    assert.equal(recipient.data().balance, 32.5);
    assert.equal(request.data().status, "approved");
    assert.equal(transfer.data().transferRequestId, requestId);
    await assertFails(updateDoc(doc(admin, "internalTransfers", transferId), { amount: 999 }));
  });

  it("rejects forged customer requests and direct ledger-only transfer records", async () => {
    const customer = testEnv.authenticatedContext("sender").firestore();
    await assertFails(setDoc(doc(collection(customer, "internalTransferRequests")), {
      senderUid: "someone-else", recipientUid: "recipient", asset: "USDT", amount: 1,
      senderName: "Fake", recipientName: "Recipient", status: "pending", createdAt: serverTimestamp()
    }));
    const admin = adminDb();
    await assertFails(setDoc(doc(collection(admin, "internalTransfers")), {
      senderUid: "sender", recipientUid: "recipient", asset: "USDT", amount: 10,
      senderBefore: 100, senderAfter: 90, recipientBefore: 20, recipientAfter: 30,
      senderName: "Sender", recipientName: "Recipient", transferRequestId: "missing-request"
    }));
  });
});


describe("administrator-initiated private support messages", () => {
  it("lets the verified admin message one registered user and lets only that user reply", async () => {
    const admin = adminDb();
    const ticketId = "admin-direct-recipient";
    const ticketRef = doc(admin, "supportTickets", ticketId);
    await assertSucceeds(setDoc(ticketRef, {
      ownerUid: "recipient",
      customerEmail: "recipient@example.com",
      customerName: "Recipient",
      subject: "Message from Onchain Support",
      status: "open",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastMessage: "Your account update is ready.",
      source: "admin-direct"
    }));
    await assertSucceeds(setDoc(doc(admin, "supportTickets", ticketId, "messages", "admin-message"), {
      senderUid: "admin",
      senderRole: "admin",
      senderName: "Onchain Support",
      text: "Your account update is ready.",
      createdAt: serverTimestamp()
    }));

    const recipient = testEnv.authenticatedContext("recipient").firestore();
    const savedTicket = await assertSucceeds(getDoc(doc(recipient, "supportTickets", ticketId)));
    assert.equal(savedTicket.data().ownerUid, "recipient");
    const messages = await assertSucceeds(getDocs(collection(recipient, "supportTickets", ticketId, "messages")));
    assert.equal(messages.size, 1);
    await assertSucceeds(setDoc(doc(recipient, "supportTickets", ticketId, "messages", "customer-reply"), {
      senderUid: "recipient",
      senderRole: "customer",
      senderName: "Recipient",
      text: "Thank you.",
      createdAt: serverTimestamp()
    }));

    const otherCustomer = testEnv.authenticatedContext("sender").firestore();
    await assertFails(getDoc(doc(otherCustomer, "supportTickets", ticketId)));
  });

  it("blocks a customer from creating an administrator-originated conversation", async () => {
    const customer = testEnv.authenticatedContext("recipient").firestore();
    await assertFails(setDoc(doc(customer, "supportTickets", "forged-admin-message"), {
      ownerUid: "sender",
      customerEmail: "sender@example.com",
      customerName: "Sender",
      subject: "Message from Onchain Support",
      status: "open",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastMessage: "Forged admin message",
      source: "admin-direct"
    }));
  });
});

describe("canonical wallet client access", () => {
  it("allows members to read their own canonical wallet but not write it", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "userTradeState/wallet-owner"), {
        uid: "wallet-owner", balance: 20500, holdings: { BTC: 0.01 },
        history: [{ id: "trade-1" }]
      });
    });
    const owner = testEnv.authenticatedContext("wallet-owner").firestore();
    const walletRef = doc(owner, "userTradeState/wallet-owner");
    const restored = await assertSucceeds(getDoc(walletRef));
    assert.equal(restored.data().balance, 20500);
    await assertFails(setDoc(walletRef, {
      uid: "wallet-owner", balance: 20625, holdings: { BTC: 0.01 }, history: [], updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(walletRef, { balance: 20625 }));
    await assertFails(getDoc(doc(testEnv.authenticatedContext("another-member").firestore(), "userTradeState/wallet-owner")));
  });

  it("blocks all client wallet writes, including verified administrator writes", async () => {
    const owner = testEnv.authenticatedContext("wallet-owner").firestore();
    const admin = adminDb();
    const wallet = doc(owner, "userTradeState/wallet-owner");
    await assertFails(setDoc(wallet, { uid: "wallet-owner", balance: 500, holdings: {}, history: [] }));
    await assertFails(setDoc(wallet, { uid: "wallet-owner", balance: -1, holdings: {}, history: [] }));
    await assertFails(updateDoc(doc(admin, "userTradeState/wallet-owner"), { balance: 999 }));
  });

  it("allows owners and admins to read their permitted append-only wallet ledger rows", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "walletLedger/ledger-sender"), { uid: "sender", type: "deposit", amount: 10 });
    });
    const sender = testEnv.authenticatedContext("sender").firestore();
    const other = testEnv.authenticatedContext("recipient").firestore();
    const admin = adminDb();
    await assertSucceeds(getDoc(doc(sender, "walletLedger/ledger-sender")));
    await assertFails(getDoc(doc(other, "walletLedger/ledger-sender")));
    await assertSucceeds(getDoc(doc(admin, "walletLedger/ledger-sender")));
    await assertFails(setDoc(doc(sender, "walletLedger/client-forged"), { uid: "sender", amount: 500 }));
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
