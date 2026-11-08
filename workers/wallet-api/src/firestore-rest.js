import { getFirestoreAccessToken } from "./google-auth.js";

const API_ROOT = "https://firestore.googleapis.com/v1";

function documentPath(projectId, collection, documentId) {
  for (const part of [projectId, collection, documentId]) {
    if (typeof part !== "string" || !part || part.includes("/") || part.includes("..")) {
      throw new Error("Invalid Firestore document path.");
    }
  }
  return `projects/${projectId}/databases/(default)/documents/${collection}/${documentId}`;
}

function firestoreError(status, payload) {
  const code = payload?.error?.status || payload?.error?.code || "UNKNOWN";
  const message = payload?.error?.message || "Firestore request failed.";
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function firestoreRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { throw new Error("Firestore returned an unreadable response."); }
  }
  if (!response.ok) throw firestoreError(response.status, payload);
  return payload;
}

export async function withFirestoreTransaction(env, callback, maxAttempts = 3) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("Wallet database is not configured.");
  }
  const token = await getFirestoreAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
  const base = `${API_ROOT}/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const started = await firestoreRequest(`${base}:beginTransaction`, token, {
      method: "POST",
      body: JSON.stringify({ options: { readWrite: {} } })
    });
    if (typeof started?.transaction !== "string") throw new Error("Firestore did not start a transaction.");

    const writes = [];
    const tx = {
      async get(collection, id) {
        const name = documentPath(env.FIREBASE_PROJECT_ID, collection, id);
        const results = await firestoreRequest(`${base}:batchGet`, token, {
          method: "POST",
          body: JSON.stringify({ documents: [name], transaction: started.transaction })
        });
        const found = Array.isArray(results) ? results.find(item => item.found)?.found : null;
        const missing = Array.isArray(results) ? results.some(item => item.missing) : false;
        if (found) return found;
        if (missing) return null;
        throw new Error("Firestore document read returned an unexpected result.");
      },
      create(collection, id, fields) {
        writes.push({
          update: {
            name: documentPath(env.FIREBASE_PROJECT_ID, collection, id),
            fields
          },
          currentDocument: { exists: false }
        });
      },
      set(collection, id, fields) {
        writes.push({
          update: {
            name: documentPath(env.FIREBASE_PROJECT_ID, collection, id),
            fields
          }
        });
      },
      update(collection, id, fields, fieldPaths) {
        const write = {
          update: {
            name: documentPath(env.FIREBASE_PROJECT_ID, collection, id),
            fields
          }
        };
        if (Array.isArray(fieldPaths) && fieldPaths.length) {
          write.updateMask = { fieldPaths };
        }
        writes.push(write);
      }
    };

    try {
      const result = await callback(tx);
      if (!writes.length) {
        await firestoreRequest(`${base}:rollback`, token, {
          method: "POST",
          body: JSON.stringify({ transaction: started.transaction })
        });
        return result;
      }
      await firestoreRequest(`${base}:commit`, token, {
        method: "POST",
        body: JSON.stringify({ writes, transaction: started.transaction })
      });
      return result;
    } catch (error) {
      try {
        await firestoreRequest(`${base}:rollback`, token, {
          method: "POST",
          body: JSON.stringify({ transaction: started.transaction })
        });
      } catch { /* The transaction may already have expired or aborted. */ }
      if ((error.code === "ABORTED" || error.status === 409) && attempt + 1 < maxAttempts) continue;
      throw error;
    }
  }
  throw new Error("Wallet transaction could not be completed. Please retry.");
}

export function firestoreString(value) {
  return { stringValue: String(value) };
}

export function firestoreInteger(value) {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid integer field.");
  return { integerValue: String(value) };
}

export function firestoreTimestamp(value = new Date()) {
  return { timestampValue: value.toISOString() };
}
