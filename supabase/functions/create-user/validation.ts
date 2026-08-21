// supabase/functions/create-user/validation.ts
//
// Pure, dependency-free validation logic for create-user/index.ts,
// extracted into its own module so it can be exercised by an ordinary
// vitest unit test (see src/utils/createUserValidation.test.ts) without
// needing a Deno test runner or any Supabase/network access. No Deno-
// specific syntax is used here -- this file is valid under both the Deno
// runtime (imported by index.ts via a relative path) and Node/Vite
// (imported by the test file the same way).

export const ALLOWED_ROLES = ['admin', 'hr_manager', 'accountant', 'operations_manager'] as const;
export type AllowedRole = typeof ALLOWED_ROLES[number];

export const MIN_PASSWORD_LENGTH = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function isValidPassword(password: string): boolean {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}

export function isAllowedRole(role: string): role is AllowedRole {
  return (ALLOWED_ROLES as readonly string[]).includes(role);
}

// Region is required for every functional role except Admin -- Admin has
// cross-region authority within the tenant by design (is_business_admin()/
// region_allowed() throughout this rollout).
export function isRegionRequired(role: AllowedRole): boolean {
  return role !== 'admin';
}

export interface CreateUserInput {
  email: string;
  password: string;
  full_name: string;
  role: string;
  region_id: string | null;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// The exact validation sequence create-user/index.ts runs against the
// request body, factored out so it's testable independent of the HTTP
// handler, the service-role client, and the database.
export function validateCreateUserInput(input: CreateUserInput): ValidationResult {
  if (!isValidEmail(input.email)) {
    return { valid: false, error: 'A valid email address is required' };
  }
  if (!isValidPassword(input.password)) {
    return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
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
