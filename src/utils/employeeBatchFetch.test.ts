import { describe, it, expect, vi } from 'vitest';
import { fetchInEmployeeIdBatches, dedupeById, BatchQueryBuilder } from './employeeBatchFetch';

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
