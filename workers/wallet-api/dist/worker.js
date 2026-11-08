// workers/wallet-api/src/auth.js
var FIREBASE_CERTS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
var cachedKeys = null;
var cachedKeysUntil = 0;
function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}
async function getFirebaseKeys(fetchImpl = fetch) {
  if (cachedKeys && Date.now() < cachedKeysUntil) return cachedKeys;
  const response2 = await fetchImpl(FIREBASE_CERTS_URL, { headers: { Accept: "application/json" } });
  if (!response2.ok) throw new Error("Firebase signing keys are temporarily unavailable.");
  const body = await response2.json();
  const maxAge = Number((response2.headers.get("cache-control") || "").match(/max-age=(\d+)/i)?.[1] || 300);
  cachedKeys = body.keys || [];
  cachedKeysUntil = Date.now() + Math.max(60, Math.min(maxAge, 3600)) * 1e3;
  return cachedKeys;
}
async function verifyFirebaseIdToken(token, projectId, fetchImpl = fetch) {
  if (typeof token !== "string" || token.length > 1e4) throw new Error("A valid Firebase sign-in token is required.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid Firebase sign-in token.");
  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported sign-in token.");
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Sign-in token belongs to a different project.");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128) throw new Error("Invalid account identity.");
  const now = Math.floor(Date.now() / 1e3);
  if (!Number.isFinite(claims.exp) || claims.exp <= now) throw new Error("Sign-in token has expired. Sign in again.");
  if (!Number.isFinite(claims.iat) || claims.iat > now + 60 || now - claims.iat > 3600) throw new Error("Sign-in token is not valid yet.");
  if (!Number.isFinite(claims.auth_time) || claims.auth_time > now + 60) throw new Error("Invalid sign-in time.");
  const keys = await getFirebaseKeys(fetchImpl);
  const jwk = keys.find((key) => key.kid === header.kid && key.use === "sig" && key.alg === "RS256");
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

// workers/wallet-api/src/google-auth.js
var TOKEN_URL = "https://oauth2.googleapis.com/token";
var SCOPE = "https://www.googleapis.com/auth/datastore";
var cachedToken = null;
var cachedUntil = 0;
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function pemToBytes(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function encodeJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}
async function createAssertion(serviceAccount, nowSeconds) {
  if (!serviceAccount || typeof serviceAccount.client_email !== "string" || typeof serviceAccount.private_key !== "string" || typeof serviceAccount.token_uri !== "string") {
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
async function getFirestoreAccessToken(secret, fetchImpl = fetch) {
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
  const now = Math.floor(Date.now() / 1e3);
  const assertion = await createAssertion(account, now);
  const response2 = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!response2.ok) {
    cachedToken = null;
    cachedUntil = 0;
    throw new Error("Wallet database authentication is temporarily unavailable.");
  }
  const result = await response2.json();
  if (typeof result.access_token !== "string" || !Number.isFinite(result.expires_in)) {
    throw new Error("Wallet database authentication returned an invalid response.");
  }
  cachedToken = result.access_token;
  cachedUntil = Date.now() + Math.max(60, result.expires_in - 120) * 1e3;
  return cachedToken;
}

// workers/wallet-api/src/firestore-rest.js
var API_ROOT = "https://firestore.googleapis.com/v1";
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
  const response2 = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...options.body ? { "Content-Type": "application/json" } : {},
      ...options.headers
    }
  });
  const text = await response2.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Firestore returned an unreadable response.");
    }
  }
  if (!response2.ok) throw firestoreError(response2.status, payload);
  return payload;
}
async function withFirestoreTransaction(env, callback, maxAttempts = 3, dependencies = {}) {
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
    const writtenDocuments = /* @__PURE__ */ new Set();
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
          let payload = null;
          try {
            payload = JSON.parse(rawText);
          } catch {
          }
          throw firestoreError(raw.status, payload);
        }
        let results;
        try {
          results = JSON.parse(rawText);
        } catch {
          results = rawText.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
        }
        const found = Array.isArray(results) ? results.find((item) => item.found)?.found : results?.found;
        const missing = Array.isArray(results) ? results.some((item) => item.missing) : Boolean(results?.missing);
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
      } catch {
      }
      if ((error.code === "ABORTED" || error.status === 409) && attempt + 1 < maxAttempts) continue;
      throw error;
    }
  }
  throw new Error("Wallet transaction could not be completed. Please retry.");
}
function firestoreString(value) {
  return { stringValue: String(value) };
}
function firestoreInteger(value) {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid integer field.");
  return { integerValue: String(value) };
}

// workers/wallet-api/src/quotes.js
var BINANCE_ROOT = "https://data-api.binance.vision/api/v3";
var ALLOWED_ASSETS = /* @__PURE__ */ new Set([
  "BTC",
  "ETH",
  "BNB",
  "SOL",
  "XRP",
  "USDC",
  "DOGE",
  "TRX",
  "TON",
  "ADA",
  "AVAX",
  "SHIB",
  "LINK",
  "BCH",
  "SUI",
  "XLM",
  "DOT",
  "LTC",
  "NEAR",
  "UNI",
  "ETC",
  "ICP",
  "APT",
  "FIL",
  "HBAR",
  "ARB",
  "OP",
  "RENDER",
  "ATOM",
  "VET",
  "INJ",
  "MKR",
  "AAVE",
  "GRT",
  "ALGO",
  "THETA",
  "MANA",
  "SAND",
  "AXS",
  "EOS",
  "ZEC",
  "XMR",
  "DASH",
  "QNT",
  "CAKE",
  "FLOKI",
  "PEPE",
  "BONK",
  "FET",
  "TAO",
  "JUP",
  "ONDO",
  "SEI",
  "KAS",
  "STX",
  "IMX",
  "WLD",
  "DAI",
  "FDUSD",
  "PAXG",
  "XAUT"
]);
async function getTrustedQuote(symbol, fetchImpl = fetch) {
  const asset = String(symbol || "").toUpperCase();
  if (!ALLOWED_ASSETS.has(asset)) {
    const error = new Error("This trading pair is not enabled yet.");
    error.status = 400;
    error.code = "UNSUPPORTED_ASSET";
    throw error;
  }
  const pair = asset + "USDT";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8e3);
  try {
    const response2 = await fetchImpl(`${BINANCE_ROOT}/ticker/price?symbol=${encodeURIComponent(pair)}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cf: { cacheTtl: 0 }
    });
    if (!response2.ok) {
      const error = new Error("A live quote is not available for this pair.");
      error.status = response2.status === 400 ? 400 : 503;
      error.code = "QUOTE_UNAVAILABLE";
      throw error;
    }
    const body = await response2.json();
    if (body.symbol !== pair || typeof body.price !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(body.price) || Number(body.price) <= 0) {
      const error = new Error("The market returned an invalid quote.");
      error.status = 503;
      error.code = "INVALID_QUOTE";
      throw error;
    }
    return { symbol: asset, pair, price: body.price, source: "Binance", quotedAt: (/* @__PURE__ */ new Date()).toISOString() };
  } catch (error) {
    if (error.status) throw error;
    const wrapped = new Error("Live market pricing is temporarily unavailable.");
    wrapped.status = 503;
    wrapped.code = "QUOTE_UNAVAILABLE";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

// workers/wallet-api/src/trades.js
var SCALE = 100000000n;
var PRICE_SCALE = 1000000000000n;
var MIN_TRADE_USDT = 100n * SCALE;
function fail(message, status = 400, code = "INVALID_REQUEST") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}
function parseUnits(value, label) {
  if (typeof value !== "string" && typeof value !== "number") fail(`Invalid ${label}.`);
  const s = String(value);
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(s)) fail(`Invalid ${label}.`);
  const [whole, fraction = ""] = s.split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "00000000").slice(0, 8));
}
function parsePriceUnits(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,11})(?:[.][0-9]{1,12})?$/.test(value)) fail("Invalid market price.", 503, "INVALID_QUOTE");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * PRICE_SCALE + BigInt((fraction + "000000000000").slice(0, 12));
}
function fmt(units) {
  const whole = units / SCALE, fraction = (units % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
function fmtPrice(units) {
  const whole = units / PRICE_SCALE, fraction = (units % PRICE_SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
function valueOf(field) {
  if (!field) return void 0;
  if (field.stringValue !== void 0) return field.stringValue;
  return void 0;
}
function mapBalances(account) {
  const fields = account?.fields?.balances?.mapValue?.fields || {};
  const out = {};
  for (const [symbol, field] of Object.entries(fields)) out[symbol] = valueOf(field);
  return out;
}
async function hashKey(uid, operationId) {
  const bytes = new TextEncoder().encode(uid + ":" + operationId);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function mapValue(balances) {
  const fields = {};
  for (const [symbol, amount] of Object.entries(balances)) fields[symbol] = firestoreString(amount);
  return { mapValue: { fields } };
}
function timestampTransform(fieldPath) {
  return { fieldPath, setToServerValue: "REQUEST_TIME" };
}
async function executeStandardTrade({ user, body, env, dependencies = {} }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid trade request.");
  const side = body.side;
  if (side !== "buy" && side !== "sell") fail("Trade side must be buy or sell.");
  const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "";
  if (!/^[A-Z0-9]{2,12}$/.test(symbol) || symbol === "USDT") fail("Invalid trading asset.");
  const operationId = body.operationId;
  if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(operationId)) fail("A valid unique operation ID is required.");
  const quoteAmount = parseUnits(body.quoteAmount, "trade amount");
  const minimum = symbol === "XAUT" || symbol === "PAXG" ? 500n * SCALE : MIN_TRADE_USDT;
  if (quoteAmount < minimum) fail(`The minimum trade amount is ${symbol === "XAUT" || symbol === "PAXG" ? "500" : "100"} USDT.`, 400, "MINIMUM_TRADE");
  const quote = await (dependencies.getQuote || getTrustedQuote)(symbol, dependencies.fetchImpl || fetch);
  const priceUnits = parsePriceUnits(quote.price);
  if (priceUnits <= 0n) fail("Invalid live market quote.", 503, "INVALID_QUOTE");
  const quantity = quoteAmount * PRICE_SCALE / priceUnits;
  if (quantity <= 0n) fail("Trade amount is too small for this asset.");
  const actualGross = side === "buy" ? quoteAmount : quantity * priceUnits / PRICE_SCALE;
  const keyId = await hashKey(user.uid, operationId);
  const tradeId = crypto.randomUUID();
  const buyEntryId = crypto.randomUUID(), sellEntryId = crypto.randomUUID();
  return withFirestoreTransaction(env, async (tx) => {
    const prior = await tx.get("operationKeys", keyId);
    if (prior) {
      const priorFields = prior.fields || {};
      if (valueOf(priorFields.side) !== side || valueOf(priorFields.symbol) !== symbol || valueOf(priorFields.quoteAmount) !== fmt(quoteAmount)) {
        fail("This operation ID was already used for a different order. Start a new order.", 409, "IDEMPOTENCY_CONFLICT");
      }
      const result = priorFields.result?.mapValue?.fields || {};
      return {
        replayed: true,
        tradeId: valueOf(result.tradeId),
        status: valueOf(result.status) || "filled",
        side: valueOf(result.side),
        symbol: valueOf(result.symbol),
        quantity: valueOf(result.quantity),
        price: valueOf(result.price),
        grossAmount: valueOf(result.grossAmount),
        balances: Object.fromEntries(Object.entries(result.balances?.mapValue?.fields || {}).map(([asset, field]) => [asset, valueOf(field)]))
      };
    }
    const account = await tx.get("walletAccounts", user.uid);
    if (!account) fail("Your cloud wallet is not set up yet. Your existing balance has not been changed.", 409, "ACCOUNT_NOT_MIGRATED");
    const accountFields = account.fields || {};
    if (valueOf(accountFields.uid) !== user.uid || valueOf(accountFields.status) !== "active" || valueOf(accountFields.migrationStatus) !== "verified" || Number(accountFields.schemaVersion?.integerValue) !== 1) {
      fail("Your cloud wallet must be verified before trading can be enabled.", 409, "ACCOUNT_NOT_VERIFIED");
    }
    const balances = mapBalances(account);
    const beforeQuote = parseUnits(balances.USDT || "0", "USDT balance");
    const beforeAsset = parseUnits(balances[symbol] || "0", `${symbol} balance`);
    let afterQuote, afterAsset, quoteDebit, quoteCredit, assetDebit, assetCredit;
    if (side === "buy") {
      if (beforeQuote < quoteAmount) fail("Insufficient USDT balance.", 409, "INSUFFICIENT_FUNDS");
      afterQuote = beforeQuote - quoteAmount;
      afterAsset = beforeAsset + quantity;
      quoteDebit = quoteAmount;
      quoteCredit = 0n;
      assetDebit = 0n;
      assetCredit = quantity;
    } else {
      if (beforeAsset < quantity) fail(`Insufficient ${symbol} balance.`, 409, "INSUFFICIENT_FUNDS");
      afterQuote = beforeQuote + actualGross;
      afterAsset = beforeAsset - quantity;
      quoteDebit = 0n;
      quoteCredit = actualGross;
      assetDebit = quantity;
      assetCredit = 0n;
    }
    balances.USDT = fmt(afterQuote);
    balances[symbol] = fmt(afterAsset);
    const ledgerBase = {
      uid: firestoreString(user.uid),
      operationId: firestoreString(operationId),
      type: firestoreString("trade_settlement"),
      status: firestoreString("posted"),
      source: firestoreString("trade_engine"),
      relatedId: firestoreString(tradeId)
    };
    const quoteEntry = side === "buy" ? {
      ...ledgerBase,
      asset: firestoreString("USDT"),
      amount: firestoreString(fmt(quoteDebit)),
      direction: firestoreString("debit"),
      balanceBefore: firestoreString(fmt(beforeQuote)),
      balanceAfter: firestoreString(fmt(afterQuote))
    } : {
      ...ledgerBase,
      asset: firestoreString("USDT"),
      amount: firestoreString(fmt(quoteCredit)),
      direction: firestoreString("credit"),
      balanceBefore: firestoreString(fmt(beforeQuote)),
      balanceAfter: firestoreString(fmt(afterQuote))
    };
    const assetEntry = side === "buy" ? {
      ...ledgerBase,
      asset: firestoreString(symbol),
      amount: firestoreString(fmt(assetCredit)),
      direction: firestoreString("credit"),
      balanceBefore: firestoreString(fmt(beforeAsset)),
      balanceAfter: firestoreString(fmt(afterAsset))
    } : {
      ...ledgerBase,
      asset: firestoreString(symbol),
      amount: firestoreString(fmt(assetDebit)),
      direction: firestoreString("debit"),
      balanceBefore: firestoreString(fmt(beforeAsset)),
      balanceAfter: firestoreString(fmt(afterAsset))
    };
    tx.update("walletAccounts", user.uid, {
      balances: mapValue(balances),
      version: firestoreInteger(Number(accountFields.version?.integerValue || 0) + 1)
    }, ["balances", "version"], [timestampTransform("updatedAt")]);
    tx.create("walletLedger", buyEntryId, quoteEntry, [timestampTransform("createdAt")]);
    tx.create("walletLedger", sellEntryId, assetEntry, [timestampTransform("createdAt")]);
    tx.create("tradeLedger", tradeId, {
      uid: firestoreString(user.uid),
      operationId: firestoreString(operationId),
      symbol: firestoreString(symbol + "/USDT"),
      baseAsset: firestoreString(symbol),
      quoteAsset: firestoreString("USDT"),
      side: firestoreString(side),
      orderType: firestoreString("market"),
      quantity: firestoreString(fmt(quantity)),
      price: firestoreString(fmtPrice(priceUnits)),
      grossAmount: firestoreString(fmt(actualGross)),
      fee: firestoreString("0"),
      netAmount: firestoreString(fmt(actualGross)),
      quoteSource: firestoreString(quote.source),
      quoteTimestamp: firestoreString(quote.quotedAt),
      status: firestoreString("filled"),
      settlementWalletEntryIds: { arrayValue: { values: [{ stringValue: buyEntryId }, { stringValue: sellEntryId }] } }
    }, [timestampTransform("createdAt")]);
    tx.create("operationKeys", keyId, {
      uid: firestoreString(user.uid),
      operationId: firestoreString(operationId),
      side: firestoreString(side),
      symbol: firestoreString(symbol),
      quoteAmount: firestoreString(fmt(quoteAmount)),
      result: { mapValue: { fields: {
        tradeId: firestoreString(tradeId),
        status: firestoreString("filled"),
        side: firestoreString(side),
        symbol: firestoreString(symbol),
        quantity: firestoreString(fmt(quantity)),
        price: firestoreString(fmtPrice(priceUnits)),
        grossAmount: firestoreString(fmt(actualGross)),
        balances: mapValue(balances)
      } } }
    });
    return { replayed: false, tradeId, status: "filled", side, symbol, quantity: fmt(quantity), price: fmtPrice(priceUnits), grossAmount: fmt(actualGross), balances, quoteSource: quote.source, quoteTimestamp: quote.quotedAt };
  }, 3, dependencies.firestoreDependencies || {});
}

// workers/wallet-api/src/accounts.js
function fieldString(field) {
  return typeof field?.stringValue === "string" ? field.stringValue : void 0;
}
async function readWalletAccount(user, env, dependencies = {}) {
  return withFirestoreTransaction(env, async (tx) => {
    const account = await tx.get("walletAccounts", user.uid);
    if (!account) return { status: "not_migrated", balances: {} };
    const fields = account.fields || {};
    if (fieldString(fields.uid) !== user.uid || fieldString(fields.status) !== "active" || fieldString(fields.migrationStatus) !== "verified" || Number(fields.schemaVersion?.integerValue) !== 1) {
      return { status: "verification_required", balances: {} };
    }
    const raw = fields.balances?.mapValue?.fields || {};
    const balances = {};
    for (const [asset, value] of Object.entries(raw)) {
      if (typeof value.stringValue !== "string" || !/^(?:0|[1-9][0-9]{0,11})(?:[.][0-9]{1,8})?$/.test(value.stringValue)) {
        const error = new Error("Cloud wallet balance data needs administrator review.");
        error.status = 503;
        error.code = "WALLET_DATA_INVALID";
        throw error;
      }
      balances[asset] = value.stringValue;
    }
    return { status: "active", balances, version: Number(fields.version?.integerValue || 0) };
  }, 3, dependencies);
}

// workers/wallet-api/src/index.js
var ALLOWED_ORIGINS = /* @__PURE__ */ new Set([
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
function getOrigin(request) {
  return request.headers.get("Origin") || "";
}
async function requireUser(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error("Sign in is required.");
    error.status = 401;
    error.code = "UNAUTHENTICATED";
    throw error;
  }
  try {
    return await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
  } catch {
    const error = new Error("Your sign-in session is invalid or expired. Sign in again.");
    error.status = 401;
    error.code = "UNAUTHENTICATED";
    throw error;
  }
}
async function readJson(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.toLowerCase().includes("application/json")) {
    const error = new Error("Send the trade request as JSON.");
    error.status = 415;
    error.code = "UNSUPPORTED_MEDIA_TYPE";
    throw error;
  }
  const raw = await request.text();
  if (raw.length > 8192) {
    const error = new Error("Trade request is too large.");
    error.status = 413;
    error.code = "REQUEST_TOO_LARGE";
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Trade request is not valid JSON.");
    error.status = 400;
    error.code = "INVALID_JSON";
    throw error;
  }
}
var index_default = {
  async fetch(request, env) {
    const origin = getOrigin(request);
    if (origin && !ALLOWED_ORIGINS.has(origin)) return response({ error: "Origin not allowed." }, 403, "");
    if (request.method === "OPTIONS") return response({}, 204, origin);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return response({
        status: "online",
        service: "OnChainCrypto Wallet API",
        projectConfigured: Boolean(env.FIREBASE_PROJECT_ID),
        serviceCredentialConfigured: Boolean(env.FIREBASE_SERVICE_ACCOUNT),
        stage: "standard-buy-sell"
      }, 200, origin);
    }
    if (request.method === "GET" && url.pathname === "/v1/wallet/account") {
      try {
        if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT) {
          const error = new Error("Wallet service is not configured.");
          error.status = 503;
          error.code = "SERVICE_NOT_CONFIGURED";
          throw error;
        }
        const user = await requireUser(request, env);
        const account = await readWalletAccount(user, env);
        return response({ ok: true, ...account }, 200, origin);
      } catch (error) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
        const code = typeof error?.code === "string" ? error.code : "WALLET_READ_UNAVAILABLE";
        const message = status >= 500 ? "Cloud wallet information is temporarily unavailable." : error.message || "Wallet request was rejected.";
        return response({ ok: false, error: message, code }, status, origin);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/trade/execute") {
      try {
        if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT) {
          const error = new Error("Wallet service is not configured.");
          error.status = 503;
          error.code = "SERVICE_NOT_CONFIGURED";
          throw error;
        }
        const user = await requireUser(request, env);
        const body = await readJson(request);
        const result = await executeStandardTrade({ user, body, env });
        return response({ ok: true, ...result }, 200, origin);
      } catch (error) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
        const code = typeof error?.code === "string" ? error.code : "TRADE_UNAVAILABLE";
        const message = status >= 500 ? "Trade could not be completed. Your wallet has not been changed." : error.message || "Trade request was rejected.";
        return response({ ok: false, error: message, code }, status, origin);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/wallet/operation") {
      return response({ ok: false, error: "Wallet operations are not enabled yet.", code: "WALLET_OPERATIONS_NOT_READY" }, 501, origin);
    }
    return response({ error: "Not found." }, 404, origin);
  }
};
export {
  index_default as default
};
