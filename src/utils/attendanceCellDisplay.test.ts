// Final roster/off-day display integrity review (screenshots: UPILE
// MWANYEKONDE, SFG-S-149). Pure unit tests for
// resolveAttendanceCellDisplayCode -- no Supabase, no disposable
// Postgres needed, since this is a pure TypeScript function mirroring
// the server's own roster_resolve_schedule precedence exactly (both
// ultimately delegate to resolveScheduleForDate, already covered by
// rosterSchedule.test.ts's own extensive suite -- this file tests only
// the NEW display-code layer on top of it).
import { describe, it, expect } from 'vitest';
import { resolveAttendanceCellDisplayCode } from './attendanceCellDisplay';
import { DateAssignmentRow, OffDayPatternRow, ShiftPatternRow } from './rosterSchedule';

const EMP = 'emp-1';

describe('resolveAttendanceCellDisplayCode: a recorded attendance status always wins, regardless of roster', () => {
  it('returns the recorded status as-is when a row exists, even on a date the roster would otherwise resolve Off', () => {
    const patterns: OffDayPatternRow[] = [{ employeeId: EMP, weekday: 3, effectiveFrom: '2026-10-01', isActive: true }];
    // 2026-11-04 is a Wednesday -- would resolve 'off' with no row, but a
    // manual correction exists (e.g. an authorized exception), so the
    // real recorded value must still be shown, never silently replaced.
    expect(resolveAttendanceCellDisplayCode('P', EMP, '2026-11-04', [], patterns, [])).toBe('P');
  });

  it('returns the recorded status for every real code (P/A/L/LV/SL/-)', () => {
    for (const code of ['P', 'A', 'L', 'LV', 'SL', '-']) {
      expect(resolveAttendanceCellDisplayCode(code, EMP, '2026-11-02', [], [], [])).toBe(code);
    }
  });
});

describe('resolveAttendanceCellDisplayCode: no attendance row -- disambiguated by the roster\'s own resolved schedule', () => {
  it('Off: a recurring weekday pattern with no row shows "-" (genuine Off, six-on/one-off fixed recurring weekday)', () => {
    const patterns: OffDayPatternRow[] = [{ employeeId: EMP, weekday: 3, effectiveFrom: '2026-10-01', isActive: true }];
    // Every Wednesday in November 2026: 4, 11, 18, 25.
    for (const date of ['2026-11-04', '2026-11-11', '2026-11-18', '2026-11-25']) {
      expect(resolveAttendanceCellDisplayCode(undefined, EMP, date, [], patterns, [])).toBe('-');
    }
  });

  it('Pending: a resolved working day (recurring Day/Night pattern) with no row shows "PENDING", never "-"', () => {
    const patterns: OffDayPatternRow[] = [{ employeeId: EMP, weekday: 3, effectiveFrom: '2026-10-01', isActive: true }];
    const shiftPatterns: ShiftPatternRow[] = [{ employeeId: EMP, shiftType: 'day', effectiveFrom: '2026-10-01', isActive: true }];
    // Tuesday 2026-11-03 resolves 'day' (not the Wednesday Off pattern).
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-11-03', [], patterns, shiftPatterns)).toBe('PENDING');
    expect(resolveAttendanceCellDisplayCode(null, EMP, '2026-11-03', [], patterns, shiftPatterns)).toBe('PENDING');
  });

  it('Pending: a resolved Night working day with no row also shows "PENDING"', () => {
    const shiftPatterns: ShiftPatternRow[] = [{ employeeId: EMP, shiftType: 'night', effectiveFrom: '2026-10-01', isActive: true }];
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-11-05', [], [], shiftPatterns)).toBe('PENDING');
  });

  it('Unassigned: no roster configuration at all, and no row, shows "UNASSIGNED", never "-" and never "PENDING"', () => {
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-11-10', [], [], [])).toBe('UNASSIGNED');
  });

  it('empty string is treated the same as no row at all (falsy recordedStatus)', () => {
    expect(resolveAttendanceCellDisplayCode('', EMP, '2026-11-10', [], [], [])).toBe('UNASSIGNED');
  });
});

describe('resolveAttendanceCellDisplayCode: effective-dated transitions and month boundaries', () => {
  it('a recurring Off pattern that only takes effect mid-month: earlier Wednesdays in the same month are Unassigned, later ones are Off', () => {
    const patterns: OffDayPatternRow[] = [{ employeeId: EMP, weekday: 3, effectiveFrom: '2026-11-15', isActive: true }];
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-11-04', [], patterns, [])).toBe('UNASSIGNED'); // before effectiveFrom
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-11-18', [], patterns, [])).toBe('-'); // on/after effectiveFrom
  });

  it('a recurring Off pattern spanning a month boundary resolves correctly on both sides (no special-casing needed -- resolveScheduleForDate is calendar-date based throughout)', () => {
    const patterns: OffDayPatternRow[] = [{ employeeId: EMP, weekday: 0, effectiveFrom: '2026-10-01', isActive: true }]; // Sunday
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-11-29', [], patterns, [])).toBe('-'); // last Sunday of Nov
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-12-06', [], patterns, [])).toBe('-'); // first Sunday of Dec
  });

  it('an inactive (superseded/corrected-away) Off pattern is never used -- falls back to Unassigned when nothing else applies', () => {
    const patterns: OffDayPatternRow[] = [{ employeeId: EMP, weekday: 3, effectiveFrom: '2026-10-01', isActive: false }];
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-11-04', [], patterns, [])).toBe('UNASSIGNED');
  });
});

describe('resolveAttendanceCellDisplayCode: dated (special-off) exceptions always win over the recurring pattern', () => {
  it('a dated "off" exception on a normally-working day shows "-" (genuine Off), not "PENDING"', () => {
    const shiftPatterns: ShiftPatternRow[] = [{ employeeId: EMP, shiftType: 'day', effectiveFrom: '2026-10-01', isActive: true }];
    const datedAssignments: DateAssignmentRow[] = [{ employeeId: EMP, assignmentDate: '2026-11-05', assignmentType: 'off', isActive: true }];
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-11-05', datedAssignments, [], shiftPatterns)).toBe('-');
  });

  it('a dated "day"/"night" exception on a normally-Off recurring day shows "PENDING" (it is now a real working day awaiting processing), not "-"', () => {
    const patterns: OffDayPatternRow[] = [{ employeeId: EMP, weekday: 3, effectiveFrom: '2026-10-01', isActive: true }];
    const datedAssignments: DateAssignmentRow[] = [{ employeeId: EMP, assignmentDate: '2026-11-04', assignmentType: 'day', isActive: true }];
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-11-04', datedAssignments, patterns, [])).toBe('PENDING');
  });

  it('an inactive dated exception (cancelled/corrected) is ignored, reverting to whatever the recurring pattern says', () => {
    const patterns: OffDayPatternRow[] = [{ employeeId: EMP, weekday: 3, effectiveFrom: '2026-10-01', isActive: true }];
    const datedAssignments: DateAssignmentRow[] = [{ employeeId: EMP, assignmentDate: '2026-11-04', assignmentType: 'day', isActive: false }];
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-11-04', datedAssignments, patterns, [])).toBe('-');
  });
});

describe('resolveAttendanceCellDisplayCode: never conflates employees -- patterns/assignments are matched by employeeId', () => {
  it('another employee\'s Off pattern never leaks into this employee\'s display code', () => {
    const otherEmp = 'emp-2';
    const patterns: OffDayPatternRow[] = [{ employeeId: otherEmp, weekday: 3, effectiveFrom: '2026-10-01', isActive: true }];
    expect(resolveAttendanceCellDisplayCode(undefined, EMP, '2026-11-04', [], patterns, [])).toBe('UNASSIGNED');
  });
});
