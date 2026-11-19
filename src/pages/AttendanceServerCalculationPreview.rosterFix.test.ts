import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildAttendanceCalculationPreviewRows, resolveCoveragePolicy, AttendanceCalculationPreviewRow,
} from '../utils/attendanceCalculationPreview';
import { DateAssignmentRow, OffDayPatternRow, ShiftPatternRow } from '../utils/rosterSchedule';
import { EmployeeLite } from '../utils/hikcentralPersonMapping';

// Stage C roster fix: runComparison() in AttendanceServerCalculationPreview.tsx
// built its "JS preview result" column by calling buildAttendanceCalculationPreviewRows
// WITHOUT the shiftPatterns field -- an easy mistake, since it's an optional
// parameter (defaulting to []) that existing callers/tests pass deliberately
// when they genuinely have none. For any employee with no dated roster
// assignment -- scheduled only via the recurring Day/Night baseline, the
// common case -- this silently resolved every date to 'unassigned' on
// Stage C's JS side only, never on the server side (which always used the
// server-authoritative roster_resolve_schedule()). This is the exact defect
// found investigating FALESI MLOTHO (SFG-S-274): recurring Day pattern,
// no dated assignment, Stage C's JS column reported Unassigned for all 4
// dates while the Main Attendance Review (which already passed
// shiftPatterns) correctly showed Day.
//
// The underlying roster-resolution precedence itself (dated assignment >
// off-day pattern > recurring shift pattern > unassigned) is already
// exhaustively tested against buildAttendanceCalculationPreviewRows in
// attendanceCalculationPreview.test.ts's "recurring shift-pattern
// integration (Attendance Review repair)" describe block (effective-date
// boundaries, pattern supersession, inactive patterns, overlapping
// evidence, overnight matching, etc.) -- this file does not repeat that
// exhaustive coverage. It instead proves the ONE thing specific to this
// fix: that Stage C's own call site, once it includes shiftPatterns,
// reaches the same correct, already-tested precedence rather than the
// silently-degraded 'unassigned' fallback -- and that the eligibility/
// protection classification this fix sits beside is structurally
// untouched by it.

const previewSource = fs.readFileSync(path.resolve(__dirname, './AttendanceServerCalculationPreview.tsx'), 'utf-8');

function employee(overrides: Partial<EmployeeLite> = {}): EmployeeLite {
  return { id: 'emp-1', employeeNumber: 'SFG-S-274', fullName: 'Test Person', workstation: 'LIMBE', status: 'Active', isDeleted: false, ...overrides };
}

const noActivePolicy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '', confirmedWorkstationsRaw: '', operatorConfirmed: false });

function rowFor(params: {
  datedAssignments?: DateAssignmentRow[];
  patterns?: OffDayPatternRow[];
  shiftPatterns?: ShiftPatternRow[];
  shiftDates?: string[];
}): AttendanceCalculationPreviewRow {
  const rows = buildAttendanceCalculationPreviewRows({
    employees: [employee()],
    shiftDates: params.shiftDates ?? ['2026-11-01'],
    datedAssignments: params.datedAssignments ?? [],
    patterns: params.patterns ?? [],
    ...(params.shiftPatterns !== undefined ? { shiftPatterns: params.shiftPatterns } : {}),
    eventsByEmployeeId: new Map(),
    coveragePolicy: noActivePolicy,
    officialStatusByKey: new Map(),
    employeeIdsWithActiveMapping: new Set(['emp-1']),
  });
  return rows[0];
}

describe('Stage C roster fix: the call site now wires shiftPatterns through', () => {
  it('the fixed call passes shiftPatterns: previewData.shiftPatterns, matching what the Main Attendance Review already passes', () => {
    expect(previewSource).toMatch(/shiftPatterns: previewData\.shiftPatterns,/);
  });

  it('the historical defect shape -- a jsRows build with no shiftPatterns key at all -- is gone', () => {
    const callStart = previewSource.indexOf('const jsRows = buildAttendanceCalculationPreviewRows({');
    const callEnd = previewSource.indexOf('});', callStart);
    const callBody = previewSource.slice(callStart, callEnd);
    expect(callBody).toMatch(/shiftPatterns/);
  });
});

describe('Stage C roster fix: recurring-pattern-only employees resolve correctly once wired (requirements 1, 2, 5)', () => {
  it('BEFORE the fix (shiftPatterns omitted entirely): a recurring-Day-only employee incorrectly resolves Unassigned -- reproduces the exact reported defect', () => {
    // Deliberately calling WITHOUT shiftPatterns, as the buggy call site used
    // to -- the recurring Day pattern a real fixture would supply is simply
    // never reached, which is exactly the bug being reproduced here.
    const row = rowFor({});
    expect(row.resolvedShift).toBe('unassigned');
    expect(row.calculation.status).toBe('unassigned');
  });

  it('AFTER the fix: the same recurring-Day-only employee (no dated assignment) resolves a real Day shift, never Unassigned', () => {
    const shiftPatterns: ShiftPatternRow[] = [{ employeeId: 'emp-1', shiftType: 'day', effectiveFrom: '2026-10-01', isActive: true }];
    const row = rowFor({ shiftPatterns });
    expect(row.resolvedShift).toBe('day');
    expect(row.calculation.status).not.toBe('unassigned');
  });

  it('AFTER the fix: a recurring-Night-only employee (no dated assignment) resolves a real Night shift, never Unassigned', () => {
    const shiftPatterns: ShiftPatternRow[] = [{ employeeId: 'emp-1', shiftType: 'night', effectiveFrom: '2026-10-01', isActive: true }];
    const row = rowFor({ shiftPatterns });
    expect(row.resolvedShift).toBe('night');
    expect(row.calculation.status).not.toBe('unassigned');
  });
});

describe('Stage C roster fix: existing resolution precedence is preserved once shiftPatterns is wired through (requirements 3, 4)', () => {
  it('a dated assignment still wins over a contradicting recurring shift pattern for that one date', () => {
    const shiftPatterns: ShiftPatternRow[] = [{ employeeId: 'emp-1', shiftType: 'day', effectiveFrom: '2026-10-01', isActive: true }];
    const datedAssignments: DateAssignmentRow[] = [{ employeeId: 'emp-1', assignmentDate: '2026-11-01', assignmentType: 'night', isActive: true }];
    const row = rowFor({ shiftPatterns, datedAssignments });
    expect(row.resolvedShift).toBe('night'); // dated override wins, not the recurring Day pattern
  });

  it('a recurring off-day pattern still wins over a contradicting recurring shift pattern (Off-day behavior preserved)', () => {
    // 2026-11-01 is a Sunday (weekday 0).
    const shiftPatterns: ShiftPatternRow[] = [{ employeeId: 'emp-1', shiftType: 'day', effectiveFrom: '2026-10-01', isActive: true }];
    const patterns: OffDayPatternRow[] = [{ employeeId: 'emp-1', weekday: 0, effectiveFrom: '2026-10-01', isActive: true }];
    const row = rowFor({ shiftPatterns, patterns });
    expect(row.resolvedShift).toBe('off');
  });
});

describe('Stage C roster fix: unrelated protections and read-only behavior are structurally untouched (requirements 6, 7)', () => {
  it('eligibility/protection classification is computed only from the SERVER result, never from jsRows -- this fix (which only changes jsRows inputs) cannot affect it', () => {
    expect(previewSource).toMatch(
      /classifyAutomaticEligibility\(\s*\{ employeeId: selectedEmployeeId, date, status: server\?\.status \?\? '', calculationBasis: server\?\.calculationBasis \?\? null \},\s*existing\s*\)/
    );
  });

  it('manual-correction and approved-payroll protection are still read via fetchExistingAttendanceAndPayroll, unchanged by this fix', () => {
    expect(previewSource).toMatch(/fetchExistingAttendanceAndPayroll\(selectedEmployeeId, fromDate, toDate\)/);
  });

  it('the comparison still performs no write call of any kind', () => {
    expect(previewSource).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  });
});
