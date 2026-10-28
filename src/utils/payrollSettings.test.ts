// SAFEGUARD -- October 2026 payroll hotfix, fail-closed payroll-settings
// patch. Mocks only the Supabase `.from()` entry point this module
// touches, so getPayrollRatesStrict()'s own classification logic is
// exercised without a live Supabase instance -- same convention as
// payrollApproval.test.ts / livePayrollEstimate.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromMock = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import { getPayrollRatesStrict, getPayrollRates, DEFAULT_RATES } from './payrollSettings';

function chain(result: { data: unknown[] | null; error: unknown }) {
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.in = () => Promise.resolve(result);
  return builder;
}

function settingsRow(key: string, value: string) {
  return { key, value };
}

describe('getPayrollRatesStrict', () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it('1. successfully loaded, explicit zero rates -- preserved exactly, never replaced by a default', async () => {
    fromMock.mockImplementation(() => chain({
      data: [settingsRow('paye_rate', '0'), settingsRow('paye_threshold', '0'), settingsRow('pension_employee_rate', '0')],
      error: null,
    }));
    const result = await getPayrollRatesStrict();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.rates.payeRate).toBe(0);
      expect(result.rates.pensionEmployeeRate).toBe(0);
    }
  });

  it('2. successfully loaded, nonzero configured rates -- used exactly as configured', async () => {
    fromMock.mockImplementation(() => chain({
      data: [settingsRow('paye_rate', '0.25'), settingsRow('paye_threshold', '50000'), settingsRow('pension_employee_rate', '0.03')],
      error: null,
    }));
    const result = await getPayrollRatesStrict();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.rates.payeRate).toBe(0.25);
      expect(result.rates.pensionEmployeeRate).toBe(0.03);
    }
  });

  it('3. missing settings, query succeeds with zero rows at all -- PAYE is a required field, so the WHOLE result is unavailable, never defaulted to a guessed 30%/5% (release-gate correction)', async () => {
    fromMock.mockImplementation(() => chain({ data: [], error: null }));
    const result = await getPayrollRatesStrict();
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/paye_rate/);
      expect(result.reason).toMatch(/has not been configured/i);
    }
  });

  it('3b. PAYE/pension configured (including an explicit 0), but a non-critical deduction field (e.g. appearance_deduction) has no row -- that ONE field still defaults; PAYE/pension are untouched', async () => {
    fromMock.mockImplementation(() => chain({
      data: [settingsRow('paye_rate', '0'), settingsRow('paye_threshold', '0'), settingsRow('pension_employee_rate', '0')],
      // appearance_deduction row absent
      error: null,
    }));
    const result = await getPayrollRatesStrict();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.rates.payeRate).toBe(0);
      expect(result.rates.pensionEmployeeRate).toBe(0);
      expect(result.rates.appearanceDeduction).toBe(DEFAULT_RATES.appearanceDeduction);
    }
  });

  it('3c. pension_employee_rate missing while PAYE is configured -- the WHOLE result is unavailable (pension is also a required field, not just PAYE)', async () => {
    fromMock.mockImplementation(() => chain({
      data: [settingsRow('paye_rate', '0'), settingsRow('paye_threshold', '0')],
      // pension_employee_rate row absent
      error: null,
    }));
    const result = await getPayrollRatesStrict();
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/pension_employee_rate/);
    }
  });

  it('4. database/network error -- unavailable, NEVER DEFAULT_RATES', async () => {
    fromMock.mockImplementation(() => chain({ data: null, error: new Error('network error') }));
    const result = await getPayrollRatesStrict();
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/could not reach/i);
    }
  });

  it('4b. an unexpected thrown exception (not a returned {error}) -- unavailable, never a default', async () => {
    fromMock.mockImplementation(() => {
      throw new Error('unexpected client exception');
    });
    const result = await getPayrollRatesStrict();
    expect(result.status).toBe('unavailable');
  });

  it('5. malformed value (row exists but is not a valid number) -- the WHOLE result is unavailable, not just that one field defaulted', async () => {
    fromMock.mockImplementation(() => chain({
      data: [settingsRow('paye_rate', 'not-a-number'), settingsRow('pension_employee_rate', '0')],
      error: null,
    }));
    const result = await getPayrollRatesStrict();
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/paye_rate/);
    }
  });

  it('5b. an explicit zero is never itself treated as malformed (parseFloat("0") is a valid number, not NaN)', async () => {
    fromMock.mockImplementation(() => chain({
      data: [settingsRow('paye_rate', '0'), settingsRow('paye_threshold', '0'), settingsRow('pension_employee_rate', '0.00')],
      error: null,
    }));
    const result = await getPayrollRatesStrict();
    expect(result.status).toBe('ok');
  });

  it('6. stale cached values -- two independent calls never bleed into each other; a later failure is not masked by an earlier success (no hidden memoization)', async () => {
    const complete = (payeRate: string) => [settingsRow('paye_rate', payeRate), settingsRow('paye_threshold', '0'), settingsRow('pension_employee_rate', '0')];

    fromMock.mockImplementationOnce(() => chain({ data: complete('0.1'), error: null }));
    const first = await getPayrollRatesStrict();
    expect(first.status).toBe('ok');

    fromMock.mockImplementationOnce(() => chain({ data: null, error: new Error('now failing') }));
    const second = await getPayrollRatesStrict();
    expect(second.status).toBe('unavailable'); // NOT the first call's cached success

    fromMock.mockImplementationOnce(() => chain({ data: complete('0.2'), error: null }));
    const third = await getPayrollRatesStrict();
    expect(third.status).toBe('ok');
    if (third.status === 'ok') {
      expect(third.rates.payeRate).toBe(0.2); // reflects the THIRD call's own data, not the first's
    }
  });

  it('concurrent requests -- two simultaneous calls resolve independently and correctly', async () => {
    let call = 0;
    fromMock.mockImplementation(() => {
      call += 1;
      // Alternate results per call to prove no shared/cross-talking state.
      return call % 2 === 1
        ? chain({ data: [settingsRow('paye_rate', '0'), settingsRow('paye_threshold', '0'), settingsRow('pension_employee_rate', '0')], error: null })
        : chain({ data: null, error: new Error('concurrent failure') });
    });
    const [a, b] = await Promise.all([getPayrollRatesStrict(), getPayrollRatesStrict()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['ok', 'unavailable']);
  });
});

describe('getPayrollRates (unchanged, lenient legacy function -- Attendance.tsx/Payslips.tsx only)', () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it('still silently returns DEFAULT_RATES on a fetch error -- deliberately UNCHANGED by this patch for its two remaining, non-critical, non-PAYE/pension-writing callers', async () => {
    fromMock.mockImplementation(() => chain({ data: null, error: new Error('network error') }));
    const rates = await getPayrollRates();
    expect(rates).toEqual(DEFAULT_RATES);
  });
});
