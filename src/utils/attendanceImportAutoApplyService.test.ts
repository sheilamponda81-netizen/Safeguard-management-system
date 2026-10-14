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

describe('fetchDistinctWorkstations', () => {
  beforeEach(() => fromMock.mockReset());

  it('returns distinct, sorted, non-empty workstation values for active non-deleted employees', async () => {
    fromMock.mockImplementationOnce(() => ({
      select: () => ({ not: () => ({ eq: () => ({ eq: () => Promise.resolve({
        data: [{ workstation: 'Gate 2' }, { workstation: 'Gate 1' }, { workstation: 'Gate 1' }, { workstation: '' }, { workstation: null }],
        error: null,
      }) }) }) }),
    }));
    const result = await fetchDistinctWorkstations();
    expect(result).toEqual(['Gate 1', 'Gate 2']);
  });

  it('propagates a query error rather than swallowing it', async () => {
    fromMock.mockImplementationOnce(() => ({
      select: () => ({ not: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    }));
    await expect(fetchDistinctWorkstations()).rejects.toBeTruthy();
  });
});

describe('processHikCentralImportBatch', () => {
  beforeEach(() => rpcMock.mockReset());

  it('calls attendance_process_import_batch with the converted coverage window and declared scope', async () => {
    rpcMock.mockResolvedValue({
      data: { confirmation_id: 'c1', employee_count: 3, applied_count: 2, unchanged_count: 1, skipped_count: 0, failed_count: 0, rows: [] },
      error: null,
    });
    const result = await processHikCentralImportBatch({
      importBatchId: 'b1',
      workstations: ['Gate 1'],
      periodFromDate: '2026-10-01',
      periodToDate: '2026-10-04',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-04',
    });

    expect(rpcMock).toHaveBeenCalledWith('attendance_process_import_batch', {
      p_import_batch_id: 'b1',
      p_workstations: ['Gate 1'],
      p_covers_from: '2026-09-30T22:00:00.000Z',
      p_covers_through: '2026-10-04T21:59:00.000Z',
      p_date_from: '2026-10-01',
      p_date_to: '2026-10-04',
      p_notes: null,
      p_access_points: null,
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
    });
  });

  it('Stage C Step 8B: passes the observed access points through to p_access_points when supplied', async () => {
    rpcMock.mockResolvedValue({
      data: { confirmation_id: 'c1', employee_count: 1, applied_count: 1, unchanged_count: 0, skipped_count: 0, failed_count: 0, rows: [] },
      error: null,
    });
    await processHikCentralImportBatch({
      importBatchId: 'b1', workstations: ['Gate 1'], periodFromDate: '2026-10-01', periodToDate: '2026-10-01', dateFrom: '2026-10-01', dateTo: '2026-10-01',
      accessPoints: ['GATE1', 'LIMBE-MAIN'],
    });
    expect(rpcMock).toHaveBeenCalledWith('attendance_process_import_batch', expect.objectContaining({
      p_access_points: ['GATE1', 'LIMBE-MAIN'],
    }));
  });

  it('Stage C Step 8B: an empty accessPoints array is sent as null, not an empty array (no accidental all-exclude/all-include ambiguity)', async () => {
    rpcMock.mockResolvedValue({
      data: { confirmation_id: 'c1', employee_count: 1, applied_count: 1, unchanged_count: 0, skipped_count: 0, failed_count: 0, rows: [] },
      error: null,
    });
    await processHikCentralImportBatch({
      importBatchId: 'b1', workstations: ['Gate 1'], periodFromDate: '2026-10-01', periodToDate: '2026-10-01', dateFrom: '2026-10-01', dateTo: '2026-10-01',
      accessPoints: [],
    });
    expect(rpcMock).toHaveBeenCalledWith('attendance_process_import_batch', expect.objectContaining({
      p_access_points: null,
    }));
  });

  it('reports a distinct missing_rpc outcome when the migration is not yet applied', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    const result = await processHikCentralImportBatch({
      importBatchId: 'b1', workstations: ['Gate 1'], periodFromDate: '2026-10-01', periodToDate: '2026-10-01', dateFrom: '2026-10-01', dateTo: '2026-10-01',
    });
    expect(result).toEqual({ success: false, outcome: 'missing_rpc', error: expect.any(String) });
  });

  it('reports a distinct unauthorized outcome for any other RPC error, never throwing', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'Not authorized to confirm fingerprint coverage' } });
    const result = await processHikCentralImportBatch({
      importBatchId: 'b1', workstations: ['Gate 1'], periodFromDate: '2026-10-01', periodToDate: '2026-10-01', dateFrom: '2026-10-01', dateTo: '2026-10-01',
    });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('unauthorized');
    expect(result.error).toBe('Not authorized to confirm fingerprint coverage');
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
