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
  resolveStaffNames,
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
      { data: [{ confirmed_at: '2026-10-22T07:16:49.000Z', confirmed_by: 'admin-1', covers_from: '2026-10-10T22:00:00.000Z', covers_through: '2026-10-22T21:59:00.000Z', export_time_declared: '2026-10-22T21:59:00.000Z', access_points: ['Gate 1'], workstations: [], revoked_at: null, revoked_reason: null }], error: null, count: 1 },
    ]));
    const result = await fetchCoverageConfirmationsOverlapping('2026-10-22T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
    expect(result).toHaveLength(1);
    expect(result[0].revokedAt).toBeNull();
    expect(result[0].accessPoints).toEqual(['Gate 1']);
  });

  it('exposes confirmedBy so the durable administrator attribution is visible to a reviewer, not just stored in the database', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [{ confirmed_at: '2026-10-22T07:16:49.000Z', confirmed_by: 'admin-42', covers_from: '2026-10-10T22:00:00.000Z', covers_through: '2026-10-22T21:59:00.000Z', export_time_declared: null, access_points: ['Gate 1'], workstations: [], revoked_at: null, revoked_reason: null }], error: null, count: 1 },
    ]));
    const result = await fetchCoverageConfirmationsOverlapping('2026-10-22T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
    expect(result[0].confirmedBy).toBe('admin-42');
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

  it('Phase 3: surfaces the evidence-override fields when a confirmation exceeded observed evidence', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [{ confirmed_at: '2026-10-22T07:16:49.000Z', covers_from: '2026-10-10T22:00:00.000Z', covers_through: '2026-10-22T21:59:00.000Z', export_time_declared: '2026-10-22T21:59:00.000Z', access_points: ['Gate 1'], workstations: [], revoked_at: null, revoked_reason: null, latest_observed_event_at: '2026-10-22T07:16:00.000Z', exceeds_observed_evidence: true, override_reason: 'Vendor confirmed export complete despite device clock lag.', independently_verified: true }], error: null, count: 1 },
    ]));
    const result = await fetchCoverageConfirmationsOverlapping('2026-10-22T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
    expect(result[0].exceedsObservedEvidence).toBe(true);
    expect(result[0].latestObservedEventAtIso).toBe('2026-10-22T07:16:00.000Z');
    expect(result[0].overrideReason).toBe('Vendor confirmed export complete despite device clock lag.');
    expect(result[0].independentlyVerified).toBe(true);
  });

  it('Phase 3: defaults exceedsObservedEvidence to false for confirmations created before this field existed', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [{ confirmed_at: '2026-09-01T00:00:00.000Z', covers_from: '2026-09-01T00:00:00.000Z', covers_through: '2026-09-02T00:00:00.000Z', export_time_declared: null, access_points: ['Gate 1'], workstations: [], revoked_at: null, revoked_reason: null, latest_observed_event_at: null, exceeds_observed_evidence: null, override_reason: null, independently_verified: null }], error: null, count: 1 },
    ]));
    const result = await fetchCoverageConfirmationsOverlapping('2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
    expect(result[0].exceedsObservedEvidence).toBe(false);
    expect(result[0].latestObservedEventAtIso).toBeNull();
    expect(result[0].independentlyVerified).toBe(false);
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

describe('Part 3 (attendance accuracy/accountability update): resolveStaffNames', () => {
  beforeEach(() => rpcMock.mockReset());

  it('returns an empty map without calling the RPC when given no ids', async () => {
    const result = await resolveStaffNames([]);
    expect(result.size).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('de-duplicates and drops null/empty ids before calling the RPC', async () => {
    rpcMock.mockResolvedValue({ data: [{ user_id: 'u1', full_name: 'Jane HR Officer' }], error: null });
    await resolveStaffNames(['u1', 'u1', null, 'u1']);
    expect(rpcMock).toHaveBeenCalledWith('resolve_staff_names', { p_user_ids: ['u1'] });
  });

  it('maps the RPC rows into a user_id -> full_name map', async () => {
    rpcMock.mockResolvedValue({ data: [{ user_id: 'u1', full_name: 'Jane HR Officer' }, { user_id: 'u2', full_name: 'John Guard' }], error: null });
    const result = await resolveStaffNames(['u1', 'u2']);
    expect(result.get('u1')).toBe('Jane HR Officer');
    expect(result.get('u2')).toBe('John Guard');
  });

  it('an id with no resolvable profile is simply absent from the map, never fabricated', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const result = await resolveStaffNames(['unresolvable-id']);
    expect(result.has('unresolvable-id')).toBe(false);
  });

  it('propagates an RPC error (e.g. not authorized) rather than swallowing it', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Not authorized to view attendance' } });
    await expect(resolveStaffNames(['u1'])).rejects.toBeTruthy();
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

  it('Part 3: resolves auditTimeline.changedBy and coverageConfirmations.confirmedBy into namesByUserId', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'hikcentral_person_mappings') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      if (table === 'attendance_audit_log') {
        const auditOrderResult = Promise.resolve({
          data: [{ old_status: null, new_status: 'A', old_calculation_basis: null, new_calculation_basis: null, changed_by: 'uid-manual-1', change_source: 'manual', reason: 'Confirmed with site supervisor.', changed_at: '2026-11-16T09:22:00.000Z' }],
          error: null,
        });
        return { select: () => ({ eq: () => ({ eq: () => ({ order: () => auditOrderResult }) }) }) };
      }
      if (table === 'fingerprint_coverage_confirmations') {
        return mockPaginatedFrom([{
          data: [{ confirmed_at: '2026-11-15T00:00:00.000Z', confirmed_by: 'uid-confirmer-1', covers_from: '2026-11-15T00:00:00.000Z', covers_through: '2026-11-17T00:00:00.000Z', export_time_declared: null, access_points: ['Gate 1'], workstations: [], revoked_at: null, revoked_reason: null }],
          error: null, count: 1,
        }])();
      }
      if (table === 'hikcentral_import_batches') return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
      throw new Error(`unexpected table ${table}`);
    });
    rpcMock.mockImplementation((name: string) => {
      if (name === 'resolve_staff_names') {
        return Promise.resolve({ data: [{ user_id: 'uid-manual-1', full_name: 'Jane HR Officer' }, { user_id: 'uid-confirmer-1', full_name: 'John Admin' }], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });
    const detail = await fetchAttendanceEvidenceDetail('emp-1', '2026-11-16', '2026-11-15T22:00:00.000Z', '2026-11-17T02:00:00.000Z');
    expect(rpcMock).toHaveBeenCalledWith('resolve_staff_names', { p_user_ids: expect.arrayContaining(['uid-manual-1', 'uid-confirmer-1']) });
    expect(detail.namesByUserId.get('uid-manual-1')).toBe('Jane HR Officer');
    expect(detail.namesByUserId.get('uid-confirmer-1')).toBe('John Admin');
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
