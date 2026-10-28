// SAFEGUARD -- October 2026 payroll hotfix, financial-consistency
// correction. Mocks only the Supabase `.from()` entry point this module
// touches, so fetchSalaryAdvanceDeductionByEmployee()'s own batching/
// query-shape/aggregation logic is exercised without a live Supabase
// instance -- same convention as payrollApproval.test.ts. This query
// shape is a deliberate byte-for-byte mirror of Payroll.tsx's own inline
// fetch (src/pages/Payroll.tsx, ~line 759 onward); this test covers the
// mirror's own correctness, not a claim that Payroll.tsx's separate,
// already-tested inline code was re-tested here.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromMock = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import { fetchSalaryAdvanceDeductionByEmployee, fetchRefundByEmployee, computeEstimatedNetPay } from './livePayrollEstimate';
import { PayrollRates } from './payrollSettings';

// A minimal chainable query-builder stand-in: every intermediate method
// returns the same object, and the TERMINAL call in each real query chain
// below (`.range()`) resolves to the supplied result -- matching exactly
// what fetchInEmployeeIdBatches's buildQuery callback awaits.
function chain(result: { data: unknown[] | null; error: unknown; count?: number }) {
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.eq = self;
  builder.lte = self;
  builder.in = self;
  builder.range = () => Promise.resolve(result);
  return builder;
}


describe('fetchSalaryAdvanceDeductionByEmployee', () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it('employee with no active advance is simply absent from the returned map (not present with 0)', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'salary_advances') return chain({ data: [], error: null, count: 0 });
      throw new Error(`unexpected table: ${table}`);
    });
    const result = await fetchSalaryAdvanceDeductionByEmployee(['e1'], '2026-10');
    expect(result.has('e1')).toBe(false);
    expect(result.size).toBe(0);
  });

  it('empty employeeIds short-circuits without calling Supabase at all', async () => {
    const result = await fetchSalaryAdvanceDeductionByEmployee([], '2026-10');
    expect(result.size).toBe(0);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('one outstanding salary advance, partially repaid -- remaining balance capped by the combined monthly deduction', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'salary_advances') {
        return chain({
          data: [{ id: 'adv-1', employee_id: 'e4', advance_amount: 100000, application_date: '2026-09-01', created_at: '2026-09-01T00:00:00Z' }],
          error: null,
          count: 1,
        });
      }
      if (table === 'salary_advance_deductions') {
        return chain({ data: [{ salary_advance_id: 'adv-1', deduction_amount: 20000 }], error: null, count: 1 });
      }
      if (table === 'salary_advance_repayment_plans') {
        return chain({ data: [{ employee_id: 'e4', combined_monthly_deduction: 50000 }], error: null, count: 1 });
      }
      throw new Error(`unexpected table: ${table}`);
    });

    const result = await fetchSalaryAdvanceDeductionByEmployee(['e4'], '2026-10');
    // remaining = 100000 - 20000 = 80000; pool = 50000 -> LEAST(80000, 50000) = 50000
    expect(result.get('e4')).toBe(50000);
  });

  it('two simultaneously open advances for the same employee -- pooled oldest-first, matching calculatePooledAllocation exactly', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'salary_advances') {
        return chain({
          data: [
            { id: 'adv-old', employee_id: 'e4', advance_amount: 10000, application_date: '2026-08-01', created_at: '2026-08-01T00:00:00Z' },
            { id: 'adv-new', employee_id: 'e4', advance_amount: 30000, application_date: '2026-09-01', created_at: '2026-09-01T00:00:00Z' },
          ],
          error: null,
          count: 2,
        });
      }
      if (table === 'salary_advance_deductions') {
        return chain({ data: [], error: null, count: 0 }); // nothing repaid yet
      }
      if (table === 'salary_advance_repayment_plans') {
        return chain({ data: [{ employee_id: 'e4', combined_monthly_deduction: 20000 }], error: null, count: 1 });
      }
      throw new Error(`unexpected table: ${table}`);
    });

    const result = await fetchSalaryAdvanceDeductionByEmployee(['e4'], '2026-10');
    // Pool 20000: oldest (adv-old, remaining 10000) gets 10000 and finishes;
    // remaining pool 10000 carries to adv-new -> total exactly 20000, never more.
    expect(result.get('e4')).toBe(20000);
  });

  it('a failed query propagates as a rejected promise -- callers (Dashboard.tsx/Reports.tsx) are responsible for catching it and degrading to "no known advances", never silently returning wrong data', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'salary_advances') {
        return chain({ data: null, error: new Error('network error'), count: undefined });
      }
      throw new Error(`unexpected table: ${table}`);
    });
    await expect(fetchSalaryAdvanceDeductionByEmployee(['e1'], '2026-10')).rejects.toThrow('network error');
  });

  it('a SECOND page failing after the first page already succeeded (partial pagination failure) propagates -- never silently returns only the first page\'s partial result', async () => {
    // Page 1: 1 row, but count=2 tells fetchOneBatch a second page is
    // expected. Page 2: fails outright. The call counter is declared
    // OUTSIDE chain()/chainSequence() and shared across every `.from()`
    // invocation for this table -- the real buildQuery callback also
    // calls `.from(...)` fresh per page, so the mock must track state
    // across those calls the same way successive real HTTP requests would.
    let salaryAdvancesCall = 0;
    fromMock.mockImplementation((table: string) => {
      if (table === 'salary_advances') {
        const results = [
          { data: [{ id: 'adv-1', employee_id: 'e1', advance_amount: 50000, application_date: '2026-09-01', created_at: '2026-09-01T00:00:00Z' }], error: null, count: 2 },
          { data: null, error: new Error('page 2 failed') },
        ];
        return chain(results[Math.min(salaryAdvancesCall++, results.length - 1)]);
      }
      throw new Error(`unexpected table: ${table}`);
    });
    await expect(fetchSalaryAdvanceDeductionByEmployee(['e1', 'e2'], '2026-10')).rejects.toThrow('page 2 failed');
  });

  it('a fully-repaid advance (remaining balance 0) contributes nothing, even if a combined plan still exists', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'salary_advances') {
        return chain({
          data: [{ id: 'adv-1', employee_id: 'e4', advance_amount: 50000, application_date: '2026-06-01', created_at: '2026-06-01T00:00:00Z' }],
          error: null,
          count: 1,
        });
      }
      if (table === 'salary_advance_deductions') {
        return chain({ data: [{ salary_advance_id: 'adv-1', deduction_amount: 50000 }], error: null, count: 1 }); // fully repaid
      }
      if (table === 'salary_advance_repayment_plans') {
        return chain({ data: [{ employee_id: 'e4', combined_monthly_deduction: 10000 }], error: null, count: 1 });
      }
      throw new Error(`unexpected table: ${table}`);
    });

    const result = await fetchSalaryAdvanceDeductionByEmployee(['e4'], '2026-10');
    expect(result.has('e4')).toBe(false); // total === 0 -> not set, per this function's own "missing = 0" convention
  });
});

// Refund-persistence hotfix (2026-11): Dashboard.tsx and Reports.tsx must
// include a saved, active payroll_refund_drafts amount in an UNPROCESSED
// month's estimate -- same table Payroll.tsx's own preview reads and
// process_payroll_batch() re-reads at processing time.
describe('fetchRefundByEmployee', () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it('empty employeeIds short-circuits without calling Supabase at all', async () => {
    const result = await fetchRefundByEmployee([], '2026-10');
    expect(result.size).toBe(0);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('employee with no saved draft is simply absent from the returned map (not present with 0)', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'payroll_refund_drafts') return chain({ data: [], error: null, count: 0 });
      throw new Error(`unexpected table: ${table}`);
    });
    const result = await fetchRefundByEmployee(['e1'], '2026-10');
    expect(result.has('e1')).toBe(false);
  });

  it('a pending draft with a positive amount is included', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'payroll_refund_drafts') {
        return chain({ data: [{ employee_id: 'e1', amount: 15000, status: 'pending' }], error: null, count: 1 });
      }
      throw new Error(`unexpected table: ${table}`);
    });
    const result = await fetchRefundByEmployee(['e1'], '2026-10');
    expect(result.get('e1')).toBe(15000);
  });

  it('a cancelled draft is excluded even though it has a positive amount', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'payroll_refund_drafts') {
        return chain({ data: [{ employee_id: 'e1', amount: 15000, status: 'cancelled' }], error: null, count: 1 });
      }
      throw new Error(`unexpected table: ${table}`);
    });
    const result = await fetchRefundByEmployee(['e1'], '2026-10');
    expect(result.has('e1')).toBe(false);
  });

  it('a zero-amount draft (e.g. drafted then cleared) is excluded, never set as a 0 entry', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'payroll_refund_drafts') {
        return chain({ data: [{ employee_id: 'e1', amount: 0, status: 'pending' }], error: null, count: 1 });
      }
      throw new Error(`unexpected table: ${table}`);
    });
    const result = await fetchRefundByEmployee(['e1'], '2026-10');
    expect(result.has('e1')).toBe(false);
  });

  it('a failed query propagates as a rejected promise -- callers are responsible for aborting the whole estimate, never silently degrading to "no refund"', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'payroll_refund_drafts') {
        return chain({ data: null, error: new Error('network error'), count: undefined });
      }
      throw new Error(`unexpected table: ${table}`);
    });
    await expect(fetchRefundByEmployee(['e1'], '2026-10')).rejects.toThrow('network error');
  });

  it('is filtered to the requested month, not an employee\'s draft from a different month', async () => {
    fromMock.mockImplementation((table: string, ..._rest: unknown[]) => {
      if (table === 'payroll_refund_drafts') {
        const builder = chain({ data: [{ employee_id: 'e1', amount: 15000, status: 'pending' }], error: null, count: 1 });
        const originalEq = builder.eq;
        builder.eq = (...args: unknown[]) => {
          expect(args).toEqual(['month', '2026-10']);
          return originalEq(...args);
        };
        return builder;
      }
      throw new Error(`unexpected table: ${table}`);
    });
    await fetchRefundByEmployee(['e1'], '2026-10');
  });
});

describe('computeEstimatedNetPay -- refund addition (2026-11 hotfix)', () => {
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

  it('a saved refund is added to net_pay, never to gross_pay/paye/pension', () => {
    const noRefund = computeEstimatedNetPay({
      basicSalary: 300000, position: 'Office Staff', positionsRequiringUniform: NO_UNIFORM, payrollRates: ZERO_RATES,
    });
    const withRefund = computeEstimatedNetPay({
      basicSalary: 300000, position: 'Office Staff', positionsRequiringUniform: NO_UNIFORM, payrollRates: ZERO_RATES,
      refund: 15000,
    });
    expect(withRefund.gross_pay).toBe(noRefund.gross_pay);
    expect(withRefund.paye).toBe(noRefund.paye);
    expect(withRefund.pension).toBe(noRefund.pension);
    expect(withRefund.net_pay).toBe(noRefund.net_pay + 15000);
  });

  it('refund and salary-advance deduction combine additively, each applied exactly once', () => {
    const figures = computeEstimatedNetPay({
      basicSalary: 300000, position: 'Office Staff', positionsRequiringUniform: NO_UNIFORM, payrollRates: ZERO_RATES,
      salaryAdvanceDeduction: 50000,
      refund: 15000,
    });
    expect(figures.net_pay).toBe(300000 - 50000 + 15000);
  });

  it('an undefined/omitted refund is treated as 0, not NaN or an error', () => {
    const figures = computeEstimatedNetPay({
      basicSalary: 300000, position: 'Office Staff', positionsRequiringUniform: NO_UNIFORM, payrollRates: ZERO_RATES,
    });
    expect(figures.net_pay).toBe(300000);
  });
});
