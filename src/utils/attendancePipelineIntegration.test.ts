// Phase 2 completion, Task 1: integration coverage for the attendance
// pipeline dimensions the pure TS/SQL parity file (attendanceEngineSqlParity
// .test.ts) cannot exercise on its own -- those tests compare
// attendance_engine_calculate() against its TypeScript twin for a single
// calculation given fixed inputs; THIS file drives the real, unmodified
// RPCs (roster_assign_recurring_pattern, roster_assign_dates,
// attendance_process_import_batch, attendance_apply_automatic,
// attendance_correct) end-to-end against a disposable Postgres loaded
// with the exact schema in supabase/migrations/, proving genuine
// end-to-end behavior -- overlapping imports reconciling an overnight
// shift, a roster override actually changing what gets calculated, and
// the manual/payroll write-protections in attendance_write_one -- that
// only exist once those real functions are composed together.
//
// Same disposable-database convention as attendanceEngineSqlParity.test.ts
// -- see that file's header and supabase/ci/apply_ci_schema.sh. Never
// connects to production: PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
// (standard libpq env vars) must point at a disposable database for
// these tests to run at all; CI points them at a disposable `postgres:16`
// service container built by that script, never anything else.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

function databaseReachable(): boolean {
  try {
    execFileSync('psql', ['-t', '-A', '-c', 'SELECT 1'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = databaseReachable();
const dbRequired = process.env.ATTENDANCE_PARITY_REQUIRE_DB === '1';

/** Runs a statement for its side effect only -- setup/mutation, no result needed. */
function exec(sql: string): void {
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Runs a query and returns its single-row result as comma-split fields. */
function queryRow(sql: string): string[] {
  const out = execFileSync('psql', ['-t', '-A', '-F', ',', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split(',') : [];
}

/** Runs a query and returns every result row, each comma-split into fields. */
function queryRows(sql: string): string[][] {
  const out = execFileSync('psql', ['-t', '-A', '-F', ',', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split('\n').map((line) => line.split(',')) : [];
}

interface Fixture {
  tenantId: string;
  callerId: string;
  employeeId: string;
  personNo: string;
  batchId: string;
}

/**
 * Minimal, self-contained tenant/caller/employee/HikCentral-mapping
 * fixture -- every scenario below gets its own fresh set of ids (no
 * shared state, no cleanup needed between tests in the same disposable
 * database run). The caller is a super admin so every RPC's own
 * authorization check passes without needing to seed the full
 * functional-role permission matrix.
 */
function createFixture(site: string): Fixture {
  const tenantId = randomUUID();
  const callerId = randomUUID();
  const employeeId = randomUUID();
  const personNo = `P${randomUUID().slice(0, 8)}`;
  const batchId = randomUUID();

  exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', 'Integration Test Tenant', 'ITT-${tenantId.slice(0, 8)}')`);
  exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
  exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active) VALUES ('${callerId}', '${tenantId}', true, true)`);
  exec(`SELECT set_caller('${callerId}')`);
  exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${employeeId}', '${tenantId}', 'E-${employeeId.slice(0, 8)}', 'Integration Test Employee', 'Active', false, '${site}')`);
  exec(`SELECT set_employee_hikcentral_terminals('${employeeId}', ARRAY['GATE1'])`);
  exec(`INSERT INTO hikcentral_person_mappings (tenant_id, hikcentral_person_no, employee_id, match_method, is_active) VALUES ('${tenantId}', '${personNo}', '${employeeId}', 'manual', true)`);
  exec(`INSERT INTO hikcentral_import_batches (id, tenant_id, filename, status, imported_by) VALUES ('${batchId}', '${tenantId}', 'integration-test.xlsx', 'completed', '${callerId}')`);

  return { tenantId, callerId, employeeId, personNo, batchId };
}

function insertRawEvent(fixture: Fixture, isoTime: string): void {
  exec(
    `INSERT INTO hikcentral_raw_events (tenant_id, import_batch_id, hikcentral_person_no, event_time, access_point, authentication_result, event_type, event_fingerprint) ` +
    `VALUES ('${fixture.tenantId}', '${fixture.batchId}', '${fixture.personNo}', '${isoTime}', 'GATE1', 'Authorization', 'Access Granted by Fingerprint', '${randomUUID()}')`
  );
}

function attendanceRow(fixture: Fixture, date: string): { status: string | null; source: string | null } {
  const rows = queryRows(`SELECT status, source FROM attendance WHERE employee_id = '${fixture.employeeId}' AND date = '${date}'`);
  if (rows.length === 0) return { status: null, source: null };
  return { status: rows[0][0] || null, source: rows[0][1] || null };
}

describe.skipIf(!dbAvailable && !dbRequired)('Attendance pipeline integration (real SQL functions, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error(
          'ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable -- this suite must run for real in CI, never silently skip. ' +
          'See this file\'s header and supabase/ci/apply_ci_schema.sh.'
        );
      }
      console.warn('attendancePipelineIntegration.test.ts: no reachable Postgres -- skipping (see this file\'s header for setup).');
    }
  });

  it('overlapping imports automatically reconcile an overnight shift once the later checkout arrives, even recalculating a date the caller did not explicitly ask for', () => {
    const fixture = createFixture('NIGHT SITE');
    // p_weekday is deliberately NULL -- that parameter sets a recurring
    // weekly OFF-day pattern, a wholly separate thing from the baseline
    // Day/Night shift_type set here, which applies to every date with
    // no dated exception (see roster_resolve_schedule).
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'night', '2026-11-01', NULL)`);

    // Both events already sit in hikcentral_raw_events (as two real,
    // separate HikCentral exports would leave them) -- the check-in on
    // the shift's own calendar date, the checkout after midnight. Night
    // shift windows (attendance_engine_shift_windows): check-in window
    // starts at 16:00 Blantyre (14:00Z) on the shift date, check-out
    // window ends at 08:00 Blantyre (06:00Z) the NEXT date.
    insertRawEvent(fixture, '2026-11-09T14:05:00Z');
    insertRawEvent(fixture, '2026-11-10T05:00:00Z');

    // Before any coverage is confirmed, Nov 9 has no attendance row at all.
    expect(attendanceRow(fixture, '2026-11-09').status).toBeNull();

    // The administrator only declares (and only asks to recalculate)
    // Nov 10 onward -- their own export's first visible event is the
    // checkout -- but genuinely confirms coverage reaching back far
    // enough to span the Night shift's own check-in window on Nov 9.
    // covers_through (06:30Z) is kept within PR #58's 2-hour evidence-gap
    // tolerance of the last actually-observed scan (05:00Z) -- this is
    // not testing that fail-closed check, just not accidentally tripping it.
    queryRow(
      `SELECT attendance_process_import_batch('${fixture.batchId}', ARRAY['GATE1'], ` +
      `'2026-11-09T10:00:00Z'::timestamptz, '2026-11-10T06:30:00Z'::timestamptz, ` +
      `'2026-11-10'::date, '2026-11-10'::date, NULL, NULL, NULL, false)`
    );

    // Nov 9 -- a date OUTSIDE the declared [2026-11-10, 2026-11-10]
    // recalculation range -- is still correctly resolved: this is
    // specifically PR #59's one-day-backward widening (p_date_from - 1)
    // at work, not something that would happen without it.
    const nov9 = attendanceRow(fixture, '2026-11-09');
    expect(['P', 'L']).toContain(nov9.status);
    expect(nov9.source).toBe('automatic');
  });

  it('a roster date override (recurring Day -> dated Off) is honored even when fingerprint evidence exists for that date -- no attendance is fabricated for an Off day', () => {
    const fixture = createFixture('DAY SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    // A recurring weekly Off day (Sunday) is required first -- otherwise
    // this employee has no Off day at all anywhere in their roster, and
    // roster_assign_dates's own rolling seven-day rest-violation guard
    // (unrelated to what this test checks) refuses the change below.
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], 0, NULL, '2026-11-01', NULL)`);
    exec(`SELECT roster_assign_dates(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-16'::date, '2026-11-16'::date, 'off', 'integration test: override to Off')`);

    // The employee badges in anyway -- evidence a day-shift scan exists
    // must never override an explicit roster Off assignment.
    insertRawEvent(fixture, '2026-11-16T04:05:00Z');
    insertRawEvent(fixture, '2026-11-16T14:00:00Z');

    queryRow(
      `SELECT attendance_process_import_batch('${fixture.batchId}', ARRAY['GATE1'], ` +
      `'2026-11-16T00:00:00Z'::timestamptz, '2026-11-16T23:59:00Z'::timestamptz, ` +
      `'2026-11-16'::date, '2026-11-16'::date, NULL, NULL, NULL, false)`
    );

    // No attendance row at all -- Off/Unassigned/Pending are never
    // automatically written, confirmed end-to-end through the real
    // roster resolution, not just the pure engine-calculation case.
    expect(attendanceRow(fixture, '2026-11-16').status).toBeNull();
  });

  it('a manual correction is never overwritten by automatic processing, even when automatic would otherwise resolve a genuinely different, fully-confirmed outcome', () => {
    const fixture = createFixture('MANUAL SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);

    queryRow(`SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-20'::date, 'P', 'manager confirms present')`);
    expect(attendanceRow(fixture, '2026-11-20')).toEqual({ status: 'P', source: 'manual' });

    // Confirmed-complete coverage, zero fingerprint events -- automatic
    // processing would otherwise resolve this date as a genuine,
    // confirmed Absent, directly conflicting with the manual 'P' above.
    exec(
      `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY[]::TEXT[], ARRAY['GATE1'], '2026-11-20T00:00:00Z', '2026-11-20T23:59:00Z')`
    );

    const [outcome] = queryRow(`SELECT outcome FROM attendance_apply_automatic(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-20'::date, '2026-11-20'::date)`);
    expect(outcome).toBe('skipped_manual_protected');
    expect(attendanceRow(fixture, '2026-11-20')).toEqual({ status: 'P', source: 'manual' });
  });

  it('approved payroll for a month blocks ALL automatic attendance writes for that month, even a genuinely-confirmed outcome, without ever even attempting the write', () => {
    const fixture = createFixture('PAYROLL SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`INSERT INTO payroll (tenant_id, employee_id, month, approval_status) VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '2026-11', 'approved')`);

    exec(
      `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY[]::TEXT[], ARRAY['GATE1'], '2026-11-05T00:00:00Z', '2026-11-05T23:59:00Z')`
    );

    const [outcome, , , payrollFlag] = queryRow(`SELECT outcome, old_status, new_status, payroll_flag FROM attendance_apply_automatic(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-05'::date, '2026-11-05'::date)`);
    expect(outcome).toBe('skipped_payroll_approved');
    expect(payrollFlag).toBe('approved');
    // Never even written -- no attendance row exists for this date at all.
    expect(attendanceRow(fixture, '2026-11-05').status).toBeNull();
  });
});
