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
// REQUIRES a reachable Postgres with that migration (and its full
// dependency chain -- the base schema, functional-role/permission
// foundation, and roster foundation migrations) already applied. This
// is NEVER true in the normal `npm test` CI run for this repo (no
// Postgres service is configured there), so every test in this file
// is SKIPPED, not failed, when no such database is reachable --
// checked once via a synchronous `SELECT 1` through `psql` before
// anything else runs. To actually exercise this file locally:
//   1. Stand up a disposable Postgres (e.g. `service postgresql start`
//      on a box with postgresql-16 installed, or any throwaway instance).
//   2. Apply the full migration chain in supabase/migrations/ up to and
//      including 20261012000000_attendance_automation_foundation.sql
//      (stub `auth.uid()`/`auth.email()`/`auth.users` and an
//      `extensions` schema with pgcrypto first -- see this engagement's
//      Stage C Step 1 report for the exact stub SQL used).
//   3. Run with PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE pointed at
//      that database (standard libpq env vars, read directly by `psql`).
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
function callSqlEngine(input: AttendanceCalculationInput): { status: string; basis: string | null; checkInMillis: number | null; checkOutMillis: number | null } {
  const eventsLiteral = sqlTimestampArrayLiteral(input.events.map((e) => e.timestampIso));
  const coverageStatusLiteral = sqlNullableTextLiteral(input.coverage.status);
  const coverageThroughLiteral = sqlNullableTimestampLiteral(input.coverage.verifiedThroughIso);
  const sql =
    `SELECT status, COALESCE(calculation_basis, ''), ` +
    `COALESCE((EXTRACT(EPOCH FROM check_in_at) * 1000)::text, ''), COALESCE((EXTRACT(EPOCH FROM check_out_at) * 1000)::text, '') ` +
    `FROM attendance_engine_calculate('${input.shiftDate}', '${input.resolvedShift}', ${eventsLiteral}, ${coverageStatusLiteral}, ${coverageThroughLiteral});`;
  const output = execFileSync('psql', ['-t', '-A', '-F', ',', '-c', sql], { encoding: 'utf-8' }).trim();
  const [status, basis, checkInMillis, checkOutMillis] = output.split(',');
  return {
    status,
    basis: basis || null,
    checkInMillis: checkInMillis ? Number(checkInMillis) : null,
    checkOutMillis: checkOutMillis ? Number(checkOutMillis) : null,
  };
}

const dbAvailable = databaseReachable();

describe.skipIf(!dbAvailable)('attendance_engine_calculate() SQL/TypeScript parity', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      // eslint-disable-next-line no-console
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
  ];

  it.each(cases)('$name', ({ input }) => {
    const expected = calculateAttendanceStatus(input);
    const actual = callSqlEngine(input);
    expect(actual.status).toBe(expected.status);
    expect(actual.basis).toBe(expected.basis === 'not_applicable' ? null : expected.basis);
    expect(actual.checkInMillis).toBe(expected.checkInIso ? new Date(expected.checkInIso).getTime() : null);
    expect(actual.checkOutMillis).toBe(expected.checkOutIso ? new Date(expected.checkOutIso).getTime() : null);
  });
});
