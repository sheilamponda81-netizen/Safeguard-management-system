import { describe, it, expect, vi, beforeEach } from 'vitest';

// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage C, Step 3.
// Verifies the read-only server-preview service: it must call the new
// preview RPC with exactly the worklist shape the server expects, map
// its snake_case response correctly, and never call any write-shaped
// Supabase method (.insert/.update/.upsert/.delete) anywhere.
const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import { fetchServerCalculationPreview, checkAutomaticAttendanceReadiness } from './attendanceServerPreviewService';

describe('fetchServerCalculationPreview', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('calls attendance_preview_calculate with a worklist shape (employee_ids array + date range), never a status/basis input', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await fetchServerCalculationPreview(['emp-1', 'emp-2'], '2026-10-01', '2026-10-03');
    expect(rpcMock).toHaveBeenCalledWith('attendance_preview_calculate', {
      p_employee_ids: ['emp-1', 'emp-2'],
      p_date_from: '2026-10-01',
      p_date_to: '2026-10-03',
    });
  });

  it('maps the RPC\'s snake_case rows to the camelCase shape the UI consumes', async () => {
    rpcMock.mockResolvedValue({
      data: [{
        employee_id: 'emp-1',
        attendance_date: '2026-10-01',
        status: 'absent',
        calculation_basis: null,
        check_in_at: null,
        check_out_at: null,
        reason: 'No valid fingerprint scans recorded for this scheduled shift after data coverage was confirmed complete.',
      }],
      error: null,
    });
    const rows = await fetchServerCalculationPreview(['emp-1'], '2026-10-01', '2026-10-01');
    expect(rows).toEqual([{
      employeeId: 'emp-1',
      attendanceDate: '2026-10-01',
      status: 'absent',
      calculationBasis: null,
      checkInAtIso: null,
      checkOutAtIso: null,
      reason: 'No valid fingerprint scans recorded for this scheduled shift after data coverage was confirmed complete.',
    }]);
  });

  it('propagates an RPC error (e.g. a permission or scope denial) rather than swallowing it', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Not authorized to preview automatic attendance calculations', code: '42501' } });
    await expect(fetchServerCalculationPreview(['emp-1'], '2026-10-01', '2026-10-01')).rejects.toBeTruthy();
  });

  it('never calls the RPC at all for an empty employee list', async () => {
    await fetchServerCalculationPreview([], '2026-10-01', '2026-10-01');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('checkAutomaticAttendanceReadiness', () => {
  // Supports both call shapes this service actually uses: awaited
  // directly after .select() (the head-count coverage query) and
  // awaited after a further .eq() (the three employee_id queries).
  function selectChain(data: unknown, error: unknown = null, count: number | null = null) {
    const resolved = Promise.resolve({ data, error, count });
    (resolved as unknown as { eq: () => Promise<unknown> }).eq = () => Promise.resolve({ data, error, count });
    return { select: vi.fn(() => resolved) };
  }

  beforeEach(() => {
    fromMock.mockReset();
  });

  it('reports zero overlap when no mapped employee has any roster evidence', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'hikcentral_person_mappings') return selectChain([{ employee_id: 'mapped-1' }, { employee_id: 'mapped-2' }]);
      if (table === 'roster_date_assignments') return selectChain([{ employee_id: 'rostered-1' }]);
      if (table === 'roster_off_day_patterns') return selectChain([]);
      if (table === 'fingerprint_coverage_confirmations') return selectChain(null, null, 0);
      throw new Error(`unexpected table ${table}`);
    });
    const result = await checkAutomaticAttendanceReadiness();
    expect(result.mappedEmployeeCount).toBe(2);
    expect(result.rosterEvidencedEmployeeCount).toBe(1);
    expect(result.overlapEmployeeCount).toBe(0);
    expect(result.coverageConfirmationCount).toBe(0);
  });

  it('counts a genuine overlap when a mapped employee also has roster evidence', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'hikcentral_person_mappings') return selectChain([{ employee_id: 'shared-1' }, { employee_id: 'mapped-only' }]);
      if (table === 'roster_date_assignments') return selectChain([{ employee_id: 'shared-1' }]);
      if (table === 'roster_off_day_patterns') return selectChain([]);
      if (table === 'fingerprint_coverage_confirmations') return selectChain(null, null, 3);
      throw new Error(`unexpected table ${table}`);
    });
    const result = await checkAutomaticAttendanceReadiness();
    expect(result.overlapEmployeeCount).toBe(1);
    expect(result.coverageConfirmationCount).toBe(3);
  });
});
