import { describe, it, expect } from 'vitest';
import {
  buildPayrollDeductionBreakdown,
  deriveItemizedAttendanceDeduction,
  PayrollDeductionBreakdownEmployeeInput,
  ItemizedAttendanceDeductionAmounts,
} from './payrollDeductionBreakdown';

function employee(overrides: Partial<PayrollDeductionBreakdownEmployeeInput> = {}): PayrollDeductionBreakdownEmployeeInput {
  return {
    paye: 0,
    pension: 0,
    uniformAndAttendanceTotal: 0,
    salaryAdvanceDeduction: 0,
    itemized: null,
    ...overrides,
  };
}

function itemized(overrides: Partial<ItemizedAttendanceDeductionAmounts> = {}): ItemizedAttendanceDeductionAmounts {
  return { absenceDeduction: 0, lateDeduction: 0, lectureDeduction: 0, appearanceDeduction: 0, ...overrides };
}

describe('deriveItemizedAttendanceDeduction', () => {
  it('a NOT-YET-PROCESSED employee is itemized from the LIVE attendanceCounts + live rates, never the frozen employee_deductions row -- this is the exact UAT defect: calculatePayroll() never reads employee_deductions for absence/late on a live preview, so this must match', () => {
    const result = deriveItemizedAttendanceDeduction({
      isProcessed: false,
      liveAttendance: { absentDays: 2, lateDays: 3 },
      frozenRecord: null, // no employee_deductions row exists yet for this unprocessed month
      lectureDeduction: 0,
      appearanceDeduction: 0,
      liveAbsentRate: 10000,
      liveLateRate: 4200,
    });
    expect(result).toEqual({ absenceDeduction: 20000, lateDeduction: 12600, lectureDeduction: 0, appearanceDeduction: 0 });
  });

  it('a not-yet-processed employee with zero live attendance days is itemized as a confirmed zero, never "not itemized"', () => {
    const result = deriveItemizedAttendanceDeduction({
      isProcessed: false,
      liveAttendance: null, // no map entry -- a succeeded fetch simply omitted this employee (0 days)
      frozenRecord: null,
      lectureDeduction: 0,
      appearanceDeduction: 0,
      liveAbsentRate: 10000,
      liveLateRate: 4200,
    });
    expect(result).toEqual({ absenceDeduction: 0, lateDeduction: 0, lectureDeduction: 0, appearanceDeduction: 0 });
  });

  it('a not-yet-processed employee still reads lecture/appearance from the employee_deductions row when one exists (these are entered independently of processing status)', () => {
    const result = deriveItemizedAttendanceDeduction({
      isProcessed: false,
      liveAttendance: { absentDays: 0, lateDays: 0 },
      frozenRecord: null,
      lectureDeduction: 3000,
      appearanceDeduction: 2000,
      liveAbsentRate: 10000,
      liveLateRate: 4200,
    });
    expect(result).toEqual({ absenceDeduction: 0, lateDeduction: 0, lectureDeduction: 3000, appearanceDeduction: 2000 });
  });

  it('an ALREADY-PROCESSED employee is itemized from the frozen employee_deductions row, ignoring the live rate/attendance entirely', () => {
    const result = deriveItemizedAttendanceDeduction({
      isProcessed: true,
      liveAttendance: { absentDays: 99, lateDays: 99 }, // must be ignored -- processed uses the frozen record only
      frozenRecord: { absent_days: 1, late_days: 2, absent_deduction: 8000, late_deduction: 8400 },
      lectureDeduction: 0,
      appearanceDeduction: 0,
      liveAbsentRate: 999999,
      liveLateRate: 999999,
    });
    expect(result).toEqual({ absenceDeduction: 8000, lateDeduction: 8400, lectureDeduction: 0, appearanceDeduction: 0 });
  });

  it('an already-processed employee with no frozen employee_deductions row has no reliable source -- returns null, never a guess', () => {
    const result = deriveItemizedAttendanceDeduction({
      isProcessed: true,
      liveAttendance: { absentDays: 5, lateDays: 5 },
      frozenRecord: null,
      lectureDeduction: 0,
      appearanceDeduction: 0,
      liveAbsentRate: 10000,
      liveLateRate: 4200,
    });
    expect(result).toBeNull();
  });
});

describe('buildPayrollDeductionBreakdown', () => {
  it('splits a fully itemized employee into exact categories that reconcile', () => {
    const result = buildPayrollDeductionBreakdown([
      employee({
        paye: 50000,
        pension: 20000,
        uniformAndAttendanceTotal: 10000 + 4200 * 2 + 3000 + 2000, // absent(1 day)=10000 + late(2 days) + lecture + appearance
        salaryAdvanceDeduction: 15000,
        itemized: itemized({ absenceDeduction: 10000, lateDeduction: 8400, lectureDeduction: 3000, appearanceDeduction: 2000 }),
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
        uniformAndAttendanceTotal: 10000 + 8400 + 15000, // absent + late + uniform itself
        itemized: itemized({ absenceDeduction: 10000, lateDeduction: 8400 }),
      }),
    ]);
    expect(result.absenceTotal).toBe(10000);
    expect(result.lateTotal).toBe(8400);
    expect(result.uniformOnlyTotal).toBe(15000);
    expect(result.reconciles).toBe(true);
  });

  it('reconciles the exact UAT-reported scenario: a not-yet-processed employee whose bundled total is entirely live-attendance-driven', () => {
    // Mirrors calculateLivePayroll(): uniformDeductionValue (10000, position
    // requires uniform, employee override none) + absentDeduction (1 day x
    // 10000) + lateDeduction (2 days x 4200), no lecture/appearance.
    const liveItemized = deriveItemizedAttendanceDeduction({
      isProcessed: false,
      liveAttendance: { absentDays: 1, lateDays: 2 },
      frozenRecord: null,
      lectureDeduction: 0,
      appearanceDeduction: 0,
      liveAbsentRate: 10000,
      liveLateRate: 4200,
    })!;
    const bundledTotal = 10000 + 1 * 10000 + 2 * 4200;
    const result = buildPayrollDeductionBreakdown([
      employee({ uniformAndAttendanceTotal: bundledTotal, itemized: liveItemized }),
    ]);
    expect(result.absenceTotal).toBe(10000);
    expect(result.lateTotal).toBe(8400);
    expect(result.uniformOnlyTotal).toBe(10000);
    expect(result.unitemizedUniformAndAttendanceTotal).toBe(0);
    expect(result.employeesWithoutItemizedBreakdown).toBe(0);
    expect(result.reconciles).toBe(true);
  });

  it('never invents a split for an already-processed employee with no employee_deductions row -- shows an explicit unitemized bucket instead', () => {
    const result = buildPayrollDeductionBreakdown([employee({ uniformAndAttendanceTotal: 42000, itemized: null })]);
    expect(result.absenceTotal).toBe(0);
    expect(result.lateTotal).toBe(0);
    expect(result.lectureTotal).toBe(0);
    expect(result.appearanceTotal).toBe(0);
    expect(result.uniformOnlyTotal).toBe(0);
    expect(result.unitemizedUniformAndAttendanceTotal).toBe(42000);
    expect(result.employeesWithoutItemizedBreakdown).toBe(1);
    expect(result.reconciles).toBe(true);
  });

  it('does not count an employee with zero bundled deductions and no itemization as "missing a breakdown"', () => {
    const result = buildPayrollDeductionBreakdown([employee({ uniformAndAttendanceTotal: 0, itemized: null })]);
    expect(result.employeesWithoutItemizedBreakdown).toBe(0);
    expect(result.unitemizedUniformAndAttendanceTotal).toBe(0);
  });

  it('aggregates multiple employees -- itemized and unitemized -- without double counting', () => {
    const result = buildPayrollDeductionBreakdown([
      employee({
        paye: 30000,
        pension: 10000,
        uniformAndAttendanceTotal: 10000,
        itemized: itemized({ absenceDeduction: 10000 }),
      }),
      employee({
        paye: 20000,
        pension: 5000,
        uniformAndAttendanceTotal: 10000,
        itemized: null,
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

  // ===== verifiedUniform (completion-pass review item 2): a snapshot's
  // own verified uniform-only figure takes priority over the usual bare
  // remainder, and an unresolved remainder is counted separately, never
  // folded into uniformOnlyTotal. =====
  describe('verifiedUniform', () => {
    it('uses the verified uniform amount instead of the bare remainder when present', () => {
      const result = buildPayrollDeductionBreakdown([
        employee({
          uniformAndAttendanceTotal: 4200,
          itemized: itemized({ absenceDeduction: 0 }),
          verifiedUniform: { uniformDeduction: 4200, unallocatedAmount: 0 },
        }),
      ]);
      expect(result.uniformOnlyTotal).toBe(4200);
      expect(result.unallocatedTotal).toBe(0);
      expect(result.employeesWithUnresolvedUniform).toBe(0);
      expect(result.reconciles).toBe(true);
    });

    it('counts an unresolved remainder under unallocatedTotal, never under uniformOnlyTotal', () => {
      const result = buildPayrollDeductionBreakdown([
        employee({
          uniformAndAttendanceTotal: 4200,
          itemized: itemized(),
          verifiedUniform: { uniformDeduction: 0, unallocatedAmount: 4200 },
        }),
      ]);
      expect(result.uniformOnlyTotal).toBe(0);
      expect(result.unallocatedTotal).toBe(4200);
      expect(result.employeesWithUnresolvedUniform).toBe(1);
      // categorizedTotal still reconciles with grandTotal -- the money
      // isn't lost, just honestly labeled as unresolved rather than Uniform.
      expect(result.categorizedTotal).toBe(result.grandTotal);
      expect(result.reconciles).toBe(true);
    });

    it('omitting verifiedUniform (legacy/employee_deductions-sourced employee) falls back to the original bare-remainder behavior unchanged', () => {
      const result = buildPayrollDeductionBreakdown([
        employee({
          uniformAndAttendanceTotal: 9200,
          itemized: itemized({ absenceDeduction: 5000 }),
          // verifiedUniform omitted entirely
        }),
      ]);
      expect(result.uniformOnlyTotal).toBe(4200);
      expect(result.unallocatedTotal).toBe(0);
    });

    it('a mix of verified, unresolved, and legacy employees all reconcile together', () => {
      const result = buildPayrollDeductionBreakdown([
        employee({ uniformAndAttendanceTotal: 4200, itemized: itemized(), verifiedUniform: { uniformDeduction: 4200, unallocatedAmount: 0 } }),
        employee({ uniformAndAttendanceTotal: 3000, itemized: itemized(), verifiedUniform: { uniformDeduction: 0, unallocatedAmount: 3000 } }),
        employee({ uniformAndAttendanceTotal: 9200, itemized: itemized({ absenceDeduction: 5000 }) }),
      ]);
      expect(result.uniformOnlyTotal).toBe(4200 + 0 + 4200);
      expect(result.unallocatedTotal).toBe(3000);
      expect(result.employeesWithUnresolvedUniform).toBe(1);
      expect(result.grandTotal).toBe(4200 + 3000 + 9200);
      expect(result.categorizedTotal).toBe(result.grandTotal);
      expect(result.reconciles).toBe(true);
    });
  });
});
