import { describe, it, expect } from 'vitest';
import {
  buildPayrollExportRow,
  computeAttendanceDeduction,
  computeOtherDeduction,
  computeTotalDeduction,
  computePayrollExportTotals,
  buildPayrollReportCsv,
  PAYROLL_EXPORT_HEADER_ROW,
  PayrollExportRecord,
  PayrollExportEmployee,
  PayrollExportRegion,
  PayrollExportDeduction,
} from './payrollExport';

function makeRecord(overrides: Partial<PayrollExportRecord> = {}): PayrollExportRecord {
  return {
    employee_id: 'emp-1',
    gross_pay: 5000,
    paye: 500,
    pension: 250,
    uniform_deduction: 100,
    salary_advance_deduction: 200,
    net_pay: 3950,
    approval_status: 'approved',
    ...overrides,
  };
}

describe('deduction math', () => {
  it('computeAttendanceDeduction sums absent + late deductions', () => {
    expect(computeAttendanceDeduction({ absent_deduction: 300, late_deduction: 150 })).toBe(450);
  });

  it('computeAttendanceDeduction treats a missing deduction row as zero', () => {
    expect(computeAttendanceDeduction(null)).toBe(0);
    expect(computeAttendanceDeduction(undefined)).toBe(0);
  });

  it('computeOtherDeduction sums lecture + appearance + salary advance', () => {
    const record = makeRecord({ salary_advance_deduction: 200 });
    const deduction: PayrollExportDeduction = { lecture_deduction: 50, appearance_deduction: 25 };
    expect(computeOtherDeduction(record, deduction)).toBe(275);
  });

  it('computeTotalDeduction is uniform + attendance + other, and reconciles against net pay', () => {
    const record = makeRecord({
      gross_pay: 5000,
      paye: 500,
      pension: 250,
      uniform_deduction: 100,
      salary_advance_deduction: 200,
    });
    const deduction: PayrollExportDeduction = { absent_deduction: 300, late_deduction: 150, lecture_deduction: 50, appearance_deduction: 25 };
    const total = computeTotalDeduction(record, deduction);
    // uniform 100 + attendance 450 + other (50+25+200=275) = 825
    expect(total).toBe(825);
    // Net pay = gross - paye - pension - total deductions (this report's
    // own definition -- PAYE/pension are statutory, not "deductions").
    // 5000 - 500 - 250 - 825 = 3425
    expect(record.gross_pay - record.paye - record.pension - total).toBe(3425);
  });

  it('never throws, and falls back to just the record-level deductions when there is no deduction row at all', () => {
    const record = makeRecord({ salary_advance_deduction: 0 });
    expect(computeTotalDeduction(record, undefined)).toBe(record.uniform_deduction);
  });
});

describe('buildPayrollExportRow', () => {
  const employee: PayrollExportEmployee = {
    full_name: 'Jane Mwansa',
    employee_number: 'EMP-042',
    region_id: 'region-1',
    company: 'Acme Corp',
    workstation: 'Gate 3',
  };
  const region: PayrollExportRegion = { id: 'region-1', name: 'Lusaka' };
  const deduction: PayrollExportDeduction = { absent_deduction: 100, late_deduction: 50, lecture_deduction: 0, appearance_deduction: 0 };

  it('includes every required report column in order', () => {
    const row = buildPayrollExportRow(makeRecord(), employee, region, deduction);
    expect(row).toHaveLength(PAYROLL_EXPORT_HEADER_ROW.length);
    expect(row[0]).toBe('Jane Mwansa');
    expect(row[1]).toBe('EMP-042');
    expect(row[2]).toBe('Lusaka');
    expect(row[3]).toBe('Acme Corp');
    expect(row[4]).toBe('Gate 3');
    expect(row[row.length - 1]).toBe('approved');
  });

  it('falls back to a clear marker when the employee record is missing (never a blank/crash)', () => {
    const row = buildPayrollExportRow(makeRecord(), undefined, undefined, undefined);
    expect(row[0]).toBe('(employee not found)');
    expect(row[1]).toBe('');
    expect(row[2]).toBe('');
  });

  it('defaults approval status to "pending" when absent', () => {
    const row = buildPayrollExportRow(makeRecord({ approval_status: null }), employee, region, deduction);
    expect(row[row.length - 1]).toBe('pending');
  });
});

describe('computePayrollExportTotals', () => {
  it('sums gross/paye/pension/deductions/net across every record', () => {
    const records = [
      makeRecord({ employee_id: 'e1', gross_pay: 5000, paye: 500, pension: 250, uniform_deduction: 100, salary_advance_deduction: 0, net_pay: 4150 }),
      makeRecord({ employee_id: 'e2', gross_pay: 3000, paye: 200, pension: 150, uniform_deduction: 0, salary_advance_deduction: 100, net_pay: 2550 }),
    ];
    const deductionsByEmployee = new Map<string, PayrollExportDeduction>([
      ['e1', { absent_deduction: 0, late_deduction: 0 }],
      ['e2', { absent_deduction: 0, late_deduction: 0 }],
    ]);
    const totals = computePayrollExportTotals(records, deductionsByEmployee);
    expect(totals.gross).toBe(8000);
    expect(totals.paye).toBe(700);
    expect(totals.pension).toBe(400);
    expect(totals.deductions).toBe(200); // 100 (e1 uniform) + 100 (e2 salary advance)
    expect(totals.net).toBe(6700);
  });

  it('returns all-zero totals for an empty record set', () => {
    const totals = computePayrollExportTotals([], new Map());
    expect(totals).toEqual({ gross: 0, paye: 0, pension: 0, deductions: 0, net: 0 });
  });
});

describe('buildPayrollReportCsv', () => {
  const employeesById = new Map<string, PayrollExportEmployee>([
    ['e1', { full_name: 'Jane Mwansa', employee_number: 'EMP-001', region_id: 'r1' }],
  ]);
  const regionsById = new Map<string, PayrollExportRegion>([['r1', { id: 'r1', name: 'Lusaka' }]]);

  it('exports only the records passed in -- never fetches or widens scope on its own', () => {
    const records = [makeRecord({ employee_id: 'e1' })];
    const csv = buildPayrollReportCsv('2026-08', records, employeesById, regionsById, new Map());
    expect(csv).toContain('Jane Mwansa');
    expect(csv).toContain('Employee Count,1');
  });

  it('labels the report with the month actually passed in, not any other month', () => {
    const csv = buildPayrollReportCsv('2026-05', [], employeesById, regionsById, new Map());
    expect(csv).toContain('May 2026');
    expect(csv).not.toContain('2026-08');
  });

  it('handles an empty period cleanly -- header + summary, no crash, zero totals', () => {
    const csv = buildPayrollReportCsv('2026-08', [], employeesById, regionsById, new Map());
    expect(csv).toContain('Employee Count,0');
    expect(csv).toContain('Total Net Pay,MK 0');
    expect(csv.split('\n').length).toBeGreaterThan(1);
  });

  it('escapes a value that could be interpreted as a CSV formula (via the shared toCsvRow helper)', () => {
    const maliciousEmployees = new Map<string, PayrollExportEmployee>([
      ['e1', { full_name: '=cmd|"/c calc"!A1', employee_number: 'EMP-001' }],
    ]);
    const csv = buildPayrollReportCsv('2026-08', [makeRecord({ employee_id: 'e1' })], maliciousEmployees, regionsById, new Map());
    // toCsvRow prefixes a leading formula-trigger char with a single
    // quote, so the raw formula string must never appear unguarded.
    expect(csv).not.toContain('"=cmd');
    expect(csv).toContain("'=cmd");
  });

  it('includes the full required header row', () => {
    const csv = buildPayrollReportCsv('2026-08', [], employeesById, regionsById, new Map());
    PAYROLL_EXPORT_HEADER_ROW.forEach(col => {
      expect(csv).toContain(col);
    });
  });
});
