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

// Stage C Step 6B: recurring Day/Night baseline, symmetric to
// OffDayPatternRow above -- same shape, shift_type instead of weekday.
export interface ShiftPatternRow {
  employeeId: string;
  shiftType: 'day' | 'night';
  /** YYYY-MM-DD -- the date this pattern took effect. */
  effectiveFrom: string;
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
 * the precedence rule exactly (Stage C Step 6B adds step 3; steps 1, 2,
 * and the final fallback are unchanged from Step 6A):
 *   1. An active dated assignment for this exact date always wins
 *      (whether 'day', 'night', or an explicit 'off' exception) --
 *      regardless of what either recurring pattern says.
 *   2. Else, the recurring Off-day pattern in effect on this date (the
 *      active pattern row with the LARGEST effectiveFrom <= date) -- if
 *      its weekday matches, the date is 'off'.
 *   3. Else, the recurring Day/Night pattern in effect on this date (the
 *      active shiftPatterns row with the LARGEST effectiveFrom <= date,
 *      independent of the Off-day pattern's own effectiveFrom) -- if one
 *      exists, the date is that pattern's shiftType.
 *   4. Else, 'unassigned' -- no information recorded for this date at
 *      all (including an employee with no recurring pattern of either
 *      kind configured). Never Absence, never Leave, never Sick Leave --
 *      those remain exclusively `attendance.status` concerns, untouched
 *      by this module.
 */
export function resolveScheduleForDate(
  employeeId: string,
  date: string,
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): ResolvedSchedule {
  const dated = datedAssignments.find((a) => a.employeeId === employeeId && a.assignmentDate === date && a.isActive);
  if (dated) return dated.assignmentType;

  let latestOff: OffDayPatternRow | null = null;
  for (const p of patterns) {
    if (p.employeeId !== employeeId || !p.isActive || p.effectiveFrom > date) continue;
    if (!latestOff || p.effectiveFrom > latestOff.effectiveFrom) latestOff = p;
  }
  if (latestOff && weekdayOf(date) === latestOff.weekday) return 'off';

  let latestShift: ShiftPatternRow | null = null;
  for (const p of shiftPatterns) {
    if (p.employeeId !== employeeId || !p.isActive || p.effectiveFrom > date) continue;
    if (!latestShift || p.effectiveFrom > latestShift.effectiveFrom) latestShift = p;
  }
  if (latestShift) return latestShift.shiftType;

  return 'unassigned';
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
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): RollingRestWindowResult[] {
  const rangeStart = addDays(centerDate, -ROLLING_WINDOW_BUFFER_DAYS);
  const totalDays = ROLLING_WINDOW_BUFFER_DAYS * 2 + 1;
  const dates: string[] = [];
  for (let i = 0; i < totalDays; i++) dates.push(addDays(rangeStart, i));
  const resolved = dates.map((d) => resolveScheduleForDate(employeeId, d, datedAssignments, patterns, shiftPatterns));

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
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): RollingRestWindowResult[] {
  return checkRollingRestWindows(employeeId, centerDate, datedAssignments, patterns, shiftPatterns).filter(
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
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): boolean {
  if (newType === 'off') return false;
  return resolveScheduleForDate(employeeId, date, datedAssignments, patterns, shiftPatterns) === 'off';
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

/** True when the currently-active recurring Shift pattern for employeeId already has this exact shiftType effective from this exact date -- the write path's idempotent-retry no-op signal, symmetric to isOffPatternNoOp above. */
export function isShiftPatternNoOp(
  employeeId: string,
  shiftType: 'day' | 'night',
  effectiveFrom: string,
  shiftPatterns: ShiftPatternRow[]
): boolean {
  const existing = shiftPatterns.find((p) => p.employeeId === employeeId && p.isActive && p.effectiveFrom === effectiveFrom);
  return !!existing && existing.shiftType === shiftType;
}

// Phase 2B.2C: Reschedule Off Day, Policy Option A. Pure preview logic
// mirroring exactly what the new roster_reschedule_off_day RPC
// (20261009000000_roster_reschedule_off_day_option_a.sql) independently
// re-verifies server-side -- this is advisory only (lets the UI show a
// clear Before/After preview and disable submission early), never the
// actual authority. The database remains the sole source of truth,
// including for the rolling seven-day rest rule, which this preview does
// NOT attempt to replicate (that check depends on the employee's full
// resolved schedule across a 27-day window, which the UI does not fetch
// in full) -- a reschedule that looks clean here can still be correctly
// rejected by the database, and that rejection is never a bug in this
// preview.
export interface RescheduleOffDayPreview {
  originalResolved: ResolvedSchedule;
  replacementResolved: ResolvedSchedule;
  isOriginalGenuinelyOff: boolean;
  isReplacementEligible: boolean;
  hasAdjacencyConflict: boolean;
  /** Non-null means the UI should disable submission; null means the preview found no issue (the database still re-checks everything independently). */
  blockingReason: string | null;
}

export function buildRescheduleOffDayPreview(
  employeeId: string,
  originalDate: string,
  replacementDate: string,
  shiftOnOriginal: 'day' | 'night',
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): RescheduleOffDayPreview {
  const originalResolved = resolveScheduleForDate(employeeId, originalDate, datedAssignments, patterns, shiftPatterns);
  const replacementResolved = resolveScheduleForDate(employeeId, replacementDate, datedAssignments, patterns, shiftPatterns);
  const isOriginalGenuinelyOff = originalResolved === 'off';
  // Stage C Step 12 CHANGE (mirrors the identical, equally-corrected check
  // in roster_reschedule_off_day): reject the replacement date ONLY when
  // it is already 'off' -- that would let Admin believe a genuine swap
  // happened while the employee's real weekly rest entitlement was
  // actually reduced (the original date's rest converts to work, with no
  // new rest gained in exchange). A 'day', 'night', or 'unassigned'
  // replacement is accepted: since Stage C Step 6B most employees carry a
  // recurring Day/Night pattern covering every non-Off date, the
  // realistic swap target (e.g. "Wednesday Off -> Sunday Off") resolves
  // to a normal working day, not 'unassigned' -- requiring 'unassigned'
  // made the common case impossible.
  const isReplacementEligible = replacementResolved !== 'off';
  const hasAdjacencyConflict = hasNightToDayConflict(employeeId, originalDate, shiftOnOriginal, datedAssignments);

  let blockingReason: string | null = null;
  if (originalDate === replacementDate) {
    blockingReason = 'The replacement Off date must be different from the original Off date.';
  } else if (!isOriginalGenuinelyOff) {
    blockingReason = `The original date does not currently resolve to Off (it is "${originalResolved}"). Choose the employee's actual Off date.`;
  } else if (!isReplacementEligible) {
    blockingReason = `The replacement date is already Off. Choose a date that is not already Off -- a normal working day or an unassigned date is fine.`;
  } else if (hasAdjacencyConflict) {
    blockingReason = `A ${shiftOnOriginal} shift cannot be placed on the original date -- it conflicts with an adjacent Night/Day shift.`;
  }

  return { originalResolved, replacementResolved, isOriginalGenuinelyOff, isReplacementEligible, hasAdjacencyConflict, blockingReason };
}

/** The actual calendar date of `weekdayJs` (0=Sun..6=Sat) within the Mon-Sun week that starts at `weekStartMonday`. */
export function dateForWeekdayInWeek(weekStartMonday: string, weekdayJs: number): string {
  const offset = weekdayJs === 0 ? 6 : weekdayJs - 1;
  return addDays(weekStartMonday, offset);
}

/** The employee's currently active recurring Off weekday as of `asOfDate` (the active pattern row with the largest effectiveFrom <= asOfDate), or null if none is configured. Used only to intelligently default a UI field -- never treated as authoritative by any write path. */
export function resolveActiveOffWeekday(employeeId: string, asOfDate: string, patterns: OffDayPatternRow[]): number | null {
  let latest: OffDayPatternRow | null = null;
  for (const p of patterns) {
    if (p.employeeId !== employeeId || !p.isActive || p.effectiveFrom > asOfDate) continue;
    if (!latest || p.effectiveFrom > latest.effectiveFrom) latest = p;
  }
  return latest ? latest.weekday : null;
}

/** The employee's currently active recurring Day/Night shift type as of `asOfDate`, or null if none is configured. Symmetric to resolveActiveOffWeekday above -- used only to default a UI field. */
export function resolveActiveShiftType(employeeId: string, asOfDate: string, shiftPatterns: ShiftPatternRow[]): 'day' | 'night' | null {
  let latest: ShiftPatternRow | null = null;
  for (const p of shiftPatterns) {
    if (p.employeeId !== employeeId || !p.isActive || p.effectiveFrom > asOfDate) continue;
    if (!latest || p.effectiveFrom > latest.effectiveFrom) latest = p;
  }
  return latest ? latest.shiftType : null;
}

// Stage C Step 12A: the Monday-start ordinal position of a weekday
// (0=Monday..6=Sunday), independent of the 0=Sunday..6=Saturday JS
// convention used for weekday/originalWeekday/newWeekday everywhere
// else in this module. Used ONLY to determine shift DIRECTION (forward
// = later in the week, backward = earlier) for the bridge-day
// calculation below -- see buildTemporaryReschedulePlan's header for
// the full proof this mirrors from roster_apply_weekday_transition's
// migration header.
export function weekdayOrdinal(weekdayJs: number): number {
  return weekdayJs === 0 ? 6 : weekdayJs - 1;
}

// Stage C Step 12: a temporary, multi-week Off-day change --
// "<original weekday> Off -> <new weekday> Off for N weeks".
//
// Stage C Step 12A CHANGE: testing Step 12's original design (one
// roster_reschedule_off_day call per affected week, looped client-side)
// against an administrator's realistic primary use case -- moving an
// ALREADY-ESTABLISHED, indefinitely-repeating single-weekday pattern --
// proved it ALWAYS violated the rolling-seven-day rest rule: a perfectly
// periodic single-Off-day pattern has ZERO slack, so removing the one
// Off day that used to cover a run of 7-day windows and placing the new
// Off day elsewhere in the same week necessarily uncovers at least one
// window, for ANY nonzero shift. The fix (proved in full in
// roster_apply_weekday_transition's migration header) is to keep the
// OLD weekday ALSO Off (instead of converting it to a working day) for
// EXACTLY ONE transition week -- the FIRST affected week when the new
// weekday is LATER in the Mon-Sun week than the old one, or the LAST
// affected week when it is EARLIER -- which always suffices to bridge
// the gap. This plan now marks that one week as `isBridgeWeek`, and the
// actual multi-week write is now a SINGLE atomic RPC call
// (roster_apply_weekday_transition), never a per-week loop, so a
// mid-sequence failure can no longer leave some weeks changed and
// others not.
export interface TemporaryRescheduleWeekPlan {
  weekStart: string;
  weekEnd: string;
  originalDate: string;
  newOffDate: string;
  preview: RescheduleOffDayPreview;
  /** True for the single week (if any) that must keep the original weekday ALSO Off, instead of converting it to a working day, to preserve the rolling seven-day rest rule across the transition. */
  isBridgeWeek: boolean;
}

/** -1 when no bridge week is needed (shift direction is a no-op, which should never actually be submitted -- see rescheduleSameWeekday gating). */
export function bridgeWeekIndex(originalWeekday: number, newWeekday: number, durationWeeks: number): number {
  const direction = weekdayOrdinal(newWeekday) - weekdayOrdinal(originalWeekday);
  if (direction > 0) return 0;
  if (direction < 0) return durationWeeks - 1;
  return -1;
}

export function buildTemporaryReschedulePlan(
  employeeId: string,
  anchorWeekStart: string,
  originalWeekday: number,
  newWeekday: number,
  durationWeeks: number,
  shiftOnOriginal: 'day' | 'night',
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): TemporaryRescheduleWeekPlan[] {
  const bridgeIndex = bridgeWeekIndex(originalWeekday, newWeekday, durationWeeks);
  const weeks: TemporaryRescheduleWeekPlan[] = [];
  for (let i = 0; i < durationWeeks; i++) {
    const weekStart = addDays(anchorWeekStart, i * 7);
    const weekEnd = addDays(weekStart, 6);
    const originalDate = dateForWeekdayInWeek(weekStart, originalWeekday);
    const newOffDate = dateForWeekdayInWeek(weekStart, newWeekday);
    const isBridgeWeek = i === bridgeIndex;
    // The bridge week never actually places shiftOnOriginal on
    // originalDate (it stays Off instead -- see this function's header),
    // so the Night/Day adjacency check (which only matters for a shift
    // that is actually being written) does not apply to it -- only the
    // two eligibility checks (original genuinely Off, replacement not
    // already Off) remain meaningful for that one week.
    const preview = isBridgeWeek
      ? { ...buildRescheduleOffDayPreview(employeeId, originalDate, newOffDate, shiftOnOriginal, datedAssignments, patterns, shiftPatterns), hasAdjacencyConflict: false, blockingReason: (() => {
          const originalResolved = resolveScheduleForDate(employeeId, originalDate, datedAssignments, patterns, shiftPatterns);
          const replacementResolved = resolveScheduleForDate(employeeId, newOffDate, datedAssignments, patterns, shiftPatterns);
          if (originalDate === newOffDate) return 'The replacement Off date must be different from the original Off date.';
          if (originalResolved !== 'off') return `The original date does not currently resolve to Off (it is "${originalResolved}"). Choose the employee's actual Off date.`;
          if (replacementResolved === 'off') return 'The replacement date is already Off. Choose a date that is not already Off -- a normal working day or an unassigned date is fine.';
          return null;
        })() }
      : buildRescheduleOffDayPreview(employeeId, originalDate, newOffDate, shiftOnOriginal, datedAssignments, patterns, shiftPatterns);
    weeks.push({ weekStart, weekEnd, originalDate, newOffDate, preview, isBridgeWeek });
  }
  return weeks;
}

// Stage C Step 12A: the Permanent-change counterpart of the bridge logic
// above. A backward shift (new weekday earlier in the week than the
// old one) never needs a bridge for a Permanent change -- its entry gap
// is already <7 days, and the new pattern then repeats forever at
// exactly 7-day spacing with no second boundary to protect (see the
// migration header's proof). A forward shift needs exactly one bridge
// date: the OLD weekday, in the SAME week the new pattern takes effect,
// kept Off via one dated exception (the new pattern switches ALL of
// that week over to the new weekday otherwise, in one atomic step).
export interface PermanentWeekdayTransitionPlan {
  effectiveFrom: string;
  /** The one date that must be kept Off as a dated exception to bridge the transition, or null when no bridge is needed (backward shift). */
  bridgeDate: string | null;
  originalResolvedAtBridge: ResolvedSchedule | null;
}

export function buildPermanentWeekdayTransitionPlan(
  employeeId: string,
  effectiveFrom: string,
  originalWeekday: number,
  newWeekday: number,
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): PermanentWeekdayTransitionPlan {
  const direction = weekdayOrdinal(newWeekday) - weekdayOrdinal(originalWeekday);
  const bridgeDate = direction > 0 ? dateForWeekdayInWeek(effectiveFrom, originalWeekday) : null;
  const originalResolvedAtBridge = bridgeDate
    ? resolveScheduleForDate(employeeId, bridgeDate, datedAssignments, patterns, shiftPatterns)
    : null;
  return { effectiveFrom, bridgeDate, originalResolvedAtBridge };
}

// Stage C Step 12: the rolling-seven-day rest rule is NEVER replicated
// client-side (see buildRescheduleOffDayPreview's own header/established
// precedent -- it needs the employee's full resolved schedule across a
// 27-day window, which this preview deliberately does not fetch). When
// the server rejects a week for this reason, its raw message already
// names the employee (by uuid, humanized elsewhere) and the violated
// window's start/end dates (a plain `RAISE EXCEPTION ... between % and
// %`, always two ISO YYYY-MM-DD dates). This helper turns that window
// into a concrete, plain-language explanation: which specific days in it
// are working days (the actual conflict), so Admin sees the real cause
// rather than just two bounding dates. Returns null when the message
// does not match the expected rolling-rest-violation shape (e.g. a
// different kind of rejection) -- callers must fall back to showing the
// raw (humanized) message in that case, never fabricate an explanation.
export interface RollingRestConflictExplanation {
  windowStart: string;
  windowEnd: string;
  workingDays: string[];
}

export function explainRollingRestConflict(
  rawMessage: string,
  employeeId: string,
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): RollingRestConflictExplanation | null {
  const match = rawMessage.match(/between (\d{4}-\d{2}-\d{2}) and (\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const [, windowStart, windowEnd] = match;
  const workingDays: string[] = [];
  for (let d = windowStart; d <= windowEnd; d = addDays(d, 1)) {
    const resolved = resolveScheduleForDate(employeeId, d, datedAssignments, patterns, shiftPatterns);
    if (resolved === 'day' || resolved === 'night') workingDays.push(d);
  }
  return { windowStart, windowEnd, workingDays };
}

/** Every date in [dateFrom, dateTo] inclusive, as plain YYYY-MM-DD strings. */
export function expandDateRange(dateFrom: string, dateTo: string): string[] {
  const dates: string[] = [];
  for (let d = dateFrom; d <= dateTo; d = addDays(d, 1)) dates.push(d);
  return dates;
}

export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
