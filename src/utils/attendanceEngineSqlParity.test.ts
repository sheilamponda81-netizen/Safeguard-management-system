// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage C, Step 1.
//
// Proves attendance_engine_calculate() (the PL/pgSQL transcription added
// by supabase/migrations/20261012000000_attendance_automation_foundation.sql)
// produces IDENTICAL results to calculateAttendanceStatus() (Stage A's
// TypeScript engine) for the same inputs. This is the parity contract
// that migration's header relies on to justify having a server-side
// SQL mirror at all -- see that file's "WHY A SERVER-SIDE SQL MIRROR"
// comment.
//
// REQUIRES a reachable Postgres with the repo's full migration chain
// already applied -- see supabase/ci/apply_ci_schema.sh, which builds
// exactly that (a disposable Postgres, NEVER production) from the real,
// unmodified files in supabase/migrations/. CI (.github/workflows/ci.yml)
// runs that script against a disposable `postgres:16` service container
// on every PR/push and always runs this file for real against it -- see
// that workflow and ATTENDANCE_PARITY_REQUIRE_DB below for how CI turns
// "no reachable database" into a hard failure rather than a silent skip.
//
// Locally, with no such database reachable (the common case -- most
// contributors don't have one standing), every test in this file is
// SKIPPED, not failed, checked once via a synchronous `SELECT 1` through
// `psql` before anything else runs, so `npm test` still passes without
// one. To actually exercise this file locally:
//   1. Stand up a disposable Postgres (e.g. `service postgresql start`
//      on a box with postgresql-16 installed, or any throwaway instance).
//   2. Run `supabase/ci/apply_ci_schema.sh` against it (PGHOST/PGPORT/
//      PGUSER/PGPASSWORD/PGDATABASE -- standard libpq env vars, read
//      directly by `psql` -- pointed at that database).
//   3. Run this file with the same PG* env vars still set.
//
// ATTENDANCE_PARITY_REQUIRE_DB=1 (set only in CI -- see the workflow)
// makes a database that is NOT reachable a hard test FAILURE instead of
// a skip, so this suite can never silently stop running in CI without
// that being itself a failing, visible signal (e.g. the service
// container misconfigured, or the schema-build step failing earlier).
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { calculateAttendanceStatus, AttendanceCalculationInput } from './attendanceCalculationEngine';

function databaseReachable(): boolean {
  try {
    execFileSync('psql', ['-t', '-A', '-c', 'SELECT 1'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function sqlTimestampArrayLiteral(isoTimestamps: string[]): string {
  if (isoTimestamps.length === 0) return 'ARRAY[]::timestamptz[]';
  return `ARRAY[${isoTimestamps.map((t) => `'${t}'`).join(',')}]::timestamptz[]`;
}

function sqlNullableTextLiteral(value: string | undefined | null): string {
  return value === undefined || value === null ? 'NULL' : `'${value}'`;
}

function sqlNullableTimestampLiteral(value: string | undefined | null): string {
  return value === undefined || value === null ? 'NULL' : `'${value}'::timestamptz`;
}

/**
 * Runs one attendance_engine_calculate() call via psql and parses its
 * single-row result. check_in_at/check_out_at are requested as epoch
 * milliseconds (never a formatted string) specifically so comparison
 * against the TypeScript side's ISO strings is a plain numeric
 * equality, immune to any textual timestamp-formatting difference
 * between Postgres and JavaScript.
 */
function callSqlEngine(input: AttendanceCalculationInput): { status: string; basis: string | null; checkInMillis: number | null; checkOutMillis: number | null; reason: string } {
  const eventsLiteral = sqlTimestampArrayLiteral(input.events.map((e) => e.timestampIso));
  const coverageStatusLiteral = sqlNullableTextLiteral(input.coverage.status);
  const coverageThroughLiteral = sqlNullableTimestampLiteral(input.coverage.verifiedThroughIso);
  const asOfLiteral = sqlNullableTimestampLiteral(input.asOfIso);
  // reason is requested LAST and as the only column that can itself
  // contain a comma, so it is fetched via a separate \t-delimited query
  // rather than risk splitting a reason string that happens to contain
  // a literal comma.
  const sql =
    `SELECT status, COALESCE(calculation_basis, ''), ` +
    `COALESCE((EXTRACT(EPOCH FROM check_in_at) * 1000)::text, ''), COALESCE((EXTRACT(EPOCH FROM check_out_at) * 1000)::text, ''), reason ` +
    `FROM attendance_engine_calculate('${input.shiftDate}', '${input.resolvedShift}', ${eventsLiteral}, ${coverageStatusLiteral}, ${coverageThroughLiteral}, ${asOfLiteral});`;
  const output = execFileSync('psql', ['-t', '-A', '-F', '\t', '-c', sql], { encoding: 'utf-8' }).trim();
  const [status, basis, checkInMillis, checkOutMillis, reason] = output.split('\t');
  return {
    status,
    basis: basis || null,
    checkInMillis: checkInMillis ? Number(checkInMillis) : null,
    checkOutMillis: checkOutMillis ? Number(checkOutMillis) : null,
    reason,
  };
}

const dbAvailable = databaseReachable();
// CI sets this so a database that silently becomes unreachable (a
// misconfigured service container, a schema-build step that failed
// earlier in the job, ...) turns into a loud, failing test here --
// never a quietly-skipped suite that looks like a pass. Never set
// locally, where most contributors have no such database at all.
const dbRequired = process.env.ATTENDANCE_PARITY_REQUIRE_DB === '1';

describe.skipIf(!dbAvailable && !dbRequired)('attendance_engine_calculate() SQL/TypeScript parity', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error(
          'ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable -- this suite must run for real in CI, never silently skip. ' +
          'See this file\'s header and supabase/ci/apply_ci_schema.sh.'
        );
      }
      console.warn('attendanceEngineSqlParity.test.ts: no reachable Postgres -- skipping (see this file\'s header for setup).');
    }
  });

  const DAY_DATE = '2026-10-05';
  const NIGHT_DATE = '2026-10-05';

  const cases: { name: string; input: AttendanceCalculationInput }[] = [
    {
      name: 'Day grace boundary exact -- Present',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [{ timestampIso: '2026-10-05T04:15:00.000Z' }, { timestampIso: '2026-10-05T14:00:00.000Z' }], coverage: { status: 'insufficient' } },
    },
    {
      name: 'Day grace boundary plus one second -- Late',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [{ timestampIso: '2026-10-05T04:15:01.000Z' }, { timestampIso: '2026-10-05T14:00:00.000Z' }], coverage: { status: 'insufficient' } },
    },
    {
      name: 'Earliest check-in wins over later repeats',
      input: {
        shiftDate: DAY_DATE, resolvedShift: 'day',
        events: [{ timestampIso: '2026-10-05T04:30:00.000Z' }, { timestampIso: '2026-10-05T04:05:00.000Z' }, { timestampIso: '2026-10-05T14:00:00.000Z' }],
        coverage: { status: 'insufficient' },
      },
    },
    {
      name: 'First checkout wins over a later repeat',
      input: {
        shiftDate: DAY_DATE, resolvedShift: 'day',
        events: [{ timestampIso: '2026-10-05T04:05:00.000Z' }, { timestampIso: '2026-10-05T14:30:00.000Z' }, { timestampIso: '2026-10-05T17:00:00.000Z' }],
        coverage: { status: 'insufficient' },
      },
    },
    {
      name: 'Missing checkout, coverage confirmed closed -- Absent',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [{ timestampIso: '2026-10-05T04:05:00.000Z' }], coverage: { status: 'confirmed_complete', verifiedThroughIso: '2026-10-05T18:00:00.000Z' } },
    },
    {
      name: 'Missing check-in, coverage confirmed closed -- Absent',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [{ timestampIso: '2026-10-05T14:30:00.000Z' }], coverage: { status: 'confirmed_complete', verifiedThroughIso: '2026-10-05T18:00:00.000Z' } },
    },
    {
      name: 'No scans at all, coverage confirmed closed -- Absent',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [], coverage: { status: 'confirmed_complete', verifiedThroughIso: '2026-10-05T18:00:00.000Z' } },
    },
    {
      name: 'Business rule E: scans detected but none in the valid windows, coverage confirmed closed -- Absent, with a reason distinct from "no scans at all"',
      input: {
        shiftDate: DAY_DATE, resolvedShift: 'day',
        events: [{ timestampIso: '2026-10-05T10:00:00.000Z' }, { timestampIso: '2026-10-05T11:30:00.000Z' }],
        coverage: { status: 'confirmed_complete', verifiedThroughIso: '2026-10-05T18:00:00.000Z' },
      },
    },
    {
      name: 'Night shift crossing midnight -- Present',
      input: { shiftDate: NIGHT_DATE, resolvedShift: 'night', events: [{ timestampIso: '2026-10-05T14:05:00.000Z' }, { timestampIso: '2026-10-06T03:00:00.000Z' }], coverage: { status: 'insufficient' } },
    },
    {
      name: 'Night grace boundary plus one second -- Late',
      input: { shiftDate: NIGHT_DATE, resolvedShift: 'night', events: [{ timestampIso: '2026-10-05T16:15:01.000Z' }, { timestampIso: '2026-10-06T03:00:00.000Z' }], coverage: { status: 'insufficient' } },
    },
    {
      name: 'Night check-in only never counts as a checkout -- Absent once confirmed',
      input: { shiftDate: NIGHT_DATE, resolvedShift: 'night', events: [{ timestampIso: '2026-10-05T14:05:00.000Z' }], coverage: { status: 'confirmed_complete', verifiedThroughIso: '2026-10-06T06:00:00.000Z' } },
    },
    { name: 'Off day -- short-circuits regardless of events/coverage', input: { shiftDate: DAY_DATE, resolvedShift: 'off', events: [], coverage: { status: 'insufficient' } } },
    { name: 'Unassigned day -- short-circuits regardless of events/coverage', input: { shiftDate: DAY_DATE, resolvedShift: 'unassigned', events: [], coverage: { status: 'confirmed_complete', verifiedThroughIso: '2026-10-06T00:00:00.000Z' } } },
    {
      name: 'Early-export provisional Present (on-time check-in, coverage before checkout window closes)',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [{ timestampIso: '2026-10-05T04:05:00.000Z' }], coverage: { status: 'confirmed_complete', verifiedThroughIso: '2026-10-05T12:00:00.000Z' } },
    },
    {
      name: 'Early-export provisional Late (late check-in, coverage before checkout window closes)',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [{ timestampIso: '2026-10-05T04:30:00.000Z' }], coverage: { status: 'confirmed_complete', verifiedThroughIso: '2026-10-05T12:00:00.000Z' } },
    },
    {
      name: 'Missing check-in stays Pending even under an early/insufficient export, never Absent',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [], coverage: { status: 'confirmed_complete', verifiedThroughIso: '2026-10-05T12:00:00.000Z' } },
    },
    {
      name: 'Unknown coverage (no status, no verifiedThroughIso) behaves exactly like insufficient',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [{ timestampIso: '2026-10-05T04:05:00.000Z' }], coverage: { status: 'insufficient' } },
    },
    {
      name: 'Staleness gate: asOfIso before the Day checkout window closes -- still provisional Present',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [{ timestampIso: '2026-10-05T04:05:00.000Z' }], coverage: { status: 'insufficient' }, asOfIso: '2026-10-05T17:59:59.000Z' },
    },
    {
      name: 'Staleness gate: asOfIso after the Day checkout window closes, coverage unconfirmed -- Pending, never Absent',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [{ timestampIso: '2026-10-05T04:05:00.000Z' }], coverage: { status: 'insufficient' }, asOfIso: '2026-11-23T00:00:00.000Z' },
    },
    {
      name: 'Staleness gate: a stale LATE check-in also becomes Pending, not a stuck provisional Late',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [{ timestampIso: '2026-10-05T04:30:00.000Z' }], coverage: { status: 'insufficient' }, asOfIso: '2026-11-23T00:00:00.000Z' },
    },
    {
      name: 'Staleness gate: Night shift crossing midnight, asOfIso before the next-day checkout window closes -- still provisional Present',
      input: { shiftDate: NIGHT_DATE, resolvedShift: 'night', events: [{ timestampIso: '2026-10-05T16:05:00.000Z' }], coverage: { status: 'insufficient' }, asOfIso: '2026-10-06T05:59:59.000Z' },
    },
    {
      name: 'Staleness gate: Night shift crossing midnight, asOfIso after the next-day checkout window closes -- Pending',
      input: { shiftDate: NIGHT_DATE, resolvedShift: 'night', events: [{ timestampIso: '2026-10-05T16:05:00.000Z' }], coverage: { status: 'insufficient' }, asOfIso: '2026-10-06T06:00:00.000Z' },
    },
    {
      name: 'Staleness gate: a missing check-in stays Pending exactly as before, regardless of asOfIso',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [], coverage: { status: 'insufficient' }, asOfIso: '2026-11-23T00:00:00.000Z' },
    },
    {
      name: 'Staleness gate: omitting asOfIso preserves the exact prior provisional-credit behavior',
      input: { shiftDate: DAY_DATE, resolvedShift: 'day', events: [{ timestampIso: '2026-10-05T04:05:00.000Z' }], coverage: { status: 'insufficient' } },
    },
    {
      name: 'Staleness gate: a previously-stale Pending still resolves to a confirmed Present once an overlapping later import supplies the checkout',
      input: {
        shiftDate: DAY_DATE, resolvedShift: 'day',
        events: [{ timestampIso: '2026-10-05T04:05:00.000Z' }, { timestampIso: '2026-10-05T14:30:00.000Z' }],
        coverage: { status: 'confirmed_complete', verifiedThroughIso: '2026-10-05T18:00:00.000Z' },
        asOfIso: '2026-11-23T00:00:00.000Z',
      },
    },
  ];

  it.each(cases)('$name', ({ input }) => {
    const expected = calculateAttendanceStatus(input);
    const actual = callSqlEngine(input);
    expect(actual.status).toBe(expected.status);
    expect(actual.basis).toBe(expected.basis === 'not_applicable' ? null : expected.basis);
    expect(actual.checkInMillis).toBe(expected.checkInIso ? new Date(expected.checkInIso).getTime() : null);
    expect(actual.checkOutMillis).toBe(expected.checkOutIso ? new Date(expected.checkOutIso).getTime() : null);
    expect(actual.reason).toBe(expected.reason);
  });
});
