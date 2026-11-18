import { describe, it, expect } from 'vitest';
import { groupConsecutiveDates, formatDateRange } from './dateRangeGrouping';

describe('groupConsecutiveDates', () => {
  it('groups a run of consecutive dates into a single range', () => {
    expect(groupConsecutiveDates(['2026-10-05', '2026-10-06', '2026-10-07'])).toEqual([
      { start: '2026-10-05', end: '2026-10-07' },
    ]);
  });

  it('keeps non-consecutive dates as separate single-day ranges', () => {
    expect(groupConsecutiveDates(['2026-10-01', '2026-10-05'])).toEqual([
      { start: '2026-10-01', end: '2026-10-01' },
      { start: '2026-10-05', end: '2026-10-05' },
    ]);
  });

  it('sorts unsorted input before grouping', () => {
    expect(groupConsecutiveDates(['2026-10-07', '2026-10-05', '2026-10-06'])).toEqual([
      { start: '2026-10-05', end: '2026-10-07' },
    ]);
  });

  it('de-duplicates repeated dates', () => {
    expect(groupConsecutiveDates(['2026-10-05', '2026-10-05', '2026-10-06'])).toEqual([
      { start: '2026-10-05', end: '2026-10-06' },
    ]);
  });

  it('handles an empty list', () => {
    expect(groupConsecutiveDates([])).toEqual([]);
  });

  it('correctly spans a month boundary', () => {
    expect(groupConsecutiveDates(['2026-10-30', '2026-10-31', '2026-11-01'])).toEqual([
      { start: '2026-10-30', end: '2026-11-01' },
    ]);
  });

  it('correctly spans a leap-day boundary', () => {
    expect(groupConsecutiveDates(['2028-02-28', '2028-02-29', '2028-03-01'])).toEqual([
      { start: '2028-02-28', end: '2028-03-01' },
    ]);
  });

  it('mixes contiguous runs and isolated dates in one call', () => {
    expect(groupConsecutiveDates(['2026-10-01', '2026-10-02', '2026-10-10', '2026-10-15', '2026-10-16', '2026-10-17'])).toEqual([
      { start: '2026-10-01', end: '2026-10-02' },
      { start: '2026-10-10', end: '2026-10-10' },
      { start: '2026-10-15', end: '2026-10-17' },
    ]);
  });
});

describe('formatDateRange', () => {
  it('formats a single-day range as just that date', () => {
    expect(formatDateRange({ start: '2026-10-05', end: '2026-10-05' })).toBe('2026-10-05');
  });

  it('formats a multi-day range as "start – end"', () => {
    expect(formatDateRange({ start: '2026-10-05', end: '2026-10-07' })).toBe('2026-10-05 – 2026-10-07');
  });
});
