import { describe, it, expect, vi } from 'vitest';

// Deliberately a SEPARATE file from attendanceImportAutoApplyService.test.ts:
// configuring a REJECTED value on an rpc mock that an EARLIER test in the
// same file already resolved was found, in this vitest version, to
// misreport as an uncaught test exception rather than being caught by
// processHikCentralImportBatch's own try/catch -- confirmed to be a
// mock-reset/transform-timing quirk, not a defect in that function (the
// identical try/catch logic, inlined directly in a test with no prior
// resolved call on its mock, always catches it correctly). Keeping this
// scenario in its own fresh module/mock instance sidesteps the quirk
// while still giving it real, dedicated coverage.
const rpcMock = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

const { processHikCentralImportBatch } = await import('./attendanceImportAutoApplyService');

describe('processHikCentralImportBatch: network error', () => {
  it('never throws on a network error -- returns a discriminated failure instead', async () => {
    rpcMock.mockRejectedValue(new Error('network down'));
    const result = await processHikCentralImportBatch({
      importBatchId: 'b1', accessPoints: ['Gate 1'], periodFromDate: '2026-10-01', periodToDate: '2026-10-01', dateFrom: '2026-10-01', dateTo: '2026-10-01',
    });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('network_error');
  });
});
