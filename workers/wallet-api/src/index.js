import { verifyFirebaseIdToken } from "./auth.js";

const ALLOWED_ORIGINS = new Set([
  "https://onchaincrypto-d976b.web.app",
  "https://onchaincrypto-d976b.firebaseapp.com",
  "https://onchainspro.com",
  "https://www.onchainspro.com"
]);

function response(data, status, origin) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Idempotency-Key";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function getOrigin(request) {
  return request.headers.get("Origin") || "";
}

async function requireUser(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Sign in is required.");
  return verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
}

export default {
  async fetch(request, env) {
    const origin = getOrigin(request);
    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) return response({ error: "Origin not allowed." }, 403, "");
      return response({}, 204, origin);
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return response({ status: "online", service: "OnChainCrypto Wallet API", projectConfigured: Boolean(env.FIREBASE_PROJECT_ID), serviceCredentialConfigured: Boolean(env.FIREBASE_SERVICE_ACCOUNT), stage: "authentication-scaffold" }, 200, origin);
    }

    if (request.method === "POST" && ["/v1/wallet/operation", "/v1/trade/execute"].includes(url.pathname)) {
      try {
        if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT) {
          return response({ error: "Wallet service is not configured." }, 503, origin);
        }
        const user = await requireUser(request, env);
        // Intentionally fail closed until the Firestore transaction engine is added.
        // No balance or ledger writes are performed by this scaffold.
        return response({ error: "Wallet transaction engine is not enabled yet.", code: "BACKEND_NOT_READY", uid: user.uid }, 501, origin);
      } catch (error) {
        return response({ error: error?.message || "Request could not be authenticated." }, 401, origin);
      }
    }

    return response({ error: "Not found." }, 404, origin);
  }
};
