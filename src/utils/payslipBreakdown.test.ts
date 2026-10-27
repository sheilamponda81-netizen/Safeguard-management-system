import { describe, it, expect } from 'vitest';
import { checkPayslipReconciliation, buildItemizedAttendanceBreakdown, deriveUniformOnlyAmount } from './payslipBreakdown';

describe('checkPayslipReconciliation', () => {
  const baseInput = {
    grossPay: 300000,
    basicSalary: 280000,
    allowances: 10000,
    overtime: 5000,
    bonus: 5000,
    paye: 75000,
    pension: 15000,
    uniformDeduction: 10000,
    salaryAdvanceDeduction: 0,
    netPay: 200000,
  };

  it('reconciles when gross = sum of earnings and net = gross - deductions', () => {
    expect(checkPayslipReconciliation(baseInput)).toEqual({ grossReconciles: true, netReconciles: true, reconciles: true });
  });

  it('accounts for a nonzero salary advance deduction in the net reconciliation', () => {
    const result = checkPayslipReconciliation({ ...baseInput, salaryAdvanceDeduction: 20000, netPay: 180000 });
    expect(result.reconciles).toBe(true);
  });

  it('flags a gross_pay that does not match basic+allowances+overtime+bonus', () => {
    const result = checkPayslipReconciliation({ ...baseInput, grossPay: 999999 });
    expect(result.grossReconciles).toBe(false);
    expect(result.reconciles).toBe(false);
  });

  it('flags a net_pay inflated beyond what gross minus deductions supports -- the Part 6 tampering scenario', () => {
    const result = checkPayslipReconciliation({ ...baseInput, netPay: 500000 });
    expect(result.netReconciles).toBe(false);
    expect(result.reconciles).toBe(false);
  });

  it('tolerates integer rounding of 1 currency unit', () => {
    const result = checkPayslipReconciliation({ ...baseInput, netPay: 200000.6 });
    expect(result.reconciles).toBe(true);
  });
});

describe('buildItemizedAttendanceBreakdown', () => {
  it('returns available:false with no fabricated amounts when no employee_deductions row exists', () => {
    expect(buildItemizedAttendanceBreakdown(null)).toEqual({
      available: false, absentDays: 0, absentDeduction: 0, lateDays: 0, lateDeduction: 0,
    });
    expect(buildItemizedAttendanceBreakdown(undefined)).toEqual({
      available: false, absentDays: 0, absentDeduction: 0, lateDays: 0, lateDeduction: 0,
    });
  });

  it('uses the FROZEN stored absent_deduction/late_deduction amounts directly -- never a live-rate recomputation', () => {
    const result = buildItemizedAttendanceBreakdown({ absent_days: 3, absent_deduction: 9000, late_days: 1, late_deduction: 1500 });
    expect(result).toEqual({ available: true, absentDays: 3, absentDeduction: 9000, lateDays: 1, lateDeduction: 1500 });
  });

  it('treats a stored zero as a reliable fact (available:true), distinct from no row at all', () => {
    const result = buildItemizedAttendanceBreakdown({ absent_days: 0, absent_deduction: 0, late_days: 0, late_deduction: 0 });
    expect(result.available).toBe(true);
    expect(result.absentDeduction).toBe(0);
  });
});

describe('deriveUniformOnlyAmount', () => {
  it('derives the uniform-only remainder from the frozen total minus the other frozen components', () => {
    const breakdown = { available: true, absentDays: 2, absentDeduction: 4000, lateDays: 1, lateDeduction: 1000 };
    // total 10000 = 4000 absent + 1000 late + 500 lecture + 500 appearance + 4000 uniform
    expect(deriveUniformOnlyAmount(10000, breakdown, 500, 500)).toBe(4000);
  });

  it('returns 0 (never a negative or a live-rate guess) when no employee_deductions row exists for the month', () => {
    const breakdown = { available: false, absentDays: 0, absentDeduction: 0, lateDays: 0, lateDeduction: 0 };
    expect(deriveUniformOnlyAmount(10000, breakdown, 0, 0)).toBe(0);
  });

  it('floors at 0 rather than going negative if the frozen components exceed the stored total', () => {
    const breakdown = { available: true, absentDays: 2, absentDeduction: 6000, lateDays: 1, lateDeduction: 6000 };
    expect(deriveUniformOnlyAmount(10000, breakdown, 0, 0)).toBe(0);
  });

  it('does not change behavior when an employee has no uniform charge at all (remainder is exactly 0)', () => {
    const breakdown = { available: true, absentDays: 1, absentDeduction: 4000, lateDays: 0, lateDeduction: 0 };
    expect(deriveUniformOnlyAmount(4000, breakdown, 0, 0)).toBe(0);
  });
});
