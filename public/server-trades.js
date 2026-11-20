// Server-owned Quick Trade UI adapter. No browser-side price, P/L, or wallet settlement.
(function () {
  "use strict";
  const API = "https://onchainspro-wallet-api-v2.getachew21-inj-uni.workers.dev";
  const $ = id => document.getElementById(id);
  let activeTrade = null;
  let countdownTimer = null;
  let pollTimer = null;
  let polling = false;
  let restoredUid = null;

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
    const form = $("timedPaperTrade");
    form?.classList.remove("oc-stage-config", "oc-stage-complete", "oc-stage-error");
    form?.classList.add("oc-stage-running");
    for (const id of ["timedUpBtn", "timedDownBtn"]) if ($(id)) $(id).disabled = true;
    if ($("timedConfirmBtn")) $("timedConfirmBtn").disabled = true;
    const started = parseTime(trade.startedAt), expires = parseTime(trade.expiresAt);
    const symbol = trade.symbol, direction = trade.direction;
    const entry = Number(trade.entryPrice);
    if ($("timedPair")) $("timedPair").textContent = symbol + " / USDT";
    if ($("timedEntryPrice")) $("timedEntryPrice").textContent = money(entry);
    if ($("timedStartTime")) $("timedStartTime").textContent = new Date(started).toLocaleString();
    if ($("timedEndTime")) $("timedEndTime").textContent = new Date(expires).toLocaleString();
    if ($("timedDirection")) $("timedDirection").textContent = direction === "up" ? "BUY" : "SELL";
    if ($("timedAmountDetail")) $("timedAmountDetail").textContent = money(trade.amountFunding) + " " + (trade.fundingAsset || "USDT");
    if ($("timedEntryDetail")) $("timedEntryDetail").textContent = money(entry);
    if ($("timedEndPriceDetail")) $("timedEndPriceDetail").textContent = "Waiting for server settlement";
    if ($("timedMoveDetail")) $("timedMoveDetail").textContent = "—";
    if ($("timedPnl")) { $("timedPnl").textContent = "—"; $("timedPnl").className = "big"; }
    if ($("timedStatusDetail")) $("timedStatusDetail").textContent = "RUNNING";
    if ($("timedGraphStatus")) $("timedGraphStatus").textContent = "SERVER MANAGED";
    if ($("timedResult")) $("timedResult").textContent = "Trade running on the secure server" + (activeCount > 1 ? " · " + activeCount + " active trades" : "") + ". It will continue if you close this page.";
    const samples = [{ time: started, price: entry }];
    if (typeof window.drawTimedTradeGraph === "function") window.drawTimedTradeGraph(samples, entry);
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
      if ($("timedCountdown")) $("timedCountdown").textContent = timedFormat(remaining);
    }, 500);
  }
  function renderCompleted(trade) {
    if (!trade) return;
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    activeTrade = null;
    const form = $("timedPaperTrade");
    form?.classList.remove("oc-stage-config", "oc-stage-running", "oc-stage-error");
    form?.classList.add("oc-stage-complete");
    for (const id of ["timedUpBtn", "timedDownBtn"]) if ($(id)) $(id).disabled = false;
    if ($("timedConfirmBtn")) $("timedConfirmBtn").disabled = true;
    const entry = Number(trade.entry), exit = Number(trade.price), pnl = Number(trade.pnl);
    const amountUsd = Number(trade.amountUSDT || trade.amount || 0);
    const direction = trade.side === "buy" ? "up" : "down";
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
    const board = $("timedResultBoard");
    if (board) {
      board.style.display = "block";
      if ($("timedBoardOutcome")) { $("timedBoardOutcome").textContent = outcome; $("timedBoardOutcome").style.color = won ? "#07804b" : lost ? "#c53232" : "#586579"; }
      if ($("timedBoardSummary")) $("timedBoardSummary").textContent = "Server settled " + new Date(completed).toLocaleString() + " · Duration " + (trade.durationSeconds || "—") + " sec";
      if ($("timedBoardPair")) $("timedBoardPair").textContent = trade.symbol + " / USDT · " + (direction === "up" ? "BUY" : "SELL");
      if ($("timedBoardAmount")) $("timedBoardAmount").textContent = money(trade.amount || trade.amountFunding) + " " + (trade.funding || trade.fundingAsset || "USDT");
      if ($("timedBoardEntry")) $("timedBoardEntry").textContent = money(entry);
      if ($("timedBoardExit")) $("timedBoardExit").textContent = money(exit);
      if ($("timedBoardMove")) $("timedBoardMove").textContent = entry > 0 ? (((exit - entry) / entry) * 100).toFixed(5) + "%" : "—";
      if ($("timedBoardProfitLoss")) { $("timedBoardProfitLoss").textContent = (pnl > 0 ? "+" : "-") + money(Math.abs(pnl)) + " USDT"; $("timedBoardProfitLoss").style.color = won ? "#07804b" : lost ? "#c53232" : "#586579"; }
      if ($("timedBoardBefore")) $("timedBoardBefore").textContent = money(trade.balanceBefore);
      if ($("timedBoardAfter")) $("timedBoardAfter").textContent = money(trade.balanceAfter);
      if ($("timedBoardTitle")) $("timedBoardTitle").textContent = won ? "🎉 Congratulations! You Won!" : lost ? "Trade Complete — Loss" : "Trade Complete";
    }
    const samples = [{ time: parseTime(trade.startedAt), price: entry }, { time: completed, price: exit }];
    if (typeof window.drawTimedTradeGraph === "function") window.drawTimedTradeGraph(samples, entry);
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
      } else if (activeTrade?.tradeId) {
        const completed = recent.find(x => x.id === activeTrade.tradeId || x.tradeId === activeTrade.tradeId);
        if (completed) renderCompleted(completed);
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
    if (!user?.uid || window.ocTradeCloudReadyUid !== user.uid) {
      showMessage("Your account wallet is still syncing. Please wait and try again.", true);
      return;
    }
    const symbol = String($("tradeAsset")?.value || "").toUpperCase();
    const fundingAsset = String(window.__ocTradeFundingCoin || "USDT").toUpperCase();
    const amount = Number($("timedStake")?.value || 0);
    const direction = $("timedUpBtn")?.getAttribute("aria-pressed") === "true" ? "up" :
      $("timedDownBtn")?.getAttribute("aria-pressed") === "true" ? "down" : "";
    if (!direction) { showMessage("Choose Buy or Sell before confirming.", true); return; }
    const confirm = $("timedConfirmBtn");
    if (confirm) confirm.disabled = true;
    for (const id of ["timedUpBtn","timedDownBtn"]) if ($(id)) $(id).disabled = true;
    showMessage("Confirming your trade securely…");
    try {
      const result = await request("/v1/trades", { method: "POST", body: { symbol, direction, amount, fundingAsset } });
      if (!result.trade || !result.tradeId) throw new Error("The server did not return a confirmed trade.");
      renderRunning({ ...result.trade, tradeId: result.tradeId }, 1);
      await refreshTrades();
    } catch (error) {
      for (const id of ["timedUpBtn","timedDownBtn"]) if ($(id)) $(id).disabled = false;
      if (confirm) confirm.disabled = false;
      showMessage(error.message || "The server could not start this trade.", true);
    }
  }

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
