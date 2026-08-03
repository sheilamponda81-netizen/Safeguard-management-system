import { describe, it, expect } from 'vitest';
import { calculateLivePayroll, LivePayrollInputs } from './payrollCalculations';
import { DEFAULT_RATES } from './payrollSettings';

// calculateLivePayroll is the single source of truth Payroll.tsx and
// Payments.tsx both delegate to (see the comment on the function itself),
// so this is the highest-value target for locking in current behavior:
// any future change to it affects both pages identically, for better or
// worse, and a regression here is a real payroll-correctness bug.
//
// These tests intentionally do NOT change DEFAULT_RATES or the formula
// itself -- they document and verify EXISTING behavior, per the standing
// rule against altering payroll/tax/pension logic without a confirmed
// business source. If one of these tests fails after a future change,
// that's a signal to go confirm whether the change was intentional, not
// to "fix" the test to match.

const positionsRequiringUniform = new Map<string, boolean>([
  ['Guard', true],
  ['Office Assistant', false],
]);

function baseInputs(overrides: Partial<LivePayrollInputs> = {}): LivePayrollInputs {
  return {
    basicSalary: 100000,
    position: 'Guard',
    positionsRequiringUniform,
    payrollRates: DEFAULT_RATES,
    ...overrides,
  };
}

describe('calculateLivePayroll', () => {
  it('computes gross pay as the sum of basic salary, allowances, overtime, and bonus', () => {
    const result = calculateLivePayroll(baseInputs({ basicSalary: 100000, allowances: 5000, overtime: 2000, bonus: 1000 }));
    expect(result.grossPay).toBe(108000);
  });

  it('defaults allowances/overtime/bonus to 0 when omitted', () => {
    const result = calculateLivePayroll(baseInputs({ basicSalary: 100000 }));
    expect(result.grossPay).toBe(100000);
  });

  describe('PAYE', () => {
    it('is 0 when gross pay is at or below the PAYE threshold', () => {
      const result = calculateLivePayroll(baseInputs({ basicSalary: DEFAULT_RATES.payeThreshold }));
      expect(result.paye).toBe(0);
    });

    it('is 0 for gross pay below the threshold (no negative PAYE)', () => {
      const result = calculateLivePayroll(baseInputs({ basicSalary: DEFAULT_RATES.payeThreshold - 10000 }));
      expect(result.paye).toBe(0);
    });

    it('taxes only the amount above the threshold, at payeRate', () => {
      // gross 80,000, threshold 50,000 -> taxable 30,000 * 0.30 = 9,000
      const result = calculateLivePayroll(baseInputs({ basicSalary: 80000 }));
      expect(result.paye).toBe(Math.round((80000 - DEFAULT_RATES.payeThreshold) * DEFAULT_RATES.payeRate));
    });

    it('rounds to the nearest whole currency unit', () => {
      // Pick a gross pay whose taxable amount * rate isn't a whole number.
      const result = calculateLivePayroll(baseInputs({ basicSalary: 50001 }));
      expect(Number.isInteger(result.paye)).toBe(true);
    });
  });

  describe('pension', () => {
    it('is grossPay * pensionEmployeeRate, rounded', () => {
      const result = calculateLivePayroll(baseInputs({ basicSalary: 100000 }));
      expect(result.pension).toBe(Math.round(100000 * DEFAULT_RATES.pensionEmployeeRate));
    });

    it('applies even below the PAYE threshold (pension has no threshold)', () => {
      const result = calculateLivePayroll(baseInputs({ basicSalary: 10000 }));
      expect(result.pension).toBe(Math.round(10000 * DEFAULT_RATES.pensionEmployeeRate));
    });
  });

  describe('uniform deduction eligibility', () => {
    it('applies the default uniform deduction for a position that requires one', () => {
      const result = calculateLivePayroll(baseInputs({ position: 'Guard', employeeUniformDeduction: undefined }));
      expect(result.uniformDeduction).toBe(DEFAULT_RATES.uniformDeduction);
    });

    it('uses the employee-specific uniform deduction override when provided', () => {
      const result = calculateLivePayroll(baseInputs({ position: 'Guard', employeeUniformDeduction: 7500 }));
      expect(result.uniformDeduction).toBe(7500);
    });

    it('is 0 for a position that does not require a uniform, even with an override set', () => {
      const result = calculateLivePayroll(baseInputs({ position: 'Office Assistant', employeeUniformDeduction: 7500 }));
      expect(result.uniformDeduction).toBe(0);
    });

    it('defaults an unlisted position to requiring a uniform (fail-safe, matches the `?? true` in the implementation)', () => {
      const result = calculateLivePayroll(baseInputs({ position: 'Some New Role Not In The Map' }));
      expect(result.uniformDeduction).toBe(DEFAULT_RATES.uniformDeduction);
    });
  });

  describe('attendance deductions', () => {
    it('adds absentDays * absentDeduction and lateDays * lateDeduction into the uniform/deduction total', () => {
      const withoutAttendance = calculateLivePayroll(baseInputs({ position: 'Office Assistant' }));
      const withAttendance = calculateLivePayroll(baseInputs({
        position: 'Office Assistant',
        attendance: { absentDays: 2, lateDays: 1 },
      }));
      const expectedExtra = 2 * DEFAULT_RATES.absentDeduction + 1 * DEFAULT_RATES.lateDeduction;
      expect(withAttendance.uniformDeduction - withoutAttendance.uniformDeduction).toBe(expectedExtra);
    });

    it('adds lectureDeduction and appearanceDeduction when supplied', () => {
      const result = calculateLivePayroll(baseInputs({
        position: 'Office Assistant',
        lectureDeduction: 3000,
        appearanceDeduction: 2000,
      }));
      expect(result.uniformDeduction).toBe(5000);
    });

    it('treats missing attendance/lecture/appearance data as zero, not an error', () => {
      const result = calculateLivePayroll(baseInputs({ position: 'Office Assistant' }));
      expect(result.uniformDeduction).toBe(0);
    });
  });

  describe('net pay', () => {
    it('is grossPay minus paye, pension, and the combined uniform/attendance deduction', () => {
      const result = calculateLivePayroll(baseInputs({ basicSalary: 100000, position: 'Office Assistant' }));
      expect(result.netPay).toBe(result.grossPay - result.paye - result.pension - result.uniformDeduction);
    });

    it('can go negative when deductions exceed gross pay -- not clamped to zero', () => {
      // A very low salary with heavy attendance deductions should be able to
      // produce a negative net pay; this documents that calculateLivePayroll
      // does not clamp it, matching the audit brief's explicit call to test
      // "negative net pay" as a real scenario rather than assume it's blocked.
      const result = calculateLivePayroll(baseInputs({
        basicSalary: 1000,
        position: 'Guard',
        attendance: { absentDays: 10, lateDays: 10 },
      }));
      expect(result.netPay).toBeLessThan(0);
    });
  });

  describe('edge cases', () => {
    it('handles a zero basic salary without throwing', () => {
      const result = calculateLivePayroll(baseInputs({ basicSalary: 0, position: 'Office Assistant' }));
      expect(result.grossPay).toBe(0);
      expect(result.paye).toBe(0);
      expect(result.pension).toBe(0);
    });

    it('handles a very large basic salary without overflow/precision loss for this value range', () => {
      const result = calculateLivePayroll(baseInputs({ basicSalary: 50_000_000, position: 'Office Assistant' }));
      expect(result.grossPay).toBe(50_000_000);
      expect(Number.isFinite(result.paye)).toBe(true);
      expect(Number.isFinite(result.netPay)).toBe(true);
    });

    it('does not change gross pay based on a negative basic salary being passed through as-is (no input validation in this function -- callers must validate)', () => {
      // Documents current behavior: this function performs no validation of
      // its own. A negative basicSalary flows straight through into gross
      // pay. Whether negative salaries should be possible at all is a
      // business-rule/UI-validation question, not something this function
      // decides -- flagged in AUDIT_REPORT.md, not silently "fixed" here.
      const result = calculateLivePayroll(baseInputs({ basicSalary: -5000, position: 'Office Assistant' }));
      expect(result.grossPay).toBe(-5000);
    });
  });
});
