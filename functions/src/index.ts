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
