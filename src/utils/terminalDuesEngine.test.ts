import { describe, it, expect } from 'vitest';
import {
  calculateCompletedEmploymentMonths,
  calculatePensionArrears,
  calculateAnnualLeaveRefund,
  calculateUniformRefund,
  uniformRefundNeedsCorrectionReason,
  pensionMonthsOverrideNeedsCorrectionReason,
  DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH,
  calculateOutstandingSalaryEntries,
  findOutstandingSalaryDoubleCountWarnings,
  calculateLessNoticeDeduction,
  calculateTerminalDuesBreakdown,
  isTerminalDuesValidationError,
  roundUpToWholeKwacha,
} from './terminalDuesEngine';

describe('roundUpToWholeKwacha', () => {
  it('rounds a genuine fraction up', () => {
    expect(roundUpToWholeKwacha(100000.01)).toBe(100001);
  });

  it('does not inflate an exact whole value corrupted by floating-point noise', () => {
    // 26 * 100000 / 26 is mathematically exactly 100000, but IEEE754
    // division can land a hair above it -- must still read as 100000.
    expect(roundUpToWholeKwacha((26 * 100000) / 26)).toBe(100000);
  });

  it('rounds a negative amount up towards zero', () => {
    expect(roundUpToWholeKwacha(-5000.4)).toBe(-5000);
  });
});

describe('calculateCompletedEmploymentMonths', () => {
  it('counts only fully completed months by day-of-month anniversary', () => {
    // Joined the 15th, left the 10th of two months later -- the final
    // span (Feb 15 -> Mar 10) is incomplete and must not be counted.
    expect(calculateCompletedEmploymentMonths('2024-01-15', '2024-03-10')).toBe(1);
  });

  it('counts the month when dateLeft lands exactly on or after the anniversary day', () => {
    expect(calculateCompletedEmploymentMonths('2024-01-15', '2024-03-15')).toBe(2);
    expect(calculateCompletedEmploymentMonths('2024-01-15', '2024-03-20')).toBe(2);
  });

  it('handles a full multi-year tenure', () => {
    expect(calculateCompletedEmploymentMonths('2018-02-01', '2023-05-20')).toBe(63);
  });

  it('returns 0 (never negative) when dateLeft is not after dateJoined', () => {
    expect(calculateCompletedEmploymentMonths('2024-01-01', '2024-01-01')).toBe(0);
    expect(calculateCompletedEmploymentMonths('2024-06-01', '2024-01-01')).toBe(0);
  });
});

describe('calculatePensionArrears', () => {
  it('computes completed months x final salary x 10%, rounded up', () => {
    const result = calculatePensionArrears('2020-01-15', '2026-01-15', 150000);
    expect(result.completedMonths).toBe(72);
    expect(result.effectiveMonths).toBe(72);
    expect(result.amount).toBe(72 * 150000 * 0.1);
  });

  it('ignores an incomplete final month', () => {
    const result = calculatePensionArrears('2020-01-15', '2026-01-10', 150000);
    expect(result.completedMonths).toBe(71);
    expect(result.amount).toBe(71 * 150000 * 0.1);
  });

  it('applies an authorised override of the completed months instead of the system count', () => {
    const result = calculatePensionArrears('2020-01-15', '2026-01-15', 150000, 70);
    expect(result.completedMonths).toBe(72); // system count preserved for audit
    expect(result.effectiveMonths).toBe(70); // override is what's actually used
    expect(result.amount).toBe(70 * 150000 * 0.1);
  });

  it('ignores a negative or non-finite override and falls back to the system count', () => {
    expect(calculatePensionArrears('2020-01-15', '2026-01-15', 150000, -5).effectiveMonths).toBe(72);
    expect(calculatePensionArrears('2020-01-15', '2026-01-15', 150000, NaN).effectiveMonths).toBe(72);
  });
});

describe('calculateAnnualLeaveRefund', () => {
  it('computes unused days x final salary / 26, rounded up', () => {
    expect(calculateAnnualLeaveRefund(10, 150000)).toBe(Math.ceil((10 * 150000) / 26));
  });

  it('returns 0 for zero or negative unused days', () => {
    expect(calculateAnnualLeaveRefund(0, 150000)).toBe(0);
    expect(calculateAnnualLeaveRefund(-3, 150000)).toBe(0);
  });

  it('rounds a fractional result up to the next whole Kwacha', () => {
    // 1 day x 26,000 / 26 = 1000 exactly -- a clean case.
    expect(calculateAnnualLeaveRefund(1, 26000)).toBe(1000);
    // 1 day x 100,000 / 26 = 3846.153... -> rounds up to 3847.
    expect(calculateAnnualLeaveRefund(1, 100000)).toBe(3847);
  });
});

describe('calculateUniformRefund', () => {
  it('pays MWK 10,000 per month actually deducted when no rate is supplied (back-compat default)', () => {
    expect(calculateUniformRefund(6)).toBe(60000);
  });

  it('returns 0 for zero or negative months', () => {
    expect(calculateUniformRefund(0)).toBe(0);
    expect(calculateUniformRefund(-1)).toBe(0);
  });

  it('uses the CURRENT approved rate for every eligible month, never a historical rate', () => {
    // Confirmed business policy example: historical rate was MK 5,000,
    // current approved rate is MK 10,000, 7 eligible months -> MK 70,000
    // (months x CURRENT rate, not a sum of historical amounts).
    expect(calculateUniformRefund(7, 10000)).toBe(70000);
  });

  it('applies a different current rate when one is supplied', () => {
    expect(calculateUniformRefund(6, 5000)).toBe(30000);
  });

  it('defaults to DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH when no rate argument is given', () => {
    expect(calculateUniformRefund(4)).toBe(4 * DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH);
  });
});

describe('uniformRefundNeedsCorrectionReason', () => {
  it('never requires a reason when there is no payroll evidence at all (fully historical)', () => {
    expect(uniformRefundNeedsCorrectionReason(null, 5)).toBe(false);
  });

  it('requires a reason only when the entered count disagrees with reliable evidence', () => {
    expect(uniformRefundNeedsCorrectionReason(6, 6)).toBe(false);
    expect(uniformRefundNeedsCorrectionReason(6, 4)).toBe(true);
  });
});

describe('pensionMonthsOverrideNeedsCorrectionReason', () => {
  it('never requires a reason when no override was supplied', () => {
    expect(pensionMonthsOverrideNeedsCorrectionReason(72, null)).toBe(false);
    expect(pensionMonthsOverrideNeedsCorrectionReason(72, undefined)).toBe(false);
  });

  it('never requires a reason when the override matches the system calculation', () => {
    expect(pensionMonthsOverrideNeedsCorrectionReason(72, 72)).toBe(false);
  });

  it('requires a reason only when the override disagrees with the system calculation', () => {
    expect(pensionMonthsOverrideNeedsCorrectionReason(72, 70)).toBe(true);
  });

  it('ignores a non-finite override', () => {
    expect(pensionMonthsOverrideNeedsCorrectionReason(72, NaN)).toBe(false);
  });
});

describe('calculateOutstandingSalaryEntries', () => {
  it('computes the owed/paid difference for a fully unpaid month', () => {
    const { entries, total } = calculateOutstandingSalaryEntries([
      { month: '2026-03', amountOwed: 150000, amountPaid: 0 },
    ]);
    expect(entries[0].outstanding).toBe(150000);
    expect(total).toBe(150000);
  });

  it('computes the owed/paid difference for a partially paid month', () => {
    const { entries, total } = calculateOutstandingSalaryEntries([
      { month: '2026-04', amountOwed: 150000, amountPaid: 100000 },
    ]);
    expect(entries[0].outstanding).toBe(50000);
    expect(total).toBe(50000);
  });

  it('sums multiple distinct unpaid months', () => {
    const { total } = calculateOutstandingSalaryEntries([
      { month: '2026-03', amountOwed: 150000, amountPaid: 0 },
      { month: '2026-04', amountOwed: 150000, amountPaid: 100000 },
      { month: '2026-05', amountOwed: 150000, amountPaid: 150000 },
    ]);
    expect(total).toBe(150000 + 50000 + 0);
  });

  it('preserves a negative (overpaid) entry rather than clamping it to zero', () => {
    const { entries, total } = calculateOutstandingSalaryEntries([
      { month: '2026-03', amountOwed: 100000, amountPaid: 120000 },
    ]);
    expect(entries[0].outstanding).toBe(-20000);
    expect(total).toBe(-20000);
  });
});

describe('findOutstandingSalaryDoubleCountWarnings', () => {
  it('flags an entry whose month is already known to be settled elsewhere', () => {
    const warnings = findOutstandingSalaryDoubleCountWarnings(
      [
        { month: '2026-03', amountOwed: 150000, amountPaid: 0 },
        { month: '2026-04', amountOwed: 150000, amountPaid: 0 },
      ],
      ['2026-03']
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('2026-03');
  });

  it('returns no warnings when nothing overlaps', () => {
    expect(
      findOutstandingSalaryDoubleCountWarnings([{ month: '2026-03', amountOwed: 150000, amountPaid: 0 }], [])
    ).toHaveLength(0);
  });
});

describe('calculateLessNoticeDeduction', () => {
  const finalSalary = 150000;

  it('deducts nothing for on-time notice', () => {
    expect(calculateLessNoticeDeduction({ requiredNoticeDays: 26, status: 'on_time', finalSalary })).toBe(0);
  });

  it('deducts one full monthly salary for no notice at all', () => {
    expect(calculateLessNoticeDeduction({ requiredNoticeDays: 26, status: 'none', finalSalary })).toBe(150000);
  });

  it('deducts ceil(lateDays x salary / 26) for late notice', () => {
    expect(
      calculateLessNoticeDeduction({ requiredNoticeDays: 26, status: 'late', lateNoticeDays: 13, finalSalary })
    ).toBe(Math.ceil((13 * finalSalary) / 26));
  });

  it('caps the late-notice deduction at exactly one monthly salary, even if the raw formula exceeds it', () => {
    // 30 late days against a 26-day policy would mathematically exceed
    // one month's salary -- must be capped, not allowed to overshoot.
    expect(
      calculateLessNoticeDeduction({ requiredNoticeDays: 26, status: 'late', lateNoticeDays: 30, finalSalary })
    ).toBe(150000);
  });

  it('treats a missing or negative lateNoticeDays as zero late days', () => {
    expect(calculateLessNoticeDeduction({ requiredNoticeDays: 26, status: 'late', finalSalary })).toBe(0);
    expect(
      calculateLessNoticeDeduction({ requiredNoticeDays: 26, status: 'late', lateNoticeDays: -5, finalSalary })
    ).toBe(0);
  });
});

describe('calculateTerminalDuesBreakdown', () => {
  const validInputs = {
    dateJoined: '2020-01-15',
    dateLeft: '2026-01-15',
    finalSalary: 150000,
    unusedLeaveDays: 10,
    uniformDeductionMonths: 6,
    outstandingSalaryEntries: [{ month: '2026-01', amountOwed: 150000, amountPaid: 0 }],
    noticeStatus: 'on_time' as const,
  };

  it('returns a validation error when dateLeft does not come after dateJoined', () => {
    const result = calculateTerminalDuesBreakdown({ ...validInputs, dateLeft: '2020-01-15' });
    expect(isTerminalDuesValidationError(result)).toBe(true);
  });

  it('returns a validation error when final salary is not positive', () => {
    const result = calculateTerminalDuesBreakdown({ ...validInputs, finalSalary: 0 });
    expect(isTerminalDuesValidationError(result)).toBe(true);
  });

  it('sums every entitlement component with no deduction (on-time notice)', () => {
    const result = calculateTerminalDuesBreakdown(validInputs);
    if (isTerminalDuesValidationError(result)) throw new Error('expected a successful breakdown');

    const expectedPension = Math.ceil(72 * 150000 * 0.1);
    const expectedLeave = Math.ceil((10 * 150000) / 26);
    const expectedUniform = 60000;
    const expectedOutstanding = 150000;

    expect(result.pensionArrears).toBe(expectedPension);
    expect(result.annualLeaveRefund).toBe(expectedLeave);
    expect(result.uniformRefund).toBe(expectedUniform);
    expect(result.outstandingSalaryTotal).toBe(expectedOutstanding);
    expect(result.lessNoticeDeduction).toBe(0);
    expect(result.totalEntitlements).toBe(expectedPension + expectedLeave + expectedUniform + expectedOutstanding);
    expect(result.totalPayable).toBe(result.totalEntitlements);
    expect(result.excessDeduction).toBe(0);
  });

  it('floors total payable at zero and preserves the excess as a reviewable amount, never going negative', () => {
    const result = calculateTerminalDuesBreakdown({
      ...validInputs,
      // A short, just-started tenure with heavy unpaid "no notice" deduction
      // should easily exceed the small entitlement total.
      dateJoined: '2026-01-01',
      dateLeft: '2026-01-20',
      unusedLeaveDays: 0,
      uniformDeductionMonths: 0,
      outstandingSalaryEntries: [],
      noticeStatus: 'none',
    });
    if (isTerminalDuesValidationError(result)) throw new Error('expected a successful breakdown');

    expect(result.totalEntitlements).toBe(0); // 0 completed months -> no pension, nothing else entered
    expect(result.totalDeductions).toBe(150000); // one full month's salary, no notice given
    expect(result.rawPayable).toBe(-150000);
    expect(result.totalPayable).toBe(0);
    expect(result.excessDeduction).toBe(150000);
  });

  it('defaults the uniform refund to the current flat rate when no rate is supplied', () => {
    const result = calculateTerminalDuesBreakdown(validInputs);
    if (isTerminalDuesValidationError(result)) throw new Error('expected a successful breakdown');
    expect(result.uniformRefund).toBe(60000); // 6 months x DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH
  });

  it('uses the supplied CURRENT approved rate for the whole uniform refund, regardless of any historical rate', () => {
    const result = calculateTerminalDuesBreakdown({
      ...validInputs,
      uniformDeductionMonths: 7,
      uniformRefundRatePerMonth: 10000, // the current approved rate
    });
    if (isTerminalDuesValidationError(result)) throw new Error('expected a successful breakdown');
    // Confirmed business policy example: 7 months x current rate (10,000) =
    // 70,000, even though the historical rate for some of those months was
    // MK 5,000 -- this breakdown never sees or sums a historical amount.
    expect(result.uniformRefund).toBe(70000);
  });
});
