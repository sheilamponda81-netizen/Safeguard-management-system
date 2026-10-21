import { describe, it, expect } from 'vitest';
import {
  buildTerminalDueExportRow,
  computeTerminalDueExportTotal,
  buildTerminalDuePaymentsCsv,
  buildCombinedAccountsSummaryCsv,
  TerminalDueExportRecord,
} from './terminalDuesPayrollExport';

function record(overrides: Partial<TerminalDueExportRecord> = {}): TerminalDueExportRecord {
  return {
    employee_name: 'Jane Doe',
    employee_number: 'EMP-001',
    pay_point: 'Lilongwe',
    account_number: '12345678',
    proposed_amount: 100000,
    processed_at: '2026-10-26T12:00:00Z',
    processing_reference: 'TDPB-2026-10-abcd1234',
    is_historical: false,
    ...overrides,
  };
}

describe('buildTerminalDueExportRow', () => {
  it('labels an existing employee correctly', () => {
    const row = buildTerminalDueExportRow(record());
    expect(row[2]).toBe('Current Employee');
  });

  it('labels a historical employee correctly', () => {
    const row = buildTerminalDueExportRow(record({ is_historical: true }));
    expect(row[2]).toBe('Historical');
  });

  it('includes the processing reference for reconciliation', () => {
    const row = buildTerminalDueExportRow(record());
    expect(row[row.length - 1]).toBe('TDPB-2026-10-abcd1234');
  });
});

describe('computeTerminalDueExportTotal', () => {
  it('sums all records, never double counting', () => {
    expect(computeTerminalDueExportTotal([record({ proposed_amount: 100000 }), record({ proposed_amount: 50000 })])).toBe(150000);
  });

  it('is zero for an empty export (nothing processed yet)', () => {
    expect(computeTerminalDueExportTotal([])).toBe(0);
  });
});

describe('buildTerminalDuePaymentsCsv', () => {
  it('includes the header row and every record', () => {
    const csv = buildTerminalDuePaymentsCsv('2026-10', [record()]);
    expect(csv).toContain('Employee Name');
    expect(csv).toContain('Jane Doe');
    expect(csv).toContain('SUMMARY');
  });

  it('produces a stable, repeatable export for the same input (re-download does not reprocess anything)', () => {
    const records = [record(), record({ employee_name: 'John Smith', proposed_amount: 50000 })];
    const first = buildTerminalDuePaymentsCsv('2026-10', records);
    const second = buildTerminalDuePaymentsCsv('2026-10', records);
    // Generated timestamp line aside, the data rows and totals must be
    // byte-identical across repeated exports of the same committed data.
    const stripGeneratedLine = (csv: string) => csv.replace(/Generated:.*\n/, '');
    expect(stripGeneratedLine(first)).toBe(stripGeneratedLine(second));
  });
});

describe('buildCombinedAccountsSummaryCsv', () => {
  it('reconciles ordinary payroll and Terminal Dues into one combined total', () => {
    const csv = buildCombinedAccountsSummaryCsv('2026-10', 5000000, 230000);
    expect(csv).toContain('Ordinary Payroll (Net Pay)');
    expect(csv).toContain('Terminal Dues Payments');
    expect(csv).toContain('Combined Total Payable');
  });
});
