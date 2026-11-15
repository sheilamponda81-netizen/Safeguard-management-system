import { describe, it, expect, vi } from 'vitest';
import {
  shouldShowLilongwe50CorrectionPanel,
  getLilongwe50CorrectionRpcArgs,
  LILONGWE_50_CONFIRM_PHRASE,
} from './lilongwe50CorrectionGate';

// Regression/permission coverage for the one-time Lilongwe 50-employee
// correction panel: it must only ever surface for a real Super Admin
// while uncorrected rows remain, and it must never reach the RPC without
// an explicit, affirmed confirmation -- this is what stands between a
// page load and a production write at the UI layer, even though the real
// boundary is the RPC's own server-side is_super_admin()+tenant check.
describe('shouldShowLilongwe50CorrectionPanel', () => {
  it('shows for a Super Admin while uncorrected rows remain', () => {
    expect(shouldShowLilongwe50CorrectionPanel({ is_super_admin: true }, 50)).toBe(true);
    expect(shouldShowLilongwe50CorrectionPanel({ is_super_admin: true }, 1)).toBe(true);
  });

  it('hides for a Super Admin once nothing remains to correct', () => {
    expect(shouldShowLilongwe50CorrectionPanel({ is_super_admin: true }, 0)).toBe(false);
  });

  it('hides for a non-Super-Admin, even a Business Admin, regardless of remaining rows', () => {
    expect(shouldShowLilongwe50CorrectionPanel({ is_super_admin: false }, 50)).toBe(false);
    expect(shouldShowLilongwe50CorrectionPanel({}, 50)).toBe(false);
  });

  it('hides when no profile has loaded yet (null/undefined)', () => {
    expect(shouldShowLilongwe50CorrectionPanel(null, 50)).toBe(false);
    expect(shouldShowLilongwe50CorrectionPanel(undefined, 50)).toBe(false);
  });
});

describe('getLilongwe50CorrectionRpcArgs', () => {
  it('returns null -- never reaching the RPC -- when the operator declines the confirmation prompt', () => {
    const declined = vi.fn(() => false);
    expect(getLilongwe50CorrectionRpcArgs(declined)).toBeNull();
    expect(declined).toHaveBeenCalledTimes(1);
  });

  it('returns the exact RPC confirmation phrase only after the operator affirms the prompt', () => {
    const affirmed = vi.fn(() => true);
    expect(getLilongwe50CorrectionRpcArgs(affirmed)).toEqual({ p_confirm: LILONGWE_50_CONFIRM_PHRASE });
  });

  it('the confirmation phrase matches what the installed RPC requires, so the two can never silently drift apart', () => {
    expect(LILONGWE_50_CONFIRM_PHRASE).toBe('CONFIRM-50-LILONGWE-RENUMBER');
  });
});
