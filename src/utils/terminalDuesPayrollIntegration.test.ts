import { describe, it, expect } from 'vitest';
import {
  summarizeTerminalDuePayrollBatch,
  computeCombinedPayrollTotals,
  buildTerminalDuePayrollPreview,
  TerminalDueAllocationForSummary,
  TerminalDueEntitlementForSummary,
  TerminalDuePreviewAllocation,
  TerminalDuePreviewDueInfo,
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

function previewAllocation(overrides: Partial<TerminalDuePreviewAllocation> = {}): TerminalDuePreviewAllocation {
  return {
    id: 'alloc-1',
    terminal_due_id: 'due-1',
    status: 'approved',
    proposed_amount: 100000,
    last_decided_amount: null,
    ...overrides,
  };
}

function previewDue(overrides: Partial<TerminalDuePreviewDueInfo> = {}): TerminalDuePreviewDueInfo {
  return {
    employee_name: 'Alfred George',
    employee_number: 'SFG-S-413',
    historical_employee_id: null,
    ...overrides,
  };
}

describe('buildTerminalDuePayrollPreview', () => {
  it('shows an approved allocation as unprocessed, with the correct recipient and amount', () => {
    const result = buildTerminalDuePayrollPreview(
      [previewAllocation({ proposed_amount: 100000 })],
      new Map([['due-1', previewDue()]])
    );
    expect(result.approvedUnprocessedCount).toBe(1);
    expect(result.approvedUnprocessedTotal).toBe(100000);
    expect(result.recipients).toEqual([
      { terminalDueId: 'due-1', employeeName: 'Alfred George', employeeNumber: 'SFG-S-413', isHistorical: false, amount: 100000, status: 'approved' },
    ]);
  });

  it('excludes rejected, submitted, held, and excluded allocations from both the total and the recipient list', () => {
    const statuses = ['rejected', 'submitted', 'held', 'excluded'] as const;
    for (const status of statuses) {
      const result = buildTerminalDuePayrollPreview(
        [previewAllocation({ status })],
        new Map([['due-1', previewDue()]])
      );
      expect(result.approvedUnprocessedCount).toBe(0);
      expect(result.approvedUnprocessedTotal).toBe(0);
      expect(result.recipients).toHaveLength(0);
    }
  });

  it('counts a processed allocation in the recipient list but NOT in the unprocessed total -- it is already paid', () => {
    const result = buildTerminalDuePayrollPreview(
      [previewAllocation({ status: 'processed', proposed_amount: 100000, last_decided_amount: 100000 })],
      new Map([['due-1', previewDue()]])
    );
    expect(result.approvedUnprocessedCount).toBe(0);
    expect(result.approvedUnprocessedTotal).toBe(0);
    expect(result.recipients).toEqual([
      { terminalDueId: 'due-1', employeeName: 'Alfred George', employeeNumber: 'SFG-S-413', isHistorical: false, amount: 100000, status: 'processed' },
    ]);
  });

  it('prefers last_decided_amount over proposed_amount when both are present', () => {
    const result = buildTerminalDuePayrollPreview(
      [previewAllocation({ proposed_amount: 90000, last_decided_amount: 85000 })],
      new Map([['due-1', previewDue()]])
    );
    expect(result.approvedUnprocessedTotal).toBe(85000);
  });

  it('supports a historical recipient identically to an active employee', () => {
    const result = buildTerminalDuePayrollPreview(
      [previewAllocation({ terminal_due_id: 'due-hist' })],
      new Map([['due-hist', previewDue({ employee_name: 'Former Employee', employee_number: 'HIST-001', historical_employee_id: 'hist-1' })]])
    );
    expect(result.recipients[0]).toMatchObject({ employeeName: 'Former Employee', isHistorical: true });
  });

  it('sums two distinct recipients without double-counting either one', () => {
    const result = buildTerminalDuePayrollPreview(
      [
        previewAllocation({ id: 'alloc-1', terminal_due_id: 'due-1', proposed_amount: 100000 }),
        previewAllocation({ id: 'alloc-2', terminal_due_id: 'due-2', proposed_amount: 50000 }),
      ],
      new Map([
        ['due-1', previewDue({ employee_name: 'Alfred George' })],
        ['due-2', previewDue({ employee_name: 'Betty Banda', employee_number: 'SFG-S-900' })],
      ])
    );
    expect(result.approvedUnprocessedCount).toBe(2);
    expect(result.approvedUnprocessedTotal).toBe(150000);
    expect(result.recipients).toHaveLength(2);
  });

  it('never crashes on a missing due lookup, falling back to safe placeholders', () => {
    const result = buildTerminalDuePayrollPreview([previewAllocation({ terminal_due_id: 'missing' })], new Map());
    expect(result.recipients[0]).toMatchObject({ employeeName: 'Unknown', employeeNumber: null, isHistorical: false });
  });

  it('combines with computeCombinedPayrollTotals using the correct unprocessed-only figure', () => {
    const preview = buildTerminalDuePayrollPreview(
      [previewAllocation({ proposed_amount: 100000 })],
      new Map([['due-1', previewDue()]])
    );
    expect(computeCombinedPayrollTotals(5000000, preview.approvedUnprocessedTotal).combinedTotal).toBe(5100000);
  });
});
