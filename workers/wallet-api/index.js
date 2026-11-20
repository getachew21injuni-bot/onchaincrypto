// Read-only administrator wallet reconciliation endpoint.
// This Worker never writes to Firestore.
const PROJECT_ID = "onchaincrypto-d976b";
const FIREBASE_ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const FIREBASE_JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const DEFAULT_ADMIN_EMAILS = ["getachew21.inj.uni@gmail.com", "getachew21.INJ.UNI@gmail.com"];

function b64url(input) {
  return btoa(String.fromCharCode(...new Uint8Array(input)))
    .replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}
function decodeB64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
function decodeJsonPart(part) {
  return JSON.parse(new TextDecoder().decode(decodeB64url(part)));
}
function pemToDer(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\\s/g, "");
  return decodeB64url(body.replace(/\\+/g, "-").replace(/\\//g, "_"));
}
async function verifyFirebaseIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid bearer token.");
  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported token signature.");
  const response = await fetch(FIREBASE_JWKS, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error("Could not retrieve Firebase signing keys.");
  const jwks = await response.json();
  const jwk = jwks.keys.find(key => key.kid === header.kid && key.alg === "RS256");
  if (!jwk) throw new Error("Unknown Firebase signing key.");
  const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, decodeB64url(parts[2]), signed);
  if (!valid) throw new Error("Invalid Firebase token signature.");
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== FIREBASE_ISSUER || claims.aud !== PROJECT_ID ||
      typeof claims.sub !== "string" || !claims.sub ||
      typeof claims.exp !== "number" || claims.exp <= now ||
      typeof claims.iat !== "number" || claims.iat > now + 60 ||
      now - claims.iat > 3600) {
    throw new Error("Firebase token claims are invalid or expired.");
  }
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  const allowed = (DEFAULT_ADMIN_EMAILS.concat((globalThis.__unused || []))).map(v => String(v).toLowerCase());
  const configured = (globalThis.__adminEmails || []);
  const admins = allowed.concat(configured.map(v => String(v).toLowerCase()));
  if (claims.admin !== true && !(claims.email_verified === true && admins.includes(email))) {
    throw new Error("Administrator access is required.");
  }
  return claims;
}
async function serviceAccessToken(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error("Worker service-account secret is missing.");
  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  if (!account.client_email || !account.private_key || account.project_id !== PROJECT_ID) {
    throw new Error("Worker service-account configuration is invalid.");
  }
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })));
  const unsigned = head + "." + payload;
  const privateKey = await crypto.subtle.importKey("pkcs8", pemToDer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsigned));
  const assertion = unsigned + "." + b64url(signature);
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form
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
  return value;
}
function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [key, decodeValue(value)]));
}
function encodeString(value) { return { stringValue: value }; }
async function firestoreGet(accessToken, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
  const response = await fetch(url, { headers: { authorization: "Bearer " + accessToken } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Firestore document read failed.");
  const doc = await response.json();
  return { id: doc.name.split("/").pop(), ...decodeFields(doc.fields || {}) };
}
async function firestoreQuery(accessToken, collection, field, value) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: encodeString(value) } },
      limit: 500
    }
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error("Firestore query failed for " + collection + ".");
  const rows = await response.json();
  return rows.filter(row => row.document).map(row => {
    const doc = row.document;
    return { id: doc.name.split("/").pop(), ...decodeFields(doc.fields || {}) };
  });
}
async function reconcile(env, uid) {
  const token = await serviceAccessToken(env);
  const [profile, wallet, adminUSDT, adminAssets, sent, received, deposits, withdrawals, sentRequests, receivedRequests] = await Promise.all([
    firestoreGet(token, `users/${uid}`),
    firestoreGet(token, `userTradeState/${uid}`),
    firestoreQuery(token, "demoTransactions", "uid", uid),
    firestoreQuery(token, "demoAssetTransactions", "uid", uid),
    firestoreQuery(token, "internalTransfers", "senderUid", uid),
    firestoreQuery(token, "internalTransfers", "recipientUid", uid),
    firestoreQuery(token, "depositRequests", "uid", uid),
    firestoreQuery(token, "withdrawRequests", "uid", uid),
    firestoreQuery(token, "internalTransferRequests", "senderUid", uid),
    firestoreQuery(token, "internalTransferRequests", "recipientUid", uid)
  ]);
  const profileBalance = typeof profile?.demoBalanceUSDT === "number" ? profile.demoBalanceUSDT : null;
  const walletBalance = typeof wallet?.balance === "number" ? wallet.balance : null;
  return {
    readOnly: true,
    uid,
    balances: {
      profileDemoBalanceUSDT: profileBalance,
      walletBalanceUSDT: walletBalance,
      walletMinusProfileUSDT: profileBalance === null || walletBalance === null ? null : Number((walletBalance - profileBalance).toFixed(8))
    },
    timestamps: {
      profileBalanceUpdatedAt: profile?.demoBalanceUpdatedAt || profile?.adminUpdatedAt || null,
      walletUpdatedAt: wallet?.updatedAt || null
    },
    wallet: wallet ? { balance: wallet.balance, holdings: wallet.holdings || {}, history: wallet.history || [] } : null,
    profile: profile ? {
      demoBalanceUSDT: profile.demoBalanceUSDT ?? null,
      demoAssetBalances: profile.demoAssetBalances || {},
      demoBalanceUpdatedAt: profile.demoBalanceUpdatedAt || null,
      demoAssetBalancesUpdatedAt: profile.demoAssetBalancesUpdatedAt || null,
      adminUpdatedAt: profile.adminUpdatedAt || null,
      adminUpdatedBy: profile.adminUpdatedBy || null
    } : null,
    records: {
      adminUSDTTransactions: adminUSDT,
      adminAssetTransactions: adminAssets,
      outgoingTransfers: sent,
      incomingTransfers: received,
      depositRequests: deposits,
      withdrawalRequests: withdrawals,
      outgoingTransferRequests: sentRequests,
      incomingTransferRequests: receivedRequests
    },
    limits: { maxRecordsPerQuery: 500 },
    warnings: [
      "Read-only report: no Firestore documents were changed.",
      "Requests are not proof of a completed on-chain deposit or payout.",
      "A balance difference does not establish which balance is correct.",
      "Queries are capped at 500 records per collection and may require pagination for older accounts."
    ]
  };
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://onchaincrypto-d976b.web.app";
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": allowedOrigin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
      "vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (origin && origin !== allowedOrigin) return new Response(JSON.stringify({ error: "Origin not allowed." }), { status: 403, headers });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ ok: true, mode: "read-only-reconciliation" }), { headers });
    }
    if (url.pathname !== "/admin/reconcile" || request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Not found." }), { status: 404, headers });
    }
    try {
      const authorization = request.headers.get("Authorization") || "";
      if (!authorization.startsWith("Bearer ")) throw new Error("Firebase sign-in token is required.");
      const claims = await verifyFirebaseIdToken(authorization.slice(7));
      const body = await request.json();
      const uid = typeof body.uid === "string" ? body.uid : "";
      if (!uid || uid.length > 128 || uid.includes("/")) throw new Error("A valid target user UID is required.");
      const report = await reconcile(env, uid);
      return new Response(JSON.stringify(report), { status: 200, headers });
    } catch (error) {
      const message = error?.message || "Request failed.";
      const status = /administrator access|token|bearer|origin/i.test(message) ? 403 : 400;
      return new Response(JSON.stringify({ error: message }), { status, headers });
    }
  }
};
