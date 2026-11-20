import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWalletReconciliationReport } from "../workers/wallet-api/reconciliation.js";

describe("read-only wallet reconciliation", () => {
  it("reports the two balance values and their difference without mutating inputs", () => {
    const profile = { demoBalanceUSDT: 55182.14 };
    const wallet = { balance: 61430.07 };
    const profileBefore = structuredClone(profile);
    const walletBefore = structuredClone(wallet);
    const report = buildWalletReconciliationReport({ uid: "user-1", profile, wallet });
    assert.equal(report.readOnly, true);
    assert.equal(report.balances.canonicalMinusProfileUSDT, 6247.93);
    assert.deepEqual(profile, profileBefore);
    assert.deepEqual(wallet, walletBefore);
  });

  it("detects gaps in ledger balance snapshots instead of silently adding them", () => {
    const report = buildWalletReconciliationReport({
      uid: "user-1",
      profile: { demoBalanceUSDT: 100 },
      wallet: { balance: 130 },
      demoTransactions: [
        { uid: "user-1", type: "deposit", balanceBeforeUSDT: 50, balanceAfterUSDT: 100, createdAtText: "2026-01-01T00:00:00Z" },
        { uid: "user-1", type: "withdrawal", balanceBeforeUSDT: 90, balanceAfterUSDT: 80, createdAtText: "2026-01-02T00:00:00Z" }
      ]
    });
    assert.equal(report.ledgerChecks.adminUSDT.entries, 2);
    assert.equal(report.ledgerChecks.adminUSDT.continuityBreaks.length, 1);
    assert.equal(report.ledgerChecks.adminUSDT.continuityBreaks[0].difference, -10);
  });

  it("counts only pending requests as pending evidence and never treats them as credits", () => {
    const report = buildWalletReconciliationReport({
      uid: "user-1",
      profile: { demoBalanceUSDT: 0 },
      wallet: { balance: 0 },
      depositRequests: [{ uid: "user-1", status: "pending", amount: 999 }],
      withdrawRequests: [{ uid: "user-1", status: "approved", amount: 5 }]
    });
    assert.equal(report.evidenceCounts.pendingDepositRequests, 1);
    assert.equal(report.evidenceCounts.pendingWithdrawalRequests, 0);
    assert.equal(report.ledgerChecks.adminUSDT.entries, 0);
  });

  it("rejects reports without a UID", () => {
    assert.throws(() => buildWalletReconciliationReport({}), /UID/);
  });
});
