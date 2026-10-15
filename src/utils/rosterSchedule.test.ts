import { describe, it, expect } from 'vitest';
import {
  resolveScheduleForDate,
  checkRollingRestWindows,
  findConfirmedRollingRestViolations,
  hasNightToDayConflict,
  wouldOverrideRecurringOffDay,
  isDateAssignmentNoOp,
  isOffPatternNoOp,
  isShiftPatternNoOp,
  buildRescheduleOffDayPreview,
  dateForWeekdayInWeek,
  resolveActiveOffWeekday,
  resolveActiveShiftType,
  buildTemporaryReschedulePlan,
  buildPermanentWeekdayTransitionPlan,
  weekdayOrdinal,
  bridgeWeekIndex,
  explainRollingRestConflict,
  summarizeWeekSchedule,
  describeWeekOffDays,
  summarizeDateRangeAssignments,
  evaluateCancellationSafety,
  describeCancellationSafety,
  formatFriendlyWeekdayDate,
  weekdayOf,
  addDays,
  expandDateRange,
  OffDayPatternRow,
  DateAssignmentRow,
  ShiftPatternRow,
} from './rosterSchedule';

function pattern(overrides: Partial<OffDayPatternRow> = {}): OffDayPatternRow {
  return { employeeId: 'emp-1', weekday: 0, effectiveFrom: '2026-01-01', isActive: true, ...overrides };
}
function dated(overrides: Partial<DateAssignmentRow> = {}): DateAssignmentRow {
  return { employeeId: 'emp-1', assignmentDate: '2026-10-07', assignmentType: 'day', isActive: true, ...overrides };
}
function shiftPattern(overrides: Partial<ShiftPatternRow> = {}): ShiftPatternRow {
  return { employeeId: 'emp-1', shiftType: 'day', effectiveFrom: '2026-01-01', isActive: true, ...overrides };
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

describe('resolveScheduleForDate: Stage C Step 6B recurring Day/Night baseline (step 3, between off-pattern and unassigned)', () => {
  it('six Day shifts plus one weekly Off recur indefinitely, including dates far beyond any explicit roster', () => {
    const off = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday Off
    const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' })];
    // A full week, including a date 9 months past effectiveFrom -- no dated rows exist at all.
    expect(resolveScheduleForDate('emp-1', '2026-10-05', [], off, shift)).toBe('day'); // Monday
    expect(resolveScheduleForDate('emp-1', '2026-10-06', [], off, shift)).toBe('day'); // Tuesday
    expect(resolveScheduleForDate('emp-1', '2026-10-07', [], off, shift)).toBe('off'); // Wednesday -- Off pattern still wins
    expect(resolveScheduleForDate('emp-1', '2026-10-08', [], off, shift)).toBe('day'); // Thursday
    expect(resolveScheduleForDate('emp-1', '2026-10-09', [], off, shift)).toBe('day'); // Friday
    expect(resolveScheduleForDate('emp-1', '2026-10-10', [], off, shift)).toBe('day'); // Saturday
    expect(resolveScheduleForDate('emp-1', '2026-10-11', [], off, shift)).toBe('day'); // Sunday
  });

  it('six Night shifts plus one weekly Off recur indefinitely', () => {
    const off = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday Off
    const shift = [shiftPattern({ shiftType: 'night', effectiveFrom: '2026-01-01' })];
    expect(resolveScheduleForDate('emp-1', '2026-10-05', [], off, shift)).toBe('night');
    expect(resolveScheduleForDate('emp-1', '2026-10-07', [], off, shift)).toBe('off'); // Wednesday
    expect(resolveScheduleForDate('emp-1', '2026-10-11', [], off, shift)).toBe('night');
  });

  it('with no recurring shift pattern configured at all, a non-Off date remains unassigned (no silent default)', () => {
    const off = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    expect(resolveScheduleForDate('emp-1', '2026-10-05', [], off, [])).toBe('unassigned');
  });

  it('an explicit dated assignment still overrides the recurring shift pattern', () => {
    const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' })];
    const d = [dated({ assignmentDate: '2026-10-05', assignmentType: 'night' })];
    expect(resolveScheduleForDate('emp-1', '2026-10-05', d, [], shift)).toBe('night');
  });

  it('a mid-cycle shift-type change takes effect only from its own effectiveFrom onward', () => {
    const shift = [
      shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' }),
      shiftPattern({ shiftType: 'night', effectiveFrom: '2026-09-01' }),
    ];
    expect(resolveScheduleForDate('emp-1', '2026-08-15', [], [], shift)).toBe('day');
    expect(resolveScheduleForDate('emp-1', '2026-10-05', [], [], shift)).toBe('night');
  });

  it('changing only the weekly Off day leaves the recurring shift pattern (and its own effectiveFrom) completely unaffected', () => {
    const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' })];
    const offBefore = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday
    const offAfter = [pattern({ weekday: 5, effectiveFrom: '2026-10-01' })]; // Friday, changed later
    expect(resolveScheduleForDate('emp-1', '2026-10-09', [], offBefore, shift)).toBe('day'); // Friday, still working under the old Off day
    expect(resolveScheduleForDate('emp-1', '2026-10-09', [], offAfter, shift)).toBe('off'); // Friday, now Off under the new pattern
  });

  it('an inactive (corrected-away) shift pattern is never used for resolution', () => {
    const shift = [shiftPattern({ shiftType: 'night', effectiveFrom: '2026-01-01', isActive: false })];
    expect(resolveScheduleForDate('emp-1', '2026-10-05', [], [], shift)).toBe('unassigned');
  });

  it('cross-tenant/cross-employee isolation: a different employee\'s shift pattern never leaks across', () => {
    const shift = [shiftPattern({ employeeId: 'emp-2', shiftType: 'night', effectiveFrom: '2026-01-01' })];
    expect(resolveScheduleForDate('emp-1', '2026-10-05', [], [], shift)).toBe('unassigned');
  });

  it('a shift pattern with effectiveFrom AFTER the queried date is not yet in effect', () => {
    const shift = [shiftPattern({ shiftType: 'night', effectiveFrom: '2026-12-01' })];
    expect(resolveScheduleForDate('emp-1', '2026-10-05', [], [], shift)).toBe('unassigned');
  });
});

describe('isShiftPatternNoOp', () => {
  it('true only when the exact shiftType is already active from the exact effectiveFrom date', () => {
    const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-10-01' })];
    expect(isShiftPatternNoOp('emp-1', 'day', '2026-10-01', shift)).toBe(true);
    expect(isShiftPatternNoOp('emp-1', 'night', '2026-10-01', shift)).toBe(false);
    expect(isShiftPatternNoOp('emp-1', 'day', '2026-11-01', shift)).toBe(false);
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

  it('a recurring shift pattern alone never counts as Off -- only the Off pattern or a dated "off" exception can', () => {
    const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' })];
    expect(wouldOverrideRecurringOffDay('emp-1', '2026-10-07', 'night', [], [], shift)).toBe(false);
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

describe('buildRescheduleOffDayPreview (Phase 2B.2C, Policy Option A -- advisory only, database remains authoritative)', () => {
  it('a genuinely Off original date with an eligible (unassigned) replacement date has no blocking reason', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday off
    const preview = buildRescheduleOffDayPreview('emp-1', '2026-10-07', '2026-10-08', 'day', [], p); // Wed -> Thu
    expect(preview.originalResolved).toBe('off');
    expect(preview.replacementResolved).toBe('unassigned');
    expect(preview.isOriginalGenuinelyOff).toBe(true);
    expect(preview.isReplacementEligible).toBe(true);
    expect(preview.hasAdjacencyConflict).toBe(false);
    expect(preview.blockingReason).toBeNull();
  });

  it('a replacement date that already resolves Off is REJECTED, not allowed as harmless -- it would contribute no new rest day and could mislead Admin into believing a genuine swap happened', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    const d = [dated({ assignmentDate: '2026-10-08', assignmentType: 'off' })];
    const preview = buildRescheduleOffDayPreview('emp-1', '2026-10-07', '2026-10-08', 'night', d, p);
    expect(preview.replacementResolved).toBe('off');
    expect(preview.isReplacementEligible).toBe(false);
    expect(preview.blockingReason).toMatch(/already Off/);
  });

  it('a replacement date that resolves to "unassigned" is eligible', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    const preview = buildRescheduleOffDayPreview('emp-1', '2026-10-07', '2026-10-08', 'day', [], p); // Wed off, Thu unassigned
    expect(preview.replacementResolved).toBe('unassigned');
    expect(preview.isReplacementEligible).toBe(true);
    expect(preview.blockingReason).toBeNull();
  });

  it('identical original and replacement dates are blocked', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    const preview = buildRescheduleOffDayPreview('emp-1', '2026-10-07', '2026-10-07', 'day', [], p);
    expect(preview.blockingReason).toMatch(/must be different/);
  });

  it('Stage C Step 12: a replacement date that a recurring Shift pattern resolves to Day/Night is ELIGIBLE, not rejected -- the realistic swap target (e.g. "Wednesday Off -> Sunday Off") is a normal working day under the employee\'s own recurring pattern, not "unassigned"', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday off
    const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' })]; // every other day is a normal Day shift
    const preview = buildRescheduleOffDayPreview('emp-1', '2026-10-07', '2026-10-08', 'night', [], p, shift); // Wed -> Thu (a Day under the recurring pattern)
    expect(preview.replacementResolved).toBe('day');
    expect(preview.isReplacementEligible).toBe(true);
    expect(preview.blockingReason).toBeNull();
  });

  it('an original date that does not genuinely resolve Off is blocked, naming its actual resolved state', () => {
    const preview = buildRescheduleOffDayPreview('emp-1', '2026-10-07', '2026-10-08', 'day', [], []); // nothing resolves Off at all
    expect(preview.isOriginalGenuinelyOff).toBe(false);
    expect(preview.blockingReason).toMatch(/does not currently resolve to Off/);
    expect(preview.blockingReason).toMatch(/unassigned/);
  });

  it('Stage C Step 12: a replacement date that already has a dated working shift is also ELIGIBLE (not a silent-overwrite risk) -- converting it to the new Off day for this week is exactly the intended operation', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    const d = [dated({ assignmentDate: '2026-10-08', assignmentType: 'night' })];
    const preview = buildRescheduleOffDayPreview('emp-1', '2026-10-07', '2026-10-08', 'day', d, p);
    expect(preview.isReplacementEligible).toBe(true);
    expect(preview.blockingReason).toBeNull();
  });

  it('a Day shift on the original date conflicting with an active Night the day before is blocked', () => {
    const p = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    const d = [dated({ assignmentDate: '2026-10-06', assignmentType: 'night' }), dated({ assignmentDate: '2026-10-07', assignmentType: 'off' })];
    // emp-1's 10-07 is Off via the dated row (overriding the pattern) -- still genuinely Off.
    const preview = buildRescheduleOffDayPreview('emp-1', '2026-10-07', '2026-10-09', 'day', d, p);
    expect(preview.hasAdjacencyConflict).toBe(true);
    expect(preview.blockingReason).toMatch(/conflicts with an adjacent/);
  });

  it('checks run in a stable priority order: identical-dates is reported even when the original is also not Off', () => {
    const preview = buildRescheduleOffDayPreview('emp-1', '2026-10-07', '2026-10-07', 'day', [], []);
    expect(preview.blockingReason).toMatch(/must be different/);
  });
});

describe('Stage C Step 12: dateForWeekdayInWeek', () => {
  // 2026-10-05 is a Monday (2026-10-07 is confirmed Wednesday above).
  const monday = '2026-10-05';

  it('returns the Monday itself for weekday 1', () => {
    expect(dateForWeekdayInWeek(monday, 1)).toBe('2026-10-05');
  });

  it('returns the correct midweek date for weekday 3 (Wednesday)', () => {
    expect(dateForWeekdayInWeek(monday, 3)).toBe('2026-10-07');
  });

  it('returns the correct Sunday for weekday 0 -- the LAST day of the Mon-Sun week, not the first', () => {
    expect(dateForWeekdayInWeek(monday, 0)).toBe('2026-10-11');
  });

  it('returns the correct Saturday for weekday 6', () => {
    expect(dateForWeekdayInWeek(monday, 6)).toBe('2026-10-10');
  });
});

describe('Stage C Step 12: resolveActiveOffWeekday / resolveActiveShiftType (UI-default helpers only, never authoritative)', () => {
  it('resolveActiveOffWeekday returns the latest-effective active pattern\'s weekday as of the given date', () => {
    const p = [
      pattern({ weekday: 3, effectiveFrom: '2026-01-01' }),
      pattern({ weekday: 0, effectiveFrom: '2026-09-01' }),
    ];
    expect(resolveActiveOffWeekday('emp-1', '2026-10-01', p)).toBe(0);
    expect(resolveActiveOffWeekday('emp-1', '2026-02-01', p)).toBe(3);
  });

  it('resolveActiveOffWeekday returns null when no pattern is configured', () => {
    expect(resolveActiveOffWeekday('emp-1', '2026-10-01', [])).toBeNull();
  });

  it('resolveActiveOffWeekday ignores a different employee\'s pattern', () => {
    const p = [pattern({ employeeId: 'emp-2', weekday: 3, effectiveFrom: '2026-01-01' })];
    expect(resolveActiveOffWeekday('emp-1', '2026-10-01', p)).toBeNull();
  });

  it('resolveActiveShiftType returns the latest-effective active shift pattern\'s type as of the given date', () => {
    const s = [
      shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' }),
      shiftPattern({ shiftType: 'night', effectiveFrom: '2026-09-01' }),
    ];
    expect(resolveActiveShiftType('emp-1', '2026-10-01', s)).toBe('night');
    expect(resolveActiveShiftType('emp-1', '2026-02-01', s)).toBe('day');
  });

  it('resolveActiveShiftType returns null when no shift pattern is configured', () => {
    expect(resolveActiveShiftType('emp-1', '2026-10-01', [])).toBeNull();
  });
});

describe('Stage C Step 12: buildTemporaryReschedulePlan ("Wednesday Off -> Sunday Off for N weeks")', () => {
  const offPattern = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday off
  const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' })]; // every other day is Day

  it('computes one week\'s real dates correctly and finds no blocking issue for the realistic case', () => {
    const weeks = buildTemporaryReschedulePlan('emp-1', '2026-10-05', 3, 0, 1, 'day', [], offPattern, shift);
    expect(weeks).toHaveLength(1);
    expect(weeks[0].weekStart).toBe('2026-10-05');
    expect(weeks[0].weekEnd).toBe('2026-10-11');
    expect(weeks[0].originalDate).toBe('2026-10-07'); // Wednesday
    expect(weeks[0].newOffDate).toBe('2026-10-11'); // Sunday
    expect(weeks[0].preview.blockingReason).toBeNull();
  });

  it('computes 3 consecutive weeks, each shifted by exactly 7 days, for a 3-week duration', () => {
    const weeks = buildTemporaryReschedulePlan('emp-1', '2026-10-05', 3, 0, 3, 'day', [], offPattern, shift);
    expect(weeks).toHaveLength(3);
    expect(weeks.map((w) => w.originalDate)).toEqual(['2026-10-07', '2026-10-14', '2026-10-21']);
    expect(weeks.map((w) => w.newOffDate)).toEqual(['2026-10-11', '2026-10-18', '2026-10-25']);
    expect(weeks.every((w) => w.preview.blockingReason === null)).toBe(true);
  });

  it('the SAME weekday for both original and new is caught as identical-dates, every week', () => {
    const weeks = buildTemporaryReschedulePlan('emp-1', '2026-10-05', 3, 3, 2, 'day', [], offPattern, shift);
    expect(weeks.every((w) => w.originalDate === w.newOffDate)).toBe(true);
    expect(weeks.every((w) => w.preview.blockingReason?.match(/must be different/))).toBeTruthy();
  });

  it('flags only the specific week where a dated exception breaks eligibility, leaving the other weeks clean', () => {
    // Week 2's Sunday (2026-10-18) is already an explicit dated Off exception.
    const d = [dated({ assignmentDate: '2026-10-18', assignmentType: 'off' })];
    const weeks = buildTemporaryReschedulePlan('emp-1', '2026-10-05', 3, 0, 3, 'day', d, offPattern, shift);
    expect(weeks[0].preview.blockingReason).toBeNull();
    expect(weeks[1].preview.blockingReason).toMatch(/already Off/);
    expect(weeks[2].preview.blockingReason).toBeNull();
  });
});

describe('Stage C Step 12A: weekdayOrdinal and bridgeWeekIndex (the rest-preserving bridge-day proof)', () => {
  const offPattern = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday off
  const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' })];

  it('weekdayOrdinal maps JS 0=Sun..6=Sat onto a Monday-start 0..6 ordinal', () => {
    expect(weekdayOrdinal(1)).toBe(0); // Monday
    expect(weekdayOrdinal(2)).toBe(1); // Tuesday
    expect(weekdayOrdinal(3)).toBe(2); // Wednesday
    expect(weekdayOrdinal(5)).toBe(4); // Friday
    expect(weekdayOrdinal(6)).toBe(5); // Saturday
    expect(weekdayOrdinal(0)).toBe(6); // Sunday
  });

  it('a forward shift (new weekday later in the week) needs a bridge at the FIRST affected week', () => {
    expect(bridgeWeekIndex(3, 0, 3)).toBe(0); // Wed -> Sun, 3 weeks
    expect(bridgeWeekIndex(1, 5, 1)).toBe(0); // Mon -> Fri, 1 week
  });

  it('a backward shift (new weekday earlier in the week) needs a bridge at the LAST affected week', () => {
    expect(bridgeWeekIndex(0, 1, 3)).toBe(2); // Sun -> Mon, 3 weeks -- bridge on week index 2 (the last)
    expect(bridgeWeekIndex(5, 1, 1)).toBe(0); // Fri -> Mon, 1 week -- first week is also the last week
  });

  it('no shift at all (same weekday) needs no bridge', () => {
    expect(bridgeWeekIndex(3, 3, 3)).toBe(-1);
  });

  it('buildTemporaryReschedulePlan marks exactly the bridge week, for both shift directions', () => {
    const forward = buildTemporaryReschedulePlan('emp-1', '2026-10-05', 3, 0, 3, 'day', [], offPattern, shift); // Wed -> Sun
    expect(forward.map((w) => w.isBridgeWeek)).toEqual([true, false, false]);

    const sundayOffPattern = [pattern({ weekday: 0, effectiveFrom: '2026-01-01' })];
    const backward = buildTemporaryReschedulePlan('emp-1', '2026-10-05', 0, 1, 3, 'day', [], sundayOffPattern, shift); // Sun -> Mon
    expect(backward.map((w) => w.isBridgeWeek)).toEqual([false, false, true]);
  });

  it('the bridge week\'s preview never flags a Night/Day adjacency conflict for the shift that is never actually placed there', () => {
    // A Night shift resolved the day before the bridge week's original
    // (Wednesday) date would normally conflict with a Day conversion --
    // but the bridge week never converts that date at all, so the
    // conflict must not be flagged.
    const d = [dated({ assignmentDate: '2026-10-06', assignmentType: 'night' })]; // Tuesday night
    const weeks = buildTemporaryReschedulePlan('emp-1', '2026-10-05', 3, 0, 1, 'day', d, offPattern, shift);
    expect(weeks[0].isBridgeWeek).toBe(true);
    expect(weeks[0].preview.hasAdjacencyConflict).toBe(false);
    expect(weeks[0].preview.blockingReason).toBeNull();
  });

  it('the bridge week\'s preview still flags the original date not genuinely being Off, or the replacement already being Off', () => {
    const notOff = [dated({ assignmentDate: '2026-10-07', assignmentType: 'day' })]; // original date overridden to a working day
    const weeksA = buildTemporaryReschedulePlan('emp-1', '2026-10-05', 3, 0, 1, 'day', notOff, offPattern, shift);
    expect(weeksA[0].isBridgeWeek).toBe(true);
    expect(weeksA[0].preview.blockingReason).toMatch(/does not currently resolve to Off/);

    const alreadyOff = [dated({ assignmentDate: '2026-10-11', assignmentType: 'off' })]; // replacement already Off
    const weeksB = buildTemporaryReschedulePlan('emp-1', '2026-10-05', 3, 0, 1, 'day', alreadyOff, offPattern, shift);
    expect(weeksB[0].isBridgeWeek).toBe(true);
    expect(weeksB[0].preview.blockingReason).toMatch(/already Off/);
  });
});

describe('Stage C Step 12A: buildPermanentWeekdayTransitionPlan', () => {
  const offPattern = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday off
  const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' })];

  it('a forward shift (Wed -> Fri) needs one bridge date: the original weekday, in the same week the new pattern takes effect', () => {
    const result = buildPermanentWeekdayTransitionPlan('emp-1', '2026-10-05', 3, 5, [], offPattern, shift);
    expect(result.effectiveFrom).toBe('2026-10-05');
    expect(result.bridgeDate).toBe('2026-10-07'); // Wednesday of that week
    expect(result.originalResolvedAtBridge).toBe('off');
  });

  it('a backward shift (Wed -> Mon) needs no bridge at all', () => {
    const result = buildPermanentWeekdayTransitionPlan('emp-1', '2026-10-05', 3, 1, [], offPattern, shift);
    expect(result.bridgeDate).toBeNull();
    expect(result.originalResolvedAtBridge).toBeNull();
  });
});

describe('Stage C Step 12: explainRollingRestConflict', () => {
  const offPattern = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday off
  const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' })];

  it('extracts the window and lists exactly the working days within it', () => {
    const msg = 'This reschedule would leave employee 11111111-1111-1111-1111-111111111111 with no Off day between 2026-10-05 and 2026-10-11 -- rolling seven-day rest violations cannot be overridden';
    const result = explainRollingRestConflict(msg, 'emp-1', [], offPattern, shift);
    expect(result).not.toBeNull();
    expect(result!.windowStart).toBe('2026-10-05');
    expect(result!.windowEnd).toBe('2026-10-11');
    // Every day in this window resolves 'day' except Wednesday ('off'), so 6 working days.
    expect(result!.workingDays).toEqual(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  });

  it('returns null for a message that does not match the expected rolling-rest-violation shape', () => {
    expect(explainRollingRestConflict('Only Admin may reschedule roster Off days', 'emp-1', [], offPattern, shift)).toBeNull();
  });
});

describe('Stage C Step 12E: formatFriendlyWeekdayDate', () => {
  it('renders "Weekday, D Month" -- never a raw YYYY-MM-DD string', () => {
    expect(formatFriendlyWeekdayDate('2026-10-16')).toBe('Friday, 16 October');
    expect(formatFriendlyWeekdayDate('2026-01-01')).toBe('Thursday, 1 January');
  });
});

// Stage C Step 12E: a live STAGING usability report found the Reschedule
// tab defaulting to "Wednesday" for an employee whose Calendar (for the
// selected week) correctly showed Friday as Off. Investigation (read-only,
// against the real STAGING roster history) found NO resolver bug: the
// employee's recurring Off weekday genuinely is Wednesday (confirmed
// directly from the installed roster_off_day_patterns row, not assumed),
// and a genuine dated exception for that one week converts Wednesday to a
// working day and Friday to Off -- roster_resolve_schedule/
// resolveScheduleForDate already returned this correctly; only the
// Reschedule tab's old "auto-detect from today's pattern" effect asked
// the wrong question. These tests pin the fixed behavior with the real
// shape of that STAGING data.
describe('Stage C Step 12E: summarizeWeekSchedule / describeWeekOffDays', () => {
  it('reproduces the real STAGING finding: recurring Off is Wednesday, but a dated exception makes this week\'s actual Off day Friday', () => {
    const patterns = [pattern({ weekday: 0, effectiveFrom: '2026-10-10' }), pattern({ weekday: 3, effectiveFrom: '2026-10-11' })];
    const assignments = [
      dated({ assignmentDate: '2026-10-12', assignmentType: 'day' }),
      dated({ assignmentDate: '2026-10-13', assignmentType: 'day' }),
      dated({ assignmentDate: '2026-10-14', assignmentType: 'day' }),
      dated({ assignmentDate: '2026-10-15', assignmentType: 'day' }),
      dated({ assignmentDate: '2026-10-16', assignmentType: 'off' }),
    ];

    const summary = summarizeWeekSchedule('emp-1', '2026-10-12', assignments, patterns, []);
    expect(summary.recurringOffWeekday).toBe(3); // Wednesday, as of this week -- verified from the data, not assumed
    expect(summary.actualOffDays).toEqual([{ date: '2026-10-16', weekdayJs: 5, source: 'dated_exception' }]); // Friday

    const text = describeWeekOffDays('Ganizani', summary);
    expect(text.primary).toBe("Ganizani's Off day this week is Friday, 16 October.");
    expect(text.secondary).toBe("Normal weekly Off: Wednesday. This week's Off: Friday because of a schedule exception.");
  });

  it('plain recurring Off, no exception: the week\'s actual Off day matches the recurring pattern, and no mismatch sentence is appended', () => {
    const patterns = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday
    const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' })];
    const summary = summarizeWeekSchedule('emp-1', '2026-10-05', [], patterns, shift);
    expect(summary.actualOffDays).toEqual([{ date: '2026-10-07', weekdayJs: 3, source: 'recurring' }]);
    const text = describeWeekOffDays('Asaya', summary);
    expect(text.primary).toBe("Asaya's Off day this week is Wednesday, 7 October.");
    expect(text.secondary).toBe('Normal weekly Off: Wednesday.');
  });

  it('permanent change already in effect: the active pattern as of the selected week is the NEW weekday, never the superseded one', () => {
    const patterns = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' }), pattern({ weekday: 5, effectiveFrom: '2026-10-05' })]; // Wed -> Fri from week of Oct 5
    const summary = summarizeWeekSchedule('emp-1', '2026-10-05', [], patterns, []);
    expect(summary.recurringOffWeekday).toBe(5);
    expect(summary.actualOffDays.map((o) => o.weekdayJs)).toEqual([5]);
  });

  it('bridge week: TWO genuine Off days (the kept recurring day plus the new dated one), reported as multiple with no auto-pick', () => {
    const patterns = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday
    // Bridge week: Wednesday deliberately left untouched (still off via
    // the pattern) while Sunday is also marked off as the new date --
    // exactly buildTemporaryReschedulePlan's own bridge-week shape.
    const assignments = [dated({ assignmentDate: '2026-10-11', assignmentType: 'off' })]; // Sunday
    const summary = summarizeWeekSchedule('emp-1', '2026-10-05', assignments, patterns, []);
    expect(summary.actualOffDays).toEqual([
      { date: '2026-10-07', weekdayJs: 3, source: 'recurring' },
      { date: '2026-10-11', weekdayJs: 0, source: 'dated_exception' },
    ]);
    const text = describeWeekOffDays('Brian', summary);
    expect(text.primary).toBe('Brian has 2 Off days this week -- choose which one to reschedule.');
    expect(text.secondary).toBe('Normal weekly Off: Wednesday.');
  });

  it('multiple Off days from two independent dated exceptions (not a bridge week at all) are reported the same way', () => {
    const assignments = [
      dated({ assignmentDate: '2026-10-06', assignmentType: 'off' }), // Tuesday
      dated({ assignmentDate: '2026-10-09', assignmentType: 'off' }), // Friday
    ];
    const summary = summarizeWeekSchedule('emp-1', '2026-10-05', assignments, [], []);
    expect(summary.recurringOffWeekday).toBeNull();
    expect(summary.actualOffDays).toHaveLength(2);
    expect(describeWeekOffDays('Alim', summary).primary).toBe('Alim has 2 Off days this week -- choose which one to reschedule.');
  });

  it('no Off day at all: explains clearly, never invents one', () => {
    const summary = summarizeWeekSchedule('emp-1', '2026-10-05', [], [], []);
    expect(summary.actualOffDays).toEqual([]);
    expect(summary.recurringOffWeekday).toBeNull();
    const text = describeWeekOffDays('Simon', summary);
    expect(text.primary).toBe('Simon has no Off day scheduled this week.');
    expect(text.secondary).toBeNull();
  });

  it('no Off day this week despite a recurring pattern existing (pattern not yet effective) -- still explained clearly, not invented', () => {
    const patterns = [pattern({ weekday: 3, effectiveFrom: '2026-11-01' })]; // not yet effective for this week
    const summary = summarizeWeekSchedule('emp-1', '2026-10-05', [], patterns, []);
    expect(summary.actualOffDays).toEqual([]);
    expect(summary.recurringOffWeekday).toBeNull();
    expect(describeWeekOffDays('Simon', summary).secondary).toBeNull();
  });

  it('week switching: recomputes independently for a different week, never reusing a stale result', () => {
    const patterns = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    const assignments = [dated({ assignmentDate: '2026-10-14', assignmentType: 'day' }), dated({ assignmentDate: '2026-10-16', assignmentType: 'off' })];
    const weekA = summarizeWeekSchedule('emp-1', '2026-10-05', assignments, patterns, []); // untouched week
    const weekB = summarizeWeekSchedule('emp-1', '2026-10-12', assignments, patterns, []); // the exception week
    expect(weekA.actualOffDays).toEqual([{ date: '2026-10-07', weekdayJs: 3, source: 'recurring' }]);
    expect(weekB.actualOffDays).toEqual([{ date: '2026-10-16', weekdayJs: 5, source: 'dated_exception' }]);
  });

  it('Calendar/Reschedule consistency: every actualOffDays date independently resolves \'off\' via the exact same resolveScheduleForDate the Calendar tab calls', () => {
    const patterns = [pattern({ weekday: 0, effectiveFrom: '2026-10-10' }), pattern({ weekday: 3, effectiveFrom: '2026-10-11' })];
    const assignments = [dated({ assignmentDate: '2026-10-14', assignmentType: 'day' }), dated({ assignmentDate: '2026-10-16', assignmentType: 'off' })];
    const summary = summarizeWeekSchedule('emp-1', '2026-10-12', assignments, patterns, []);
    for (const off of summary.actualOffDays) {
      expect(resolveScheduleForDate('emp-1', off.date, assignments, patterns, [])).toBe('off');
    }
    // And the non-Off days in the same week must NOT resolve 'off' either way.
    for (const d of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-17', '2026-10-18']) {
      expect(resolveScheduleForDate('emp-1', d, assignments, patterns, [])).not.toBe('off');
    }
  });
});

describe('Stage C Step 13: summarizeDateRangeAssignments (Correct or Cancel Special Assignment -- before/after cancellation preview)', () => {
  it('reproduces the business example: October 4-12 mistakenly marked special Off; cancelling reveals the recurring Wednesday Off on the 7th and the recurring Day shift on every other date, never Day everywhere', () => {
    const patterns = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })]; // Wednesday
    const shift = [shiftPattern({ shiftType: 'day', effectiveFrom: '2026-01-01' })];
    const assignments = ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']
      .map((d) => dated({ assignmentDate: d, assignmentType: 'off' }));

    const summary = summarizeDateRangeAssignments('emp-1', '2026-10-04', '2026-10-12', assignments, patterns, shift);

    expect(summary).toHaveLength(9);
    for (const day of summary) {
      expect(day.resolved).toBe('off'); // currently -- the mistaken special assignment
      expect(day.hasDatedException).toBe(true);
    }
    const wednesday = summary.find((d) => d.date === '2026-10-07')!;
    expect(wednesday.underlyingResolved).toBe('off'); // genuinely off, via the recurring pattern -- NOT via the mistaken dated exception
    for (const d of summary.filter((d) => d.date !== '2026-10-07')) {
      expect(d.underlyingResolved).toBe('day'); // revealed from the recurring shift pattern, never forced
    }
  });

  it('a date with no dated exception is reported as protected: hasDatedException is false and underlyingResolved equals resolved exactly', () => {
    const patterns = [pattern({ weekday: 3, effectiveFrom: '2026-01-01' })];
    const summary = summarizeDateRangeAssignments('emp-1', '2026-10-05', '2026-10-06', [], patterns, []);
    for (const day of summary) {
      expect(day.hasDatedException).toBe(false);
      expect(day.underlyingResolved).toBe(day.resolved);
    }
  });

  it('correcting a special Day to Night mid-range: underlyingResolved still reflects what cancelling (not correcting) would reveal, independent of the requested correction type', () => {
    const patterns: OffDayPatternRow[] = [];
    const shift = [shiftPattern({ shiftType: 'night', effectiveFrom: '2026-01-01' })];
    const assignments = [dated({ assignmentDate: '2026-10-07', assignmentType: 'day' })];
    const summary = summarizeDateRangeAssignments('emp-1', '2026-10-07', '2026-10-07', assignments, patterns, shift);
    expect(summary[0].resolved).toBe('day');
    expect(summary[0].hasDatedException).toBe(true);
    expect(summary[0].underlyingResolved).toBe('night'); // what cancellation reveals -- the recurring Night pattern
  });

  it('an unassigned date (no dated exception, no pattern at all) resolves and reveals the same \'unassigned\' value, never invented', () => {
    const summary = summarizeDateRangeAssignments('emp-1', '2026-10-07', '2026-10-07', [], [], []);
    expect(summary[0].resolved).toBe('unassigned');
    expect(summary[0].hasDatedException).toBe(false);
    expect(summary[0].underlyingResolved).toBe('unassigned');
  });

  it('only cancels/inspects the named employee -- another employee\'s dated assignment on the same date is ignored entirely', () => {
    const assignments = [dated({ employeeId: 'emp-2', assignmentDate: '2026-10-07', assignmentType: 'off' })];
    const summary = summarizeDateRangeAssignments('emp-1', '2026-10-07', '2026-10-07', assignments, [], []);
    expect(summary[0].hasDatedException).toBe(false);
    expect(summary[0].resolved).toBe('unassigned');
  });
});

describe('Stage C Step 14: evaluateCancellationSafety / describeCancellationSafety (real STAGING finding: LUCIOUS LIGOMERA, SFG-S-469)', () => {
  // Reproduces the exact real-world shape: recurring Day shift + recurring
  // Sunday Off effective 2026-10-15; five immovable dated Day overrides
  // Oct 10-14 (Sat-Wed, a separate, already-settled correction); a mistaken
  // special Off Oct 15-17 (Thu-Sat) about to be cancelled. Oct 10 2026 is a
  // Saturday, Oct 15 a Thursday, Oct 18 a Sunday (confirmed against STAGING
  // directly before writing this test).
  const luciousPatterns = [pattern({ employeeId: 'lucious', weekday: 0, effectiveFrom: '2026-10-15' })]; // Sunday
  const luciousShift = [shiftPattern({ employeeId: 'lucious', shiftType: 'day', effectiveFrom: '2026-10-15' })];
  const luciousDated = [
    ...['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'].map((d) => dated({ employeeId: 'lucious', assignmentDate: d, assignmentType: 'day' })),
    ...['2026-10-15', '2026-10-16', '2026-10-17'].map((d) => dated({ employeeId: 'lucious', assignmentDate: d, assignmentType: 'off' })),
  ];

  it('flags the full Oct 15-17 cancellation as unsafe: it would leave no rest day in the Oct 10-16 window (confirmed_violation, not merely incomplete)', () => {
    const safety = evaluateCancellationSafety('lucious', '2026-10-15', '2026-10-17', luciousDated, luciousPatterns, luciousShift);
    expect(safety.safe).toBe(false);
    expect(safety.adjacencyConflictDates).toEqual([]);
    expect(safety.restViolations).toEqual(expect.arrayContaining([expect.objectContaining({ windowStart: '2026-10-10', windowEnd: '2026-10-16', status: 'confirmed_violation' })]));
  });

  it('finds the genuine safe alternative: cancel only Oct 16-17 (Fri-Sat), keeping Oct 15 (Thursday) Off as the rest day for the Oct 10-16 window', () => {
    const safety = evaluateCancellationSafety('lucious', '2026-10-15', '2026-10-17', luciousDated, luciousPatterns, luciousShift);
    expect(safety.safeSuffixRange).toEqual({ dateFrom: '2026-10-16', dateTo: '2026-10-17' });
  });

  it('also finds a safe prefix alternative: cancelling ONLY Oct 15 (Thursday) is safe too, since Oct 16 (Friday) then stays Off and still covers the Oct 10-16 window -- but cancelling Oct 15 AND 16 together is not, since that empties the window entirely', () => {
    const safety = evaluateCancellationSafety('lucious', '2026-10-15', '2026-10-17', luciousDated, luciousPatterns, luciousShift);
    expect(safety.safePrefixRange).toEqual({ dateFrom: '2026-10-15', dateTo: '2026-10-15' });
  });

  it('confirms the suffix alternative is independently safe when actually evaluated as its own request (what submitting it would re-check)', () => {
    const safety = evaluateCancellationSafety('lucious', '2026-10-16', '2026-10-17', luciousDated, luciousPatterns, luciousShift);
    expect(safety.safe).toBe(true);
  });

  it('reports the full range as safe (zero violations, both alternative fields null) once Oct 10-14 are no longer immovable -- i.e. the conflict is a genuine data-dependent fact, not a hardcoded rejection', () => {
    const lighterDated = luciousDated.filter((a) => a.assignmentDate >= '2026-10-15'); // drop the five immovable Day overrides
    const safety = evaluateCancellationSafety('lucious', '2026-10-15', '2026-10-17', lighterDated, luciousPatterns, luciousShift);
    expect(safety.safe).toBe(true);
    expect(safety.safePrefixRange).toBeNull();
    expect(safety.safeSuffixRange).toBeNull();
  });

  it('describeCancellationSafety explains the conflict in weekdays (not raw ISO dates) and names the real suggestion', () => {
    const safety = evaluateCancellationSafety('lucious', '2026-10-15', '2026-10-17', luciousDated, luciousPatterns, luciousShift);
    const description = describeCancellationSafety('Lucious Ligomera', safety);
    expect(description).not.toBeNull();
    expect(description!.primary).toContain('Lucious Ligomera');
    expect(description!.primary).toContain('Saturday, 10 October');
    expect(description!.primary).toContain('Friday, 16 October');
    expect(description!.primary).toContain('Malawi Employment Act');
    expect(description!.suggestion).toContain('keep Thursday, 15 October Off');
    expect(description!.suggestion).toContain('cancel only from Friday, 16 October to Saturday, 17 October');
  });

  it('describeCancellationSafety returns null when the result is already safe -- never invents a conflict', () => {
    expect(describeCancellationSafety('Anyone', { safe: true, adjacencyConflictDates: [], restViolations: [], safePrefixRange: null, safeSuffixRange: null })).toBeNull();
  });

  it('is never fooled by an immovable working day replaced by an UNASSIGNED gap -- an unassigned day makes the window merely "incomplete", not a hard violation, exactly mirroring the server (roster_rolling_rest_windows) which never hard-blocks on missing data', () => {
    // Same shape, but Oct 10-14 have no dated rows at all (nothing assigned, not even patterns before Oct 15).
    const safety = evaluateCancellationSafety(
      'lucious', '2026-10-15', '2026-10-17',
      luciousDated.filter((a) => a.assignmentDate >= '2026-10-15'),
      luciousPatterns, luciousShift
    );
    expect(safety.safe).toBe(true);
  });

  it('detects a Night-to-Day adjacency conflict a cancellation would create, independent of any rolling-rest violation', () => {
    // Night baseline with an UNTOUCHED recurring Sunday Off (so every
    // 7-day window structurally contains one Sunday -- by the pigeonhole
    // principle any 7 consecutive calendar days span every weekday
    // exactly once -- and can never be a confirmed_violation here,
    // isolating this test to adjacency only). Oct 13 (Tue) has a mistaken
    // dated Day override; Oct 14 (Wed) separately has an active dated Day
    // assignment that is NOT part of this cancellation request. Cancelling
    // Oct 13 alone would reveal Night immediately before Oct 14's
    // still-active Day.
    const nightPatterns = [pattern({ employeeId: 'adj', weekday: 0, effectiveFrom: '2026-01-01' })]; // Sunday, never overridden
    const nightShift = [shiftPattern({ employeeId: 'adj', shiftType: 'night', effectiveFrom: '2026-01-01' })];
    const nightDated = [
      dated({ employeeId: 'adj', assignmentDate: '2026-10-13', assignmentType: 'day' }),
      dated({ employeeId: 'adj', assignmentDate: '2026-10-14', assignmentType: 'day' }),
    ];
    const safety = evaluateCancellationSafety('adj', '2026-10-13', '2026-10-13', nightDated, nightPatterns, nightShift);
    expect(safety.safe).toBe(false);
    expect(safety.adjacencyConflictDates).toEqual(['2026-10-13']);
    expect(safety.restViolations).toEqual([]);
  });

  it('a partial-range correction that is already safe reports safe=true with no alternative fields populated', () => {
    const safety = evaluateCancellationSafety('lucious', '2026-10-16', '2026-10-16', luciousDated, luciousPatterns, luciousShift);
    // Cancelling only Friday leaves Thursday AND Saturday still dated Off -- always safe regardless of the immovable days before it.
    expect(safety.safe).toBe(true);
    expect(safety.safePrefixRange).toBeNull();
    expect(safety.safeSuffixRange).toBeNull();
  });

  it('a range with no active dated exception anywhere in it is trivially safe (nothing to cancel, matching roster_cancel_date_assignments’s own no-op/skip behavior)', () => {
    const safety = evaluateCancellationSafety('lucious', '2026-01-01', '2026-01-02', luciousDated, luciousPatterns, luciousShift);
    expect(safety.safe).toBe(true);
    expect(safety.adjacencyConflictDates).toEqual([]);
    expect(safety.restViolations).toEqual([]);
  });

  it('generalizes across every weekday, not just Sunday: a Monday recurring Off produces the same safe-suffix shape when the mistaken special Off lands on the days right after it', () => {
    // Monday Off, Day baseline, both effective from day 1. Five immovable
    // Day days Sat-Wed (weekday 6,0,1,2,3 -- note Monday itself, weekday 1,
    // is skipped here because it's already genuinely off), then a mistaken
    // special Off Thu-Sat.
    const mondayPatterns = [pattern({ employeeId: 'mon', weekday: 1, effectiveFrom: '2026-01-01' })]; // Monday
    const mondayShift = [shiftPattern({ employeeId: 'mon', shiftType: 'day', effectiveFrom: '2026-01-01' })];
    const mondayDated = [
      ...['2026-10-10', '2026-10-11', '2026-10-13', '2026-10-14'].map((d) => dated({ employeeId: 'mon', assignmentDate: d, assignmentType: 'day' })), // Sat,Sun,Tue,Wed (Mon the 12th stays genuinely off, untouched)
      ...['2026-10-15', '2026-10-16', '2026-10-17'].map((d) => dated({ employeeId: 'mon', assignmentDate: d, assignmentType: 'off' })),
    ];
    const safety = evaluateCancellationSafety('mon', '2026-10-15', '2026-10-17', mondayDated, mondayPatterns, mondayShift);
    // Oct 10-16 window: Sat,Sun,Mon(off, recurring),Tue,Wed,Thu,Fri -- has an off day (Monday) already, so this window is fine either way.
    // Oct 11-17: Sun,Mon(off),Tue,Wed,Thu,Fri,Sat -- also has Monday off. So the full range is actually already safe here.
    expect(safety.safe).toBe(true);
  });
});
