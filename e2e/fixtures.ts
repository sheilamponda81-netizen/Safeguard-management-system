// Shared gating for e2e/authenticated/**: every test file in that
// directory needs a real staging Supabase project plus 4 seeded test
// accounts (one per role_level). None of that exists in this
// environment. Rather than have those tests fail with a confusing
// connection error (or worse, silently no-op), every describe block
// there calls requireStagingEnv() first and uses Playwright's
// test.skip(condition, reason) so a run without staging credentials
// reports these as SKIPPED with a clear reason -- never as passing,
// never as a hard failure that looks like a real bug.
//
// Required env vars (set these in a local .env.e2e or CI secrets,
// never committed):
//   E2E_BASE_URL              -- URL of a deployed staging build
//   E2E_SUPABASE_URL           -- staging project's URL
//   E2E_SUPABASE_ANON_KEY      -- staging project's anon key
//   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
//   E2E_MANAGER_EMAIL / E2E_MANAGER_PASSWORD
//   E2E_SUPERVISOR_EMAIL / E2E_SUPERVISOR_PASSWORD
//   E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD
// Ideally two of each, in two different regions, to test the region-
// isolation gap directly once AUDIT_REPORT.md Finding A12 is fixed.
//
// OPTIONAL env vars, for the tests that specifically need a second
// region or a second tenant (see STAGING_VALIDATION_PLAN.md). Tests that
// need these check for them individually and skip with a clear reason if
// absent -- they are not part of REQUIRED_VARS, so their absence does not
// block the rest of this file's tests:
//   E2E_ADMIN2_EMAIL / E2E_ADMIN2_PASSWORD        -- Admin in a second region, same tenant
//   E2E_TENANT_B_ADMIN_EMAIL / E2E_TENANT_B_ADMIN_PASSWORD -- Admin in a second, separate tenant

export interface StagingCredentials {
  baseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  admin: { email: string; password: string };
  manager: { email: string; password: string };
  supervisor: { email: string; password: string };
  staff: { email: string; password: string };
}

const REQUIRED_VARS = [
  'E2E_BASE_URL',
  'E2E_SUPABASE_URL',
  'E2E_SUPABASE_ANON_KEY',
  'E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD',
  'E2E_MANAGER_EMAIL', 'E2E_MANAGER_PASSWORD',
  'E2E_SUPERVISOR_EMAIL', 'E2E_SUPERVISOR_PASSWORD',
  'E2E_STAFF_EMAIL', 'E2E_STAFF_PASSWORD',
] as const;

export function missingStagingVars(): string[] {
  return REQUIRED_VARS.filter((name) => !process.env[name]);
}

export function getStagingCredentials(): StagingCredentials {
  const missing = missingStagingVars();
  if (missing.length > 0) {
    throw new Error(`Missing staging env vars: ${missing.join(', ')}`);
  }
  return {
    baseUrl: process.env.E2E_BASE_URL!,
    supabaseUrl: process.env.E2E_SUPABASE_URL!,
    supabaseAnonKey: process.env.E2E_SUPABASE_ANON_KEY!,
    admin: { email: process.env.E2E_ADMIN_EMAIL!, password: process.env.E2E_ADMIN_PASSWORD! },
    manager: { email: process.env.E2E_MANAGER_EMAIL!, password: process.env.E2E_MANAGER_PASSWORD! },
    supervisor: { email: process.env.E2E_SUPERVISOR_EMAIL!, password: process.env.E2E_SUPERVISOR_PASSWORD! },
    staff: { email: process.env.E2E_STAFF_EMAIL!, password: process.env.E2E_STAFF_PASSWORD! },
  };
}

// Optional: an Admin account in a second region of the SAME tenant, for
// region-isolation tests. Returns null (rather than throwing) when not
// configured, so callers can test.skip() with a clear reason instead of
// crashing the whole file.
export function getSecondRegionAdmin(): { email: string; password: string } | null {
  const email = process.env.E2E_ADMIN2_EMAIL;
  const password = process.env.E2E_ADMIN2_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}

// Optional: an Admin account in a SECOND, separate tenant, for
// cross-tenant isolation tests (both "can Tenant B see Tenant A's data"
// and "does a payroll batch reject an employee_id belonging to a
// different tenant"). Returns null when not configured.
export function getTenantBAdmin(): { email: string; password: string } | null {
  const email = process.env.E2E_TENANT_B_ADMIN_EMAIL;
  const password = process.env.E2E_TENANT_B_ADMIN_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}
