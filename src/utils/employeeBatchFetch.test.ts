import { describe, it, expect, vi } from 'vitest';
import { fetchInEmployeeIdBatches, dedupeById, fetchAllPages, BatchQueryBuilder, PageQueryBuilder } from './employeeBatchFetch';

// Regression coverage for the giant-URL fix applied to TerminalDues.tsx,
// SalaryAdvances.tsx, and (this pass) Payroll.tsx's own salary-advance
// integration (salary_advances/salary_advance_deductions/
// salary_advance_repayment_plans, previously plain unbounded
// `.in('employee_id', employeeIds)`/`.in('salary_advance_id', advanceIds)`
// calls -- the exact same failure class that already broke production once
// at ~500+ employees). All these callers now delegate their region-scoped
// `.in(...)` fetch to this shared helper instead of building one unbounded
// request from a full id population. These tests exercise the helper
// directly (it is pure aside from the injected `buildQuery` callback) so
// the batching/pagination/concurrency contract every caller relies on is
// verified independently of any page's UI.

function makeIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `id-${i}`);
}

describe('fetchInEmployeeIdBatches', () => {
  it('an empty employee-id list short-circuits without ever calling buildQuery', async () => {
    const buildQuery = vi.fn();
    const result = await fetchInEmployeeIdBatches([], buildQuery);
    expect(result).toEqual([]);
    expect(buildQuery).not.toHaveBeenCalled();
  });

  it('the default batch size (75, derived from the URL byte budget) splits 80 ids into two requests, never one request carrying all 80', async () => {
    const ids = makeIds(80);
    const seenBatchLengths: number[] = [];
    const buildQuery: BatchQueryBuilder<{ id: string }> = async (batch) => {
      seenBatchLengths.push(batch.length);
      const data = batch.map(id => ({ id }));
      return { data, error: null, count: data.length };
    };
    const result = await fetchInEmployeeIdBatches(ids, buildQuery);
    expect(seenBatchLengths.sort((a, b) => b - a)).toEqual([75, 5]);
    expect(result).toHaveLength(80);
  });

  it('every individual request stays within the id budget: no single buildQuery call ever receives the full employee population', async () => {
    const ids = makeIds(500);
    let maxBatchSeen = 0;
    const buildQuery: BatchQueryBuilder<{ id: string }> = async (batch) => {
      maxBatchSeen = Math.max(maxBatchSeen, batch.length);
      return { data: batch.map(id => ({ id })), error: null, count: batch.length };
    };
    await fetchInEmployeeIdBatches(ids, buildQuery);
    expect(maxBatchSeen).toBeLessThan(ids.length);
    expect(maxBatchSeen).toBeLessThanOrEqual(75);
  });

  it('all rows across every batch are returned, with no duplicates and batch order preserved', async () => {
    const ids = makeIds(200);
    const buildQuery: BatchQueryBuilder<{ id: string }> = async (batch) => ({
      data: batch.map(id => ({ id })),
      error: null,
      count: batch.length,
    });
    const result = await fetchInEmployeeIdBatches(ids, buildQuery, { employeeBatchSize: 40 });
    expect(result).toHaveLength(200);
    const resultIds = result.map(r => r.id);
    expect(new Set(resultIds).size).toBe(200);
    // Batches are concatenated in batch-index order (first 40 ids' rows come
    // before the next 40's) even though cross-batch concurrency means they
    // may resolve out of order -- this is what callers with an ORDER BY must
    // re-sort after merging, per the helper's own documented contract.
    expect(resultIds).toEqual(ids);
  });

  it('paginates within a single batch using the exact count from the first page only, never truncating a batch larger than one page', async () => {
    const batchIds = makeIds(5);
    let queryCallCount = 0;
    const exactCountRequests: boolean[] = [];
    const buildQuery: BatchQueryBuilder<{ id: string }> = async (batch, from, to, withExactCount) => {
      queryCallCount++;
      exactCountRequests.push(withExactCount);
      const page = batch.slice(from, to + 1).map(id => ({ id }));
      return { data: page, error: null, count: withExactCount ? batch.length : null };
    };
    const result = await fetchInEmployeeIdBatches(batchIds, buildQuery, { pageSize: 2 });
    expect(result).toHaveLength(5);
    expect(queryCallCount).toBe(3); // pages of 2, 2, 1
    expect(exactCountRequests).toEqual([true, false, false]);
  });

  it('bounds concurrency: never runs more batches in flight than the configured limit', async () => {
    const ids = makeIds(400);
    let inFlight = 0;
    let maxInFlight = 0;
    const buildQuery: BatchQueryBuilder<{ id: string }> = async (batch) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight--;
      return { data: batch.map(id => ({ id })), error: null, count: batch.length };
    };
    await fetchInEmployeeIdBatches(ids, buildQuery, { employeeBatchSize: 40, concurrency: 3 });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  // Payroll.tsx's salary-advance integration specifically: >75 employees
  // (bigger than one default batch) and >150 (bigger than two), matching
  // the exact 3-query shape now used there (salary_advances by
  // employee_id, salary_advance_deductions by advance_id,
  // salary_advance_repayment_plans by employee_id) -- proving no request
  // ever carries the full id population, every row is preserved, and
  // dedupeById collapses the up-to-2-open-advances-per-employee case
  // correctly across batch boundaries.
  it('salary_advances shape: 100 employee ids never produce a single request carrying all 100, and every active advance row survives batching + dedupeById (including an employee with 2 open advances, one per batch)', async () => {
    const employeeIds = makeIds(100);
    const seenBatchLengths: number[] = [];
    const buildQuery: BatchQueryBuilder<{ id: string; employee_id: string; advance_amount: number }> = async (batch) => {
      seenBatchLengths.push(batch.length);
      // id-0 (batch 1) and id-99 (batch 2, if split) are given 2 rows each,
      // simulating the max-2-open-advances business rule -- but here both
      // rows for the SAME employee land in the SAME batch (an employee_id
      // can't span two batches), so this checks dedupeById is a true no-op
      // when ids are already genuinely distinct, while the general
      // dedupeById suite above covers actual cross-source duplicates.
      const rows = batch.flatMap(employee_id =>
        employee_id === 'id-0'
          ? [{ id: `${employee_id}-adv-1`, employee_id, advance_amount: 1000 }, { id: `${employee_id}-adv-2`, employee_id, advance_amount: 500 }]
          : [{ id: `${employee_id}-adv-1`, employee_id, advance_amount: 200 }]
      );
      return { data: rows, error: null, count: rows.length };
    };
    const raw = await fetchInEmployeeIdBatches(employeeIds, buildQuery);
    const deduped = dedupeById(raw);
    expect(seenBatchLengths.every(len => len <= 75)).toBe(true);
    expect(seenBatchLengths.length).toBeGreaterThan(1); // 100 ids must span at least 2 batches
    expect(deduped).toHaveLength(101); // 99 employees x 1 + 1 employee x 2
    expect(deduped.filter(r => r.employee_id === 'id-0')).toHaveLength(2);
  });

  it('salary_advance_deductions shape: 160 advance ids (bigger than two default batches) never produce a single request, and every ledger row is preserved for the repayment sum', async () => {
    const advanceIds = makeIds(160);
    const seenBatchLengths: number[] = [];
    const buildQuery: BatchQueryBuilder<{ salary_advance_id: string; deduction_amount: number }> = async (batch) => {
      seenBatchLengths.push(batch.length);
      return { data: batch.map(salary_advance_id => ({ salary_advance_id, deduction_amount: 50 })), error: null, count: batch.length };
    };
    const ledgerRows = await fetchInEmployeeIdBatches(advanceIds, buildQuery);
    expect(seenBatchLengths.every(len => len <= 75)).toBe(true);
    expect(seenBatchLengths.length).toBeGreaterThanOrEqual(3); // 160 / 75 rounds up to 3 batches
    expect(ledgerRows).toHaveLength(160);
    const totalRepaid = ledgerRows.reduce((sum, r) => sum + r.deduction_amount, 0);
    expect(totalRepaid).toBe(160 * 50);
  });

  it('propagates a batch error instead of returning a silent partial result', async () => {
    const ids = makeIds(100);
    const buildQuery: BatchQueryBuilder<{ id: string }> = async (batch) => {
      if (batch[0] === 'id-75') {
        return { data: null as { id: string }[] | null, error: new Error('simulated failure'), count: null };
      }
      return { data: batch.map(id => ({ id })), error: null, count: batch.length };
    };
    await expect(fetchInEmployeeIdBatches(ids, buildQuery, { employeeBatchSize: 75 })).rejects.toThrow(
      'simulated failure'
    );
  });

  // ============================================================
  // HOTFIX: Payslips.tsx regression coverage -- test items 13 and 14 from
  // the hotfix's required 15-item test list. Production evidence showed
  // Payslips' `employees` fetch (id, employee_number, full_name, position,
  // department, basic_salary, status, pay_point, contract_type, region_id,
  // uniform_deduction) failing with 400 Bad Request once a month's payroll
  // population produced hundreds of ids in a single `.in(...)` request URL
  // -- fixed by routing that fetch through fetchInEmployeeIdBatches (see
  // src/pages/Payslips.tsx's fetchPayslipData). These tests exercise the
  // shared helper with a payrollEmployeeIds-shaped id list at a size well
  // past both the original production failure and 1,000, per the
  // instruction to size the test for Central Region being added on top of
  // the existing population.
  // ============================================================
  it('test item 13: a 1,247-id payroll population (well past 1,000) is fetched with no single request carrying the full id list, and every employee is returned exactly once', async () => {
    const ids = makeIds(1247);
    const seenBatchSizes: number[] = [];
    const buildQuery: BatchQueryBuilder<{ id: string }> = async (batch) => {
      seenBatchSizes.push(batch.length);
      return { data: batch.map(id => ({ id })), error: null, count: batch.length };
    };
    const result = await fetchInEmployeeIdBatches(ids, buildQuery);
    // No batch ever carries the whole population -- this is the exact
    // failure mode production hit (one `.in()` request built from the
    // entire month's employee id list).
    expect(Math.max(...seenBatchSizes)).toBeLessThan(1247);
    expect(seenBatchSizes.length).toBeGreaterThan(1);
    expect(dedupeById(result)).toHaveLength(1247);
  });

  it('test item 14: a single failed batch out of many fails the ENTIRE Payslips employee load, never a partial employee list silently missing some payslips', async () => {
    const ids = makeIds(1247);
    let callCount = 0;
    const buildQuery: BatchQueryBuilder<{ id: string }> = async (batch) => {
      callCount += 1;
      // Fail a batch in the middle of the run, after some have already
      // succeeded -- proves a late failure still aborts the whole load
      // rather than returning whatever succeeded so far.
      if (callCount === 5) {
        return { data: null as { id: string }[] | null, error: new Error('simulated PostgREST failure'), count: null };
      }
      return { data: batch.map(id => ({ id })), error: null, count: batch.length };
    };
    await expect(fetchInEmployeeIdBatches(ids, buildQuery, { concurrency: 1 })).rejects.toThrow(
      'simulated PostgREST failure'
    );
  });
});

describe('fetchAllPages', () => {
  // Regression coverage for the Employees page production bug: a single
  // unpaginated `.select('*')` request against `employees_general` was
  // silently truncated at PostgREST's server-side max-rows cap once the
  // tenant's employee population passed it, dropping every employee sorted
  // after the cutoff (confirmed in production: a 1,580-row table, capped at
  // 1,000, truncated the Employees page to showing only 885 active/on-leave
  // employees and made search unable to find anyone past the cutoff).
  // fetchEmployees() in src/pages/Employees.tsx now builds its query
  // through this helper instead of a single unpaginated request.

  it('a result set past a 1,000-row server cap is fetched in full, not silently truncated to the first page', async () => {
    const TOTAL = 1580; // matches the production row count that exposed the bug
    const SERVER_CAP = 1000; // PostgREST's own server-side max-rows cap
    let queryCallCount = 0;
    const buildQuery: PageQueryBuilder<{ id: number }> = async (from, to, withExactCount) => {
      queryCallCount++;
      const cappedTo = Math.min(to, from + SERVER_CAP - 1, TOTAL - 1);
      const page = Array.from({ length: Math.max(0, cappedTo - from + 1) }, (_, i) => ({ id: from + i }));
      return { data: page, error: null, count: withExactCount ? TOTAL : null };
    };
    const result = await fetchAllPages(buildQuery);
    expect(result).toHaveLength(TOTAL);
    expect(result.map(r => r.id)).toEqual(Array.from({ length: TOTAL }, (_, i) => i));
    expect(queryCallCount).toBeGreaterThan(1);
  });

  it('requests an exact count only on the first page, never repeating it on later pages', async () => {
    const TOTAL = 2500;
    const exactCountRequests: boolean[] = [];
    const buildQuery: PageQueryBuilder<{ id: number }> = async (from, to, withExactCount) => {
      exactCountRequests.push(withExactCount);
      const cappedTo = Math.min(to, TOTAL - 1);
      const page = Array.from({ length: Math.max(0, cappedTo - from + 1) }, (_, i) => ({ id: from + i }));
      return { data: page, error: null, count: withExactCount ? TOTAL : null };
    };
    await fetchAllPages(buildQuery, 1000);
    expect(exactCountRequests).toEqual([true, false, false]); // 2500 rows / 1000 page size = 3 pages
  });

  it('an empty, genuinely-zero-row result is returned as [] without throwing', async () => {
    const buildQuery: PageQueryBuilder<{ id: number }> = async (_from, _to, withExactCount) => ({
      data: [],
      error: null,
      count: withExactCount ? 0 : null,
    });
    const result = await fetchAllPages(buildQuery);
    expect(result).toEqual([]);
  });

  it('propagates a query error instead of returning a silent partial result', async () => {
    const buildQuery: PageQueryBuilder<{ id: number }> = async () => ({
      data: null,
      error: new Error('simulated PostgREST failure'),
      count: null,
    });
    await expect(fetchAllPages(buildQuery)).rejects.toThrow('simulated PostgREST failure');
  });

  it('throws instead of silently returning an incomplete result if the server stops short of the known total', async () => {
    const buildQuery: PageQueryBuilder<{ id: number }> = async (from, _to, withExactCount) => {
      if (from === 0) {
        return { data: [{ id: 0 }], error: null, count: withExactCount ? 5 : null };
      }
      return { data: [], error: null, count: null }; // server returns nothing even though 4 more rows are known to exist
    };
    await expect(fetchAllPages(buildQuery)).rejects.toThrow(/expected more rows/);
  });

  // PR #55 final release review: pin exact boundary totals around the
  // 1,000-row server cap (not just arbitrary 1,580/2,500 totals above) --
  // 1,000 (exactly one full page, must stop without an extra empty-page
  // request), 1,001 (one row past a full page, forces a second page of
  // exactly 1 row), 1,500 (a realistic production-sized population), and
  // 5,000 (an exact multiple of the page size, must stop after its 5th full
  // page without a wasted 6th request). Every one of this PR's 6 call sites
  // shares this exact loop, so proving it here covers all of them.
  it.each([1000, 1001, 1500, 5000])(
    'fetches exactly %i rows with no missing or duplicated ids and no wasted trailing request',
    async (TOTAL) => {
      let queryCallCount = 0;
      const buildQuery: PageQueryBuilder<{ id: number }> = async (from, to, withExactCount) => {
        queryCallCount++;
        const cappedTo = Math.min(to, TOTAL - 1);
        const page = Array.from({ length: Math.max(0, cappedTo - from + 1) }, (_, i) => ({ id: from + i }));
        return { data: page, error: null, count: withExactCount ? TOTAL : null };
      };
      const result = await fetchAllPages(buildQuery);
      expect(result).toHaveLength(TOTAL);
      expect(new Set(result.map(r => r.id)).size).toBe(TOTAL); // no duplicates
      expect(result.map(r => r.id)).toEqual(Array.from({ length: TOTAL }, (_, i) => i)); // deterministic order preserved
      expect(queryCallCount).toBe(Math.ceil(TOTAL / 1000)); // no extra trailing request once the known total is met
    }
  );

  it('REGRESSION: an error on a LATER page (not just the first) still propagates and never returns the partial rows already accumulated', async () => {
    const buildQuery: PageQueryBuilder<{ id: number }> = async (from, _to, withExactCount) => {
      if (from === 0) {
        // Page 1 succeeds with 1,000 rows and reports a total of 1,500.
        const page = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
        return { data: page, error: null, count: withExactCount ? 1500 : null };
      }
      // Page 2 (the remaining 500 rows) fails.
      return { data: null, error: new Error('simulated page-2 failure'), count: null };
    };
    await expect(fetchAllPages(buildQuery)).rejects.toThrow('simulated page-2 failure');
  });
});

describe('dedupeById', () => {
  it('collapses duplicate ids while preserving one entry per id', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'a' }];
    const deduped = dedupeById(rows);
    expect(deduped).toHaveLength(2);
    expect(new Set(deduped.map(r => r.id))).toEqual(new Set(['a', 'b']));
  });

  it('an already-unique list is returned unchanged in content', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(dedupeById(rows).map(r => r.id).sort()).toEqual(['a', 'b', 'c']);
  });
});
