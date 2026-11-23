// Post-release safety check (2026-11-26): the 20261125000000 migration
// used CREATE OR REPLACE FUNCTION to add a 6th parameter to
// attendance_engine_calculate. PostgreSQL only replaces a function
// whose argument TYPE LIST matches exactly -- adding a parameter
// creates a NEW, separate overload rather than truly replacing the old
// one, so the original 5-argument function (still containing the
// pre-fix, unconditional early-export logic) was left behind
// alongside the new 6-argument one. Confirmed via direct production
// inspection that calling attendance_engine_calculate with exactly 5
// arguments -- the ONLY way to invoke that old overload at all --
// raised "function ... is not unique", since PostgreSQL could not
// choose between the true 5-arg function and the 6-arg function's one
// default. The 20261126000000 migration drops that dead 5-arg
// overload (zero dependents, zero callers anywhere in the schema or
// application code -- confirmed by full-text search of every
// function body, view, trigger, and RLS policy, plus a source grep of
// the TypeScript codebase).
//
// Same disposable-database convention as attendanceEngineSqlParity.test.ts
// and attendancePipelineIntegration.test.ts -- see those files' headers.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';

function databaseReachable(): boolean {
  try {
    execFileSync('psql', ['-t', '-A', '-c', 'SELECT 1'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function queryRow(sql: string): string[] {
  const out = execFileSync('psql', ['-t', '-A', '-F', ',', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split(',') : [];
}

const dbAvailable = databaseReachable();
const dbRequired = process.env.ATTENDANCE_PARITY_REQUIRE_DB === '1';

describe.skipIf(!dbAvailable && !dbRequired)('attendance_engine_calculate: exactly one overload exists, no ambiguity trap', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error(
          'ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable -- this suite must run for real in CI, never silently skip. ' +
          'See this file\'s header and supabase/ci/apply_ci_schema.sh.'
        );
      }
      console.warn('attendanceEngineCalculateOverloadSafety.test.ts: no reachable Postgres -- skipping (see this file\'s header for setup).');
    }
  });

  it('exactly one overload of attendance_engine_calculate exists in the schema', () => {
    const rows = execFileSync(
      'psql', ['-t', '-A', '-c', "SELECT pronargs FROM pg_proc WHERE proname = 'attendance_engine_calculate' ORDER BY pronargs;"],
      { encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean);
    expect(rows).toEqual(['6']);
  });

  it('a 5-argument call -- the historical calling convention, and the shape p_as_of\'s default was meant to keep working -- resolves cleanly instead of raising "function is not unique"', () => {
    const [status] = queryRow(
      "SELECT status FROM attendance_engine_calculate('2026-01-01'::date, 'day', NULL, 'insufficient', NULL);"
    );
    expect(status).toBe('pending');
  });

  it('the 6-argument call with a real stale check-in-only scenario is completely unaffected by the overload cleanup', () => {
    const [status, basis] = queryRow(
      "SELECT status, COALESCE(calculation_basis, '') FROM attendance_engine_calculate(" +
      "'2026-01-01'::date, 'day', ARRAY['2026-01-01T04:05:00Z']::timestamptz[], 'insufficient', NULL, '2026-11-23T00:00:00Z'::timestamptz);"
    );
    expect(status).toBe('pending');
    expect(basis).toBe('');
  });

  it('attendance_resolve_and_calculate (the real orchestration function the automatic-write path uses) still resolves correctly through the single remaining overload', () => {
    // off/unassigned short-circuit calls attendance_engine_calculate with
    // 6 args including clock_timestamp() -- exercises the exact call
    // shape attendance_apply_automatic depends on in production.
    const [status] = queryRow(
      "SELECT status FROM attendance_engine_calculate('2026-01-01'::date, 'off', NULL, 'insufficient', NULL, clock_timestamp());"
    );
    expect(status).toBe('off');
  });
});
