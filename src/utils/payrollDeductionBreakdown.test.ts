import { describe, it, expect } from 'vitest';
import { buildPayrollDeductionBreakdown, PayrollDeductionBreakdownEmployeeInput } from './payrollDeductionBreakdown';

function employee(overrides: Partial<PayrollDeductionBreakdownEmployeeInput> = {}): PayrollDeductionBreakdownEmployeeInput {
  return {
    paye: 0,
    pension: 0,
    uniformAndAttendanceTotal: 0,
    salaryAdvanceDeduction: 0,
    attendanceRecord: null,
    lectureDeduction: 0,
    appearanceDeduction: 0,
    ...overrides,
  };
}

describe('buildPayrollDeductionBreakdown', () => {
  it('splits a fully itemized employee into exact categories that reconcile', () => {
    const result = buildPayrollDeductionBreakdown([
      employee({
        paye: 50000,
        pension: 20000,
        uniformAndAttendanceTotal: 10000 + 4200 * 2 + 3000 + 2000, // absent(1 day)=10000 + late(2 days) + lecture + appearance
        salaryAdvanceDeduction: 15000,
        attendanceRecord: { absent_days: 1, late_days: 2, absent_deduction: 10000, late_deduction: 8400 },
        lectureDeduction: 3000,
        appearanceDeduction: 2000,
      }),
    ]);

    expect(result.payeTotal).toBe(50000);
    expect(result.pensionTotal).toBe(20000);
    expect(result.absenceTotal).toBe(10000);
    expect(result.lateTotal).toBe(8400);
    expect(result.lectureTotal).toBe(3000);
    expect(result.appearanceTotal).toBe(2000);
    expect(result.uniformOnlyTotal).toBe(0); // bundled total exactly equals the itemized parts here
    expect(result.salaryAdvanceTotal).toBe(15000);
    expect(result.unitemizedUniformAndAttendanceTotal).toBe(0);
    expect(result.employeesWithoutItemizedBreakdown).toBe(0);
    expect(result.reconciles).toBe(true);
  });

  it('derives a non-zero uniform-only remainder when the bundle exceeds the itemized parts', () => {
    const result = buildPayrollDeductionBreakdown([
      employee({
        paye: 0,
        pension: 0,
        uniformAndAttendanceTotal: 10000 + 8400 + 15000, // absent + late + uniform itself
        attendanceRecord: { absent_days: 1, late_days: 2, absent_deduction: 10000, late_deduction: 8400 },
        lectureDeduction: 0,
        appearanceDeduction: 0,
      }),
    ]);
    expect(result.absenceTotal).toBe(10000);
    expect(result.lateTotal).toBe(8400);
    expect(result.uniformOnlyTotal).toBe(15000);
    expect(result.reconciles).toBe(true);
  });

  it('never invents a split for an employee with no employee_deductions row -- shows an explicit unitemized bucket instead', () => {
    const result = buildPayrollDeductionBreakdown([
      employee({ uniformAndAttendanceTotal: 42000, attendanceRecord: null }),
    ]);
    expect(result.absenceTotal).toBe(0);
    expect(result.lateTotal).toBe(0);
    expect(result.lectureTotal).toBe(0);
    expect(result.appearanceTotal).toBe(0);
    expect(result.uniformOnlyTotal).toBe(0);
    expect(result.unitemizedUniformAndAttendanceTotal).toBe(42000);
    expect(result.employeesWithoutItemizedBreakdown).toBe(1);
    expect(result.reconciles).toBe(true);
  });

  it('does not count an employee with zero bundled deductions and no record as "missing a breakdown"', () => {
    const result = buildPayrollDeductionBreakdown([employee({ uniformAndAttendanceTotal: 0, attendanceRecord: null })]);
    expect(result.employeesWithoutItemizedBreakdown).toBe(0);
    expect(result.unitemizedUniformAndAttendanceTotal).toBe(0);
  });

  it('aggregates multiple employees -- itemized and unitemized -- without double counting', () => {
    const result = buildPayrollDeductionBreakdown([
      employee({
        paye: 30000,
        pension: 10000,
        uniformAndAttendanceTotal: 10000,
        attendanceRecord: { absent_days: 1, late_days: 0, absent_deduction: 10000, late_deduction: 0 },
      }),
      employee({
        paye: 20000,
        pension: 5000,
        uniformAndAttendanceTotal: 10000,
        attendanceRecord: null,
      }),
    ]);
    expect(result.payeTotal).toBe(50000);
    expect(result.pensionTotal).toBe(15000);
    expect(result.absenceTotal).toBe(10000);
    expect(result.unitemizedUniformAndAttendanceTotal).toBe(10000);
    expect(result.employeesWithoutItemizedBreakdown).toBe(1);
    expect(result.grandTotal).toBe(30000 + 10000 + 10000 + 20000 + 5000 + 10000);
    expect(result.categorizedTotal).toBe(result.grandTotal);
    expect(result.reconciles).toBe(true);
  });

  it('includes salary advance deductions as their own category, separate from uniform/attendance', () => {
    const result = buildPayrollDeductionBreakdown([
      employee({ salaryAdvanceDeduction: 25000, uniformAndAttendanceTotal: 0 }),
    ]);
    expect(result.salaryAdvanceTotal).toBe(25000);
    expect(result.grandTotal).toBe(25000);
    expect(result.reconciles).toBe(true);
  });

  it('returns all-zero, reconciling totals for an empty employee list', () => {
    const result = buildPayrollDeductionBreakdown([]);
    expect(result.grandTotal).toBe(0);
    expect(result.categorizedTotal).toBe(0);
    expect(result.reconciles).toBe(true);
  });

  it('has no hygiene-deduction field or category anywhere in its output', () => {
    const result = buildPayrollDeductionBreakdown([employee({ uniformAndAttendanceTotal: 5000 })]);
    expect(Object.keys(result).some(k => k.toLowerCase().includes('hygiene'))).toBe(false);
  });
});
