import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getBlantyreToday,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  shiftMonthStart,
  dateRangeLengthDays,
  shiftCalendarRange,
  formatDayHeading,
  formatPeriodHeading,
  isValidDateRange,
  MAX_CUSTOM_RANGE_DAYS,
} from './rosterCalendarNav';

afterEach(() => {
  vi.useRealTimers();
});

describe('getBlantyreToday (Africa/Blantyre "today", never host-local or raw UTC)', () => {
  it('matches the UTC date when well inside the Blantyre day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T12:00:00.000Z'));
    expect(getBlantyreToday()).toBe('2026-10-07');
  });

  it('rolls over to the next Blantyre day before UTC midnight -- the exact off-by-one this module exists to avoid (22:00 UTC = 00:00 Blantyre next day)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T22:30:00.000Z'));
    expect(getBlantyreToday()).toBe('2026-10-08');
  });

  it('does not roll over just before the Blantyre day boundary (21:59 UTC is still 23:59 the same Blantyre day)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T21:59:00.000Z'));
    expect(getBlantyreToday()).toBe('2026-10-07');
  });

  it('crosses a year boundary correctly (2025-12-31T23:00:00Z is 2026-01-01 in Blantyre)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-12-31T23:00:00.000Z'));
    expect(getBlantyreToday()).toBe('2026-01-01');
  });
});

describe('startOfWeek / endOfWeek (Monday-Sunday week, per confirmed policy)', () => {
  it('a Wednesday resolves to that week\'s Monday and Sunday', () => {
    // 2026-10-07 is a Wednesday.
    expect(startOfWeek('2026-10-07')).toBe('2026-10-05');
    expect(endOfWeek('2026-10-07')).toBe('2026-10-11');
  });

  it('a Monday is its own week start', () => {
    expect(startOfWeek('2026-10-05')).toBe('2026-10-05');
  });

  it('a Sunday is its own week end, and its week start is the preceding Monday', () => {
    expect(endOfWeek('2026-10-11')).toBe('2026-10-11');
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05');
  });

  it('a week spanning a month boundary resolves correctly', () => {
    // 2026-11-01 is a Sunday; its week starts 2026-10-26.
    expect(startOfWeek('2026-11-01')).toBe('2026-10-26');
    expect(endOfWeek('2026-10-26')).toBe('2026-11-01');
  });
});

describe('startOfMonth / endOfMonth (including leap-year February)', () => {
  it('resolves a mid-month date to its month bounds', () => {
    expect(startOfMonth('2026-10-15')).toBe('2026-10-01');
    expect(endOfMonth('2026-10-15')).toBe('2026-10-31');
  });

  it('handles a 30-day month', () => {
    expect(endOfMonth('2026-11-10')).toBe('2026-11-30');
  });

  it('handles February in a non-leap year (2026 is not a leap year)', () => {
    expect(endOfMonth('2026-02-01')).toBe('2026-02-28');
  });

  it('handles February in a leap year (2024 is a leap year)', () => {
    expect(endOfMonth('2024-02-01')).toBe('2024-02-29');
  });

  it('handles February in a century leap year (2000 was a leap year) and a century non-leap year (2100 will not be)', () => {
    expect(endOfMonth('2000-02-01')).toBe('2000-02-29');
    expect(endOfMonth('2100-02-01')).toBe('2100-02-28');
  });

  it('handles December correctly (month-end does not roll into next year)', () => {
    expect(endOfMonth('2026-12-05')).toBe('2026-12-31');
  });
});

describe('shiftMonthStart (month/year navigation, including crossing a year boundary)', () => {
  it('moves forward one month within the same year', () => {
    expect(shiftMonthStart('2026-10-01', 1)).toBe('2026-11-01');
  });

  it('moves backward one month within the same year', () => {
    expect(shiftMonthStart('2026-10-01', -1)).toBe('2026-09-01');
  });

  it('crosses forward into the next year (December -> January)', () => {
    expect(shiftMonthStart('2026-12-01', 1)).toBe('2027-01-01');
  });

  it('crosses backward into the previous year (January -> December)', () => {
    expect(shiftMonthStart('2026-01-01', -1)).toBe('2025-12-01');
  });

  it('supports multi-month jumps spanning more than one year', () => {
    expect(shiftMonthStart('2026-06-01', 13)).toBe('2027-07-01');
    expect(shiftMonthStart('2026-06-01', -13)).toBe('2025-05-01');
  });
});

describe('shiftCalendarRange (Previous/Next for each view mode)', () => {
  it('week mode shifts both endpoints by 7 days', () => {
    expect(shiftCalendarRange('2026-10-05', '2026-10-11', 'week', 1)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(shiftCalendarRange('2026-10-05', '2026-10-11', 'week', -1)).toEqual({ from: '2026-09-28', to: '2026-10-04' });
  });

  it('month mode recomputes the next month\'s own correct end date, not a fixed day-count shift (Oct 31 days -> Nov 30 days)', () => {
    expect(shiftCalendarRange('2026-10-01', '2026-10-31', 'month', 1)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('month mode crosses a year boundary correctly', () => {
    expect(shiftCalendarRange('2026-12-01', '2026-12-31', 'month', 1)).toEqual({ from: '2027-01-01', to: '2027-01-31' });
  });

  it('month mode lands correctly on a leap-year February', () => {
    expect(shiftCalendarRange('2024-01-01', '2024-01-31', 'month', 1)).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('custom mode shifts both endpoints by the range\'s own length, preserving an arbitrary span (10 days here, not snapped to a week or month)', () => {
    expect(shiftCalendarRange('2026-10-01', '2026-10-10', 'custom', 1)).toEqual({ from: '2026-10-11', to: '2026-10-20' });
    expect(shiftCalendarRange('2026-10-01', '2026-10-10', 'custom', -1)).toEqual({ from: '2026-09-21', to: '2026-09-30' });
  });

  it('custom mode works for a single-day range', () => {
    expect(shiftCalendarRange('2026-10-01', '2026-10-01', 'custom', 1)).toEqual({ from: '2026-10-02', to: '2026-10-02' });
  });
});

describe('formatDayHeading (replaces the ambiguous raw "MM-DD" slice)', () => {
  it('formats a known date as "Thu 08 Oct"', () => {
    // 2026-10-08 is a Thursday.
    expect(formatDayHeading('2026-10-08')).toBe('Thu 08 Oct');
  });

  it('zero-pads a single-digit day', () => {
    expect(formatDayHeading('2026-10-01')).toBe('Thu 01 Oct');
  });

  it('never produces the old ambiguous "10-08" form', () => {
    expect(formatDayHeading('2026-10-08')).not.toMatch(/^\d{2}-\d{2}$/);
  });
});

describe('formatPeriodHeading (always includes the year)', () => {
  it('month view shows the full month name and year', () => {
    expect(formatPeriodHeading('month', '2026-10-01', '2026-10-31')).toBe('October 2026');
  });

  it('week view within a single month shows a compact day range with one month/year', () => {
    expect(formatPeriodHeading('week', '2026-10-05', '2026-10-11')).toBe('5 -- 11 Oct 2026');
  });

  it('a range spanning two months in the same year names both months once each, with the year once', () => {
    expect(formatPeriodHeading('custom', '2026-10-29', '2026-11-04')).toBe('29 Oct -- 4 Nov 2026');
  });

  it('a range spanning two different years names both years', () => {
    expect(formatPeriodHeading('custom', '2026-12-29', '2027-01-04')).toBe('29 Dec 2026 -- 4 Jan 2027');
  });
});

describe('dateRangeLengthDays (used to bound custom-range rendering without allocating the full date array)', () => {
  it('a single day is length 1', () => {
    expect(dateRangeLengthDays('2026-10-01', '2026-10-01')).toBe(1);
  });

  it('a week (Monday through Sunday) is length 7', () => {
    expect(dateRangeLengthDays('2026-10-05', '2026-10-11')).toBe(7);
  });

  it('spans a month boundary correctly', () => {
    expect(dateRangeLengthDays('2026-10-25', '2026-11-05')).toBe(12);
  });

  it('spans a leap-year February correctly (29 days counted, not 28)', () => {
    expect(dateRangeLengthDays('2024-02-01', '2024-02-29')).toBe(29);
  });

  it('matches expandDateRange\'s own count for a representative range', () => {
    expect(dateRangeLengthDays('2026-10-01', '2026-10-31')).toBe(31);
  });
});

describe('isValidDateRange', () => {
  it('accepts a normal forward range', () => {
    expect(isValidDateRange('2026-10-01', '2026-10-07')).toBe(true);
  });

  it('accepts a single-day range (from === to)', () => {
    expect(isValidDateRange('2026-10-01', '2026-10-01')).toBe(true);
  });

  it('rejects an inverted range (to before from)', () => {
    expect(isValidDateRange('2026-10-07', '2026-10-01')).toBe(false);
  });
});

describe('MAX_CUSTOM_RANGE_DAYS', () => {
  it('is a sane positive bound comfortably larger than any single month', () => {
    expect(MAX_CUSTOM_RANGE_DAYS).toBeGreaterThan(31);
  });
});
