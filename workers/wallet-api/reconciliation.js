// Read-only reconciliation helpers. This module never writes to Firestore.
const finite = value => typeof value === "number" && Number.isFinite(value);

function millis(value) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === "object" && typeof value.toMillis === "function") {
    return value.toMillis();
  }
  if (value && typeof value === "object" && typeof value.seconds === "number") {
    return value.seconds * 1000;
  }
  return 0;
}

function checkChain(rows, beforeKey, afterKey, timeKey = "createdAtText") {
  const valid = rows.filter(row => finite(row[beforeKey]) && finite(row[afterKey]))
    .slice().sort((a, b) => millis(a[timeKey] || a.createdAt) - millis(b[timeKey] || b.createdAt));
  const breaks = [];
  for (let i = 1; i < valid.length; i += 1) {
    const prior = valid[i - 1][afterKey];
    const next = valid[i][beforeKey];
    if (Math.abs(prior - next) > 0.005) {
      breaks.push({ previousAfter: prior, nextBefore: next, difference: Number((next - prior).toFixed(8)) });
    }
  }
  return {
    entries: valid.length,
    firstBefore: valid.length ? valid[0][beforeKey] : null,
    lastAfter: valid.length ? valid[valid.length - 1][afterKey] : null,
    continuityBreaks: breaks
  };
}

export function buildWalletReconciliationReport({ uid, wallet, walletLedger = [], tradeHistory = [], transfers = [], depositRequests = [], withdrawRequests = [] }) {
  if (!uid || typeof uid !== "string") throw new TypeError("A user UID is required.");
  const walletBalance = wallet && finite(wallet.balance) ? wallet.balance : null;
  const rows = walletLedger.filter(row => row.uid === uid && row.asset && finite(row.balanceBefore) && finite(row.balanceAfter));
  const assets = [...new Set(rows.map(row => String(row.asset)))].sort();
  const ledgerChecksByAsset = Object.fromEntries(assets.map(asset => [
    asset,
    checkChain(rows.filter(row => String(row.asset) === asset), "balanceBefore", "balanceAfter", "createdAtText")
  ]));
  const tradeRows = tradeHistory.filter(row => finite(row.balanceBefore) && finite(row.balanceAfter));
  const sent = transfers.filter(row => row.senderUid === uid && finite(row.senderBefore) && finite(row.senderAfter));
  const received = transfers.filter(row => row.recipientUid === uid && finite(row.recipientBefore) && finite(row.recipientAfter));

  return {
    uid,
    readOnly: true,
    balances: { canonicalWalletBalanceUSDT: walletBalance, source: "userTradeState/{uid}" },
    ledgerChecks: {
      canonicalWalletLedgerByAsset: ledgerChecksByAsset,
      tradeHistory: checkChain(tradeRows, "balanceBefore", "balanceAfter", "time"),
      outgoingTransfers: checkChain(sent, "senderBefore", "senderAfter"),
      incomingTransfers: checkChain(received, "recipientBefore", "recipientAfter")
    },
    evidenceCounts: {
      walletLedgerEntries: walletLedger.filter(row => row.uid === uid).length,
      tradeHistoryEntriesWithBalanceSnapshots: tradeRows.length,
      outgoingTransfers: sent.length,
      incomingTransfers: received.length,
      pendingDepositRequests: depositRequests.filter(row => row.uid === uid && row.status === "pending").length,
      pendingWithdrawalRequests: withdrawRequests.filter(row => row.uid === uid && row.status === "pending").length
    },
    limitations: [
      "userTradeState/{uid} is the only wallet balance source.",
      "Requests are not proof of a completed deposit or external payout.",
      "Ledger continuity does not prove completeness if records are missing.",
      "This report is read-only and never reconciles or changes balances."
    ]
  };
}
