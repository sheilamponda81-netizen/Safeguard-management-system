import { describe, it, expect } from 'vitest';
import {
  getQualifyingEmployeeIds,
  summarizeAdvanceStatuses,
  getDominantStatusForColor,
  getSlotsAvailableLabel,
  filterAdvancesByTab,
  getMissingEmployeeIds,
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

// Part 3 (SALARY ADVANCES + PAYROLL & PAYSLIP FINANCIAL TRANSPARENCY):
// ACTIVE/PAID/OTHER-HISTORY tabs. Regression coverage for the real
// production case the audit found: DANIEL SIMPILICIOUS CHILINDE
// (SFG-S-308) holds two advances for the same employee -- one 'active'
// (outstanding MK15,000) and one 'cancelled' (never repaid, MK30,000,
// which the task did not even mention but production data showed). The
// two tabs must never show the same advance, and switching tabs must
// never affect the other tab's own advances or counts.
describe('filterAdvancesByTab', () => {
  const chilindeActive = { employee_id: 'chilinde', status: 'active' };
  const chilindeCancelled = { employee_id: 'chilinde', status: 'cancelled' };
  const wongaActive = { employee_id: 'wonga', status: 'active' };
  const somePending = { employee_id: 'other', status: 'pending' };
  const somePaid = { employee_id: 'other', status: 'paid' };
  const someRejected = { employee_id: 'other2', status: 'rejected' };
  const all = [chilindeActive, chilindeCancelled, wongaActive, somePending, somePaid, someRejected];

  it('ACTIVE tab includes active and pending, never paid/rejected/cancelled', () => {
    expect(filterAdvancesByTab(all, 'active')).toEqual([chilindeActive, wongaActive, somePending]);
  });

  it('PAID tab includes only paid', () => {
    expect(filterAdvancesByTab(all, 'paid')).toEqual([somePaid]);
  });

  it('OTHER/HISTORY tab includes rejected and cancelled, including CHILINDE\'s never-repaid cancelled advance -- never silently dropped', () => {
    expect(filterAdvancesByTab(all, 'other')).toEqual([chilindeCancelled, someRejected]);
  });

  it('the same advance never appears in two tabs', () => {
    const active = new Set(filterAdvancesByTab(all, 'active'));
    const paid = new Set(filterAdvancesByTab(all, 'paid'));
    const other = new Set(filterAdvancesByTab(all, 'other'));
    all.forEach(row => {
      const memberships = [active.has(row), paid.has(row), other.has(row)].filter(Boolean).length;
      expect(memberships).toBe(1);
    });
  });

  it('empty input yields an empty list for every tab', () => {
    expect(filterAdvancesByTab([], 'active')).toEqual([]);
    expect(filterAdvancesByTab([], 'paid')).toEqual([]);
    expect(filterAdvancesByTab([], 'other')).toEqual([]);
  });
});

// Part 2: resolving real names for soft-deleted employees who still own a
// pre-existing advance (production case: CHARLES WONGA / SFG-S-303 and
// DANIEL CHILINDE / SFG-S-308, both is_deleted = true with real
// outstanding balances) -- without this, the page's active-only employee
// fetch leaves their advances unable to resolve a name at all.
describe('getMissingEmployeeIds', () => {
  it('returns the employee_id of an advance whose employee is not in the active list', () => {
    const advances = [{ employee_id: 'wonga' }, { employee_id: 'active-emp' }];
    expect(getMissingEmployeeIds(advances, ['active-emp'])).toEqual(['wonga']);
  });

  it('dedupes when the same missing employee owns multiple advances (CHILINDE: active + cancelled)', () => {
    const advances = [{ employee_id: 'chilinde' }, { employee_id: 'chilinde' }];
    expect(getMissingEmployeeIds(advances, [])).toEqual(['chilinde']);
  });

  it('returns nothing when every advance already belongs to an active employee', () => {
    const advances = [{ employee_id: 'active-emp' }];
    expect(getMissingEmployeeIds(advances, ['active-emp'])).toEqual([]);
  });

  it('empty advances yields an empty list', () => {
    expect(getMissingEmployeeIds([], ['active-emp'])).toEqual([]);
  });
});
