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
let testEnv;

before(async () => {
  const rules = await readFile("firestore.rules", "utf8");
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { rules }
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "users/sender"), {
      uid: "sender",
      adminAssigned: true,
      demoBalanceUSDT: 100,
      accountStatus: "active"
    });
    await setDoc(doc(db, "users/recipient"), {
      uid: "recipient",
      adminAssigned: true,
      demoBalanceUSDT: 20,
      accountStatus: "active"
    });
  });
});

describe("internal USDT transfer security", () => {
  it("allows one atomic transfer and records matching balances", async () => {
    const db = testEnv.authenticatedContext("sender").firestore();
    const senderRef = doc(db, "users/sender");
    const recipientRef = doc(db, "users/recipient");
    const transferRef = doc(collection(db, "internalTransfers"));

    await assertSucceeds(runTransaction(db, async (transaction) => {
      const senderSnap = await transaction.get(senderRef);
      const recipientSnap = await transaction.get(recipientRef);
      const amount = 12.5;
      const senderBefore = senderSnap.data().demoBalanceUSDT;
      const recipientBefore = recipientSnap.data().demoBalanceUSDT;
      transaction.update(senderRef, {
        demoBalanceUSDT: senderBefore - amount,
        demoBalanceUpdatedAt: serverTimestamp(),
        demoBalanceLastTransferId: transferRef.id
      });
      transaction.update(recipientRef, {
        demoBalanceUSDT: recipientBefore + amount,
        demoBalanceUpdatedAt: serverTimestamp(),
        demoBalanceLastTransferId: transferRef.id
      });
      transaction.set(transferRef, {
        senderUid: "sender",
        recipientUid: "recipient",
        asset: "USDT",
        amount,
        senderBefore,
        senderAfter: senderBefore - amount,
        recipientBefore,
        recipientAfter: recipientBefore + amount,
        senderName: "Sender",
        recipientName: "Recipient",
        createdAt: serverTimestamp()
      });
    }));

    const sender = await assertSucceeds(getDoc(senderRef));
    const recipient = await assertSucceeds(getDoc(recipientRef));
    const ledger = await assertSucceeds(getDoc(transferRef));
    assert.equal(sender.data().demoBalanceUSDT, 87.5);
    assert.equal(recipient.data().demoBalanceUSDT, 32.5);
    assert.equal(ledger.data().amount, 12.5);
  });

  it("blocks a direct balance change without a transfer ledger", async () => {
    const db = testEnv.authenticatedContext("sender").firestore();
    await assertFails(updateDoc(doc(db, "users/sender"), {
      demoBalanceUSDT: 999,
      demoBalanceUpdatedAt: serverTimestamp(),
      demoBalanceLastTransferId: "forged-transfer"
    }));
  });

  it("blocks a ledger-only transfer without both balance updates", async () => {
    const db = testEnv.authenticatedContext("sender").firestore();
    const transferRef = doc(collection(db, "internalTransfers"));
    await assertFails(setDoc(transferRef, {
      senderUid: "sender",
      recipientUid: "recipient",
      asset: "USDT",
      amount: 10,
      senderBefore: 100,
      senderAfter: 90,
      recipientBefore: 20,
      recipientAfter: 30,
      senderName: "Sender",
      recipientName: "Recipient",
      createdAt: serverTimestamp()
    }));
  });

  it("blocks a transfer larger than the sender balance", async () => {
    const db = testEnv.authenticatedContext("sender").firestore();
    const senderRef = doc(db, "users/sender");
    const recipientRef = doc(db, "users/recipient");
    const transferRef = doc(collection(db, "internalTransfers"));

    await assertFails(runTransaction(db, async (transaction) => {
      const senderSnap = await transaction.get(senderRef);
      const recipientSnap = await transaction.get(recipientRef);
      const amount = 101;
      transaction.update(senderRef, {
        demoBalanceUSDT: senderSnap.data().demoBalanceUSDT - amount,
        demoBalanceUpdatedAt: serverTimestamp(),
        demoBalanceLastTransferId: transferRef.id
      });
      transaction.update(recipientRef, {
        demoBalanceUSDT: recipientSnap.data().demoBalanceUSDT + amount,
        demoBalanceUpdatedAt: serverTimestamp(),
        demoBalanceLastTransferId: transferRef.id
      });
      transaction.set(transferRef, {
        senderUid: "sender",
        recipientUid: "recipient",
        asset: "USDT",
        amount,
        senderBefore: 100,
        senderAfter: -1,
        recipientBefore: 20,
        recipientAfter: 121,
        senderName: "Sender",
        recipientName: "Recipient",
        createdAt: serverTimestamp()
      });
    }));
  });

  it("keeps customer profiles private and prevents directory enumeration", async () => {
    const db = testEnv.authenticatedContext("sender").firestore();
    await assertFails(getDoc(doc(db, "users/recipient")));
    await assertFails(getDocs(collection(db, "userDirectory")));
  });

  it("does not allow users to modify or delete transfer history", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "internalTransfers/existing"), {
        senderUid: "sender",
        recipientUid: "recipient"
      });
    });
    const db = testEnv.authenticatedContext("sender").firestore();
    await assertFails(updateDoc(doc(db, "internalTransfers/existing"), {
      amount: 999
    }));
  });
});
