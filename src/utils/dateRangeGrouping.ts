// HikCentral Import redesign -- Coverage tab: groups a scope's missing
// coverage dates (already computed by hikcentral_coverage_timeline, see
// attendanceImportAutoApplyService.ts's CoverageTimelineEntry) into
// contiguous calendar-date ranges for a compact "expandable missing
// intervals" display, instead of listing every date individually. Pure
// and side-effect free -- does not fetch, infer, or acknowledge anything.

export interface DateRange {
  start: string;
  end: string;
}

/** True when `nextStr` (YYYY-MM-DD) is the calendar day immediately after `dateStr` (YYYY-MM-DD), both treated as plain dates with no timezone involved. */
function isNextCalendarDay(dateStr: string, nextStr: string): boolean {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10) === nextStr;
}

/**
 * Groups possibly-unsorted, possibly-duplicated YYYY-MM-DD date strings
 * into the fewest contiguous [start, end] ranges, sorted ascending. A
 * single isolated date becomes a range where start === end.
 */
export function groupConsecutiveDates(dates: string[]): DateRange[] {
  const sorted = Array.from(new Set(dates)).sort();
  const ranges: DateRange[] = [];
  for (const date of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && isNextCalendarDay(last.end, date)) {
      last.end = date;
    } else {
      ranges.push({ start: date, end: date });
    }
  }
  return ranges;
}

/** Formats a DateRange for display: a single date as-is, a span as "start – end". */
export function formatDateRange(range: DateRange): string {
  return range.start === range.end ? range.start : `${range.start} – ${range.end}`;
}
