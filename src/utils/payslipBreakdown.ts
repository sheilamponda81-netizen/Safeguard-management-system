// Phase 4B -- pure, testable helpers for the itemised ordinary payslip.
// Deliberately narrow: this module does NOT recompute payroll (no
// attendance/rate logic lives here) -- it only (a) checks that a
// COMMITTED payroll row's own stored figures are internally consistent,
// and (b) decides, from already-stored data, whether a reliable
// itemised attendance-deduction breakdown exists for a given record, so
// the page can show one honestly or say plainly that it can't.

export interface PayslipReconciliationInput {
  grossPay: number;
  basicSalary: number;
  allowances: number;
  overtime: number;
  bonus: number;
  paye: number;
  pension: number;
  uniformDeduction: number;
  salaryAdvanceDeduction: number;
  netPay: number;
  // Refund-persistence hotfix (2026-11): defaults to 0 for full backward
  // compatibility with every existing caller/test. Deliberately NOT part
  // of expectedGross below -- see
  // supabase/migrations/20261108000000_payroll_refund_adjustments.sql's
  // header for why a refund is added at the net-pay level only, never
  // into the taxable gross/PAYE/pension base the way bonus is.
  refund?: number;
}

export interface PayslipReconciliationResult {
  /** gross_pay as stored vs basic+allowances+overtime+bonus. */
  grossReconciles: boolean;
  /** net_pay as stored vs gross - paye - pension - uniform - salary advance. */
  netReconciles: boolean;
  /** True only when both of the above hold (within rounding tolerance). */
  reconciles: boolean;
}

const TOLERANCE = 1; // whole currency unit -- absorbs integer rounding, never a real discrepancy

/**
 * Checks a committed payroll record's own stored figures against each
 * other -- never against today's rates or settings, so this never
 * flags a historical record as "wrong" just because a rate changed
 * since it was processed. A failure here means the record's own numbers
 * don't add up (e.g. a tampered/malformed submission), not that it is
 * stale.
 */
export function checkPayslipReconciliation(input: PayslipReconciliationInput): PayslipReconciliationResult {
  const expectedGross = input.basicSalary + input.allowances + input.overtime + input.bonus;
  const grossReconciles = Math.abs(input.grossPay - expectedGross) <= TOLERANCE;

  const expectedNet = input.grossPay - input.paye - input.pension - input.uniformDeduction - input.salaryAdvanceDeduction + (input.refund || 0);
  const netReconciles = Math.abs(input.netPay - expectedNet) <= TOLERANCE;

  return { grossReconciles, netReconciles, reconciles: grossReconciles && netReconciles };
}

export interface AttendanceDeductionRecord {
  absent_days?: number | null;
  late_days?: number | null;
  absent_deduction?: number | null;
  late_deduction?: number | null;
}

export interface ItemizedAttendanceBreakdown {
  /** Whether a stored employee_deductions row exists for this employee/month at all. */
  available: boolean;
  absentDays: number;
  absentDeduction: number;
  lateDays: number;
  lateDeduction: number;
}

/**
 * Builds the attendance-deduction portion of the breakdown strictly from
 * the FROZEN employee_deductions row for this employee/month (never from
 * today's configured rate x day count) -- "available: false" when no such
 * row exists, so the caller can show an explicit "not available" note
 * instead of silently rendering a fabricated zero as if it were a
 * verified fact.
 */
export function buildItemizedAttendanceBreakdown(record: AttendanceDeductionRecord | null | undefined): ItemizedAttendanceBreakdown {
  if (!record) {
    return { available: false, absentDays: 0, absentDeduction: 0, lateDays: 0, lateDeduction: 0 };
  }
  return {
    available: true,
    absentDays: record.absent_days || 0,
    absentDeduction: record.absent_deduction || 0,
    lateDays: record.late_days || 0,
    lateDeduction: record.late_deduction || 0,
  };
}

/**
 * Derives the uniform-only portion of the frozen `payroll.uniform_deduction`
 * bucket (which bundles uniform + attendance + lecture/appearance into one
 * committed total) as a REMAINDER against the other frozen, itemized
 * components -- never from today's employee.uniform_deduction setting or
 * today's position-eligibility config, both of which can change after the
 * month was processed and would silently relabel a past month's uniform
 * charge with a figure that never applied to it. Only meaningful when an
 * employee_deductions row exists for the month; otherwise 0, so the caller's
 * "itemized breakdown not available" fallback covers it instead of showing a
 * fabricated figure.
 */
export function deriveUniformOnlyAmount(
  totalUniformAndAttendance: number,
  breakdown: ItemizedAttendanceBreakdown,
  lectureDeduction: number,
  appearanceDeduction: number
): number {
  if (!breakdown.available) return 0;
  const remainder = totalUniformAndAttendance - breakdown.absentDeduction - breakdown.lateDeduction - lectureDeduction - appearanceDeduction;
  return Math.max(0, remainder);
}
