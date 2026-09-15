// supabase/functions/disable-user/validation.ts
//
// Pure, dependency-free validation logic for disable-user/index.ts,
// extracted into its own module so it can be exercised by an ordinary
// vitest unit test (see src/utils/disableUserValidation.test.ts) without
// needing a Deno test runner or any Supabase/network access -- same
// rationale and pattern as create-user/validation.ts and
// update-user/validation.ts.

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// HOTFIX (release-review blocker fix): the exact friendly pre-check
// disable-user/index.ts applies before ever calling disable_user_profile()
// -- only a genuine Super Administrator may disable another Super
// Administrator. This is NOT the authoritative boundary (that is
// disable_user_profile() itself and, independently,
// prevent_profile_privilege_escalation() -- see the hotfix migration's
// PART 1b) -- it exists only to return a clear error before a network
// round trip in the common (non-racing) case.
export function canDisableTarget(
  callerIsSuperAdmin: boolean,
  targetIsSuperAdmin: boolean
): ValidationResult {
  if (targetIsSuperAdmin && !callerIsSuperAdmin) {
    return { valid: false, error: 'Only a Super Administrator may disable a Super Administrator' };
  }
  return { valid: true };
}
