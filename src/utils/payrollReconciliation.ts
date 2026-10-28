// SAFEGUARD -- October 2026 payroll hotfix, final financial-reliability
// patch (Defects 1 & 2).
//
// THE shared "what did/will this month's payroll actually cost" contract,
// used by both Dashboard.tsx and Reports.tsx -- one reconciliation, not
// two that happen to agree today. Deliberately mirrors Payroll.tsx's own,
// already-authoritative two-branch behavior (src/pages/Payroll.tsx's
// fetchData(), `isHistoricalMonth = selectedMonth < systemMonth`, and
// getDisplayPayroll() = stored row if one exists, else a live estimate)
// rather than inventing a new business rule:
//
//   - HISTORICAL month (selectedMonth < systemMonth): population is
//     EXACTLY whoever has a stored `payroll` row for that month -- never
//     filtered by any employee's CURRENT status. Payroll.tsx's own branch
//     A does this specifically because a legitimate stored payroll record
//     for someone since deactivated/terminated/soft-deleted must not
//     silently disappear from a past month's total just because a LATER,
//     unrelated status change happened -- see that function's own comment
//     for the exact reasoning this mirrors.
//   - CURRENT/FUTURE month: population is the union of today's payable
//     roster (PAYABLE_EMPLOYEE_STATUSES, i.e. Active + On Leave, the SAME
//     whitelist Payroll.tsx's own branch B roster query uses) and anyone
//     who already has a stored row this month (so a stored row written
//     moments before an employee's status changed within the same month
//     is still counted, exactly like Payroll.tsx's own totals). Each
//     employee uses their stored row if one exists; otherwise a live
//     estimate via computeEstimatedNetPay() (livePayrollEstimate.ts).
//
// FAIL-CLOSED CONTRACT (Defect 1): a stored row NEVER needs a live
// estimate at all. But estimating even ONE employee requires
// `liveEstimateInputs` (attendance/positions/rates/salary-advance data).
// If that is omitted (the caller could not fetch it) and at least one
// employee in the population needs an estimate, this function returns
// `unavailable: true` and `totals`/`employees` MUST NOT be displayed or
// trusted as a real figure -- there is no "safe partial sum" here: a
// total that silently omits whichever employees could not be estimated
// is exactly the "plausible but incorrect" total this patch exists to
// prevent. Callers must render an explicit unavailable/retry state
// instead of any number when `unavailable` is true.
import { computeEstimatedNetPay, EstimatedNetPayResult } from './livePayrollEstimate';
import { AttendanceCount } from './payrollCalculations';
import { PayrollRates } from './payrollSettings';

export interface ReconciliationEmployee {
  id: string;
  basic_salary: number;
  position: string;
  uniform_deduction?: number | null;
}

export interface StoredPayrollRow {
  employee_id: string;
  gross_pay: number;
  paye: number;
  pension: number;
  net_pay: number;
  /** 'pending' | 'approved' | 'rejected' -- a stored row's EXISTENCE means
   *  this month was processed for this employee; it does NOT mean the
   *  decision is final. Never inferred as "complete" by this function. */
  approval_status: string;
}

export interface LiveEstimateInputs {
  attendanceByEmployeeId: Map<string, AttendanceCount>;
  positionsRequiringUniform: Map<string, boolean>;
  payrollRates: PayrollRates;
  /** This month's pooled total per employee -- see
   *  fetchSalaryAdvanceDeductionByEmployee()'s own header. A missing
   *  entry means "no active advance", never "unknown" -- unavailability
   *  of this whole fetch is signaled by omitting `liveEstimateInputs`
   *  entirely, not by passing an empty map here. */
  salaryAdvanceByEmployeeId: Map<string, number>;
  deductionsByEmployeeId?: Map<string, { lecture_deduction?: number; appearance_deduction?: number }>;
}

export type MonthProcessingState = 'unprocessed' | 'partial' | 'fully_processed';

export interface EmployeeReconciliation {
  employeeId: string;
  source: 'stored' | 'estimated';
  figures: EstimatedNetPayResult;
  /** Only present for source: 'stored'. */
  approvalStatus?: string;
}

export interface MonthlyPayrollReconciliation {
  state: MonthProcessingState;
  /** true = at least one employee needed a live estimate and none was
   *  available; `totals`/`employees` are then a zeroed PLACEHOLDER, never
   *  a real figure -- callers must check this BEFORE reading either. */
  unavailable: boolean;
  employees: EmployeeReconciliation[];
  totals: { gross_pay: number; paye: number; pension: number; net_pay: number };
  processedCount: number;
  estimatedCount: number;
  totalPopulationCount: number;
}

export function reconcileMonthlyPayroll(
  isHistoricalMonth: boolean,
  currentPayableEmployees: ReconciliationEmployee[],
  storedPayrollRows: StoredPayrollRow[],
  liveEstimateInputs: LiveEstimateInputs | undefined
): MonthlyPayrollReconciliation {
  const storedByEmployeeId = new Map<string, StoredPayrollRow>();
  storedPayrollRows.forEach(row => storedByEmployeeId.set(row.employee_id, row));

  // Historical: population is EXACTLY the stored rows -- never today's
  // roster (see this file's header). Current/future: union of today's
  // payable roster and anyone already stored this month.
  const populationIds: string[] = isHistoricalMonth
    ? Array.from(storedByEmployeeId.keys())
    : Array.from(new Set<string>([...currentPayableEmployees.map(e => e.id), ...storedByEmployeeId.keys()]));

  const payableById = new Map(currentPayableEmployees.map(e => [e.id, e]));

  const employees: EmployeeReconciliation[] = [];
  let unavailable = false;
  let processedCount = 0;
  let estimatedCount = 0;

  for (const id of populationIds) {
    const stored = storedByEmployeeId.get(id);
    if (stored) {
      processedCount++;
      employees.push({
        employeeId: id,
        source: 'stored',
        figures: { gross_pay: stored.gross_pay, paye: stored.paye, pension: stored.pension, net_pay: stored.net_pay },
        approvalStatus: stored.approval_status,
      });
      continue;
    }

    // Not stored. isHistoricalMonth never reaches here (populationIds is
    // stored-rows-only in that branch) -- this employee needs a live
    // estimate, and must be in today's payable roster to get one.
    const emp = payableById.get(id);
    if (!emp) continue; // defensive; cannot occur given populationIds' construction above

    estimatedCount++;
    if (!liveEstimateInputs) {
      // Required input unavailable -- do NOT fabricate a figure, and do
      // NOT silently drop this employee from a "safe partial" total.
      unavailable = true;
      continue;
    }

    const deduction = liveEstimateInputs.deductionsByEmployeeId?.get(id);
    const figures = computeEstimatedNetPay({
      basicSalary: emp.basic_salary,
      position: emp.position,
      employeeUniformDeduction: emp.uniform_deduction,
      positionsRequiringUniform: liveEstimateInputs.positionsRequiringUniform,
      payrollRates: liveEstimateInputs.payrollRates,
      attendance: liveEstimateInputs.attendanceByEmployeeId.get(id),
      lectureDeduction: deduction?.lecture_deduction,
      appearanceDeduction: deduction?.appearance_deduction,
      salaryAdvanceDeduction: liveEstimateInputs.salaryAdvanceByEmployeeId.get(id),
    });
    employees.push({ employeeId: id, source: 'estimated', figures });
  }

  const totalPopulationCount = populationIds.length;
  const state: MonthProcessingState =
    totalPopulationCount === 0 || processedCount === 0
      ? 'unprocessed'
      : processedCount === totalPopulationCount
        ? 'fully_processed'
        : 'partial';

  const totals = unavailable
    ? { gross_pay: 0, paye: 0, pension: 0, net_pay: 0 }
    : employees.reduce(
        (acc, e) => ({
          gross_pay: acc.gross_pay + e.figures.gross_pay,
          paye: acc.paye + e.figures.paye,
          pension: acc.pension + e.figures.pension,
          net_pay: acc.net_pay + e.figures.net_pay,
        }),
        { gross_pay: 0, paye: 0, pension: 0, net_pay: 0 }
      );

  return { state, unavailable, employees, totals, processedCount, estimatedCount, totalPopulationCount };
}
