// Server-owned Quick Trade UI adapter. No browser-side price, P/L, or wallet settlement.
(function () {
  "use strict";
  const API = "https://onchainspro-wallet-api-v2.getachew21-inj-uni.workers.dev";
  const $ = id => document.getElementById(id);
  let activeTrade = null;
  let countdownTimer = null;
  let pollTimer = null;
  let polling = false;
  let creatingTrade = false;
  let restoredUid = null;
  let lastCompletedTradeId = null;
  const tradeSamples = new Map();

  function dismissedKey(tradeId) {
    const uid = window.ocFirebaseAuth?.currentUser?.uid || "unknown";
    return "oc-trade-result-dismissed:" + uid + ":" + String(tradeId || "");
  }
  function isResultDismissed(tradeId) {
    if (!tradeId) return false;
    try { return localStorage.getItem(dismissedKey(tradeId)) === "1"; } catch (_) { return false; }
  }
  function markResultDismissed(tradeId) {
    if (!tradeId) return;
    try { localStorage.setItem(dismissedKey(tradeId), "1"); } catch (_) {}
  }
  function showWinNotification(trade) {
    const amount = Math.abs(Number(trade?.pnl));
    const symbol = String(trade?.symbol || "your asset").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 20);
    let toast = document.getElementById("oc-trade-win-notification");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "oc-trade-win-notification";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      Object.assign(toast.style, {
        position: "fixed", left: "50%", bottom: "calc(24px + env(safe-area-inset-bottom))",
        transform: "translateX(-50%)", zIndex: "100000", width: "min(92vw, 390px)",
        padding: "14px 18px", borderRadius: "14px", background: "#123b2b",
        color: "#ffffff", border: "1px solid #25bd78", boxShadow: "0 10px 32px rgba(0,0,0,.28)",
        font: "600 14px/1.45 Inter, Arial, sans-serif", textAlign: "center",
        opacity: "0", transition: "opacity .2s ease"
      });
      document.body.appendChild(toast);
    }
    toast.textContent = "🎉 Congratulations! You won " + money(amount) + " USDT on " + symbol + ".";
    toast.style.display = "block";
    requestAnimationFrame(() => { toast.style.opacity = "1"; });
    clearTimeout(toast._ocHideTimer);
    toast._ocHideTimer = setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => { if (toast.isConnected && toast.style.opacity === "0") toast.style.display = "none"; }, 250);
    }, 6000);
  }
  function showMessage(message, error = false) {
    const node = $("timedResult");
    if (node) {
      node.textContent = message;
      node.className = "muted tiny " + (error ? "red" : "");
    }
  }
  async function request(path, options = {}) {
    const auth = window.ocFirebaseAuth;
    const user = auth?.currentUser;
    if (!user?.uid) throw new Error("Please sign in before using Quick Trade.");
    const token = await user.getIdToken();
    const response = await fetch(API + path, {
      method: options.method || "GET",
      cache: "no-store",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "The secure trade service is unavailable.");
    return result;
  }
  function parseTime(value) {
    const n = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(n) ? n : 0;
  }
  function renderRunning(trade, activeCount = 1) {
    activeTrade = trade;
    lastCompletedTradeId = null;
    const form = $("timedPaperTrade");
    form?.classList.remove("oc-stage-config", "oc-stage-complete", "oc-stage-error");
    form?.classList.add("oc-stage-running");
    const board = $("timedResultBoard");
    if (board) board.style.display = "none";
    for (const id of ["timedUpBtn", "timedDownBtn"]) if ($(id)) $(id).disabled = true;
    if ($("timedConfirmBtn")) $("timedConfirmBtn").disabled = true;
    const started = parseTime(trade.startedAt), expires = parseTime(trade.expiresAt);
    const symbol = trade.symbol, direction = trade.direction;
    const entry = Number(trade.entryPrice);
    const tradeId = trade.tradeId || trade.id;
    if (!tradeSamples.has(tradeId)) tradeSamples.set(tradeId, [{ time: started, price: entry }]);
    const samples = tradeSamples.get(tradeId);
    const latest = Number(trade.latestPrice);
    if (Number.isFinite(latest) && latest > 0) {
      const sampledAt = parseTime(trade.priceSampledAt) || Date.now();
      const previous = samples[samples.length - 1];
      if (!previous || sampledAt > previous.time) samples.push({ time: sampledAt, price: latest });
      const move = (latest - entry) / entry;
      const estimated = Number(trade.amountUSDT) * (direction === "up" ? move : -move);
      if ($("timedEndPriceDetail")) $("timedEndPriceDetail").textContent = money(latest);
      if ($("timedMoveDetail")) $("timedMoveDetail").textContent = (move >= 0 ? "+" : "") + (move * 100).toFixed(5) + "%";
      if ($("timedPnl")) {
        $("timedPnl").textContent = (estimated > 0 ? "+" : estimated < 0 ? "−" : "") + money(Math.abs(estimated)) + " USDT";
        $("timedPnl").className = "big " + (estimated > 0 ? "green" : estimated < 0 ? "red" : "");
      }
      if ($("timedGraphStatus")) $("timedGraphStatus").textContent = "LIVE SERVER PRICE";
    } else {
      if ($("timedEndPriceDetail")) $("timedEndPriceDetail").textContent = "Price feed reconnecting…";
      if ($("timedGraphStatus")) $("timedGraphStatus").textContent = "PRICE FEED RECONNECTING";
    }
    if ($("timedPair")) $("timedPair").textContent = symbol + " / USDT";
    if ($("timedEntryPrice")) $("timedEntryPrice").textContent = money(entry);
    if ($("timedStartTime")) $("timedStartTime").textContent = new Date(started).toLocaleString();
    if ($("timedEndTime")) $("timedEndTime").textContent = new Date(expires).toLocaleString();
    if ($("timedDirection")) $("timedDirection").textContent = direction === "up" ? "BUY" : "SELL";
    if ($("timedAmountDetail")) $("timedAmountDetail").textContent = money(trade.amountFunding) + " " + (trade.fundingAsset || "USDT");
    if ($("timedEntryDetail")) $("timedEntryDetail").textContent = money(entry);
    if ($("timedStatusDetail")) $("timedStatusDetail").textContent = "RUNNING";
    if ($("timedResult")) $("timedResult").textContent = "Trade running on the secure server" + (activeCount > 1 ? " · " + activeCount + " active trades" : "") + ". Live price samples and estimated P/L refresh automatically.";
    if (typeof window.drawTimedTradeGraph === "function") window.drawTimedTradeGraph(samples, entry);
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
      if ($("timedCountdown")) $("timedCountdown").textContent = timedFormat(remaining);
    }, 500);
  }
  function renderCompleted(trade) {
    if (!trade) return;
    const dismissedTradeId = trade.tradeId || trade.id;
    if (isResultDismissed(dismissedTradeId)) {
      lastCompletedTradeId = dismissedTradeId;
      const board = $("timedResultBoard");
      if (board) { board.dataset.dismissed = "true"; board.hidden = true; board.style.display = "none"; }
      const form = $("timedPaperTrade");
      if (form) { form.classList.remove("oc-stage-running", "oc-stage-complete", "oc-stage-error"); form.classList.add("oc-stage-config"); }
      return;
    }
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    const completedActiveTrade = activeTrade;
    activeTrade = null;
    const form = $("timedPaperTrade");
    form?.classList.remove("oc-stage-config", "oc-stage-running", "oc-stage-error");
    form?.classList.add("oc-stage-complete");
    for (const id of ["timedUpBtn", "timedDownBtn"]) if ($(id)) $(id).disabled = false;
    if ($("timedConfirmBtn")) $("timedConfirmBtn").disabled = true;
    const entry = Number(trade.entry), exit = Number(trade.price), pnl = Number(trade.pnl);
    const amountUsd = Number(trade.amountUSDT || trade.amount || 0);
    const direction = trade.side === "buy" ? "up" : "down";
    const tradeKeyForNotice = trade.tradeId || trade.id;
    const notifyThisWin = pnl > 0 && Boolean(completedActiveTrade && (completedActiveTrade.tradeId === tradeKeyForNotice || completedActiveTrade.id === tradeKeyForNotice));
    const won = pnl > 0, lost = pnl < 0;
    const outcome = won ? "WIN +" + money(Math.abs(pnl)) + " USDT" : lost ? "LOSS -" + money(Math.abs(pnl)) + " USDT" : "EVEN · 0.00 USDT";
    const completed = parseTime(trade.completedAt || trade.time);
    if ($("timedCountdown")) $("timedCountdown").textContent = "00:00";
    if ($("timedEntryPrice")) $("timedEntryPrice").textContent = money(entry);
    if ($("timedEndTime")) $("timedEndTime").textContent = new Date(completed).toLocaleString();
    if ($("timedEndPriceDetail")) $("timedEndPriceDetail").textContent = money(exit);
    if ($("timedMoveDetail")) $("timedMoveDetail").textContent = entry > 0 ? (((exit - entry) / entry) * 100).toFixed(5) + "%" : "—";
    if ($("timedPnl")) { $("timedPnl").textContent = outcome; $("timedPnl").className = "big " + (won ? "green" : lost ? "red" : ""); }
    if ($("timedStatusDetail")) $("timedStatusDetail").textContent = outcome;
    if ($("timedGraphStatus")) $("timedGraphStatus").textContent = "SETTLED BY SERVER";
    showMessage(outcome + " · " + trade.symbol + " · Result confirmed and saved by the server.");
    if (notifyThisWin) showWinNotification(trade);
    const board = $("timedResultBoard");
    if (board) {
      board.dataset.tradeId = trade.tradeId || trade.id || "";
      board.dataset.dismissed = "false";
      board.hidden = false;
      board.style.display = "block";
      if ($("timedBoardOutcome")) { $("timedBoardOutcome").textContent = outcome; $("timedBoardOutcome").style.color = won ? "#07804b" : lost ? "#c53232" : "#586579"; }
      if ($("timedBoardSummary")) $("timedBoardSummary").textContent = "Your trade is complete.";
      if ($("timedBoardPair")) $("timedBoardPair").textContent = trade.symbol + " / USDT · " + (direction === "up" ? "BUY" : "SELL");
      if ($("timedBoardAmount")) $("timedBoardAmount").textContent = money(trade.amount || trade.amountFunding) + " " + (trade.funding || trade.fundingAsset || "USDT");
      if ($("timedBoardEntry")) $("timedBoardEntry").textContent = money(entry);
      if ($("timedBoardExit")) $("timedBoardExit").textContent = money(exit);
      if ($("timedBoardMove")) $("timedBoardMove").textContent = entry > 0 ? (((exit - entry) / entry) * 100).toFixed(5) + "%" : "—";
      if ($("timedBoardDuration")) { const seconds = Math.max(0, Math.round((completed - parseTime(trade.startedAt)) / 1000)); $("timedBoardDuration").textContent = seconds + " seconds"; }
      if ($("timedBoardProfitLoss")) { $("timedBoardProfitLoss").textContent = (pnl > 0 ? "+" : "-") + money(Math.abs(pnl)) + " USDT"; $("timedBoardProfitLoss").style.color = won ? "#07804b" : lost ? "#c53232" : "#586579"; }
      if ($("timedBoardBefore")) $("timedBoardBefore").textContent = money(trade.balanceBefore);
      if ($("timedBoardAfter")) $("timedBoardAfter").textContent = money(trade.balanceAfter);
      if ($("timedBoardTitle")) $("timedBoardTitle").textContent = won ? "Trade Won" : lost ? "Trade Lost" : "Trade Complete";
    }
    const tradeKey = trade.tradeId || trade.id;
    const samples = [...(tradeSamples.get(tradeKey) || [{ time: parseTime(trade.startedAt), price: entry }])];
    const lastSample = samples[samples.length - 1];
    if (!lastSample || completed > lastSample.time) samples.push({ time: completed, price: exit });
    if (typeof window.drawTimedTradeGraph === "function") window.drawTimedTradeGraph(samples, entry);
    tradeSamples.delete(tradeKey);
    if (typeof window.drawTimedPnlGraph === "function") window.drawTimedPnlGraph(samples, entry, amountUsd, direction, "timedBoardPnlChart", pnl);
  }
  async function refreshTrades(showErrors = false) {
    if (polling) return;
    const user = window.ocFirebaseAuth?.currentUser;
    if (!user?.uid) return;
    polling = true;
    try {
      const data = await request("/v1/trades");
      const active = Array.isArray(data.activeTrades) ? data.activeTrades : [];
      const recent = Array.isArray(data.recentTrades) ? data.recentTrades : [];
      if (active.length) {
        active.sort((a,b) => parseTime(a.expiresAt) - parseTime(b.expiresAt));
        const current = active.find(x => x.id === activeTrade?.tradeId) || active[0];
        renderRunning({ ...current, tradeId: current.id }, active.length);
      } else {
        const completed = activeTrade?.tradeId
          ? recent.find(x => x.id === activeTrade.tradeId || x.tradeId === activeTrade.tradeId)
          : recent[0];
        const completedId = completed?.id || completed?.tradeId;
        if (completed && completedId && completedId !== lastCompletedTradeId) {
          lastCompletedTradeId = completedId;
          renderCompleted(completed);
        }
      }
    } catch (error) {
      if (showErrors) showMessage(error.message || "Could not load server trades.", true);
      else console.warn("Server trade refresh failed:", error.message || error);
    } finally {
      polling = false;
    }
  }
  async function startServerTrade() {
    const user = window.ocFirebaseAuth?.currentUser;
    if (!user?.uid) {
      showMessage("Please sign in before using Quick Trade.", true);
      return;
    }
    const symbol = String($("tradeAsset")?.value || "").toUpperCase();
    const fundingAsset = String(window.__ocTradeFundingCoin || "USDT").toUpperCase();
    const amount = Number($("timedStake")?.value || 0);
    const direction = $("timedUpBtn")?.getAttribute("aria-pressed") === "true" ? "up" :
      $("timedDownBtn")?.getAttribute("aria-pressed") === "true" ? "down" : "";
    if (!symbol) { showMessage("Choose a trading pair before confirming.", true); return; }
    if (!Number.isFinite(amount) || amount <= 0) {
      showMessage("Enter a valid trade amount before confirming.", true);
      window.ocValidateQuickTradeForm?.();
      return;
    }
    if (!direction) { showMessage("Choose Buy or Sell before confirming.", true); return; }
    const confirm = $("timedConfirmBtn");
    if (creatingTrade) return;
    creatingTrade = true;
    if (confirm) confirm.disabled = true;
    for (const id of ["timedUpBtn","timedDownBtn"]) if ($(id)) $(id).disabled = true;
    // Do not count down while the secure server is validating and reserving the trade.
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    if ($("timedCountdown")) $("timedCountdown").textContent = "—";
    showMessage("Starting your trade securely…");
    try {
      const result = await request("/v1/trades", { method: "POST", body: { symbol, direction, amount, fundingAsset } });
      if (!result.trade || !result.tradeId) throw new Error("The server did not return a confirmed trade.");
      renderRunning({ ...result.trade, tradeId: result.tradeId }, 1);
      await refreshTrades();
    } catch (error) {
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = null;
      if ($("timedCountdown")) $("timedCountdown").textContent = "—";
      for (const id of ["timedUpBtn","timedDownBtn"]) if ($(id)) $(id).disabled = false;
      if (typeof window.ocValidateQuickTradeForm === "function") window.ocValidateQuickTradeForm();
      else if (confirm) confirm.disabled = false;
      showMessage(error.message || "The server could not start this trade.", true);
    } finally {
      creatingTrade = false;
    }
  }

  document.addEventListener("click", event => {
    const close = event.target?.closest?.("#timedBoardClose");
    if (close) { const board = $("timedResultBoard"); markResultDismissed(board?.dataset.tradeId || lastCompletedTradeId); }
  }, true);

  // A running trade belongs to the server and cannot be cancelled by closing or
  // navigating away from the browser.
  document.addEventListener("click", event => {
    const cancel = event.target?.closest?.("#timedCancelBtn");
    if (cancel && (activeTrade || creatingTrade)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showMessage("This confirmed trade continues on the server until its expiry.");
    }
  }, true);

  // Capture phase prevents the old browser-only timer and client-side P/L handler
  // from running. There is deliberately no local fallback.
  document.addEventListener("click", event => {
    const button = event.target?.closest?.("#timedConfirmBtn");
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void startServerTrade();
  }, true);

  window.ocRestoreServerTrades = async function () {
    const uid = window.ocFirebaseAuth?.currentUser?.uid;
    if (!uid || window.ocTradeCloudReadyUid !== uid || restoredUid === uid) return;
    restoredUid = uid;
    await refreshTrades(true);
  };
  window.addEventListener("focus", () => { void refreshTrades(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshTrades(); });
  let lastIdlePoll = 0;
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    const uid = window.ocFirebaseAuth?.currentUser?.uid;
    if (uid && window.ocTradeCloudReadyUid === uid) {
      if (restoredUid !== uid) void window.ocRestoreServerTrades();
      else if (activeTrade || Date.now() - lastIdlePoll >= 15000) {
        if (!activeTrade) lastIdlePoll = Date.now();
        void refreshTrades();
      }
    } else if (!uid) restoredUid = null;
  }, 5000);
  void pollTimer;
})();
