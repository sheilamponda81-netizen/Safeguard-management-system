import { describe, it, expect, beforeEach, vi } from 'vitest';

const fromMock = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

const { fetchActiveNonDeletedEmployees, fetchAllEmployeesById } = await import('./hikcentralPersonMappingService');

// PRODUCTION HOTFIX regression coverage: both functions now page through
// fetchAllPages() instead of a single unbounded query. `pages` is consumed
// in order across however many times `.from()` is invoked -- fetchAllPages
// calls buildQuery (and therefore supabase.from()) once per page, sharing
// this closure's callIndex across those calls.
interface ChainableMock {
  select: (...args: unknown[]) => ChainableMock;
  eq: (...args: unknown[]) => ChainableMock;
  or: (...args: unknown[]) => ChainableMock;
  order: (...args: unknown[]) => ChainableMock;
  range: (...args: unknown[]) => Promise<{ data: unknown; error: unknown; count?: number | null }>;
}

function mockPaginatedFrom(pages: Array<{ data: unknown; error: unknown; count?: number | null }>) {
  let callIndex = 0;
  return () => {
    const builder: ChainableMock = {
      select: () => builder,
      eq: () => builder,
      or: () => builder,
      order: () => builder,
      range: () => {
        const page = pages[Math.min(callIndex, pages.length - 1)];
        callIndex++;
        return Promise.resolve(page);
      },
    };
    return builder;
  };
}

function liteRow(overrides: Partial<{
  id: string; employee_number: string; full_name: string;
  workstation: string | null; status: string | null; is_deleted: boolean | null;
}> = {}) {
  return {
    id: 'emp-1',
    employee_number: 'SFG-S-001',
    full_name: 'TEST PERSON',
    workstation: 'Head Office',
    status: 'Active',
    is_deleted: false,
    ...overrides,
  };
}

describe('fetchActiveNonDeletedEmployees', () => {
  beforeEach(() => fromMock.mockReset());

  it('maps rows to EmployeeLite shape (fewer than 1,000 matches, single page)', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [liteRow(), liteRow({ id: 'emp-2', employee_number: 'SFG-S-002', is_deleted: null })], error: null, count: 2 },
    ]));
    const result = await fetchActiveNonDeletedEmployees();
    expect(result).toEqual([
      { id: 'emp-1', employeeNumber: 'SFG-S-001', fullName: 'TEST PERSON', workstation: 'Head Office', status: 'Active', isDeleted: false },
      { id: 'emp-2', employeeNumber: 'SFG-S-002', fullName: 'TEST PERSON', workstation: 'Head Office', status: 'Active', isDeleted: null },
    ]);
  });

  it('REGRESSION (PostgREST 1,000-row cap): pages past 1,000 matching employees, with no missing or duplicated rows at the page boundary', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => liteRow({ id: `emp-${i}`, employee_number: `SFG-S-${i}` }));
    const page2 = [liteRow({ id: 'emp-1000', employee_number: 'SFG-S-1000' }), liteRow({ id: 'emp-1001', employee_number: 'SFG-S-1001' })];
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: page1, error: null, count: 1002 },
      { data: page2, error: null, count: null },
    ]));
    const result = await fetchActiveNonDeletedEmployees();
    expect(result).toHaveLength(1002);
    const ids = result.map((e) => e.id);
    expect(new Set(ids).size).toBe(1002); // no duplicates
    expect(ids).toContain('emp-999'); // last row of page 1 (exact boundary)
    expect(ids).toContain('emp-1000'); // first row of page 2 (exact boundary)
    expect(fromMock.mock.calls.length).toBe(2);
  });

  it('propagates a query error rather than returning a partial employee list', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: null, error: { message: 'boom' }, count: null }]));
    await expect(fetchActiveNonDeletedEmployees()).rejects.toBeTruthy();
  });

  it('filters to Active status and non-deleted (null or false) on every page -- never broadens scope to other statuses or deleted employees', async () => {
    const seenCalls: string[] = [];
    let callIndex = 0;
    const pages = [{ data: [], error: null, count: 0 }];
    fromMock.mockImplementation(() => {
      const builder: ChainableMock = {
        select: () => builder,
        eq: (...args: unknown[]) => { seenCalls.push(`eq:${JSON.stringify(args)}`); return builder; },
        or: (...args: unknown[]) => { seenCalls.push(`or:${JSON.stringify(args)}`); return builder; },
        order: () => builder,
        range: () => {
          const page = pages[Math.min(callIndex, pages.length - 1)];
          callIndex++;
          return Promise.resolve(page);
        },
      };
      return builder;
    });
    await fetchActiveNonDeletedEmployees();
    expect(seenCalls).toEqual([
      `eq:${JSON.stringify(['status', 'Active'])}`,
      `or:${JSON.stringify(['is_deleted.is.null,is_deleted.eq.false'])}`,
    ]);
  });
});

describe('fetchAllEmployeesById', () => {
  beforeEach(() => fromMock.mockReset());

  it('keys every employee by id, including non-Active/deleted employees (display-only lookup, intentionally unfiltered)', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [liteRow(), liteRow({ id: 'emp-2', status: 'Terminated', is_deleted: true })], error: null, count: 2 },
    ]));
    const result = await fetchAllEmployeesById();
    expect(result.size).toBe(2);
    expect(result.get('emp-1')?.fullName).toBe('TEST PERSON');
    expect(result.get('emp-2')?.status).toBe('Terminated');
  });

  it('REGRESSION (PostgREST 1,000-row cap): pages past 1,000 total employees with no missing or duplicated ids at the page boundary', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => liteRow({ id: `emp-${i}`, employee_number: `SFG-S-${i}` }));
    const page2 = [liteRow({ id: 'emp-1000', employee_number: 'SFG-S-1000' })];
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: page1, error: null, count: 1001 },
      { data: page2, error: null, count: null },
    ]));
    const result = await fetchAllEmployeesById();
    expect(result.size).toBe(1001);
    expect(result.has('emp-999')).toBe(true);
    expect(result.has('emp-1000')).toBe(true);
    expect(fromMock.mock.calls.length).toBe(2);
  });

  it('propagates a query error rather than returning a partial map', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: null, error: { message: 'boom' }, count: null }]));
    await expect(fetchAllEmployeesById()).rejects.toBeTruthy();
  });

  it('applies no status/deleted filter at all -- this lookup must remain intentionally unscoped for display purposes', async () => {
    const seenCalls: string[] = [];
    let callIndex = 0;
    const pages = [{ data: [], error: null, count: 0 }];
    fromMock.mockImplementation(() => {
      const builder: ChainableMock = {
        select: () => builder,
        eq: (...args: unknown[]) => { seenCalls.push(`eq:${JSON.stringify(args)}`); return builder; },
        or: (...args: unknown[]) => { seenCalls.push(`or:${JSON.stringify(args)}`); return builder; },
        order: () => builder,
        range: () => {
          const page = pages[Math.min(callIndex, pages.length - 1)];
          callIndex++;
          return Promise.resolve(page);
        },
      };
      return builder;
    });
    await fetchAllEmployeesById();
    expect(seenCalls).toEqual([]);
  });
});
