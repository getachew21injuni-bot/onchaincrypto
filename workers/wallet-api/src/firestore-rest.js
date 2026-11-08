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

async function firestoreRequest(url, token, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
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

export async function withFirestoreTransaction(env, callback, maxAttempts = 3, dependencies = {}) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("Wallet database is not configured.");
  }
  const tokenProvider = dependencies.getAccessToken || getFirestoreAccessToken;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const token = await tokenProvider(env.FIREBASE_SERVICE_ACCOUNT);
  const base = `${API_ROOT}/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const started = await firestoreRequest(`${base}:beginTransaction`, token, {
      method: "POST",
      body: JSON.stringify({ options: { readWrite: {} } })
    }, fetchImpl);
    if (typeof started?.transaction !== "string") throw new Error("Firestore did not start a transaction.");

    const writes = [];
    const writtenDocuments = new Set();
    const assertReadable = () => {
      if (writes.length) throw new Error("Firestore transaction reads must happen before writes.");
    };
    const addWrite = (collection, id, write) => {
      const name = documentPath(env.FIREBASE_PROJECT_ID, collection, id);
      if (writtenDocuments.has(name)) throw new Error("A Firestore transaction cannot write the same document twice.");
      writtenDocuments.add(name);
      writes.push(write);
    };
    const tx = {
      async get(collection, id) {
        assertReadable();
        const name = documentPath(env.FIREBASE_PROJECT_ID, collection, id);
        const raw = await fetchImpl(`${base}:batchGet`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ documents: [name], transaction: started.transaction })
        });
        const rawText = await raw.text();
        if (!raw.ok) {
          let payload = null; try { payload = JSON.parse(rawText); } catch {}
          throw firestoreError(raw.status, payload);
        }
        let results;
        try { results = JSON.parse(rawText); }
        catch {
          results = rawText.split(/\\r?\\n/).filter(Boolean).map(line => JSON.parse(line));
        }
        const found = Array.isArray(results) ? results.find(item => item.found)?.found : results?.found;
        const missing = Array.isArray(results) ? results.some(item => item.missing) : Boolean(results?.missing);
        if (found) return found;
        if (missing) return null;
        throw new Error("Firestore document read returned an unexpected result.");
      },
      create(collection, id, fields, transforms = []) {
        const write = {
          update: { name: documentPath(env.FIREBASE_PROJECT_ID, collection, id), fields },
          currentDocument: { exists: false }
        };
        if (transforms.length) write.updateTransforms = transforms;
        addWrite(collection, id, write);
      },
      set(collection, id, fields, transforms = []) {
        const write = { update: { name: documentPath(env.FIREBASE_PROJECT_ID, collection, id), fields } };
        if (transforms.length) write.updateTransforms = transforms;
        addWrite(collection, id, write);
      },
      update(collection, id, fields, fieldPaths, transforms = []) {
        const write = {
          update: {
            name: documentPath(env.FIREBASE_PROJECT_ID, collection, id),
            fields
          }
        };
        if (Array.isArray(fieldPaths) && fieldPaths.length) {
          write.updateMask = { fieldPaths };
        }
        if (transforms.length) write.updateTransforms = transforms;
        addWrite(collection, id, write);
      }
    };

    try {
      const result = await callback(tx);
      if (!writes.length) {
        await firestoreRequest(`${base}:rollback`, token, {
          method: "POST",
          body: JSON.stringify({ transaction: started.transaction })
        }, fetchImpl);
        return result;
      }
      await firestoreRequest(`${base}:commit`, token, {
        method: "POST",
        body: JSON.stringify({ writes, transaction: started.transaction })
      }, fetchImpl);
      return result;
    } catch (error) {
      try {
        await firestoreRequest(`${base}:rollback`, token, {
          method: "POST",
          body: JSON.stringify({ transaction: started.transaction })
        }, fetchImpl);
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
