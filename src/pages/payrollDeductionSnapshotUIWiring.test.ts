import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Salary Advances + Payroll & Payslip Financial Transparency audit --
// end-to-end completion pass. This repo has no React component-
// rendering test infrastructure (no @testing-library/react dependency --
// see absentDeductionDisplay.test.ts's own header for the established
// precedent), so this file pins the UI wiring at the source level,
// exactly the same way: a required string/pattern must be present, and a
// specific superseded pattern must not reappear. The actual per-category
// arithmetic (what a snapshot resolves to, what reconciles) is proven for
// real against a disposable Postgres by payrollDeductionSnapshotIntegration.test.ts
// and in isolation by payrollDeductionSnapshotResolution.test.ts -- this
// file only proves the two pages actually call that resolution and
// render its result, tied to the exact payroll_id, with the unresolved
// amount never silently dropped.
const payrollSource = fs.readFileSync(path.resolve(__dirname, './Payroll.tsx'), 'utf-8');
const payslipsSource = fs.readFileSync(path.resolve(__dirname, './Payslips.tsx'), 'utf-8');

describe('Payroll.tsx wires payroll_deduction_snapshots in, tied to the exact payroll_id', () => {
  it('imports the shared resolution helper', () => {
    expect(payrollSource).toMatch(/import\s*\{\s*resolveDeductionSnapshot,\s*PayrollDeductionSnapshotRow,\s*ResolvedDeductionSnapshot\s*\}\s*from\s*'\.\.\/utils\/payrollDeductionSnapshotResolution'/);
  });

  it('groups fetched snapshot rows by their own payroll_id, never by employee+month alone', () => {
    expect(payrollSource).toMatch(/snapshotRowsByPayrollId/);
    expect(payrollSource).toMatch(/map\.get\(r\.payroll_id\)/);
  });

  it('resolves each employee\'s snapshot by looking up THEIR OWN existingRecord.id (payroll_id), not a bare employee/month key', () => {
    expect(payrollSource).toMatch(/const existingRecord = payrollByEmployee\.get\(emp\.id\);\s*\n\s*const rows = existingRecord \? snapshotRowsByPayrollId\.get\(existingRecord\.id\) : undefined;/);
  });

  it('a verified snapshot\'s own category figures supersede the legacy employee_deductions-based derivation entirely when one exists', () => {
    expect(payrollSource).toMatch(/const snapshot = snapshotByEmployeeId\.get\(emp\.id\);\s*\n\s*if \(snapshot\) \{/);
  });

  it('the Deductions Breakdown card has a clickable "Unresolved" category, distinct from "Not itemized"', () => {
    expect(payrollSource).toMatch(/Unresolved \(\{deductionBreakdown\.employeesWithUnresolvedUniform\}/);
    expect(payrollSource).toMatch(/deductionBreakdown\.unallocatedTotal/);
  });

  it('the per-employee row sub-breakdown surfaces an unresolved remainder explicitly, never silently folding it into Uniform', () => {
    expect(payrollSource).toMatch(/unallocatedAmount > 0 && <div className="text-amber-500">Unresolved: \{formatKwacha\(unallocatedAmount\)\}<\/div>/);
  });

  it('the snapshot fetch is isolated in its own try/catch -- a table that does not exist yet (migration not applied) must never break the rest of the page', () => {
    const snapshotFetchBlock = payrollSource.slice(
      payrollSource.indexOf('payroll_deduction_snapshots (NOT YET applied'),
      payrollSource.indexOf('payroll_deduction_snapshots (NOT YET applied') + 1800
    );
    expect(snapshotFetchBlock).toMatch(/try \{/);
    expect(snapshotFetchBlock).toMatch(/catch \(snapshotErr\)/);
  });
});

describe('Payslips.tsx wires payroll_deduction_snapshots in, tied to the exact payroll_id', () => {
  it('imports the shared resolution helper', () => {
    expect(payslipsSource).toMatch(/import\s*\{\s*resolveDeductionSnapshot,\s*PayrollDeductionSnapshotRow\s*\}\s*from\s*'\.\.\/utils\/payrollDeductionSnapshotResolution'/);
  });

  it('fetches snapshot rows filtered directly by payroll_id (the actual committed row ids for this page\'s authorized payroll set), never by employee/month alone', () => {
    expect(payslipsSource).toMatch(/\.in\('payroll_id', batch\)/);
    expect(payslipsSource).toMatch(/authorizedPayrollIds = authorizedPayrollData\.map/);
  });

  it('resolves each payslip strictly against its OWN payroll.id', () => {
    expect(payslipsSource).toMatch(/resolveDeductionSnapshot\(snapshotRowsByPayrollId\.get\(payroll\.id\) \?\? null\)/);
  });

  it('the snapshot fetch is isolated in its own try/catch -- a table that does not exist yet must never break the rest of this page', () => {
    const snapshotFetchBlock = payslipsSource.slice(
      payslipsSource.indexOf('payroll_deduction_snapshots (NOT YET applied'),
      payslipsSource.indexOf('payroll_deduction_snapshots (NOT YET applied') + 2200
    );
    expect(snapshotFetchBlock).toMatch(/try \{/);
    expect(snapshotFetchBlock).toMatch(/catch \(snapshotErr\)/);
  });

  it('screen, print (HTML), and PDF all render the same "Unresolved" line for an unresolved remainder -- exactly 3 occurrences, one per render surface', () => {
    const matches = payslipsSource.match(/Unresolved \(not independently verifiable as Uniform\)/g) || [];
    expect(matches.length).toBe(3);
  });

  it('net pay is never affected by the unallocated/unresolved concept -- totalDeductions and the HTML/PDF Total Deductions figure still sum paye+pension+uniform_deduction+salaryAdvanceDeduction exactly as before', () => {
    const matches = payslipsSource.match(/p\.paye \+ p\.pension \+ (totalUniformAtt|p\.uniform_deduction) \+ salaryAdvanceDeduction/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});
