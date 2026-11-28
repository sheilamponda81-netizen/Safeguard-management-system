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
  it('imports the shared resolution helper and its discriminated-union types', () => {
    expect(payrollSource).toMatch(/import\s*\{\s*resolveDeductionSnapshot,\s*PayrollDeductionSnapshotRow,\s*ResolvedDeductionSnapshot,\s*SnapshotResolution\s*\}\s*from\s*'\.\.\/utils\/payrollDeductionSnapshotResolution'/);
  });

  it('groups fetched snapshot rows by their own payroll_id, never by employee+month alone', () => {
    expect(payrollSource).toMatch(/snapshotRowsByPayrollId/);
    expect(payrollSource).toMatch(/map\.get\(r\.payroll_id\)/);
  });

  it('resolves each employee\'s snapshot by passing THEIR OWN existingRecord.id (payroll_id) and committed bundledTotal into resolveDeductionSnapshot, not a bare employee/month key', () => {
    expect(payrollSource).toMatch(/const existingRecord = payrollByEmployee\.get\(emp\.id\);/);
    expect(payrollSource).toMatch(/resolveDeductionSnapshot\(rows \?\? null, \{\s*\n\s*payrollId: existingRecord\.id,\s*\n\s*bundledTotal: existingRecord\.uniform_deduction \|\| 0,\s*\n\s*\}\)/);
  });

  it('a validated ("available") snapshot\'s own category figures supersede the legacy employee_deductions-based derivation entirely -- an "invalid" one never silently falls back to it either', () => {
    expect(payrollSource).toMatch(/if \(resolution\?\.status === 'available'\) \{/);
    expect(payrollSource).toMatch(/if \(resolution\?\.status === 'invalid'\) \{/);
    // The 'invalid' branch must set null (not-itemized), never call the
    // legacy deriveItemizedAttendanceDeduction fallback for this employee.
    const invalidBranch = payrollSource.slice(
      payrollSource.indexOf("if (resolution?.status === 'invalid') {"),
      payrollSource.indexOf("if (resolution?.status === 'invalid') {") + 700
    );
    expect(invalidBranch).toMatch(/map\.set\(emp\.id, null\)/);
    expect(invalidBranch).not.toMatch(/deriveItemizedAttendanceDeduction/);
  });

  it('exposes a distinct integrity-warning reason per employee, separate from the resolved snapshot and never merged into the legacy "not itemized" case', () => {
    expect(payrollSource).toMatch(/snapshotIntegrityWarningByEmployeeId/);
    expect(payrollSource).toMatch(/resolution\?\.status === 'invalid'\) map\.set\(emp\.id, resolution\.reason\)/);
  });

  it('the Deductions Breakdown card has a clickable "Unresolved" category AND a distinct "Evidence Integrity Warning" category, both separate from "Not itemized"', () => {
    expect(payrollSource).toMatch(/Unresolved \(\{deductionBreakdown\.employeesWithUnresolvedUniform\}/);
    expect(payrollSource).toMatch(/deductionBreakdown\.unallocatedTotal/);
    expect(payrollSource).toMatch(/⚠ Evidence Integrity Warning \(\{deductionBreakdown\.employeesWithIntegrityWarning\}/);
    expect(payrollSource).toMatch(/deductionBreakdown\.integrityWarningTotal/);
  });

  it('the per-employee row sub-breakdown surfaces an unresolved remainder explicitly, and an integrity warning takes priority over it, never silently folding either into Uniform', () => {
    expect(payrollSource).toMatch(/unallocatedAmount > 0 && <div className="text-amber-500">Unresolved: \{formatKwacha\(unallocatedAmount\)\}<\/div>/);
    expect(payrollSource).toMatch(/integrityWarningReason \? \(\s*\n\s*<div className="text-red-600" title=\{integrityWarningReason\}>⚠ Evidence integrity warning/);
  });

  it('the category drill-down has its own "integrityWarning" case, reporting the exact validation failure reason, gated on the same bundled uniform_deduction amount as every other category', () => {
    expect(payrollSource).toMatch(/case 'integrityWarning':/);
    expect(payrollSource).toMatch(/detail = `Snapshot evidence exists but failed validation: \$\{integrityWarningReason\}`/);
    // The pre-existing 'unitemized' case must now also exclude employees
    // with an integrity warning, so the same employee can never be
    // double-counted into both buckets.
    expect(payrollSource).toMatch(/!itemized && !integrityWarningReason && \(p\.uniform_deduction \|\| 0\) > 0/);
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

  it('resolves each payslip strictly against its OWN payroll.id and the exact committed bundledTotal, and derives its integrity-warning reason from the \'invalid\' status, not the \'none\' one', () => {
    expect(payslipsSource).toMatch(/resolveDeductionSnapshot\(snapshotRowsByPayrollId\.get\(payroll\.id\) \?\? null, \{\s*\n\s*payrollId: payroll\.id,\s*\n\s*bundledTotal: payroll\.uniform_deduction \|\| 0,\s*\n\s*\}\)/);
    expect(payslipsSource).toMatch(/const integrityWarningReason = resolution\.status === 'invalid' \? resolution\.reason : null;/);
  });

  it('persists the integrity-warning reason onto the payslip record so all 3 render surfaces (screen, print, PDF) can read the exact same value for this payroll_id', () => {
    expect(payslipsSource).toMatch(/integrity_warning_reason\?:\s*string \| null;/);
    expect(payslipsSource).toMatch(/integrity_warning_reason: integrityWarningReason/);
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

  it('screen, print (HTML), and PDF all read integrity_warning_reason and render the SAME integrity-warning message ahead of the ordinary breakdown -- exactly 3 occurrences, one per render surface, never silently falling back to a conflicting explanation', () => {
    const readMatches = payslipsSource.match(/const integrityWarningReason = p\.integrity_warning_reason \|\| null;/g) || [];
    expect(readMatches.length).toBe(3);
    const htmlAndPdfMatches = payslipsSource.match(/integrityWarningReason \? `<div style="color:#b91c1c;">&#9888; Evidence integrity warning -- recorded snapshot failed validation, not used for this breakdown\.<\/div>` : attendanceBreakdownAvailable \? `/g) || [];
    expect(htmlAndPdfMatches.length).toBe(2);
    expect(payslipsSource).toMatch(/\{integrityWarningReason \? \(\s*\n\s*<p className="pl-3 text-\[11px\] text-red-600" title=\{integrityWarningReason\}>⚠ Evidence integrity warning -- recorded snapshot failed validation, not used for this breakdown\.<\/p>\s*\n\s*\) : attendanceBreakdownAvailable \? \(/);
  });

  it('a snapshot that failed validation is treated as breakdown-unavailable (never partially shown), independent of whether a legacy attendance-count breakdown would otherwise have been available', () => {
    expect(payslipsSource).toMatch(/const breakdownAvailable = integrityWarningReason \? false : \(snapshot \? true : attendanceBreakdown\.available\);/);
  });

  it('net pay is never affected by the unallocated/unresolved/integrity-warning concept -- totalDeductions and the HTML/PDF Total Deductions figure still sum paye+pension+uniform_deduction+salaryAdvanceDeduction exactly as before', () => {
    const matches = payslipsSource.match(/p\.paye \+ p\.pension \+ (totalUniformAtt|p\.uniform_deduction) \+ salaryAdvanceDeduction/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Payroll.tsx and Payslips.tsx parity (instruction #8): both pages must reach the identical resolution for the same evidence', () => {
  it('both pages call resolveDeductionSnapshot with the SAME shape of context: the exact payroll_id being displayed and that row\'s own committed uniform_deduction as bundledTotal -- never a different or re-derived total', () => {
    expect(payrollSource).toMatch(/bundledTotal: existingRecord\.uniform_deduction \|\| 0,/);
    expect(payslipsSource).toMatch(/bundledTotal: payroll\.uniform_deduction \|\| 0,/);
  });

  it('both pages treat an \'invalid\' resolution as strictly worse than \'none\' -- neither ever lets an invalid snapshot fall back to the legacy employee_deductions-derived breakdown', () => {
    // Payroll.tsx: the 'invalid' branch sets null and returns before
    // reaching the legacy deriveItemizedAttendanceDeduction call below it.
    const payrollInvalidIdx = payrollSource.indexOf("if (resolution?.status === 'invalid') {");
    const payrollInvalidBranch = payrollSource.slice(payrollInvalidIdx, payrollInvalidIdx + 700);
    expect(payrollInvalidBranch).toMatch(/return;/);
    // Payslips.tsx: breakdownAvailable is forced false whenever
    // integrityWarningReason is set, regardless of what the legacy
    // attendanceBreakdown.available would otherwise have been.
    expect(payslipsSource).toMatch(/const breakdownAvailable = integrityWarningReason \? false : /);
  });
});
