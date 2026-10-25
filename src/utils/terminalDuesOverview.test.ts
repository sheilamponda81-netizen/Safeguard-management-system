import { describe, it, expect } from 'vitest';
import {
  computeEntitlementFinancials,
  summarizeTerminalDuesOverview,
  matchesOverviewFilter,
  OverviewEntitlement,
  OverviewAllocation,
} from './terminalDuesOverview';

function entitlement(overrides: Partial<OverviewEntitlement> = {}): OverviewEntitlement {
  return { id: 'due-1', status: 'approved', total_payable: 343000, ...overrides };
}

function allocation(overrides: Partial<OverviewAllocation> = {}): OverviewAllocation {
  return { terminal_due_id: 'due-1', status: 'approved', proposed_amount: 100000, last_decided_amount: null, ...overrides };
}

describe('computeEntitlementFinancials', () => {
  it('matches the Alfred George ground-truth example exactly (BUG 2 regression: zero processed must never read as Partially Settled)', () => {
    // Entitlement 343,000; one approved (unprocessed) allocation of 100,000;
    // nothing has actually been paid yet.
    const result = computeEntitlementFinancials(entitlement(), [allocation()]);
    expect(result.totalEntitlement).toBe(343000);
    expect(result.actuallyPaid).toBe(0);
    expect(result.approvedUnprocessed).toBe(100000);
    expect(result.remainingLiability).toBe(343000);
    expect(result.availableForFutureAllocation).toBe(243000);
    // BUG 2: an approved-but-unprocessed allocation must never make this
    // read as "partially processed" -- nothing has been paid at all.
    expect(result.settlementStatus).toBe('not_yet_processed');
  });

  it('BUG 2 regression: after Alfred George\'s MK 100,000 allocation is actually processed, the status becomes Partially Settled -- never before', () => {
    const result = computeEntitlementFinancials(entitlement(), [
      allocation({ status: 'processed', proposed_amount: 100000, last_decided_amount: 100000 }),
    ]);
    expect(result.actuallyPaid).toBe(100000);
    expect(result.approvedUnprocessed).toBe(0);
    expect(result.remainingLiability).toBe(243000);
    expect(result.settlementStatus).toBe('partially_processed');
  });

  it('BUG 2 regression: approvedSum alone, at any size, never changes settlementStatus away from not_yet_processed', () => {
    const result = computeEntitlementFinancials(entitlement({ total_payable: 100000 }), [
      allocation({ status: 'approved', proposed_amount: 100000, last_decided_amount: 100000 }), // fully reserved, nothing processed
    ]);
    expect(result.actuallyPaid).toBe(0);
    expect(result.settlementStatus).toBe('not_yet_processed');
  });

  it('never counts an approved-but-unprocessed allocation as paid', () => {
    const result = computeEntitlementFinancials(entitlement({ total_payable: 100000 }), [
      allocation({ status: 'approved', proposed_amount: 100000 }),
    ]);
    expect(result.actuallyPaid).toBe(0);
    expect(result.approvedUnprocessed).toBe(100000);
  });

  it('counts only processed allocations as actually paid', () => {
    const result = computeEntitlementFinancials(entitlement({ total_payable: 200000 }), [
      allocation({ status: 'processed', proposed_amount: 80000, last_decided_amount: 80000 }),
    ]);
    expect(result.actuallyPaid).toBe(80000);
    expect(result.remainingLiability).toBe(120000);
    expect(result.settlementStatus).toBe('partially_processed');
  });

  it('prefers last_decided_amount over proposed_amount for processed and approved allocations', () => {
    const result = computeEntitlementFinancials(entitlement({ total_payable: 200000 }), [
      allocation({ status: 'processed', proposed_amount: 90000, last_decided_amount: 85000 }),
      allocation({ status: 'approved', proposed_amount: 50000, last_decided_amount: 45000 }),
    ]);
    expect(result.actuallyPaid).toBe(85000);
    expect(result.approvedUnprocessed).toBe(45000);
  });

  it('retains the correct outstanding balance for a partially processed entitlement across several months', () => {
    const result = computeEntitlementFinancials(entitlement({ total_payable: 300000 }), [
      allocation({ status: 'processed', proposed_amount: 100000, last_decided_amount: 100000 }),
      allocation({ status: 'processed', proposed_amount: 50000, last_decided_amount: 50000 }),
      allocation({ status: 'approved', proposed_amount: 30000 }),
    ]);
    expect(result.actuallyPaid).toBe(150000);
    expect(result.remainingLiability).toBe(150000);
    expect(result.approvedUnprocessed).toBe(30000);
    expect(result.availableForFutureAllocation).toBe(120000);
    expect(result.settlementStatus).toBe('partially_processed');
  });

  it('marks an entitlement fully settled only once processed reaches the full total_payable', () => {
    const result = computeEntitlementFinancials(entitlement({ total_payable: 80000 }), [
      allocation({ status: 'processed', proposed_amount: 80000, last_decided_amount: 80000 }),
    ]);
    expect(result.remainingLiability).toBe(0);
    expect(result.settlementStatus).toBe('fully_settled');
  });

  it('never produces a negative remaining liability even if processed exceeds total_payable', () => {
    const result = computeEntitlementFinancials(entitlement({ total_payable: 80000 }), [
      allocation({ status: 'processed', proposed_amount: 90000, last_decided_amount: 90000 }),
    ]);
    expect(result.remainingLiability).toBe(0);
    expect(result.availableForFutureAllocation).toBe(0);
  });

  it('ignores submitted, held, rejected, and excluded allocations entirely', () => {
    const statuses = ['submitted', 'held', 'rejected', 'excluded'] as const;
    for (const status of statuses) {
      const result = computeEntitlementFinancials(entitlement({ total_payable: 100000 }), [
        allocation({ status, proposed_amount: 100000 }),
      ]);
      expect(result.actuallyPaid).toBe(0);
      expect(result.approvedUnprocessed).toBe(0);
      expect(result.remainingLiability).toBe(100000);
      expect(result.availableForFutureAllocation).toBe(100000);
    }
  });

  it('excludes a pending entitlement from confirmed liability entirely, not as a zero within it', () => {
    const result = computeEntitlementFinancials(entitlement({ status: 'pending', total_payable: 250000 }), []);
    expect(result.remainingLiability).toBe(0);
    expect(result.actuallyPaid).toBe(0);
    expect(result.settlementStatus).toBe('pending_approval');
  });

  it('treats a legacy paid record as fully paid using its own evidence, with no ledger rows required', () => {
    const result = computeEntitlementFinancials(entitlement({ status: 'paid', total_payable: 250200 }), []);
    expect(result.actuallyPaid).toBe(250200);
    expect(result.remainingLiability).toBe(0);
    expect(result.isLegacyPaid).toBe(true);
    expect(result.hasLedgerConflict).toBe(false);
    expect(result.settlementStatus).toBe('fully_settled');
  });

  it('flags a reconciliation conflict when a legacy paid record unexpectedly also has ledger rows', () => {
    const result = computeEntitlementFinancials(entitlement({ status: 'paid', total_payable: 250200 }), [
      allocation({ status: 'processed', proposed_amount: 50000 }),
    ]);
    // Still reports the legacy evidence as authoritative (never invents a
    // blended figure), but flags the conflict for Admin investigation.
    expect(result.actuallyPaid).toBe(250200);
    expect(result.hasLedgerConflict).toBe(true);
  });

  it('reflects whatever total_payable currently holds, as set by an approved revision, without recomputing it', () => {
    // A revision replaces total_payable in place (TerminalDuesRevision.tsx /
    // approve_terminal_due_revision()) -- this module only ever reads it.
    const revised = computeEntitlementFinancials(entitlement({ total_payable: 410000 }), [
      allocation({ status: 'processed', proposed_amount: 100000, last_decided_amount: 100000 }),
    ]);
    expect(revised.remainingLiability).toBe(310000);
    expect(revised.availableForFutureAllocation).toBe(310000);
  });
});

describe('summarizeTerminalDuesOverview', () => {
  it('aggregates multiple entitlements correctly', () => {
    const entitlements = [
      entitlement({ id: 'due-1', status: 'approved', total_payable: 343000 }),
      entitlement({ id: 'due-2', status: 'paid', total_payable: 250200 }),
      entitlement({ id: 'due-3', status: 'pending', total_payable: 90000 }),
    ];
    const allocations = [allocation({ terminal_due_id: 'due-1', status: 'approved', proposed_amount: 100000 })];
    const summary = summarizeTerminalDuesOverview(entitlements, allocations);

    expect(summary.confirmedEntitlementCount).toBe(2);
    expect(summary.confirmedEntitlementTotal).toBe(343000 + 250200);
    expect(summary.actuallyPaidTotal).toBe(250200);
    expect(summary.remainingLiabilityTotal).toBe(343000);
    expect(summary.approvedForPayrollTotal).toBe(100000);
    expect(summary.pendingApprovalCount).toBe(1);
    expect(summary.pendingApprovalTotal).toBe(90000);
    expect(summary.ledgerConflictCount).toBe(0);
  });

  it('computes settlement progress as a percentage of confirmed entitlements only, never dividing by zero', () => {
    expect(summarizeTerminalDuesOverview([], []).settlementProgressPct).toBe(0);

    const summary = summarizeTerminalDuesOverview(
      [entitlement({ id: 'due-1', status: 'approved', total_payable: 200000 })],
      [allocation({ terminal_due_id: 'due-1', status: 'processed', proposed_amount: 50000, last_decided_amount: 50000 })]
    );
    expect(summary.settlementProgressPct).toBe(25);
  });

  it('counts ledger conflicts across the whole set', () => {
    const summary = summarizeTerminalDuesOverview(
      [entitlement({ id: 'due-1', status: 'paid', total_payable: 100000 })],
      [allocation({ terminal_due_id: 'due-1', status: 'processed', proposed_amount: 20000 })]
    );
    expect(summary.ledgerConflictCount).toBe(1);
  });

  it('supports a historical employee entitlement identically to an active one (identity-agnostic aggregation)', () => {
    // This module never reads employee_id/historical_employee_id -- it
    // only keys off the entitlement id, so a historical subject's
    // financials aggregate exactly the same way.
    const summary = summarizeTerminalDuesOverview(
      [entitlement({ id: 'hist-due-1', status: 'approved', total_payable: 150000 })],
      [allocation({ terminal_due_id: 'hist-due-1', status: 'processed', proposed_amount: 150000, last_decided_amount: 150000 })]
    );
    expect(summary.actuallyPaidTotal).toBe(150000);
    expect(summary.remainingLiabilityTotal).toBe(0);
  });
});

describe('matchesOverviewFilter', () => {
  it('"all" matches every entitlement regardless of status', () => {
    const pending = entitlement({ status: 'pending' });
    const financials = computeEntitlementFinancials(pending, []);
    expect(matchesOverviewFilter('all', pending, financials)).toBe(true);
  });

  it('"pending_approval" matches only pending entitlements', () => {
    const pending = entitlement({ status: 'pending' });
    const approved = entitlement({ status: 'approved' });
    expect(matchesOverviewFilter('pending_approval', pending, computeEntitlementFinancials(pending, []))).toBe(true);
    expect(matchesOverviewFilter('pending_approval', approved, computeEntitlementFinancials(approved, []))).toBe(false);
  });

  it('"outstanding" matches unpaid and partially paid approved entitlements, never pending or fully settled', () => {
    const notStarted = entitlement({ status: 'approved', total_payable: 100000 });
    const partial = entitlement({ id: 'due-2', status: 'approved', total_payable: 100000 });
    const partialAllocs = [allocation({ terminal_due_id: 'due-2', status: 'processed', proposed_amount: 40000, last_decided_amount: 40000 })];
    const settled = entitlement({ id: 'due-3', status: 'approved', total_payable: 100000 });
    const settledAllocs = [allocation({ terminal_due_id: 'due-3', status: 'processed', proposed_amount: 100000, last_decided_amount: 100000 })];
    const pending = entitlement({ status: 'pending' });

    expect(matchesOverviewFilter('outstanding', notStarted, computeEntitlementFinancials(notStarted, []))).toBe(true);
    expect(matchesOverviewFilter('outstanding', partial, computeEntitlementFinancials(partial, partialAllocs))).toBe(true);
    expect(matchesOverviewFilter('outstanding', settled, computeEntitlementFinancials(settled, settledAllocs))).toBe(false);
    expect(matchesOverviewFilter('outstanding', pending, computeEntitlementFinancials(pending, []))).toBe(false);
  });

  it('"fully_settled" matches both a legacy paid record and a fully processed ledger entitlement', () => {
    const legacyPaid = entitlement({ status: 'paid', total_payable: 250200 });
    const ledgerSettled = entitlement({ id: 'due-2', status: 'approved', total_payable: 80000 });
    const ledgerAllocs = [allocation({ terminal_due_id: 'due-2', status: 'processed', proposed_amount: 80000, last_decided_amount: 80000 })];

    expect(matchesOverviewFilter('fully_settled', legacyPaid, computeEntitlementFinancials(legacyPaid, []))).toBe(true);
    expect(matchesOverviewFilter('fully_settled', ledgerSettled, computeEntitlementFinancials(ledgerSettled, ledgerAllocs))).toBe(true);
  });
});
