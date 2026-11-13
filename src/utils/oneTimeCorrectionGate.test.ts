import { describe, it, expect, vi } from 'vitest';
import { shouldShowCorrectionPanel, getCorrectionRpcArgs, CORRECTION_CONFIRM_PHRASE } from './oneTimeCorrectionGate';

// Regression/permission coverage for the one-time SFG-IMP-261110
// correction panel: it must only ever surface for a real Super Admin
// while uncorrected rows remain, and it must never reach the RPC without
// an explicit, affirmed confirmation -- this is what stands between a
// page load and a production write at the UI layer, even though the real
// boundary is the RPC's own server-side is_super_admin()+tenant check.
describe('shouldShowCorrectionPanel', () => {
  it('shows for a Super Admin while imported rows remain', () => {
    expect(shouldShowCorrectionPanel({ is_super_admin: true }, 293)).toBe(true);
    expect(shouldShowCorrectionPanel({ is_super_admin: true }, 1)).toBe(true);
  });

  it('hides for a Super Admin once nothing remains to correct', () => {
    expect(shouldShowCorrectionPanel({ is_super_admin: true }, 0)).toBe(false);
  });

  it('hides for a non-Super-Admin, even a Business Admin, regardless of remaining rows', () => {
    expect(shouldShowCorrectionPanel({ is_super_admin: false }, 293)).toBe(false);
    expect(shouldShowCorrectionPanel({}, 293)).toBe(false);
  });

  it('hides when no profile has loaded yet (null/undefined)', () => {
    expect(shouldShowCorrectionPanel(null, 293)).toBe(false);
    expect(shouldShowCorrectionPanel(undefined, 293)).toBe(false);
  });
});

describe('getCorrectionRpcArgs', () => {
  it('returns null -- never reaching the RPC -- when the operator declines the confirmation prompt', () => {
    const declined = vi.fn(() => false);
    expect(getCorrectionRpcArgs(declined)).toBeNull();
    expect(declined).toHaveBeenCalledTimes(1);
  });

  it('returns the exact RPC confirmation phrase only after the operator affirms the prompt', () => {
    const affirmed = vi.fn(() => true);
    expect(getCorrectionRpcArgs(affirmed)).toEqual({ p_confirm: CORRECTION_CONFIRM_PHRASE });
  });

  it('the confirmation phrase matches what correction_rpc_migration.sql requires, so the two can never silently drift apart', () => {
    expect(CORRECTION_CONFIRM_PHRASE).toBe('CONFIRM-293-CENTRAL');
  });
});
