// Safeguard HikCentral Attendance MVP -- Phase 2B.1: Roster Management
// Foundation. Pure, DB-free scheduling logic. Everything here operates on
// already-fetched plain data and returns plain data -- no Supabase calls.
// This is the EXECUTABLE SPEC the new migration's PL/pgSQL functions
// mirror: every rule enforced server-side (resolution precedence, the
// rolling-seven-day rest check, Night-to-Day adjacency, Off-day override
// detection, idempotency) is implemented here FIRST and unit-tested, then
// transcribed into SQL. See the migration file's header for how the two
// stay in sync.
//
// SCOPE: this module assigns and resolves WHO is scheduled Day/Night/Off
// on WHICH calendar date. It computes NOTHING about attendance, lateness,
// hours worked, or payroll -- those remain entirely separate, untouched
// concerns (the shift-window constants below are definitions only, kept
// here so a future phase has one place to read them from, never consumed
// by any calculation in this module).
//
// CORE INVARIANT: all dates are plain Africa/Blantyre calendar dates
// (YYYY-MM-DD strings), never UTC instants -- there is no timezone
// conversion anywhere in this file, because a roster assignment is
// inherently a calendar-date concept (per the confirmed business rule,
// "a Night shift belongs to its starting date"), not a timestamp. Dates
// are compared as plain strings throughout (correct because zero-padded
// ISO YYYY-MM-DD strings sort lexicographically in calendar order) and
// never parsed with the host's local timezone.

export type AssignmentType = 'day' | 'night' | 'off';
export type ResolvedSchedule = AssignmentType | 'unassigned';

// Shift-window definitions (confirmed business policy). NOT used by any
// calculation in this module -- kept here as the one place to read them
// from for a future phase, and so the UI can display them without a
// second copy of these numbers.
export const DAY_SHIFT = {
  scheduledStart: '06:00',
  scheduledEnd: '18:00',
  validCheckInWindow: ['04:00', '08:00'] as const,
  validCheckOutWindow: ['16:00', '20:00'] as const,
  lateAfter: '06:15',
};
export const NIGHT_SHIFT = {
  scheduledStart: '18:00',
  scheduledEnd: '06:00', // next calendar date
  validCheckInWindow: ['16:00', '20:00'] as const,
  validCheckOutWindow: ['04:00', '08:00'] as const, // next calendar date
  lateAfter: '18:15',
};

export interface OffDayPatternRow {
  employeeId: string;
  /** 0 = Sunday .. 6 = Saturday (JS Date#getUTCDay() convention). */
  weekday: number;
  /** YYYY-MM-DD -- the date this pattern took effect. */
  effectiveFrom: string;
  /** false for a row that was later identified as wrong and corrected away -- excluded from resolution. */
  isActive: boolean;
}

export interface DateAssignmentRow {
  employeeId: string;
  /** YYYY-MM-DD */
  assignmentDate: string;
  assignmentType: AssignmentType;
  isActive: boolean;
}

function parseIsoDate(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

/** 0 = Sunday .. 6 = Saturday, computed from the plain calendar date (never the host's local timezone or a wall-clock instant). */
export function weekdayOf(date: string): number {
  const { y, m, d } = parseIsoDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parseIsoDate(date);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Resolves the effective schedule for one employee on one date, applying
 * the precedence rule exactly:
 *   1. An active dated assignment for this exact date always wins
 *      (whether 'day', 'night', or an explicit 'off' exception) --
 *      regardless of what the recurring pattern says.
 *   2. Else, the recurring Off-day pattern in effect on this date (the
 *      active pattern row with the LARGEST effectiveFrom <= date) -- if
 *      its weekday matches, the date is 'off'.
 *   3. Else, 'unassigned' -- no information recorded for this date at
 *      all. Never Absence, never Leave, never Sick Leave -- those remain
 *      exclusively `attendance.status` concerns, untouched by this module.
 */
export function resolveScheduleForDate(
  employeeId: string,
  date: string,
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[]
): ResolvedSchedule {
  const dated = datedAssignments.find((a) => a.employeeId === employeeId && a.assignmentDate === date && a.isActive);
  if (dated) return dated.assignmentType;

  let latest: OffDayPatternRow | null = null;
  for (const p of patterns) {
    if (p.employeeId !== employeeId || !p.isActive || p.effectiveFrom > date) continue;
    if (!latest || p.effectiveFrom > latest.effectiveFrom) latest = p;
  }
  if (!latest) return 'unassigned';
  return weekdayOf(date) === latest.weekday ? 'off' : 'unassigned';
}

// A rolling-rest window's zero-Off-days outcome is only ever a CONFIRMED
// violation when every date in it is actually known (resolved to a real
// working/off value) -- a window containing an 'unassigned' date cannot
// be confirmed either way yet, and must never be reported as a violation
// (per the explicit requirement to distinguish incomplete schedules from
// confirmed violations).
export type RollingRestWindowStatus = 'ok' | 'confirmed_violation' | 'incomplete';

export interface RollingRestWindowResult {
  windowStart: string;
  windowEnd: string;
  status: RollingRestWindowStatus;
}

// Generous enough to guarantee every 7-day window that could possibly be
// affected by a single weekday-pattern change is covered, regardless of
// which direction the change moves the Off weekday (worst case: old and
// new Off-weekdays up to 6 days apart).
export const ROLLING_WINDOW_BUFFER_DAYS = 13;

/**
 * Checks every consecutive 7-day window in [centerDate - 13, centerDate + 13]
 * for this employee, classifying each as 'ok' (contains an Off day),
 * 'confirmed_violation' (every date resolved, none Off), or 'incomplete'
 * (contains at least one 'unassigned' date, so nothing can be confirmed).
 */
export function checkRollingRestWindows(
  employeeId: string,
  centerDate: string,
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[]
): RollingRestWindowResult[] {
  const rangeStart = addDays(centerDate, -ROLLING_WINDOW_BUFFER_DAYS);
  const totalDays = ROLLING_WINDOW_BUFFER_DAYS * 2 + 1;
  const dates: string[] = [];
  for (let i = 0; i < totalDays; i++) dates.push(addDays(rangeStart, i));
  const resolved = dates.map((d) => resolveScheduleForDate(employeeId, d, datedAssignments, patterns));

  const results: RollingRestWindowResult[] = [];
  for (let i = 0; i + 7 <= dates.length; i++) {
    const window = resolved.slice(i, i + 7);
    const hasOff = window.includes('off');
    const hasUnassigned = window.includes('unassigned');
    const status: RollingRestWindowStatus = hasOff ? 'ok' : hasUnassigned ? 'incomplete' : 'confirmed_violation';
    results.push({ windowStart: dates[i], windowEnd: dates[i + 6], status });
  }
  return results;
}

/** Convenience filter -- only the windows that must hard-block a write (no override path exists for these, per confirmed policy). */
export function findConfirmedRollingRestViolations(
  employeeId: string,
  centerDate: string,
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[]
): RollingRestWindowResult[] {
  return checkRollingRestWindows(employeeId, centerDate, datedAssignments, patterns).filter(
    (w) => w.status === 'confirmed_violation'
  );
}

/**
 * True when assigning `newType` to `date` would put this employee in two
 * places at once against an adjacent day's assignment -- Night(date-1)
 * followed by Day(date), or Day(date+1) preceded by Night(date) -- per
 * the confirmed hard-block policy. Night(date) bleeding into an Off day
 * on date+1 is NEVER a conflict (confirmed valid pattern) and is
 * deliberately not checked here at all.
 */
export function hasNightToDayConflict(
  employeeId: string,
  date: string,
  newType: AssignmentType,
  datedAssignments: DateAssignmentRow[]
): boolean {
  const findActive = (d: string) => datedAssignments.find((a) => a.employeeId === employeeId && a.assignmentDate === d && a.isActive);
  if (newType === 'day') {
    const prev = findActive(addDays(date, -1));
    if (prev?.assignmentType === 'night') return true;
  }
  if (newType === 'night') {
    const next = findActive(addDays(date, 1));
    if (next?.assignmentType === 'day') return true;
  }
  return false;
}

/**
 * True when assigning `newType` (day/night) to `date` would collide with
 * what the employee's recorded schedule (dated exception or recurring
 * pattern) says is an Off day. The write path (`roster_assign_dates`)
 * always hard-blocks this case -- there is no override. This helper is for
 * the UI to warn before submitting and point the user at
 * `roster_reschedule_off_day` instead of waiting for the RPC to reject it.
 */
export function wouldOverrideRecurringOffDay(
  employeeId: string,
  date: string,
  newType: AssignmentType,
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[]
): boolean {
  if (newType === 'off') return false;
  return resolveScheduleForDate(employeeId, date, datedAssignments, patterns) === 'off';
}

/** True when the currently-active dated assignment for (employeeId, date) already equals requestedType exactly -- the write path's idempotent-retry no-op signal. */
export function isDateAssignmentNoOp(
  employeeId: string,
  date: string,
  requestedType: AssignmentType,
  datedAssignments: DateAssignmentRow[]
): boolean {
  const existing = datedAssignments.find((a) => a.employeeId === employeeId && a.assignmentDate === date && a.isActive);
  return !!existing && existing.assignmentType === requestedType;
}

/** True when the currently-active Off-day pattern for employeeId already has this exact weekday effective from this exact date -- the write path's idempotent-retry no-op signal for patterns. */
export function isOffPatternNoOp(
  employeeId: string,
  weekday: number,
  effectiveFrom: string,
  patterns: OffDayPatternRow[]
): boolean {
  const existing = patterns.find((p) => p.employeeId === employeeId && p.isActive && p.effectiveFrom === effectiveFrom);
  return !!existing && existing.weekday === weekday;
}

/** Every date in [dateFrom, dateTo] inclusive, as plain YYYY-MM-DD strings. */
export function expandDateRange(dateFrom: string, dateTo: string): string[] {
  const dates: string[] = [];
  for (let d = dateFrom; d <= dateTo; d = addDays(d, 1)) dates.push(d);
  return dates;
}

export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
