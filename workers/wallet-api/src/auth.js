const FIREBASE_CERTS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let cachedKeys = null;
let cachedKeysUntil = 0;

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function getFirebaseKeys(fetchImpl = fetch) {
  if (cachedKeys && Date.now() < cachedKeysUntil) return cachedKeys;
  const response = await fetchImpl(FIREBASE_CERTS_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Firebase signing keys are temporarily unavailable.");
  const body = await response.json();
  const maxAge = Number((response.headers.get("cache-control") || "").match(/max-age=(\d+)/i)?.[1] || 300);
  cachedKeys = body.keys || [];
  cachedKeysUntil = Date.now() + Math.max(60, Math.min(maxAge, 3600)) * 1000;
  return cachedKeys;
}

export async function verifyFirebaseIdToken(token, projectId, fetchImpl = fetch) {
  if (typeof token !== "string" || token.length > 10000) throw new Error("A valid Firebase sign-in token is required.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid Firebase sign-in token.");
  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);

  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported sign-in token.");
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Sign-in token belongs to a different project.");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128) throw new Error("Invalid account identity.");
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= now) throw new Error("Sign-in token has expired. Sign in again.");
  if (!Number.isFinite(claims.iat) || claims.iat > now + 60 || now - claims.iat > 3600) throw new Error("Sign-in token is not valid yet.");
  if (!Number.isFinite(claims.auth_time) || claims.auth_time > now + 60) throw new Error("Invalid sign-in time.");

  const keys = await getFirebaseKeys(fetchImpl);
  const jwk = keys.find(key => key.kid === header.kid && key.use === "sig" && key.alg === "RS256");
  if (!jwk) {
    cachedKeys = null;
    cachedKeysUntil = 0;
    throw new Error("Sign-in token key is not recognized. Retry sign-in.");
  }

  const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  if (!valid) throw new Error("Sign-in token signature is invalid.");
  return {
    uid: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    emailVerified: claims.email_verified === true,
    admin: claims.admin === true
  };
}
