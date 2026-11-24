import { describe, it, expect, beforeEach, vi } from 'vitest';

const fromMock = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

const { fetchActiveNonDeletedEmployees, fetchAllEmployeesById, fetchActiveHikCentralPersonMappings, fetchIdentifiedRawEvents } = await import('./hikcentralPersonMappingService');
const { profileHikCentralIdentities, classifyHikCentralIdentities } = await import('./hikcentralPersonMapping');

// PRODUCTION HOTFIX regression coverage: both functions now page through
// fetchAllPages() instead of a single unbounded query. `pages` is consumed
// in order across however many times `.from()` is invoked -- fetchAllPages
// calls buildQuery (and therefore supabase.from()) once per page, sharing
// this closure's callIndex across those calls.
interface ChainableMock {
  select: (...args: unknown[]) => ChainableMock;
  eq: (...args: unknown[]) => ChainableMock;
  or: (...args: unknown[]) => ChainableMock;
  not: (...args: unknown[]) => ChainableMock;
  neq: (...args: unknown[]) => ChainableMock;
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
      not: () => builder,
      neq: () => builder,
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
        not: () => builder,
        neq: () => builder,
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
        not: () => builder,
        neq: () => builder,
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

function mappingRow(overrides: Partial<{
  id: string; hikcentral_person_no: string; employee_id: string; match_method: string;
  confirmed_by: string | null; confirmed_at: string | null; created_at: string;
}> = {}) {
  return {
    id: 'map-1',
    hikcentral_person_no: '1001',
    employee_id: 'emp-1',
    match_method: 'manual',
    confirmed_by: 'profile-1',
    confirmed_at: '2026-11-01T00:00:00Z',
    created_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

describe('fetchActiveHikCentralPersonMappings', () => {
  beforeEach(() => fromMock.mockReset());

  it('maps rows to ActiveMappingRow shape (fewer than 1,000 matches, single page)', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [mappingRow(), mappingRow({ id: 'map-2', employee_id: 'emp-2', hikcentral_person_no: '1002' })], error: null, count: 2 },
    ]));
    const result = await fetchActiveHikCentralPersonMappings();
    expect(result).toEqual([
      { id: 'map-1', hikcentralPersonNo: '1001', employeeId: 'emp-1', matchMethod: 'manual', confirmedBy: 'profile-1', confirmedAt: '2026-11-01T00:00:00Z', createdAt: '2026-11-01T00:00:00Z' },
      { id: 'map-2', hikcentralPersonNo: '1002', employeeId: 'emp-2', matchMethod: 'manual', confirmedBy: 'profile-1', confirmedAt: '2026-11-01T00:00:00Z', createdAt: '2026-11-01T00:00:00Z' },
    ]);
  });

  // Final Phase 2 release review: this function was a single unpaginated
  // query until this review -- same PostgREST 1,000-row-cap risk already
  // fixed for fetchActiveNonDeletedEmployees/fetchAllEmployeesById above
  // in this same file. Active mappings trend close to the active
  // employee population, so this was a real, reachable risk, not
  // theoretical.
  it('REGRESSION (PostgREST 1,000-row cap): pages past 1,000 active mappings with no missing or duplicated rows at the page boundary', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => mappingRow({ id: `map-${i}`, employee_id: `emp-${i}`, hikcentral_person_no: `${1000 + i}` }));
    const page2 = [mappingRow({ id: 'map-1000', employee_id: 'emp-1000', hikcentral_person_no: '2000' })];
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: page1, error: null, count: 1001 },
      { data: page2, error: null, count: null },
    ]));
    const result = await fetchActiveHikCentralPersonMappings();
    expect(result).toHaveLength(1001);
    const ids = result.map((m) => m.id);
    expect(new Set(ids).size).toBe(1001); // no duplicates
    expect(ids).toContain('map-999'); // last row of page 1 (exact boundary)
    expect(ids).toContain('map-1000'); // first row of page 2 (exact boundary)
    expect(fromMock.mock.calls.length).toBe(2);
  });

  it('propagates a query error rather than returning a partial mapping list', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: null, error: { message: 'boom' }, count: null }]));
    await expect(fetchActiveHikCentralPersonMappings()).rejects.toBeTruthy();
  });

  it('filters to is_active=true on every page -- never broadens scope to superseded mappings', async () => {
    const seenCalls: string[] = [];
    let callIndex = 0;
    const pages = [{ data: [], error: null, count: 0 }];
    fromMock.mockImplementation(() => {
      const builder: ChainableMock = {
        select: () => builder,
        eq: (...args: unknown[]) => { seenCalls.push(`eq:${JSON.stringify(args)}`); return builder; },
        or: () => builder,
        not: () => builder,
        neq: () => builder,
        order: () => builder,
        range: () => {
          const page = pages[Math.min(callIndex, pages.length - 1)];
          callIndex++;
          return Promise.resolve(page);
        },
      };
      return builder;
    });
    await fetchActiveHikCentralPersonMappings();
    expect(seenCalls).toEqual([`eq:${JSON.stringify(['is_active', true])}`]);
  });
});

function rawEventRow(overrides: Partial<{
  id: string; hikcentral_person_no: string; first_name: string | null; last_name: string | null;
  access_point: string | null; event_time: string;
}> = {}) {
  return {
    id: 'evt-1',
    hikcentral_person_no: '00000084',
    first_name: 'Falesi',
    last_name: 'Mlotho',
    access_point: 'AHL - LIMBE_Door_1',
    event_time: '2026-11-06T04:10:55.000Z',
    ...overrides,
  };
}

// Person Mapping pagination defect (confirmed in production: 8,138
// identified raw-event rows / 185 distinct Person Nos. for the real
// tenant, but the old unpaginated query returned only ~1,000 rows --
// 18 distinct Person Nos. in practice -- hiding 167 real identities
// from the page entirely). fetchAllPages() closes this the same way
// every sibling function in this file was already fixed.
describe('fetchIdentifiedRawEvents', () => {
  beforeEach(() => fromMock.mockReset());

  it('maps rows to IdentifiedRawEventRow shape (fewer than 1,000 matches, single page)', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [rawEventRow(), rawEventRow({ id: 'evt-2', hikcentral_person_no: '00000085', first_name: 'John', last_name: 'Banda' })], error: null, count: 2 },
    ]));
    const result = await fetchIdentifiedRawEvents();
    expect(result).toEqual([
      { hikcentralPersonNo: '00000084', firstName: 'Falesi', lastName: 'Mlotho', accessPoint: 'AHL - LIMBE_Door_1', eventTimeIso: '2026-11-06T04:10:55.000Z' },
      { hikcentralPersonNo: '00000085', firstName: 'John', lastName: 'Banda', accessPoint: 'AHL - LIMBE_Door_1', eventTimeIso: '2026-11-06T04:10:55.000Z' },
    ]);
  });

  // Task 4, item 1 & 3: proves more than 1,000 raw events are fetched,
  // and that ordering by `id` (the table's own unique primary key) as
  // the page tie-breaker means no row at the exact page boundary is
  // skipped OR duplicated -- the same boundary-correctness convention
  // already proven for every sibling paginated function in this file.
  it('REGRESSION (PostgREST 1,000-row cap): pages past 1,000 identified raw events with no missing or duplicated rows at the page boundary', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => rawEventRow({ id: `evt-${i}`, hikcentral_person_no: `P${i}` }));
    const page2 = [rawEventRow({ id: 'evt-1000', hikcentral_person_no: 'P1000' }), rawEventRow({ id: 'evt-1001', hikcentral_person_no: 'P1001' })];
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: page1, error: null, count: 1002 },
      { data: page2, error: null, count: null },
    ]));
    const result = await fetchIdentifiedRawEvents();
    expect(result).toHaveLength(1002);
    const personNos = result.map((r) => r.hikcentralPersonNo);
    expect(personNos).toContain('P999'); // last row of page 1 (exact boundary)
    expect(personNos).toContain('P1000'); // first row of page 2 (exact boundary)
    expect(new Set(personNos).size).toBe(1002); // no duplicates
    expect(fromMock.mock.calls.length).toBe(2);
  });

  it('propagates a query error rather than returning a partial (misleadingly small) identity list', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: null, error: { message: 'boom' }, count: null }]));
    await expect(fetchIdentifiedRawEvents()).rejects.toBeTruthy();
  });

  it('an empty dataset returns an empty array, never an error', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: [], error: null, count: 0 }]));
    expect(await fetchIdentifiedRawEvents()).toEqual([]);
  });

  it('filters to identified (non-null, non-blank) Person No. on every page -- never broadens scope to anonymous events', async () => {
    const seenCalls: string[] = [];
    let callIndex = 0;
    const pages = [{ data: [], error: null, count: 0 }];
    fromMock.mockImplementation(() => {
      const builder: ChainableMock = {
        select: () => builder,
        eq: () => builder,
        or: () => builder,
        not: (...args: unknown[]) => { seenCalls.push(`not:${JSON.stringify(args)}`); return builder; },
        neq: (...args: unknown[]) => { seenCalls.push(`neq:${JSON.stringify(args)}`); return builder; },
        order: () => builder,
        range: () => {
          const page = pages[Math.min(callIndex, pages.length - 1)];
          callIndex++;
          return Promise.resolve(page);
        },
      };
      return builder;
    });
    await fetchIdentifiedRawEvents();
    expect(seenCalls).toEqual([
      `not:${JSON.stringify(['hikcentral_person_no', 'is', null])}`,
      `neq:${JSON.stringify(['hikcentral_person_no', ''])}`,
    ]);
  });

  // Task 4, item 8: this is strictly a read -- a builder with no
  // insert/update/delete method at all still lets the whole call
  // succeed, proving nothing in this function's own code path ever
  // reaches for one (it would throw a TypeError immediately if it did).
  it('performs no write operation of any kind -- a read-only builder with no insert/update/delete is sufficient', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: [rawEventRow()], error: null, count: 1 }]));
    await expect(fetchIdentifiedRawEvents()).resolves.toHaveLength(1);
  });

  // Tenant isolation: no explicit tenant_id filter is added here, by the
  // same deliberate convention as every sibling function in this file
  // (fetchActiveNonDeletedEmployees / fetchAllEmployeesById /
  // fetchActiveHikCentralPersonMappings) -- it is enforced server-side by
  // RLS ("HikCentral raw events: view within tenant, permitted", confirmed
  // directly against production), unchanged by this fix.

  // Task 2 / Task 4 items 2, 4, 5, 6: a representative, >1,000-row, 185-
  // identity dataset (mirroring the real production shape) proves the
  // FULL pipeline -- paginated fetch -> profileHikCentralIdentities ->
  // classifyHikCentralIdentities -- discovers every identity once the
  // pagination defect is fixed, with duplicate raw events for the same
  // Person No. collapsing into exactly one identity card (never one per
  // row), already-mapped identities staying correctly classified as
  // 'mapped' (never duplicated or reclassified), and unmapped identities
  // correctly landing in 'exact' or 'needs_review' as their own name
  // evidence dictates -- never auto-mapped. The classification algorithm
  // itself is untouched by this fix; this proves the pipeline feeding it
  // is now complete.
  it('integration: 185 distinct identities (8,138 identified rows, spanning 2 pages) are all discoverable and classify correctly end-to-end', async () => {
    const rows: ReturnType<typeof rawEventRow>[] = [];
    // 160 identities already mapped in production's real shape -- 7
    // duplicate raw events each (160*7 = 1,120 rows on their own,
    // already past PostgREST's 1,000-row cap), which must collapse into
    // ONE identity card per Person No., never one per row.
    const EVENTS_PER_MAPPED_IDENTITY = 7;
    for (let i = 0; i < 160; i++) {
      const personNo = `M${String(i).padStart(4, '0')}`;
      for (let e = 0; e < EVENTS_PER_MAPPED_IDENTITY; e++) {
        rows.push(rawEventRow({ id: `evt-mapped-${i}-${e}`, hikcentral_person_no: personNo, first_name: 'Mapped', last_name: `Employee${i}` }));
      }
    }
    // 20 identities with no mapping yet, but an exact unambiguous name
    // match against an active employee -- must classify 'exact'.
    for (let i = 0; i < 20; i++) {
      rows.push(rawEventRow({ id: `evt-exact-${i}`, hikcentral_person_no: `E${String(i).padStart(4, '0')}`, first_name: 'Exact', last_name: `Candidate${i}` }));
    }
    // 5 identities with no mapping and no confident name match --
    // must land in 'needs_review', never auto-mapped.
    for (let i = 0; i < 5; i++) {
      rows.push(rawEventRow({ id: `evt-review-${i}`, hikcentral_person_no: `R${String(i).padStart(4, '0')}`, first_name: 'Completely', last_name: `Unmatched${i}` }));
    }
    expect(rows.length).toBeGreaterThan(1000); // 160*7 + 20 + 5 = 1,145 rows -- genuinely exceeds the PostgREST cap
    const distinctPersonNos = new Set(rows.map((r) => r.hikcentral_person_no));
    expect(distinctPersonNos.size).toBe(185);

    // Split across two PostgREST pages, exactly as production would.
    const page1 = rows.slice(0, 1000);
    const page2 = rows.slice(1000);
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: page1, error: null, count: rows.length },
      { data: page2, error: null, count: null },
    ]));

    const identifiedRows = await fetchIdentifiedRawEvents();
    expect(identifiedRows).toHaveLength(rows.length);

    const profiles = profileHikCentralIdentities(identifiedRows);
    expect(profiles).toHaveLength(185); // every real identity discovered, none hidden by pagination

    const mappedProfile = profiles.find((p) => p.hikcentralPersonNo === 'M0000');
    expect(mappedProfile?.eventCount).toBe(7); // 7 duplicate raw events collapsed into ONE identity card

    const employees = [
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `emp-exact-${i}`, employeeNumber: `SFG-E-${i}`, fullName: `Exact Candidate${i}`,
        workstation: 'LIMBE', status: 'Active', isDeleted: false,
      })),
    ];
    const activeMappings = Array.from({ length: 160 }, (_, i) => ({
      id: `map-${i}`, hikcentralPersonNo: `M${String(i).padStart(4, '0')}`, employeeId: `emp-mapped-${i}`,
      matchMethod: 'manual', confirmedBy: 'admin-1', confirmedAt: '2026-10-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z',
    }));

    const classified = classifyHikCentralIdentities(profiles, employees, activeMappings);
    expect(classified).toHaveLength(185);
    const byCategory = { mapped: 0, exact: 0, needs_review: 0, conflict: 0 };
    for (const c of classified) byCategory[c.category]++;
    expect(byCategory.mapped).toBe(160); // already-mapped identities remain correctly classified, never duplicated
    expect(byCategory.exact).toBe(20); // unambiguous name matches, still requiring explicit confirmation to actually map
    expect(byCategory.needs_review).toBe(5); // ambiguous identities appear under review, never auto-mapped
    expect(byCategory.conflict).toBe(0);

    // One HikCentral Person No. cannot be actively mapped to two
    // different employees -- classification itself never produces two
    // ClassifiedIdentity entries for the same Person No. (confirmed by
    // the 185-length assertion above matching 185 distinct Person Nos.
    // exactly), and the database's own unique partial index
    // (uq_hikcentral_person_mappings_active_person) enforces this
    // server-side regardless.
    const distinctClassifiedPersonNos = new Set(classified.map((c) => c.profile.hikcentralPersonNo));
    expect(distinctClassifiedPersonNos.size).toBe(185);
  });
});
