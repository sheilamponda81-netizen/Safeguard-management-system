// SAFEGUARD -- Attendance Final Automation, Accuracy and Accountability
// Update.
//
// Covers two additive pieces of 20261201000000_attendance_automation_
// accuracy_accountability.sql not already exercised by
// attendanceSiteAlertLifecycle.test.ts (the threshold/source changes)
// or attendanceEngineSqlParity.test.ts (the rule-E explanation):
//   1. resolve_staff_names -- accountability name resolution, gated on
//      attendance.view, scoped to the caller's own tenant.
//   2. attendance_site_absence_alerts_list -- the new coverage_state /
//      suspected_device_or_import_issue columns.
// Same disposable-Postgres convention as the other attendance test
// files in this directory; never connects to production.
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

function execExpectError(sql: string): string {
  try {
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] });
    throw new Error('Expected this statement to fail, but it succeeded: ' + sql);
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr;
    return stderr ? stderr.toString('utf-8') : String(err);
  }
}

function queryRows(sql: string): string[][] {
  const out = execFileSync('psql', ['-t', '-A', '-F', '\t', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split('\n').map((line) => line.split('\t')) : [];
}

function queryJson(sql: string): unknown {
  const out = execFileSync('psql', ['-t', '-A', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? JSON.parse(out) : null;
}

interface Fixture { tenantId: string; callerId: string; site: string }

function createFixture(label: string, opts: { role?: string; permissions?: string[] } = {}): Fixture {
  const tenantId = randomUUID();
  const callerId = randomUUID();
  const site = `SITE-${tenantId.slice(0, 8)}`;
  exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', '${label}', 'ITT-${tenantId.slice(0, 8)}')`);
  exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
  if (opts.role) {
    const regionId = randomUUID();
    exec(`INSERT INTO regions (id, tenant_id, name, code) VALUES ('${regionId}', '${tenantId}', 'Main Region', 'MAIN-${regionId.slice(0, 8)}')`);
    exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, role, region_id, full_name) VALUES ('${callerId}', '${tenantId}', false, true, '${opts.role}', '${regionId}', 'Caller ${label}')`);
    for (const p of opts.permissions || []) {
      exec(`INSERT INTO role_permissions (role, permission) VALUES ('${opts.role}', '${p}') ON CONFLICT (role, permission) DO NOTHING`);
    }
  } else {
    exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, full_name) VALUES ('${callerId}', '${tenantId}', true, true, 'Caller ${label}')`);
  }
  exec(`SELECT set_caller('${callerId}')`);
  return { tenantId, callerId, site };
}

function makeEmployee(fixture: Fixture): string {
  const employeeId = randomUUID();
  exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${employeeId}', '${fixture.tenantId}', 'E-${employeeId.slice(0, 8)}', 'Integration Test Employee', 'Active', false, '${fixture.site}')`);
  return employeeId;
}

function setAttendance(fixture: Fixture, employeeId: string, date: string, status: string, source = 'automatic'): void {
  exec(
    `INSERT INTO attendance (tenant_id, employee_id, date, status, source) VALUES ('${fixture.tenantId}', '${employeeId}', '${date}', '${status}', '${source}') ` +
    `ON CONFLICT (employee_id, date) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source`
  );
}

describe.skipIf(!dbAvailable && !dbRequired)('resolve_staff_names + attendance_site_absence_alerts_list coverage_state (real SQL functions, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error('ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable.');
      }
      console.warn('attendanceAccountabilityAndCoverageState.test.ts: no reachable Postgres -- skipping.');
    }
  });

  it('resolve_staff_names returns the full name for a profile within the caller\'s own tenant', () => {
    const fixture = createFixture('Resolve Own Tenant');
    const otherUserId = randomUUID();
    exec(`INSERT INTO auth.users (id) VALUES ('${otherUserId}')`);
    exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, full_name) VALUES ('${otherUserId}', '${fixture.tenantId}', false, true, 'Jane HR Officer')`);

    const rows = queryRows(`SELECT user_id, full_name FROM resolve_staff_names(ARRAY['${otherUserId}']::uuid[])`);
    expect(rows).toEqual([[otherUserId, 'Jane HR Officer']]);
  });

  it('resolve_staff_names never returns a profile from a different tenant to a non-super-admin caller', () => {
    const fixtureA = createFixture('Resolve Tenant A', { role: 'hr_manager', permissions: ['attendance.map_hikcentral_persons'] });
    const fixtureB = createFixture('Resolve Tenant B');
    const otherUserId = randomUUID();
    exec(`INSERT INTO auth.users (id) VALUES ('${otherUserId}')`);
    exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, full_name) VALUES ('${otherUserId}', '${fixtureB.tenantId}', false, true, 'Someone Else Tenant B')`);

    exec(`SELECT set_caller('${fixtureA.callerId}')`);
    const rows = queryRows(`SELECT user_id, full_name FROM resolve_staff_names(ARRAY['${otherUserId}']::uuid[])`);
    expect(rows).toEqual([]);
  });

  // RELEASE SAFETY FIX (post-review): resolve_staff_names must be
  // gated on attendance.map_hikcentral_persons -- the SAME permission
  // the Evidence Centre page itself requires to open at all
  // (AttendanceEvidenceCentre.tsx's canView check) -- not
  // attendance.view, which this RPC's first draft copied from the
  // separate, unrelated attendance_site_absence_alerts_list function.
  // In production these two permissions are granted to two
  // non-overlapping roles (hr_manager and operations_manager), so this
  // is the exact difference between the feature working for its real
  // intended user and silently failing for them.
  it('resolve_staff_names succeeds for an hr_manager-role caller (attendance.map_hikcentral_persons, same permission that opens the Evidence Centre page)', () => {
    const fixture = createFixture('Resolve HR Manager', { role: 'hr_manager', permissions: ['attendance.map_hikcentral_persons'] });
    const otherUserId = randomUUID();
    exec(`INSERT INTO auth.users (id) VALUES ('${otherUserId}')`);
    exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, full_name) VALUES ('${otherUserId}', '${fixture.tenantId}', false, true, 'Jane HR Manager Colleague')`);

    exec(`SELECT set_caller('${fixture.callerId}')`);
    const rows = queryRows(`SELECT user_id, full_name FROM resolve_staff_names(ARRAY['${otherUserId}']::uuid[])`);
    expect(rows).toEqual([[otherUserId, 'Jane HR Manager Colleague']]);
  });

  it('resolve_staff_names rejects an operations_manager-role caller who holds ONLY attendance.view -- confirms the gate no longer matches the unrelated alerts-list permission', () => {
    const fixture = createFixture('Resolve Operations Manager Only', { role: 'operations_manager', permissions: ['attendance.view'] });
    const stderr = execExpectError(`SELECT * FROM resolve_staff_names(ARRAY['${fixture.callerId}']::uuid[])`);
    expect(stderr).toMatch(/not authorized/i);
  });

  it('resolve_staff_names requires attendance.map_hikcentral_persons (or super admin) -- a caller with no permission at all is rejected', () => {
    const fixture = createFixture('Resolve No Permission', { role: 'guard', permissions: [] });
    const stderr = execExpectError(`SELECT * FROM resolve_staff_names(ARRAY['${fixture.callerId}']::uuid[])`);
    expect(stderr).toMatch(/not authorized/i);
  });

  it('resolve_staff_names returns an empty set for an empty/null id array, never an error', () => {
    createFixture('Resolve Empty Array');
    expect(queryRows('SELECT * FROM resolve_staff_names(ARRAY[]::uuid[])')).toEqual([]);
    expect(queryRows('SELECT * FROM resolve_staff_names(NULL)')).toEqual([]);
  });

  it('attendance_site_absence_alerts_list flags suspected_device_or_import_issue only when a backing confirmation exceeds observed evidence', () => {
    const fixture = createFixture('Coverage State Outage Suspected');
    const date = '2026-11-20';
    const accessPoint = `AP-${fixture.tenantId.slice(0, 8)}`;
    const employees = Array.from({ length: 6 }, () => makeEmployee(fixture));
    employees.forEach((id) => {
      exec(`INSERT INTO employee_hikcentral_terminals (tenant_id, employee_id, access_point, is_active, assigned_by) VALUES ('${fixture.tenantId}', '${id}', '${accessPoint}', true, '${fixture.callerId}')`);
      setAttendance(fixture, id, date, 'A', 'automatic');
    });
    // A confirmation whose declared coverage reaches past the latest
    // actually-observed evidence -- the real "device/export may not
    // have reported for the whole window" signal.
    exec(
      `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through, export_time_declared, exceeds_observed_evidence, independently_verified, override_reason) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY['${fixture.site}'], ARRAY['${accessPoint}'], '${date}T00:00:00Z'::timestamptz - interval '4 hours', '${date}T00:00:00Z'::timestamptz + interval '2 days', '${date}T00:00:00Z'::timestamptz + interval '2 days', true, true, 'Verified with site supervisor despite the device gap')`
    );

    const rows = queryJson(`SELECT jsonb_agg(row_to_json(r)) FROM attendance_site_absence_alerts_list() r`) as Array<{ suspected_device_or_import_issue: boolean; coverage_state: unknown[] }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].suspected_device_or_import_issue).toBe(true);
    expect(rows[0].coverage_state.length).toBeGreaterThan(0);
  });

  it('attendance_site_absence_alerts_list does not flag suspected_device_or_import_issue when backing coverage is genuinely evidence-backed', () => {
    const fixture = createFixture('Coverage State Evidence Backed');
    const date = '2026-11-21';
    const accessPoint = `AP-${fixture.tenantId.slice(0, 8)}`;
    const employees = Array.from({ length: 6 }, () => makeEmployee(fixture));
    employees.forEach((id) => {
      exec(`INSERT INTO employee_hikcentral_terminals (tenant_id, employee_id, access_point, is_active, assigned_by) VALUES ('${fixture.tenantId}', '${id}', '${accessPoint}', true, '${fixture.callerId}')`);
      setAttendance(fixture, id, date, 'A', 'automatic');
    });
    exec(
      `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through, export_time_declared, latest_observed_event_at, exceeds_observed_evidence, independently_verified) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY['${fixture.site}'], ARRAY['${accessPoint}'], '${date}T00:00:00Z'::timestamptz - interval '4 hours', '${date}T00:00:00Z'::timestamptz + interval '2 days', '${date}T00:00:00Z'::timestamptz + interval '2 days', '${date}T00:00:00Z'::timestamptz + interval '1 day', false, false)`
    );

    const rows = queryJson(`SELECT jsonb_agg(row_to_json(r)) FROM attendance_site_absence_alerts_list() r`) as Array<{ suspected_device_or_import_issue: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].suspected_device_or_import_issue).toBe(false);
  });

  it('attendance_site_absence_alerts_list current_absent_count and affected_employees exclude manual-sourced Absent rows, consistent with the trigger', () => {
    const fixture = createFixture('List Excludes Manual');
    const date = '2026-11-22';
    const automaticEmployees = Array.from({ length: 6 }, () => makeEmployee(fixture));
    automaticEmployees.forEach((id) => setAttendance(fixture, id, date, 'A', 'automatic'));
    const manualEmployee = makeEmployee(fixture);
    setAttendance(fixture, manualEmployee, date, 'A', 'manual');

    const rows = queryJson(`SELECT jsonb_agg(row_to_json(r)) FROM attendance_site_absence_alerts_list() r`) as Array<{ current_absent_count: number; affected_employees: Array<{ employee_id: string }> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].current_absent_count).toBe(6);
    expect(rows[0].affected_employees).toHaveLength(6);
    expect(rows[0].affected_employees.some((e) => e.employee_id === manualEmployee)).toBe(false);
  });
});
