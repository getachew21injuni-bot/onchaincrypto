import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWalletReconciliationReport } from "../workers/wallet-api/reconciliation.js";

describe("read-only canonical wallet reconciliation", () => {
  it("reports only the canonical Firestore wallet balance as the balance source", () => {
    const wallet = { balance: 61430.07 };
    const before = structuredClone(wallet);
    const report = buildWalletReconciliationReport({ uid: "user-1", wallet });
    assert.equal(report.readOnly, true);
    assert.equal(report.balances.canonicalWalletBalanceUSDT, 61430.07);
    assert.equal(report.balances.source, "userTradeState/{uid}");
    assert.equal("profileDemoBalanceUSDT" in report.balances, false);
    assert.deepEqual(wallet, before);
  });

  it("detects ledger continuity gaps independently for each asset", () => {
    const report = buildWalletReconciliationReport({
      uid: "user-1",
      wallet: { balance: 130 },
      walletLedger: [
        { uid: "user-1", asset: "USDT", balanceBefore: 50, balanceAfter: 100, createdAtText: "2026-01-01T00:00:00Z" },
        { uid: "user-1", asset: "USDT", balanceBefore: 90, balanceAfter: 80, createdAtText: "2026-01-02T00:00:00Z" },
        { uid: "user-1", asset: "BTC", balanceBefore: 0.1, balanceAfter: 0.2, createdAtText: "2026-01-03T00:00:00Z" }
      ]
    });
    const usdt = report.ledgerChecks.canonicalWalletLedgerByAsset.USDT;
    assert.equal(usdt.entries, 2);
    assert.equal(usdt.continuityBreaks.length, 1);
    assert.equal(usdt.continuityBreaks[0].difference, -10);
    assert.equal(report.ledgerChecks.canonicalWalletLedgerByAsset.BTC.entries, 1);
  });

  it("counts only pending requests and never treats them as completed credits", () => {
    const report = buildWalletReconciliationReport({
      uid: "user-1",
      wallet: { balance: 0 },
      depositRequests: [{ uid: "user-1", status: "pending", amount: 999 }],
      withdrawRequests: [{ uid: "user-1", status: "approved", amount: 5 }]
    });
    assert.equal(report.evidenceCounts.pendingDepositRequests, 1);
    assert.equal(report.evidenceCounts.pendingWithdrawalRequests, 0);
    assert.equal(report.evidenceCounts.walletLedgerEntries, 0);
  });

  it("rejects reports without a UID", () => {
    assert.throws(() => buildWalletReconciliationReport({}), /UID/);
  });
});
