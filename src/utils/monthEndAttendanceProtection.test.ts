// Phase 2 completion, Task 2: Month-End Attendance Protection.
//
// Drives the real, unmodified RPCs end-to-end against a disposable
// Postgres loaded with this repo's exact schema (see
// attendancePipelineIntegration.test.ts's own header and
// supabase/ci/apply_ci_schema.sh once that script lands -- this file
// uses the identical database-reachability/ATTENDANCE_PARITY_REQUIRE_DB
// convention, duplicated here on purpose: each of this project's
// disposable-Postgres test files is deliberately self-contained, same
// precedent as attendanceImportAutoApplyService.networkError.test.ts).
// Never connects to production.
//
// Covers the two genuine gaps this task's migration
// (20261119000000_month_end_attendance_protection.sql) fixes, plus one
// explicit acceptance case that needed no code change at all --
// confirming it, not assuming it:
//   1. Fresh automatic evidence arriving for an already-approved-payroll
//      month is correctly refused AND now durably flagged via the
//      existing attendance_reconciliation_flags mechanism, reusable by
//      a human later -- previously it was refused but silently dropped.
//   2. attendance_month_end_summary() surfaces unresolved Pending
//      records and open reconciliation flags at the period level.
//   3. A Nov 30 overnight shift correctly resolves once its Dec 1
//      checkout evidence arrives -- the automatic one-day-backward
//      reconciliation window (PR #59) is plain DATE arithmetic with no
//      month/year special-casing, so this already worked; this test
//      makes that explicit and permanent rather than merely assumed.
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

function exec(sql: string): void {
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function queryRow(sql: string): string[] {
  const out = execFileSync('psql', ['-t', '-A', '-F', ',', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split(',') : [];
}

interface Fixture {
  tenantId: string;
  callerId: string;
  employeeId: string;
  personNo: string;
  batchId: string;
}

/**
 * Same fixture shape/convention as attendancePipelineIntegration.test.ts.
 * p_effective_from for the recurring pattern is always within 35 days of
 * "now" -- roster_assert_pattern_backdate_allowed refuses anything older,
 * by design, regardless of which test is calling it.
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

function insertRawEvent(fixture: Fixture, isoTime: string, accessPoint = 'GATE1'): void {
  exec(
    `INSERT INTO hikcentral_raw_events (tenant_id, import_batch_id, hikcentral_person_no, event_time, access_point, authentication_result, event_type, event_fingerprint) ` +
    `VALUES ('${fixture.tenantId}', '${fixture.batchId}', '${fixture.personNo}', '${isoTime}', '${accessPoint}', 'Authorization', 'Access Granted by Fingerprint', '${randomUUID()}')`
  );
}

describe.skipIf(!dbAvailable && !dbRequired)('Month-end attendance protection (real SQL functions, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error(
          'ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable -- this suite must run for real in CI, never silently skip. ' +
          'See supabase/ci/apply_ci_schema.sh.'
        );
      }
      console.warn('monthEndAttendanceProtection.test.ts: no reachable Postgres -- skipping.');
    }
  });

  it('fresh automatic evidence for an already-approved-payroll month is refused AND durably flagged for human review -- not silently dropped', () => {
    const fixture = createFixture('PAYROLL SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-10-25', NULL)`);
    exec(`INSERT INTO payroll (tenant_id, employee_id, month, approval_status) VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '2026-11', 'approved')`);
    exec(
      `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY[]::TEXT[], ARRAY['GATE1'], '2026-11-05T00:00:00Z', '2026-11-05T23:59:00Z')`
    );

    const [outcome] = queryRow(`SELECT outcome FROM attendance_apply_automatic(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-05'::date, '2026-11-05'::date)`);
    expect(outcome).toBe('skipped_payroll_approved');

    const [flagCount, flaggedReason, resolvedAt] = queryRow(
      `SELECT count(*), max(flagged_reason), max(resolved_at)::text FROM attendance_reconciliation_flags ` +
      `WHERE employee_id = '${fixture.employeeId}' AND attendance_date = '2026-11-05'`
    );
    expect(flagCount).toBe('1');
    expect(flaggedReason).toBe('payroll_approved');
    expect(resolvedAt).toBe('');

    // Idempotent-retry safety, not deduplication -- a second skip on the
    // same date appends a SECOND flag, matching the existing written-
    // branch's own append-only behavior (never silently merged away).
    queryRow(`SELECT outcome FROM attendance_apply_automatic(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-05'::date, '2026-11-05'::date)`);
    const [flagCountAfterRetry] = queryRow(`SELECT count(*) FROM attendance_reconciliation_flags WHERE employee_id = '${fixture.employeeId}' AND attendance_date = '2026-11-05'`);
    expect(flagCountAfterRetry).toBe('2');
  });

  it('attendance_month_end_summary surfaces unresolved Pending records and open reconciliation flags at the period level', () => {
    const fixture = createFixture('SUMMARY SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-10-25', NULL)`);
    exec(`INSERT INTO payroll (tenant_id, employee_id, month, approval_status) VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '2026-11', 'approved')`);
    exec(
      `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY[]::TEXT[], ARRAY['GATE1'], '2026-11-05T00:00:00Z', '2026-11-05T23:59:00Z')`
    );
    // Refused (approved payroll) and flagged -- same mechanism as above.
    queryRow(`SELECT outcome FROM attendance_apply_automatic(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-05'::date, '2026-11-05'::date)`);

    const [scheduledEmployeeCount, , , , pendingDays, employeesWithPending, openFlags] = queryRow(
      `SELECT scheduled_employee_count, present_days, late_days, absent_days, pending_days, employees_with_pending_count, open_reconciliation_flags ` +
      `FROM attendance_month_end_summary('2026-11')`
    );
    // NOTE on scope: this RPC's own authorized caller is a super admin
    // (createFixture's own convention, reused from attendancePipeline
    // Integration.test.ts), and attendance_month_end_summary's scope
    // CTE deliberately bypasses tenant/region filtering entirely for a
    // super admin (matching get_payroll_attendance_counts' own,
    // already-reviewed precedent) -- so this call legitimately sees
    // every November-scoped employee across every fixture/tenant in
    // this disposable database, not just this test's own one. Only
    // "greater than/at least" assertions are therefore safe here; an
    // exact count would be a false assumption about isolation this RPC
    // was never designed to provide to a super-admin caller.
    expect(Number(scheduledEmployeeCount)).toBeGreaterThanOrEqual(1);
    expect(Number(pendingDays)).toBeGreaterThan(0);
    expect(Number(employeesWithPending)).toBeGreaterThanOrEqual(1);
    expect(Number(openFlags)).toBeGreaterThanOrEqual(1);
  });

  // Final Phase 2 release review: every other test in this file calls
  // attendance_month_end_summary as a super-admin fixture caller
  // (createFixture's own convention) -- none actually exercised the
  // permission bar itself. Confirms it empirically, not just by
  // reading that it mirrors get_payroll_attendance_counts' own
  // already-reviewed check.
  it('attendance_month_end_summary rejects a caller with no payroll.view permission, no legacy role_level<=2, and no super-admin flag', () => {
    const tenantId = randomUUID();
    const callerId = randomUUID();
    exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', 'Permission Test Tenant', 'PTT-${tenantId.slice(0, 8)}')`);
    exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
    exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, role_level) VALUES ('${callerId}', '${tenantId}', false, true, 99)`);
    exec(`SELECT set_caller('${callerId}')`);
    try {
      execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-c', `SELECT * FROM attendance_month_end_summary('2026-11')`], { stdio: ['ignore', 'pipe', 'pipe'] });
      throw new Error('Expected attendance_month_end_summary to reject an unauthorized caller, but it succeeded.');
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
      expect(stderr).toContain('You do not have permission to view the month-end attendance summary');
    }
  });

  it('a Nov 30 overnight shift resolves correctly once its Dec 1 checkout evidence arrives -- the automatic reconciliation window rolls over a month/year boundary with no special-casing needed', () => {
    const fixture = createFixture('NIGHT SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'night', '2026-11-01', NULL)`);
    insertRawEvent(fixture, '2026-11-30T14:05:00Z');
    insertRawEvent(fixture, '2026-12-01T05:00:00Z');

    queryRow(
      `SELECT attendance_process_import_batch('${fixture.batchId}', ARRAY['GATE1'], ` +
      `'2026-11-30T10:00:00Z'::timestamptz, '2026-12-01T06:30:00Z'::timestamptz, ` +
      `'2026-12-01'::date, '2026-12-01'::date, NULL, NULL, NULL, false)`
    );

    const rows = queryRow(`SELECT status, source FROM attendance WHERE employee_id = '${fixture.employeeId}' AND date = '2026-11-30'`);
    const [status, source] = rows;
    expect(['P', 'L']).toContain(status);
    expect(source).toBe('automatic');
  });
});
