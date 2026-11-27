import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

import { processHikCentralImportBatch, splitAttendanceProcessingDays } from './attendanceImportAutoApplyService';

const args = {
  importBatchId: 'existing-saved-batch',
  accessPoints: ['AHL - KANENGO_Door_1'],
  periodFromDate: '2026-11-01',
  periodToDate: '2026-11-03',
  dateFrom: '2026-11-01',
  dateTo: '2026-11-03',
};

function successful(day: number) {
  return {
    data: {
      confirmation_id: 'same-coverage',
      employee_count: 2,
      applied_count: 1,
      unchanged_count: 0,
      skipped_count: 1,
      failed_count: 0,
      rows: [
        { employee_id: 'e1', attendance_date: `2026-11-0${day}`, outcome: 'written' },
        { employee_id: 'e2', attendance_date: `2026-11-0${day}`, outcome: 'skipped_pending' },
      ],
      needs_terminal_configuration: [],
    },
    error: null,
  };
}

describe('timeout-safe HikCentral attendance processing', () => {
  beforeEach(() => rpc.mockReset());

  it('splits dates in Blantyre calendar order and validates input', () => {
    expect(splitAttendanceProcessingDays('2026-11-01', '2026-11-03')).toEqual(['2026-11-01','2026-11-02','2026-11-03']);
    expect(splitAttendanceProcessingDays('2026-11-30', '2026-12-01')).toEqual(['2026-11-30','2026-12-01']);
    expect(() => splitAttendanceProcessingDays('2026-11-03','2026-11-01')).toThrow();
    expect(() => splitAttendanceProcessingDays('2026-02-30','2026-03-01')).toThrow();
  });

  it('keeps original evidence bounds and batch identity, but uses one-day RPCs', async () => {
    rpc.mockResolvedValueOnce(successful(1)).mockResolvedValueOnce(successful(2)).mockResolvedValueOnce(successful(3));
    const onProgress = vi.fn();
    const result = await processHikCentralImportBatch({ ...args, onProgress });
    expect(result).toMatchObject({ success: true, appliedCount: 3, employeeCount: 2 });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls.map((c: unknown[]) => (c[1] as {p_date_from:string}).p_date_from)).toEqual(['2026-11-01','2026-11-02','2026-11-03']);
    for (const c of rpc.mock.calls) {
      const p = c[1] as Record<string, unknown>;
      expect(p.p_import_batch_id).toBe('existing-saved-batch');
      expect(p.p_covers_from).toBe('2026-10-31T22:00:00.000Z');
      expect(p.p_covers_through).toBe('2026-11-03T21:59:00.000Z');
      expect(p.p_date_from).toBe(p.p_date_to);
    }
    expect(onProgress).toHaveBeenLastCalledWith(3,3);
  });

  it('reports committed partial progress without claiming success and is safe to retry', async () => {
    rpc.mockResolvedValueOnce(successful(1)).mockResolvedValueOnce({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    });
    const result = await processHikCentralImportBatch(args);
    expect(result.success).toBe(false);
    expect(result.error).toContain('1 of 3 days');
    expect(result.appliedCount).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('does not bypass a coverage-evidence warning', async () => {
    rpc.mockResolvedValueOnce({ data: {
      status: 'needs_override_reason',
      latest_observed_event_at: '2026-11-02T10:00:00Z',
      declared_covers_through: '2026-11-03T21:59:00Z',
      access_points: args.accessPoints,
    }, error: null });
    const result = await processHikCentralImportBatch(args);
    expect(result.outcome).toBe('needs_override_reason');
    expect(result.success).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
