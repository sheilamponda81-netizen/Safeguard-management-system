import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getPreviousMonth,
  getNextMonth,
  getAvailableMonthsFromSystem,
  getSystemStartDate,
  getChartMonths,
  getActualCurrentMonth,
} from './currentMonth';

// Local helper mirroring the file's own "YYYY-MM" key format, driven off
// getSystemStartDate() rather than a hardcoded string -- these tests must
// stay correct regardless of what the actual system start month is.
function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
function addMonths(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + n, 1);
}

// These cover the actual month-navigation requirements from the historical-
// navigation feature request: previous/next month math (including year
// boundaries), and that the available-months list -- which every month-
// based page's dropdown/arrow-disabling logic is gated on -- includes
// historical months, not just the current month forward. Before the fix,
// getAvailableMonthsFromSystem only ever generated the forward-looking
// window, which made the left/previous arrow permanently disabled on
// every page the moment the current month was reached, and the dropdown
// never listed anything earlier -- exactly the "historical months are
// inconvenient or unavailable" complaint this feature fixes.

describe('getPreviousMonth / getNextMonth', () => {
  it('moves back one month within the same year', () => {
    expect(getPreviousMonth('2026-09')).toBe('2026-08');
  });

  it('moves forward one month within the same year', () => {
    expect(getNextMonth('2026-08')).toBe('2026-09');
  });

  it('crosses the previous-year boundary: January -> previous -> December of the prior year', () => {
    expect(getPreviousMonth('2027-01')).toBe('2026-12');
  });

  it('crosses the next-year boundary: December -> next -> January of the following year', () => {
    expect(getNextMonth('2026-12')).toBe('2027-01');
  });

  it('does not let getPreviousMonth go before the system start date', () => {
    const start = getSystemStartDate();
    const startKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    expect(getPreviousMonth(startKey)).toBe(startKey);
  });
});

describe('getAvailableMonthsFromSystem', () => {
  it('includes months before the current/system month (historical months are selectable)', () => {
    const months = getAvailableMonthsFromSystem('2026-09');
    expect(months).toContain('2026-08');
    expect(months).toContain('2026-07');
  });

  it('includes the current/system month itself', () => {
    const months = getAvailableMonthsFromSystem('2026-09');
    expect(months).toContain('2026-09');
  });

  it('includes future months (forward navigation still works)', () => {
    const months = getAvailableMonthsFromSystem('2026-09');
    expect(months).toContain('2026-10');
    expect(months).toContain('2027-09');
  });

  it('never includes a month before the system start date, even historically', () => {
    const start = getSystemStartDate();
    const beforeStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
    const beforeStartKey = `${beforeStart.getFullYear()}-${String(beforeStart.getMonth() + 1).padStart(2, '0')}`;
    const months = getAvailableMonthsFromSystem('2026-09');
    expect(months).not.toContain(beforeStartKey);
    expect(months).not.toContain('2025-12');
  });

  it('returns months in ascending chronological order end to end', () => {
    const months = getAvailableMonthsFromSystem('2026-09');
    const sorted = [...months].sort();
    expect(months).toEqual(sorted);
  });

  it('does not contain duplicate months at the historical/forward-window seam', () => {
    const months = getAvailableMonthsFromSystem('2026-09');
    expect(new Set(months).size).toBe(months.length);
  });

  it('grows the historical range as the system month advances, without shrinking the forward window', () => {
    const early = getAvailableMonthsFromSystem('2026-08');
    const later = getAvailableMonthsFromSystem('2026-10');
    // Every month reachable before is still reachable after -- purely
    // additive, never a regression for any other page using this list.
    early.forEach(m => expect(later).toContain(m));
    // The forward-looking window keeps the same 48-month depth relative
    // to whatever the current/system month is.
    expect(later).toContain('2030-09');
  });

  it('at the system start date itself, has no historical months but still has the current month and a forward window', () => {
    const start = getSystemStartDate();
    const startKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    const months = getAvailableMonthsFromSystem(startKey);
    expect(months[0]).toBe(startKey);
    expect(months).toContain(startKey);
    expect(months.length).toBe(48);
  });
});

// Regression coverage for the real staging bug (both the Monthly Payroll
// Trend and Employee Growth Dashboard charts showed all 6 points labeled
// with the system start month and a flat/repeated line): the old
// implementation, on hitting the FIRST out-of-range month in its i=5..0
// loop, filled every remaining slot with a single hardcoded placeholder
// and broke out of the loop entirely -- discarding even the later,
// perfectly valid iterations (including the current month itself). See
// getChartMonths()'s own header comment in currentMonth.ts for the full
// trace.
describe('getChartMonths', () => {
  it('at the system start month itself, returns exactly ONE month -- never 6 duplicates of it', () => {
    const start = getSystemStartDate();
    const startKey = monthKey(start);
    const months = getChartMonths(startKey);
    expect(months).toEqual([startKey]);
  });

  it('one real month after start, returns exactly those TWO distinct real months, in order -- not 6 copies of the start month', () => {
    const start = getSystemStartDate();
    const startKey = monthKey(start);
    const nextKey = monthKey(addMonths(start, 1));
    const months = getChartMonths(nextKey);
    expect(months).toEqual([startKey, nextKey]);
    expect(new Set(months).size).toBe(2);
  });

  it('every returned month is unique -- no repeated/duplicated month key under any input', () => {
    const start = getSystemStartDate();
    for (let i = 0; i <= 8; i++) {
      const key = monthKey(addMonths(start, i));
      const months = getChartMonths(key);
      expect(new Set(months).size).toBe(months.length);
    }
  });

  it('the LAST entry is always exactly the requested (or current) month', () => {
    const start = getSystemStartDate();
    const key = monthKey(addMonths(start, 3));
    const months = getChartMonths(key);
    expect(months[months.length - 1]).toBe(key);
  });

  it('once the system has existed 6+ months, returns exactly 6 consecutive real months ending at the requested month', () => {
    const start = getSystemStartDate();
    const key = monthKey(addMonths(start, 7)); // 8 real months have now passed (0..7)
    const months = getChartMonths(key);
    expect(months).toHaveLength(6);
    const expected = [2, 3, 4, 5, 6, 7].map(i => monthKey(addMonths(start, i)));
    expect(months).toEqual(expected);
  });

  it('never returns a month before the actual system start, even when fewer than 6 real months exist', () => {
    const start = getSystemStartDate();
    const startKey = monthKey(start);
    const months = getChartMonths(monthKey(addMonths(start, 2)));
    months.forEach(m => expect(m >= startKey).toBe(true));
  });

  it('returns months in ascending chronological order', () => {
    const start = getSystemStartDate();
    const months = getChartMonths(monthKey(addMonths(start, 9)));
    expect(months).toEqual([...months].sort());
  });
});

// Safeguard Stage C -- Monthly Register current-month bug: with
// current_payroll_month (the admin-advanced payroll-processing cursor)
// left at its default of 2026-07, Attendance.tsx treated July 2026 as
// "current" well into October, silently saving a manual edit against
// 1 July instead of the real date. getActualCurrentMonth() must track the
// real Africa/Blantyre calendar month instead, completely independent of
// that setting -- these tests pin the system clock rather than reading
// current_payroll_month at all.
describe('getActualCurrentMonth: real Africa/Blantyre calendar month, independent of current_payroll_month', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches today in UTC when well clear of a day boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
    expect(getActualCurrentMonth()).toBe('2026-10');
  });

  it('rolls over to the next calendar month at the Blantyre (UTC+2) day boundary, not the UTC one', () => {
    vi.useFakeTimers();
    // 2026-07-31T23:00:00Z is 2026-08-01T01:00 in Blantyre (UTC+2) --
    // already August locally even though it's still July in UTC.
    vi.setSystemTime(new Date('2026-07-31T23:00:00.000Z'));
    expect(getActualCurrentMonth()).toBe('2026-08');
  });

  it('does not fall back to July 2026 once the real date has moved well past it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-25T10:00:00.000Z'));
    expect(getActualCurrentMonth()).not.toBe('2026-07');
    expect(getActualCurrentMonth()).toBe('2026-12');
  });
});
