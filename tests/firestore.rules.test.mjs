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


describe("private account notification rules", () => {
  it("allows a member to create only their own KYC-submitted alert while KYC is pending", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "kycSubmissions/sender"), { uid: "sender", status: "pending" });
    });
    const db = testEnv.authenticatedContext("sender").firestore();
    await assertSucceeds(setDoc(doc(db, "userNotifications/sender/items/kyc-submitted"), {
      kind: "kyc_submitted", title: "Identity verification submitted",
      message: "Your identity documents are waiting for review.",
      createdAt: serverTimestamp(), createdAtText: new Date().toLocaleString(),
      readAt: null, createdBy: "sender", source: "kyc-submission"
    }));
    await assertFails(setDoc(doc(db, "userNotifications/sender/items/forged-status"), {
      kind: "account_status", title: "Account suspended", message: "Your account was suspended.",
      createdAt: serverTimestamp(), createdAtText: new Date().toLocaleString(),
      readAt: null, createdBy: "sender", source: "kyc-submission"
    }));
    await assertFails(setDoc(doc(db, "userNotifications/recipient/items/forged-kyc"), {
      kind: "kyc_submitted", title: "Identity verification submitted",
      message: "Your identity documents are waiting for review.",
      createdAt: serverTimestamp(), createdAtText: new Date().toLocaleString(),
      readAt: null, createdBy: "sender", source: "kyc-submission"
    }));
  });

  it("allows verified admins to notify a user about a support reply and blocks customer forgery", async () => {
    const admin = adminDb();
    await assertSucceeds(setDoc(doc(admin, "userNotifications/recipient/items/support-reply"), {
      kind: "support_reply", title: "New reply from Onchain Support",
      message: "Our team has replied to your conversation.",
      createdAt: serverTimestamp(), createdAtText: new Date().toLocaleString(),
      readAt: null, createdBy: "admin", source: "admin-support"
    }));
    const customer = testEnv.authenticatedContext("recipient").firestore();
    await assertFails(setDoc(doc(customer, "userNotifications/recipient/items/forged-support-reply"), {
      kind: "support_reply", title: "New reply from Onchain Support",
      message: "Forged support message.",
      createdAt: serverTimestamp(), createdAtText: new Date().toLocaleString(),
      readAt: null, createdBy: "recipient", source: "admin-support"
    }));
  });

  it("allows the verified admin to create account-status alerts and blocks customer forgery", async () => {
    const admin = adminDb();
    await assertSucceeds(setDoc(doc(admin, "userNotifications/recipient/items/account-status"), {
      kind: "account_status", title: "Account activated", message: "An administrator has activated your account.",
      createdAt: serverTimestamp(), createdAtText: new Date().toLocaleString(),
      readAt: null, createdBy: "admin", source: "admin-account-status"
    }));
    const customer = testEnv.authenticatedContext("recipient").firestore();
    await assertFails(setDoc(doc(customer, "userNotifications/recipient/items/forged-admin-status"), {
      kind: "account_status", title: "Account suspended", message: "An administrator suspended your account.",
      createdAt: serverTimestamp(), createdAtText: new Date().toLocaleString(),
      readAt: null, createdBy: "recipient", source: "admin-account-status"
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


describe("notification read-state persistence", () => {
  it("allows a member to mark their own account and market notifications as read", async () => {
    const db = testEnv.authenticatedContext("sender").firestore();
    const accountRef = doc(db, "userNotifications/sender/items/deposit-1");
    const marketReadRef = doc(db, "userNotificationReads/sender/items/market-1");
    const accountReadRef = doc(db, "userNotificationReads/sender/items/account_deposit-1");
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "userNotifications/sender/items/deposit-1"), {
        kind: "deposit", title: "Deposit received", message: "Your deposit was credited.",
        createdAt: new Date(), createdAtText: new Date().toLocaleString(),
        readAt: null, createdBy: "admin", source: "admin-demo"
      });
      await setDoc(doc(context.firestore(), "marketAlerts/market-1"), {
        kind: "bullish", title: "Market update", message: "A market update is available.",
        createdAt: new Date(), createdAtText: new Date().toLocaleString(),
        createdBy: "admin", source: "admin-manual"
      });
    });
    await assertSucceeds(updateDoc(accountRef, { readAt: serverTimestamp() }));
    await assertSucceeds(setDoc(marketReadRef, { readAt: serverTimestamp() }));
    await assertSucceeds(setDoc(accountReadRef, { readAt: serverTimestamp() }));
    const savedAccount = await assertSucceeds(getDoc(accountRef));
    const savedMarketRead = await assertSucceeds(getDoc(marketReadRef));
    const savedAccountRead = await assertSucceeds(getDoc(accountReadRef));
    assert.ok(savedAccount.data().readAt);
    assert.ok(savedMarketRead.data().readAt);
    assert.ok(savedAccountRead.data().readAt);
    const otherDb = testEnv.authenticatedContext("recipient").firestore();
    await assertFails(updateDoc(doc(otherDb, "userNotifications/sender/items/deposit-1"), { readAt: serverTimestamp() }));
    await assertFails(setDoc(doc(otherDb, "userNotificationReads/sender/items/market-1"), { readAt: serverTimestamp() }));
    await assertFails(setDoc(doc(otherDb, "userNotificationReads/sender/items/account_deposit-1"), { readAt: serverTimestamp() }));
  });

  it("keeps optimistic read state through older snapshots and recognizes legacy read flags", async () => {
    const source = await readFile("public/index.html", "utf8");
    assert.match(source, /const pendingNotificationReadKeys=new Set\(\)/);
    assert.match(source, /pendingNotificationReadKeys\.has\("account:"\+n\.id\)/);
    assert.match(source, /accountReadById\.has\("account_"\+n\.id\)/);
    assert.match(source, /type==="market"\?id:"account_"\+id/);
    assert.match(source, /pendingNotificationReadKeys\.has\("market:"\+n\.id\)/);
    assert.match(source, /n\.read===true\|\|n\.isRead===true/);
    assert.match(source, /row\.id\.startsWith\("account_"\).*row\.id\.slice\(8\).*row\.id/);
    assert.match(source, /pendingNotificationReadKeys\.delete\(\(row\.id\.startsWith\("account_"\)/);
    assert.match(source, /This notification could not be marked as read/);
  });
});
