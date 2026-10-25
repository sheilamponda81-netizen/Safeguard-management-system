// Payroll Management page -- itemized deductions breakdown (display-only).
//
// payroll.uniform_deduction is a BUNDLED total (uniform + attendance +
// lecture/appearance all combined into one committed figure -- see
// payslipBreakdown.ts's own header). This module aggregates that bundle
// across every employee for the selected month into separate categories.
//
// "Hygiene deduction" does not exist anywhere in this schema (no column,
// no rate, no UI elsewhere) -- this module deliberately has no such
// category, per the instruction not to invent one.
//
// TWO authoritative sources exist for the itemized absence/late figures,
// and the UAT-reported "everything lands in Not Itemized" defect was this
// module originally reading only ONE of them (the frozen
// `employee_deductions` row) regardless of which one actually applies:
//
//   - An ALREADY-PROCESSED employee (a committed `payroll` row exists):
//     the frozen `employee_deductions` row for that employee/month is the
//     ONLY authoritative source -- if it doesn't exist, there is nothing
//     reliable to itemize, and the bundled total goes into the explicit
//     "not itemized" bucket rather than being guessed.
//   - A NOT-YET-PROCESSED employee (live preview, no committed row yet):
//     Payroll.tsx's own calculatePayroll() never reads the frozen
//     employee_deductions row for absence/late at all -- it derives them
//     from the LIVE `attendanceCounts` map (current/future months source
//     this from get_payroll_attendance_counts(), never from
//     employee_deductions -- see payrollAttendanceCounts.ts's own header)
//     times the live configured payrollRates.absentDeduction/
//     lateDeduction, via calculateLivePayroll() in payrollCalculations.ts.
//     This module's deriveItemizedAttendanceDeduction() mirrors that exact
//     formula so the itemized absence/late figures always reconcile with
//     the bundled uniform_deduction total calculatePayroll() actually
//     produced -- a live-preview employee is therefore always itemizable
//     (attendanceCounts + payrollRates are always available whenever the
//     page isn't in its fail-closed blocked state, which the caller
//     already gates the whole card behind).
//
// Lecture/appearance deductions are NOT bundled into either of the above
// branches differently -- they are read from the stored
// employee_deductions row's own lecture_deduction/appearance_deduction
// columns in both cases, exactly as calculatePayroll() and the historical
// payslip breakdown both already do (these are entered once by HR via
// Attendance.tsx and apply regardless of whether the month has been
// processed yet).
import { AttendanceDeductionRecord, buildItemizedAttendanceBreakdown } from './payslipBreakdown';

export interface ItemizedAttendanceDeductionAmounts {
  absenceDeduction: number;
  lateDeduction: number;
  lectureDeduction: number;
  appearanceDeduction: number;
}

export interface DeriveItemizedAttendanceDeductionInputs {
  /** True when this employee has a committed/historical payroll row for
   *  the month (getDisplayPayroll() would return the stored record, not
   *  a live calculatePayroll() estimate). */
  isProcessed: boolean;
  /** The live attendanceCounts map entry for this employee, or null/undefined
   *  if none -- only consulted when !isProcessed. */
  liveAttendance: { absentDays: number; lateDays: number } | null | undefined;
  /** The frozen employee_deductions row for this employee/month, or null
   *  -- only consulted (for absence/late) when isProcessed. */
  frozenRecord: AttendanceDeductionRecord | null;
  lectureDeduction: number;
  appearanceDeduction: number;
  /** The LIVE configured rates (payrollRates.absentDeduction/lateDeduction)
   *  -- only used when !isProcessed, mirroring calculateLivePayroll()
   *  exactly (today's rate, since an unprocessed month has nothing
   *  historical to preserve). */
  liveAbsentRate: number;
  liveLateRate: number;
}

/**
 * Resolves the itemized absence/late/lecture/appearance amounts for one
 * employee/month, or null when no reliable source exists (a processed
 * employee with no frozen employee_deductions row -- genuinely nothing to
 * itemize, never guessed). See this file's header for which of the two
 * sources applies and why.
 */
export function deriveItemizedAttendanceDeduction(
  inputs: DeriveItemizedAttendanceDeductionInputs
): ItemizedAttendanceDeductionAmounts | null {
  if (inputs.isProcessed) {
    const frozen = buildItemizedAttendanceBreakdown(inputs.frozenRecord);
    if (!frozen.available) return null;
    return {
      absenceDeduction: frozen.absentDeduction,
      lateDeduction: frozen.lateDeduction,
      lectureDeduction: inputs.lectureDeduction,
      appearanceDeduction: inputs.appearanceDeduction,
    };
  }

  // Live/unprocessed -- mirrors calculateLivePayroll()'s own formula
  // (payrollCalculations.ts) exactly: absentDays * live rate, lateDays *
  // live rate. Always resolvable (defaults to 0 days, a confirmed zero,
  // never "unknown") whenever the caller isn't already in the fail-closed
  // attendanceCountsUnavailable state -- the caller gates the whole
  // breakdown card behind that separately.
  const absentDays = inputs.liveAttendance?.absentDays || 0;
  const lateDays = inputs.liveAttendance?.lateDays || 0;
  return {
    absenceDeduction: absentDays * inputs.liveAbsentRate,
    lateDeduction: lateDays * inputs.liveLateRate,
    lectureDeduction: inputs.lectureDeduction,
    appearanceDeduction: inputs.appearanceDeduction,
  };
}

export interface PayrollDeductionBreakdownEmployeeInput {
  paye: number;
  pension: number;
  /** The bundled payroll.uniform_deduction figure for this employee/month. */
  uniformAndAttendanceTotal: number;
  salaryAdvanceDeduction: number;
  /** Pre-resolved via deriveItemizedAttendanceDeduction() -- null means no
   *  reliable itemization source exists for this employee/month. */
  itemized: ItemizedAttendanceDeductionAmounts | null;
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
   *  total but no reliable source to itemize it. */
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

    if (e.itemized) {
      absenceTotal += e.itemized.absenceDeduction;
      lateTotal += e.itemized.lateDeduction;
      lectureTotal += e.itemized.lectureDeduction;
      appearanceTotal += e.itemized.appearanceDeduction;
      const remainder =
        e.uniformAndAttendanceTotal - e.itemized.absenceDeduction - e.itemized.lateDeduction - e.itemized.lectureDeduction - e.itemized.appearanceDeduction;
      uniformOnlyTotal += Math.max(0, remainder);
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
