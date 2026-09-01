import { describe, it, expect } from 'vitest';
import {
  getPreviousMonth,
  getNextMonth,
  getAvailableMonthsFromSystem,
  getSystemStartDate,
} from './currentMonth';

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
