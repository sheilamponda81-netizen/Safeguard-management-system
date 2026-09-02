// Pure, dependency-free helpers for Dashboard.tsx's headcount and payroll
// pending-approval math. Extracted so this logic is unit-testable without
// a component-test harness (this repo has none) -- Dashboard.tsx itself
// just calls these against its own fetched data.

export interface EmployeeRegistrationRecord {
  hire_date: string | null;
}

// Cumulative employees REGISTERED as of the end of a given month (monthEnd,
// "YYYY-MM-DD") -- NOT active headcount. Departures are deliberately never
// subtracted: `employees.status` is unconstrained free TEXT with no
// schema column recording when it changed, and there are TWO independent,
// non-overlapping departure paths in this app -- Employees.tsx's soft
// delete (is_deleted/deleted_at) and Security.tsx's Edit Guard status
// dropdown (which can set status to 'Terminated'/'Suspended' via a plain
// `.update({ status })` that never touches is_deleted/deleted_at at all).
// An employee can therefore be genuinely terminated with deleted_at
// forever NULL, so a deleted_at-based exclusion would silently miss some
// departures and not others -- less honest than not attempting it. This
// counts hire_date registrations only, a number the schema can actually
// prove, regardless of current status or soft-delete state.
export function countRegisteredAsOf(employees: EmployeeRegistrationRecord[], monthEnd: string): number {
  return employees.filter(e => !!e.hire_date && e.hire_date <= monthEnd).length;
}

export interface PayrollRecordForApproval {
  month: string;
  approval_status: string;
}

// Counts DISTINCT payroll months/runs that have at least one row still
// pending approval -- not employee rows. A run with 469 pending employee
// rows for one month is 1 pending run, not 469. `normalizeMonthKey` is
// injected (rather than imported) so this stays a pure function of its
// arguments and the caller controls exactly how a raw `payroll.month`
// value maps to a canonical key.
export function countPendingPayrollMonths(
  records: PayrollRecordForApproval[],
  normalizeMonthKey: (raw: string) => string | null
): number {
  const pendingMonthKeys = new Set<string>();
  records.forEach(r => {
    if (r.approval_status !== 'pending') return;
    const key = normalizeMonthKey(r.month);
    if (key) pendingMonthKeys.add(key);
  });
  return pendingMonthKeys.size;
}
