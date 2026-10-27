// Terminal Dues Modernization -- Phase 1 calculation engine.
//
// Pure, deterministic, side-effect-free math for the new Terminal Dues
// calculator. Deliberately separate from the legacy terminalDuesCalculations.ts
// (still used by the existing, already-approved/paid live `terminal_dues`
// workflow) -- this engine backs the NEW draft calculation pathway
// (`terminal_due_calculations`) only, so correcting the business formulas
// here never recomputes or touches any historical pending/approved/paid
// terminal due.
//
// Every monetary component is rounded UP to the whole Kwacha independently,
// per the business rule, using roundUpToWholeKwacha() (which first snaps
// away IEEE754 division noise so an exact whole-Kwacha result is never
// bumped up by 1).

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

/**
 * Snaps a float to 6 decimal places before any ceiling operation. A division
 * like (26 * 100000) / 26 can land on 100000.00000000001 or
 * 99999.99999999999 due to IEEE754 representation error -- Math.ceil() alone
 * would wrongly inflate the first case to 100001. Six decimal places is far
 * finer than any real MWK calculation needs, so this only ever removes
 * floating-point noise, never a genuine fraction.
 */
function cleanFloat(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Rounds a monetary amount UP to the nearest whole MWK (business rule:
 * "round calculated monetary components upward to whole MWK"). Safe for
 * negative amounts too (e.g. an overpayment entry): Math.ceil(-5000.4) is
 * -5000, i.e. "up" towards zero, applied the same direction consistently. */
export function roundUpToWholeKwacha(amount: number): number {
  return Math.ceil(cleanFloat(amount));
}

// ---------------------------------------------------------------------------
// Completed employment months (pension arrears basis)
// ---------------------------------------------------------------------------

/**
 * Whole COMPLETED calendar months between dateJoined and dateLeft, counted
 * by day-of-month anniversary -- not a plain year/month subtraction. An
 * employee joined 2024-01-15 who leaves 2024-03-10 has completed exactly 1
 * month (Jan 15 -> Feb 15); the Feb 15 -> Mar 10 span is incomplete and is
 * ignored entirely, per the "completed months only... ignore incomplete
 * months" business rule. Returns 0 (never negative) if dateLeft is not
 * after dateJoined. Dates are parsed as UTC midnight so the result never
 * shifts with the server's local timezone.
 */
export function calculateCompletedEmploymentMonths(dateJoined: string, dateLeft: string): number {
  const joined = new Date(`${dateJoined}T00:00:00Z`);
  const left = new Date(`${dateLeft}T00:00:00Z`);
  if (!(left.getTime() > joined.getTime())) return 0;

  let months =
    (left.getUTCFullYear() - joined.getUTCFullYear()) * 12 +
    (left.getUTCMonth() - joined.getUTCMonth());

  // The final, partial month (dateLeft's day-of-month hasn't yet reached
  // dateJoined's anniversary day) is incomplete -- do not count it.
  if (left.getUTCDate() < joined.getUTCDate()) {
    months -= 1;
  }

  return Math.max(0, months);
}

// ---------------------------------------------------------------------------
// Pension arrears
// ---------------------------------------------------------------------------

export interface PensionArrearsResult {
  completedMonths: number;
  /** System-calculated months, or the authorised override if one was supplied. */
  effectiveMonths: number;
  amount: number;
}

/**
 * Pension arrears = completed employment months x final monthly salary x 10%.
 * `overrideMonths`, when provided (>= 0), is an authorised, audited
 * correction of the system-calculated month count -- this function only
 * applies whichever count it is given; recording who authorised the
 * override and why is the caller's responsibility (see
 * terminal_due_calculations.inputs in the migration).
 */
export function calculatePensionArrears(
  dateJoined: string,
  dateLeft: string,
  finalSalary: number,
  overrideMonths?: number | null
): PensionArrearsResult {
  const completedMonths = calculateCompletedEmploymentMonths(dateJoined, dateLeft);
  const effectiveMonths =
    overrideMonths != null && Number.isFinite(overrideMonths) && overrideMonths >= 0
      ? overrideMonths
      : completedMonths;
  const amount = roundUpToWholeKwacha(effectiveMonths * finalSalary * 0.1);
  return { completedMonths, effectiveMonths, amount };
}

// ---------------------------------------------------------------------------
// Annual leave refund
// ---------------------------------------------------------------------------

/** Annual leave refund = unused leave days x final salary / 26. */
export function calculateAnnualLeaveRefund(unusedLeaveDays: number, finalSalary: number): number {
  if (!(unusedLeaveDays > 0)) return 0;
  return roundUpToWholeKwacha((unusedLeaveDays * finalSalary) / 26);
}

// ---------------------------------------------------------------------------
// Uniform refund
// ---------------------------------------------------------------------------

/** Fallback rate used only when no approved `terminal_dues_uniform_refund_rate`
 * system setting exists yet (see TerminalDuesCalculator.tsx) -- keeps every
 * existing caller/test that omits `ratePerMonth` behaving exactly as before. */
export const DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH = 10000;

/**
 * Uniform refund = eligible deduction months x the CURRENT approved monthly
 * rate -- confirmed business policy: the current rate applies to every
 * eligible month, including months whose historical deduction rate was
 * different. Historical payroll amounts are evidence of HOW MANY months a
 * deduction occurred, never of what rate to refund at; this function
 * deliberately has no parameter for a historical rate.
 */
export function calculateUniformRefund(
  deductionMonths: number,
  ratePerMonth: number = DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH
): number {
  if (!(deductionMonths > 0)) return 0;
  return roundUpToWholeKwacha(deductionMonths * ratePerMonth);
}

/**
 * Whether an HR-entered uniform deduction month count needs a documented
 * correction reason: true only when reliable payroll evidence exists AND
 * the entered count disagrees with it. A fully historical case (no payroll
 * evidence at all, payrollEvidenceMonths === null) never needs one -- HR's
 * entered count IS the record in that case, per business rule.
 */
export function uniformRefundNeedsCorrectionReason(
  payrollEvidenceMonths: number | null,
  enteredMonths: number
): boolean {
  if (payrollEvidenceMonths == null) return false;
  return enteredMonths !== payrollEvidenceMonths;
}

/**
 * Whether an HR-entered pension-months override needs a documented
 * correction reason: true only when an override was actually supplied AND
 * it disagrees with the system-calculated completed-months count. Mirrors
 * uniformRefundNeedsCorrectionReason()'s shape -- no override, or an
 * override that happens to match the system count, never needs one.
 */
export function pensionMonthsOverrideNeedsCorrectionReason(
  systemCalculatedMonths: number,
  overrideMonths: number | null | undefined
): boolean {
  if (overrideMonths == null || !Number.isFinite(overrideMonths)) return false;
  return overrideMonths !== systemCalculatedMonths;
}

// ---------------------------------------------------------------------------
// Outstanding salary (multiple distinct unpaid months)
// ---------------------------------------------------------------------------

export interface OutstandingSalaryEntryInput {
  /** HR-entered label for the unpaid month, e.g. "2026-03". Not validated here. */
  month: string;
  amountOwed: number;
  amountPaid: number;
}

export interface OutstandingSalaryEntryResult extends OutstandingSalaryEntryInput {
  /** amountOwed - amountPaid, rounded up. Deliberately NOT clamped at zero
   * per-entry: a negative value (overpaid) is a real signal the breakdown
   * must show, not hide -- only the grand total is floored at zero. */
  outstanding: number;
}

/**
 * Resolves each outstanding-salary entry's owed/paid difference and sums
 * them. `amountPaid` exists specifically so a month already paid via
 * payroll or an earlier terminal due isn't double-counted here -- see
 * findOutstandingSalaryDoubleCountWarnings() for the companion check
 * against known-settled months.
 */
export function calculateOutstandingSalaryEntries(
  entries: OutstandingSalaryEntryInput[]
): { entries: OutstandingSalaryEntryResult[]; total: number } {
  const resolved = entries.map(entry => ({
    ...entry,
    outstanding: roundUpToWholeKwacha(entry.amountOwed - entry.amountPaid),
  }));
  const total = roundUpToWholeKwacha(resolved.reduce((sum, e) => sum + e.outstanding, 0));
  return { entries: resolved, total };
}

/**
 * Pure warning generator: flags any outstanding-salary entry whose month is
 * already known (from payroll/payment_status, supplied by the caller) to
 * have been paid or settled elsewhere -- a non-blocking validation signal,
 * not an authority. The database has no constraint enforcing this (the two
 * systems are intentionally not integrated in Phase 1), so this is advisory
 * only.
 */
export function findOutstandingSalaryDoubleCountWarnings(
  entries: OutstandingSalaryEntryInput[],
  alreadySettledMonths: string[]
): string[] {
  const settled = new Set(alreadySettledMonths);
  return entries
    .filter(e => settled.has(e.month))
    .map(e => `${e.month} is already recorded as paid in payroll/payment records. Verify before including it here.`);
}

// ---------------------------------------------------------------------------
// Less Notice
// ---------------------------------------------------------------------------

export type NoticeStatus = 'on_time' | 'late' | 'none';

export interface LessNoticeInput {
  /** Company policy notice period in working days. Always 26 today, but
   * threaded through rather than hardcoded so a future policy change is a
   * data change, not a code change. */
  requiredNoticeDays: number;
  status: NoticeStatus;
  /** HR-verified late-notice working days. Only meaningful when status === 'late'. */
  lateNoticeDays?: number;
  finalSalary: number;
}

/**
 * Less Notice deduction:
 * - on_time -> 0
 * - none -> one full monthly salary
 * - late -> ceil(lateNoticeDays x finalSalary / requiredNoticeDays), capped
 *   at one monthly salary
 *
 * This is a deduction against terminal dues ONLY -- it never touches
 * normal earned-salary payroll calculations, and this function has no way
 * to (and must not be made to) forfeit earned salary or treat an off day
 * as a notice day; `lateNoticeDays` is an opaque HR-verified input, not
 * derived from attendance/roster data here.
 */
export function calculateLessNoticeDeduction(input: LessNoticeInput): number {
  if (input.status === 'on_time') return 0;
  if (input.status === 'none') return roundUpToWholeKwacha(input.finalSalary);

  const requiredDays = input.requiredNoticeDays > 0 ? input.requiredNoticeDays : 26;
  const lateDays = Math.max(0, input.lateNoticeDays ?? 0);
  const raw = (lateDays * input.finalSalary) / requiredDays;
  return Math.min(roundUpToWholeKwacha(raw), roundUpToWholeKwacha(input.finalSalary));
}

// ---------------------------------------------------------------------------
// Full breakdown
// ---------------------------------------------------------------------------

export interface TerminalDuesCalculationInputs {
  dateJoined: string;
  dateLeft: string;
  finalSalary: number;
  /** Authorised, audited correction of the system-calculated completed months. */
  pensionMonthsOverride?: number | null;
  unusedLeaveDays?: number;
  uniformDeductionMonths?: number;
  /** The CURRENT approved monthly uniform refund rate, sourced from the
   * `terminal_dues_uniform_refund_rate` system setting by the caller.
   * Defaults to DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH when omitted. */
  uniformRefundRatePerMonth?: number;
  outstandingSalaryEntries?: OutstandingSalaryEntryInput[];
  noticeStatus: NoticeStatus;
  requiredNoticeDays?: number;
  lateNoticeDays?: number;
}

export interface TerminalDuesBreakdown {
  completedMonths: number;
  effectiveMonths: number;
  pensionArrears: number;
  annualLeaveRefund: number;
  uniformRefund: number;
  outstandingSalaryEntries: OutstandingSalaryEntryResult[];
  outstandingSalaryTotal: number;
  lessNoticeDeduction: number;
  totalEntitlements: number;
  totalDeductions: number;
  /** totalEntitlements - totalDeductions, BEFORE flooring at zero. */
  rawPayable: number;
  /** max(0, rawPayable) -- the amount actually payable. */
  totalPayable: number;
  /** abs(rawPayable) when rawPayable < 0, else 0 -- preserved for review,
   * never turned into employee debt. */
  excessDeduction: number;
}

export interface TerminalDuesValidationError {
  error: string;
}

export function isTerminalDuesValidationError(
  result: TerminalDuesBreakdown | TerminalDuesValidationError
): result is TerminalDuesValidationError {
  return 'error' in result;
}

/**
 * Composes every component above into the full itemised breakdown. Returns
 * a validation error (not a thrown exception) for the two preconditions
 * that make the rest of the math meaningless: dateLeft must be after
 * dateJoined, and finalSalary must be positive.
 */
export function calculateTerminalDuesBreakdown(
  inputs: TerminalDuesCalculationInputs
): TerminalDuesBreakdown | TerminalDuesValidationError {
  if (!inputs.dateJoined || !inputs.dateLeft) {
    return { error: 'Date joined and date left are both required.' };
  }
  if (!(new Date(`${inputs.dateLeft}T00:00:00Z`).getTime() > new Date(`${inputs.dateJoined}T00:00:00Z`).getTime())) {
    return { error: 'Date left must be after date joined.' };
  }
  if (!(inputs.finalSalary > 0)) {
    return { error: 'Final salary must be greater than zero.' };
  }

  const pension = calculatePensionArrears(
    inputs.dateJoined,
    inputs.dateLeft,
    inputs.finalSalary,
    inputs.pensionMonthsOverride
  );
  const annualLeaveRefund = calculateAnnualLeaveRefund(inputs.unusedLeaveDays ?? 0, inputs.finalSalary);
  const uniformRefund = calculateUniformRefund(
    inputs.uniformDeductionMonths ?? 0,
    inputs.uniformRefundRatePerMonth ?? DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH
  );
  const { entries: outstandingSalaryEntries, total: outstandingSalaryTotal } = calculateOutstandingSalaryEntries(
    inputs.outstandingSalaryEntries ?? []
  );
  const lessNoticeDeduction = calculateLessNoticeDeduction({
    requiredNoticeDays: inputs.requiredNoticeDays ?? 26,
    status: inputs.noticeStatus,
    lateNoticeDays: inputs.lateNoticeDays,
    finalSalary: inputs.finalSalary,
  });

  const totalEntitlements = roundUpToWholeKwacha(
    pension.amount + annualLeaveRefund + uniformRefund + outstandingSalaryTotal
  );
  const totalDeductions = lessNoticeDeduction;
  const rawPayable = totalEntitlements - totalDeductions;
  const totalPayable = Math.max(0, rawPayable);
  const excessDeduction = rawPayable < 0 ? Math.abs(rawPayable) : 0;

  return {
    completedMonths: pension.completedMonths,
    effectiveMonths: pension.effectiveMonths,
    pensionArrears: pension.amount,
    annualLeaveRefund,
    uniformRefund,
    outstandingSalaryEntries,
    outstandingSalaryTotal,
    lessNoticeDeduction,
    totalEntitlements,
    totalDeductions,
    rawPayable,
    totalPayable,
    excessDeduction,
  };
}
