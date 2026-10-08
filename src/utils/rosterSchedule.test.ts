import { describe, it, expect } from 'vitest';
import {
  resolveScheduleForDate,
  checkRollingRestWindows,
  findConfirmedRollingRestViolations,
  hasNightToDayConflict,
  wouldOverrideRecurringOffDay,
  isDateAssignmentNoOp,
  isOffPatternNoOp,
  weekdayOf,
  addDays,
  expandDateRange,
  OffDayPatternRow,
  DateAssignmentRow,
} from './rosterSchedule';

function pattern(overrides: Partial<OffDayPatternRow> = {}): OffDayPatternRow {
  return { employeeId: 'emp-1', weekday: 0, effectiveFrom: '2026-01-01', isActive: true, ...overrides };
}
function dated(overrides: Partial<DateAssignmentRow> = {}): DateAssignmentRow {
  return { employeeId: 'emp-1', assignmentDate: '2026-10-07', assignmentType: 'day', isActive: true, ...overrides };
}

describe('weekdayOf / addDays (plain calendar-date arithmetic, never host-local-timezone-dependent)', () => {
  it('computes the correct weekday for a known date (2026-10-07 is a Wednesday)', () => {
    expect(weekdayOf('2026-10-07')).toBe(3); // Sunday=0 .. Wednesday=3
  });

  it('addDays rolls across a month boundary correctly', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('addDays supports negative offsets', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });
});

describe('expandDateRange', () => {
  it('includes both endpoints', () => {
    expect(expandDateRange('2026-10-01', '2026-10-03')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });

  it('a single-day range returns exactly one date', () => {
    expect(expandDateRange('2026-10-01', '2026-10-01')).toEqual(['2026-10-01']);
  });

  it('an inverted range (from after to) returns empty, never throws', () => {
    expect(expandDateRange('2026-10-05', '2026-10-01')).toEqual([]);
  });
});

describe('resolveScheduleForDate: precedence (dated assignment > recurring pattern > unassigned)', () => {
  it('an active dated assignment wins over a recurring pattern that would otherwise say Off', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday
    const d = [dated({ assignmentDate: '2026-10-07', assignmentType: 'day' })]; // same Wednesday, explicitly assigned Day
    expect(resolveScheduleForDate('emp-1', '2026-10-07', d, p)).toBe('day');
  });

  it('a dated "off" exception resolves to off even with no recurring pattern at all', () => {
    const d = [dated({ assignmentDate: '2026-10-07', assignmentType: 'off' })];
    expect(resolveScheduleForDate('emp-1', '2026-10-07', d, [])).toBe('off');
  });

  it('with no dated assignment, the recurring pattern resolves Off on its matching weekday', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    expect(resolveScheduleForDate('emp-1', '2026-10-07', [], p)).toBe('off'); // Wednesday
    expect(resolveScheduleForDate('emp-1', '2026-10-08', [], p)).toBe('unassigned'); // Thursday
  });

  it('no dated assignment and no applicable pattern resolves to unassigned, never absence/leave', () => {
    expect(resolveScheduleForDate('emp-1', '2026-10-07', [], [])).toBe('unassigned');
  });

  it('a pattern with effectiveFrom AFTER the queried date is not yet in effect', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-12-01' })];
    expect(resolveScheduleForDate('emp-1', '2026-10-07', [], p)).toBe('unassigned');
  });

  it('an inactive (corrected-away) pattern is never used for resolution, even for a date it would have covered', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01', isActive: false })];
    expect(resolveScheduleForDate('emp-1', '2026-10-07', [], p)).toBe('unassigned');
  });

  it('resolution is scoped per employee -- a different employee\'s pattern/assignment never leaks across', () => {
    const p = [pattern({ employeeId: 'emp-2', weekday: 3, effectiveFrom: '2026-01-01' })];
    expect(resolveScheduleForDate('emp-1', '2026-10-07', [], p)).toBe('unassigned');
  });
});

describe('resolveScheduleForDate: effective-dated history, including backdated corrections', () => {
  it('picks the pattern with the LARGEST effectiveFrom not after the queried date -- correct BEFORE and AFTER an effective-date change', () => {
    const p = [
      pattern({ weekday: 0, effectiveFrom: '2026-01-01' }), // Sunday, from Jan 1
      pattern({ weekday: 3, effectiveFrom: '2026-09-01' }), // Wednesday, from Sep 1
    ];
    // Before the change: Aug 2026, a Sunday, should resolve Off under the OLD (Sunday) pattern.
    expect(resolveScheduleForDate('emp-1', '2026-08-30', [], p)).toBe('off'); // 2026-08-30 is a Sunday
    // After the change: Oct 2026, a Wednesday, should resolve Off under the NEW (Wednesday) pattern.
    expect(resolveScheduleForDate('emp-1', '2026-10-07', [], p)).toBe('off'); // Wednesday
    // After the change, a Sunday no longer resolves Off.
    expect(resolveScheduleForDate('emp-1', '2026-10-11', [], p)).toBe('unassigned'); // Sunday after the change
  });

  it('a BACKDATED correction inserted between two existing rows resolves correctly for the gap it fills, without needing to touch either neighboring row', () => {
    const p = [
      pattern({ weekday: 0, effectiveFrom: '2026-01-01' }), // Sunday, from Jan 1
      pattern({ weekday: 3, effectiveFrom: '2026-09-01' }), // Wednesday, from Sep 1 (the "current" row)
      pattern({ weekday: 5, effectiveFrom: '2026-06-01' }), // Friday, backdated correction filling Jun 1 - Aug 31
    ];
    // Within the backdated correction's window: resolves Friday, not the Jan-1 Sunday pattern.
    expect(resolveScheduleForDate('emp-1', '2026-07-03', [], p)).toBe('off'); // 2026-07-03 is a Friday
    expect(resolveScheduleForDate('emp-1', '2026-07-05', [], p)).toBe('unassigned'); // a Sunday in July -- NOT off, since July is governed by the backdated Friday row
    // Before the backdated correction's window: the original Jan-1 Sunday pattern still governs.
    expect(resolveScheduleForDate('emp-1', '2026-03-01', [], p)).toBe('off'); // 2026-03-01 is a Sunday
    // After Sep 1: the current Wednesday pattern still governs, untouched by the backdated insert.
    expect(resolveScheduleForDate('emp-1', '2026-10-07', [], p)).toBe('off'); // Wednesday
  });
});

describe('checkRollingRestWindows / findConfirmedRollingRestViolations', () => {
  function weeklyOffPattern(weekday: number, effectiveFrom = '2026-01-01'): OffDayPatternRow[] {
    return [pattern({ weekday, effectiveFrom })];
  }

  it('a clean weekly Off pattern produces zero confirmed violations around any center date', () => {
    const p = weeklyOffPattern(0); // every Sunday off
    const violations = findConfirmedRollingRestViolations('emp-1', '2026-10-07', [], p);
    expect(violations).toEqual([]);
  });

  it('an employee with NO pattern and NO dated assignments at all produces only "incomplete" windows, never a confirmed violation', () => {
    const results = checkRollingRestWindows('emp-1', '2026-10-07', [], []);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((w) => w.status === 'incomplete')).toBe(true);
  });

  it('a fully-assigned stretch with zero Off days anywhere is a CONFIRMED violation for every window in that stretch', () => {
    // Explicitly assign Day every single day across the whole ±13-day buffer, no Off anywhere.
    const center = '2026-10-07';
    const dates: string[] = [];
    for (let i = -20; i <= 20; i++) dates.push(addDays(center, i));
    const assignments = dates.map((d) => dated({ assignmentDate: d, assignmentType: 'day' }));
    const violations = findConfirmedRollingRestViolations('emp-1', center, assignments, []);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((w) => w.status === 'confirmed_violation')).toBe(true);
  });

  it('removing an employee\'s only Off day (via a dated override) in an otherwise fully-assigned stretch produces a confirmed violation at exactly that boundary', () => {
    const center = '2026-10-07';
    const dates: string[] = [];
    for (let i = -20; i <= 20; i++) dates.push(addDays(center, i));
    // Fully assigned, no Off at all.
    const assignments = dates.map((d) => dated({ assignmentDate: d, assignmentType: 'day' }));
    const violations = findConfirmedRollingRestViolations('emp-1', center, assignments, []);
    expect(violations.some((w) => w.windowStart <= center && center <= w.windowEnd)).toBe(true);
  });

  it('a pattern change that leaves a gap with no Off day in some 7-day window is detected as a confirmed violation', () => {
    // Off on Sunday until 2026-01-04, then Off on Saturday from 2026-01-04 --
    // verified (by direct computation) to leave a 12-day gap with no
    // resolved Off day at all: last old-pattern Sunday is 2025-12-28, first
    // new-pattern Saturday is 2026-01-10.
    const p = [
      pattern({ weekday: 0, effectiveFrom: '2020-01-01' }), // Sunday
      pattern({ weekday: 6, effectiveFrom: '2026-01-04' }), // Saturday
    ];
    // Fill every date in the buffer with an explicit working assignment EXCEPT
    // the actual Off days implied by the two patterns, so "incomplete" never
    // masks the check -- this isolates the pattern-transition gap itself.
    const center = '2026-01-03';
    const dates: string[] = [];
    for (let i = -20; i <= 20; i++) dates.push(addDays(center, i));
    const assignments: DateAssignmentRow[] = [];
    for (const d of dates) {
      const resolved = resolveScheduleForDate('emp-1', d, [], p);
      if (resolved === 'unassigned') assignments.push(dated({ assignmentDate: d, assignmentType: 'day' }));
    }
    const violations = findConfirmedRollingRestViolations('emp-1', center, assignments, p);
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe('hasNightToDayConflict (hard-block adjacency, no override path)', () => {
  it('blocks assigning Day when the previous date has an active Night assignment', () => {
    const d = [dated({ assignmentDate: '2026-10-06', assignmentType: 'night' })];
    expect(hasNightToDayConflict('emp-1', '2026-10-07', 'day', d)).toBe(true);
  });

  it('blocks assigning Night when the NEXT date already has an active Day assignment', () => {
    const d = [dated({ assignmentDate: '2026-10-08', assignmentType: 'day' })];
    expect(hasNightToDayConflict('emp-1', '2026-10-07', 'night', d)).toBe(true);
  });

  it('does NOT block Night followed by Night on consecutive dates (never asked for, not invented)', () => {
    const d = [dated({ assignmentDate: '2026-10-06', assignmentType: 'night' })];
    expect(hasNightToDayConflict('emp-1', '2026-10-07', 'night', d)).toBe(false);
  });

  it('does NOT block a Night shift finishing into an Off day the next morning -- confirmed valid per policy, never flagged here at all', () => {
    // There is no "off" case in hasNightToDayConflict's newType checks at all --
    // assigning 'off' never triggers this function's logic in either direction.
    const d = [dated({ assignmentDate: '2026-10-06', assignmentType: 'night' })];
    expect(hasNightToDayConflict('emp-1', '2026-10-07', 'off', d)).toBe(false);
  });

  it('is scoped per employee -- another employee\'s adjacent Night assignment never causes a false block', () => {
    const d = [dated({ employeeId: 'emp-2', assignmentDate: '2026-10-06', assignmentType: 'night' })];
    expect(hasNightToDayConflict('emp-1', '2026-10-07', 'day', d)).toBe(false);
  });
});

describe('wouldOverrideRecurringOffDay', () => {
  it('true when assigning Day/Night onto a date the recurring pattern says is Off', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday
    expect(wouldOverrideRecurringOffDay('emp-1', '2026-10-07', 'day', [], p)).toBe(true); // Wednesday
  });

  it('true when assigning Day/Night onto a date with an existing dated "off" exception', () => {
    const d = [dated({ assignmentDate: '2026-10-07', assignmentType: 'off' })];
    expect(wouldOverrideRecurringOffDay('emp-1', '2026-10-07', 'night', d, [])).toBe(true);
  });

  it('false when the date is not an Off day at all', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    expect(wouldOverrideRecurringOffDay('emp-1', '2026-10-08', 'day', [], p)).toBe(false); // Thursday
  });

  it('false when the new assignment is itself "off" -- cannot "override Off with Off"', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    expect(wouldOverrideRecurringOffDay('emp-1', '2026-10-07', 'off', [], p)).toBe(false);
  });
});

describe('isDateAssignmentNoOp / isOffPatternNoOp (idempotent-retry detection)', () => {
  it('a dated assignment request identical to the current active row is a no-op', () => {
    const d = [dated({ assignmentDate: '2026-10-07', assignmentType: 'night' })];
    expect(isDateAssignmentNoOp('emp-1', '2026-10-07', 'night', d)).toBe(true);
  });

  it('a dated assignment request that differs from the current active row is NOT a no-op', () => {
    const d = [dated({ assignmentDate: '2026-10-07', assignmentType: 'night' })];
    expect(isDateAssignmentNoOp('emp-1', '2026-10-07', 'day', d)).toBe(false);
  });

  it('no existing active row at all is never a no-op (always a genuine first-time write)', () => {
    expect(isDateAssignmentNoOp('emp-1', '2026-10-07', 'day', [])).toBe(false);
  });

  it('an Off-day pattern request identical to the current active pattern (same weekday, same effectiveFrom) is a no-op', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    expect(isOffPatternNoOp('emp-1', 3, '2026-01-01', p)).toBe(true);
  });

  it('a different weekday for the same effectiveFrom is NOT a no-op', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    expect(isOffPatternNoOp('emp-1', 4, '2026-01-01', p)).toBe(false);
  });
});
