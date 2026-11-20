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

export function buildWalletReconciliationReport({ uid, profile, wallet, demoTransactions = [], tradeHistory = [], transfers = [], depositRequests = [], withdrawRequests = [] }) {
  if (!uid || typeof uid !== "string") throw new TypeError("A user UID is required.");
  const profileBalance = profile && finite(profile.demoBalanceUSDT) ? profile.demoBalanceUSDT : null;
  const walletBalance = wallet && finite(wallet.balance) ? wallet.balance : null;
  const difference = profileBalance === null || walletBalance === null
    ? null : Number((walletBalance - profileBalance).toFixed(8));

  const usdtRows = demoTransactions.filter(row => row.uid === uid && row.type && finite(row.balanceBeforeUSDT) && finite(row.balanceAfterUSDT));
  const tradeRows = tradeHistory.filter(row => finite(row.balanceBefore) && finite(row.balanceAfter));
  const sent = transfers.filter(row => row.senderUid === uid && finite(row.senderBefore) && finite(row.senderAfter));
  const received = transfers.filter(row => row.recipientUid === uid && finite(row.recipientBefore) && finite(row.recipientAfter));

  return {
    uid,
    readOnly: true,
    balances: { profileDemoBalanceUSDT: profileBalance, canonicalWalletBalanceUSDT: walletBalance, canonicalMinusProfileUSDT: difference },
    ledgerChecks: {
      adminUSDT: checkChain(usdtRows, "balanceBeforeUSDT", "balanceAfterUSDT"),
      tradeHistory: checkChain(tradeRows, "balanceBefore", "balanceAfter", "time"),
      outgoingTransfers: checkChain(sent, "senderBefore", "senderAfter"),
      incomingTransfers: checkChain(received, "recipientBefore", "recipientAfter")
    },
    evidenceCounts: {
      adminUSDTLedgerEntries: usdtRows.length,
      tradeHistoryEntriesWithBalanceSnapshots: tradeRows.length,
      outgoingTransfers: sent.length,
      incomingTransfers: received.length,
      pendingDepositRequests: depositRequests.filter(row => row.uid === uid && row.status === "pending").length,
      pendingWithdrawalRequests: withdrawRequests.filter(row => row.uid === uid && row.status === "pending").length
    },
    limitations: [
      "A balance difference is not proof that either stored balance is correct.",
      "Requests are not proof of a completed deposit or payout.",
      "Ledger continuity does not prove completeness if records are missing.",
      "No balance is selected, merged, seeded, or modified by this report."
    ]
  };
}
