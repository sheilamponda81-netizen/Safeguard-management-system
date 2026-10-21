import { describe, it, expect } from 'vitest';
import {
  summarizeTerminalDuePayrollBatch,
  computeCombinedPayrollTotals,
  TerminalDueAllocationForSummary,
  TerminalDueEntitlementForSummary,
} from './terminalDuesPayrollIntegration';

function allocation(overrides: Partial<TerminalDueAllocationForSummary> = {}): TerminalDueAllocationForSummary {
  return {
    id: 'alloc-1',
    terminal_due_id: 'due-1',
    status: 'approved',
    proposed_amount: 100000,
    carried_forward_from_id: null,
    employee_name: 'Jane Doe',
    employee_number: 'EMP-001',
    ...overrides,
  };
}

function entitlement(overrides: Partial<TerminalDueEntitlementForSummary> = {}): TerminalDueEntitlementForSummary {
  return {
    id: 'due-1',
    status: 'approved',
    total_payable: 230000,
    has_pending_revision: false,
    already_processed_total: 0,
    ...overrides,
  };
}

describe('summarizeTerminalDuePayrollBatch', () => {
  it('counts a valid approved allocation as eligible', () => {
    const due = entitlement();
    const result = summarizeTerminalDuePayrollBatch([allocation()], new Map([[due.id, due]]));
    expect(result.eligibleCount).toBe(1);
    expect(result.eligibleTotal).toBe(100000);
    expect(result.exceptions).toHaveLength(0);
  });

  it('never counts submitted, rejected, held, processed, or excluded allocations as eligible or exceptions', () => {
    const due = entitlement();
    const statuses: TerminalDueAllocationForSummary['status'][] = ['submitted', 'rejected', 'held', 'processed', 'excluded'];
    for (const status of statuses) {
      const result = summarizeTerminalDuePayrollBatch([allocation({ status })], new Map([[due.id, due]]));
      expect(result.eligibleCount).toBe(0);
      expect(result.exceptions).toHaveLength(0);
    }
  });

  it('flags an approved allocation whose entitlement is no longer approved', () => {
    const due = entitlement({ status: 'pending' });
    const result = summarizeTerminalDuePayrollBatch([allocation()], new Map([[due.id, due]]));
    expect(result.eligibleCount).toBe(0);
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0].reason).toBe('entitlement_not_approved');
  });

  it('flags an approved allocation whose entitlement has a pending revision', () => {
    const due = entitlement({ has_pending_revision: true });
    const result = summarizeTerminalDuePayrollBatch([allocation()], new Map([[due.id, due]]));
    expect(result.exceptions[0].reason).toBe('pending_revision');
  });

  it('flags an approved allocation that would exceed the outstanding balance', () => {
    const due = entitlement({ total_payable: 100000, already_processed_total: 50000 });
    const result = summarizeTerminalDuePayrollBatch([allocation({ proposed_amount: 60000 })], new Map([[due.id, due]]));
    expect(result.exceptions[0].reason).toBe('exceeds_outstanding_balance');
  });

  it('counts carried-forward allocations regardless of their current status', () => {
    const due = entitlement();
    const result = summarizeTerminalDuePayrollBatch(
      [allocation({ carried_forward_from_id: 'old-id', status: 'submitted' })],
      new Map([[due.id, due]])
    );
    expect(result.carriedForwardCount).toBe(1);
  });

  it('flags a missing entitlement as not approved rather than crashing', () => {
    const result = summarizeTerminalDuePayrollBatch([allocation({ terminal_due_id: 'missing' })], new Map());
    expect(result.exceptions[0].reason).toBe('entitlement_not_approved');
  });
});

describe('computeCombinedPayrollTotals', () => {
  it('sums ordinary payroll and Terminal Dues totals', () => {
    expect(computeCombinedPayrollTotals(5000000, 230000)).toEqual({
      ordinaryPayrollTotal: 5000000,
      terminalDuesTotal: 230000,
      combinedTotal: 5230000,
    });
  });
});
