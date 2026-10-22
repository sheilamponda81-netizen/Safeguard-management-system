import { describe, it, expect } from 'vitest';
import { summarizeTerminalDuesStatement, TerminalDuesStatementInput } from './terminalDuesStatement';

const baseSubject = {
  name: 'Retired Guard',
  reference: 'HIST-001',
  isHistorical: true,
  dateJoined: '2015-01-01',
  dateLeft: '2026-01-01',
  reasonForLeaving: 'retirement',
  payPoint: 'Blantyre Branch',
  accountNumber: 'HIST-ACC-001',
};

const baseEntitlement = {
  version: 1,
  pensionArrears: 80000,
  annualLeaveRefund: 20000,
  uniformRefund: 10000,
  outstandingSalary: 0,
  lessNoticeDeduction: 0,
  totalEntitlements: 110000,
  finalApprovedEntitlement: 110000,
  approvedAt: '2026-10-01T00:00:00Z',
};

describe('summarizeTerminalDuesStatement', () => {
  it('reports zero processed and full outstanding when nothing has been processed yet', () => {
    const input: TerminalDuesStatementInput = {
      subject: baseSubject,
      entitlement: baseEntitlement,
      processedAllocations: [],
      currentMonthAllocation: null,
      statementMonth: '2026-10',
    };
    const result = summarizeTerminalDuesStatement(input);
    expect(result.totalProcessedToDate).toBe(0);
    expect(result.outstandingBalance).toBe(110000);
    expect(result.isFullySettled).toBe(false);
    expect(result.settlementBasis).toBe('Not yet processed');
  });

  it('shows a nonzero outstanding balance for a partial payment', () => {
    const allocation = { payrollMonth: '2026-09', amount: 90000, processingReference: 'TDPB-2026-09-aaa', processedAt: '2026-09-28T00:00:00Z' };
    const input: TerminalDuesStatementInput = {
      subject: baseSubject,
      entitlement: baseEntitlement,
      processedAllocations: [allocation],
      currentMonthAllocation: null,
      statementMonth: '2026-10',
    };
    const result = summarizeTerminalDuesStatement(input);
    expect(result.totalProcessedToDate).toBe(90000);
    expect(result.outstandingBalance).toBe(20000);
    expect(result.isFullySettled).toBe(false);
    expect(result.settlementBasis).toBe('Partially processed -- further payment(s) expected');
  });

  it('labels a fully processed entitlement "Settled by Payroll Processing", never "Bank Paid"', () => {
    const allocations = [
      { payrollMonth: '2026-08', amount: 60000, processingReference: 'TDPB-2026-08-bbb', processedAt: '2026-08-28T00:00:00Z' },
      { payrollMonth: '2026-09', amount: 50000, processingReference: 'TDPB-2026-09-ccc', processedAt: '2026-09-28T00:00:00Z' },
    ];
    const input: TerminalDuesStatementInput = {
      subject: baseSubject,
      entitlement: baseEntitlement,
      processedAllocations: allocations,
      currentMonthAllocation: allocations[1],
      statementMonth: '2026-09',
    };
    const result = summarizeTerminalDuesStatement(input);
    expect(result.totalProcessedToDate).toBe(110000);
    expect(result.outstandingBalance).toBe(0);
    expect(result.isFullySettled).toBe(true);
    expect(result.settlementBasis).toContain('Settled by Payroll Processing');
    expect(result.settlementBasis).toContain('TDPB-2026-09-ccc');
    expect(result.settlementBasis).not.toMatch(/bank/i);
  });

  it('separates the current month allocation from the "earlier" processed payments', () => {
    const earlier = { payrollMonth: '2026-08', amount: 60000, processingReference: 'TDPB-2026-08-bbb', processedAt: '2026-08-28T00:00:00Z' };
    const current = { payrollMonth: '2026-09', amount: 50000, processingReference: 'TDPB-2026-09-ccc', processedAt: '2026-09-28T00:00:00Z' };
    const input: TerminalDuesStatementInput = {
      subject: baseSubject,
      entitlement: baseEntitlement,
      processedAllocations: [earlier, current],
      currentMonthAllocation: current,
      statementMonth: '2026-09',
    };
    const result = summarizeTerminalDuesStatement(input);
    expect(result.priorProcessedAllocations).toEqual([earlier]);
  });

  it('never reports outstanding balance as negative, even if processed somehow exceeds the entitlement', () => {
    const allocation = { payrollMonth: '2026-09', amount: 999999, processingReference: 'TDPB-x', processedAt: null };
    const input: TerminalDuesStatementInput = {
      subject: baseSubject,
      entitlement: baseEntitlement,
      processedAllocations: [allocation],
      currentMonthAllocation: null,
      statementMonth: '2026-09',
    };
    const result = summarizeTerminalDuesStatement(input);
    expect(result.outstandingBalance).toBe(0);
  });
});
