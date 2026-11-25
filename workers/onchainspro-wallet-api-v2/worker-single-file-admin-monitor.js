// OnChainSpro Wallet API v2 — single-file Cloudflare Worker
// Contains the server-authoritative trade engine and authenticated Admin trade-monitor endpoint.
// Source branch: fix/admin-live-trade-monitor-20261124

// Server-authoritative Quick Trade engine for the OnChainSpro wallet Worker.
// Firestore is the source of truth. The browser may request a trade and display it;
// only this module creates, prices, expires, and settles it.
const PRICE_IDS = {
  BTC:"bitcoin", ETH:"ethereum", BNB:"binancecoin", USDT:"tether", SOL:"solana", XRP:"ripple",
  USDC:"usd-coin", DOGE:"dogecoin", TRX:"tron", TON:"the-open-network", ADA:"cardano",
  AVAX:"avalanche-2", SHIB:"shiba-inu", LINK:"chainlink", BCH:"bitcoin-cash", SUI:"sui",
  XLM:"stellar", DOT:"polkadot", LTC:"litecoin", NEAR:"near", UNI:"uniswap",
  ETC:"ethereum-classic", ICP:"internet-computer", APT:"aptos", FIL:"filecoin",
  HBAR:"hedera-hashgraph", ARB:"arbitrum", OP:"optimism", RENDER:"render-token",
  ATOM:"cosmos", VET:"vechain", INJ:"injective-protocol", MKR:"maker", AAVE:"aave",
  GRT:"the-graph", ALGO:"algorand", THETA:"theta-token", MANA:"decentraland",
  SAND:"sandbox", AXS:"axie-infinity", EOS:"eos", ZEC:"zcash", XMR:"monero",
  DASH:"dash", QNT:"quant-network", CAKE:"pancakeswap-token", FLOKI:"floki",
  PEPE:"pepe", BONK:"bonk", FET:"fetch-ai", TAO:"bittensor",
  JUP:"jupiter-exchange-solana", ONDO:"ondo-finance", SEI:"sei-network",
  KAS:"kaspa", STX:"stacks", IMX:"immutable-x", WLD:"worldcoin-wld",
  DAI:"dai", FDUSD:"first-digital-usd", PAXG:"pax-gold", XAUT:"tether-gold"
};
const ASSETS = new Set([...Object.keys(PRICE_IDS), "XAU"]);
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const safeNumber = n => Number.isFinite(Number(n)) ? Number(n) : 0;

export function createTradeEngine({ ROOT, serviceToken, toFirestore, fieldsFromFirestore }) {
  const docUrl = (collection, id) => `${ROOT}/${collection}/${encodeURIComponent(id)}`;
  async function readDoc(access, collection, id) {
    const response = await fetch(docUrl(collection, id), { headers: { authorization: "Bearer " + access } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Firestore read failed for " + collection + ".");
    const raw = await response.json();
    return { data: fieldsFromFirestore(raw.fields), updateTime: raw.updateTime, name: raw.name };
  }
  async function query(access, structuredQuery) {
    const response = await fetch(ROOT + ":runQuery", {
      method: "POST",
      headers: { authorization: "Bearer " + access, "content-type": "application/json" },
      body: JSON.stringify({ structuredQuery })
    });
    if (!response.ok) throw new Error("Firestore trade query failed.");
    const rows = await response.json();
    return (Array.isArray(rows) ? rows : []).filter(x => x.document).map(x => {
      const d = x.document;
      return { id: d.name.split("/").pop(), data: fieldsFromFirestore(d.fields), updateTime: d.updateTime, name: d.name };
    });
  }
  async function quote(symbol) {
    if (symbol === "USDT" || symbol === "USDC" || symbol === "DAI" || symbol === "FDUSD") return 1;
    if (symbol === "XAU") {
      try {
        const response = await fetch("https://fapi.binance.com/fapi/v1/ticker/price?symbol=XAUUSDT", { signal: AbortSignal.timeout(5000) });
        if (response.ok) {
          const result = await response.json(), price = Number(result.price);
          if (price > 0 && Number.isFinite(price)) return price;
        }
      } catch (_) { /* Continue to the independent gold-backed fallback. */ }
      // One PAX Gold token represents one troy ounce of gold and provides an
      // independent server-side reference if the XAUUSDT futures feed is down.
      try {
        const fallback = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd", { signal: AbortSignal.timeout(5000) });
        if (fallback.ok) {
          const data = await fallback.json(), price = Number(data?.["pax-gold"]?.usd);
          if (price > 0 && Number.isFinite(price)) return price;
        }
      } catch (_) { /* Report a clear error below. */ }
      throw new Error("The server gold price feed is temporarily unavailable.");
    }
    const pair = symbol + "USDT";
    // Try Binance's public market-data host first, then its primary API host.
    // Either provider may be unavailable from a particular network/region.
    for (const host of ["https://data-api.binance.vision", "https://api.binance.com"]) {
      try {
        const response = await fetch(host + "/api/v3/ticker/price?symbol=" + pair, { signal: AbortSignal.timeout(4000) });
        if (response.ok) {
          const result = await response.json(), price = Number(result.price);
          if (price > 0 && Number.isFinite(price)) return price;
        }
      } catch (_) { /* Continue to the next public price source. */ }
    }
    // Coinbase is an independent BTC spot-price fallback. Keep it server-side;
    // the browser market feed and this trade-entry feed are separate services.
    if (symbol === "BTC") {
      try {
        const coinbase = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", { signal: AbortSignal.timeout(5000) });
        if (coinbase.ok) {
          const result = await coinbase.json();
          const price = Number(result?.data?.amount);
          if (price > 0 && Number.isFinite(price)) return price;
        }
      } catch (_) { /* Continue to CoinGecko if Coinbase is unavailable. */ }
    }
    const id = PRICE_IDS[symbol];
    if (!id) throw new Error("No trusted server price source is configured for " + symbol + ".");
    const fallback = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + encodeURIComponent(id) + "&vs_currencies=usd", { signal: AbortSignal.timeout(5000) });
    if (!fallback.ok) throw new Error("The server price feed is temporarily unavailable for " + symbol + ".");
    const data = await fallback.json(), price = Number(data?.[id]?.usd);
    if (!(price > 0) || !Number.isFinite(price)) throw new Error("The server returned an invalid market price for " + symbol + ".");
    return price;
  }
  function plan(amount, symbol) {
    const minimum = symbol === "XAU" ? 500 : 100;
    const tiers = [
      { min: minimum, max: 5000, rate: 12, duration: 30, label: "Level 1" },
      { min: 5000, max: 10000, rate: 15, duration: 60, label: "Level 2" },
      { min: 10000, max: 25000, rate: 18, duration: 90, label: "Level 3" },
      { min: 25000, max: 50000, rate: 21, duration: 120, label: "Level 4" },
      { min: 50000, max: 100000, rate: 24, duration: 180, label: "Level 5" },
      { min: 100000, max: Number.MAX_SAFE_INTEGER, rate: 27, duration: 360, label: "Level 6" }
    ];
    return tiers.find(t => amount >= t.min && amount < t.max) || null;
  }
  async function controls(access, uid) {
    const [user, global] = await Promise.all([
      readDoc(access, "users", uid),
      readDoc(access, "platformSettings", "demoTradeControl")
    ]);
    const u = user?.data || {}, g = global?.data || {};
    if (u.tradingEnabled === false || u.accountStatus === "suspended") throw new Error("Trading is disabled for this account.");
    const globalMode = ["market","win","lose"].includes(g.mode) ? g.mode : "market";
    const userMode = ["inherit","market","win","lose"].includes(u.demoTradeControlMode) ? u.demoTradeControlMode : "inherit";
    const mode = globalMode === "win" || globalMode === "lose" ? globalMode : (userMode === "inherit" ? globalMode : userMode);
    return {
      mode,
      maxTradeAmountUSDT: safeNumber(u.maxTradeAmountUSDT),
      winPercent: Math.min(100, Math.max(1, safeNumber(globalMode === "win" ? g.winPercent : u.demoWinPercent) || 15)),
      lossPercent: Math.min(100, Math.max(1, safeNumber(globalMode === "lose" ? g.lossPercent : u.demoLossPercent) || 50))
    };
  }
  async function commit(access, writes) {
    const response = await fetch(ROOT + ":commit", {
      method: "POST",
      headers: { authorization: "Bearer " + access, "content-type": "application/json" },
      body: JSON.stringify({ writes })
    });
    const responseText = await response.text();
    if (!response.ok) {
      let firestoreError = {};
      try { firestoreError = JSON.parse(responseText)?.error || {}; } catch (_) { /* Keep the HTTP status if the response is not JSON. */ }
      const firestoreStatus = typeof firestoreError.status === "string" ? firestoreError.status : "";
      const firestoreMessage = typeof firestoreError.message === "string" ? firestoreError.message.slice(0, 500) : "";
      console.error("Firestore trade commit rejected", {
        httpStatus: response.status,
        firestoreStatus,
        firestoreMessage
      });
      if (response.status === 409 || response.status === 412) throw new Error("TRADE_CONFLICT");
      throw new Error("Firestore trade commit failed (HTTP " + response.status + (firestoreStatus ? ", " + firestoreStatus : "") + ")" + (firestoreMessage ? ": " + firestoreMessage : ".") );
    }
    return responseText ? JSON.parse(responseText) : {};
  }
  // Firestore commit writes require a resource name, not the HTTPS REST URL used by reads.
  const enc = (collection, id) => `${ROOT.replace(/^https:\/\/firestore.googleapis.com\/v1\//, "")}/${collection}/${encodeURIComponent(id)}`;
  const writeDoc = (name, data, currentDocument) => ({
    update: { name, fields: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, v instanceof Date ? { timestampValue: v.toISOString() } : toFirestore(v)])) },
    currentDocument
  });

  async function create(uid, body) {
    if (!uid) throw new Error("Sign in before starting a trade.");
    // Validate and fetch the entry quote before starting the user's full trade duration.
    const symbol = String(body?.symbol || "").toUpperCase();
    const direction = String(body?.direction || "");
    const fundingAsset = String(body?.fundingAsset || "USDT").toUpperCase();
    const fundingAmount = round2(safeNumber(body?.amount));
    if (!ASSETS.has(symbol) || ["USDT","USDC","DAI","FDUSD"].includes(symbol) || !["up","down"].includes(direction) || !(fundingAmount > 0) || fundingAmount > 1000000 || (!ASSETS.has(fundingAsset) && !["USDT","USDC"].includes(fundingAsset)) || fundingAsset !== "USDT") {
      throw new Error("Invalid trade details.");
    }
    const access = await serviceToken();
    const [wallet, setting, fundingPrice] = await Promise.all([readDoc(access, "userTradeState", uid), controls(access, uid), quote(fundingAsset)]);
    if (!wallet || !wallet.updateTime) throw new Error("Your cloud wallet is unavailable. No trade was created.");
    const balance = safeNumber(wallet.data.balance);
    if (balance < 0) throw new Error("Your cloud wallet balance is invalid.");
    const stake = round2(fundingAmount * fundingPrice);
    const availableFunding = fundingAsset === "USDT" ? balance : safeNumber(wallet.data.holdings?.[fundingAsset]);
    if (fundingAmount > availableFunding + 1e-8) throw new Error("Insufficient " + fundingAsset + " balance.");
    const p = plan(stake, symbol);
    if (!p) throw new Error("The amount does not fit an available investment level.");
    // The users/{uid} document was already read by controls(); reuse that
    // snapshot instead of issuing a second Firestore read for every trade.
    const max = setting.maxTradeAmountUSDT;
    if (max > 0 && stake > max) throw new Error("This trade exceeds your account's maximum trade amount.");
    const entry = await quote(symbol);
    const guard = await readDoc(access, "activeTradeGuards", uid);
    const reserved = safeNumber(guard?.data?.reservedUSDT);
    if (balance - reserved + 1e-8 < stake) throw new Error("Insufficient available USDT after accounting for your other active trades.");
    // The countdown starts only after all preflight work is complete, immediately before the atomic Firestore reservation.
    const now = Date.now(), id = crypto.randomUUID();
    // Keep the first reservation safely ahead of the settlement scheduler. The
    // exact duration is finalized from Firestore's successful commitTime below.
    const trade = {
      uid, symbol, direction, amountUSDT: stake, amountFunding: fundingAmount, fundingAsset, fundingPriceAtStart: fundingPrice, entryPrice: entry, exitPrice: null,
      startedAt: new Date(now), expiresAt: new Date(now + (p.duration + 60) * 1000),
      durationSeconds: p.duration, planLevel: p.label, payoutRate: p.rate,
      outcomeMode: setting.mode, winPercent: setting.winPercent, lossPercent: setting.lossPercent,
      status: "active", pnlUSDT: null, createdAt: new Date(now), updatedAt: new Date(now)
    };
    const nextGuard = { uid, reservedUSDT: round2(reserved + stake), activeCount: safeNumber(guard?.data?.activeCount) + 1, updatedAt: new Date(now) };
    const guardWrite = guard
      ? writeDoc(enc("activeTradeGuards", uid), nextGuard, { updateTime: guard.updateTime })
      : writeDoc(enc("activeTradeGuards", uid), nextGuard, { exists: false });
    try {
      // A no-balance-change wallet write with updateTime precondition serializes
      // trade creation against concurrent wallet changes and other trade starts.
      const reservation = await commit(access, [
        writeDoc(enc("userTradeState", uid), {
          uid, balance, holdings: wallet.data.holdings || {},
          history: Array.isArray(wallet.data.history) ? wallet.data.history : [],
          updatedAt: new Date(now)
        }, { updateTime: wallet.updateTime }),
        guardWrite,
        writeDoc(enc("activeTrades", id), { ...trade, tradeId: id }, { exists: false })
      ]);
      // Firestore's commitTime is when the wallet reservation and active trade
      // became durable. Start the customer's full duration from that moment,
      // not from before the network round-trip for the atomic commit.
      const committedAt = Date.parse(reservation?.commitTime) || Date.now();
      trade.startedAt = new Date(committedAt);
      trade.expiresAt = new Date(committedAt + p.duration * 1000);
      trade.createdAt = new Date(committedAt);
      trade.updatedAt = new Date(committedAt);
      // The initial +60s expiry prevents settlement racing this finalization.
      let finalized = false;
      let finalizeError;
      for (let attempt = 0; attempt < 3 && !finalized; attempt++) {
        try {
          await commit(access, [writeDoc(enc("activeTrades", id), { ...trade, tradeId: id })]);
          finalized = true;
        } catch (error) {
          finalizeError = error;
        }
      }
      if (!finalized) {
        console.error("Trade reservation succeeded but expiry finalization needs retry", id, finalizeError?.message || finalizeError);
        throw new Error("Your trade was reserved, but its timer is still syncing. Refresh your trades before placing another order.");
      }
    } catch (error) {
      if (error.message === "TRADE_CONFLICT") throw new Error("Your wallet or active trades changed. Please try confirming again.");
      throw error;
    }
    return { tradeId: id, trade, availableUSDT: round2(balance - nextGuard.reservedUSDT) };
  }

  async function list(uid) {
    const access = await serviceToken();
    const activeQuery = () => query(access, {
      from: [{ collectionId: "activeTrades" }],
      where: { compositeFilter: { op: "AND", filters: [
        { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } },
        { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "active" } } }
      ] } },
      orderBy: [{ field: { fieldPath: "expiresAt" }, direction: "ASCENDING" }],
      limit: 100
    });

    // Retry this account's expired trades on refresh; the scheduled trigger
    // remains the background safety net for closed browsers and other accounts.
    const beforeSettlement = await activeQuery();
    for (const item of beforeSettlement) {
      if (Date.parse(item.data.expiresAt) <= Date.now()) {
        try { await settleOne(access, item); }
        catch (error) { console.error("On-demand trade settlement failed", item.id, error?.message || error); }
      }
    }

    const [active, recent] = await Promise.all([
      activeQuery(),
      query(access, {
        from: [{ collectionId: "tradeLedger" }],
        where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } },
        orderBy: [{ field: { fieldPath: "completedAt" }, direction: "DESCENDING" }],
        limit: 30
      })
    ]);

    // Mark prices are server-quoted on every authenticated refresh. Settlement
    // still obtains its own independent authoritative expiry quote.
    const prices = new Map();
    for (const item of active) {
      const symbol = item.data.symbol;
      if (!prices.has(symbol)) {
        prices.set(symbol, quote(symbol).then(price => ({ price, sampledAt: new Date().toISOString() }))
          .catch(error => ({ price: null, sampledAt: null, error: error?.message || "Price feed unavailable." })));
      }
    }
    const activeTrades = await Promise.all(active.map(async item => {
      const sample = await prices.get(item.data.symbol);
      return {
        id: item.id,
        ...item.data,
        ...(sample.price !== null
          ? { latestPrice: sample.price, priceSampledAt: sample.sampledAt }
          : { latestPrice: null, priceFeedError: true })
      };
    }));
    return { activeTrades, recentTrades: recent.map(x => ({ id: x.id, ...x.data })) };
  }

  async function settleOne(access, item) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const trade = await readDoc(access, "activeTrades", item.id);
      if (!trade || trade.data.status !== "active" || Date.parse(trade.data.expiresAt) > Date.now()) return false;
      const uid = trade.data.uid;
      const [wallet, guard] = await Promise.all([
        readDoc(access, "userTradeState", uid),
        readDoc(access, "activeTradeGuards", uid)
      ]);
      if (!wallet?.updateTime || !guard?.updateTime) throw new Error("Wallet or active-trade reservation record is missing.");
      const exit = await quote(trade.data.symbol);
      const move = (exit - Number(trade.data.entryPrice)) / Number(trade.data.entryPrice);
      let pnl = Number(trade.data.amountUSDT) * (trade.data.direction === "up" ? move : -move);
      if (trade.data.outcomeMode === "win") pnl = Number(trade.data.amountUSDT) * Math.min(100, Math.max(1, safeNumber(trade.data.winPercent))) / 100;
      if (trade.data.outcomeMode === "lose") pnl = -Number(trade.data.amountUSDT) * Math.min(100, Math.max(1, safeNumber(trade.data.lossPercent))) / 100;
      pnl = round2(pnl);
      const before = safeNumber(wallet.data.balance), after = round2(Math.max(0, before + pnl));
      const history = Array.isArray(wallet.data.history) ? wallet.data.history.slice(0, 299) : [];
      const completedAt = new Date();
      const result = {
        id: "quick-" + item.id, kind: "quick-result", side: trade.data.direction === "up" ? "buy" : "sell",
        symbol: trade.data.symbol, amount: trade.data.amountUSDT, qty: Number(trade.data.amountUSDT) / Number(trade.data.entryPrice),
        price: exit, entry: Number(trade.data.entryPrice), pnl, time: completedAt.toISOString(), funding: "USDT",
        balanceAdjustment: pnl, settlementAsset: "USDT", status: pnl > 0 ? "win" : pnl < 0 ? "loss" : "even",
        serverTradeId: item.id
      };
      history.unshift(result);
      const guardData = guard.data || {};
      const nextGuard = {
        uid, reservedUSDT: round2(Math.max(0, safeNumber(guardData.reservedUSDT) - Number(trade.data.amountUSDT))),
        activeCount: Math.max(0, safeNumber(guardData.activeCount) - 1), updatedAt: completedAt
      };
      const completed = { ...trade.data, startedAt: new Date(trade.data.startedAt), expiresAt: new Date(trade.data.expiresAt), createdAt: new Date(trade.data.createdAt), status: "completed", exitPrice: exit, pnlUSDT: pnl, completedAt, updatedAt: completedAt };
      const ledger = {
        ...result, uid, tradeId: item.id,
        amountUSDT: Number(trade.data.amountUSDT),
        amountFunding: Number(trade.data.amountFunding),
        fundingAsset: trade.data.fundingAsset || "USDT",
        durationSeconds: Number(trade.data.durationSeconds),
        startedAt: new Date(trade.data.startedAt),
        balanceBefore: before, balanceAfter: after, completedAt,
        settlementSource: "server-cron"
      };
      try {
        await commit(access, [
          writeDoc(enc("userTradeState", uid), { uid, balance: after, holdings: wallet.data.holdings || {}, history, updatedAt: completedAt }, { updateTime: wallet.updateTime }),
          writeDoc(enc("activeTrades", item.id), completed, { updateTime: trade.updateTime }),
          writeDoc(enc("activeTradeGuards", uid), nextGuard, { updateTime: guard.updateTime }),
          writeDoc(enc("tradeLedger", item.id), ledger, { exists: false })
        ]);
        return true;
      } catch (error) {
        if (error.message !== "TRADE_CONFLICT") throw error;
        const already = await readDoc(access, "activeTrades", item.id);
        if (!already || already.data.status !== "active") return false;
      }
    }
    return false;
  }

  async function settleDue() {
    const access = await serviceToken();
    const now = new Date();
    const due = await query(access, {
      from: [{ collectionId: "activeTrades" }],
      where: { compositeFilter: { op: "AND", filters: [
        { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "active" } } },
        { fieldFilter: { field: { fieldPath: "expiresAt" }, op: "LESS_THAN_OR_EQUAL", value: { timestampValue: now } } }
      ] } },
      orderBy: [{ field: { fieldPath: "expiresAt" }, direction: "ASCENDING" }],
      limit: 50
    });
    let settled = 0, failed = 0;
    for (const item of due) {
      try { if (await settleOne(access, item)) settled++; }
      catch (error) { failed++; console.error("Trade settlement failed", item.id, error?.message || error); }
    }
    return { scanned: due.length, settled, failed };
  }

  return { create, list, settleDue };
}


// OnChainSpro trusted wallet API v2 — wallet and server-side Quick Trade API.

//

// This Worker exposes authenticated wallet reads, audited administrator USDT adjustments, and server-owned Quick Trade lifecycle.

// Conversions, transfers, deposits and withdrawals remain disabled until their

// server-side business rules and source records are migrated. Never trust client-supplied P/L.



const PROJECT_ID = "onchaincrypto-d976b";



const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;



const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;



const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";



const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {

   status,

   headers: {

      "content-type": "application/json; charset=utf-8",

      "cache-control": "no-store",

      ...headers

   }

});



const b64u = bytes => {

   let s = "";

   for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);

   return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

};



function decode64(value) {

   if (!/^[A-Za-z0-9_-]+$/.test(value)) {

      throw new Error("Malformed token.");

   }



   const s = value.replace(/-/g, "+").replace(/_/g, "/");



   return Uint8Array.from(

      atob(s + "=".repeat((4 - s.length % 4) % 4)),

      c => c.charCodeAt(0)

   );

}



const decodePart = part =>

   JSON.parse(new TextDecoder().decode(decode64(part)));



function pemDer(pem) {

   const body = String(pem || "").replace(

      /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,

      ""

   );



   // FIX: normalize Base64 and remove trailing padding before validation.

   const normalized = body

      .replace(/\+/g, "-")

      .replace(/\//g, "_")

      .replace(/=+$/g, "");



   return decode64(normalized);

}



async function verifyUserToken(token) {

   const parts = String(token || "").split(".");



   if (parts.length !== 3) {

      throw new Error("A valid Firebase sign-in token is required.");

   }



   const head = decodePart(parts[0]);

   const claims = decodePart(parts[1]);



   if (head.alg !== "RS256" || !head.kid) {

      throw new Error("Unsupported token signature.");

   }



   const response = await fetch(JWKS_URL, {

      cf: { cacheTtl: 300 }

   });



   if (!response.ok) {

      throw new Error("Firebase token verification is temporarily unavailable.");

   }



   const keys = await response.json();



   const jwk = keys.keys?.find(

      k => k.kid === head.kid && k.alg === "RS256"

   );



   if (!jwk) {

      throw new Error("Firebase token signing key was not found.");

   }



   const key = await crypto.subtle.importKey(

      "jwk",

      jwk,

      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },

      false,

      ["verify"]

   );



   const valid = await crypto.subtle.verify(

      "RSASSA-PKCS1-v1_5",

      key,

      decode64(parts[2]),

      new TextEncoder().encode(parts[0] + "." + parts[1])

   );



   const now = Math.floor(Date.now() / 1000);



   if (

      !valid ||

      claims.iss !== ISSUER ||

      claims.aud !== PROJECT_ID ||

      typeof claims.sub !== "string" ||

      !claims.sub ||

      claims.sub.length > 128 ||

      !Number.isFinite(claims.exp) ||

      claims.exp <= now ||

      !Number.isFinite(claims.iat) ||

      claims.iat > now + 60 ||

      now - claims.iat > 3600

   ) {

      throw new Error("Firebase sign-in token is invalid or expired.");

   }



   return claims;

}



async function serviceToken(env) {

   let account;



   try {

      account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || "");

   } catch {

      throw new Error("Worker service-account secret is invalid.");

   }



   if (

      account.project_id !== PROJECT_ID ||

      !account.client_email ||

      !account.private_key

   ) {

      throw new Error("Worker service-account configuration is invalid.");

   }



   const now = Math.floor(Date.now() / 1000);



   const header = b64u(

      new TextEncoder().encode(

         JSON.stringify({ alg: "RS256", typ: "JWT" })

      )

   );



   const payload = b64u(

      new TextEncoder().encode(

         JSON.stringify({

            iss: account.client_email,

            scope: "https://www.googleapis.com/auth/datastore",

            aud: "https://oauth2.googleapis.com/token",

            iat: now,

            exp: now + 3600

         })

      )

   );



   const unsigned = header + "." + payload;



   const key = await crypto.subtle.importKey(

      "pkcs8",

      pemDer(account.private_key),

      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },

      false,

      ["sign"]

   );



   const sig = await crypto.subtle.sign(

      "RSASSA-PKCS1-v1_5",

      key,

      new TextEncoder().encode(unsigned)

   );



   const assertion = unsigned + "." + b64u(sig);



   const response = await fetch("https://oauth2.googleapis.com/token", {

      method: "POST",

      headers: {

         "content-type": "application/x-www-form-urlencoded"

      },

      body: new URLSearchParams({

         grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",

         assertion

      })

   });



   if (!response.ok) {

      throw new Error("Google service-account authentication failed.");

   }



   const result = await response.json();



   if (!result.access_token) {

      throw new Error("Google did not issue a service token.");

   }



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



   if ("arrayValue" in v) {

      return (v.arrayValue.values || []).map(fromFirestore);

   }



   if ("mapValue" in v) {

      return Object.fromEntries(

         Object.entries(v.mapValue.fields || {}).map(

            ([k, x]) => [k, fromFirestore(x)]

         )

      );

   }



   return null;

}



function fieldsFromFirestore(fields) {

   return Object.fromEntries(

      Object.entries(fields || {}).map(

         ([k, v]) => [k, fromFirestore(v)]

      )

   );

}



function toFirestore(v) {

   if (v === null) return { nullValue: null };



   if (typeof v === "string") {

      return { stringValue: v };

   }



   if (typeof v === "boolean") {

      return { booleanValue: v };

   }



   if (Number.isInteger(v)) {

      return { integerValue: String(v) };

   }



   if (typeof v === "number" && Number.isFinite(v)) {

      return { doubleValue: v };

   }



   if (Array.isArray(v)) {

      return {

         arrayValue: {

            values: v.map(toFirestore)

         }

      };

   }



   if (v && typeof v === "object") {

      return {

         mapValue: {

            fields: Object.fromEntries(

               Object.entries(v).map(([k, x]) => [k, toFirestore(x)])

            )

         }

      };

   }



   throw new Error("Unsupported Firestore value.");

}



async function readWallet(token, uid) {

   const response = await fetch(

      `${ROOT}/userTradeState/${encodeURIComponent(uid)}`,

      {

         headers: {

            authorization: "Bearer " + token

         }

      }

   );



   if (response.status === 404) return null;



   if (!response.ok) {

      throw new Error("Canonical Firestore wallet read failed.");

   }



   const doc = await response.json();



   return {

      data: fieldsFromFirestore(doc.fields),

      updateTime: doc.updateTime

   };

}



async function adminAdjustment(env, token, claims, body) {

   const admins = String(env.ADMIN_EMAILS || "")

      .split(",")

      .map(x => x.trim().toLowerCase())

      .filter(Boolean);



   const email = String(claims.email || "").toLowerCase();



   if (

      !(

         claims.admin === true ||

         (

            claims.email_verified === true &&

            email &&

            admins.includes(email)

         )

      )

   ) {

      return json({ error: "Administrator access is required." }, 403);

   }



   const uid = typeof body.uid === "string" ? body.uid.trim() : "";

   const requestId = typeof body.requestId === "string"

      ? body.requestId.trim()

      : "";

   const reason = typeof body.reason === "string"

      ? body.reason.trim().slice(0, 240)

      : "";



   const delta = Number(body.deltaUSDT);



   if (

      !uid ||

      uid.length > 128 ||

      uid.includes("/") ||

      !/^[A-Za-z0-9_-]{16,100}$/.test(requestId) ||

      !reason ||

      !Number.isFinite(delta) ||

      delta === 0 ||

      Math.abs(delta) > 1000000

   ) {

      return json({

         error: "A valid UID, unique requestId, reason and non-zero USDT adjustment are required."

      }, 400);

   }



   const access = await serviceToken(env);



   const wallet = await readWallet(access, uid);



   if (!wallet || !wallet.updateTime) {

      return json({

         error: "Canonical wallet record is missing; no balance was created."

      }, 409);

   }



   const balance = Number(wallet.data?.balance);



   if (!Number.isFinite(balance) || balance < 0) {

      return json({

         error: "Canonical wallet balance is invalid."

      }, 409);

   }



   const next = Math.round((balance + delta) * 100) / 100;



   if (next < 0) {

      return json({

         error: "Insufficient USDT balance for this adjustment."

      }, 409);

   }



   const ledgerName =

      `${ROOT}/walletLedger/${encodeURIComponent(requestId)}`;



   const prior = await fetch(ledgerName, {

      headers: {

         authorization: "Bearer " + access

      }

   });



   if (prior.ok) {

      return json({

         error: "This requestId has already been processed."

      }, 409);

   }



   if (prior.status !== 404) {

      throw new Error("Could not verify transaction idempotency.");

   }



   const writes = [

      {

         update: {

            name: `${ROOT}/userTradeState/${encodeURIComponent(uid)}`,

            fields: {

               uid: toFirestore(uid),

               balance: toFirestore(next),

               holdings: toFirestore(

                  wallet.data.holdings &&

                  typeof wallet.data.holdings === "object"

                     ? wallet.data.holdings

                     : {}

               ),

               history: toFirestore(

                  Array.isArray(wallet.data.history)

                     ? wallet.data.history

                     : []

               ),

               updatedAt: {

                  timestampValue: new Date().toISOString()

               }

            }

         },

         updateMask: {

            fieldPaths: [

               "uid",

               "balance",

               "holdings",

               "history",

               "updatedAt"

            ]

         },

         currentDocument: {

            updateTime: wallet.updateTime

         }

      },

      {

         update: {

            name: ledgerName,

            fields: {

               uid: toFirestore(uid),

               type: toFirestore("admin_adjustment"),

               asset: toFirestore("USDT"),

               amount: toFirestore(delta),

               balanceBefore: toFirestore(balance),

               balanceAfter: toFirestore(next),

               reason: toFirestore(reason),

               actorUid: toFirestore(claims.sub),

               actorEmail: toFirestore(email),

               requestId: toFirestore(requestId),

               createdAt: {

                  timestampValue: new Date().toISOString()

               }

            }

         },

         currentDocument: {

            exists: false

         }

      }

   ];



   const commit = await fetch(ROOT + ":commit", {

      method: "POST",

      headers: {

         authorization: "Bearer " + access,

         "content-type": "application/json"

      },

      body: JSON.stringify({ writes })

   });



   if (commit.status === 409 || commit.status === 412) {

      return json({

         error: "Wallet changed during this request. Refresh and retry with a new requestId."

      }, 409);

   }



   if (!commit.ok) {

      throw new Error("Atomic Firestore wallet transaction failed.");

   }



   return json({

      ok: true,

      uid,

      balance: next,

      requestId,

      ledger: "walletLedger/" + requestId

   });

}




async function adminTradeMonitor(env, claims) {
  const admins = String(env.ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  const email = String(claims.email || "").toLowerCase();
  if (!(claims.admin === true || (claims.email_verified === true && email && admins.includes(email)))) {
    return json({ error: "Administrator access is required." }, 403);
  }
  const access = await serviceToken(env);
  async function list(collectionId, field, limitCount) {
    const response = await fetch(ROOT + ":runQuery", {
      method: "POST",
      headers: { authorization: "Bearer " + access, "content-type": "application/json" },
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId }],
        orderBy: [{ field: { fieldPath: field }, direction: "DESCENDING" }],
        limit: limitCount
      } })
    });
    if (!response.ok) throw new Error("Administrator trade records could not be read from Firestore (" + collectionId + ").");
    const rows = await response.json();
    return (Array.isArray(rows) ? rows : []).filter(x => x.document).map(x => ({
      id: x.document.name.split("/").pop(),
      ...(fieldsFromFirestore(x.document.fields) || {})
    }));
  }
  const [activeTrades, recentTrades] = await Promise.all([
    list("activeTrades", "startedAt", 500),
    list("tradeLedger", "completedAt", 500)
  ]);
  return json({
    activeTrades: activeTrades.filter(x => x.status === "active"),
    recentTrades,
    activeCount: activeTrades.filter(x => x.status === "active").length,
    completedCount: recentTrades.length,
    asOf: new Date().toISOString()
  }, 200);
}

export default {

   async fetch(request, env) {

      const origin = request.headers.get("Origin") || "";



      const allowed = String(env.ALLOWED_ORIGINS || "")

         .split(",")

         .map(x => x.trim())

         .filter(Boolean);



      if (origin && !allowed.includes(origin)) {

         return json(

            { error: "Origin not allowed." },

            403,

            { vary: "Origin" }

         );

      }



      const cors = origin

         ? {

               "access-control-allow-origin": origin,

               "access-control-allow-methods": "GET, POST, OPTIONS",

               "access-control-allow-headers": "Authorization, Content-Type",

               "access-control-max-age": "600",

               vary: "Origin"

            }

         : {};



      if (request.method === "OPTIONS") {

         return new Response(null, {

            status: 204,

            headers: cors

         });

      }



      if (

         new URL(request.url).pathname === "/health" &&

         request.method === "GET"

      ) {

         return json(

            { ok: true, mode: "wallet-api-v2-server-trades" },

            200,

            cors

         );

      }



      try {

         const auth = request.headers.get("Authorization") || "";



         if (!auth.startsWith("Bearer ")) {

            return json(

               { error: "Firebase sign-in token is required." },

               401,

               cors

            );

         }



         const claims = await verifyUserToken(auth.slice(7));



         const url = new URL(request.url);

      const trades = createTradeEngine({
        ROOT,
        serviceToken: () => serviceToken(env),
        toFirestore,
        fieldsFromFirestore
      });


      if (url.pathname === "/v1/admin/trades" && request.method === "GET") {
        const result = await adminTradeMonitor(env, claims);
        const headers = new Headers(result.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(result.body, { status: result.status, headers });
      }

      if (url.pathname === "/v1/trades" && request.method === "POST") {
        const result = await trades.create(claims.sub, await request.json());
        return json(result, 201, cors);
      }

      if (url.pathname === "/v1/trades" && request.method === "GET") {
        return json(await trades.list(claims.sub), 200, cors);
      }



         if (

            url.pathname === "/v1/wallet" &&

            request.method === "GET"

         ) {

            const access = await serviceToken(env);



            const wallet = await readWallet(access, claims.sub);



            if (!wallet) {

               return json({

                  error: "Canonical wallet record is missing; no balance was created."

               }, 404, cors);

            }



            return json({

               uid: claims.sub,

               wallet: wallet.data,

               updateTime: wallet.updateTime

            }, 200, cors);

         }



         if (

            url.pathname === "/v1/admin/adjust-usdt" &&

            request.method === "POST"

         ) {

            const result = await adminAdjustment(

               env,

               null,

               claims,

               await request.json()

            );



            const headers = new Headers(result.headers);



            for (const [k, v] of Object.entries(cors)) {

               headers.set(k, v);

            }



            return new Response(result.body, {

               status: result.status,

               headers

            });

         }



         return json({

            error: "Route not found or not enabled in this migration stage."

         }, 404, cors);



      } catch (error) {

         return json({

            error: error?.message || "Wallet API request failed."

         }, 400, cors);

      }
  },
  async scheduled(event, env, ctx) {
    const trades = createTradeEngine({
      ROOT,
      serviceToken: () => serviceToken(env),
      toFirestore,
      fieldsFromFirestore
    });
    ctx.waitUntil(trades.settleDue());
  }
};
