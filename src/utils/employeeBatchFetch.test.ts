import { describe, it, expect, vi } from 'vitest';
import { fetchInEmployeeIdBatches, dedupeById, BatchQueryBuilder } from './employeeBatchFetch';

// Regression coverage for the giant-URL fix applied to TerminalDues.tsx and
// SalaryAdvances.tsx: both pages now delegate their region-scoped
// `.in('employee_id', [...])` fetch to this shared helper instead of
// building one unbounded request from a full employee-id population. These
// tests exercise the helper directly (it is pure aside from the injected
// `buildQuery` callback) so the batching/pagination/concurrency contract
// both callers rely on is verified independently of either page's UI.

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
