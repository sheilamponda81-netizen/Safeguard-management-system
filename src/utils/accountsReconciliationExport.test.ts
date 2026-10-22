import { describe, it, expect } from 'vitest';
import {
  buildOrdinaryPayrollPaymentRow,
  computeOrdinaryPayrollPaymentTotals,
  buildOrdinaryPayrollPaymentsCsv,
  buildAccountsReconciliationSummaryCsv,
  OrdinaryPayrollPaymentRecord,
} from './accountsReconciliationExport';

const sampleRecord: OrdinaryPayrollPaymentRecord = {
  employee_id: 'emp-1',
  full_name: 'Jane Guard',
  employee_number: 'EMP-001',
  pay_point: 'Lilongwe Branch',
  account_number: 'ACC-001',
  gross_pay: 300000,
  paye: 75000,
  pension: 15000,
  uniform_deduction: 10000,
  salary_advance_deduction: 5000,
  net_pay: 195000,
  processing_reference: 'PWTD-2026-12-abc123',
};

describe('buildOrdinaryPayrollPaymentRow', () => {
  it('includes bank/pay-point and processing reference columns', () => {
    const row = buildOrdinaryPayrollPaymentRow(sampleRecord);
    expect(row).toContain('Lilongwe Branch');
    expect(row).toContain('ACC-001');
    expect(row).toContain('PWTD-2026-12-abc123');
  });

  it('shows a clear placeholder when processing_reference is missing (pre-tracking row)', () => {
    const row = buildOrdinaryPayrollPaymentRow({ ...sampleRecord, processing_reference: null });
    expect(row).toContain('(predates processing-reference tracking)');
  });
});

describe('computeOrdinaryPayrollPaymentTotals', () => {
  it('sums every monetary field across records independently', () => {
    const totals = computeOrdinaryPayrollPaymentTotals([sampleRecord, { ...sampleRecord, employee_id: 'emp-2' }]);
    expect(totals).toEqual({
      gross: 600000,
      paye: 150000,
      pension: 30000,
      uniformDeduction: 20000,
      salaryAdvanceDeduction: 10000,
      net: 390000,
    });
  });

  it('returns all zeros for an empty record list', () => {
    expect(computeOrdinaryPayrollPaymentTotals([])).toEqual({
      gross: 0, paye: 0, pension: 0, uniformDeduction: 0, salaryAdvanceDeduction: 0, net: 0,
    });
  });
});

describe('buildOrdinaryPayrollPaymentsCsv', () => {
  it('includes the month, every record, and a totals summary block', () => {
    const csv = buildOrdinaryPayrollPaymentsCsv('2026-12', [sampleRecord]);
    expect(csv).toContain('Jane Guard');
    expect(csv).toContain('SUMMARY');
    expect(csv).toContain('Employee Count,1');
  });

  it('produces a valid (non-throwing) empty-records CSV', () => {
    expect(() => buildOrdinaryPayrollPaymentsCsv('2026-12', [])).not.toThrow();
    const csv = buildOrdinaryPayrollPaymentsCsv('2026-12', []);
    expect(csv).toContain('Employee Count,0');
  });
});

describe('buildAccountsReconciliationSummaryCsv', () => {
  const baseInput = {
    month: '2026-12',
    ordinaryEmployeeCount: 5,
    ordinaryGross: 1500000,
    ordinaryDeductions: 300000,
    ordinaryNet: 1200000,
    ordinaryProcessingReferences: ['PWTD-2026-12-abc123'],
    terminalDuesPaymentCount: 2,
    terminalDuesCurrentEmployeeCount: 1,
    terminalDuesHistoricalEmployeeCount: 1,
    terminalDuesTotal: 180000,
    terminalDuesProcessingReferences: ['PWTD-2026-12-abc123'],
  };

  it('never double-counts Terminal Dues into ordinary gross/deductions -- each stays its own row', () => {
    const csv = buildAccountsReconciliationSummaryCsv(baseInput);
    // Ordinary gross is reported as exactly the ordinary figure (1,500,000),
    // never inflated by adding the Terminal Dues total (180,000) into it.
    expect(csv).toMatch(/Gross Pay[^\n]*1,500,000/);
    expect(csv).not.toMatch(/Gross Pay[^\n]*1,680,000/);
  });

  it('computes the final combined total as ordinary net + Terminal Dues total, never gross', () => {
    const csv = buildAccountsReconciliationSummaryCsv(baseInput);
    // 1,200,000 (ordinary net) + 180,000 (TD total) = 1,380,000
    expect(csv).toMatch(/Final Combined Amount Payable[^\n]*1,380,000/);
  });

  it('lists distinct processing references from both sides', () => {
    const csv = buildAccountsReconciliationSummaryCsv(baseInput);
    expect(csv).toContain('PWTD-2026-12-abc123');
  });

  it('shows an explicit "(none)" placeholder rather than a blank cell when no references exist', () => {
    const csv = buildAccountsReconciliationSummaryCsv({ ...baseInput, ordinaryProcessingReferences: [], terminalDuesProcessingReferences: [] });
    expect(csv).toContain('(none)');
  });

  it('includes the historical-vs-current Terminal Dues employee breakdown', () => {
    const csv = buildAccountsReconciliationSummaryCsv(baseInput);
    expect(csv).toContain('Current Employee Payments');
    expect(csv).toContain('Historical Employee Payments');
  });
});
