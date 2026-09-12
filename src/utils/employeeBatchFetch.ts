// ===== PRODUCTION HOTFIX: shared employee-id batching helper =====
// A single Supabase query built with `.in('employee_id', employeeIds)` from
// an entire tenant/region's employee population produces an extremely large
// PostgREST request URL as that population grows -- production has grown
// past the point where several of these requests are reliably accepted,
// returning 400 Bad Request. This helper splits `employeeIds` into small
// batches (keeping each request's IN-list short), runs a bounded number of
// batches concurrently (not fully sequential, not all-at-once), and
// paginates each batch internally via `.range()` -- using an exact row
// count from each batch's FIRST page only -- so a batch with more rows than
// fit in one page (e.g. many employees each with many daily attendance
// rows) is never silently truncated.
//
// PERFORMANCE CORRECTION (2026-08-20): the original 25-id / 500-row /
// exact-count-on-every-page settings were deliberately conservative for the
// initial production hotfix. With ~500+ employees that produced excessive
// request fan-out (dozens of batches, each repeating an exact COUNT on
// every page). This revision widens the batch size (computed from a URL-
// size budget, not a bare guess), widens the page size, and only requests
// an exact count once per batch -- all without reintroducing the oversized
// single-request IN-list that caused the original 400s, and without
// weakening the anti-truncation guarantee (see fetchOneBatch below).

// UUIDs are a fixed 36 characters. A byte budget for just the encoded,
// comma-separated ID-list portion of the request URL -- 2800 bytes is
// comfortably under the ~8KB request-line/header limits common to
// browsers/proxies/PostgREST even after the rest of a query's own filters,
// date params, and select list are added on top, while still yielding a
// meaningfully larger batch than the original hardcoded 25 (≈75 ids).
// Computing the batch size from an actual size budget (instead of a second
// bare magic number) means this stays safe if UUID formatting or the rest
// of a query's params ever change shape.
const UUID_LENGTH = 36;
const EMPLOYEE_ID_URL_BUDGET_BYTES = 2800;
const DEFAULT_EMPLOYEE_BATCH_SIZE = Math.floor(EMPLOYEE_ID_URL_BUDGET_BYTES / (UUID_LENGTH + 1));

// PostgREST/Supabase's own default response cap is commonly 1000 rows; this
// is a page SIZE REQUEST, not a truncation assumption either way -- see the
// note in fetchOneBatch on why raising it carries no truncation risk even
// if the actual server-side cap turns out to be lower.
const DEFAULT_PAGE_SIZE = 1000;

// Deliberately not raised in this pass: no measurements yet showing more
// concurrent batches is safe/beneficial, and this hotfix should not trade
// browser-side latency for hammering production Supabase with a wider
// concurrent request fan-out.
const DEFAULT_CONCURRENCY = 4;

export interface BatchPageResult<T> {
  data: T[] | null;
  error: any;
  count: number | null;
}

// `withExactCount` tells the caller's query builder whether THIS page
// should request `{ count: 'exact' }` -- only true for a batch's first
// page. Postgres has to compute an exact count over the matching rows,
// which is real per-request overhead; once a batch's true total is known
// from page 1, repeating that count on every later page of the same batch
// was pure waste.
export type BatchQueryBuilder<T> = (
  employeeIdBatch: string[],
  rangeFrom: number,
  rangeTo: number,
  withExactCount: boolean
) => PromiseLike<BatchPageResult<T>>;

async function fetchOneBatch<T>(
  batch: string[],
  buildQuery: BatchQueryBuilder<T>,
  pageSize: number
): Promise<T[]> {
  const records: T[] = [];
  let offset = 0;
  // Unknown until the first page's exact count comes back. Using this
  // (rather than "did the last page come back full") to decide when a
  // batch is exhausted means raising `pageSize` can never silently drop
  // rows: even if a server-side cap returns fewer rows than requested for
  // some page, the loop still knows the batch's TRUE total from the first
  // page's exact count and keeps paging until it's actually met.
  let total = Infinity;

  while (offset < total) {
    const wantCount = total === Infinity;
    const { data, error, count } = await buildQuery(batch, offset, offset + pageSize - 1, wantCount);
    if (error) throw error;

    const page = data || [];
    if (wantCount) {
      total = count ?? page.length;
    }

    if (page.length === 0) {
      // A legitimately empty batch (total === 0, e.g. no rows match at all)
      // ends up here too on its first and only iteration -- `offset < total`
      // is false in that case (0 < 0), so it's treated as a normal, expected
      // end of data below. Only throw when the known true total says more
      // rows genuinely exist at this offset but the server just returned
      // none -- silently stopping in THAT case would hand back an
      // incomplete result with no indication anything went wrong.
      if (offset < total) {
        throw new Error(
          `fetchInEmployeeIdBatches: expected more rows at offset ${offset} (known total ${total}) but the server returned none`
        );
      }
      break;
    }

    records.push(...page);
    // Advance by the ACTUAL number of rows returned, not the requested
    // `pageSize`. If the project's Supabase/PostgREST max-rows setting is
    // lower than `pageSize`, a single request can come back with fewer rows
    // than asked for even though more remain -- advancing by the requested
    // `pageSize` in that case would jump the next `.range()` past the rows
    // the server didn't return this time, silently dropping them. Advancing
    // by what actually came back means the next request always starts
    // exactly where the previous one left off, regardless of any server-
    // side cap on the response size.
    offset += page.length;
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
    for (;;) {
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
