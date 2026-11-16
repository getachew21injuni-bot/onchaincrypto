const PROJECT_ID = "onchaincrypto-d976b";
const ADMIN_EMAIL = "getachew21inj.uni@gmail.com";
const AUTH_API = "https://identitytoolkit.googleapis.com/v1";
const FIRESTORE_API = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const ALLOWED_ORIGINS = new Set([
  "https://onchainspro.com",
  "https://www.onchainspro.com",
  "https://onchaincrypto-d976b.web.app",
  "https://onchaincrypto-d976b.firebaseapp.com"
]);
const PERSONAL_FIELDS = [
  "email", "customerEmail", "customerName", "displayName", "firstName", "lastName",
  "phone", "phoneNumber", "country", "dateOfBirth", "gender", "address",
  "avatarDataUrl", "destinationAddress", "legalName", "documentNumber",
  "documentType", "receiptImage", "receiptFileName", "timezone", "senderName",
  "recipientName", "createdByEmail"
];
const FINANCIAL_COLLECTIONS = [
  { name: "demoAssetTransactions", fields: ["uid"] },
  { name: "demoTransactions", fields: ["uid"] },
  { name: "depositRequests", fields: ["uid"] },
  { name: "withdrawRequests", fields: ["uid"] },
  { name: "internalTransferRequests", fields: ["senderUid", "recipientUid"] },
  { name: "internalTransfers", fields: ["senderUid", "recipientUid"] },
  { name: "adminActivityLogs", fields: ["uid"] }
];
let jwksCache = null;
let jwksExpiresAt = 0;
let accessTokenCache = null;
let accessTokenExpiresAt = 0;

const enc = new TextEncoder();
const b64url = (bytes) => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};
const decodeB64url = (value) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};
const decodePart = (value) => JSON.parse(new TextDecoder().decode(decodeB64url(value)));
const pemToBytes = (pem) => {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return decodeB64url(body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""));
};
const timestamp = () => ({ timestampValue: new Date().toISOString() });
const str = (value) => ({ stringValue: String(value) });

function json(data, status, origin) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "vary": "Origin"
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "POST, OPTIONS";
    headers["access-control-allow-headers"] = "Authorization, Content-Type";
    headers["access-control-max-age"] = "600";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

async function verifyAdminIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid-token");
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("invalid-token");

  if (!jwksCache || Date.now() > jwksExpiresAt) {
    const response = await fetch(JWKS_URL);
    if (!response.ok) throw new Error("token-key-service-unavailable");
    jwksCache = await response.json();
    const cacheControl = response.headers.get("cache-control") || "";
    const maxAge = Number((cacheControl.match(/max-age=(\d+)/) || [])[1] || 300);
    jwksExpiresAt = Date.now() + Math.min(maxAge, 3600) * 1000;
  }
  const jwk = (jwksCache.keys || []).find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("invalid-token");
  const publicKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", publicKey, decodeB64url(parts[2]), enc.encode(parts[0] + "." + parts[1])
  );
  const now = Math.floor(Date.now() / 1000);
  if (!valid || claims.iss !== "https://securetoken.google.com/" + PROJECT_ID ||
      claims.aud !== PROJECT_ID || !claims.sub || claims.sub.length > 128 ||
      !claims.exp || claims.exp <= now || !claims.iat || claims.iat > now + 60) {
    throw new Error("invalid-token");
  }
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  const authTime = Number(claims.auth_time || 0);
  if (claims.email_verified !== true || email !== ADMIN_EMAIL ||
      !authTime || authTime > now + 60 || now - authTime > 600) {
    throw new Error("recent-admin-sign-in-required");
  }
  return { uid: claims.sub, email };
}

async function getGoogleAccessToken(env) {
  if (accessTokenCache && Date.now() < accessTokenExpiresAt) return accessTokenCache;
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error("firebase-service-account-secret-missing");
  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  if (!account.client_email || !account.private_key) throw new Error("invalid-service-account-secret");
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const jwtClaims = b64url(enc.encode(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  })));
  const unsigned = jwtHeader + "." + jwtClaims;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", pemToBytes(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, enc.encode(unsigned));
  const assertion = unsigned + "." + b64url(signature);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) throw new Error("google-service-authentication-failed");
  accessTokenCache = result.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(60, Number(result.expires_in || 3600) - 120) * 1000;
  return accessTokenCache;
}

async function googleJson(url, accessToken, body, method = "POST") {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: "Bearer " + accessToken,
      "content-type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) throw new Error("google-api-request-failed-" + response.status);
  return data;
}

async function runQuery(accessToken, collection, field, uid, parent = "") {
  const url = FIRESTORE_API + (parent ? "/" + parent : "") + ":runQuery";
  const result = await googleJson(url, accessToken, {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: {
        fieldFilter: {
          field: { fieldPath: field },
          op: "EQUAL",
          value: str(uid)
        }
      },
      limit: 1000
    }
  });
  return (Array.isArray(result) ? result : [])
    .filter((entry) => entry.document && entry.document.name)
    .map((entry) => entry.document);
}

async function listDocuments(accessToken, parentPath, collection) {
  const url = FIRESTORE_API + "/" + parentPath + "/" + collection + "?pageSize=1000";
  const response = await fetch(url, { headers: { authorization: "Bearer " + accessToken } });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error("firestore-list-failed-" + response.status);
  const result = await response.json();
  return result.documents || [];
}

async function getDocument(accessToken, path) {
  const response = await fetch(FIRESTORE_API + "/" + path, {
    headers: { authorization: "Bearer " + accessToken }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("firestore-read-failed-" + response.status);
  return response.json();
}

async function commitWrites(accessToken, writes) {
  for (let offset = 0; offset < writes.length; offset += 400) {
    await googleJson(FIRESTORE_API + ":commit", accessToken, {
      writes: writes.slice(offset, offset + 400)
    });
  }
}

function deleteWrite(name) { return { delete: name }; }
function updateWrite(name, fields, fieldPaths) {
  return { update: { name, fields }, updateMask: { fieldPaths } };
}

async function deleteAccount(request, env) {
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "origin-not-allowed" }, 403, origin);
  const authHeader = request.headers.get("authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!idToken) return json({ error: "sign-in-required" }, 401, origin);

  let admin;
  try { admin = await verifyAdminIdToken(idToken); }
  catch (error) {
    const message = error.message === "recent-admin-sign-in-required"
      ? "Please sign in again before deleting an account."
      : "Administrator authentication could not be verified.";
    return json({ error: message }, 401, origin);
  }

  let body;
  try { body = await request.json(); } catch {
    return json({ error: "Invalid request." }, 400, origin);
  }
  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(uid) || body.confirmation !== "DELETE") {
    return json({ error: "Select an account and confirm by typing DELETE." }, 400, origin);
  }
  if (uid === admin.uid) return json({ error: "You cannot delete the administrator account currently in use." }, 409, origin);

  let accessToken;
  try { accessToken = await getGoogleAccessToken(env); }
  catch { return json({ error: "The secure Firebase service connection is not configured correctly." }, 503, origin); }

  let auditName = "";
  let stage = "account-check";
  try {
    const accountInfo = await googleJson(AUTH_API + "/accounts:lookup", accessToken, {
      localId: [uid], targetProjectId: PROJECT_ID
    });
    const target = (accountInfo.users || [])[0];
    if (!target) return json({ error: "The selected sign-in account was not found." }, 404, origin);
    let customClaims = {};
    try { customClaims = target.customAttributes ? JSON.parse(target.customAttributes) : {}; } catch {}
    if (customClaims.admin === true || String(target.email || "").toLowerCase() === ADMIN_EMAIL) {
      return json({ error: "Administrator accounts cannot be deleted from this member list." }, 409, origin);
    }

    // Read and preflight all records before changing account access.
    const pseudonymousUid = "deleted_" + await sha256(uid);
    stage = "preflight-financial-records";
    const financialDocs = new Map();
    for (const entry of FINANCIAL_COLLECTIONS) {
      const found = new Map();
      for (const field of entry.fields) {
        const docs = await runQuery(accessToken, entry.name, field, uid);
        if (docs.length >= 1000) throw new Error("record-limit-exceeded");
        for (const doc of docs) found.set(doc.name, doc);
      }
      for (const [name, doc] of found) {
        const fields = {};
        const mask = new Set([...entry.fields, ...PERSONAL_FIELDS]);
        for (const field of entry.fields) {
          if (doc.fields?.[field]?.stringValue === uid) fields[field] = str(pseudonymousUid);
        }
        financialDocs.set(name, updateWrite(name, fields, [...mask]));
      }
    }
    if (financialDocs.size > 2000) throw new Error("record-limit-exceeded");

    stage = "preflight-private-records";
    const ticketMap = new Map();
    for (const ownerField of ["ownerUid", "uid"]) {
      const tickets = await runQuery(accessToken, "supportTickets", ownerField, uid);
      if (tickets.length >= 10) throw new Error("support-ticket-limit-exceeded");
      for (const ticket of tickets) ticketMap.set(ticket.name, ticket);
    }
    const messageNames = [];
    for (const ticket of ticketMap.values()) {
      const ticketPath = ticket.name.split("/documents/")[1];
      const messages = await listDocuments(accessToken, ticketPath, "messages");
      if (messages.length >= 1000) throw new Error("private-record-limit-exceeded");
      messageNames.push(...messages.map((item) => item.name));
      if (messageNames.length > 1000) throw new Error("private-record-limit-exceeded");
    }
    const notifications = await listDocuments(accessToken, "userNotifications/" + uid, "items");
    if (notifications.length >= 1000) throw new Error("private-record-limit-exceeded");
    const tradeState = await getDocument(accessToken, "userTradeState/" + uid);

    const auditId = crypto.randomUUID();
    auditName = `projects/${PROJECT_ID}/databases/(default)/documents/adminAuditLogs/${auditId}`;
    stage = "audit-start";
    await commitWrites(accessToken, [{
      update: {
        name: auditName,
        fields: {
          adminUid: str(admin.uid),
          action: str("user_deletion_started"),
          targetReference: str(pseudonymousUid),
          status: str("in_progress"),
          createdAt: timestamp()
        }
      }
    }]);

    stage = "disable-account";
    await googleJson(AUTH_API + "/accounts:update", accessToken, {
      localId: uid, disableUser: true, targetProjectId: PROJECT_ID
    });

    stage = "scrub-financial-records";
    await commitWrites(accessToken, [...financialDocs.values()]);

    stage = "remove-private-and-profile-records";
    const deleteWrites = [
      "users", "userDirectory", "kycSubmissions", "brokerConnectionRequests"
    ].map((collection) => deleteWrite(
      `projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${uid}`
    ));
    for (const name of messageNames) deleteWrites.push(deleteWrite(name));
    for (const ticket of ticketMap.values()) deleteWrites.push(deleteWrite(ticket.name));
    for (const item of notifications) deleteWrites.push(deleteWrite(item.name));
    deleteWrites.push(deleteWrite(
      `projects/${PROJECT_ID}/databases/(default)/documents/userNotifications/${uid}`
    ));
    await commitWrites(accessToken, deleteWrites);

    if (tradeState) {
      const fields = { ...(tradeState.fields || {}) };
      for (const field of PERSONAL_FIELDS) delete fields[field];
      fields.uid = str(pseudonymousUid);
      const mask = [...new Set([...Object.keys(tradeState.fields || {}), ...PERSONAL_FIELDS, "uid"])];
      stage = "preserve-wallet-ledger";
      await commitWrites(accessToken, [
        updateWrite(
          `projects/${PROJECT_ID}/databases/(default)/documents/userTradeState/${pseudonymousUid}`,
          fields,
          mask
        ),
        deleteWrite(tradeState.name)
      ]);
    }

    stage = "delete-auth-account";
    await googleJson(AUTH_API + "/accounts:delete", accessToken, {
      localId: uid, targetProjectId: PROJECT_ID
    });

    stage = "audit-complete";
    await commitWrites(accessToken, [{
      update: {
        name: auditName,
        fields: {
          action: str("user_deleted"),
          status: str("completed"),
          completedAt: timestamp(),
          retainedFinancialRecordCount: { integerValue: String(financialDocs.size) },
          deletedSupportTicketCount: { integerValue: String(ticketMap.size) },
          deletedSupportMessageCount: { integerValue: String(messageNames.length) },
          deletedNotificationCount: { integerValue: String(notifications.length) }
        }
      },
      updateMask: {
        fieldPaths: [
          "action", "status", "completedAt", "retainedFinancialRecordCount",
          "deletedSupportTicketCount", "deletedSupportMessageCount", "deletedNotificationCount"
        ]
      }
    }]);
    return json({
      ok: true,
      message: "The member account was deleted. Financial records were retained under a pseudonymous reference.",
      reference: pseudonymousUid,
      retainedFinancialRecordCount: financialDocs.size
    }, 200, origin);
  } catch (error) {
    if (auditName && accessToken) {
      try {
        await commitWrites(accessToken, [{
          update: {
            name: auditName,
            fields: {
              status: str("failed"),
              failureStage: str(stage),
              failedAt: timestamp()
            }
          },
          updateMask: { fieldPaths: ["status", "failureStage", "failedAt"] }
        }]);
      } catch {}
    }
    const limitError = ["record-limit-exceeded", "support-ticket-limit-exceeded", "private-record-limit-exceeded"].includes(error.message);
    return json({
      error: limitError
        ? "This account has more records than the safe one-request cleanup limit. No deletion was started."
        : "Account deletion could not be completed. The member may have been disabled; check the admin audit log before retrying.",
      stage,
      auditId: auditName ? auditName.split("/").pop() : undefined
    }, limitError ? 409 : 500, origin);
  }
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") {
      if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin || "https://www.onchainspro.com",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type",
          "access-control-max-age": "600",
          "vary": "Origin"
        }
      });
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "onchainspro-admin-api" }, 200, origin);
    }
    if (request.method !== "POST" || url.pathname !== "/admin/delete-user") {
      return json({ error: "Not found." }, 404, origin);
    }
    return deleteAccount(request, env);
  }
};
