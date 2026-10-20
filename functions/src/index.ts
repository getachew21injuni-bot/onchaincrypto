import { initializeApp } from "firebase-admin/app";
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
