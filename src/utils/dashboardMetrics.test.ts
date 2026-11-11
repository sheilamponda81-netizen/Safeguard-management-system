import { describe, it, expect } from 'vitest';
import { countRegisteredAsOf, countPendingPayrollMonths, estimateMonthlyPayrollTotal, computeHeadcountStats, HeadcountEmployee } from './dashboardMetrics';
import { DEFAULT_RATES } from './payrollSettings';
import { AttendanceCount } from './payrollCalculations';

// Regression coverage for the Dashboard production incident: "Total
// Employees" (and every other headcount stat derived from the same
// fetch -- On Leave, Active Guards, Active Supervisors) was computed from
// an unpaginated `employees_general` fetch that Supabase/PostgREST
// silently truncated at 1,000 rows once the tenant's population passed it
// -- confirmed in production at exactly this scale: 1,580 total employees,
// 1,399 Active/On Leave, Dashboard showing 1,000. Dashboard.tsx now fetches
// the complete population via fetchAllPages() (see
// employeeBatchFetch.test.ts for that fix's own regression coverage) before
// calling computeHeadcountStats() -- these tests cover the CATEGORY MATH
// itself at and beyond that same scale, independent of how the data was
// fetched.
describe('computeHeadcountStats', () => {
  it('reconciles to the exact production baseline: 1,399 Active/On Leave (1,224 Active + 175 On Leave) within a 1,580-employee population, never capped at 1,000', () => {
    const employees: HeadcountEmployee[] = [
      ...Array.from({ length: 1224 }, () => ({ position: 'Guard', status: 'Active' })),
      ...Array.from({ length: 175 }, () => ({ position: 'Guard', status: 'On Leave' })),
      // The remaining 181 are deleted in production and never reach this
      // function at all (Dashboard.tsx fetches employees_general with
      // is_deleted=false) -- not represented here, since
      // computeHeadcountStats has no is_deleted concept of its own.
    ];
    const stats = computeHeadcountStats(employees);
    expect(employees.length).toBe(1399); // past the old 1,000-row cap
    expect(stats.active).toBe(1224);
    expect(stats.onLeave).toBe(175);
    expect(stats.active + stats.onLeave).toBe(1399);
  });

  it('a 1,580-employee population (the exact production row count) is fully reconciled by status, with every category counted past the old 1,000-row cap', () => {
    const employees: HeadcountEmployee[] = [
      ...Array.from({ length: 1224 }, (_, i) => ({ position: i % 2 === 0 ? 'Guard' : 'Supervisor', status: 'Active' })),
      ...Array.from({ length: 175 }, () => ({ position: 'Guard', status: 'On Leave' })),
      ...Array.from({ length: 181 }, () => ({ position: 'Guard', status: 'Deleted' })), // mirrors is_deleted=true rows if ever passed in
    ];
    expect(employees.length).toBe(1580);
    const stats = computeHeadcountStats(employees);
    expect(stats.active).toBe(1224);
    expect(stats.onLeave).toBe(175);
    // 'Deleted' status rows count toward neither active nor on-leave --
    // confirms deleted employees are never silently counted as payable/
    // active even if a caller ever passed them in.
    expect(stats.active + stats.onLeave).toBe(1399);
    expect(stats.activeGuards + stats.supervisorsOnDuty).toBe(1224); // every Active row matches exactly one of the two position buckets here
  });

  it('activeGuards/supervisorsOnDuty only count status === "Active", never On Leave or Deleted, even with a matching position', () => {
    const employees: HeadcountEmployee[] = [
      { position: 'Senior Guard', status: 'Active' },
      { position: 'Senior Guard', status: 'On Leave' },
      { position: 'Senior Guard', status: 'Deleted' },
      { position: 'Site Supervisor', status: 'Active' },
      { position: 'Site Supervisor', status: 'On Leave' },
    ];
    const stats = computeHeadcountStats(employees);
    expect(stats.activeGuards).toBe(1);
    expect(stats.supervisorsOnDuty).toBe(1);
    expect(stats.active).toBe(2);
    expect(stats.onLeave).toBe(2);
  });

  it('position matching is case-insensitive substring matching, consistent with Dashboard.tsx\'s pre-extraction logic', () => {
    const employees: HeadcountEmployee[] = [
      { position: 'DOG HANDLER', status: 'Active' }, // no match (doesn't contain guard/security/officer/patrol)
      { position: 'SITE COMMANDER', status: 'Active' }, // no match
      { position: 'Security Officer', status: 'Active' }, // matches both 'security' and 'officer'
      { position: 'night patrol', status: 'Active' },
      { position: 'OPERATIONS MANAGER', status: 'Active' },
    ];
    const stats = computeHeadcountStats(employees);
    expect(stats.activeGuards).toBe(2); // Security Officer, night patrol
    expect(stats.supervisorsOnDuty).toBe(1); // OPERATIONS MANAGER
  });

  it('a null/missing position never throws and matches no category', () => {
    const employees: HeadcountEmployee[] = [
      { position: null, status: 'Active' },
      { position: '', status: 'Active' },
    ];
    expect(() => computeHeadcountStats(employees)).not.toThrow();
    const stats = computeHeadcountStats(employees);
    expect(stats.activeGuards).toBe(0);
    expect(stats.supervisorsOnDuty).toBe(0);
    expect(stats.active).toBe(2);
  });

  it('an empty population returns all-zero stats', () => {
    expect(computeHeadcountStats([])).toEqual({ active: 0, onLeave: 0, activeGuards: 0, supervisorsOnDuty: 0 });
  });
});

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

// Regression coverage for the "Monthly Payroll" card's projected-figure
// fix: when the selected month has no processed `payroll` rows, the card
// must show a real, useful estimate rather than just "Not Processed" text
// -- but that estimate has to come from the SAME formula (calculateLivePayroll)
// Payroll.tsx/Payments.tsx already use, not an invented one.
describe('estimateMonthlyPayrollTotal', () => {
  const noAttendance = new Map<string, AttendanceCount>();
  const uniformAlwaysRequired = new Map<string, boolean>(); // empty => defaults to true

  it('single employee, no attendance, default rates: gross - PAYE - pension - default uniform deduction', () => {
    // basicSalary 100000: gross 100000; paye = (100000-50000)*0.30 = 15000;
    // pension = 100000*0.05 = 5000; uniform (no per-employee override) =
    // DEFAULT_RATES.uniformDeduction = 10000. net = 100000-15000-5000-10000 = 70000.
    const employees = [{ id: 'e1', basic_salary: 100000, position: 'Guard', uniform_deduction: null }];
    expect(estimateMonthlyPayrollTotal(employees, noAttendance, uniformAlwaysRequired, DEFAULT_RATES)).toBe(70000);
  });

  it('sums across multiple employees, not just the first', () => {
    const employees = [
      { id: 'e1', basic_salary: 100000, position: 'Guard', uniform_deduction: null },
      { id: 'e2', basic_salary: 100000, position: 'Guard', uniform_deduction: null },
    ];
    expect(estimateMonthlyPayrollTotal(employees, noAttendance, uniformAlwaysRequired, DEFAULT_RATES)).toBe(140000);
  });

  it('applies real attendance-derived deductions per employee (absent/late days), not zero for everyone', () => {
    // Same base as the first test, but 2 absent + 1 late day:
    // attendance deduction = 2*4200 + 1*4200 = 12600; uniform total = 10000+12600 = 22600.
    // net = 100000-15000-5000-22600 = 57400.
    const employees = [{ id: 'e1', basic_salary: 100000, position: 'Guard', uniform_deduction: null }];
    const attendance = new Map<string, AttendanceCount>([['e1', { absentDays: 2, lateDays: 1 }]]);
    expect(estimateMonthlyPayrollTotal(employees, attendance, uniformAlwaysRequired, DEFAULT_RATES)).toBe(57400);
  });

  it('honors a position explicitly NOT requiring a uniform deduction', () => {
    const employees = [{ id: 'e1', basic_salary: 100000, position: 'Admin', uniform_deduction: null }];
    const positions = new Map<string, boolean>([['Admin', false]]);
    // net = 100000-15000-5000-0 = 80000 (no uniform deduction at all).
    expect(estimateMonthlyPayrollTotal(employees, noAttendance, positions, DEFAULT_RATES)).toBe(80000);
  });

  it('honors a per-employee uniform_deduction override instead of the default rate', () => {
    const employees = [{ id: 'e1', basic_salary: 100000, position: 'Guard', uniform_deduction: 5000 }];
    // net = 100000-15000-5000-5000 = 75000.
    expect(estimateMonthlyPayrollTotal(employees, noAttendance, uniformAlwaysRequired, DEFAULT_RATES)).toBe(75000);
  });

  it('empty roster yields 0, not a fallback nonzero value', () => {
    expect(estimateMonthlyPayrollTotal([], noAttendance, uniformAlwaysRequired, DEFAULT_RATES)).toBe(0);
  });

  it('an employee with no attendance-map entry is treated as zero absent/late days, not skipped', () => {
    const employees = [
      { id: 'e1', basic_salary: 100000, position: 'Guard', uniform_deduction: null },
      { id: 'e2', basic_salary: 100000, position: 'Guard', uniform_deduction: null },
    ];
    // Only e1 has an attendance row; e2 falls back to 0/0, not excluded from the sum.
    const attendance = new Map<string, AttendanceCount>([['e1', { absentDays: 1, lateDays: 0 }]]);
    const total = estimateMonthlyPayrollTotal(employees, attendance, uniformAlwaysRequired, DEFAULT_RATES);
    // e1: 100000-15000-5000-(10000+4200) = 65800; e2: 70000 (from the first test). Sum = 135800.
    expect(total).toBe(135800);
  });
});
