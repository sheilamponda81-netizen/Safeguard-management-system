import { describe, it, expect } from 'vitest';
import { countHeadcountAsOf, countPendingPayrollMonths } from './dashboardMetrics';

// Regression coverage for the real semantic bug: the Employee Growth chart
// used to derive past-month counts from is_deleted=false employee rows
// only, so anyone who had since been soft-deleted (terminated) vanished
// from EVERY past month's count too, not just the current one -- silently
// understating historical headcount. countHeadcountAsOf must reconstruct
// "who was actually employed as of monthEnd" using hire_date/deleted_at.
describe('countHeadcountAsOf', () => {
  it('counts someone hired before monthEnd and never deleted', () => {
    const employees = [{ hire_date: '2026-06-15', deleted_at: null }];
    expect(countHeadcountAsOf(employees, '2026-06-30')).toBe(1);
  });

  it('does not count someone hired AFTER monthEnd', () => {
    const employees = [{ hire_date: '2026-07-15', deleted_at: null }];
    expect(countHeadcountAsOf(employees, '2026-06-30')).toBe(0);
  });

  it('the exact reported scenario: hired June, terminated August -- still counts for June and July, not for August', () => {
    const employees = [{ hire_date: '2026-06-10', deleted_at: '2026-08-05T00:00:00Z' }];
    expect(countHeadcountAsOf(employees, '2026-06-30')).toBe(1);
    expect(countHeadcountAsOf(employees, '2026-07-31')).toBe(1);
    expect(countHeadcountAsOf(employees, '2026-08-31')).toBe(0);
  });

  it('someone whose departure date IS monthEnd itself is already gone by end of that day, so does not count for that month', () => {
    const employees = [{ hire_date: '2026-06-01', deleted_at: '2026-06-30T23:00:00Z' }];
    expect(countHeadcountAsOf(employees, '2026-06-30')).toBe(0);
  });

  it('someone who departs the day AFTER monthEnd still counts as present for monthEnd', () => {
    const employees = [{ hire_date: '2026-06-01', deleted_at: '2026-07-01T00:00:00Z' }];
    expect(countHeadcountAsOf(employees, '2026-06-30')).toBe(1);
  });

  it('does not count a row with no hire_date at all', () => {
    const employees = [{ hire_date: null, deleted_at: null }];
    expect(countHeadcountAsOf(employees, '2026-06-30')).toBe(0);
  });

  it('mixed roster: sums only those actually present as of monthEnd', () => {
    const employees = [
      { hire_date: '2026-06-01', deleted_at: null }, // still employed
      { hire_date: '2026-06-10', deleted_at: '2026-08-01' }, // left after June
      { hire_date: '2026-07-01', deleted_at: null }, // hired after June
      { hire_date: '2026-05-01', deleted_at: '2026-06-01' }, // left before/at June start
    ];
    expect(countHeadcountAsOf(employees, '2026-06-30')).toBe(2);
  });
});

// Regression coverage for the real semantic bug: pendingPayrollApprovalCount
// used to count individual pending employee rows for the selected month
// (e.g. 469 rows for one July payroll run), which wildly overstated the
// actual "Approve Payroll" workload -- one run is one thing to approve.
describe('countPendingPayrollMonths', () => {
  const normalize = (raw: string) => raw; // identity for these tests

  it('many pending rows in ONE month collapse to a count of 1', () => {
    const records = Array.from({ length: 469 }, (_, i) => ({ month: '2026-07', approval_status: 'pending', employee_id: `e${i}` }));
    expect(countPendingPayrollMonths(records, normalize)).toBe(1);
  });

  it('pending rows spread across two months count as 2', () => {
    const records = [
      { month: '2026-06', approval_status: 'pending' },
      { month: '2026-07', approval_status: 'pending' },
      { month: '2026-07', approval_status: 'pending' },
    ];
    expect(countPendingPayrollMonths(records, normalize)).toBe(2);
  });

  it('approved rows are never counted, even in a month with no pending rows', () => {
    const records = [
      { month: '2026-06', approval_status: 'approved' },
      { month: '2026-07', approval_status: 'approved' },
    ];
    expect(countPendingPayrollMonths(records, normalize)).toBe(0);
  });

  it('a month with a mix of pending and approved rows still counts once', () => {
    const records = [
      { month: '2026-07', approval_status: 'pending' },
      { month: '2026-07', approval_status: 'approved' },
    ];
    expect(countPendingPayrollMonths(records, normalize)).toBe(1);
  });

  it('empty input yields 0, not a fallback nonzero value', () => {
    expect(countPendingPayrollMonths([], normalize)).toBe(0);
  });

  it('a month key that fails to normalize (returns null) is excluded, never counted as a stray "null" month', () => {
    const normalizeWithFailure = (raw: string) => (raw === 'garbage' ? null : raw);
    const records = [
      { month: 'garbage', approval_status: 'pending' },
      { month: '2026-07', approval_status: 'pending' },
    ];
    expect(countPendingPayrollMonths(records, normalizeWithFailure)).toBe(1);
  });
});
