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
