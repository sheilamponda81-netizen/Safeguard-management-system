// SAFEGUARD -- October 2026 payroll hotfix, financial-consistency correction.
//
// Dashboard.tsx's "Projected Payroll" card and Reports.tsx's "Total
// Payroll" card both need an UNPROCESSED month's live salary-advance
// deduction per employee, so their net-pay estimate matches Payroll.tsx's
// own preview exactly (same contract: gross pay minus PAYE/pension/uniform/
// attendance deductions minus THIS month's pooled salary-advance
// deduction). Rather than each screen independently re-deriving that
// figure (a real risk of silent formula drift between three call sites),
// this is a byte-for-byte mirror of Payroll.tsx's own fetch (same three
// tables, same filters, same batching helper) feeding the SAME pure
// calculatePooledAllocation() (salaryAdvanceCalculations.ts) Payroll.tsx
// itself already uses -- one formula, three screens, not three formulas
// that happen to agree today.
//
// Deliberately NOT used by Payroll.tsx itself: that page's own inline
// fetch (src/pages/Payroll.tsx, ~line 759 onward) also needs the full
// per-advance breakdown (remaining balance, application date) to drive its
// own editable preview UI, not just the final total this function
// returns, and is already tested/working -- reusing it here would mean
// changing already-correct, already-tested code for no behavioral gain.
// Both this function and Payroll.tsx's own fetch terminate in the exact
// same calculatePooledAllocation() call, so there is one formula, not two.
//
// For a PROCESSED month, this function must not be called at all --
// Dashboard.tsx and Reports.tsx both already read the actually-stored
// `payroll.net_pay` column in that case (which process_payroll_batch()
// computed server-side, salary-advance-inclusive), and must keep doing so
// rather than recalculating a historical payment from current advance
// ledger state.

import { supabase } from '../lib/supabase';
import { fetchInEmployeeIdBatches, dedupeById } from './employeeBatchFetch';
import { calculatePooledAllocation, OpenAdvanceForAllocation } from './salaryAdvanceCalculations';
import { calculateLivePayroll, AttendanceCount } from './payrollCalculations';
import { PayrollRates } from './payrollSettings';

export interface EstimatedNetPayInputs {
  basicSalary: number;
  position: string;
  employeeUniformDeduction?: number | null;
  positionsRequiringUniform: Map<string, boolean>;
  payrollRates: PayrollRates;
  attendance?: AttendanceCount;
  lectureDeduction?: number;
  appearanceDeduction?: number;
  /** THIS month's pooled salary-advance deduction, e.g. from
   *  fetchSalaryAdvanceDeductionByEmployee() below -- 0/undefined means
   *  "no active advance", never "unknown". */
  salaryAdvanceDeduction?: number;
}

export interface EstimatedNetPayResult {
  gross_pay: number;
  paye: number;
  pension: number;
  net_pay: number;
}

/**
 * THE "Estimated Net Payroll" financial contract for an UNPROCESSED
 * month, shared by Dashboard.tsx and Reports.tsx (see dashboardMetrics.ts's
 * estimateMonthlyPayrollTotal() and Reports.tsx's getEmployeeFigures(),
 * both of which call this function rather than each recomputing their own
 * version) -- one formula, not two that happen to agree today. Composes
 * calculateLivePayroll() (gross pay, PAYE, pension, uniform/attendance
 * deductions, all per the currently CONFIGURED payroll rates -- this
 * function never substitutes a statutory default for a deliberately-zero
 * PAYE/pension rate) with a single, final subtraction of this month's
 * pooled salary-advance deduction -- mathematically identical to what
 * Payroll.tsx's own preview computes (calculateLivePayroll() then
 * subtract calculatePooledAllocation().total), see
 * payrollDashboardReportsReconciliation.test.ts for the direct proof.
 *
 * gross_pay/paye/pension are returned EXACTLY as calculateLivePayroll()
 * computed them -- only net_pay is ever adjusted by the advance
 * subtraction, so a caller can never mistake a reduced net figure for a
 * changed gross/basic-salary metric.
 *
 * Callers MUST NOT apply this to an employee whose month is already
 * PROCESSED -- a processed `payroll` row's own stored net_pay already has
 * that run's salary-advance deduction subtracted server-side exactly
 * once; applying this function on top would double-subtract it. Both
 * Dashboard.tsx and Reports.tsx already branch on processed-vs-not before
 * ever reaching this function.
 */
export function computeEstimatedNetPay(inputs: EstimatedNetPayInputs): EstimatedNetPayResult {
  const live = calculateLivePayroll({
    basicSalary: inputs.basicSalary,
    position: inputs.position,
    employeeUniformDeduction: inputs.employeeUniformDeduction,
    positionsRequiringUniform: inputs.positionsRequiringUniform,
    payrollRates: inputs.payrollRates,
    attendance: inputs.attendance,
    lectureDeduction: inputs.lectureDeduction,
    appearanceDeduction: inputs.appearanceDeduction,
  });
  const salaryAdvanceDeduction = inputs.salaryAdvanceDeduction || 0;
  return {
    gross_pay: live.grossPay,
    paye: live.paye,
    pension: live.pension,
    net_pay: live.netPay - salaryAdvanceDeduction,
  };
}

/**
 * This month's total pooled salary-advance deduction per employee, for
 * employees with at least one currently-active advance whose deduction
 * has started by `selectedMonth` -- identical population/filter to
 * Payroll.tsx's own `salaryAdvanceByEmployee`/`combinedPlanByEmployee`
 * fetch. An employee with no active advance is simply absent from the
 * returned map (not present with 0) -- callers should treat a missing
 * entry as 0, the same convention `countsFromDeductions` in
 * payrollAttendanceCounts.ts already uses.
 */
export async function fetchSalaryAdvanceDeductionByEmployee(
  employeeIds: string[],
  selectedMonth: string
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (employeeIds.length === 0) return result;

  const activeAdvancesRaw = await fetchInEmployeeIdBatches<{
    id: string; employee_id: string; advance_amount: number; application_date: string; created_at: string;
  }>(
    employeeIds,
    (batch, from, to, withCount) =>
      supabase
        .from('salary_advances')
        .select('id, employee_id, advance_amount, application_date, created_at', withCount ? { count: 'exact' } : undefined)
        .eq('status', 'active')
        .lte('deduction_start_month', selectedMonth)
        .in('employee_id', batch)
        .range(from, to)
  );
  const activeAdvances = dedupeById(activeAdvancesRaw);
  if (activeAdvances.length === 0) return result;

  const advanceIds = activeAdvances.map(a => a.id);
  const ledgerRows = await fetchInEmployeeIdBatches<{ salary_advance_id: string; deduction_amount: number }>(
    advanceIds,
    (batch, from, to, withCount) =>
      supabase
        .from('salary_advance_deductions')
        .select('salary_advance_id, deduction_amount', withCount ? { count: 'exact' } : undefined)
        .in('salary_advance_id', batch)
        .range(from, to)
  );
  const repaidByAdvance = new Map<string, number>();
  ledgerRows.forEach(row => {
    repaidByAdvance.set(row.salary_advance_id, (repaidByAdvance.get(row.salary_advance_id) || 0) + row.deduction_amount);
  });

  const advancesByEmployee = new Map<string, OpenAdvanceForAllocation[]>();
  activeAdvances.forEach(advance => {
    const repaid = repaidByAdvance.get(advance.id) || 0;
    const existing = advancesByEmployee.get(advance.employee_id) || [];
    existing.push({
      id: advance.id,
      remainingBalance: Math.max(0, advance.advance_amount - repaid),
      applicationDate: advance.application_date,
      createdAt: advance.created_at,
    });
    advancesByEmployee.set(advance.employee_id, existing);
  });

  const plans = await fetchInEmployeeIdBatches<{ employee_id: string; combined_monthly_deduction: number }>(
    Array.from(advancesByEmployee.keys()),
    (batch, from, to, withCount) =>
      supabase
        .from('salary_advance_repayment_plans')
        .select('employee_id, combined_monthly_deduction', withCount ? { count: 'exact' } : undefined)
        .in('employee_id', batch)
        .range(from, to)
  );
  const combinedPlanByEmployee = new Map<string, number>();
  plans.forEach(plan => combinedPlanByEmployee.set(plan.employee_id, plan.combined_monthly_deduction));

  advancesByEmployee.forEach((advances, employeeId) => {
    const combinedMonthlyDeduction = combinedPlanByEmployee.get(employeeId) || 0;
    const { total } = calculatePooledAllocation(combinedMonthlyDeduction, advances);
    if (total > 0) result.set(employeeId, total);
  });

  return result;
}
