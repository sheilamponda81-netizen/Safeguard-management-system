import { describe, it, expect } from 'vitest';
import { countRegisteredAsOf, countPendingPayrollMonths } from './dashboardMetrics';

// Regression coverage for the real semantic finding: the Employee Growth
// chart cannot prove real historical ACTIVE headcount at all, because there
// are two independent departure paths in this app and only one of them
// (Employees.tsx's soft delete) has a timestamp -- Security.tsx's Edit
// Guard status dropdown can set status='Terminated'/'Suspended' via a plain
// `.update({ status })` that never touches is_deleted/deleted_at, and there
// is no termination_date/status_changed_at column anywhere in the schema.
// countRegisteredAsOf deliberately counts cumulative REGISTRATIONS
// (hire_date <= monthEnd) only, never attempting to subtract a departure
// the schema cannot date.
describe('countRegisteredAsOf', () => {
  it('counts someone hired before monthEnd', () => {
    const employees = [{ hire_date: '2026-06-15' }];
    expect(countRegisteredAsOf(employees, '2026-06-30')).toBe(1);
  });

  it('does not count someone hired AFTER monthEnd', () => {
    const employees = [{ hire_date: '2026-07-15' }];
    expect(countRegisteredAsOf(employees, '2026-06-30')).toBe(0);
  });

  it('counts someone hired exactly ON monthEnd', () => {
    const employees = [{ hire_date: '2026-06-30' }];
    expect(countRegisteredAsOf(employees, '2026-06-30')).toBe(1);
  });

  it('the scenario that made deleted_at-based exclusion unsafe: hired June, status later set to Terminated with NO deleted_at -- still counts for every month from June onward, since this is a registration count, not an active-headcount count', () => {
    const employees = [{ hire_date: '2026-06-10' }];
    expect(countRegisteredAsOf(employees, '2026-06-30')).toBe(1);
    expect(countRegisteredAsOf(employees, '2026-09-30')).toBe(1);
  });

  it('does not count a row with no hire_date at all', () => {
    const employees = [{ hire_date: null }];
    expect(countRegisteredAsOf(employees, '2026-06-30')).toBe(0);
  });

  it('mixed roster: sums only those registered by monthEnd, regardless of current status', () => {
    const employees = [
      { hire_date: '2026-06-01' },
      { hire_date: '2026-06-10' },
      { hire_date: '2026-07-01' }, // hired after June
      { hire_date: null }, // no hire_date at all
    ];
    expect(countRegisteredAsOf(employees, '2026-06-30')).toBe(2);
  });

  it('is monotonically non-decreasing month over month (a cumulative count can never shrink)', () => {
    const employees = [
      { hire_date: '2026-06-05' },
      { hire_date: '2026-07-10' },
      { hire_date: '2026-08-20' },
    ];
    const june = countRegisteredAsOf(employees, '2026-06-30');
    const july = countRegisteredAsOf(employees, '2026-07-31');
    const august = countRegisteredAsOf(employees, '2026-08-31');
    expect(june).toBeLessThanOrEqual(july);
    expect(july).toBeLessThanOrEqual(august);
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
