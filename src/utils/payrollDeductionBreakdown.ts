// Payroll Management page -- itemized deductions breakdown (display-only).
//
// payroll.uniform_deduction is a BUNDLED total (uniform + attendance +
// lecture/appearance all combined into one committed figure -- see
// payslipBreakdown.ts's own header). This module aggregates that bundle
// across every employee for the selected month into separate categories,
// reusing the EXACT SAME per-employee formulas Payslips.tsx already uses
// (buildItemizedAttendanceBreakdown / deriveUniformOnlyAmount) so nothing
// here is a new or guessed calculation -- it only re-groups figures that
// already exist.
//
// "Hygiene deduction" does not exist anywhere in this schema (no column,
// no rate, no UI elsewhere) -- this module deliberately has no such
// category, per the instruction not to invent one.
//
// An employee with no `employee_deductions` row for the month (so no
// itemized absent/late/lecture/appearance figures are available) has
// their WHOLE bundled uniform/attendance total added to
// `unitemizedUniformAndAttendanceTotal` instead of being guessed-split
// into the categories below -- this keeps `categorizedTotal` exactly
// reconciling with `grandTotal` without ever inventing a missing figure.
import { AttendanceDeductionRecord, buildItemizedAttendanceBreakdown, deriveUniformOnlyAmount } from './payslipBreakdown';

export interface PayrollDeductionBreakdownEmployeeInput {
  paye: number;
  pension: number;
  /** The bundled payroll.uniform_deduction figure for this employee/month. */
  uniformAndAttendanceTotal: number;
  salaryAdvanceDeduction: number;
  /** The employee_deductions row for this employee/month, or null if none exists. */
  attendanceRecord: AttendanceDeductionRecord | null;
  lectureDeduction: number;
  appearanceDeduction: number;
}

export interface PayrollDeductionBreakdownTotals {
  payeTotal: number;
  pensionTotal: number;
  uniformOnlyTotal: number;
  absenceTotal: number;
  lateTotal: number;
  lectureTotal: number;
  appearanceTotal: number;
  salaryAdvanceTotal: number;
  /** Bundled uniform/attendance total for employees with NO itemized
   *  breakdown available this month -- an explicit "not itemized"
   *  bucket, never split into the categories above by guesswork. */
  unitemizedUniformAndAttendanceTotal: number;
  /** Count of employees with a non-zero bundled uniform/attendance
   *  total but no employee_deductions row to itemize it. */
  employeesWithoutItemizedBreakdown: number;
  /** Sum of every category above, including the unitemized bucket. */
  categorizedTotal: number;
  /** paye + pension + uniformAndAttendanceTotal + salaryAdvanceDeduction
   *  summed across every employee -- the same formula the page's
   *  existing "Total Deductions" stat card already uses. */
  grandTotal: number;
  /** True when categorizedTotal matches grandTotal within a 1-currency-
   *  unit rounding tolerance. A false here means a real inconsistency in
   *  the underlying stored figures, not a flaw in this aggregation --
   *  never hidden by forcing the numbers to agree. */
  reconciles: boolean;
}

const TOLERANCE = 1;

export function buildPayrollDeductionBreakdown(
  inputs: PayrollDeductionBreakdownEmployeeInput[]
): PayrollDeductionBreakdownTotals {
  let payeTotal = 0;
  let pensionTotal = 0;
  let uniformOnlyTotal = 0;
  let absenceTotal = 0;
  let lateTotal = 0;
  let lectureTotal = 0;
  let appearanceTotal = 0;
  let salaryAdvanceTotal = 0;
  let unitemizedUniformAndAttendanceTotal = 0;
  let employeesWithoutItemizedBreakdown = 0;
  let grandTotal = 0;

  for (const e of inputs) {
    payeTotal += e.paye;
    pensionTotal += e.pension;
    salaryAdvanceTotal += e.salaryAdvanceDeduction;
    grandTotal += e.paye + e.pension + e.uniformAndAttendanceTotal + e.salaryAdvanceDeduction;

    const itemized = buildItemizedAttendanceBreakdown(e.attendanceRecord);
    if (itemized.available) {
      absenceTotal += itemized.absentDeduction;
      lateTotal += itemized.lateDeduction;
      lectureTotal += e.lectureDeduction;
      appearanceTotal += e.appearanceDeduction;
      uniformOnlyTotal += deriveUniformOnlyAmount(e.uniformAndAttendanceTotal, itemized, e.lectureDeduction, e.appearanceDeduction);
    } else {
      unitemizedUniformAndAttendanceTotal += e.uniformAndAttendanceTotal;
      if (e.uniformAndAttendanceTotal > 0) employeesWithoutItemizedBreakdown += 1;
    }
  }

  const categorizedTotal =
    payeTotal + pensionTotal + uniformOnlyTotal + absenceTotal + lectureTotal + appearanceTotal + lateTotal + salaryAdvanceTotal + unitemizedUniformAndAttendanceTotal;

  return {
    payeTotal,
    pensionTotal,
    uniformOnlyTotal,
    absenceTotal,
    lateTotal,
    lectureTotal,
    appearanceTotal,
    salaryAdvanceTotal,
    unitemizedUniformAndAttendanceTotal,
    employeesWithoutItemizedBreakdown,
    categorizedTotal,
    grandTotal,
    reconciles: Math.abs(categorizedTotal - grandTotal) <= TOLERANCE,
  };
}
