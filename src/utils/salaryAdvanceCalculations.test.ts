import { describe, it, expect } from 'vitest';
import { calculateAdvanceSchedule, calculateMonthlyDeductionDue, calculatePooledAllocation, AdvanceScheduleValidationError } from './salaryAdvanceCalculations';

describe('calculateAdvanceSchedule', () => {
  describe('monthly_amount mode', () => {
    it('derives an exact repayment period when the amount divides evenly', () => {
      // MK 80,000 / MK 20,000 = exactly 4 deductions, from the task's own example.
      const result = calculateAdvanceSchedule({
        advanceAmount: 80000,
        repaymentMethod: 'monthly_amount',
        monthlyDeduction: 20000,
        deductionStartMonth: '2026-01',
      });
      expect(result.repaymentPeriodMonths).toBe(4);
      expect(result.configuredMonthlyDeduction).toBe(20000);
      expect(result.finalDeductionAmount).toBe(20000);
      expect(result.expectedPayoffMonth).toBe('2026-04');
    });

    it('derives a smaller final installment when the amount does not divide evenly', () => {
      const result = calculateAdvanceSchedule({
        advanceAmount: 80000,
        repaymentMethod: 'monthly_amount',
        monthlyDeduction: 30000,
        deductionStartMonth: '2026-01',
      });
      expect(result.repaymentPeriodMonths).toBe(3);
      expect(result.configuredMonthlyDeduction).toBe(30000);
      expect(result.finalDeductionAmount).toBe(20000); // 80000 - 30000*2
      // The sum of all deductions must equal the advance exactly.
      expect(result.configuredMonthlyDeduction * (result.repaymentPeriodMonths - 1) + result.finalDeductionAmount).toBe(80000);
    });

    it('rejects a non-positive monthly deduction', () => {
      expect(() => calculateAdvanceSchedule({
        advanceAmount: 50000, repaymentMethod: 'monthly_amount', monthlyDeduction: 0, deductionStartMonth: '2026-01',
      })).toThrow(AdvanceScheduleValidationError);
      expect(() => calculateAdvanceSchedule({
        advanceAmount: 50000, repaymentMethod: 'monthly_amount', monthlyDeduction: -1000, deductionStartMonth: '2026-01',
      })).toThrow(AdvanceScheduleValidationError);
    });
  });

  describe('repayment_period mode', () => {
    it('derives an exact monthly deduction when the period divides evenly', () => {
      const result = calculateAdvanceSchedule({
        advanceAmount: 90000,
        repaymentMethod: 'repayment_period',
        repaymentPeriodMonths: 3,
        deductionStartMonth: '2026-01',
      });
      expect(result.configuredMonthlyDeduction).toBe(30000);
      expect(result.finalDeductionAmount).toBe(30000);
    });

    it('rounds the regular installment down and puts the remainder in the final deduction', () => {
      const result = calculateAdvanceSchedule({
        advanceAmount: 100000,
        repaymentMethod: 'repayment_period',
        repaymentPeriodMonths: 3,
        deductionStartMonth: '2026-01',
      });
      // 100000 / 3 = 33333.33 -> floors to 33333, final absorbs the remainder.
      expect(result.configuredMonthlyDeduction).toBe(33333);
      expect(result.finalDeductionAmount).toBe(33334);
      expect(result.configuredMonthlyDeduction * 2 + result.finalDeductionAmount).toBe(100000);
    });

    it('rejects a non-positive or non-integer period', () => {
      expect(() => calculateAdvanceSchedule({
        advanceAmount: 50000, repaymentMethod: 'repayment_period', repaymentPeriodMonths: 0, deductionStartMonth: '2026-01',
      })).toThrow(AdvanceScheduleValidationError);
      expect(() => calculateAdvanceSchedule({
        advanceAmount: 50000, repaymentMethod: 'repayment_period', repaymentPeriodMonths: 2.5, deductionStartMonth: '2026-01',
      })).toThrow(AdvanceScheduleValidationError);
    });

    it('rejects a period so long the monthly deduction would round to zero', () => {
      expect(() => calculateAdvanceSchedule({
        advanceAmount: 5, repaymentMethod: 'repayment_period', repaymentPeriodMonths: 12, deductionStartMonth: '2026-01',
      })).toThrow(AdvanceScheduleValidationError);
    });
  });

  it('rejects a non-positive advance amount regardless of mode', () => {
    expect(() => calculateAdvanceSchedule({
      advanceAmount: 0, repaymentMethod: 'monthly_amount', monthlyDeduction: 1000, deductionStartMonth: '2026-01',
    })).toThrow(AdvanceScheduleValidationError);
    expect(() => calculateAdvanceSchedule({
      advanceAmount: -5000, repaymentMethod: 'repayment_period', repaymentPeriodMonths: 3, deductionStartMonth: '2026-01',
    })).toThrow(AdvanceScheduleValidationError);
  });

  it('rejects a malformed deduction start month', () => {
    expect(() => calculateAdvanceSchedule({
      advanceAmount: 50000, repaymentMethod: 'monthly_amount', monthlyDeduction: 10000, deductionStartMonth: 'not-a-month',
    })).toThrow(AdvanceScheduleValidationError);
  });

  it('never produces NaN or Infinity in any output field', () => {
    const result = calculateAdvanceSchedule({
      advanceAmount: 123456.78,
      repaymentMethod: 'repayment_period',
      repaymentPeriodMonths: 7,
      deductionStartMonth: '2026-06',
    });
    for (const value of [result.advanceAmount, result.configuredMonthlyDeduction, result.repaymentPeriodMonths, result.finalDeductionAmount]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Number.isNaN(value)).toBe(false);
    }
  });
});

describe('calculateMonthlyDeductionDue', () => {
  it('deducts the full configured amount when balance comfortably covers it', () => {
    expect(calculateMonthlyDeductionDue(20000, 60000)).toBe(20000);
  });

  it('caps the deduction at the remaining balance for the final installment', () => {
    // From the task's own example: remaining 6,000, configured 20,000 -> deduct only 6,000.
    expect(calculateMonthlyDeductionDue(20000, 6000)).toBe(6000);
  });

  it('deducts zero once the balance is already exhausted', () => {
    expect(calculateMonthlyDeductionDue(20000, 0)).toBe(0);
    expect(calculateMonthlyDeductionDue(20000, -1)).toBe(0);
  });
});

describe('calculatePooledAllocation', () => {
  it('allocates a single open advance exactly as calculateMonthlyDeductionDue would', () => {
    const { total, allocations } = calculatePooledAllocation(20000, [
      { id: 'a1', remainingBalance: 60000, applicationDate: '2026-01-01' },
    ]);
    expect(total).toBe(20000);
    expect(allocations.get('a1')).toBe(20000);
  });

  it('the correction\'s own worked example: a single combined figure, oldest-first, exhausts before the younger one starts', () => {
    // Advance #1 outstanding = 60,000, Advance #2 = 40,000 (total 100,000).
    // Management chooses ONE combined figure of 25,000/month -- NOT the
    // sum of any per-advance rate.
    const advances = [
      { id: 'older', remainingBalance: 60000, applicationDate: '2026-01-01' },
      { id: 'younger', remainingBalance: 40000, applicationDate: '2026-02-01' },
    ];
    const month1 = calculatePooledAllocation(25000, advances);
    expect(month1.total).toBe(25000);
    expect(month1.allocations.get('older')).toBe(25000); // the whole combined figure, since it doesn't exhaust the oldest
    expect(month1.allocations.get('younger')).toBe(0); // nothing left in the pool this month
  });

  it('the correction\'s own worked example: leftover from the older advance finishing spills to the younger one the SAME month', () => {
    // Advance #1 remaining = 10,000, Advance #2 remaining = 30,000,
    // combined monthly repayment = 20,000 -- from the correction's exact example.
    const result = calculatePooledAllocation(20000, [
      { id: 'older', remainingBalance: 10000, applicationDate: '2026-01-01' },
      { id: 'younger', remainingBalance: 30000, applicationDate: '2026-02-01' },
    ]);
    expect(result.allocations.get('older')).toBe(10000);
    expect(result.allocations.get('younger')).toBe(10000);
    expect(result.total).toBe(20000);
  });

  it('processes oldest advance first even when array order is reversed, with NO per-advance rate cap', () => {
    const result = calculatePooledAllocation(20000, [
      { id: 'younger', remainingBalance: 30000, applicationDate: '2026-02-01' },
      { id: 'older', remainingBalance: 5000, applicationDate: '2026-01-01' },
    ]);
    // Older advance (remaining 5,000) is funded first and finishes; the
    // ENTIRE leftover (20,000 - 5,000 = 15,000) goes to the younger one --
    // no per-advance rate caps it anymore, only its own remaining balance.
    expect(result.allocations.get('older')).toBe(5000);
    expect(result.allocations.get('younger')).toBe(15000);
    expect(result.total).toBe(20000);
  });

  it('never allocates more than the combined monthly figure in total', () => {
    const result = calculatePooledAllocation(80000, [
      { id: 'a', remainingBalance: 200000, applicationDate: '2026-01-01' },
      { id: 'b', remainingBalance: 200000, applicationDate: '2026-01-02' },
    ]);
    expect(result.total).toBe(80000); // exactly the combined figure, both far from exhausted
  });

  it('returns an empty allocation with zero total for no open advances', () => {
    const result = calculatePooledAllocation(20000, []);
    expect(result.total).toBe(0);
    expect(result.allocations.size).toBe(0);
  });

  it('returns zero for every advance when the combined monthly figure is zero (e.g. no plan exists yet)', () => {
    const result = calculatePooledAllocation(0, [
      { id: 'a', remainingBalance: 60000, applicationDate: '2026-01-01' },
    ]);
    expect(result.total).toBe(0);
    expect(result.allocations.get('a')).toBe(0);
  });

  it('never produces a negative or NaN allocation for any advance', () => {
    const result = calculatePooledAllocation(10000, [
      { id: 'a', remainingBalance: 0, applicationDate: '2026-01-01' },
      { id: 'b', remainingBalance: -500, applicationDate: '2026-01-02' },
    ]);
    for (const value of [...result.allocations.values(), result.total]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
