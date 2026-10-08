// Safeguard HikCentral Attendance MVP -- Phase 2B.2A: Roster Calendar
// Navigation. Pure, DB-free calendar-view math for the Roster Management
// Calendar tab -- Week/Month view boundaries, Previous/Next/Today
// navigation targets, and display formatting. Builds on
// rosterSchedule.ts's addDays()/weekdayOf() (plain UTC-anchored
// calendar-date arithmetic, never the host's local timezone) and reuses
// the already-established Africa/Blantyre conversion from
// hikcentralAttendancePreview.ts's blantyreDateKey() for "today", so this
// module never carries a second copy of the fixed UTC+02:00 offset.
//
// Like rosterSchedule.ts, every date here is a plain YYYY-MM-DD calendar
// string -- there is no concept of a timestamp or a schedule-resolution
// decision in this file. This module answers exactly one question: given
// a view mode and a currently-displayed range, what range should
// Previous/Next/Today/Week/Month show next -- and how should that range
// be labeled on screen. It never reads or writes roster data.
import { addDays, weekdayOf } from './rosterSchedule';
import { blantyreDateKey } from './hikcentralAttendancePreview';

export type CalendarViewMode = 'week' | 'month' | 'custom';

/** Today's Africa/Blantyre calendar date (YYYY-MM-DD) -- never the host machine's local date, never the raw UTC date. */
export function getBlantyreToday(): string {
  return blantyreDateKey(new Date().toISOString());
}

/** The Monday on or before `date` (Mon-Sun week, per confirmed policy). */
export function startOfWeek(date: string): string {
  const dow = weekdayOf(date); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  return addDays(date, -daysSinceMonday);
}

/** The Sunday ending the Mon-Sun week containing `date`. */
export function endOfWeek(date: string): string {
  return addDays(startOfWeek(date), 6);
}

/** The 1st of the calendar month containing `date`. */
export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/**
 * The last day of the calendar month containing `date`, correctly
 * handling every month length including February in a leap year --
 * computed via JS's own calendar-aware Date arithmetic (day 0 of the
 * FOLLOWING month is the last day of THIS month), never a hardcoded
 * days-per-month table that could get a leap year wrong.
 */
export function endOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${date.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * Shifts a month-start date (YYYY-MM-01) by a whole number of months,
 * correctly crossing year boundaries in either direction. Only ever
 * called with a normalized month-start anchor (day always '01'), so there
 * is no day-of-month clamping concern (unlike a general "add N months"
 * that must decide what Jan 31 + 1 month means).
 */
export function shiftMonthStart(monthStartDate: string, months: number): string {
  const [y, m] = monthStartDate.split('-').map(Number);
  const zeroBasedTotal = y * 12 + (m - 1) + months;
  const newYear = Math.floor(zeroBasedTotal / 12);
  const newMonth = ((zeroBasedTotal % 12) + 12) % 12;
  return `${newYear}-${String(newMonth + 1).padStart(2, '0')}-01`;
}

/**
 * The inclusive day count of [dateFrom, dateTo], computed arithmetically
 * (never by building the full date array) -- so checking whether a
 * caller-chosen custom range is too large to render stays O(1) instead of
 * allocating the very array the size check exists to avoid allocating.
 */
export function dateRangeLengthDays(dateFrom: string, dateTo: string): number {
  const [fy, fm, fd] = dateFrom.split('-').map(Number);
  const [ty, tm, td] = dateTo.split('-').map(Number);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / msPerDay) + 1;
}

/**
 * The next range Previous/Next should show, for whichever view mode is
 * currently active:
 *   - week: shift both endpoints by 7 days.
 *   - month: shift the month-start anchor by one whole month (handles
 *     every month-length change and year boundary correctly) and
 *     recompute the new month's own end date -- NOT a fixed day-count
 *     shift, which would misalign across months of different lengths.
 *   - custom: shift both endpoints by the CURRENT span's own length in
 *     days, so a user-chosen N-day range keeps navigating in N-day
 *     blocks, never snapping to a week or month.
 */
export function shiftCalendarRange(
  dateFrom: string,
  dateTo: string,
  viewMode: CalendarViewMode,
  direction: 1 | -1
): { from: string; to: string } {
  if (viewMode === 'week') {
    return { from: addDays(dateFrom, 7 * direction), to: addDays(dateTo, 7 * direction) };
  }
  if (viewMode === 'month') {
    const newStart = shiftMonthStart(dateFrom, direction);
    return { from: newStart, to: endOfMonth(newStart) };
  }
  const spanDays = dateRangeLengthDays(dateFrom, dateTo);
  const shiftAmount = spanDays * direction;
  return { from: addDays(dateFrom, shiftAmount), to: addDays(dateTo, shiftAmount) };
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** A single day-column heading, e.g. "Thu 08 Oct" -- never the ambiguous raw "10-08" slice this replaces. */
export function formatDayHeading(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${WEEKDAY_SHORT[weekdayOf(date)]} ${String(d).padStart(2, '0')} ${MONTH_SHORT[m - 1]}`;
}

/** The heading for the currently displayed period, always including the year, e.g. "October 2026" or "5 -- 11 Oct 2026". */
export function formatPeriodHeading(viewMode: CalendarViewMode, dateFrom: string, dateTo: string): string {
  const [fy, fm, fd] = dateFrom.split('-').map(Number);
  const [ty, tm, td] = dateTo.split('-').map(Number);

  if (viewMode === 'month') {
    return `${MONTH_FULL[fm - 1]} ${fy}`;
  }
  if (fy === ty && fm === tm) {
    return `${fd} -- ${td} ${MONTH_SHORT[fm - 1]} ${fy}`;
  }
  if (fy === ty) {
    return `${fd} ${MONTH_SHORT[fm - 1]} -- ${td} ${MONTH_SHORT[tm - 1]} ${fy}`;
  }
  return `${fd} ${MONTH_SHORT[fm - 1]} ${fy} -- ${td} ${MONTH_SHORT[tm - 1]} ${ty}`;
}

/** The only validity rule for an independently-editable From/To pair: the range must not be inverted. */
export function isValidDateRange(dateFrom: string, dateTo: string): boolean {
  return dateFrom <= dateTo;
}

/** Upper bound on a custom range's rendered day-columns -- Week (7) and Month (<=31) are always within this; only an unbounded custom range needs a guard against an unusably large employee-by-date grid. */
export const MAX_CUSTOM_RANGE_DAYS = 93;
