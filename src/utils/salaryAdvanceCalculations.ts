// Pure repayment-schedule math for Salary Advances, unit-testable without
// Supabase or rendering -- same pattern as terminalDuesCalculations.ts /
// payrollCalculations.ts. The database (process_payroll_batch RPC) is the
// authoritative source for what actually gets deducted from a real payroll
// run; this module exists so the Salary Advances page can preview the exact
// same numbers before submitting, using the identical formula, per the
// requirement that "calculations displayed in the UI must be derived from
// the same business logic as the backend and must not disagree with
// payroll." See supabase/migrations/20260813000001_payroll_salary_advance_integration.sql
// for the SQL that mirrors this file's LEAST()/remaining-balance logic.

import { getNextMonth } from './currentMonth';

export type RepaymentMethod = 'monthly_amount' | 'repayment_period';

export interface AdvanceScheduleInputs {
  advanceAmount: number;
  repaymentMethod: RepaymentMethod;
  /** Required (and authoritative) when repaymentMethod === 'monthly_amount'. */
  monthlyDeduction?: number;
  /** Required (and authoritative) when repaymentMethod === 'repayment_period'. */
  repaymentPeriodMonths?: number;
  /** 'YYYY-MM', matching payroll.month's convention. */
  deductionStartMonth: string;
}

export interface AdvanceSchedule {
  advanceAmount: number;
  repaymentMethod: RepaymentMethod;
  /** The regular (non-final) monthly deduction -- derived, never independently
   *  entered by the user regardless of which mode was used. */
  configuredMonthlyDeduction: number;
  /** Total number of deductions, including the final (possibly smaller) one. */
  repaymentPeriodMonths: number;
  /** The last installment, which absorbs any rounding remainder so the sum
   *  of all deductions equals advanceAmount exactly. */
  finalDeductionAmount: number;
  /** 'YYYY-MM' of the month the final deduction is expected in. */
  expectedPayoffMonth: string;
}

export class AdvanceScheduleValidationError extends Error {}

/**
 * Derives a full repayment schedule from EITHER a monthly amount OR a
 * repayment period -- never both independently, so the two can never
 * contradict each other (one is always calculated FROM the advance amount
 * and the other input, matching the "system must derive one of monthly
 * amount / period" requirement).
 *
 * Throws AdvanceScheduleValidationError (never returns a NaN/Infinity
 * schedule) for: non-positive advance amount, non-positive monthly
 * deduction/period, or a monthly deduction so large relative to the
 * advance that it would somehow not terminate (defensive only -- cannot
 * actually happen given the checks above, but guards against a future
 * change introducing a division/loop bug).
 */
export function calculateAdvanceSchedule(inputs: AdvanceScheduleInputs): AdvanceSchedule {
  const { advanceAmount, repaymentMethod, deductionStartMonth } = inputs;

  if (!Number.isFinite(advanceAmount) || advanceAmount <= 0) {
    throw new AdvanceScheduleValidationError('Advance amount must be a positive number');
  }
  if (!deductionStartMonth || !/^\d{4}-\d{2}$/.test(deductionStartMonth)) {
    throw new AdvanceScheduleValidationError('Deduction start month must be in YYYY-MM format');
  }

  let configuredMonthlyDeduction: number;
  let repaymentPeriodMonths: number;

  if (repaymentMethod === 'monthly_amount') {
    const monthlyDeduction = inputs.monthlyDeduction;
    if (!Number.isFinite(monthlyDeduction) || (monthlyDeduction as number) <= 0) {
      throw new AdvanceScheduleValidationError('Monthly deduction must be a positive number');
    }
    configuredMonthlyDeduction = Math.round((monthlyDeduction as number) * 100) / 100;
    // e.g. 80,000 / 20,000 = 4 exactly -> 4 deductions, no remainder.
    // e.g. 80,000 / 30,000 = 2.67 -> 3 deductions, last one smaller.
    repaymentPeriodMonths = Math.ceil(advanceAmount / configuredMonthlyDeduction);
  } else if (repaymentMethod === 'repayment_period') {
    const months = inputs.repaymentPeriodMonths;
    if (!Number.isFinite(months) || !Number.isInteger(months) || (months as number) <= 0) {
      throw new AdvanceScheduleValidationError('Repayment period must be a positive whole number of months');
    }
    repaymentPeriodMonths = months as number;
    // Round DOWN to the nearest whole Kwacha for the regular installment so
    // the schedule never over-collects in early months -- the final
    // installment (computed below from the true remainder) absorbs the
    // rounding difference instead.
    configuredMonthlyDeduction = Math.floor(advanceAmount / repaymentPeriodMonths);
    if (configuredMonthlyDeduction <= 0) {
      // e.g. a 500 Kwacha advance over 12 months would floor to 0/month --
      // reject rather than silently producing an infinite/zero-progress
      // schedule.
      throw new AdvanceScheduleValidationError('Repayment period is too long for this advance amount -- the monthly deduction would round to zero');
    }
  } else {
    throw new AdvanceScheduleValidationError('Repayment method must be either "monthly_amount" or "repayment_period"');
  }

  if (!Number.isFinite(repaymentPeriodMonths) || repaymentPeriodMonths <= 0 || repaymentPeriodMonths > 1200) {
    // 100 years is an impossible repayment period for any real advance --
    // defensive upper bound only, never expected to trigger given the
    // positive-amount/positive-deduction checks above.
    throw new AdvanceScheduleValidationError('Calculated repayment period is invalid');
  }

  const regularDeductionsTotal = Math.round(configuredMonthlyDeduction * (repaymentPeriodMonths - 1) * 100) / 100;
  const finalDeductionAmount = Math.round((advanceAmount - regularDeductionsTotal) * 100) / 100;

  if (!Number.isFinite(finalDeductionAmount) || finalDeductionAmount <= 0) {
    throw new AdvanceScheduleValidationError('Calculated final deduction is invalid');
  }

  let expectedPayoffMonth = deductionStartMonth;
  for (let i = 1; i < repaymentPeriodMonths; i++) {
    expectedPayoffMonth = getNextMonth(expectedPayoffMonth);
  }

  return {
    advanceAmount: Math.round(advanceAmount * 100) / 100,
    repaymentMethod,
    configuredMonthlyDeduction,
    repaymentPeriodMonths,
    finalDeductionAmount,
    expectedPayoffMonth,
  };
}

/**
 * The deduction due for ONE specific payroll month, given a remaining
 * balance BEFORE this month's own deduction -- identical formula to the
 * SQL RPC's `LEAST(configured_monthly_deduction, remaining_balance)`.
 * Returns 0 (never negative) once the balance is already exhausted.
 *
 * Only correct for an employee with a SINGLE open advance. An employee
 * with two simultaneously open advances must use
 * calculatePooledAllocation() below instead -- see its own header for why
 * a single-advance LEAST() can't be applied independently per advance
 * once a shared monthly budget and oldest-first spillover are involved.
 */
export function calculateMonthlyDeductionDue(configuredMonthlyDeduction: number, remainingBalanceBeforeThisMonth: number): number {
  if (remainingBalanceBeforeThisMonth <= 0) return 0;
  return Math.round(Math.min(configuredMonthlyDeduction, remainingBalanceBeforeThisMonth) * 100) / 100;
}

/** One employee's open advance, as input to calculatePooledAllocation(). */
export interface OpenAdvanceForAllocation {
  id: string;
  /** Derived remaining balance BEFORE this month's own deduction. */
  remainingBalance: number;
  /** 'YYYY-MM-DD' (or any lexicographically-sortable date string) -- older = allocated first. */
  applicationDate: string;
  /** Tie-breaker matching the SQL's own `ORDER BY application_date, created_at, id` -- optional. */
  createdAt?: string;
}

export interface PooledAllocationResult {
  /** This employee's TOTAL deduction this month, across all open advances --
   *  what payroll.salary_advance_deduction stores and net_pay subtracts once. */
  total: number;
  /** Per-advance split, keyed by advance id -- what each ledger row this
   *  month should contain. */
  allocations: Map<string, number>;
}

/**
 * Business rule (corrected from an earlier draft that summed each
 * advance's own independently-configured rate): when an employee has up
 * to 2 simultaneously open ('active', start month reached) salary
 * advances, there is ONE COMBINED monthly deduction figure for their
 * total outstanding debt -- set by management (see
 * salary_advance_repayment_plans / adjust_combined_repayment_plan() in
 * supabase/migrations/20260813000000_salary_advances_schema.sql), passed
 * in here as `combinedMonthlyDeduction` rather than derived by summing
 * anything. That single figure is allocated across the employee's open
 * advances OLDEST ADVANCE FIRST: the oldest gets
 * `LEAST(its own remaining balance, the remaining pool)` -- no per-advance
 * rate caps it anymore -- and whatever pool budget it doesn't use (because
 * it finished paying off that month) carries forward to the next advance
 * in the same month. Example from the business rule: pool = 20,000,
 * Advance #1 remaining = 10,000, Advance #2 remaining = 30,000 -> Advance
 * #1 gets 10,000 (finishes), Advance #2 gets the remaining 10,000 of the
 * pool -- total exactly 20,000, never more. Mirrors
 * supabase/migrations/20260813000001_payroll_salary_advance_integration.sql's
 * pooled allocation loop exactly -- this function exists purely so the
 * frontend can preview/display the same numbers the RPC will actually
 * apply, per the "UI must not disagree with payroll" requirement. The RPC
 * remains authoritative for what's actually deducted; this is a preview only.
 */
export function calculatePooledAllocation(combinedMonthlyDeduction: number, advances: OpenAdvanceForAllocation[]): PooledAllocationResult {
  const sorted = [...advances].sort((a, b) => {
    const byDate = a.applicationDate.localeCompare(b.applicationDate);
    if (byDate !== 0) return byDate;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });

  let pool = Math.max(combinedMonthlyDeduction, 0);
  const allocations = new Map<string, number>();
  let total = 0;

  for (const advance of sorted) {
    const remaining = Math.max(advance.remainingBalance, 0);
    const alloc = Math.round(Math.min(remaining, pool) * 100) / 100;
    allocations.set(advance.id, alloc);
    pool = Math.round((pool - alloc) * 100) / 100;
    total = Math.round((total + alloc) * 100) / 100;
  }

  return { total, allocations };
}
