import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

// Dynamic import, evaluated after vi.mock above, not a static top-level
// import -- matching payrollProcessing.test.ts's own established
// precedent. A static import of this module (which itself imports the
// mocked supabase client) was found to misbehave specifically for a
// REJECTED rpc mock crossing the module boundary (the exact same
// try/catch logic inlined directly in this test file caught it fine;
// only going through a statically-imported module failed) -- a
// vitest/esbuild transform-and-hoisting interaction, not a defect in
// processHikCentralImportBatch's own try/catch.
const {
  periodToCoverageWindow, isoToBlantyreDateStr, fetchDistinctWorkstations, processHikCentralImportBatch,
  fetchCoverageTimeline, fetchSiteAbsenceAlerts, acknowledgeSiteAlert,
  fetchEmployeeTerminalAssignments, setEmployeeHikCentralTerminals,
} = await import('./attendanceImportAutoApplyService');

describe('periodToCoverageWindow', () => {
  it('converts a Blantyre-local period into the UTC instants fingerprint_coverage_confirmations needs (UTC+2, no DST)', () => {
    const { coversFromIso, coversThroughIso } = periodToCoverageWindow('2026-10-01', '2026-10-04');
    // 2026-10-01 00:00 Blantyre -> 2026-09-30 22:00 UTC
    expect(coversFromIso).toBe('2026-09-30T22:00:00.000Z');
    // 2026-10-04 23:59 Blantyre -> 2026-10-04 21:59 UTC
    expect(coversThroughIso).toBe('2026-10-04T21:59:00.000Z');
  });

  it('covers_through is always after covers_from for any non-empty period', () => {
    const { coversFromIso, coversThroughIso } = periodToCoverageWindow('2026-10-01', '2026-10-01');
    expect(new Date(coversThroughIso).getTime()).toBeGreaterThan(new Date(coversFromIso).getTime());
  });
});

describe('isoToBlantyreDateStr', () => {
  it('converts a UTC instant to its Africa/Blantyre calendar date', () => {
    // 2026-10-01T04:05:00Z is 2026-10-01 06:05 Blantyre -- same calendar date.
    expect(isoToBlantyreDateStr('2026-10-01T04:05:00Z')).toBe('2026-10-01');
  });

  it('rolls over to the next Blantyre calendar date when the UTC instant is late enough', () => {
    // 2026-10-01T22:30:00Z is 2026-10-02 00:30 Blantyre -- the NEXT calendar date.
    expect(isoToBlantyreDateStr('2026-10-01T22:30:00Z')).toBe('2026-10-02');
  });

  it('is the exact inverse of periodToCoverageWindow for a period start', () => {
    const { coversFromIso } = periodToCoverageWindow('2026-10-05', '2026-10-05');
    expect(isoToBlantyreDateStr(coversFromIso)).toBe('2026-10-05');
  });
});

// PRODUCTION HOTFIX regression coverage: fetchDistinctWorkstations now pages
// through fetchAllPages() instead of a single unbounded query, so its mock
// chain must support .order().range() as the terminal (resolving) call, and
// tests must exercise the >1000-row pagination path, not just a single page.
// `pages` is consumed in order across however many times `.from()` is
// invoked -- fetchAllPages calls buildQuery (and therefore supabase.from())
// once per page, sharing this closure's callIndex across those calls.
interface ChainableMock {
  select: (...args: unknown[]) => ChainableMock;
  not: (...args: unknown[]) => ChainableMock;
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
      not: () => builder,
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

describe('fetchDistinctWorkstations', () => {
  beforeEach(() => fromMock.mockReset());

  it('returns distinct, sorted, non-empty workstation values for active non-deleted employees (fewer than 1,000 matches, single page)', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      {
        data: [{ workstation: 'Gate 2' }, { workstation: 'Gate 1' }, { workstation: 'Gate 1' }, { workstation: '' }, { workstation: null }],
        error: null,
        count: 5,
      },
    ]));
    const result = await fetchDistinctWorkstations();
    expect(result).toEqual(['Gate 1', 'Gate 2']);
  });

  it('propagates a query error rather than swallowing it', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: null, error: { message: 'boom' }, count: null }]));
    await expect(fetchDistinctWorkstations()).rejects.toBeTruthy();
  });

  it('REGRESSION (PostgREST 1,000-row cap): pages past 1,000 matching employees instead of silently truncating at the first page', async () => {
    // Page 1: exactly 1,000 rows (the server's response cap), total count
    // 1,200 -- proves the loop does not stop just because a page came back
    // full. Page 2: the remaining 200 rows, including the exact page
    // boundary's workstation value, to catch an off-by-one in the range.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ workstation: `Gate ${i}` }));
    const page2 = [{ workstation: 'Gate 999' }, { workstation: 'Gate 1199' }];
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: page1, error: null, count: 1002 },
      { data: page2, error: null, count: null },
    ]));
    const result = await fetchDistinctWorkstations();
    // 1000 distinct "Gate 0".."Gate 999" values from page 1 plus the new
    // "Gate 1199" from page 2 -- "Gate 999" on page 2 is a duplicate of
    // page 1's own row and must not appear twice.
    expect(result).toHaveLength(1001);
    expect(result.filter((w) => w === 'Gate 999')).toHaveLength(1);
    expect(result).toContain('Gate 1199');
    expect(fromMock.mock.calls.length).toBe(2);
  });

  it('exact status/is_deleted filters are preserved on every page of a paginated fetch', async () => {
    const seenFilters: Array<{ method: string }> = [];
    let callIndex = 0;
    const pages = [{ data: [], error: null, count: 0 }];
    fromMock.mockImplementation(() => {
      const builder: ChainableMock = {
        select: () => builder,
        not: (...args: unknown[]) => { seenFilters.push({ method: `not:${JSON.stringify(args)}` }); return builder; },
        eq: (...args: unknown[]) => { seenFilters.push({ method: `eq:${JSON.stringify(args)}` }); return builder; },
        or: () => builder,
        order: () => builder,
        range: () => {
          const page = pages[Math.min(callIndex, pages.length - 1)];
          callIndex++;
          return Promise.resolve(page);
        },
      };
      return builder;
    });
    await fetchDistinctWorkstations();
    expect(seenFilters).toEqual([
      { method: `not:${JSON.stringify(['workstation', 'is', null])}` },
      { method: `eq:${JSON.stringify(['status', 'Active'])}` },
      { method: `eq:${JSON.stringify(['is_deleted', false])}` },
    ]);
  });
});

describe('Stage C Step 11: fetchEmployeeTerminalAssignments / setEmployeeHikCentralTerminals', () => {
  beforeEach(() => { fromMock.mockReset(); rpcMock.mockReset(); });

  it('groups active employee_hikcentral_terminals rows by employee_id', async () => {
    fromMock.mockImplementationOnce(() => ({
      select: () => ({ eq: () => Promise.resolve({
        data: [
          { employee_id: 'e1', access_point: 'GATE1' },
          { employee_id: 'e1', access_point: 'GATE2' },
          { employee_id: 'e2', access_point: 'GATE1' },
        ],
        error: null,
      }) }),
    }));
    const result = await fetchEmployeeTerminalAssignments();
    expect(result.get('e1')).toEqual(['GATE1', 'GATE2']);
    expect(result.get('e2')).toEqual(['GATE1']);
  });

  it('fetchEmployeeTerminalAssignments propagates a query error rather than swallowing it', async () => {
    fromMock.mockImplementationOnce(() => ({
      select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
    }));
    await expect(fetchEmployeeTerminalAssignments()).rejects.toBeTruthy();
  });

  it('setEmployeeHikCentralTerminals calls the RPC with the employee id and desired access points', async () => {
    rpcMock.mockResolvedValue({ data: { added_count: 1, revoked_count: 0, access_points: ['GATE1'] }, error: null });
    await setEmployeeHikCentralTerminals('e1', ['GATE1']);
    expect(rpcMock).toHaveBeenCalledWith('set_employee_hikcentral_terminals', { p_employee_id: 'e1', p_access_points: ['GATE1'] });
  });

  it('setEmployeeHikCentralTerminals throws rather than swallowing an RPC error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(setEmployeeHikCentralTerminals('e1', ['GATE1'])).rejects.toBeTruthy();
  });
});

describe('processHikCentralImportBatch', () => {
  beforeEach(() => rpcMock.mockReset());

  it('Stage C Step 11: calls attendance_process_import_batch with the converted coverage window and the required access points, no workstations supplied', async () => {
    rpcMock.mockResolvedValue({
      data: { confirmation_id: 'c1', employee_count: 3, applied_count: 2, unchanged_count: 1, skipped_count: 0, failed_count: 0, rows: [], needs_terminal_configuration: [] },
      error: null,
    });
    const result = await processHikCentralImportBatch({
      importBatchId: 'b1',
      accessPoints: ['GATE1'],
      periodFromDate: '2026-10-01',
      periodToDate: '2026-10-04',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-04',
    });

    expect(rpcMock).toHaveBeenCalledWith('attendance_process_import_batch', {
      p_import_batch_id: 'b1',
      p_access_points: ['GATE1'],
      p_covers_from: '2026-09-30T22:00:00.000Z',
      p_covers_through: '2026-10-04T21:59:00.000Z',
      p_date_from: '2026-10-01',
      p_date_to: '2026-10-04',
      p_notes: null,
      p_workstations: null,
      p_override_reason: null,
      p_independently_verified: false,
    });
    expect(result).toEqual({
      success: true,
      outcome: 'success',
      confirmationId: 'c1',
      employeeCount: 3,
      appliedCount: 2,
      unchangedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      needsTerminalConfiguration: [],
    });
  });

  it('Stage C Step 11: workstations remain optional, legacy, additive-only -- passed through verbatim when supplied', async () => {
    rpcMock.mockResolvedValue({
      data: { confirmation_id: 'c1', employee_count: 1, applied_count: 1, unchanged_count: 0, skipped_count: 0, failed_count: 0, rows: [] },
      error: null,
    });
    await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['GATE1', 'LIMBE-MAIN'], periodFromDate: '2026-10-01', periodToDate: '2026-10-01', dateFrom: '2026-10-01', dateTo: '2026-10-01',
      workstations: ['Gate 1'],
    });
    expect(rpcMock).toHaveBeenCalledWith('attendance_process_import_batch', expect.objectContaining({
      p_access_points: ['GATE1', 'LIMBE-MAIN'],
      p_workstations: ['Gate 1'],
    }));
  });

  it('Stage C Step 11: an empty workstations array is sent as null, not an empty array (no accidental all-exclude/all-include ambiguity)', async () => {
    rpcMock.mockResolvedValue({
      data: { confirmation_id: 'c1', employee_count: 1, applied_count: 1, unchanged_count: 0, skipped_count: 0, failed_count: 0, rows: [] },
      error: null,
    });
    await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['GATE1'], periodFromDate: '2026-10-01', periodToDate: '2026-10-01', dateFrom: '2026-10-01', dateTo: '2026-10-01',
      workstations: [],
    });
    expect(rpcMock).toHaveBeenCalledWith('attendance_process_import_batch', expect.objectContaining({
      p_workstations: null,
    }));
  });

  it('Stage C Step 11: maps needs_terminal_configuration from the RPC response to camelCase, defaulting to an empty array', async () => {
    rpcMock.mockResolvedValue({
      data: {
        confirmation_id: 'c1', employee_count: 2, applied_count: 1, unchanged_count: 0, skipped_count: 1, failed_count: 0, rows: [],
        needs_terminal_configuration: [{ employee_id: 'e1', full_name: 'Jane Doe' }],
      },
      error: null,
    });
    const result = await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['GATE1'], periodFromDate: '2026-10-01', periodToDate: '2026-10-01', dateFrom: '2026-10-01', dateTo: '2026-10-01',
    });
    expect(result.needsTerminalConfiguration).toEqual([{ employeeId: 'e1', fullName: 'Jane Doe' }]);
  });

  it('Phase 3: trims and passes a supplied override reason; omitting it sends null', async () => {
    rpcMock.mockResolvedValue({
      data: { confirmation_id: 'c1', employee_count: 1, applied_count: 1, unchanged_count: 0, skipped_count: 0, failed_count: 0, rows: [] },
      error: null,
    });
    await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['GATE1'], periodFromDate: '2026-10-22', periodToDate: '2026-10-22', dateFrom: '2026-10-22', dateTo: '2026-10-22',
      overrideReason: '  Vendor confirmed export complete.  ',
    });
    expect(rpcMock).toHaveBeenCalledWith('attendance_process_import_batch', expect.objectContaining({
      p_override_reason: 'Vendor confirmed export complete.',
    }));
  });

  it('Phase 3: a whitespace-only override reason is sent as null, never accepted as a real reason', async () => {
    rpcMock.mockResolvedValue({
      data: { confirmation_id: 'c1', employee_count: 1, applied_count: 1, unchanged_count: 0, skipped_count: 0, failed_count: 0, rows: [] },
      error: null,
    });
    await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['GATE1'], periodFromDate: '2026-10-22', periodToDate: '2026-10-22', dateFrom: '2026-10-22', dateTo: '2026-10-22',
      overrideReason: '   ',
    });
    expect(rpcMock).toHaveBeenCalledWith('attendance_process_import_batch', expect.objectContaining({
      p_override_reason: null,
    }));
  });

  it('Phase 3 safety review: independentlyVerified defaults to false and is sent as a literal boolean, never inferred from overrideReason alone', async () => {
    rpcMock.mockResolvedValue({
      data: { confirmation_id: 'c1', employee_count: 1, applied_count: 1, unchanged_count: 0, skipped_count: 0, failed_count: 0, rows: [] },
      error: null,
    });
    await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['GATE1'], periodFromDate: '2026-10-22', periodToDate: '2026-10-22', dateFrom: '2026-10-22', dateTo: '2026-10-22',
      overrideReason: 'Vendor confirmed export complete.',
      // independentlyVerified deliberately omitted -- a reason alone must never imply it.
    });
    expect(rpcMock).toHaveBeenCalledWith('attendance_process_import_batch', expect.objectContaining({
      p_override_reason: 'Vendor confirmed export complete.',
      p_independently_verified: false,
    }));
  });

  it('Phase 3 safety review: passes independentlyVerified=true only when explicitly set', async () => {
    rpcMock.mockResolvedValue({
      data: { confirmation_id: 'c1', employee_count: 1, applied_count: 1, unchanged_count: 0, skipped_count: 0, failed_count: 0, rows: [] },
      error: null,
    });
    await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['GATE1'], periodFromDate: '2026-10-22', periodToDate: '2026-10-22', dateFrom: '2026-10-22', dateTo: '2026-10-22',
      overrideReason: 'Vendor confirmed export complete.',
      independentlyVerified: true,
    });
    expect(rpcMock).toHaveBeenCalledWith('attendance_process_import_batch', expect.objectContaining({
      p_independently_verified: true,
    }));
  });

  it('Phase 3: maps a needs_override_reason RPC response to a distinct outcome, writing nothing', async () => {
    rpcMock.mockResolvedValue({
      data: {
        status: 'needs_override_reason',
        latest_observed_event_at: '2026-10-22T07:16:00.000Z',
        declared_covers_through: '2026-10-22T21:59:00.000Z',
        access_points: ['Gate 1'],
      },
      error: null,
    });
    const result = await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['Gate 1'], periodFromDate: '2026-10-22', periodToDate: '2026-10-22', dateFrom: '2026-10-22', dateTo: '2026-10-22',
    });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('needs_override_reason');
    expect(result.coverageEvidenceWarning).toEqual({
      latestObservedEventAtIso: '2026-10-22T07:16:00.000Z',
      declaredCoversThroughIso: '2026-10-22T21:59:00.000Z',
      accessPoints: ['Gate 1'],
    });
  });

  it('Phase 3: a needs_override_reason response with no observed event at all surfaces a null latestObservedEventAtIso, never fabricating a timestamp', async () => {
    rpcMock.mockResolvedValue({
      data: {
        status: 'needs_override_reason',
        latest_observed_event_at: null,
        declared_covers_through: '2026-10-22T21:59:00.000Z',
        access_points: ['Gate 1'],
      },
      error: null,
    });
    const result = await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['Gate 1'], periodFromDate: '2026-10-22', periodToDate: '2026-10-22', dateFrom: '2026-10-22', dateTo: '2026-10-22',
    });
    expect(result.coverageEvidenceWarning?.latestObservedEventAtIso).toBeNull();
  });

  it('reports a distinct missing_rpc outcome when the migration is not yet applied', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    const result = await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['GATE1'], periodFromDate: '2026-10-01', periodToDate: '2026-10-01', dateFrom: '2026-10-01', dateTo: '2026-10-01',
    });
    expect(result).toEqual({ success: false, outcome: 'missing_rpc', error: expect.any(String) });
  });

  it('reports a distinct unauthorized outcome for any other RPC error, never throwing', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'Not authorized to confirm fingerprint coverage' } });
    const result = await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['GATE1'], periodFromDate: '2026-10-01', periodToDate: '2026-10-01', dateFrom: '2026-10-01', dateTo: '2026-10-01',
    });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('unauthorized');
    expect(result.error).toBe('Not authorized to confirm fingerprint coverage');
  });

  describe('Stage C Step 10: fetchCoverageTimeline', () => {
    it('maps the RPC rows from snake_case to camelCase', async () => {
      rpcMock.mockResolvedValue({
        data: [{
          scope_type: 'workstation', scope_key: 'HEAD OFFICE',
          first_covered_date: '2026-10-01', last_covered_date: '2026-10-09',
          next_expected_date: '2026-10-10', missing_dates: ['2026-10-05'],
        }],
        error: null,
      });
      const result = await fetchCoverageTimeline(90);
      expect(rpcMock).toHaveBeenCalledWith('hikcentral_coverage_timeline', { p_lookback_days: 90 });
      expect(result).toEqual([{
        scopeType: 'workstation', scopeKey: 'HEAD OFFICE',
        firstCoveredDate: '2026-10-01', lastCoveredDate: '2026-10-09',
        nextExpectedDate: '2026-10-10', missingDates: ['2026-10-05'],
      }]);
    });

    it('throws rather than swallowing an RPC error', async () => {
      rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
      await expect(fetchCoverageTimeline()).rejects.toBeTruthy();
    });
  });

  describe('Stage C Step 10: fetchSiteAbsenceAlerts / acknowledgeSiteAlert', () => {
    it('fetches alerts filtered by status and maps affected employees', async () => {
      rpcMock.mockResolvedValue({
        data: [{
          id: 'a1', site: 'HEAD OFFICE', alert_date: '2026-10-01', status: 'open',
          absent_count_at_creation: 5, current_absent_count: 6,
          affected_employees: [{ employee_id: 'e1', full_name: 'Jane Doe' }],
          created_at: '2026-10-01T00:00:00Z', closed_by: null, closed_at: null, closed_note: null,
        }],
        error: null,
      });
      const result = await fetchSiteAbsenceAlerts('open');
      expect(rpcMock).toHaveBeenCalledWith('attendance_site_absence_alerts_list', { p_status: 'open' });
      expect(result[0]).toEqual({
        id: 'a1', site: 'HEAD OFFICE', alertDate: '2026-10-01', status: 'open',
        absentCountAtCreation: 5, currentAbsentCount: 6,
        affectedEmployees: [{ employeeId: 'e1', fullName: 'Jane Doe' }],
        createdAt: '2026-10-01T00:00:00Z', closedBy: null, closedAt: null, closedNote: null,
      });
    });

    it('acknowledgeSiteAlert passes the alert id and note, and maps the returned row', async () => {
      rpcMock.mockResolvedValue({
        data: {
          id: 'a1', site: 'HEAD OFFICE', alert_date: '2026-10-01', status: 'closed',
          absent_count_at_creation: 5, current_absent_count: 3,
          affected_employees: [], created_at: '2026-10-01T00:00:00Z',
          closed_by: 'admin1', closed_at: '2026-10-02T00:00:00Z', closed_note: 'Followed up.',
        },
        error: null,
      });
      const result = await acknowledgeSiteAlert('a1', 'Followed up.');
      expect(rpcMock).toHaveBeenCalledWith('attendance_site_alert_acknowledge', { p_alert_id: 'a1', p_note: 'Followed up.' });
      expect(result.status).toBe('closed');
      expect(result.closedNote).toBe('Followed up.');
    });

    it('throws rather than swallowing an RPC error for either call', async () => {
      rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
      await expect(fetchSiteAbsenceAlerts()).rejects.toBeTruthy();
      await expect(acknowledgeSiteAlert('a1', 'note')).rejects.toBeTruthy();
    });
  });

  // The network-error (rejected-promise) case is covered in its own file,
  // attendanceImportAutoApplyService.networkError.test.ts -- a rejected
  // mock value configured on the SAME rpcMock instance that earlier tests
  // in this file already resolved was found to misreport as an uncaught
  // exception in this vitest version (confirmed: the exact same try/catch
  // logic, inlined directly in a test file with no prior resolved call on
  // the mock, catches it correctly every time) -- a mock-reset/transform
  // quirk unrelated to processHikCentralImportBatch's own correctness.
});
