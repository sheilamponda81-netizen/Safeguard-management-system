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
  /** Stage C Step 14: the same window/working-days data, phrased in weekdays ("Saturday, 10 October") rather than raw ISO dates -- per the business requirement that an Admin-facing conflict explanation must speak in weekdays, with exact dates only as supporting detail. */
  windowStartLabel: string;
  windowEndLabel: string;
  workingDaysLabel: string;
  /** One ready-to-show sentence combining the above -- the preferred way for a handler to render this explanation. */
  summary: string;
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
  const windowStartLabel = formatFriendlyWeekdayDate(windowStart);
  const windowEndLabel = formatFriendlyWeekdayDate(windowEnd);
  const workingDaysLabel = workingDays.map((d) => WEEKDAY_LABELS[weekdayOf(d)]).join(', ');
  const summary = `This would leave no rest day between ${windowStartLabel} and ${windowEndLabel} -- every day in that span (${workingDaysLabel}) is a working day. Malawi's Employment Act requires at least 24 consecutive hours of rest after no more than six consecutive working days. Try a shorter change, a different pair of weekdays, or keep one of those days Off so at least one rest day remains in that span.`;
  return { windowStart, windowEnd, workingDays, windowStartLabel, windowEndLabel, workingDaysLabel, summary };
}

/** Every date in [dateFrom, dateTo] inclusive, as plain YYYY-MM-DD strings. */
export function expandDateRange(dateFrom: string, dateTo: string): string[] {
  const dates: string[] = [];
  for (let d = dateFrom; d <= dateTo; d = addDays(d, 1)) dates.push(d);
  return dates;
}

export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** "Friday, 16 October" -- the one friendly date format the Reschedule tab uses when naming a specific Off day to the administrator, never a raw YYYY-MM-DD string. */
export function formatFriendlyWeekdayDate(date: string): string {
  const { m, d } = parseIsoDate(date);
  return `${WEEKDAY_LABELS[weekdayOf(date)]}, ${d} ${MONTH_LABELS[m - 1]}`;
}

// Stage C Step 12E: "the administrator should not have to know or guess
// the employee's current Off weekday." Investigating a real STAGING
// usability report (Reschedule defaulted to Wednesday while the
// Calendar correctly showed Friday as Off for the selected week) found
// NO resolver bug -- roster_resolve_schedule/resolveScheduleForDate
// already correctly returns 'off' for Friday that week (a genuine,
// deliberate dated exception overrides the employee's Wednesday
// recurring pattern for that one week) and 'day' for Wednesday (the
// matching dated exception that converts it). The Calendar tab was
// already showing this correctly, because it already calls
// resolveScheduleForDate for every visible day. The bug was that the
// Reschedule tab's old auto-detect effect asked "what is this
// employee's recurring pattern AS OF TODAY" (resolveActiveOffWeekday
// with today as the date) instead of "what does this employee's
// schedule actually resolve to IN THE SELECTED WEEK" -- an entirely
// different question whose answer happened to differ here specifically
// because of the dated exception. This function answers the right
// question: it resolves all seven days of the given week with the
// SAME resolver the Calendar uses, and reports which date(s) actually
// come out 'off' -- the recurring-pattern lookup is kept too, but only
// as a separate, clearly labeled fact for display, never as the
// thing auto-selected.
export interface WeekOffDayInfo {
  date: string;
  weekdayJs: number;
  /** 'dated_exception' when an active dated assignment on this exact date is what makes it resolve 'off' (whether or not that exception's weekday also matches the recurring pattern); 'recurring' when no dated assignment exists for the date and the recurring Off-day pattern is what makes it 'off'. */
  source: 'recurring' | 'dated_exception';
}

export interface WeekScheduleSummary {
  weekStart: string;
  weekEnd: string;
  /** Every date in [weekStart, weekStart+6] that actually resolves 'off', in calendar order -- never more than 7, and (per confirmed policy) never invented when empty. */
  actualOffDays: WeekOffDayInfo[];
  /** The employee's recurring Off weekday as of this week's Monday, or null if none is configured -- shown separately from actualOffDays, never conflated with it. */
  recurringOffWeekday: number | null;
}

export function summarizeWeekSchedule(
  employeeId: string,
  weekStart: string,
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): WeekScheduleSummary {
  const weekEnd = addDays(weekStart, 6);
  const recurringOffWeekday = resolveActiveOffWeekday(employeeId, weekStart, patterns);
  const actualOffDays: WeekOffDayInfo[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const resolved = resolveScheduleForDate(employeeId, date, datedAssignments, patterns, shiftPatterns);
    if (resolved !== 'off') continue;
    const hasDatedException = datedAssignments.some((a) => a.employeeId === employeeId && a.assignmentDate === date && a.isActive);
    actualOffDays.push({ date, weekdayJs: weekdayOf(date), source: hasDatedException ? 'dated_exception' : 'recurring' });
  }
  return { weekStart, weekEnd, actualOffDays, recurringOffWeekday };
}

/** Plain-language, SQL-free description of a week's actual Off day(s) -- `secondary` is the separate "Normal weekly Off: ..." fact (requirement: display it separately, never folded silently into the primary sentence), appended with the exception explanation only when the two genuinely differ. Either field may be null/empty exactly when there is nothing true to say (no recurring pattern configured; or, for `primary`, never -- it always states the real situation, including the no-Off-day case, rather than inventing one). */
export interface WeekOffDaySummaryText {
  primary: string;
  secondary: string | null;
}

export function describeWeekOffDays(employeeName: string, summary: WeekScheduleSummary): WeekOffDaySummaryText {
  const { actualOffDays, recurringOffWeekday } = summary;
  const secondaryBase = recurringOffWeekday !== null ? `Normal weekly Off: ${WEEKDAY_LABELS[recurringOffWeekday]}.` : null;

  if (actualOffDays.length === 0) {
    return { primary: `${employeeName} has no Off day scheduled this week.`, secondary: secondaryBase };
  }
  if (actualOffDays.length > 1) {
    return {
      primary: `${employeeName} has ${actualOffDays.length} Off days this week -- choose which one to reschedule.`,
      secondary: secondaryBase,
    };
  }

  const off = actualOffDays[0];
  const primary = `${employeeName}'s Off day this week is ${formatFriendlyWeekdayDate(off.date)}.`;
  let secondary = secondaryBase;
  if (secondary && off.source === 'dated_exception' && recurringOffWeekday !== off.weekdayJs) {
    secondary += ` This week's Off: ${WEEKDAY_LABELS[off.weekdayJs]} because of a schedule exception.`;
  }
  return { primary, secondary };
}

// Stage C Step 13: "Correct or Cancel Special Roster Assignments."
// Generalizes the Step 12E week-summary idea (show the ACTUAL resolved
// schedule, distinguished from its source) to an arbitrary date range
// and every resolved value, not only 'off' -- what the Correct Special
// Assignment workflow needs to show a before/after preview for
// cancelling a mistaken dated exception (Day, Night, or Off) and
// revealing whatever the employee's underlying recurring pattern says
// instead, never forcing a specific value onto it.
export interface DateAssignmentStatus {
  date: string;
  weekdayJs: number;
  /** What this date currently resolves to -- identical to what the Calendar tab shows. */
  resolved: ResolvedSchedule;
  /** True when an active dated row exists for this exact date -- the only thing roster_cancel_date_assignments will ever touch; false means this date's value comes directly from the recurring pattern (or is unassigned) and is therefore protected -- changing it requires Temporary/Permanent Off Day or Recurring Schedule instead. */
  hasDatedException: boolean;
  /** What this date would resolve to with no dated exception in effect at all -- i.e. the "after" value a cancellation would reveal. Equal to `resolved` whenever hasDatedException is false. */
  underlyingResolved: ResolvedSchedule;
}

export function summarizeDateRangeAssignments(
  employeeId: string,
  dateFrom: string,
  dateTo: string,
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): DateAssignmentStatus[] {
  return expandDateRange(dateFrom, dateTo).map((date) => {
    const resolved = resolveScheduleForDate(employeeId, date, datedAssignments, patterns, shiftPatterns);
    const hasDatedException = datedAssignments.some((a) => a.employeeId === employeeId && a.assignmentDate === date && a.isActive);
    const underlyingResolved = hasDatedException
      ? resolveScheduleForDate(employeeId, date, [], patterns, shiftPatterns)
      : resolved;
    return { date, weekdayJs: weekdayOf(date), resolved, hasDatedException, underlyingResolved };
  });
}

// ============================================================
// Stage C Step 14: "Complete Roster Scheduling Alignment."
// Real STAGING finding (LUCIOUS LIGOMERA, SFG-S-469): cancelling a
// mistaken special Off across Thu-Sat was correctly REJECTED by
// roster_cancel_date_assignments -- it is a genuine Malawi Employment
// Act s.36(4) rest conflict (revealing Day on all three dates leaves a
// 7-day window, Sat-Fri, with no rest day at all), not a resolver bug.
// The gap is UX, not validation: the Correct/Cancel tab had no
// proactive, weekday-phrased warning and no safe-alternative
// suggestion before submitting, unlike the Temporary/Permanent Off Day
// tab's bridge-day handling. This is an ADVISORY, read-only mirror of
// the server's own two checks (Night-to-Day adjacency + rolling
// seven-day rest, exactly as roster_cancel_date_assignments's Pass 2
// re-resolves them) -- it never grants an override; a conflict it
// finds safe is still independently re-validated and enforced by the
// database on submit, and a conflict it flags can only be resolved by
// cancelling fewer dates (or leaving more untouched), never bypassed.
// ============================================================

export interface CancellationSafetyResult {
  safe: boolean;
  /** Dates (within the requested range) whose cancellation would create a Night-to-Day adjacency conflict. */
  adjacencyConflictDates: string[];
  /** Rolling seven-day rest windows that would have no Off day at all if every date in the requested range were cancelled. This is the STATUTORY rest check (Malawi Employment Act s.36(4)) -- a rolling window, never aligned to calendar-week boundaries. */
  restViolations: RollingRestWindowResult[];
  /** The largest safe alternative obtained by cancelling only a leading sub-range (dateFrom through some earlier end date) -- null when none exists or the full range is already safe. */
  safePrefixRange: { dateFrom: string; dateTo: string } | null;
  /** The largest safe alternative obtained by cancelling only a trailing sub-range (some later start date through dateTo) -- null when none exists or the full range is already safe. */
  safeSuffixRange: { dateFrom: string; dateTo: string } | null;
}

/**
 * Advisory preview of whether cancelling every active dated exception
 * for employeeId across [dateFrom, dateTo] would be safe -- mirrors
 * roster_cancel_date_assignments's own Pass 2 exactly (resolve each
 * touched date against the simulated post-cancellation state, then
 * check Night-to-Day adjacency and the rolling seven-day rest rule),
 * so the UI can warn BEFORE submitting instead of only after a server
 * rejection. When unsafe, also searches for the largest safe leading
 * or trailing sub-range of the SAME requested dates, so the Admin can
 * be offered a concrete, safe alternative in weekday language rather
 * than a dead end.
 */
export function evaluateCancellationSafety(
  employeeId: string,
  dateFrom: string,
  dateTo: string,
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): CancellationSafetyResult {
  const check = (cancelFrom: string, cancelTo: string): { safe: boolean; adjacencyConflictDates: string[]; restViolations: RollingRestWindowResult[] } => {
    const touchedDates = expandDateRange(cancelFrom, cancelTo).filter((d) =>
      datedAssignments.some((a) => a.employeeId === employeeId && a.assignmentDate === d && a.isActive)
    );
    if (touchedDates.length === 0) return { safe: true, adjacencyConflictDates: [], restViolations: [] };

    const simulated = datedAssignments.filter(
      (a) => !(a.employeeId === employeeId && a.isActive && touchedDates.includes(a.assignmentDate))
    );

    const adjacencyConflictDates: string[] = [];
    const restViolationKeys = new Set<string>();
    const restViolations: RollingRestWindowResult[] = [];
    for (const date of touchedDates) {
      const resolved = resolveScheduleForDate(employeeId, date, simulated, patterns, shiftPatterns);
      if (resolved === 'day' && resolveScheduleForDate(employeeId, addDays(date, -1), simulated, patterns, shiftPatterns) === 'night') {
        adjacencyConflictDates.push(date);
      } else if (resolved === 'night' && resolveScheduleForDate(employeeId, addDays(date, 1), simulated, patterns, shiftPatterns) === 'day') {
        adjacencyConflictDates.push(date);
      }
      for (const violation of findConfirmedRollingRestViolations(employeeId, date, simulated, patterns, shiftPatterns)) {
        const key = `${violation.windowStart}:${violation.windowEnd}`;
        if (!restViolationKeys.has(key)) {
          restViolationKeys.add(key);
          restViolations.push(violation);
        }
      }
    }
    return { safe: adjacencyConflictDates.length === 0 && restViolations.length === 0, adjacencyConflictDates, restViolations };
  };

  const full = check(dateFrom, dateTo);
  if (full.safe) {
    return { ...full, safePrefixRange: null, safeSuffixRange: null };
  }

  let safePrefixRange: { dateFrom: string; dateTo: string } | null = null;
  for (let end = addDays(dateTo, -1); end >= dateFrom; end = addDays(end, -1)) {
    if (check(dateFrom, end).safe) {
      safePrefixRange = { dateFrom, dateTo: end };
      break;
    }
  }

  let safeSuffixRange: { dateFrom: string; dateTo: string } | null = null;
  for (let start = addDays(dateFrom, 1); start <= dateTo; start = addDays(start, 1)) {
    if (check(start, dateTo).safe) {
      safeSuffixRange = { dateFrom: start, dateTo };
      break;
    }
  }

  return { ...full, safePrefixRange, safeSuffixRange };
}

export interface CancellationSafetyDescription {
  /** The conflict explanation, in weekdays, with exact dates as supporting detail -- never a raw technical message. */
  primary: string;
  /** A concrete, safe alternative the Admin can take instead, or null when evaluateCancellationSafety found none. Never an override of the conflict -- only a smaller/different selection that the server will independently re-validate and accept. */
  suggestion: string | null;
}

/** Turns a CancellationSafetyResult into the plain-weekday explanation + safe-alternative text the Correct/Cancel tab shows before submitting. Returns null when safety.safe is true (nothing to explain). */
export function describeCancellationSafety(employeeName: string, safety: CancellationSafetyResult): CancellationSafetyDescription | null {
  if (safety.safe) return null;

  const sentences: string[] = [];
  if (safety.restViolations.length > 0) {
    const v = safety.restViolations[0];
    const windowDays: string[] = [];
    for (let d = v.windowStart; d <= v.windowEnd; d = addDays(d, 1)) windowDays.push(WEEKDAY_LABELS[weekdayOf(d)]);
    sentences.push(
      `Cancelling all of these would leave ${employeeName} with no rest day between ${formatFriendlyWeekdayDate(v.windowStart)} and ${formatFriendlyWeekdayDate(v.windowEnd)} -- every day in that span (${windowDays.join(', ')}) would be a working day, which exceeds the maximum six consecutive working days before 24 hours of rest is required (Malawi Employment Act s.36(4)).`
    );
  }
  if (safety.adjacencyConflictDates.length > 0) {
    const dayLabels = safety.adjacencyConflictDates.map((d) => formatFriendlyWeekdayDate(d)).join(', ');
    sentences.push(`Cancelling ${dayLabels} would also put ${employeeName} on a Day shift immediately after, or a Night shift immediately before, another working day with no break between them.`);
  }

  let suggestion: string | null = null;
  if (safety.safeSuffixRange) {
    suggestion = `Safe alternative: keep ${formatFriendlyWeekdayDate(addDays(safety.safeSuffixRange.dateFrom, -1))} Off, and cancel only from ${formatFriendlyWeekdayDate(safety.safeSuffixRange.dateFrom)} to ${formatFriendlyWeekdayDate(safety.safeSuffixRange.dateTo)}.`;
  } else if (safety.safePrefixRange) {
    suggestion = `Safe alternative: cancel only from ${formatFriendlyWeekdayDate(safety.safePrefixRange.dateFrom)} to ${formatFriendlyWeekdayDate(safety.safePrefixRange.dateTo)}, and keep ${formatFriendlyWeekdayDate(addDays(safety.safePrefixRange.dateTo, 1))} Off.`;
  } else {
    suggestion = `No sub-range of these exact dates is safe to cancel together. Try a narrower or different range, or use the Temporary / Permanent Off Day tool to plan a compliant change.`;
  }

  return { primary: sentences.join(' '), suggestion };
}
