// Pure, dependency-free helpers for Dashboard.tsx's headcount and payroll
// pending-approval math. Extracted so this logic is unit-testable without
// a component-test harness (this repo has none) -- Dashboard.tsx itself
// just calls these against its own fetched data.

export interface GrowthHistoryEmployee {
  hire_date: string | null;
  deleted_at: string | null;
}

// Real headcount AS OF THE END OF a given month (monthEnd, "YYYY-MM-DD"),
// not "hired ever" and not "currently employed today". Someone counts for
// a month if they had already been hired by monthEnd AND either haven't
// left yet or left after monthEnd -- so a person hired in June and
// terminated (soft-deleted) in August still counts toward June's and
// July's headcount, even though they are invisible to any is_deleted=false
// query by the time this runs.
export function countHeadcountAsOf(employees: GrowthHistoryEmployee[], monthEnd: string): number {
  return employees.filter(e => {
    if (!e.hire_date || e.hire_date > monthEnd) return false;
    if (!e.deleted_at) return true;
    return e.deleted_at.slice(0, 10) > monthEnd;
  }).length;
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
