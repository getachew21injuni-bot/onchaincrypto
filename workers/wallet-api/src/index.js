// Standard Buy/Sell Worker entry point; bundled for the Cloudflare dashboard editor.
import { verifyFirebaseIdToken } from "./auth.js";
import { executeStandardTrade } from "./trades.js";
import { readWalletAccount } from "./accounts.js";

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
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers });
}
function getOrigin(request) { return request.headers.get("Origin") || ""; }
async function requireUser(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error("Sign in is required."); error.status = 401; error.code = "UNAUTHENTICATED"; throw error;
  }
  try { return await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID); }
  catch {
    const error = new Error("Your sign-in session is invalid or expired. Sign in again.");
    error.status = 401; error.code = "UNAUTHENTICATED"; throw error;
  }
}
async function readJson(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.toLowerCase().includes("application/json")) {
    const error = new Error("Send the trade request as JSON."); error.status = 415; error.code = "UNSUPPORTED_MEDIA_TYPE"; throw error;
  }
  const raw = await request.text();
  if (raw.length > 8192) {
    const error = new Error("Trade request is too large."); error.status = 413; error.code = "REQUEST_TOO_LARGE"; throw error;
  }
  try { return JSON.parse(raw); }
  catch { const error = new Error("Trade request is not valid JSON."); error.status = 400; error.code = "INVALID_JSON"; throw error; }
}
export default {
  async fetch(request, env) {
    const origin = getOrigin(request);
    if (origin && !ALLOWED_ORIGINS.has(origin)) return response({ error: "Origin not allowed." }, 403, "");
    if (request.method === "OPTIONS") return response({}, 204, origin);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return response({
        status: "online", service: "OnChainCrypto Wallet API",
        projectConfigured: Boolean(env.FIREBASE_PROJECT_ID),
        serviceCredentialConfigured: Boolean(env.FIREBASE_SERVICE_ACCOUNT),
        stage: "standard-buy-sell"
      }, 200, origin);
    }
    if (request.method === "GET" && url.pathname === "/v1/wallet/account") {
      try {
        if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT) {
          const error = new Error("Wallet service is not configured."); error.status = 503; error.code = "SERVICE_NOT_CONFIGURED"; throw error;
        }
        const user = await requireUser(request, env);
        const account = await readWalletAccount(user, env);
        return response({ ok: true, ...account }, 200, origin);
      } catch (error) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
        const code = typeof error?.code === "string" ? error.code : "WALLET_READ_UNAVAILABLE";
        const message = status >= 500 ? "Cloud wallet information is temporarily unavailable." : (error.message || "Wallet request was rejected.");
        return response({ ok: false, error: message, code }, status, origin);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/trade/execute") {
      try {
        if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT) {
          const error = new Error("Wallet service is not configured."); error.status = 503; error.code = "SERVICE_NOT_CONFIGURED"; throw error;
        }
        const user = await requireUser(request, env);
        const body = await readJson(request);
        const result = await executeStandardTrade({ user, body, env });
        return response({ ok: true, ...result }, 200, origin);
      } catch (error) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
        const code = typeof error?.code === "string" ? error.code : "TRADE_UNAVAILABLE";
        const message = status >= 500 ? "Trade could not be completed. Your wallet has not been changed." : (error.message || "Trade request was rejected.");
        return response({ ok: false, error: message, code }, status, origin);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/wallet/operation") {
      return response({ ok: false, error: "Wallet operations are not enabled yet.", code: "WALLET_OPERATIONS_NOT_READY" }, 501, origin);
    }
    return response({ error: "Not found." }, 404, origin);
  }
};
