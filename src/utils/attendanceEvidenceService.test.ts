import { describe, it, expect, beforeEach, vi } from 'vitest';

const fromMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

const {
  fetchRawEventsForPersonInRange, fetchCoverageConfirmationsOverlapping, fetchImportBatchesByIds,
  fetchAuditTimelineForEmployeeDate, fetchActivePersonNoForEmployee, fetchAttendanceEvidenceDetail,
} = await import('./attendanceEvidenceService');

// Mirrors PR #55/#56's established ChainableMock/mockPaginatedFrom
// convention for fetchAllPages()-based functions.
interface ChainableMock {
  select: (...args: unknown[]) => ChainableMock;
  eq: (...args: unknown[]) => ChainableMock;
  gte: (...args: unknown[]) => ChainableMock;
  lte: (...args: unknown[]) => ChainableMock;
  lt: (...args: unknown[]) => ChainableMock;
  in: (...args: unknown[]) => ChainableMock;
  order: (...args: unknown[]) => ChainableMock;
  range: (...args: unknown[]) => Promise<{ data: unknown; error: unknown; count?: number | null }>;
  maybeSingle: (...args: unknown[]) => Promise<{ data: unknown; error: unknown }>;
}

function mockPaginatedFrom(pages: Array<{ data: unknown; error: unknown; count?: number | null }>) {
  let callIndex = 0;
  return () => {
    const builder: ChainableMock = {
      select: () => builder,
      eq: () => builder,
      gte: () => builder,
      lte: () => builder,
      lt: () => builder,
      in: () => builder,
      order: () => builder,
      range: () => {
        const page = pages[Math.min(callIndex, pages.length - 1)];
        callIndex++;
        return Promise.resolve(page);
      },
      maybeSingle: () => Promise.resolve(pages[0] as { data: unknown; error: unknown }),
    };
    return builder;
  };
}

describe('fetchRawEventsForPersonInRange', () => {
  beforeEach(() => fromMock.mockReset());

  it('maps rows for a single person (fewer than 1,000 matches, single page)', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [{ event_time: '2026-10-05T04:05:00.000Z', access_point: 'Gate 1', card_reader: 'R1', authentication_result: 'Authorized', event_type: 'Access Granted by Fingerprint', import_batch_id: 'batch-1' }], error: null, count: 1 },
    ]));
    const result = await fetchRawEventsForPersonInRange('00000164', '2026-10-05T00:00:00.000Z', '2026-10-06T00:00:00.000Z');
    expect(result).toEqual([{
      timestampIso: '2026-10-05T04:05:00.000Z', accessPoint: 'Gate 1', cardReader: 'R1',
      authenticationResult: 'Authorized', eventType: 'Access Granted by Fingerprint', importBatchId: 'batch-1',
    }]);
  });

  it('REGRESSION (PostgREST 1,000-row cap): pages past 1,000 rows for one person with no missing/duplicated rows', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ event_time: `2026-10-05T0${i % 10}:00:00.000Z`, access_point: 'Gate 1', card_reader: null, authentication_result: 'Authorized', event_type: 'Access Granted by Fingerprint', import_batch_id: `b${i}` }));
    const page2 = [{ event_time: '2026-10-05T23:00:00.000Z', access_point: 'Gate 1', card_reader: null, authentication_result: 'Authorized', event_type: 'Access Granted by Fingerprint', import_batch_id: 'b1000' }];
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: page1, error: null, count: 1001 },
      { data: page2, error: null, count: null },
    ]));
    const result = await fetchRawEventsForPersonInRange('00000164', '2026-10-05T00:00:00.000Z', '2026-10-06T00:00:00.000Z');
    expect(result).toHaveLength(1001);
    expect(fromMock.mock.calls.length).toBe(2);
  });

  it('propagates a query error rather than returning a partial event list', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: null, error: { message: 'boom' }, count: null }]));
    await expect(fetchRawEventsForPersonInRange('00000164', '2026-10-05T00:00:00.000Z', '2026-10-06T00:00:00.000Z')).rejects.toBeTruthy();
  });

  it('filters to the exact person number and date range on every page', async () => {
    const seenCalls: string[] = [];
    let callIndex = 0;
    const pages = [{ data: [], error: null, count: 0 }];
    fromMock.mockImplementation(() => {
      const builder: ChainableMock = {
        select: () => builder,
        eq: (...args: unknown[]) => { seenCalls.push(`eq:${JSON.stringify(args)}`); return builder; },
        gte: (...args: unknown[]) => { seenCalls.push(`gte:${JSON.stringify(args)}`); return builder; },
        lte: () => builder,
        lt: () => builder,
        in: () => builder,
        order: () => builder,
        range: () => {
          const page = pages[Math.min(callIndex, pages.length - 1)];
          callIndex++;
          return Promise.resolve(page);
        },
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return builder;
    });
    await fetchRawEventsForPersonInRange('00000164', '2026-10-05T00:00:00.000Z', '2026-10-06T00:00:00.000Z');
    expect(seenCalls).toEqual([
      `eq:${JSON.stringify(['hikcentral_person_no', '00000164'])}`,
      `gte:${JSON.stringify(['event_time', '2026-10-05T00:00:00.000Z'])}`,
    ]);
  });
});

describe('fetchCoverageConfirmationsOverlapping', () => {
  beforeEach(() => fromMock.mockReset());

  it('maps rows including revocation fields', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [{ confirmed_at: '2026-10-22T07:16:49.000Z', covers_from: '2026-10-10T22:00:00.000Z', covers_through: '2026-10-22T21:59:00.000Z', export_time_declared: '2026-10-22T21:59:00.000Z', access_points: ['Gate 1'], workstations: [], revoked_at: null, revoked_reason: null }], error: null, count: 1 },
    ]));
    const result = await fetchCoverageConfirmationsOverlapping('2026-10-22T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
    expect(result).toHaveLength(1);
    expect(result[0].revokedAt).toBeNull();
    expect(result[0].accessPoints).toEqual(['Gate 1']);
  });

  it('surfaces a revoked confirmation rather than hiding it', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [{ confirmed_at: '2026-10-22T07:16:49.000Z', covers_from: '2026-10-10T22:00:00.000Z', covers_through: '2026-10-22T21:59:00.000Z', export_time_declared: null, access_points: [], workstations: ['Head Office'], revoked_at: '2026-11-01T00:00:00.000Z', revoked_reason: 'Found to be premature' }], error: null, count: 1 },
    ]));
    const result = await fetchCoverageConfirmationsOverlapping('2026-10-22T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
    expect(result[0].revokedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(result[0].revokedReason).toBe('Found to be premature');
  });

  it('propagates a query error', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: null, error: { message: 'boom' }, count: null }]));
    await expect(fetchCoverageConfirmationsOverlapping('2026-10-22T00:00:00.000Z', '2026-10-23T00:00:00.000Z')).rejects.toBeTruthy();
  });
});

describe('fetchImportBatchesByIds', () => {
  beforeEach(() => fromMock.mockReset());

  it('returns [] without querying at all when given no ids', async () => {
    const result = await fetchImportBatchesByIds([]);
    expect(result).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('deduplicates ids before querying and maps the result', async () => {
    const inMock = vi.fn(() => Promise.resolve({ data: [{ id: 'batch-1', filename: 'f.xlsx', created_at: '2026-10-22T09:15:14.000Z', completed_at: '2026-10-22T09:15:20.000Z', status: 'completed' }], error: null }));
    fromMock.mockImplementation(() => ({ select: () => ({ in: inMock }) }));
    const result = await fetchImportBatchesByIds(['batch-1', 'batch-1', 'batch-1']);
    expect(inMock).toHaveBeenCalledWith('id', ['batch-1']);
    expect(result).toEqual([{ id: 'batch-1', filename: 'f.xlsx', createdAtIso: '2026-10-22T09:15:14.000Z', completedAtIso: '2026-10-22T09:15:20.000Z', status: 'completed' }]);
  });

  it('propagates a query error', async () => {
    fromMock.mockImplementation(() => ({ select: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }));
    await expect(fetchImportBatchesByIds(['batch-1'])).rejects.toBeTruthy();
  });
});

describe('fetchAuditTimelineForEmployeeDate', () => {
  beforeEach(() => fromMock.mockReset());

  it('maps rows oldest-first with reason/attribution intact', async () => {
    const orderMock = vi.fn(() => Promise.resolve({
      data: [{ old_status: null, new_status: 'A', old_calculation_basis: null, new_calculation_basis: null, changed_by: 'uid-1', change_source: 'automatic', reason: null, changed_at: '2026-10-22T07:16:49.000Z' }],
      error: null,
    }));
    fromMock.mockImplementation(() => ({ select: () => ({ eq: () => ({ eq: () => ({ order: orderMock }) }) }) }));
    const result = await fetchAuditTimelineForEmployeeDate('emp-1', '2026-10-22');
    expect(result).toEqual([{
      oldStatus: null, newStatus: 'A', oldCalculationBasis: null, newCalculationBasis: null,
      changedBy: 'uid-1', changeSource: 'automatic', reason: null, changedAtIso: '2026-10-22T07:16:49.000Z',
    }]);
  });

  it('returns [] for an employee-day with no recorded changes', async () => {
    fromMock.mockImplementation(() => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }) }));
    expect(await fetchAuditTimelineForEmployeeDate('emp-1', '2026-10-22')).toEqual([]);
  });

  it('propagates a query error', async () => {
    fromMock.mockImplementation(() => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }));
    await expect(fetchAuditTimelineForEmployeeDate('emp-1', '2026-10-22')).rejects.toBeTruthy();
  });
});

describe('fetchActivePersonNoForEmployee', () => {
  beforeEach(() => fromMock.mockReset());

  it('returns the active person number when a mapping exists', async () => {
    fromMock.mockImplementation(() => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { hikcentral_person_no: '00000164' }, error: null }) }) }) }) }));
    expect(await fetchActivePersonNoForEmployee('emp-1')).toBe('00000164');
  });

  it('returns null, never throwing, when no active mapping exists', async () => {
    fromMock.mockImplementation(() => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }));
    expect(await fetchActivePersonNoForEmployee('emp-1')).toBeNull();
  });
});

describe('fetchAttendanceEvidenceDetail (composition)', () => {
  beforeEach(() => { fromMock.mockReset(); rpcMock.mockReset(); });

  it('skips the raw-events fetch entirely for an unmapped employee, never fabricating evidence', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'hikcentral_person_mappings') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      if (table === 'attendance_audit_log') return { select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }) };
      if (table === 'fingerprint_coverage_confirmations') return mockPaginatedFrom([{ data: [], error: null, count: 0 }])();
      if (table === 'hikcentral_import_batches') return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
      throw new Error(`unexpected table ${table}`);
    });
    rpcMock.mockResolvedValue({ data: [], error: null });
    const detail = await fetchAttendanceEvidenceDetail('emp-1', '2026-10-22', '2026-10-21T22:00:00.000Z', '2026-10-23T02:00:00.000Z');
    expect(detail.rawEvents).toEqual([]);
    expect(detail.serverCalculation).toBeNull();
  });

  it('picks out the server calculation row matching the requested date, not just the first row returned', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'hikcentral_person_mappings') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      if (table === 'attendance_audit_log') return { select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }) };
      if (table === 'fingerprint_coverage_confirmations') return mockPaginatedFrom([{ data: [], error: null, count: 0 }])();
      if (table === 'hikcentral_import_batches') return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
      throw new Error(`unexpected table ${table}`);
    });
    rpcMock.mockResolvedValue({
      data: [
        { employee_id: 'emp-1', attendance_date: '2026-10-21', status: 'present', calculation_basis: 'confirmed', check_in_at: null, check_out_at: null, reason: 'r' },
        { employee_id: 'emp-1', attendance_date: '2026-10-22', status: 'absent', calculation_basis: null, check_in_at: null, check_out_at: null, reason: 'r2' },
      ],
      error: null,
    });
    const detail = await fetchAttendanceEvidenceDetail('emp-1', '2026-10-22', '2026-10-21T22:00:00.000Z', '2026-10-23T02:00:00.000Z');
    expect(detail.serverCalculation?.status).toBe('absent');
  });

  it('never calls any write method (.insert/.update/.upsert/.delete) anywhere in its dependency chain', async () => {
    fromMock.mockImplementation((table: string) => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        lte: () => builder,
        lt: () => builder,
        in: () => Promise.resolve({ data: [], error: null }),
        // Thenable AND chainable, like a real Supabase query builder: some
        // callers (audit log) terminate at .order() directly, others
        // (fetchAllPages-based) chain .range() after it.
        order: () => Object.assign(Promise.resolve({ data: [], error: null, count: 0 }), { range: () => Promise.resolve({ data: [], error: null, count: 0 }) }),
        range: () => Promise.resolve({ data: [], error: null, count: 0 }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: () => { throw new Error(`unexpected write: insert on ${table}`); },
        update: () => { throw new Error(`unexpected write: update on ${table}`); },
        upsert: () => { throw new Error(`unexpected write: upsert on ${table}`); },
        delete: () => { throw new Error(`unexpected write: delete on ${table}`); },
      };
      return builder;
    });
    rpcMock.mockResolvedValue({ data: [], error: null });
    await expect(fetchAttendanceEvidenceDetail('emp-1', '2026-10-22', '2026-10-21T22:00:00.000Z', '2026-10-23T02:00:00.000Z')).resolves.toBeTruthy();
  });
});
