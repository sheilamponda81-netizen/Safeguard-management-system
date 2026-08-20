// ===== PRODUCTION HOTFIX: shared employee-id batching helper =====
// A single Supabase query built with `.in('employee_id', employeeIds)` from
// an entire tenant/region's employee population produces an extremely large
// PostgREST request URL as that population grows -- production has grown
// past the point where several of these requests are reliably accepted,
// returning 400 Bad Request. This helper splits `employeeIds` into small
// batches (keeping each request's IN-list short), runs a bounded number of
// batches concurrently (not fully sequential, not all-at-once), and
// paginates each batch internally via `.range()` using `{ count: 'exact' }`
// so a batch with more rows than fit in one page (e.g. many employees each
// with many daily attendance rows) is never silently truncated.

const DEFAULT_EMPLOYEE_BATCH_SIZE = 25;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 4;

export interface BatchPageResult<T> {
  data: T[] | null;
  error: any;
  count: number | null;
}

export type BatchQueryBuilder<T> = (
  employeeIdBatch: string[],
  rangeFrom: number,
  rangeTo: number
) => PromiseLike<BatchPageResult<T>>;

async function fetchOneBatch<T>(
  batch: string[],
  buildQuery: BatchQueryBuilder<T>,
  pageSize: number
): Promise<T[]> {
  const records: T[] = [];
  let offset = 0;

  while (true) {
    const { data, error, count } = await buildQuery(batch, offset, offset + pageSize - 1);
    if (error) throw error;

    records.push(...(data || []));
    offset += pageSize;

    // `count` is the batch's true total matching row count (from
    // `{ count: 'exact' }`), so pagination stops based on real remaining
    // rows rather than assuming "fewer rows than requested" means "no more
    // data" -- that assumption breaks if the server enforces its own
    // max-rows cap below what was requested.
    const total = count ?? records.length;
    if (offset >= total || (data || []).length === 0) break;
  }

  return records;
}

// Runs `buildQuery` once per employee-id batch (batches of `employeeBatchSize`
// ids), with at most `concurrency` batches in flight at a time -- bounded
// concurrency, not sequential-only and not an unbounded `Promise.all` over
// every batch -- and concatenates every batch's (already-paginated) rows
// into one array. Employee batches never overlap and each batch's own pages
// never overlap, so the result cannot contain a duplicate row purely from
// batching/pagination; callers whose rows have a stable primary `id` may
// still run the result through `dedupeById` as a defensive measure.
//
// If a batch fails, the error propagates out of this function (the whole
// load fails) rather than returning a partial result silently.
export async function fetchInEmployeeIdBatches<T>(
  employeeIds: string[],
  buildQuery: BatchQueryBuilder<T>,
  options?: { employeeBatchSize?: number; pageSize?: number; concurrency?: number }
): Promise<T[]> {
  if (employeeIds.length === 0) return [];

  const employeeBatchSize = options?.employeeBatchSize ?? DEFAULT_EMPLOYEE_BATCH_SIZE;
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_CONCURRENCY);

  const batches: string[][] = [];
  for (let i = 0; i < employeeIds.length; i += employeeBatchSize) {
    batches.push(employeeIds.slice(i, i + employeeBatchSize));
  }

  const results: T[][] = new Array(batches.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= batches.length) return;
      results[i] = await fetchOneBatch(batches[i], buildQuery, pageSize);
    }
  }

  const workerCount = Math.min(concurrency, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results.flat();
}

// Defensive dedup for callers whose selected columns include a stable
// primary `id` (e.g. `select('*')` loads of attendance/payroll rows). Not
// needed for correctness (see note above) but cheap insurance against any
// future change to the batching/pagination shape.
export function dedupeById<T extends { id: string }>(records: T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of records) {
    byId.set(record.id, record);
  }
  return Array.from(byId.values());
}
