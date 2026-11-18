import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';
import { execSync } from 'child_process';

// Separate from vite.config.ts deliberately: vite.config.ts is the
// production build config (plugins, chunking, dev server) and has no
// reason to also carry test-runner configuration. Vitest only needs the
// same `@` path alias the app itself uses.

// Final Phase 2 release review: with PR #61 (CI) merged alongside PR
// #62/#63/#64, this repo now has FIVE disposable-Postgres integration
// test files (attendanceEngineSqlParity, attendancePipelineIntegration,
// monthEndAttendanceProtection, attendanceCorrectMandatoryReason,
// attendanceSiteAlertLifecycle), each using the same
// psql-reachability-check-then-exec() convention. That convention's
// `auth.uid()` stub (bootstrap_stub.sql) is a single-row `var_caller`
// TABLE, not a per-connection/session value, because each `exec()` call
// is its OWN short-lived `psql` process -- it has to be durable,
// database-wide state for a single test to "stay logged in" across its
// own several exec() calls.
//
// Vitest parallelizes separate TEST FILES across worker
// threads/processes by default. With only one such file (true until
// PR #61 added a second), that was harmless. With several, two
// different files' tests can now genuinely interleave against the
// SAME physical disposable Postgres (one shared PGDATABASE for the
// whole `npm test` run) -- one file's set_caller() call can land
// between another, concurrently-running file's own exec() calls,
// making its very next statement silently run as the WRONG caller.
// Reproduced for real during this review's sequential-merge rehearsal
// (all 4 PRs combined): attendanceSiteAlertLifecycle.test.ts
// intermittently failed with "Alert does not belong to your tenant" /
// an 'unauthorized' outcome instead of 'acknowledged' -- a caller-id
// race, not a real authorization bug (each test's own fixture and
// caller were correct in isolation; confirmed by running that file
// alone, repeatedly, with no failures).
//
// Fix: when a Postgres is actually reachable (the only time any of
// these files runs for real rather than skipping), disable Vitest's
// file-level parallelism outright -- same reachability check each of
// those test files already performs, duplicated here on purpose
// (vitest.config.ts has no access to a test file's own module-level
// state, and this must be decided before any file loads). This only
// serializes test FILES against each other, never the individual
// tests within one file, and has no effect at all for every
// contributor/CI run without a reachable database (today's normal
// case locally; always on in CI once PR #61's workflow exists).
function disposablePostgresReachable(): boolean {
  try {
    execSync('psql -t -A -c "SELECT 1"', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
const fileParallelism = !(disposablePostgresReachable() || process.env.ATTENDANCE_PARITY_REQUIRE_DB === '1');

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    fileParallelism,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // src/tests/auth.test.ts (a legacy manual smoke-test script with
    // hardcoded live credentials, no describe/it blocks, requiring a real
    // Supabase session) was already removed from this branch's own history
    // -- this exclude is a defensive no-op today, kept so the file can
    // never accidentally get picked up as a test again if it's ever
    // reintroduced by a future merge from main.
    exclude: [...configDefaults.exclude, 'src/tests/auth.test.ts'],
    // src/lib/supabase.ts throws at import time if these are unset, and
    // several otherwise-pure utility modules (e.g. payrollSettings.ts,
    // for its DB-backed getPayrollRates()) import it transitively even
    // when the specific export under test doesn't touch the network.
    // These are placeholder values only, matching .env.example's format
    // -- never real credentials -- purely so importing those modules
    // doesn't throw during a test run that exercises none of their
    // actual Supabase calls.
    env: {
      VITE_SUPABASE_URL: 'https://test-placeholder.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'test-placeholder-anon-key',
    },
  },
});
