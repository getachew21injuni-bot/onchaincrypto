// OnChainSpro trusted wallet API v2 — isolated staging implementation.
// All customer/admin balance mutations in this branch are routed through this Worker.
// userTradeState/{uid} is the only canonical wallet; walletLedger is append-only audit history.
// Never trust browser-supplied prices, Quick Trade outcomes or P/L.
const PROJECT_ID = "onchaincrypto-d976b";
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
});
const b64u = bytes => {
  let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};
function decode64(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Malformed token.");
  const s = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
}
const decodePart = part => JSON.parse(new TextDecoder().decode(decode64(part)));
function pemDer(pem) {
  const body = String(pem || "").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const normalized = body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return decode64(normalized);
}
async function verifyUserToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new HttpError("A valid Firebase sign-in token is required.", 401);
  const head = decodePart(parts[0]), claims = decodePart(parts[1]);
  if (head.alg !== "RS256" || !head.kid) throw new HttpError("Unsupported Firebase token signature.", 401);
  const response = await fetch(JWKS_URL, { cf: { cacheTtl: 300 } });
  if (!response.ok) throw new HttpError("Firebase token verification is temporarily unavailable.", 503);
  const keys = await response.json();
  const jwk = keys.keys?.find(k => k.kid === head.kid && k.alg === "RS256");
  if (!jwk) throw new HttpError("Firebase token signing key was not found.", 401);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode64(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  const now = Math.floor(Date.now() / 1000);
  if (!valid || claims.iss !== ISSUER || claims.aud !== PROJECT_ID || typeof claims.sub !== "string" ||
      !claims.sub || claims.sub.length > 128 || claims.sub.includes("/") ||
      (claims.user_id && claims.user_id !== claims.sub) ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      !Number.isFinite(claims.iat) || claims.iat > now + 60 || now - claims.iat > 3600 ||
      !Number.isFinite(claims.auth_time) || claims.auth_time > now + 60 || claims.auth_time > claims.iat + 60) {
    throw new HttpError("Firebase sign-in token is invalid or expired.", 401);
  }
  return claims;
}
async function serviceToken(env) {
  let account;
  try { account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || ""); } catch { throw new Error("Worker service-account secret is invalid."); }
  if (account.project_id !== PROJECT_ID || !account.client_email || !account.private_key) throw new Error("Worker service-account configuration is invalid.");
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64u(new TextEncoder().encode(JSON.stringify({
    iss: account.client_email, scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
  })));
  const unsigned = header + "." + payload;
  const key = await crypto.subtle.importKey("pkcs8", pemDer(account.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + "." + b64u(sig);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  if (!response.ok) throw new Error("Google service-account authentication failed.");
  const result = await response.json();
  if (!result.access_token) throw new Error("Google did not issue a service token.");
  return result.access_token;
}
function fromFirestore(v) {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFirestore);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromFirestore(x)]));
  return null;
}
function fieldsFromFirestore(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, fromFirestore(v)]));
}
function toFirestore(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Number.isInteger(v)) return { integerValue: String(v) };
  if (typeof v === "number" && Number.isFinite(v)) return { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestore) } };
  if (v && typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFirestore(x)])) } };
  throw new Error("Unsupported Firestore value.");
}
async function readWallet(token, uid) {
  const response = await fetch(`${ROOT}/userTradeState/${encodeURIComponent(uid)}`, { headers: { authorization: "Bearer " + token } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Canonical Firestore wallet read failed.");
  const doc = await response.json();
  return { data: fieldsFromFirestore(doc.fields), updateTime: doc.updateTime };
}
class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const validId = value => typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
const isAdmin = (env, claims) => {
  const email = String(claims.email || "").toLowerCase();
  const allow = String(env.ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  return claims.admin === true || (claims.email_verified === true && !!email && allow.includes(email));
};
const docPath = (collection, id) => `${ROOT}/${collection}/${encodeURIComponent(id)}`;
async function readDocument(token, collection, id) {
  const response = await fetch(docPath(collection, id), { headers: { authorization: "Bearer " + token } });
  if (response.status === 404) return null;
  if (!response.ok) throw new HttpError("Firestore could not read " + collection + ".", 502);
  const doc = await response.json();
  return { data: fieldsFromFirestore(doc.fields), updateTime: doc.updateTime, name: doc.name };
}
async function queryDocuments(token, collection, field, value, limit = 200) {
  const response = await fetch(ROOT + ":runQuery", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: toFirestore(value) } },
      limit
    } })
  });
  if (!response.ok) throw new HttpError("Firestore could not query " + collection + ".", 502);
  const rows = await response.json();
  return rows.filter(row => row.document).map(row => ({
    id: row.document.name.split("/").pop(), ...fieldsFromFirestore(row.document.fields || {})
  }));
}
async function commitWrites(token, writes) {
  const response = await fetch(ROOT + ":commit", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ writes })
  });
  if (response.status === 409 || response.status === 412) throw new HttpError("A record changed while this operation was processing. Refresh and retry.", 409);
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    if (/FAILED_PRECONDITION|ALREADY_EXISTS|ABORTED/i.test(details)) throw new HttpError("The operation conflicted with a newer wallet or an existing request.", 409);
    throw new HttpError("Atomic Firestore commit failed.", 502);
  }
  return response.json();
}
function walletWrite(uid, wallet, updateTime, balance, holdings, history) {
  return {
    update: { name: docPath("userTradeState", uid), fields: {
      uid: toFirestore(uid), balance: toFirestore(balance), holdings: toFirestore(holdings),
      history: toFirestore(history), updatedAt: { timestampValue: new Date().toISOString() }
    } },
    updateMask: { fieldPaths: ["uid", "balance", "holdings", "history", "updatedAt"] },
    currentDocument: { updateTime }
  };
}
function createLedgerWrite(id, fields) {
  return { update: { name: docPath("walletLedger", id), fields: Object.fromEntries(Object.entries(fields).map(([k,v]) => [k, v && v.timestampValue ? v : toFirestore(v)])) }, currentDocument: { exists: false } };
}
const COIN_IDS = {
  BTC:"bitcoin", ETH:"ethereum", BNB:"binancecoin", XRP:"ripple", SOL:"solana", DOGE:"dogecoin",
  TRX:"tron", TON:"the-open-network", ADA:"cardano", AVAX:"avalanche-2", SHIB:"shiba-inu",
  LINK:"chainlink", BCH:"bitcoin-cash", SUI:"sui", XLM:"stellar", DOT:"polkadot", LTC:"litecoin",
  NEAR:"near", UNI:"uniswap", ETC:"ethereum-classic", ICP:"internet-computer", APT:"aptos",
  FIL:"filecoin", HBAR:"hedera-hashgraph", ARB:"arbitrum", OP:"optimism", RENDER:"render-token",
  ATOM:"cosmos", VET:"vechain", INJ:"injective-protocol", MKR:"maker", AAVE:"aave",
  GRT:"the-graph", ALGO:"algorand", THETA:"theta-token", MANA:"decentraland", SAND:"the-sandbox",
  AXS:"axie-infinity", EOS:"eos", ZEC:"zcash", XMR:"monero", DASH:"dash", QNT:"quant-network",
  CAKE:"pancakeswap-token", FLOKI:"floki", PEPE:"pepe", BONK:"bonk", FET:"fetch-ai",
  TAO:"bittensor", JUP:"jupiter-exchange-solana", ONDO:"ondo-finance", SEI:"sei-network",
  KAS:"kaspa", STX:"stacks", IMX:"immutable-x", WLD:"worldcoin-wld", DAI:"dai",
  FDUSD:"first-digital-usd", PAXG:"pax-gold", XAUT:"tether-gold"
};
async function trustedPrices(symbols) {
  const requested = [...new Set(symbols.map(x => String(x || "").toUpperCase()))];
  const prices = {};
  const stable = new Set(["USDT", "USDC", "DAI", "FDUSD"]);
  for (const symbol of requested) if (stable.has(symbol)) prices[symbol] = 1;
  if (requested.includes("XAU")) {
    const response = await fetch("https://fapi.binance.com/fapi/v1/ticker/price?symbol=XAUUSDT", { cf: { cacheTtl: 5 } });
    if (!response.ok) throw new HttpError("Trusted gold price is temporarily unavailable.", 503);
    const row = await response.json(), price = Number(row.price);
    if (!(price > 0) || !Number.isFinite(price)) throw new HttpError("Trusted gold price is invalid.", 503);
    prices.XAU = price;
  }
  const ids = [...new Set(requested.filter(s => !stable.has(s) && s !== "XAU").map(s => COIN_IDS[s]).filter(Boolean))];
  const unsupported = requested.filter(s => !(s in prices) && !COIN_IDS[s]);
  if (unsupported.length) throw new HttpError("Trusted price is not available for: " + unsupported.join(", "), 422);
  if (ids.length) {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + encodeURIComponent(ids.join(",")) + "&vs_currencies=usd", { cf: { cacheTtl: 15 } });
    if (!response.ok) throw new HttpError("Trusted crypto prices are temporarily unavailable. Try again shortly.", 503);
    const data = await response.json();
    for (const symbol of requested) {
      const id = COIN_IDS[symbol];
      if (id && Number(data?.[id]?.usd) > 0) prices[symbol] = Number(data[id].usd);
    }
  }
  for (const symbol of requested) if (!(prices[symbol] > 0)) throw new HttpError("A trusted price is not available for " + symbol + ".", 503);
  return prices;
}
function requireRequestId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) throw new HttpError("A unique request ID is required.");
  return id;
}
async function walletOrder(env, claims, body) {
  const requestId = requireRequestId(body.requestId), uid = claims.sub;
  const side = body.side, symbol = String(body.symbol || "").toUpperCase(), amount = Number(body.amountUSDT), kind = body.kind === "trade" ? "trade" : "buy-hold";
  if (!["buy", "sell"].includes(side) || (!COIN_IDS[symbol] && !["XAU","PAXG","XAUT"].includes(symbol)) ||
      !Number.isFinite(amount) || amount < 1 || amount > 1000000000) throw new HttpError("Order details are invalid.");
  const access = await serviceToken(env), [wallet, profile, prices] = await Promise.all([
    readWallet(access, uid), readDocument(access, "users", uid), trustedPrices([symbol])
  ]);
  if (!wallet || !wallet.updateTime) throw new HttpError("Canonical wallet is missing. No balance was created.", 409);
  if (!profile || profile.data.accountStatus === "suspended" || profile.data.tradingEnabled === false)
    throw new HttpError("Trading is disabled for this account.", 403);
  const maxOrder = Number(profile.data.maxTradeAmountUSDT);
  if (Number.isFinite(maxOrder) && maxOrder > 0 && amount > maxOrder)
    throw new HttpError("This order exceeds the account's configured trading limit.", 403);
  const balance = Number(wallet.data.balance), holdings = wallet.data.holdings && typeof wallet.data.holdings === "object" ? { ...wallet.data.holdings } : {};
  if (!Number.isFinite(balance) || balance < 0) throw new HttpError("Canonical wallet balance is invalid.", 409);
  const price = prices[symbol], qty = Number((amount / price).toFixed(8));
  const beforeUsdt = balance, beforeAsset = Number(holdings[symbol] || 0);
  if (!Number.isFinite(beforeAsset) || beforeAsset < 0) throw new HttpError("Canonical " + symbol + " balance is invalid.", 409);
  let nextBalance = balance, nextAsset = beforeAsset;
  if (side === "buy") {
    if (amount > balance) throw new HttpError("Insufficient USDT balance.", 409);
    nextBalance = Number((balance - amount).toFixed(8)); nextAsset = Number((beforeAsset + qty).toFixed(8));
  } else {
    if (qty > beforeAsset + 1e-10) throw new HttpError("Insufficient " + symbol + " balance.", 409);
    nextBalance = Number((balance + amount).toFixed(8)); nextAsset = Number(Math.max(0, beforeAsset - qty).toFixed(8));
  }
  holdings[symbol] = nextAsset;
  if (nextAsset <= 1e-12) delete holdings[symbol];
  const createdAt = new Date().toISOString();
  const entry = { id: requestId, side, symbol, amount, qty, price, time: createdAt, demo: true, kind, source: "wallet-api-v2" };
  const history = [{ ...entry }, ...(Array.isArray(wallet.data.history) ? wallet.data.history : [])].slice(0, 300);
  await commitWrites(access, [
    walletWrite(uid, wallet.data, wallet.updateTime, nextBalance, holdings, history),
    createLedgerWrite("order-" + requestId, {
      uid, type: side, asset: symbol, amountUSDT: amount, quantity: qty, price,
      balanceBefore: beforeUsdt, balanceAfter: nextBalance, assetBefore: beforeAsset, assetAfter: nextAsset,
      requestId, source: "wallet-api-v2", createdAtText: createdAt, createdAt: { timestampValue: createdAt }
    })
  ]);
  return { ok: true, wallet: { uid, balance: nextBalance, holdings, history }, order: entry };
}
async function walletConvert(env, claims, body) {
  const requestId = requireRequestId(body.requestId), uid = claims.sub;
  const from = String(body.from || "").toUpperCase(), to = String(body.to || "").toUpperCase(), amount = Number(body.amount);
  if (!from || !to || from === to || !Number.isFinite(amount) || amount <= 0 || amount > 1000000000 ||
      (!["USDT","USDC","DAI","FDUSD"].includes(from) && !COIN_IDS[from] && !["XAU","PAXG","XAUT"].includes(from)) ||
      (!["USDT","USDC","DAI","FDUSD"].includes(to) && !COIN_IDS[to] && !["XAU","PAXG","XAUT"].includes(to))) {
    throw new HttpError("Conversion details are invalid.");
  }
  const access = await serviceToken(env), [wallet, prices] = await Promise.all([
    readWallet(access, uid), trustedPrices([from, to])
  ]);
  if (!wallet || !wallet.updateTime) throw new HttpError("Canonical wallet is missing. No balance was created.", 409);
  const balance = Number(wallet.data.balance), holdings = wallet.data.holdings && typeof wallet.data.holdings === "object" ? { ...wallet.data.holdings } : {};
  if (!Number.isFinite(balance) || balance < 0) throw new HttpError("Canonical wallet balance is invalid.", 409);
  const beforeFrom = from === "USDT" ? balance : Number(holdings[from] || 0);
  if (!Number.isFinite(beforeFrom) || beforeFrom < amount) throw new HttpError("Insufficient " + from + " balance.", 409);
  const feeUSDT = amount * prices[from] * 0.001;
  const received = Number(Math.max(0, (amount * prices[from] - feeUSDT) / prices[to]).toFixed(8));
  let nextBalance = balance;
  if (from === "USDT") nextBalance = Number((nextBalance - amount).toFixed(8));
  else holdings[from] = Number(Math.max(0, beforeFrom - amount).toFixed(8));
  if (to === "USDT") nextBalance = Number((nextBalance + received).toFixed(8));
  else holdings[to] = Number((Number(holdings[to] || 0) + received).toFixed(8));
  if (holdings[from] !== undefined && holdings[from] <= 1e-12) delete holdings[from];
  const createdAt = new Date().toISOString();
  await commitWrites(access, [
    walletWrite(uid, wallet.data, wallet.updateTime, nextBalance, holdings, Array.isArray(wallet.data.history) ? wallet.data.history.slice(0, 300) : []),
    createLedgerWrite("convert-" + requestId, {
      uid, type: "conversion", status: "completed", asset: from + "->" + to, from, to, amount, received, fromQty: amount, toQty: received, feeUSDT, feeUsdt: feeUSDT,
      priceFrom: prices[from], priceTo: prices[to], balanceBefore: beforeFrom,
      balanceAfter: from === "USDT" ? nextBalance : holdings[from] || 0,
      requestId, source: "wallet-api-v2", createdAtText: createdAt, createdAt: { timestampValue: createdAt }
    })
  ]);
  return { ok: true, wallet: { uid, balance: nextBalance, holdings, history: wallet.data.history || [] },
    conversion: { from, to, amount, received, feeUSDT, priceFrom: prices[from], priceTo: prices[to], time: createdAt } };
}
async function startQuickTrade(env, claims, body) {
  const tradeId = requireRequestId(body.tradeId), uid = claims.sub;
  const symbol = String(body.symbol || "").toUpperCase(), funding = String(body.funding || "USDT").toUpperCase();
  const direction = body.direction, stake = Number(body.stake);
  if (!["up","down"].includes(direction) || !Number.isFinite(stake) || stake <= 0 ||
      (!COIN_IDS[symbol] && !["XAU","PAXG","XAUT"].includes(symbol)) ||
      (!["USDT","USDC","DAI","FDUSD"].includes(funding) && !COIN_IDS[funding] && !["XAU","PAXG","XAUT"].includes(funding))) {
    throw new HttpError("Quick Trade details are invalid.");
  }
  const access = await serviceToken(env);
  const [wallet, profile, global] = await Promise.all([
    readWallet(access, uid), readDocument(access, "users", uid), readDocument(access, "platformSettings", "demoTradeControl")
  ]);
  if (!wallet || !wallet.updateTime) throw new HttpError("Canonical wallet is missing. No balance was created.", 409);
  if (!profile || profile.data.accountStatus === "suspended" || profile.data.tradingEnabled === false)
    throw new HttpError("Trading is disabled for this account.", 403);
  const prices = await trustedPrices([symbol, funding]), fundingPrice = prices[funding], stakeUSD = stake * fundingPrice;
  const maxTradeAmount = Number(profile.data.maxTradeAmountUSDT);
  if (Number.isFinite(maxTradeAmount) && maxTradeAmount > 0 && stakeUSD > maxTradeAmount)
    throw new HttpError("This trade exceeds the account's configured trading limit.", 403);
  const available = funding === "USDT" ? Number(wallet.data.balance) : Number(wallet.data.holdings?.[funding] || 0);
  if (!Number.isFinite(available) || stake > available + 1e-10) throw new HttpError("Insufficient " + funding + " wallet balance.", 409);
  const minimum = symbol === "XAU" ? 500 : 100;
  const levels = [
    { rate:12,min:minimum,max:5000,duration:30 }, { rate:15,min:5000,max:10000,duration:60 },
    { rate:18,min:10000,max:25000,duration:90 }, { rate:21,min:25000,max:50000,duration:120 },
    { rate:24,min:50000,max:100000,duration:180 }, { rate:27,min:100000,max:Infinity,duration:360 }
  ];
  const plan = levels.find((p,i) => stakeUSD >= p.min && (stakeUSD < p.max || i === levels.length - 1)) || null;
  if (!plan) throw new HttpError("Trade amount does not meet the minimum for this asset.", 422);
  const userMode = ["inherit","market","win","lose"].includes(profile?.data.demoTradeControlMode) ? profile.data.demoTradeControlMode : "inherit";
  const globalData = global?.data || {}, globalMode = ["market","win","lose"].includes(globalData.mode) ? globalData.mode : "market";
  const mode = globalMode === "win" || globalMode === "lose" ? globalMode : (userMode !== "inherit" ? userMode : globalMode);
  const winPercent = Math.min(100, Math.max(1, Number(globalMode === "win" ? globalData.winPercent : profile?.data.demoWinPercent) || 15));
  const lossPercent = Math.min(100, Math.max(1, Number(globalMode === "lose" ? globalData.lossPercent : profile?.data.demoLossPercent) || 50));
  const startedAt = new Date(), endsAt = new Date(startedAt.getTime() + plan.duration * 1000);
  const trade = {
    tradeId, uid, symbol, funding, fundingPrice, direction, stake, stakeUSD,
    entryPrice: prices[symbol], payoutRate: plan.rate, duration: plan.duration,
    adminMode: mode, adminWinPercent: winPercent, adminLossPercent: lossPercent,
    status: "running", startedAt: startedAt.toISOString(), endsAt: endsAt.toISOString()
  };
  const fields = Object.fromEntries(Object.entries(trade).map(([k,v]) => [k, toFirestore(v)]));
  await commitWrites(access, [
    { update: { name: docPath("quickTrades", tradeId), fields }, currentDocument: { exists: false } },
    { update: { name: docPath("activeQuickTrades", uid), fields: {
      uid: toFirestore(uid), tradeId: toFirestore(tradeId), endsAt: toFirestore(endsAt.toISOString()),
      startedAt: toFirestore(startedAt.toISOString())
    } }, currentDocument: { exists: false } }
  ]);
  return { ok: true, trade };
}
async function settleQuickTrade(env, claims, body) {
  const tradeId = String(body.tradeId || "").trim();
  if (!validId(tradeId)) throw new HttpError("A valid Quick Trade ID is required.");
  const uid = claims.sub, access = await serviceToken(env);
  const tradeDoc = await readDocument(access, "quickTrades", tradeId);
  if (!tradeDoc || tradeDoc.data.uid !== uid) throw new HttpError("Quick Trade was not found for this account.", 404);
  if (tradeDoc.data.status === "completed") {
    const wallet = await readWallet(access, uid);
    return { ok: true, alreadySettled: true, trade: tradeDoc.data, result: tradeDoc.data.resultRecord || null, wallet: wallet?.data || null };
  }
  if (tradeDoc.data.status !== "running") throw new HttpError("Quick Trade is not active.", 409);
  const ends = new Date(tradeDoc.data.endsAt).getTime();
  if (!Number.isFinite(ends) || Date.now() < ends) throw new HttpError("Quick Trade has not reached its server-confirmed expiry.", 409);
  const [wallet, prices, active] = await Promise.all([
    readWallet(access, uid), trustedPrices([tradeDoc.data.symbol]), readDocument(access, "activeQuickTrades", uid)
  ]);
  if (!wallet || !wallet.updateTime || !active || active.data.tradeId !== tradeId) throw new HttpError("Active trade or canonical wallet record is missing.", 409);
  const balance = Number(wallet.data.balance);
  if (!Number.isFinite(balance) || balance < 0) throw new HttpError("Canonical wallet balance is invalid.", 409);
  const exitPrice = prices[tradeDoc.data.symbol], entryPrice = Number(tradeDoc.data.entryPrice), stakeUSD = Number(tradeDoc.data.stakeUSD);
  if (!(entryPrice > 0) || !(stakeUSD > 0)) throw new HttpError("Stored Quick Trade details are invalid.", 409);
  const move = (exitPrice - entryPrice) / entryPrice;
  let calculatedPnl = stakeUSD * (tradeDoc.data.direction === "up" ? move : -move);
  if (tradeDoc.data.adminMode === "win") calculatedPnl = stakeUSD * Math.min(100, Math.max(1, Number(tradeDoc.data.adminWinPercent) || 15)) / 100;
  else if (tradeDoc.data.adminMode === "lose") calculatedPnl = -stakeUSD * Math.min(100, Math.max(1, Number(tradeDoc.data.adminLossPercent) || 50)) / 100;
  const nextBalance = Number(Math.max(0, balance + calculatedPnl).toFixed(2)), appliedPnl = Number((nextBalance - balance).toFixed(2));
  const completedAt = new Date().toISOString(), result = {
    id: "quick-" + tradeId, kind: "quick-result", side: tradeDoc.data.direction === "up" ? "buy" : "sell",
    symbol: tradeDoc.data.symbol, amount: stakeUSD, qty: stakeUSD / entryPrice, price: exitPrice,
    entry: entryPrice, pnl: appliedPnl, time: completedAt, funding: tradeDoc.data.funding,
    balanceAdjustment: appliedPnl, settlementAsset: "USDT",
    status: appliedPnl > 0 ? "win" : appliedPnl < 0 ? "loss" : "even"
  };
  const history = [result, ...(Array.isArray(wallet.data.history) ? wallet.data.history : [])].slice(0, 300);
  const completedTrade = { ...tradeDoc.data, status: "completed", exitPrice, calculatedPnl, appliedPnl, completedAt, resultRecord: result, balanceBefore: balance, balanceAfter: nextBalance };
  await commitWrites(access, [
    walletWrite(uid, wallet.data, wallet.updateTime, nextBalance,
      wallet.data.holdings && typeof wallet.data.holdings === "object" ? wallet.data.holdings : {}, history),
    { update: { name: docPath("quickTrades", tradeId), fields: Object.fromEntries(Object.entries(completedTrade).map(([k,v]) => [k, toFirestore(v)])) },
      updateMask: { fieldPaths: ["status","exitPrice","calculatedPnl","appliedPnl","completedAt","resultRecord","balanceBefore","balanceAfter"] }, currentDocument: { updateTime: tradeDoc.updateTime } },
    { delete: docPath("activeQuickTrades", uid), currentDocument: { updateTime: active.updateTime } },
    createLedgerWrite("quick-trade-" + tradeId, {
      uid, type: "quick_trade_settlement", asset: "USDT", amount: appliedPnl,
      balanceBefore: balance, balanceAfter: nextBalance, symbol: tradeDoc.data.symbol,
      direction: tradeDoc.data.direction, stakeUSD, entryPrice, exitPrice,
      controlMode: tradeDoc.data.adminMode, requestId: tradeId, source: "wallet-api-v2",
      createdAtText: completedAt, createdAt: { timestampValue: completedAt }
    })
  ]);
  return { ok: true, alreadySettled: false, trade: completedTrade, result: { ...result, balanceBefore: balance, balanceAfter: nextBalance }, wallet: { uid, balance: nextBalance,
    holdings: wallet.data.holdings || {}, history } };
}
async function reviewDepositWithdrawal(env, claims, body) {
  if (!isAdmin(env, claims)) throw new HttpError("Administrator access is required.", 403);
  const kind = body.kind === "deposit" ? "deposit" : body.kind === "withdraw" ? "withdraw" : "";
  const requestId = String(body.requestId || "").trim();
  const decision = body.decision;
  if (!kind || !validId(requestId) || !["approve", "reject"].includes(decision)) throw new HttpError("A valid request kind, request ID and decision are required.");
  const access = await serviceToken(env), collection = kind === "deposit" ? "depositRequests" : "withdrawRequests";
  const request = await readDocument(access, collection, requestId);
  if (!request) throw new HttpError("Request not found.", 404);
  if ((request.data.status || "pending") !== "pending") throw new HttpError("This request has already been reviewed.", 409);
  const reviewedAt = new Date().toISOString(), reviewedBy = String(claims.email || claims.sub);
  if (decision === "reject") {
    await commitWrites(access, [{
      update: { name: docPath(collection, requestId), fields: { status: toFirestore("rejected"), reviewedAt: { timestampValue: reviewedAt }, reviewedBy: toFirestore(reviewedBy) } },
      updateMask: { fieldPaths: ["status", "reviewedAt", "reviewedBy"] },
      currentDocument: { updateTime: request.updateTime }
    }]);
    return { ok: true, status: "rejected", requestId };
  }
  const uid = String(request.data.uid || ""), asset = String(request.data.asset || "USDT").toUpperCase(), amount = Number(request.data.amount);
  if (!validId(uid) || !/^[A-Z0-9]{2,12}$/.test(asset) || !Number.isFinite(amount) || amount <= 0 || amount > 1000000000) throw new HttpError("The request details are invalid.");
  const [profile, wallet] = await Promise.all([readDocument(access, "users", uid), readDocument(access, "userTradeState", uid)]);
  if (!profile) throw new HttpError("User profile is missing.", 409);
  if (!wallet || !wallet.updateTime) throw new HttpError("Canonical wallet is missing. No balance was created.", 409);
  if (profile.data.accountStatus === "suspended") throw new HttpError("This account is suspended.", 403);
  const holdings = wallet.data.holdings && typeof wallet.data.holdings === "object" && !Array.isArray(wallet.data.holdings) ? { ...wallet.data.holdings } : {};
  const balance = Number(wallet.data.balance);
  if (!Number.isFinite(balance) || balance < 0) throw new HttpError("Canonical wallet balance is invalid.", 409);
  const before = asset === "USDT" ? balance : Number(holdings[asset] || 0);
  if (!Number.isFinite(before) || before < 0) throw new HttpError("Canonical asset balance is invalid.", 409);
  const after = Number((before + (kind === "deposit" ? amount : -amount)).toFixed(asset === "USDT" ? 2 : 8));
  if (after < 0) throw new HttpError("Insufficient canonical wallet balance.", 409);
  const nextBalance = asset === "USDT" ? after : balance;
  if (asset !== "USDT") holdings[asset] = after;
  const ledgerId = `admin-${kind}-${requestId}`, ledgerType = kind === "withdraw" ? "withdrawal" : "deposit";
  const ledger = createLedgerWrite(ledgerId, {
    uid, type: ledgerType, status: "approved", asset, amount, balanceBefore: before, balanceAfter: after,
    source: "admin-request-review", requestId, actorUid: claims.sub, actorEmail: reviewedBy, createdAtText: reviewedAt,
    createdAt: { timestampValue: reviewedAt }
  });
  await commitWrites(access, [
    walletWrite(uid, wallet.data, wallet.updateTime, nextBalance, holdings, Array.isArray(wallet.data.history) ? wallet.data.history.slice(0, 300) : []),
    { update: { name: docPath(collection, requestId), fields: {
      status: toFirestore("approved"), reviewedAt: { timestampValue: reviewedAt },
      reviewedBy: toFirestore(reviewedBy), walletLedgerId: toFirestore(ledgerId)
    } }, updateMask: { fieldPaths: ["status", "reviewedAt", "reviewedBy", "walletLedgerId"] }, currentDocument: { updateTime: request.updateTime } },
    ledger,
    { update: { name: docPath("userNotifications/" + uid + "/items", ledgerId), fields: {
      kind: toFirestore(kind === "deposit" ? "deposit" : "withdrawal_approved"),
      title: toFirestore(kind === "deposit" ? "Deposit request approved" : "Withdrawal request approved"),
      message: toFirestore(kind === "deposit"
        ? "Your " + amount + " " + asset + " deposit request was approved and credited to your OnChain account."
        : "Your " + amount + " " + asset + " withdrawal request was approved as an internal account adjustment. No external blockchain payout was sent."),
      createdAt: { timestampValue: reviewedAt }, readAt: { nullValue: null },
      createdBy: toFirestore(claims.sub), source: toFirestore("wallet-api-v2")
    } }, currentDocument: { exists: false } }
  ]);
  return { ok: true, status: "approved", uid, asset, amount, balanceAfter: after, ledgerId };
}
async function adminAdjustAssets(env, claims, body) {
  if (!isAdmin(env, claims)) throw new HttpError("Administrator access is required.", 403);
  const uid = String(body.uid || "").trim(), requestId = String(body.requestId || "").trim();
  const operation = body.operation, amount = Number(body.amount);
  const reason = String(body.reason || "").trim().slice(0, 240);
  const assets = Array.isArray(body.assets) ? [...new Set(body.assets.map(x => String(x || "").toUpperCase()))] : [];
  if (!validId(uid) || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId) ||
      !["deposit", "withdrawal"].includes(operation) || !Number.isFinite(amount) || amount <= 0 || amount > 1000000000 ||
      !reason || !assets.length || assets.length > 40 || assets.some(x => !/^[A-Z0-9]{2,12}$/.test(x))) {
    throw new HttpError("A valid user, request ID, operation, asset list, amount and reason are required.");
  }
  const access = await serviceToken(env);
  const wallet = await readWallet(access, uid);
  if (!wallet || !wallet.updateTime) throw new HttpError("Canonical wallet is missing. No balance was created.", 409);
  const balance = Number(wallet.data.balance);
  if (!Number.isFinite(balance) || balance < 0) throw new HttpError("Canonical USDT balance is invalid.", 409);
  const holdings = wallet.data.holdings && typeof wallet.data.holdings === "object" && !Array.isArray(wallet.data.holdings) ? { ...wallet.data.holdings } : {};
  let nextBalance = balance;
  const changes = [];
  for (const asset of assets) {
    const before = asset === "USDT" ? nextBalance : Number(holdings[asset] || 0);
    if (!Number.isFinite(before) || before < 0) throw new HttpError("Canonical " + asset + " balance is invalid.", 409);
    const after = Number((before + (operation === "deposit" ? amount : -amount)).toFixed(asset === "USDT" ? 2 : 8));
    if (after < 0) throw new HttpError("Insufficient " + asset + " balance. No assets were changed.", 409);
    if (asset === "USDT") nextBalance = after; else holdings[asset] = after;
    changes.push({ asset, before, after });
  }
  const createdAt = new Date().toISOString(), actorEmail = String(claims.email || claims.sub);
  const writes = [
    walletWrite(uid, wallet.data, wallet.updateTime, nextBalance, holdings, Array.isArray(wallet.data.history) ? wallet.data.history.slice(0, 300) : []),
    ...changes.map(change => createLedgerWrite("admin-" + requestId + "-" + change.asset, {
      uid, type: operation, status: "approved", asset: change.asset, amount, balanceBefore: change.before, balanceAfter: change.after,
      reason, requestId, actorUid: claims.sub, actorEmail, source: "admin-finance-adjustment", createdAtText: createdAt,
      createdAt: { timestampValue: createdAt }
    })),
    { update: { name: docPath("userNotifications/" + uid + "/items", requestId), fields: {
      kind: toFirestore(operation === "deposit" ? "deposit" : "withdrawal_approved"),
      title: toFirestore(operation === "deposit" ? "Account deposit credited" : "Account withdrawal adjustment"),
      message: toFirestore("Admin " + operation + " adjustment: " + changes.map(x => x.asset + " " + amount).join(", ") + ". " + reason),
      createdAt: { timestampValue: createdAt }, readAt: { nullValue: null },
      createdBy: toFirestore(claims.sub), source: toFirestore("wallet-api-v2")
    } }, currentDocument: { exists: false } }
  ];
  await commitWrites(access, writes);
  return { ok: true, uid, operation, changes, requestId };
}
async function reviewInternalTransfer(env, claims, body) {
  if (!isAdmin(env, claims)) throw new HttpError("Administrator access is required.", 403);
  const requestId = String(body.requestId || "").trim(), decision = body.decision;
  if (!validId(requestId) || !["approve", "reject"].includes(decision)) throw new HttpError("A valid transfer request ID and decision are required.");
  const access = await serviceToken(env), request = await readDocument(access, "internalTransferRequests", requestId);
  if (!request) throw new HttpError("Transfer request not found.", 404);
  if (request.data.status !== "pending") throw new HttpError("This transfer request has already been reviewed.", 409);
  const reviewedAt = new Date().toISOString(), reviewedBy = String(claims.email || claims.sub);
  if (decision === "reject") {
    await commitWrites(access, [{
      update: { name: docPath("internalTransferRequests", requestId), fields: {
        status: toFirestore("rejected"), reviewedAt: { timestampValue: reviewedAt }, reviewedBy: toFirestore(reviewedBy)
      } }, updateMask: { fieldPaths: ["status", "reviewedAt", "reviewedBy"] }, currentDocument: { updateTime: request.updateTime }
    }]);
    return { ok: true, status: "rejected", requestId };
  }
  const senderUid = String(request.data.senderUid || ""), recipientUid = String(request.data.recipientUid || ""), amount = Number(request.data.amount);
  if (!validId(senderUid) || !validId(recipientUid) || senderUid === recipientUid || request.data.asset !== "USDT" ||
      !Number.isFinite(amount) || amount <= 0 || amount > 1000000000) throw new HttpError("Transfer request details are invalid.");
  const [senderProfile, recipientProfile, senderWallet, recipientWallet] = await Promise.all([
    readDocument(access, "users", senderUid), readDocument(access, "users", recipientUid),
    readDocument(access, "userTradeState", senderUid), readDocument(access, "userTradeState", recipientUid)
  ]);
  if (!senderProfile || !recipientProfile || !senderWallet || !recipientWallet || !senderWallet.updateTime || !recipientWallet.updateTime)
    throw new HttpError("Sender or recipient profile or canonical wallet is missing. No balance was changed.", 409);
  if (senderProfile.data.accountStatus === "suspended" || recipientProfile.data.accountStatus === "suspended")
    throw new HttpError("A suspended account cannot send or receive transfers.", 403);
  const senderBefore = Number(senderWallet.data.balance), recipientBefore = Number(recipientWallet.data.balance);
  if (!Number.isFinite(senderBefore) || !Number.isFinite(recipientBefore) || senderBefore < amount || recipientBefore < 0)
    throw new HttpError("Insufficient sender balance or invalid recipient balance.", 409);
  const senderAfter = Number((senderBefore - amount).toFixed(8)), recipientAfter = Number((recipientBefore + amount).toFixed(8));
  if (recipientAfter > 1000000000) throw new HttpError("Recipient balance limit would be exceeded.", 409);
  const transferId = "transfer-" + requestId, ledgerOut = "transfer-out-" + requestId, ledgerIn = "transfer-in-" + requestId;
  const senderHoldings = senderWallet.data.holdings && typeof senderWallet.data.holdings === "object" ? senderWallet.data.holdings : {};
  const recipientHoldings = recipientWallet.data.holdings && typeof recipientWallet.data.holdings === "object" ? recipientWallet.data.holdings : {};
  const common = { asset: "USDT", amount, requestId, actorUid: claims.sub, actorEmail: reviewedBy, createdAt: { timestampValue: reviewedAt } };
  await commitWrites(access, [
    walletWrite(senderUid, senderWallet.data, senderWallet.updateTime, senderAfter, senderHoldings, Array.isArray(senderWallet.data.history) ? senderWallet.data.history.slice(0,300) : []),
    walletWrite(recipientUid, recipientWallet.data, recipientWallet.updateTime, recipientAfter, recipientHoldings, Array.isArray(recipientWallet.data.history) ? recipientWallet.data.history.slice(0,300) : []),
    { update: { name: docPath("internalTransferRequests", requestId), fields: {
      status: toFirestore("approved"), reviewedAt: { timestampValue: reviewedAt }, reviewedBy: toFirestore(reviewedBy), transferId: toFirestore(transferId)
    } }, updateMask: { fieldPaths: ["status", "reviewedAt", "reviewedBy", "transferId"] }, currentDocument: { updateTime: request.updateTime } },
    { update: { name: docPath("internalTransfers", transferId), fields: Object.fromEntries(Object.entries({
      senderUid, recipientUid, asset: "USDT", amount, senderBefore, senderAfter, recipientBefore, recipientAfter,
      senderName: String(request.data.senderName || "OnChain member").slice(0,80),
      recipientName: String(request.data.recipientName || "OnChain member").slice(0,80),
      createdAt: { timestampValue: reviewedAt }, transferRequestId: requestId, approvedBy: reviewedBy, source: "wallet-api-v2"
    }).map(([k,v]) => [k, v && v.timestampValue ? v : toFirestore(v)])) }, currentDocument: { exists: false } },
    createLedgerWrite(ledgerOut, { ...common, uid: senderUid, type: "internal_transfer_sent", balanceBefore: senderBefore, balanceAfter: senderAfter, counterpartyUid: recipientUid }),
    createLedgerWrite(ledgerIn, { ...common, uid: recipientUid, type: "internal_transfer_received", balanceBefore: recipientBefore, balanceAfter: recipientAfter, counterpartyUid: senderUid })
  ]);
  return { ok: true, status: "approved", requestId, transferId, senderBalance: senderAfter, recipientBalance: recipientAfter };
}
async function adminAdjustment(env, claims, body) {
  const email = String(claims.email || "").toLowerCase();
  if (!isAdmin(env, claims)) throw new HttpError("Administrator access is required.", 403);
  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 240) : "";
  const delta = Number(body.deltaUSDT);
  if (!validId(uid) || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId) ||
      !reason || !Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000000) {
    throw new HttpError("A valid UID, unique requestId, reason and non-zero USDT adjustment are required.");
  }
  const access = await serviceToken(env);
  const wallet = await readWallet(access, uid);
  if (!wallet || !wallet.updateTime) throw new HttpError("Canonical wallet record is missing; no balance was created.", 409);
  const balance = Number(wallet.data?.balance);
  if (!Number.isFinite(balance) || balance < 0) throw new HttpError("Canonical wallet balance is invalid.", 409);
  const next = Math.round((balance + delta) * 100) / 100;
  if (next < 0) throw new HttpError("Insufficient USDT balance for this adjustment.", 409);
  const ledgerName = `${ROOT}/walletLedger/${encodeURIComponent(requestId)}`;
  const prior = await fetch(ledgerName, { headers: { authorization: "Bearer " + access } });
  if (prior.ok) throw new HttpError("This requestId has already been processed.", 409);
  if (prior.status !== 404) throw new HttpError("Could not verify transaction idempotency.", 502);
  const writes = [
    { update: { name: `${ROOT}/userTradeState/${encodeURIComponent(uid)}`, fields: {
      uid: toFirestore(uid), balance: toFirestore(next),
      holdings: toFirestore(wallet.data.holdings && typeof wallet.data.holdings === "object" ? wallet.data.holdings : {}),
      history: toFirestore(Array.isArray(wallet.data.history) ? wallet.data.history : []),
      updatedAt: { timestampValue: new Date().toISOString() }
    } }, updateMask: { fieldPaths: ["uid", "balance", "holdings", "history", "updatedAt"] }, currentDocument: { updateTime: wallet.updateTime } },
    { update: { name: ledgerName, fields: {
      uid: toFirestore(uid), type: toFirestore("admin_adjustment"), asset: toFirestore("USDT"),
      amount: toFirestore(delta), balanceBefore: toFirestore(balance), balanceAfter: toFirestore(next),
      reason: toFirestore(reason), actorUid: toFirestore(claims.sub), actorEmail: toFirestore(email),
      requestId: toFirestore(requestId), createdAt: { timestampValue: new Date().toISOString() }
    } }, currentDocument: { exists: false } }
  ];
  await commitWrites(access, writes);
  return { ok: true, uid, balance: next, requestId, ledger: "walletLedger/" + requestId };
}
export const walletApiInternals = Object.freeze({ toFirestore, fieldsFromFirestore, validId, isAdmin, walletWrite, createLedgerWrite });

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
    if (origin && !allowed.includes(origin)) return json({ error: "Origin not allowed." }, 403, { vary: "Origin" });
    const cors = origin ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type", "access-control-max-age": "600", vary: "Origin" } : {};
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true, mode: "staged-wallet-api-v2" }, 200, cors);
    try {
      const auth = request.headers.get("Authorization") || "";
      if (!auth.startsWith("Bearer ")) throw new HttpError("Firebase sign-in token is required.", 401);
      const claims = await verifyUserToken(auth.slice(7));
      if (url.pathname === "/v1/wallet" && request.method === "GET") {
        const access = await serviceToken(env);
        const wallet = await readWallet(access, claims.sub);
        if (!wallet) throw new HttpError("Canonical wallet record is missing; no balance was created.", 404);
        return json({ uid: claims.sub, wallet: wallet.data, updateTime: wallet.updateTime }, 200, cors);
      }
      if (url.pathname === "/v1/wallet/ledger" && request.method === "GET") {
        const access = await serviceToken(env);
        const rows = await queryDocuments(access, "walletLedger", "uid", claims.sub, 200);
        rows.sort((a, b) => String(b.createdAtText || "").localeCompare(String(a.createdAtText || "")));
        return json({ uid: claims.sub, rows }, 200, cors);
      }
      if (url.pathname === "/v1/quick-trade/active" && request.method === "GET") {
        const access = await serviceToken(env);
        const active = await readDocument(access, "activeQuickTrades", claims.sub);
        if (!active) return json({ active: false }, 200, cors);
        const trade = await readDocument(access, "quickTrades", String(active.data.tradeId || ""));
        if (!trade || trade.data.uid !== claims.sub || trade.data.status !== "running") return json({ active: false }, 200, cors);
        return json({ active: true, trade: trade.data }, 200, cors);
      }
      if (request.method !== "POST") throw new HttpError("Method not allowed.", 405);
      let body;
      try { body = await request.json(); } catch { throw new HttpError("Request body must be valid JSON."); }
      let result;
      if (url.pathname === "/v1/wallet/order") result = await walletOrder(env, claims, body);
      else if (url.pathname === "/v1/wallet/convert") result = await walletConvert(env, claims, body);
      else if (url.pathname === "/v1/quick-trade/start") result = await startQuickTrade(env, claims, body);
      else if (url.pathname === "/v1/quick-trade/settle") result = await settleQuickTrade(env, claims, body);
      else if (url.pathname === "/v1/admin/adjust-usdt") result = await adminAdjustment(env, claims, body);
      else if (url.pathname === "/v1/admin/review-request") result = await reviewDepositWithdrawal(env, claims, body);
      else if (url.pathname === "/v1/admin/review-transfer") result = await reviewInternalTransfer(env, claims, body);
      else if (url.pathname === "/v1/admin/adjust-assets") result = await adminAdjustAssets(env, claims, body);
      else throw new HttpError("Route not found or not enabled in this migration stage.", 404);
      return json(result, 200, cors);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      return json({ error: error?.message || "Wallet API request failed." }, status, cors);
    }
  }
};