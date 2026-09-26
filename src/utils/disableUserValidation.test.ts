import { describe, it, expect } from 'vitest';
// Imports the actual validation module the disable-user Edge Function runs
// (supabase/functions/disable-user/validation.ts) -- not a copy -- so this
// test exercises the real logic deployed server-side, not a duplicate that
// could drift. Same pattern as createUserValidation.test.ts.
import { canDisableTarget } from '../../supabase/functions/disable-user/validation';

// HOTFIX (release-review blocker fix): regression coverage for the
// friendly pre-check disable-user/index.ts applies before ever calling
// disable_user_profile(). The AUTHORITATIVE boundary (disable_user_profile()
// itself, and independently prevent_profile_privilege_escalation()) is
// SQL, validated empirically in a disposable local PostgreSQL instance --
// this file covers only the JS-side pre-check's own decision logic.
describe('canDisableTarget (HOTFIX: disable-user Super Administrator pre-check)', () => {
  it('item 1: an ordinary (non-super-admin) caller targeting a Super Administrator is rejected', () => {
    const result = canDisableTarget(false, true);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Super Administrator/);
  });

  it('item 4/7: a genuine Super Administrator caller targeting a Super Administrator is allowed by this pre-check (the RPC/trigger still enforce the last-active-invariant and self-disable separately)', () => {
    expect(canDisableTarget(true, true)).toEqual({ valid: true });
  });

  it('item 7: any caller (super or ordinary) targeting an ORDINARY (non-super-admin) user is allowed -- unaffected by this fix', () => {
    expect(canDisableTarget(false, false)).toEqual({ valid: true });
    expect(canDisableTarget(true, false)).toEqual({ valid: true });
  });

  it('never silently downgrades -- a rejected request always reports valid:false with a specific error, never a bare false-y result', () => {
    const result = canDisableTarget(false, true);
    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });
});
