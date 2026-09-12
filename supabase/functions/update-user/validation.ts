// supabase/functions/update-user/validation.ts
//
// Pure, dependency-free validation logic for update-user/index.ts, mirroring
// create-user/validation.ts's own structure so it can be exercised by an
// ordinary vitest unit test (see src/utils/updateUserValidation.test.ts)
// without a Deno runtime or any Supabase/network access.

export const ALLOWED_ROLES = ['admin', 'hr_manager', 'accountant', 'operations_manager'] as const;
export type AllowedRole = typeof ALLOWED_ROLES[number];

// Fields the request body must never carry -- rejected outright (400) if
// present as a KEY at all, regardless of value, rather than silently
// ignored. tenant_id/role_level/is_super_admin/email/password are never
// parameters of update_functional_user_profile() either -- there is no
// way for any of these to reach that RPC even if this check were somehow
// bypassed, but rejecting explicitly here catches a misbehaving/confused
// caller early with a clear error instead of a silent no-op.
export const PROTECTED_FIELDS = ['tenant_id', 'role_level', 'is_super_admin', 'email', 'password'] as const;

export function isAllowedRole(role: string): role is AllowedRole {
  return (ALLOWED_ROLES as readonly string[]).includes(role);
}

// Region is required for every functional role except Admin -- Admin has
// cross-region authority within the tenant by design (matches create-user's
// own isRegionRequired()).
export function isRegionRequired(role: AllowedRole): boolean {
  return role !== 'admin';
}

// Returns the first protected field name found as an own key of the raw
// request body, or null if none are present. Checked against the RAW
// parsed body, before any destructuring, so an unexpected extra key can't
// slip past unnoticed.
export function findProtectedField(body: Record<string, unknown>): string | null {
  for (const field of PROTECTED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      return field;
    }
  }
  return null;
}

export interface UpdateUserInput {
  user_id: string;
  full_name: string;
  department: string | null;
  role: string;
  region_id: string | null;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// The exact validation sequence update-user/index.ts runs against the
// request body, factored out so it's testable independent of the HTTP
// handler and the database. Protected-field rejection is checked
// separately (findProtectedField), before this is ever called, so it can
// run against the raw body prior to this typed shape being constructed.
export function validateUpdateUserInput(input: UpdateUserInput): ValidationResult {
  if (!input.user_id || typeof input.user_id !== 'string') {
    return { valid: false, error: 'user_id is required' };
  }
  if (!input.full_name || !input.full_name.trim()) {
    return { valid: false, error: 'Full name is required' };
  }
  if (!isAllowedRole(input.role)) {
    return { valid: false, error: `Role must be one of: ${ALLOWED_ROLES.join(', ')}` };
  }
  if (isRegionRequired(input.role) && !input.region_id) {
    return { valid: false, error: 'Region is required for this role' };
  }
  return { valid: true };
}
