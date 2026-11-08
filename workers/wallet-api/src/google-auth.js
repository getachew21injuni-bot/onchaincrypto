const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/datastore";
let cachedToken = null;
let cachedUntil = 0;

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToBytes(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function encodeJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function createAssertion(serviceAccount, nowSeconds) {
  if (!serviceAccount || typeof serviceAccount.client_email !== "string" ||
      typeof serviceAccount.private_key !== "string" ||
      typeof serviceAccount.token_uri !== "string") {
    throw new Error("Wallet service credentials are incomplete.");
  }
  if (serviceAccount.token_uri !== TOKEN_URL) {
    throw new Error("Wallet service token endpoint is not approved.");
  }
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const payload = encodeJson({
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  });
  const unsigned = header + "." + payload;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return unsigned + "." + base64Url(new Uint8Array(signature));
}

export async function getFirestoreAccessToken(secret, fetchImpl = fetch) {
  let account;
  try {
    account = typeof secret === "string" ? JSON.parse(secret) : secret;
  } catch {
    throw new Error("Wallet service credentials are not valid JSON.");
  }
  if (!account || typeof account.client_email !== "string" || typeof account.private_key !== "string" || account.token_uri !== TOKEN_URL) {
    throw new Error("Wallet service credentials are incomplete or use an unapproved token endpoint.");
  }
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const now = Math.floor(Date.now() / 1000);
  const assertion = await createAssertion(account, now);
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!response.ok) {
    cachedToken = null;
    cachedUntil = 0;
    throw new Error("Wallet database authentication is temporarily unavailable.");
  }
  const result = await response.json();
  if (typeof result.access_token !== "string" || !Number.isFinite(result.expires_in)) {
    throw new Error("Wallet database authentication returned an invalid response.");
  }
  cachedToken = result.access_token;
  cachedUntil = Date.now() + Math.max(60, result.expires_in - 120) * 1000;
  return cachedToken;
}
