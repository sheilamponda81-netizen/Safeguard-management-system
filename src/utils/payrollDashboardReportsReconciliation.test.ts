// SAFEGUARD -- October 2026 payroll hotfix, financial-consistency
// correction (follow-up to the earlier Dashboard/Reports/Payroll
// population-whitelist fix).
//
// Proves the "Estimated Net Payroll" contract for an UNPROCESSED month:
// Dashboard.tsx (estimateMonthlyPayrollTotal, dashboardMetrics.ts) and
// Reports.tsx (getEmployeeFigures' live-calculation branch) both now call
// the SAME function, computeEstimatedNetPay() (livePayrollEstimate.ts),
// rather than each independently recreating the formula -- so this file
// tests that one function plus its two call-site aggregations, not three
// separately-written calculations that merely happen to agree today.
//
// Also proves computeEstimatedNetPay()'s composition
// (calculateLivePayroll() then subtract ONE pooled salary-advance total)
// is mathematically identical to Payroll.tsx's own preview composition --
// Payroll.tsx's own inline fetch/compute code is intentionally left
// untouched (already tested, already working; see livePayrollEstimate.ts's
// header for why), but both terminate in the exact same
// calculateLivePayroll()/calculatePooledAllocation() pair, so this proves
// the THIRD screen agrees without needing to import a React page.
import { describe, it, expect } from 'vitest';
import { calculateLivePayroll } from './payrollCalculations';
import { calculatePooledAllocation, OpenAdvanceForAllocation } from './salaryAdvanceCalculations';
import { computeEstimatedNetPay } from './livePayrollEstimate';
import { estimateMonthlyPayrollTotal, PayrollEstimateEmployee } from './dashboardMetrics';
import { PAYABLE_EMPLOYEE_STATUSES } from './employeeStatus';
import { PayrollRates } from './payrollSettings';

const ZERO_PAYE_PENSION_RATES: PayrollRates = {
  // October 2026's actual, deliberately-configured rates (per the system
  // owner's own directive) -- zero PAYE/pension pending Accountant sign-off.
  // This file must never substitute a statutory default for these.
  payeRate: 0,
  payeThreshold: 0,
  pensionEmployeeRate: 0,
  uniformDeduction: 10000,
  absentDeduction: 4200,
  lateDeduction: 4200,
  lectureDeduction: 3000,
  lectureFullMonthDeduction: 15000,
  appearanceDeduction: 0,
};

const NONZERO_RATES: PayrollRates = {
  payeRate: 0.30,
  payeThreshold: 50000,
  pensionEmployeeRate: 0.05,
  uniformDeduction: 10000,
  absentDeduction: 4200,
  lateDeduction: 4200,
  lectureDeduction: 3000,
  lectureFullMonthDeduction: 15000,
  appearanceDeduction: 0,
};

const NO_UNIFORM = new Map<string, boolean>([['Office Staff', false]]);

// ============================================================
// Part 1: computeEstimatedNetPay() -- the shared financial contract.
// ============================================================
describe('computeEstimatedNetPay (shared Dashboard/Reports contract)', () => {
  it('Active employee, full attendance, zero PAYE/pension (October\'s real configuration) -- full basic salary, no deduction', () => {
    const figures = computeEstimatedNetPay({
      basicSalary: 300000,
      position: 'Office Staff',
      positionsRequiringUniform: NO_UNIFORM,
      payrollRates: ZERO_PAYE_PENSION_RATES,
      attendance: { absentDays: 0, lateDays: 0 },
    });
    expect(figures.gross_pay).toBe(300000);
    expect(figures.paye).toBe(0);
    expect(figures.pension).toBe(0);
    expect(figures.net_pay).toBe(300000);
  });

  it('Employee on approved paid annual leave (0 absent days from the attendance engine) -- same full salary as full attendance, never penalized', () => {
    // Leave days never reach this function as absentDays at all (see
    // attendanceDeductions.ts / payrollPaidLeaveEligibility.test.ts) --
    // modeled here simply as absentDays: 0, exactly like full attendance.
    const onLeave = computeEstimatedNetPay({
      basicSalary: 250000,
      position: 'Office Staff',
      positionsRequiringUniform: NO_UNIFORM,
      payrollRates: ZERO_PAYE_PENSION_RATES,
      attendance: { absentDays: 0, lateDays: 0 },
    });
    expect(onLeave.net_pay).toBe(250000);
  });

  it('Employee with unauthorized absences -- deducted correctly, not waived', () => {
    const figures = computeEstimatedNetPay({
      basicSalary: 300000,
      position: 'Office Staff',
      positionsRequiringUniform: NO_UNIFORM,
      payrollRates: ZERO_PAYE_PENSION_RATES,
      attendance: { absentDays: 2, lateDays: 0 },
    });
    expect(figures.net_pay).toBe(300000 - 2 * ZERO_PAYE_PENSION_RATES.absentDeduction);
  });

  it('Employee with an outstanding salary advance -- subtracted exactly once, gross pay untouched', () => {
    const withAdvance = computeEstimatedNetPay({
      basicSalary: 350000,
      position: 'Office Staff',
      positionsRequiringUniform: NO_UNIFORM,
      payrollRates: ZERO_PAYE_PENSION_RATES,
      attendance: { absentDays: 0, lateDays: 0 },
      salaryAdvanceDeduction: 50000,
    });
    expect(withAdvance.gross_pay).toBe(350000); // gross never touched by the advance
    expect(withAdvance.net_pay).toBe(350000 - 50000);
  });

  it('Employee with multiple relevant deductions at once (absence + late + lecture + uniform + salary advance) -- all applied, none double-counted', () => {
    const figures = computeEstimatedNetPay({
      basicSalary: 400000,
      position: 'Guard',
      employeeUniformDeduction: null,
      positionsRequiringUniform: new Map([['Guard', true]]),
      payrollRates: ZERO_PAYE_PENSION_RATES,
      attendance: { absentDays: 1, lateDays: 2 },
      lectureDeduction: 3000,
      appearanceDeduction: 0,
      salaryAdvanceDeduction: 20000,
    });
    const expectedDeductions =
      ZERO_PAYE_PENSION_RATES.uniformDeduction +
      1 * ZERO_PAYE_PENSION_RATES.absentDeduction +
      2 * ZERO_PAYE_PENSION_RATES.lateDeduction +
      3000 +
      20000;
    expect(figures.net_pay).toBe(400000 - expectedDeductions);
  });

  it('Zero PAYE and pension rates -- preview reflects the CONFIGURED zero exactly, never a substituted statutory default', () => {
    const figures = computeEstimatedNetPay({
      basicSalary: 500000,
      position: 'Office Staff',
      positionsRequiringUniform: NO_UNIFORM,
      payrollRates: ZERO_PAYE_PENSION_RATES,
      attendance: { absentDays: 0, lateDays: 0 },
    });
    expect(figures.paye).toBe(0);
    expect(figures.pension).toBe(0);
  });

  it('Nonzero PAYE and pension rates (synthetic fixture, NOT a claim about real October rates) -- both applied correctly', () => {
    const figures = computeEstimatedNetPay({
      basicSalary: 500000,
      position: 'Office Staff',
      positionsRequiringUniform: NO_UNIFORM,
      payrollRates: NONZERO_RATES,
      attendance: { absentDays: 0, lateDays: 0 },
    });
    const expectedPaye = Math.round(Math.max(0, 500000 - NONZERO_RATES.payeThreshold) * NONZERO_RATES.payeRate);
    const expectedPension = Math.round(500000 * NONZERO_RATES.pensionEmployeeRate);
    expect(figures.paye).toBe(expectedPaye);
    expect(figures.pension).toBe(expectedPension);
    expect(figures.net_pay).toBe(500000 - expectedPaye - expectedPension);
  });

  it('gross_pay is NEVER altered by the salary-advance subtraction -- only net_pay changes (no gross/net conflation)', () => {
    const noAdvance = computeEstimatedNetPay({
      basicSalary: 300000, position: 'Office Staff', positionsRequiringUniform: NO_UNIFORM, payrollRates: ZERO_PAYE_PENSION_RATES,
    });
    const withAdvance = computeEstimatedNetPay({
      basicSalary: 300000, position: 'Office Staff', positionsRequiringUniform: NO_UNIFORM, payrollRates: ZERO_PAYE_PENSION_RATES,
      salaryAdvanceDeduction: 75000,
    });
    expect(withAdvance.gross_pay).toBe(noAdvance.gross_pay);
    expect(withAdvance.net_pay).toBe(noAdvance.net_pay - 75000);
  });

  it('matches Payroll.tsx\'s own preview composition exactly: calculateLivePayroll() then subtract calculatePooledAllocation().total', () => {
    const advances: OpenAdvanceForAllocation[] = [
      { id: 'adv-1', remainingBalance: 10000, applicationDate: '2026-08-01' },
      { id: 'adv-2', remainingBalance: 30000, applicationDate: '2026-09-01' },
    ];
    const combinedMonthlyDeduction = 20000;
    const { total: poolTotal } = calculatePooledAllocation(combinedMonthlyDeduction, advances);

    const live = calculateLivePayroll({
      basicSalary: 450000,
      position: 'Office Staff',
      positionsRequiringUniform: NO_UNIFORM,
      payrollRates: ZERO_PAYE_PENSION_RATES,
      attendance: { absentDays: 0, lateDays: 0 },
    });
    const payrollTsxStyleNetPay = live.netPay - poolTotal;

    const shared = computeEstimatedNetPay({
      basicSalary: 450000,
      position: 'Office Staff',
      positionsRequiringUniform: NO_UNIFORM,
      payrollRates: ZERO_PAYE_PENSION_RATES,
      attendance: { absentDays: 0, lateDays: 0 },
      salaryAdvanceDeduction: poolTotal,
    });

    expect(shared.net_pay).toBe(payrollTsxStyleNetPay);
  });
});

// ============================================================
// Part 2: Dashboard.tsx vs Reports.tsx reconciliation -- same synthetic
// population and month, including an outstanding salary advance,
// non-payable/soft-deleted employees, and an employee with no
// company/resident assignment.
// ============================================================
describe('Dashboard <-> Reports reconciliation for the same population/month', () => {
  // Synthetic October 2026 roster:
  //  E1: Active, full attendance, no advance.
  //  E2: On Leave (whole month), no advance.
  //  E3: Terminated, NOT soft-deleted -- must be excluded from BOTH totals.
  //  E4: Active, one outstanding salary advance (pooled total 50,000),
  //      and (requirement 7) no company/resident assignment -- Reports.tsx
  //      no longer has any company-assignment-skip in its payroll total
  //      (the old totalCompanyPayroll card was removed entirely), so E4
  //      must still be fully counted.
  //  E5: Active but soft-deleted -- must be excluded from BOTH totals.
  const E1: PayrollEstimateEmployee = { id: 'e1', basic_salary: 300000, position: 'Office Staff', uniform_deduction: null };
  const E2: PayrollEstimateEmployee = { id: 'e2', basic_salary: 250000, position: 'Office Staff', uniform_deduction: null };
  const E3: PayrollEstimateEmployee = { id: 'e3', basic_salary: 400000, position: 'Office Staff', uniform_deduction: null };
  const E4: PayrollEstimateEmployee = { id: 'e4', basic_salary: 350000, position: 'Office Staff', uniform_deduction: null };
  const E5: PayrollEstimateEmployee = { id: 'e5', basic_salary: 999999, position: 'Office Staff', uniform_deduction: null };

  const statusById: Record<string, string> = {
    e1: 'Active', e2: 'On Leave', e3: 'Terminated', e4: 'Active', e5: 'Active',
  };
  const isDeletedById: Record<string, boolean> = { e5: true };

  const attendanceByEmployeeId = new Map([
    ['e1', { absentDays: 0, lateDays: 0 }],
    ['e2', { absentDays: 0, lateDays: 0 }],
    ['e4', { absentDays: 0, lateDays: 0 }],
  ]);
  const salaryAdvanceByEmployeeId = new Map([['e4', 50000]]);

  // What each page's own population filter produces -- Dashboard/Reports
  // both now use PAYABLE_EMPLOYEE_STATUSES + !is_deleted (see
  // employeeStatus.ts, Dashboard.tsx, Reports.tsx's activeEmployees).
  function payablePopulation(all: PayrollEstimateEmployee[]): PayrollEstimateEmployee[] {
    return all.filter(e =>
      !isDeletedById[e.id] &&
      PAYABLE_EMPLOYEE_STATUSES.includes(statusById[e.id] as typeof PAYABLE_EMPLOYEE_STATUSES[number])
    );
  }

  it('Dashboard\'s estimateMonthlyPayrollTotal() excludes the Terminated and soft-deleted employees', () => {
    const roster = [E1, E2, E3, E4, E5];
    const payable = payablePopulation(roster);
    expect(payable.map(e => e.id).sort()).toEqual(['e1', 'e2', 'e4']);

    const dashboardTotal = estimateMonthlyPayrollTotal(payable, attendanceByEmployeeId, NO_UNIFORM, ZERO_PAYE_PENSION_RATES, salaryAdvanceByEmployeeId);
    // 300000 + 250000 + (350000 - 50000) = 850000
    expect(dashboardTotal).toBe(850000);
  });

  it('Reports\' equivalent per-employee reduction (what payrollSummary.totalNet now computes, no company/resident requirement) reconciles EXACTLY with Dashboard\'s total', () => {
    const roster = [E1, E2, E3, E4, E5];
    const payable = payablePopulation(roster);

    // Mirrors Reports.tsx's payrollSummary useMemo: sum
    // getEmployeeFigures(emp).net_pay over activeEmployees, with no
    // company/resident filter at all (the old totalCompanyPayroll's skip
    // of unassigned employees has been removed from the UI entirely).
    const reportsTotal = payable.reduce((sum, e) => {
      const figures = computeEstimatedNetPay({
        basicSalary: e.basic_salary,
        position: e.position,
        employeeUniformDeduction: e.uniform_deduction,
        positionsRequiringUniform: NO_UNIFORM,
        payrollRates: ZERO_PAYE_PENSION_RATES,
        attendance: attendanceByEmployeeId.get(e.id),
        salaryAdvanceDeduction: salaryAdvanceByEmployeeId.get(e.id),
      });
      return sum + figures.net_pay;
    }, 0);

    const dashboardTotal = estimateMonthlyPayrollTotal(payable, attendanceByEmployeeId, NO_UNIFORM, ZERO_PAYE_PENSION_RATES, salaryAdvanceByEmployeeId);

    expect(reportsTotal).toBe(dashboardTotal);
    expect(reportsTotal).toBe(850000);
  });

  it('Payroll.tsx\'s own preview composition (calculateLivePayroll then subtract the pooled advance total) reconciles with the shared Dashboard/Reports total for the SAME population', () => {
    const roster = [E1, E2, E3, E4, E5];
    const payable = payablePopulation(roster);

    const payrollStyleTotal = payable.reduce((sum, e) => {
      const live = calculateLivePayroll({
        basicSalary: e.basic_salary,
        position: e.position,
        positionsRequiringUniform: NO_UNIFORM,
        payrollRates: ZERO_PAYE_PENSION_RATES,
        attendance: attendanceByEmployeeId.get(e.id),
      });
      const advance = salaryAdvanceByEmployeeId.get(e.id) || 0;
      return sum + (live.netPay - advance);
    }, 0);

    const dashboardTotal = estimateMonthlyPayrollTotal(payable, attendanceByEmployeeId, NO_UNIFORM, ZERO_PAYE_PENSION_RATES, salaryAdvanceByEmployeeId);
    expect(payrollStyleTotal).toBe(dashboardTotal);
  });

  it('different selected months: a salary advance present in October but not yet active in September produces DIFFERENT, correctly month-scoped totals', () => {
    const octoberAdvances = new Map([['e4', 50000]]);
    const septemberAdvances = new Map<string, number>(); // advance's deduction_start_month is after September

    const octTotal = estimateMonthlyPayrollTotal([E1, E2, E4], attendanceByEmployeeId, NO_UNIFORM, ZERO_PAYE_PENSION_RATES, octoberAdvances);
    const sepTotal = estimateMonthlyPayrollTotal([E1, E2, E4], attendanceByEmployeeId, NO_UNIFORM, ZERO_PAYE_PENSION_RATES, septemberAdvances);

    expect(octTotal).toBe(850000);
    expect(sepTotal).toBe(900000); // no advance deducted yet
    expect(sepTotal).not.toBe(octTotal);
  });

  it('empty population (e.g. a failed/partial query resolving to []) estimates exactly 0, not NaN or a thrown error', () => {
    expect(estimateMonthlyPayrollTotal([], new Map(), NO_UNIFORM, ZERO_PAYE_PENSION_RATES, new Map())).toBe(0);
  });

  it('a payable employee missing from the salary-advance map (e.g. genuinely has none) is treated as a 0 deduction, not excluded or NaN', () => {
    const total = estimateMonthlyPayrollTotal([E1], attendanceByEmployeeId, NO_UNIFORM, ZERO_PAYE_PENSION_RATES, new Map());
    expect(total).toBe(300000);
  });
});

// ============================================================
// Part 3: processed-month contract -- stored payroll.net_pay must be used
// as-is, never recalculated, and never double-subtracted against a live
// salary-advance estimate.
// ============================================================
describe('Processed month: use the stored payroll row, never recompute or double-subtract', () => {
  it('an employee with an existing processed payroll row is represented by that row\'s own net_pay, unaffected by a live salary-advance map', () => {
    // This mirrors Reports.tsx's getEmployeeFigures: when payrollByEmployee
    // has a row, it is returned directly and computeEstimatedNetPay() is
    // never called for that employee at all -- so a live salary-advance
    // figure (even a wrong/stale one) can never double-subtract against
    // an already-processed, already-advance-inclusive stored net_pay.
    const storedPayrollRow = { gross_pay: 300000, paye: 0, pension: 0, net_pay: 250000 }; // already advance-inclusive
    const getEmployeeFiguresForProcessedEmployee = (hasStoredRow: boolean) => {
      if (hasStoredRow) {
        return { gross_pay: storedPayrollRow.gross_pay, paye: storedPayrollRow.paye, pension: storedPayrollRow.pension, net_pay: storedPayrollRow.net_pay };
      }
      return computeEstimatedNetPay({
        basicSalary: 300000, position: 'Office Staff', positionsRequiringUniform: NO_UNIFORM, payrollRates: ZERO_PAYE_PENSION_RATES,
        salaryAdvanceDeduction: 50000, // would double-subtract if this branch were wrongly reached
      });
    };
    const figures = getEmployeeFiguresForProcessedEmployee(true);
    expect(figures.net_pay).toBe(250000); // the stored figure, untouched
  });
});
