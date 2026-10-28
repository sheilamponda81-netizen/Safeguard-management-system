// Pure, dependency-free helpers for Dashboard.tsx's headcount and payroll
// pending-approval math. Extracted so this logic is unit-testable without
// a component-test harness (this repo has none) -- Dashboard.tsx itself
// just calls these against its own fetched data.

import { AttendanceCount } from './payrollCalculations';
import { PayrollRates } from './payrollSettings';
import { computeEstimatedNetPay } from './livePayrollEstimate';

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

export interface PayrollEstimateEmployee {
  id: string;
  basic_salary: number;
  position: string;
  uniform_deduction: number | null;
}

// Projected NET payroll total for a month with no processed `payroll` rows
// yet -- summed via calculateLivePayroll(), the SAME "single source of
// truth" formula Payroll.tsx and Payments.tsx already use for an
// unprocessed month's own live preview (see payrollCalculations.ts's
// header), reused here rather than inventing a second, possibly-diverging
// formula. `salaryAdvanceByEmployeeId` (2026-11, financial-consistency
// correction) subtracts THIS month's pooled salary-advance deduction per
// employee -- computed by fetchSalaryAdvanceDeductionByEmployee()
// (livePayrollEstimate.ts), which mirrors Payroll.tsx's own fetch and
// calls the SAME calculatePooledAllocation() Payroll.tsx uses -- so this
// total now matches Payroll.tsx's own preview net-pay figure for the same
// population/month, not merely close to it. A missing map entry means "no
// active advance", not "fetch failed" -- see that function's own header.
// Still deliberately narrower than Payroll.tsx's own per-employee preview
// in exactly one remaining way: the employee_deductions lecture/appearance
// line items, which would require their own additional roster-wide fetch
// for a dashboard-level aggregate explicitly labeled "Estimated", not a
// replacement for Payroll.tsx's own authoritative pre-processing preview.
// Every input this function uses (basic salary, position, uniform
// deduction, attendance-derived deductions, configured payroll rates, and
// now salary advances) is real, not invented.
export function estimateMonthlyPayrollTotal(
  employees: PayrollEstimateEmployee[],
  attendanceByEmployeeId: Map<string, AttendanceCount>,
  positionsRequiringUniform: Map<string, boolean>,
  payrollRates: PayrollRates,
  salaryAdvanceByEmployeeId: Map<string, number> = new Map()
): number {
  return employees.reduce((total, e) => {
    const figures = computeEstimatedNetPay({
      basicSalary: e.basic_salary,
      position: e.position,
      employeeUniformDeduction: e.uniform_deduction,
      positionsRequiringUniform,
      payrollRates,
      attendance: attendanceByEmployeeId.get(e.id),
      salaryAdvanceDeduction: salaryAdvanceByEmployeeId.get(e.id),
    });
    return total + figures.net_pay;
  }, 0);
}
