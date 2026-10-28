// SAFEGUARD -- October 2026 payroll hotfix, final financial-reliability
// patch. Proves reconcileMonthlyPayroll()'s per-employee composition,
// fail-closed unavailable handling, and historical-row retention --
// mirroring Payroll.tsx's own isHistoricalMonth/getDisplayPayroll
// contract (see payrollReconciliation.ts's own header).
import { describe, it, expect } from 'vitest';
import { reconcileMonthlyPayroll, ReconciliationEmployee, StoredPayrollRow, LiveEstimateInputs } from './payrollReconciliation';
import { PayrollRates } from './payrollSettings';

const ZERO_RATES: PayrollRates = {
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
const NO_UNIFORM = new Map<string, boolean>([['Office Staff', false]]);

function inputs(overrides: Partial<LiveEstimateInputs> = {}): LiveEstimateInputs {
  return {
    attendanceByEmployeeId: new Map(),
    positionsRequiringUniform: NO_UNIFORM,
    payrollRates: ZERO_RATES,
    salaryAdvanceByEmployeeId: new Map(),
    ...overrides,
  };
}

const E1: ReconciliationEmployee = { id: 'e1', basic_salary: 300000, position: 'Office Staff' };
const E2: ReconciliationEmployee = { id: 'e2', basic_salary: 250000, position: 'Office Staff' };
const E3: ReconciliationEmployee = { id: 'e3', basic_salary: 400000, position: 'Office Staff' };

describe('reconcileMonthlyPayroll -- current/future month', () => {
  it('no processed payroll rows -- fully estimates the payable roster, state "unprocessed"', () => {
    const result = reconcileMonthlyPayroll(false, [E1, E2], [], inputs());
    expect(result.unavailable).toBe(false);
    expect(result.state).toBe('unprocessed');
    expect(result.processedCount).toBe(0);
    expect(result.estimatedCount).toBe(2);
    expect(result.totals.net_pay).toBe(550000);
  });

  it('every payable employee has a stored row -- state "fully_processed", stored figures used verbatim', () => {
    const stored: StoredPayrollRow[] = [
      { employee_id: 'e1', gross_pay: 300000, paye: 0, pension: 0, net_pay: 250000, approval_status: 'approved' },
      { employee_id: 'e2', gross_pay: 250000, paye: 0, pension: 0, net_pay: 250000, approval_status: 'pending' },
    ];
    const result = reconcileMonthlyPayroll(false, [E1, E2], stored, inputs());
    expect(result.state).toBe('fully_processed');
    expect(result.unavailable).toBe(false);
    expect(result.processedCount).toBe(2);
    expect(result.estimatedCount).toBe(0);
    expect(result.totals.net_pay).toBe(500000); // 250000 + 250000, exactly the stored figures
  });

  it('partial processing: one employee stored, one not -- state "partial", stored row untouched, other estimated', () => {
    const stored: StoredPayrollRow[] = [
      { employee_id: 'e1', gross_pay: 300000, paye: 0, pension: 0, net_pay: 280000, approval_status: 'approved' },
    ];
    const result = reconcileMonthlyPayroll(false, [E1, E2], stored, inputs());
    expect(result.state).toBe('partial');
    expect(result.unavailable).toBe(false);
    expect(result.processedCount).toBe(1);
    expect(result.estimatedCount).toBe(1);
    const e1 = result.employees.find(e => e.employeeId === 'e1')!;
    const e2 = result.employees.find(e => e.employeeId === 'e2')!;
    expect(e1.source).toBe('stored');
    expect(e1.figures.net_pay).toBe(280000); // exactly the stored figure, not recalculated
    expect(e2.source).toBe('estimated');
    expect(e2.figures.net_pay).toBe(250000);
    expect(result.totals.net_pay).toBe(530000);
  });

  it('a stored approval_status of "pending" or "rejected" is still source: stored -- presence of a row is never read as approval/payment completeness', () => {
    const stored: StoredPayrollRow[] = [
      { employee_id: 'e1', gross_pay: 300000, paye: 0, pension: 0, net_pay: 300000, approval_status: 'rejected' },
    ];
    const result = reconcileMonthlyPayroll(false, [E1], stored, inputs());
    expect(result.employees[0].source).toBe('stored');
    expect(result.employees[0].approvalStatus).toBe('rejected');
    expect(result.state).toBe('fully_processed'); // "processed" (a row exists), not "approved"
  });

  it('unavailable live-estimate inputs with at least one employee needing an estimate -- unavailable:true, zeroed totals, no silent partial sum', () => {
    const stored: StoredPayrollRow[] = [
      { employee_id: 'e1', gross_pay: 300000, paye: 0, pension: 0, net_pay: 300000, approval_status: 'approved' },
    ];
    const result = reconcileMonthlyPayroll(false, [E1, E2], stored, undefined);
    expect(result.unavailable).toBe(true);
    expect(result.totals).toEqual({ gross_pay: 0, paye: 0, pension: 0, net_pay: 0 });
    // e1 (stored) is NOT silently excluded from the employees list -- but
    // the aggregate total is still zeroed/unavailable rather than a
    // misleading "just the known part".
    expect(result.employees.some(e => e.employeeId === 'e1' && e.source === 'stored')).toBe(true);
    expect(result.employees.some(e => e.employeeId === 'e2')).toBe(false); // e2 needed an estimate; none pushed
  });

  it('every employee already stored -- unavailable live-estimate inputs do NOT matter at all (no estimate ever needed)', () => {
    const stored: StoredPayrollRow[] = [
      { employee_id: 'e1', gross_pay: 300000, paye: 0, pension: 0, net_pay: 300000, approval_status: 'approved' },
      { employee_id: 'e2', gross_pay: 250000, paye: 0, pension: 0, net_pay: 250000, approval_status: 'approved' },
    ];
    const result = reconcileMonthlyPayroll(false, [E1, E2], stored, undefined);
    expect(result.unavailable).toBe(false);
    expect(result.state).toBe('fully_processed');
    expect(result.totals.net_pay).toBe(550000);
  });

  it('no payable employees and no stored rows -- state "unprocessed", total exactly 0, never NaN', () => {
    const result = reconcileMonthlyPayroll(false, [], [], inputs());
    expect(result.state).toBe('unprocessed');
    expect(result.unavailable).toBe(false);
    expect(result.totals.net_pay).toBe(0);
    expect(result.totalPopulationCount).toBe(0);
  });

  it('a stored row exists for an employee NOT in today\'s payable roster (became non-payable within the same month) -- still counted, source: stored', () => {
    const stored: StoredPayrollRow[] = [
      { employee_id: 'e3', gross_pay: 400000, paye: 0, pension: 0, net_pay: 400000, approval_status: 'approved' },
    ];
    // E3 deliberately NOT in currentPayableEmployees.
    const result = reconcileMonthlyPayroll(false, [E1], stored, inputs());
    const e3 = result.employees.find(e => e.employeeId === 'e3');
    expect(e3?.source).toBe('stored');
    expect(result.totals.net_pay).toBe(300000 + 400000);
  });

  it('salary advance applied exactly once for an estimated employee; a stored employee\'s figure is never touched by the live advance map', () => {
    const stored: StoredPayrollRow[] = [
      { employee_id: 'e1', gross_pay: 300000, paye: 0, pension: 0, net_pay: 250000, approval_status: 'approved' }, // already advance-inclusive
    ];
    const result = reconcileMonthlyPayroll(
      false, [E1, E2], stored,
      inputs({ salaryAdvanceByEmployeeId: new Map([['e1', 999999], ['e2', 50000]]) }) // e1's map entry must be IGNORED (stored)
    );
    const e1 = result.employees.find(e => e.employeeId === 'e1')!;
    const e2 = result.employees.find(e => e.employeeId === 'e2')!;
    expect(e1.figures.net_pay).toBe(250000); // untouched by the (irrelevant) 999999 entry
    expect(e2.figures.net_pay).toBe(250000 - 50000); // estimated, advance subtracted exactly once
  });

  it('employee with multiple relevant deductions while estimated (absence + late + salary advance)', () => {
    const result = reconcileMonthlyPayroll(
      false, [E3], [],
      inputs({
        attendanceByEmployeeId: new Map([['e3', { absentDays: 1, lateDays: 1 }]]),
        salaryAdvanceByEmployeeId: new Map([['e3', 20000]]),
      })
    );
    const expected = 400000 - ZERO_RATES.absentDeduction - ZERO_RATES.lateDeduction - 20000;
    expect(result.employees[0].figures.net_pay).toBe(expected);
  });
});

describe('reconcileMonthlyPayroll -- historical month (selectedMonth < systemMonth)', () => {
  it('population is EXACTLY the stored rows, never today\'s payable roster -- mirrors Payroll.tsx\'s own branch A', () => {
    const stored: StoredPayrollRow[] = [
      { employee_id: 'e3', gross_pay: 400000, paye: 0, pension: 0, net_pay: 400000, approval_status: 'approved' },
    ];
    // currentPayableEmployees deliberately does NOT include e3 at all (and
    // includes e1/e2, who were never processed that month) -- the
    // historical result must be driven purely by the stored rows.
    const result = reconcileMonthlyPayroll(true, [E1, E2], stored, undefined);
    expect(result.employees.map(e => e.employeeId)).toEqual(['e3']);
    expect(result.totals.net_pay).toBe(400000);
    expect(result.state).toBe('fully_processed');
  });

  it('a now-terminated/soft-deleted employee\'s historical row is still included -- no retroactive exclusion by current status', () => {
    // currentPayableEmployees is empty -- as if EVERY employee who was
    // ever paid that month is now non-payable/deleted. The historical
    // total must be unaffected, because population never consults
    // currentPayableEmployees in this branch.
    const stored: StoredPayrollRow[] = [
      { employee_id: 'e-terminated', gross_pay: 500000, paye: 0, pension: 0, net_pay: 450000, approval_status: 'approved' },
    ];
    const result = reconcileMonthlyPayroll(true, [], stored, undefined);
    expect(result.totals.net_pay).toBe(450000);
    expect(result.unavailable).toBe(false); // historical never needs a live estimate
  });

  it('a genuinely never-processed historical month -- state "unprocessed", total 0, not "unavailable" (this is a known fact, not a fetch failure)', () => {
    const result = reconcileMonthlyPayroll(true, [E1, E2], [], undefined);
    expect(result.state).toBe('unprocessed');
    expect(result.unavailable).toBe(false);
    expect(result.totals.net_pay).toBe(0);
  });
});

describe('reconcileMonthlyPayroll -- Dashboard/Reports/Payroll reconciliation parity', () => {
  it('for the SAME synthetic population/month, this function reproduces exactly what Payroll.tsx\'s own getDisplayPayroll()-style sum would produce', () => {
    const stored: StoredPayrollRow[] = [
      { employee_id: 'e1', gross_pay: 300000, paye: 0, pension: 0, net_pay: 300000, approval_status: 'approved' },
    ];
    const liveInputs = inputs({ salaryAdvanceByEmployeeId: new Map([['e2', 50000]]) });
    const result = reconcileMonthlyPayroll(false, [E1, E2], stored, liveInputs);

    // Payroll.tsx-style manual sum: getDisplayPayroll(e1) = stored row;
    // getDisplayPayroll(e2) = calculatePayroll() live estimate minus advance.
    const payrollTsxStyleTotal = 300000 /* e1 stored */ + (250000 - 50000) /* e2 live - advance */;
    expect(result.totals.net_pay).toBe(payrollTsxStyleTotal);
  });
});

// Refund-persistence hotfix (2026-11): Dashboard.tsx and Reports.tsx must
// include a saved, active payroll_refund_drafts amount in an UNPROCESSED
// month's estimate, exactly like Payroll.tsx's own preview -- see
// livePayrollEstimate.ts's fetchRefundByEmployee() header.
describe('reconcileMonthlyPayroll -- refund-persistence hotfix (2026-11)', () => {
  it('a saved refund draft is added exactly once for an estimated employee, alongside an unrelated salary advance', () => {
    const result = reconcileMonthlyPayroll(
      false, [E1, E2], [],
      inputs({
        salaryAdvanceByEmployeeId: new Map([['e2', 50000]]),
        refundByEmployeeId: new Map([['e2', 15000]]),
      })
    );
    const e1 = result.employees.find(e => e.employeeId === 'e1')!;
    const e2 = result.employees.find(e => e.employeeId === 'e2')!;
    expect(e1.figures.net_pay).toBe(300000); // untouched -- no refund entry for e1
    expect(e2.figures.net_pay).toBe(250000 - 50000 + 15000); // advance subtracted, refund added, once each
    expect(result.totals.net_pay).toBe(300000 + (250000 - 50000 + 15000));
  });

  it('a stored employee\'s figure is never touched by the live refund map, even if one exists for them', () => {
    const stored: StoredPayrollRow[] = [
      { employee_id: 'e1', gross_pay: 300000, paye: 0, pension: 0, net_pay: 310000, approval_status: 'approved' }, // already refund-inclusive from processing
    ];
    const result = reconcileMonthlyPayroll(
      false, [E1, E2], stored,
      inputs({ refundByEmployeeId: new Map([['e1', 999999], ['e2', 15000]]) }) // e1's map entry must be IGNORED (stored)
    );
    const e1 = result.employees.find(e => e.employeeId === 'e1')!;
    const e2 = result.employees.find(e => e.employeeId === 'e2')!;
    expect(e1.figures.net_pay).toBe(310000); // untouched by the (irrelevant) 999999 entry
    expect(e2.figures.net_pay).toBe(250000 + 15000); // estimated, refund added exactly once
  });

  it('omitting refundByEmployeeId entirely (caller never fetched it) behaves exactly as if no employee has a refund -- no crash, no unavailable', () => {
    const result = reconcileMonthlyPayroll(false, [E1], [], inputs()); // inputs() has no refundByEmployeeId key at all
    expect(result.unavailable).toBe(false);
    expect(result.employees[0].figures.net_pay).toBe(300000);
  });

  it('for the SAME synthetic population/month including a refund, reproduces exactly what Payroll.tsx\'s own preview (live estimate + refund - advance) would produce', () => {
    const liveInputs = inputs({
      salaryAdvanceByEmployeeId: new Map([['e2', 50000]]),
      refundByEmployeeId: new Map([['e2', 15000]]),
    });
    const result = reconcileMonthlyPayroll(false, [E1, E2], [], liveInputs);

    const payrollTsxStyleTotal = 300000 /* e1 live, no refund/advance */ + (250000 - 50000 + 15000) /* e2 live - advance + refund */;
    expect(result.totals.net_pay).toBe(payrollTsxStyleTotal);
  });
});
