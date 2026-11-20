// Read-only administrator wallet reconciliation endpoint.
// This Worker performs Firestore reads only. It contains no Firestore write API calls.
import { buildWalletReconciliationReport } from "./reconciliation.js";

const PROJECT_ID = "onchaincrypto-d976b";
const FIREBASE_ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const FIREBASE_JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const FIRESTORE_ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Malformed token encoding.");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}
function decodeJsonPart(part) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(part)));
}
function pemToDer(pem) {
  if (typeof pem !== "string") throw new Error("Service-account private key is missing.");
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const normalized = body.replace(/\+/g, "-").replace(/\//g, "_");
  return decodeBase64Url(normalized);
}
async function verifyFirebaseIdToken(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid bearer token.");
  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported token signature.");
  const response = await fetch(FIREBASE_JWKS, { cf: { cacheTtl: 300 } });
  if (!response.ok) throw new Error("Could not retrieve Firebase signing keys.");
  const jwks = await response.json();
  const jwk = jwks.keys?.find(key => key.kid === header.kid && key.alg === "RS256");
  if (!jwk) throw new Error("Unknown Firebase signing key.");
  const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, decodeBase64Url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!valid) throw new Error("Invalid Firebase token signature.");

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== FIREBASE_ISSUER || claims.aud !== PROJECT_ID ||
      typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128 ||
      typeof claims.exp !== "number" || claims.exp <= now ||
      typeof claims.iat !== "number" || claims.iat > now + 60 ||
      now - claims.iat > 3600 ||
      (claims.auth_time != null && (typeof claims.auth_time !== "number" || claims.auth_time > now + 60))) {
    throw new Error("Firebase token claims are invalid or expired.");
  }

  const configuredAdmins = String(env.ADMIN_EMAILS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  const isAllowlistedAdmin = claims.email_verified === true && email !== "" && configuredAdmins.includes(email);
  if (claims.admin !== true && !isAllowlistedAdmin) throw new Error("Administrator access is required.");
  return claims;
}
async function serviceAccessToken(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error("Worker service-account secret is missing.");
  let account;
  try { account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); }
  catch { throw new Error("Worker service-account secret is not valid JSON."); }
  if (!account.client_email || !account.private_key || account.project_id !== PROJECT_ID) {
    throw new Error("Worker service-account configuration is invalid.");
  }
  const now = Math.floor(Date.now() / 1000);
  const head = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })));
  const unsigned = head + "." + payload;
  const privateKey = await crypto.subtle.importKey("pkcs8", pemToDer(account.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsigned));
  const assertion = unsigned + "." + bytesToBase64Url(signature);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  if (!response.ok) throw new Error("Google service-account authentication failed.");
  const data = await response.json();
  if (!data.access_token) throw new Error("Google did not return an access token.");
  return data.access_token;
}
function decodeValue(value) {
  if (!value || typeof value !== "object") return value;
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields || {});
  return null;
}
function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [key, decodeValue(value)]));
}
async function firestoreGet(accessToken, path) {
  const response = await fetch(`${FIRESTORE_ROOT}/${path}`, { headers: { authorization: "Bearer " + accessToken } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Firestore document read failed.");
  const doc = await response.json();
  return { id: doc.name.split("/").pop(), ...decodeFields(doc.fields || {}) };
}
async function firestoreQuery(accessToken, collection, field, value) {
  const response = await fetch(FIRESTORE_ROOT + ":runQuery", {
    method: "POST",
    headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } },
        limit: 500
      }
    })
  });
  if (!response.ok) throw new Error("Firestore query failed for " + collection + ".");
  const rows = await response.json();
  return rows.filter(row => row.document).map(row => {
    const doc = row.document;
    return { id: doc.name.split("/").pop(), ...decodeFields(doc.fields || {}) };
  });
}
async function reconcile(env, uid) {
  const accessToken = await serviceAccessToken(env);
  const [profile, wallet, adminUSDT, adminAssets, sent, received, deposits, withdrawals, sentRequests, receivedRequests] = await Promise.all([
    firestoreGet(accessToken, `users/${uid}`),
    firestoreGet(accessToken, `userTradeState/${uid}`),
    firestoreQuery(accessToken, "demoTransactions", "uid", uid),
    firestoreQuery(accessToken, "demoAssetTransactions", "uid", uid),
    firestoreQuery(accessToken, "internalTransfers", "senderUid", uid),
    firestoreQuery(accessToken, "internalTransfers", "recipientUid", uid),
    firestoreQuery(accessToken, "depositRequests", "uid", uid),
    firestoreQuery(accessToken, "withdrawRequests", "uid", uid),
    firestoreQuery(accessToken, "internalTransferRequests", "senderUid", uid),
    firestoreQuery(accessToken, "internalTransferRequests", "recipientUid", uid)
  ]);

  const transfers = [...sent, ...received];
  const report = buildWalletReconciliationReport({
    uid,
    profile,
    wallet,
    demoTransactions: adminUSDT,
    tradeHistory: Array.isArray(wallet?.history) ? wallet.history : [],
    transfers,
    depositRequests: deposits,
    withdrawRequests: withdrawals
  });
  return {
    ...report,
    timestamps: {
      profileBalanceUpdatedAt: profile?.demoBalanceUpdatedAt || profile?.adminUpdatedAt || null,
      walletUpdatedAt: wallet?.updatedAt || null
    },
    evidenceCounts: {
      ...report.evidenceCounts,
      adminAssetLedgerEntries: adminAssets.length,
      incomingTransferRequests: receivedRequests.length,
      outgoingTransferRequests: sentRequests.length,
      depositRequestsTotal: deposits.length,
      withdrawalRequestsTotal: withdrawals.length
    },
    queryLimits: { maxRecordsPerCollection: 500, mayBeTruncated: true },
    warnings: [
      ...report.limitations,
      "Queries are capped at 500 records per collection; older records may be omitted.",
      "Asset-ledger and request records are counted but are not treated as completed balance changes."
    ]
  };
}
function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders } });
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = String(env.ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
    if (origin && !allowedOrigins.includes(origin)) return json({ error: "Origin not allowed." }, 403, { vary: "Origin" });
    const cors = origin ? {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-max-age": "600",
      "vary": "Origin"
    } : {};
    if (request.method === "OPTIONS") return new Response(null, { status: origin && allowedOrigins.includes(origin) ? 204 : 403, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, mode: "read-only-reconciliation" }, 200, cors);
    }
    if (url.pathname !== "/admin/reconcile" || request.method !== "POST") return json({ error: "Not found." }, 404, cors);
    try {
      const authorization = request.headers.get("Authorization") || "";
      if (!authorization.startsWith("Bearer ")) throw new Error("Firebase sign-in token is required.");
      const claims = await verifyFirebaseIdToken(authorization.slice(7), env);
      const body = await request.json();
      const uid = typeof body.uid === "string" ? body.uid.trim() : "";
      if (!uid || uid.length > 128 || uid.includes("/") || uid !== claims.sub && claims.admin !== true) {
        throw new Error("A valid target user UID is required.");
      }
      const report = await reconcile(env, uid);
      return json(report, 200, cors);
    } catch (error) {
      const message = error?.message || "Request failed.";
      const status = /administrator access|token|bearer|origin/i.test(message) ? 403 : 400;
      return json({ error: message }, status, cors);
    }
  }
};
