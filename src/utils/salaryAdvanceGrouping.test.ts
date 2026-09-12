import { describe, it, expect } from 'vitest';
import {
  getQualifyingEmployeeIds,
  summarizeAdvanceStatuses,
  getDominantStatusForColor,
  getSlotsAvailableLabel,
} from './salaryAdvanceGrouping';

// Regression coverage for the real staging UX request: the Salary
// Advances main list showed the same employee as two independent rows
// when they held two separate advances. These functions decide grouping
// visibility and truthful status labeling WITHOUT ever touching the
// underlying advance records or merging their financial history --
// getEmployeeAdvanceSummary() (SalaryAdvances.tsx) still does all real
// financial aggregation, computed from the FULL advances array, never a
// filtered one.
describe('getQualifyingEmployeeIds', () => {
  it('collapses two advances belonging to the same employee into ONE id', () => {
    const rows = [
      { employee_id: 'e1', status: 'active' },
      { employee_id: 'e1', status: 'pending' },
    ];
    expect(getQualifyingEmployeeIds(rows)).toEqual(['e1']);
  });

  it('preserves first-seen order across different employees', () => {
    const rows = [
      { employee_id: 'e2', status: 'active' },
      { employee_id: 'e1', status: 'pending' },
      { employee_id: 'e2', status: 'paid' },
    ];
    expect(getQualifyingEmployeeIds(rows)).toEqual(['e2', 'e1']);
  });

  it('empty input yields an empty list, not a fallback value', () => {
    expect(getQualifyingEmployeeIds([])).toEqual([]);
  });

  it('search/status filtering already narrows the input array upstream -- this only dedupes what remains, proving one employee never produces duplicate rows regardless of how many of their advances matched', () => {
    const rows = [
      { employee_id: 'e1', status: 'active' },
      { employee_id: 'e3', status: 'rejected' },
      { employee_id: 'e1', status: 'paid' },
      { employee_id: 'e1', status: 'cancelled' },
    ];
    const ids = getQualifyingEmployeeIds(rows);
    expect(ids).toEqual(['e1', 'e3']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('summarizeAdvanceStatuses', () => {
  it('one active + one pending: "Active + Pending", never silently just one', () => {
    expect(summarizeAdvanceStatuses(['active', 'pending'])).toBe('Active + Pending');
  });

  it('order is stable regardless of input order (active always listed before pending)', () => {
    expect(summarizeAdvanceStatuses(['pending', 'active'])).toBe('Active + Pending');
  });

  it('two active advances: "2 Active"', () => {
    expect(summarizeAdvanceStatuses(['active', 'active'])).toBe('2 Active');
  });

  it('a single active advance: "Active" (no "1 Active")', () => {
    expect(summarizeAdvanceStatuses(['active'])).toBe('Active');
  });

  it('a single pending advance: "Pending"', () => {
    expect(summarizeAdvanceStatuses(['pending'])).toBe('Pending');
  });

  it('two pending advances (the max both-slots-pending case): "2 Pending"', () => {
    expect(summarizeAdvanceStatuses(['pending', 'pending'])).toBe('2 Pending');
  });

  it('zero open advances, one paid: "Paid" -- falls back to the closed set truthfully, not "No Advances"', () => {
    expect(summarizeAdvanceStatuses(['paid'])).toBe('Paid');
  });

  it('zero open advances, only rejected: "Rejected"', () => {
    expect(summarizeAdvanceStatuses(['rejected'])).toBe('Rejected');
  });

  it('zero open advances, only cancelled: "Cancelled"', () => {
    expect(summarizeAdvanceStatuses(['cancelled'])).toBe('Cancelled');
  });

  it('mixed closed statuses with no open ones: combines truthfully too, same pattern as the open case', () => {
    expect(summarizeAdvanceStatuses(['paid', 'rejected'])).toBe('Paid + Rejected');
  });

  it('an OPEN advance always takes priority over closed history -- one active plus one already-paid advance reads "Active", not a mix with Paid', () => {
    expect(summarizeAdvanceStatuses(['active', 'paid'])).toBe('Active');
  });

  it('empty input: "No Advances" fallback, never a blank label', () => {
    expect(summarizeAdvanceStatuses([])).toBe('No Advances');
  });
});

describe('getDominantStatusForColor', () => {
  it('pending takes priority for color purposes even alongside active', () => {
    expect(getDominantStatusForColor(['active', 'pending'])).toBe('pending');
  });

  it('active takes priority over closed statuses', () => {
    expect(getDominantStatusForColor(['active', 'paid'])).toBe('active');
  });

  it('falls through to paid/rejected/cancelled priority once nothing is open', () => {
    expect(getDominantStatusForColor(['rejected', 'paid'])).toBe('paid');
    expect(getDominantStatusForColor(['cancelled', 'rejected'])).toBe('rejected');
    expect(getDominantStatusForColor(['cancelled'])).toBe('cancelled');
  });
});

describe('getSlotsAvailableLabel', () => {
  it('2/2 (both slots occupied): "No slots available"', () => {
    expect(getSlotsAvailableLabel(2, 2)).toBe('No slots available');
  });

  it('1/2: "1 slot available" (singular, not "1 slots")', () => {
    expect(getSlotsAvailableLabel(1, 2)).toBe('1 slot available');
  });

  it('0/2: "2 slots available"', () => {
    expect(getSlotsAvailableLabel(0, 2)).toBe('2 slots available');
  });

  it('never goes negative even if openCount somehow exceeds maxSlots', () => {
    expect(getSlotsAvailableLabel(3, 2)).toBe('No slots available');
  });
});
