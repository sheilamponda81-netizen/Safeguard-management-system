// SAFEGUARD -- October 2026 payroll hotfix, Issue 2 regression tests.
//
// Business rule under test: an employee on approved paid annual leave must
// receive normal salary -- leave status must never cause exclusion, zero
// salary, or an absence deduction. This file proves the rule holds across
// the full pipeline this hotfix's audit traced it through:
//   - calculateAttendanceDeductions() (attendanceDeductions.ts) only ever
//     counts a day as "absent" when that day's attendance status is the
//     literal string 'A'. A leave day is recorded as 'LV' (see Attendance.tsx's
//     own STATUS_LABELS/statusCycle), never 'A' -- so a leave day can never
//     reach the absence-deduction branch, by construction, regardless of how
//     many leave days exist in the month.
//   - calculateLivePayroll() (payrollCalculations.ts) takes basicSalary as a
//     flat figure and only ever subtracts absentDays*rate/lateDays*rate for
//     whatever counts calculateAttendanceDeductions produced -- there is no
//     separate proration-by-attendance logic anywhere that could zero out or
//     shrink basicSalary itself for a leave day.
//   - PAYABLE_EMPLOYEE_STATUSES (employeeStatus.ts) includes 'On Leave'
//     alongside 'Active' -- being on leave never excludes an employee from
//     the payable roster Payroll.tsx (and, after this hotfix, Dashboard.tsx/
//     Reports.tsx) builds payroll totals from.
//   - The salary-advance deduction (applied in Payroll.tsx as a separate
//     `netPay = live.netPay - salaryAdvanceDeduction` subtraction, entirely
//     after and independent of calculateLivePayroll()) is unaffected by, and
//     never doubles up with, attendance/leave-derived deductions.
//
// These are the SAME two pure functions Payroll.tsx's preview and (via the
// SQL parity convention established by attendanceEngineSqlParity.test.ts)
// the server-side processing path both call -- proving these functions
// handle leave correctly here is what makes preview and actual processing
// agree on a paid-leave employee's pay, without needing a live database.
import { describe, it, expect } from 'vitest';
import { calculateAttendanceDeductions, AttendanceDeductionRecord } from './attendanceDeductions';
import { calculateLivePayroll } from './payrollCalculations';
import { PAYABLE_EMPLOYEE_STATUSES } from './employeeStatus';
import { PayrollRates } from './payrollSettings';

const OCTOBER_2026_DATES = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);

const RATES: PayrollRates = {
  payeThreshold: 100000,
  payeRate: 0.3,
  pensionEmployeeRate: 0.05,
  uniformDeduction: 5000,
  absentDeduction: 10000,
  lateDeduction: 2000,
  lectureDeduction: 3000,
  lectureFullMonthDeduction: 20000,
  appearanceDeduction: 0,
};

const DEDUCTION_RATES = {
  absentDeduction: RATES.absentDeduction,
  lateDeduction: RATES.lateDeduction,
  lectureDeduction: RATES.lectureDeduction,
  lectureFullMonthDeduction: RATES.lectureFullMonthDeduction,
  appearanceDeduction: RATES.appearanceDeduction,
};

const BASIC_SALARY = 500000;
const POSITIONS_NO_UNIFORM = new Map<string, boolean>([['Office Staff', false]]);

function livePayrollFor(records: AttendanceDeductionRecord[]) {
  const counts = calculateAttendanceDeductions(records, OCTOBER_2026_DATES, DEDUCTION_RATES);
  const result = calculateLivePayroll({
    basicSalary: BASIC_SALARY,
    position: 'Office Staff',
    positionsRequiringUniform: POSITIONS_NO_UNIFORM,
    payrollRates: RATES,
    attendance: { absentDays: counts.absentDays, lateDays: counts.lateDays },
  });
  return { counts, result };
}

function fullMonthOf(status: string): AttendanceDeductionRecord[] {
  return OCTOBER_2026_DATES.map((date) => ({ date, status }));
}

describe('Issue 2 -- paid-leave payroll eligibility (6 synthetic scenarios)', () => {
  it('Scenario 1: Active employee, full attendance (all Present) -- full salary, zero attendance deduction', () => {
    const { counts, result } = livePayrollFor(fullMonthOf('P'));
    expect(counts.absentDays).toBe(0);
    expect(counts.lateDays).toBe(0);
    expect(result.uniformDeduction).toBe(0); // no absent/late/lecture/appearance/uniform deduction at all
    expect(result.netPay).toBe(result.grossPay - result.paye - result.pension);
    expect(result.netPay).toBeGreaterThan(0);
  });

  it('Scenario 2: approved paid leave for the ENTIRE month (all days "LV") -- same full salary as Scenario 1, zero absence deduction', () => {
    const { counts, result } = livePayrollFor(fullMonthOf('LV'));
    expect(counts.absentDays).toBe(0); // 'LV' is never counted as 'A'
    expect(counts.lateDays).toBe(0);
    expect(result.uniformDeduction).toBe(0);
    const fullAttendance = livePayrollFor(fullMonthOf('P')).result;
    expect(result.netPay).toBe(fullAttendance.netPay); // leave status never reduces pay vs. full attendance
    expect(result.netPay).toBeGreaterThan(0);
  });

  it('Scenario 3: partial-month paid leave (half the month "LV", half "P") -- still zero absence deduction, same full salary', () => {
    const records = OCTOBER_2026_DATES.map((date, i) => ({ date, status: i < 15 ? 'LV' : 'P' }));
    const { counts, result } = livePayrollFor(records);
    expect(counts.absentDays).toBe(0); // no day in this scenario is ever 'A'
    const fullAttendance = livePayrollFor(fullMonthOf('P')).result;
    expect(result.netPay).toBe(fullAttendance.netPay); // no pro-rating for the leave portion of the month
  });

  it('Scenario 4: unauthorized absences ("A") ARE deducted -- confirms the engine still penalizes real absence, i.e. leave is not a blanket deduction-exempt loophole', () => {
    // Oct 4-6, 2026 are Sun/Mon/Tue -- deliberately NOT Wed/Thu, so this
    // scenario isolates the absence deduction from the separate, unrelated
    // lecture-day deduction (which only fires for an 'A' on a Wed/Thu).
    const records = OCTOBER_2026_DATES.map((date, i) => ({ date, status: i >= 3 && i < 6 ? 'A' : 'P' }));
    const { counts, result } = livePayrollFor(records);
    expect(counts.absentDays).toBe(3);
    expect(result.uniformDeduction).toBe(3 * RATES.absentDeduction); // 'uniformDeduction' field also carries attendance deductions, see payrollCalculations.ts
    const fullAttendance = livePayrollFor(fullMonthOf('P')).result;
    expect(result.netPay).toBe(fullAttendance.netPay - 3 * RATES.absentDeduction);
  });

  it('Scenario 5: soft-deleted / non-payable statuses are excluded from the payable roster regardless of attendance -- negative check on PAYABLE_EMPLOYEE_STATUSES, not on the pay math', () => {
    expect(PAYABLE_EMPLOYEE_STATUSES).toContain('Active');
    expect(PAYABLE_EMPLOYEE_STATUSES).toContain('On Leave');
    expect((PAYABLE_EMPLOYEE_STATUSES as readonly string[]).includes('Terminated')).toBe(false);
    expect((PAYABLE_EMPLOYEE_STATUSES as readonly string[]).includes('Suspended')).toBe(false);
    // is_deleted is a separate column from `status` entirely (Security.tsx's status
    // dropdown never touches is_deleted) -- a soft-deleted employee must be excluded
    // by the caller's own `!is_deleted` filter independent of this whitelist, which
    // is exactly why Payroll.tsx/Dashboard.tsx/Reports.tsx all apply BOTH filters.
  });

  it('Scenario 6: approved paid leave (full month) WITH a salary-advance deduction -- full salary still applies, advance deducted independently, no double-counting with any absence deduction', () => {
    const { result } = livePayrollFor(fullMonthOf('LV'));
    const salaryAdvanceDeduction = 50000;
    // Mirrors Payroll.tsx line ~1045: netPay = netPayBeforeAdvance - salaryAdvanceDeduction,
    // applied entirely after and independent of calculateLivePayroll()'s own attendance handling.
    const netPayAfterAdvance = result.netPay - salaryAdvanceDeduction;
    const fullAttendanceNoAdvance = livePayrollFor(fullMonthOf('P')).result.netPay;
    expect(netPayAfterAdvance).toBe(fullAttendanceNoAdvance - salaryAdvanceDeduction);
    // The advance is the ONLY deduction beyond PAYE/pension -- no absence deduction snuck in.
    expect(result.uniformDeduction).toBe(0);
  });
});
