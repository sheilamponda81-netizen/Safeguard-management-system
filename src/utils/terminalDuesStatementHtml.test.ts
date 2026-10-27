import { describe, it, expect } from 'vitest';
import { buildTerminalDuesStatementHtml } from './terminalDuesStatementHtml';
import { summarizeTerminalDuesStatement, TerminalDuesStatementInput } from './terminalDuesStatement';

const baseInput: TerminalDuesStatementInput = {
  subject: {
    name: 'Retired Guard',
    reference: 'HIST-001',
    isHistorical: true,
    dateJoined: '2015-01-01',
    dateLeft: '2026-01-01',
    reasonForLeaving: 'retirement',
    payPoint: 'Blantyre Branch',
    accountNumber: 'HIST-ACC-001',
  },
  entitlement: {
    version: 2,
    pensionArrears: 80000,
    annualLeaveRefund: 20000,
    uniformRefund: 10000,
    outstandingSalary: 0,
    lessNoticeDeduction: 0,
    totalEntitlements: 110000,
    finalApprovedEntitlement: 110000,
    approvedAt: '2026-10-01T00:00:00Z',
  },
  processedAllocations: [
    { payrollMonth: '2026-09', amount: 110000, processingReference: 'TDPB-2026-09-ccc', processedAt: '2026-09-28T00:00:00Z' },
  ],
  currentMonthAllocation: null,
  statementMonth: '2026-10',
};

describe('buildTerminalDuesStatementHtml', () => {
  it('labels payments "Payroll Processed", never "Bank Paid"', () => {
    const summary = summarizeTerminalDuesStatement(baseInput);
    const html = buildTerminalDuesStatementHtml(baseInput, summary);
    expect(html).toMatch(/Payroll Processed/i);
    expect(html).not.toMatch(/Bank Paid/i);
    expect(html).not.toMatch(/Bank Transfer/i);
  });

  it('includes employment dates and reason for leaving for a historical subject', () => {
    const summary = summarizeTerminalDuesStatement(baseInput);
    const html = buildTerminalDuesStatementHtml(baseInput, summary);
    expect(html).toContain('2015-01-01');
    expect(html).toContain('2026-01-01');
    expect(html).toContain('retirement');
    expect(html).toContain('Historical Employee');
  });

  it('includes the version label', () => {
    const summary = summarizeTerminalDuesStatement(baseInput);
    const html = buildTerminalDuesStatementHtml(baseInput, summary);
    expect(html).toContain('v2');
  });

  it('includes every required entitlement component line item', () => {
    const summary = summarizeTerminalDuesStatement(baseInput);
    const html = buildTerminalDuesStatementHtml(baseInput, summary);
    expect(html).toContain('Pension Arrears');
    expect(html).toContain('Unused Annual Leave Refund');
    expect(html).toContain('Uniform Refund');
    expect(html).toContain('Verified Outstanding Salary');
    expect(html).toContain('Less Notice Deduction');
    expect(html).toContain('Final Approved Entitlement');
  });

  it('shows the outstanding balance and settlement status', () => {
    const summary = summarizeTerminalDuesStatement(baseInput);
    const html = buildTerminalDuesStatementHtml(baseInput, summary);
    expect(html).toContain('Remaining Outstanding Balance');
    expect(html).toContain('Settled by Payroll Processing');
  });
});
