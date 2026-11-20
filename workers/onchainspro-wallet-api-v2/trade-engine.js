// Server-authoritative Quick Trade engine for the OnChainSpro wallet Worker.
// Firestore is the source of truth. The browser may request a trade and display it;
// only this module creates, prices, expires, and settles it.
const ASSETS = new Set(["BTC","ETH","BNB","XRP","SOL","ADA","DOGE","LTC","TRX","XAU"]);
const DURATIONS = [30,60,90,120,180,360];
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const safeNumber = n => Number.isFinite(Number(n)) ? Number(n) : 0;

export function createTradeEngine({ ROOT, serviceToken, fromFirestore, toFirestore, fieldsFromFirestore }) {
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
    const pair = symbol === "XAU" ? "XAUUSDT" : symbol + "USDT";
    const url = symbol === "XAU"
      ? "https://fapi.binance.com/fapi/v1/ticker/price?symbol=" + pair
      : "https://data-api.binance.vision/api/v3/ticker/price?symbol=" + pair;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("The server price feed is temporarily unavailable.");
    const result = await response.json();
    const price = Number(result.price);
    if (!(price > 0) || !Number.isFinite(price)) throw new Error("The server returned an invalid market price.");
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
    if (response.status === 409 || response.status === 412) throw new Error("TRADE_CONFLICT");
    if (!response.ok) throw new Error("Atomic Firestore trade write failed.");
    return response.json();
  }
  const enc = (collection, id) => docUrl(collection, id);
  const timestamp = value => ({ timestampValue: new Date(value).toISOString() });
  const writeDoc = (name, data, currentDocument) => ({
    update: { name, fields: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, toFirestore(v)])) },
    currentDocument
  });

  async function create(uid, body) {
    if (!uid) throw new Error("Sign in before starting a trade.");
    const symbol = String(body?.symbol || "").toUpperCase();
    const direction = String(body?.direction || "");
    const stake = round2(safeNumber(body?.amountUSDT));
    if (!ASSETS.has(symbol) || !["up","down"].includes(direction) || !(stake > 0) || stake > 1000000) {
      throw new Error("Invalid trade details.");
    }
    const access = await serviceToken();
    const [wallet, setting] = await Promise.all([readDoc(access, "userTradeState", uid), controls(access, uid)]);
    if (!wallet || !wallet.updateTime) throw new Error("Your cloud wallet is unavailable. No trade was created.");
    const balance = safeNumber(wallet.data.balance);
    if (balance < 0) throw new Error("Your cloud wallet balance is invalid.");
    const p = plan(stake, symbol);
    if (!p) throw new Error("The amount does not fit an available investment level.");
    const user = await readDoc(access, "users", uid);
    const max = safeNumber(user?.data?.maxTradeAmountUSDT);
    if (max > 0 && stake > max) throw new Error("This trade exceeds your account's maximum trade amount.");
    const entry = await quote(symbol);
    const guard = await readDoc(access, "activeTradeGuards", uid);
    const reserved = safeNumber(guard?.data?.reservedUSDT);
    if (balance - reserved + 1e-8 < stake) throw new Error("Insufficient available USDT after accounting for your other active trades.");
    const now = Date.now(), id = crypto.randomUUID(), expiresAt = now + p.duration * 1000;
    const trade = {
      uid, symbol, direction, amountUSDT: stake, entryPrice: entry, exitPrice: null,
      startedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
      durationSeconds: p.duration, planLevel: p.label, payoutRate: p.rate,
      outcomeMode: setting.mode, winPercent: setting.winPercent, lossPercent: setting.lossPercent,
      status: "active", pnlUSDT: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
    };
    const nextGuard = { uid, reservedUSDT: round2(reserved + stake), activeCount: safeNumber(guard?.data?.activeCount) + 1, updatedAt: new Date(now).toISOString() };
    const guardWrite = guard
      ? writeDoc(enc("activeTradeGuards", uid), nextGuard, { updateTime: guard.updateTime })
      : writeDoc(enc("activeTradeGuards", uid), nextGuard, { exists: false });
    try {
      await commit(access, [
        guardWrite,
        writeDoc(enc("activeTrades", id), { ...trade, tradeId: id }, { exists: false })
      ]);
    } catch (error) {
      if (error.message === "TRADE_CONFLICT") throw new Error("Your wallet or active trades changed. Please try confirming again.");
      throw error;
    }
    return { tradeId: id, trade, availableUSDT: round2(balance - nextGuard.reservedUSDT) };
  }

  async function list(uid) {
    const access = await serviceToken();
    const [active, recent] = await Promise.all([
      query(access, { from: [{ collectionId: "activeTrades" }], where: { compositeFilter: { op: "AND", filters: [
        { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } },
        { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "active" } } }
      ] } }, orderBy: [{ field: { fieldPath: "expiresAt" }, direction: "ASCENDING" }], limit: 100 }),
      query(access, { from: [{ collectionId: "tradeLedger" }], where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } }, orderBy: [{ field: { fieldPath: "completedAt" }, direction: "DESCENDING" }], limit: 30 })
    ]);
    return { activeTrades: active.map(x => ({ id: x.id, ...x.data })), recentTrades: recent.map(x => ({ id: x.id, ...x.data })) };
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
      const completedAt = new Date().toISOString();
      const result = {
        id: "quick-" + item.id, kind: "quick-result", side: trade.data.direction === "up" ? "buy" : "sell",
        symbol: trade.data.symbol, amount: trade.data.amountUSDT, qty: Number(trade.data.amountUSDT) / Number(trade.data.entryPrice),
        price: exit, entry: Number(trade.data.entryPrice), pnl, time: completedAt, funding: "USDT",
        balanceAdjustment: pnl, settlementAsset: "USDT", status: pnl > 0 ? "win" : pnl < 0 ? "loss" : "even",
        serverTradeId: item.id
      };
      history.unshift(result);
      const guardData = guard.data || {};
      const nextGuard = {
        uid, reservedUSDT: round2(Math.max(0, safeNumber(guardData.reservedUSDT) - Number(trade.data.amountUSDT))),
        activeCount: Math.max(0, safeNumber(guardData.activeCount) - 1), updatedAt: completedAt
      };
      const completed = { ...trade.data, status: "completed", exitPrice: exit, pnlUSDT: pnl, completedAt, updatedAt: completedAt };
      const ledger = { ...result, uid, tradeId: item.id, balanceBefore: before, balanceAfter: after, completedAt, settlementSource: "server-cron" };
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
    const now = new Date().toISOString();
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
