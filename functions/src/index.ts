import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { createHash } from "node:crypto";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "us-central1", maxInstances: 5 });

const allowedTopics = new Set([
  "Account registration",
  "Sign-in problem",
  "Email verification link",
  "Password reset",
  "Website issue",
  "Other question",
]);

/**
 * Creates a private support ticket for an authenticated Firebase user.
 * The Admin SDK bypasses Firestore client rules; validate every field here.
 * This function does not send email yet and is not a payment/trading endpoint.
 */
export const createSupportTicket = onCall(
  { enforceAppCheck: true, cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in before creating a support ticket.");
    }

    const topic = typeof request.data?.topic === "string" ? request.data.topic.trim() : "";
    const subject = typeof request.data?.subject === "string" ? request.data.subject.trim() : "";
    const message = typeof request.data?.message === "string" ? request.data.message.trim() : "";

    if (!allowedTopics.has(topic)) {
      throw new HttpsError("invalid-argument", "Choose a valid support topic.");
    }
    if (subject.length < 3 || subject.length > 120) {
      throw new HttpsError("invalid-argument", "Subject must be 3–120 characters.");
    }
    if (message.length < 10 || message.length > 3000) {
      throw new HttpsError("invalid-argument", "Message must be 10–3000 characters.");
    }
    if (/(seed phrase|recovery phrase|private key|password\s*[:=]|verification code\s*[:=])/i.test(message)) {
      throw new HttpsError("invalid-argument", "Do not include passwords, verification codes, private keys, or recovery phrases.");
    }

    const ref = await db.collection("supportTickets").add({
      uid: request.auth.uid,
      email: request.auth.token.email ?? null,
      topic,
      subject,
      message,
      status: "open",
      createdAt: FieldValue.serverTimestamp(),
    });

    return { ticketId: ref.id, status: "open" };
  }
);


const supportedDepositAssets = new Set(["USDT", "BTC", "ETH", "BNB", "TRX", "SOL", "USDC"]);
const depositNetworks = new Set([
  "TRC20", "ERC20", "BEP20", "Bitcoin", "Ethereum", "Solana", "Polygon",
]);

function requireSignedIn(request: { auth?: { uid: string; token: Record<string, unknown> } | null }) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Please sign in first.");
  }
  return request.auth;
}

function requireAdmin(request: { auth?: { uid: string; token: Record<string, unknown> } | null }) {
  const auth = requireSignedIn(request);
  if (auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
  return auth;
}

/**
 * Records a user's deposit claim for manual review only.
 * It does not create a wallet address, verify blockchain transfers, or credit balances.
 */
export const createDepositRequest = onCall(
  { enforceAppCheck: true, cors: true },
  async (request) => {
    const auth = requireSignedIn(request);
    const asset = typeof request.data?.asset === "string" ? request.data.asset.trim().toUpperCase() : "";
    const network = typeof request.data?.network === "string" ? request.data.network.trim() : "";
    const txHash = typeof request.data?.txHash === "string" ? request.data.txHash.trim() : "";
    const amount = request.data?.amount;

    if (!supportedDepositAssets.has(asset)) {
      throw new HttpsError("invalid-argument", "Unsupported asset.");
    }
    if (!depositNetworks.has(network)) {
      throw new HttpsError("invalid-argument", "Unsupported network.");
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
      throw new HttpsError("invalid-argument", "Enter a valid positive amount.");
    }
    if (txHash.length < 8 || txHash.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(txHash)) {
      throw new HttpsError("invalid-argument", "Enter a valid transaction reference/hash.");
    }

    // Prevent duplicate transaction references for the same asset/network.
    const duplicate = await db.collection("depositRequests")
      .where("asset", "==", asset)
      .where("network", "==", network)
      .where("txHash", "==", txHash)
      .limit(1).get();
    if (!duplicate.empty) {
      throw new HttpsError("already-exists", "This transaction reference has already been submitted.");
    }

    const ref = await db.collection("depositRequests").add({
      uid: auth.uid,
      email: typeof auth.token.email === "string" ? auth.token.email : null,
      asset,
      network,
      amount,
      txHash,
      status: "pending_review",
      createdAt: FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null,
    });

    return { requestId: ref.id, status: "pending_review", balanceCredited: false };
  }
);

/** Returns only the signed-in user's own deposit requests. */
export const listMyDepositRequests = onCall(
  { enforceAppCheck: true, cors: true },
  async (request) => {
    const auth = requireSignedIn(request);
    const snap = await db.collection("depositRequests")
      .where("uid", "==", auth.uid)
      .limit(50).get();
    return {
      requests: snap.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          asset: data.asset,
          network: data.network,
          amount: data.amount,
          txHash: data.txHash,
          status: data.status,
          createdAt: data.createdAt?.toDate?.().toISOString?.() ?? null,
          reviewedAt: data.reviewedAt?.toDate?.().toISOString?.() ?? null,
        };
      }),
    };
  }
);

/** Admin-only list of deposit requests. Requires a server-issued custom claim: admin=true. */
export const adminListDepositRequests = onCall(
  { enforceAppCheck: true, cors: true },
  async (request) => {
    requireAdmin(request);
    const snap = await db.collection("depositRequests")
      .orderBy("createdAt", "desc")
      .limit(100).get();
    return {
      requests: snap.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          uid: data.uid,
          email: data.email,
          asset: data.asset,
          network: data.network,
          amount: data.amount,
          txHash: data.txHash,
          status: data.status,
          createdAt: data.createdAt?.toDate?.().toISOString?.() ?? null,
        };
      }),
    };
  }
);

/**
 * Admin review records a decision and audit log only. It intentionally does not credit a balance.
 * A real balance credit requires independently verified payment-provider/blockchain evidence.
 */
export const adminReviewDepositRequest = onCall(
  { enforceAppCheck: true, cors: true },
  async (request) => {
    const admin = requireAdmin(request);
    const requestId = typeof request.data?.requestId === "string" ? request.data.requestId.trim() : "";
    const decision = request.data?.decision;
    const note = typeof request.data?.note === "string" ? request.data.note.trim().slice(0, 500) : "";

    if (!/^[A-Za-z0-9_-]{10,150}$/.test(requestId)) {
      throw new HttpsError("invalid-argument", "Invalid request ID.");
    }
    if (decision !== "verified" && decision !== "rejected") {
      throw new HttpsError("invalid-argument", "Decision must be verified or rejected.");
    }

    const ref = db.collection("depositRequests").doc(requestId);
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists) {
        throw new HttpsError("not-found", "Deposit request was not found.");
      }
      const existing = snap.data();
      if (existing?.status !== "pending_review") {
        throw new HttpsError("failed-precondition", "This request has already been reviewed.");
      }
      transaction.update(ref, {
        status: decision,
        reviewNote: note,
        reviewedBy: admin.uid,
        reviewedAt: FieldValue.serverTimestamp(),
      });
      const auditRef = db.collection("adminAuditLogs").doc();
      transaction.set(auditRef, {
        adminUid: admin.uid,
        action: "deposit_request_reviewed",
        targetId: requestId,
        decision,
        note,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    return { requestId, status: decision, balanceCredited: false };
  }
);


/**
 * Permanently removes a member's sign-in and profile details while retaining
 * financial/audit records under a one-way pseudonymous reference.
 * This callable is restricted to the verified dashboard administrator.
 */
export const adminDeleteUser = onCall(
  { enforceAppCheck: false, cors: true, timeoutSeconds: 540, memory: "512MiB" },
  async (request) => {
    const admin = requireSignedIn(request);
    const adminEmail = typeof admin.token.email === "string" ? admin.token.email.toLowerCase() : "";
    if (admin.token.email_verified !== true || adminEmail !== "getachew21.inj.uni@gmail.com") {
      throw new HttpsError("permission-denied", "Verified administrator access is required.");
    }

    const targetUid = typeof request.data?.uid === "string" ? request.data.uid.trim() : "";
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(targetUid)) {
      throw new HttpsError("invalid-argument", "Select a valid user account.");
    }
    if (targetUid === admin.uid) {
      throw new HttpsError("failed-precondition", "You cannot delete the administrator account currently in use.");
    }
    if (request.data?.confirmation !== "DELETE") {
      throw new HttpsError("failed-precondition", "Deletion confirmation is required.");
    }
    const authTime = Number(admin.token.auth_time || 0);
    if (!authTime || Date.now() / 1000 - authTime > 10 * 60) {
      throw new HttpsError("failed-precondition", "For security, sign in again before deleting an account.");
    }

    const auth = getAuth();
    let targetAuth;
    try {
      targetAuth = await auth.getUser(targetUid);
    } catch {
      throw new HttpsError("not-found", "The selected sign-in account was not found.");
    }
    if (targetAuth.customClaims?.admin === true || targetAuth.email?.toLowerCase() === "getachew21.inj.uni@gmail.com") {
      throw new HttpsError("failed-precondition", "Administrator accounts cannot be deleted from this user list.");
    }

    const pseudonymousUid = "deleted_" + createHash("sha256").update(targetUid).digest("hex").slice(0, 32);
    const auditRef = db.collection("adminAuditLogs").doc();
    await auth.updateUser(targetUid, { disabled: true });
    await auditRef.set({
      adminUid: admin.uid,
      action: "user_deletion_started",
      targetReference: pseudonymousUid,
      status: "in_progress",
      createdAt: FieldValue.serverTimestamp(),
    });

    const counts: Record<string, number> = {};
    const personalFields = [
      "email", "customerEmail", "customerName", "displayName", "firstName", "lastName",
      "phone", "phoneNumber", "country", "dateOfBirth", "gender", "address",
      "avatarDataUrl", "destinationAddress", "legalName", "documentNumber",
      "documentType", "receiptImage", "receiptFileName", "timezone", "senderName",
      "recipientName", "createdByEmail",
    ];
    const financialCollections = [
      { name: "demoAssetTransactions", fields: ["uid"] },
      { name: "demoTransactions", fields: ["uid"] },
      { name: "depositRequests", fields: ["uid"] },
      { name: "withdrawRequests", fields: ["uid"] },
      { name: "internalTransferRequests", fields: ["senderUid", "recipientUid"] },
      { name: "internalTransfers", fields: ["senderUid", "recipientUid"] },
      { name: "adminActivityLogs", fields: ["uid"] },
    ];

    // Keep amounts, timestamps, statuses and transaction references; replace
    // account identifiers and remove direct personal fields from each record.
    for (const entry of financialCollections) {
      const found = new Map<string, any>();
      for (const field of entry.fields) {
        const snap = await db.collection(entry.name).where(field, "==", targetUid).get();
        for (const item of snap.docs) found.set(item.ref.path, item);
      }
      let batch = db.batch();
      let writes = 0;
      for (const item of found.values()) {
        const scrub: Record<string, unknown> = {};
        for (const field of entry.fields) {
          if (item.get(field) === targetUid) scrub[field] = pseudonymousUid;
        }
        for (const field of personalFields) scrub[field] = FieldValue.delete();
        batch.set(item.ref, scrub, { merge: true });
        writes++;
        counts[entry.name] = (counts[entry.name] || 0) + 1;
        if (writes >= 400) {
          await batch.commit();
          batch = db.batch();
          writes = 0;
        }
      }
      if (writes) await batch.commit();
    }

    // Keep the wallet snapshot for reconciliation, but detach it from the
    // deleted authentication UID and strip any profile fields.
    const tradeStateRef = db.collection("userTradeState").doc(targetUid);
    const tradeState = await tradeStateRef.get();
    if (tradeState.exists) {
      const scrub: Record<string, unknown> = { uid: pseudonymousUid };
      for (const field of personalFields) scrub[field] = FieldValue.delete();
      await tradeStateRef.set(scrub, { merge: true });
      counts.userTradeState = 1;
    }

    // Remove profile, directory, identity-verification and broker-onboarding data.
    for (const collectionName of ["users", "userDirectory", "kycSubmissions", "brokerConnectionRequests"]) {
      const ref = db.collection(collectionName).doc(targetUid);
      const snap = await ref.get();
      if (snap.exists) {
        await ref.delete();
        counts[collectionName] = 1;
      }
    }

    // Remove private support conversations and their message subcollections.
    const tickets = await db.collection("supportTickets").where("ownerUid", "==", targetUid).get();
    for (const ticket of tickets.docs) {
      const messages = await ticket.ref.collection("messages").get();
      let batch = db.batch();
      let writes = 0;
      for (const message of messages.docs) {
        batch.delete(message.ref);
        writes++;
        if (writes >= 400) {
          await batch.commit();
          batch = db.batch();
          writes = 0;
        }
      }
      if (writes) await batch.commit();
      await ticket.ref.delete();
    }
    counts.supportTickets = tickets.size;

    // Remove private account notifications.
    const notifications = await db.collection("userNotifications").doc(targetUid).collection("items").get();
    let notificationBatch = db.batch();
    let notificationWrites = 0;
    for (const item of notifications.docs) {
      notificationBatch.delete(item.ref);
      notificationWrites++;
      if (notificationWrites >= 400) {
        await notificationBatch.commit();
        notificationBatch = db.batch();
        notificationWrites = 0;
      }
    }
    if (notificationWrites) await notificationBatch.commit();
    await db.collection("userNotifications").doc(targetUid).delete().catch(() => undefined);
    counts.userNotifications = notifications.size;

    await auth.deleteUser(targetUid);
    await auditRef.update({
      action: "user_deleted",
      status: "completed",
      retainedFinancialRecordCounts: counts,
      completedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true, reference: pseudonymousUid, retainedFinancialRecordCounts: counts };
  }
);


/** Enables or disables a member's Firebase sign-in from the verified Admin panel. */
export const adminSetUserAccess = onCall(
  { enforceAppCheck: false, cors: true },
  async (request) => {
    const admin = requireSignedIn(request);
    const adminEmail = typeof admin.token.email === "string" ? admin.token.email.toLowerCase() : "";
    if (admin.token.email_verified !== true || adminEmail !== "getachew21.inj.uni@gmail.com") {
      throw new HttpsError("permission-denied", "Verified administrator access is required.");
    }
    const uid = typeof request.data?.uid === "string" ? request.data.uid.trim() : "";
    const status = request.data?.status;
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(uid) || (status !== "active" && status !== "suspended")) {
      throw new HttpsError("invalid-argument", "Choose a valid account and status.");
    }
    if (uid === admin.uid) throw new HttpsError("failed-precondition", "You cannot change access for the administrator account currently in use.");
    const auth = getAuth();
    let target;
    try { target = await auth.getUser(uid); }
    catch { throw new HttpsError("not-found", "The selected sign-in account was not found."); }
    if (target.customClaims?.admin === true || target.email?.toLowerCase() === "getachew21.inj.uni@gmail.com") {
      throw new HttpsError("failed-precondition", "Administrator account access cannot be changed here.");
    }
    await auth.updateUser(uid, { disabled: status === "suspended" });
    await db.collection("users").doc(uid).set({
      accountStatus: status,
      adminUpdatedAt: FieldValue.serverTimestamp(),
      adminUpdatedBy: adminEmail,
    }, { merge: true });
    await db.collection("adminAuditLogs").add({
      adminUid: admin.uid,
      action: status === "suspended" ? "user_access_suspended" : "user_access_reactivated",
      targetReference: "member_" + createHash("sha256").update(uid).digest("hex").slice(0, 32),
      createdAt: FieldValue.serverTimestamp(),
    });
    return { ok: true, uid, status };
  }
);
