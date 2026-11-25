// SAFEGUARD -- Automatic Fingerprint Terminal Resolution.
//
// Drives the real, unmodified RPCs (attendance_resolve_and_calculate,
// attendance_apply_automatic, attendance_process_import_batch,
// set_site_hikcentral_terminals, set_employee_hikcentral_terminals,
// attendance_coverage_explain) against a disposable Postgres loaded
// with the exact schema in supabase/migrations/ -- proving the new
// shared site-level terminal model end-to-end, never just by reading
// the migration. Same disposable-database convention as
// attendancePipelineIntegration.test.ts; never connects to production.
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

function queryRow(sql: string): string[] {
  const out = execFileSync('psql', ['-t', '-A', '-F', '\t', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split('\t') : [];
}

function queryRows(sql: string): string[][] {
  const out = execFileSync('psql', ['-t', '-A', '-F', '\t', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split('\n').map((line) => line.split('\t')) : [];
}

interface Fixture {
  tenantId: string;
  callerId: string;
  employeeId: string;
  personNo: string;
  batchId: string;
  site: string;
}

/**
 * Same minimal fixture shape as attendancePipelineIntegration.test.ts,
 * but DELIBERATELY never calls set_employee_hikcentral_terminals --
 * every test in this file decides for itself whether the employee gets
 * an individual assignment, a site-level config, both, or neither.
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
  exec(`INSERT INTO hikcentral_person_mappings (tenant_id, hikcentral_person_no, employee_id, match_method, is_active) VALUES ('${tenantId}', '${personNo}', '${employeeId}', 'manual', true)`);
  exec(`INSERT INTO hikcentral_import_batches (id, tenant_id, filename, status, imported_by) VALUES ('${batchId}', '${tenantId}', 'integration-test.xlsx', 'completed', '${callerId}')`);

  return { tenantId, callerId, employeeId, personNo, batchId, site };
}

function insertRawEvent(fixture: Fixture, isoTime: string, accessPoint: string): void {
  exec(
    `INSERT INTO hikcentral_raw_events (tenant_id, import_batch_id, hikcentral_person_no, event_time, access_point, authentication_result, event_type, event_fingerprint) ` +
    `VALUES ('${fixture.tenantId}', '${fixture.batchId}', '${fixture.personNo}', '${isoTime}', '${accessPoint}', 'Authorization', 'Access Granted by Fingerprint', '${randomUUID()}')`
  );
}

function attendanceRow(employeeId: string, date: string): { status: string | null; source: string | null } {
  const rows = queryRows(`SELECT status, source FROM attendance WHERE employee_id = '${employeeId}' AND date = '${date}'`);
  if (rows.length === 0) return { status: null, source: null };
  return { status: rows[0][0] || null, source: rows[0][1] || null };
}

/** Inserts a genuinely evidence-backed coverage confirmation for the given access points spanning the given UTC window. */
function confirmCoverage(fixture: Fixture, accessPoints: string[], coversFromIso: string, coversThroughIso: string, latestObservedIso: string): void {
  const apArray = accessPoints.map((a) => `'${a}'`).join(',');
  exec(
    `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through, latest_observed_event_at) ` +
    `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY[]::TEXT[], ARRAY[${apArray}], '${coversFromIso}', '${coversThroughIso}', '${latestObservedIso}')`
  );
}

function resolveAndCalculate(employeeId: string, date: string): { status: string; basis: string; reason: string } {
  const [status, basis, , , reason] = queryRow(`SELECT status, COALESCE(calculation_basis,''), check_in_at, check_out_at, reason FROM attendance_resolve_and_calculate('${employeeId}'::uuid, '${date}'::date)`);
  return { status, basis, reason };
}

describe.skipIf(!dbAvailable && !dbRequired)('Automatic fingerprint terminal resolution (real SQL functions, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error('ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable.');
      }
      console.warn('attendanceAutomaticTerminalResolution.test.ts: no reachable Postgres -- skipping.');
    }
  });

  // 1. Valid fingerprint from one terminal (site-level fallback, no individual assignment at all).
  it('item 1: a mapped employee with NO individual terminal assignment resolves Present via the shared site-level configuration', () => {
    const fixture = createFixture('LIMBE TEST SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['AHL-LIMBE-DOOR-1'])`);
    insertRawEvent(fixture, '2026-11-16T04:05:00Z', 'AHL-LIMBE-DOOR-1');
    insertRawEvent(fixture, '2026-11-16T14:00:00Z', 'AHL-LIMBE-DOOR-1');
    confirmCoverage(fixture, ['AHL-LIMBE-DOOR-1'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T14:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('present');
    expect(result.basis).toBe('confirmed');
  });

  // 2. Check-in and checkout from two different eligible terminals.
  it('item 2: a valid check-in at one eligible terminal and checkout at a DIFFERENT eligible terminal both count as the same shift\'s evidence', () => {
    const fixture = createFixture('TWO DOOR SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['DOOR-A', 'DOOR-B'])`);
    insertRawEvent(fixture, '2026-11-16T04:05:00Z', 'DOOR-A'); // check-in at Door A
    insertRawEvent(fixture, '2026-11-16T14:00:00Z', 'DOOR-B'); // checkout at Door B
    confirmCoverage(fixture, ['DOOR-A', 'DOOR-B'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T14:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('present');
    expect(result.basis).toBe('confirmed');
  });

  // 3. Employee changes workstation.
  it('item 3: an employee moved to a different (configured) workstation picks up that site\'s terminals automatically, with no admin action', () => {
    const fixture = createFixture('OLD SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('OLD SITE', ARRAY['OLD-DOOR'])`);
    exec(`SELECT set_site_hikcentral_terminals('NEW SITE', ARRAY['NEW-DOOR'])`);

    // Move the employee to NEW SITE.
    exec(`UPDATE employees SET workstation = 'NEW SITE' WHERE id = '${fixture.employeeId}'`);

    insertRawEvent(fixture, '2026-11-16T04:05:00Z', 'NEW-DOOR');
    insertRawEvent(fixture, '2026-11-16T14:00:00Z', 'NEW-DOOR');
    confirmCoverage(fixture, ['NEW-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T14:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('present');

    // The OLD site's terminal is never consulted for this employee any more.
    const [eligible] = queryRow(`SELECT array_agg(access_point ORDER BY access_point) FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
    expect(eligible).toBe('{NEW-DOOR}');
  });

  // 4. Multiple terminals at one site -- explicit human configuration, both must be covered.
  it('item 4: a site configured with two terminals requires BOTH to be covered before Absent is ever reached -- one missing stays Pending', () => {
    const fixture = createFixture('MULTI DOOR SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['DOOR-A', 'DOOR-B'])`);
    // Only DOOR-A has a coverage confirmation -- DOOR-B does not.
    confirmCoverage(fixture, ['DOOR-A'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T15:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('pending');
    expect(result.status).not.toBe('absent');
  });

  // 5. Fingerprint-managed employee has no prior individual terminal assignment (distinct from item 1: explicit absence check).
  it('item 5: a freshly-mapped employee with zero prior employee_hikcentral_terminals rows is still Absent-eligible once their site is configured', () => {
    const fixture = createFixture('FRESH ONBOARD SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    const [ownAssignments] = queryRow(`SELECT count(*) FROM employee_hikcentral_terminals WHERE employee_id = '${fixture.employeeId}'::uuid`);
    expect(ownAssignments).toBe('0');
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['FRESH-DOOR'])`);
    confirmCoverage(fixture, ['FRESH-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T18:00:00Z');
    // No scans at all -- genuinely absent once coverage is confirmed complete.
    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('absent');
  });

  // 6. Mapped employee with incomplete coverage.
  it('item 6: a mapped, site-configured employee with a coverage declaration that does NOT span the whole shift stays Pending', () => {
    const fixture = createFixture('PARTIAL COVERAGE SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['PARTIAL-DOOR'])`);
    // Covers through only 10:00Z -- the Day shift's checkout window ends at 20:00Z (18:00Z Blantyre).
    confirmCoverage(fixture, ['PARTIAL-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T10:00:00Z', '2026-11-16T09:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('pending');
  });

  // 7. Multiple access points with one terminal missing from export entirely (no confirmation row at all for it).
  it('item 7: of two eligible terminals, one with no coverage confirmation row at all still correctly blocks Absent (never assumed covered by omission)', () => {
    const fixture = createFixture('MISSING EXPORT SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['EXPORTED-DOOR', 'MISSING-DOOR'])`);
    confirmCoverage(fixture, ['EXPORTED-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T15:00:00Z');
    // MISSING-DOOR has no confirmation row at all.
    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('pending');
  });

  // 8. No scans with genuinely complete relevant coverage -> Absent.
  it('item 8: no scans at all, with genuinely complete, evidence-backed coverage for every eligible terminal, resolves Absent', () => {
    const fixture = createFixture('TRUE ABSENCE SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['TA-DOOR'])`);
    confirmCoverage(fixture, ['TA-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');
    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('absent');
  });

  // 9. No scans with incomplete coverage -> Pending, never Absent.
  it('item 9: no scans at all, with NO coverage confirmation for the site\'s terminal, stays Pending -- never a fabricated Absent', () => {
    const fixture = createFixture('NO COVERAGE SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['NC-DOOR'])`);
    // No confirmCoverage call at all.
    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('pending');
    expect(result.status).not.toBe('absent');
  });

  // 10. Manual attendance without mapping.
  it('item 10: an employee with NO HikCentral mapping at all is never automatically marked Absent, however complete any site\'s coverage is', () => {
    const fixture = createFixture('UNMAPPED SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`UPDATE hikcentral_person_mappings SET is_active = false WHERE employee_id = '${fixture.employeeId}'::uuid`); // deactivate the mapping
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['UM-DOOR'])`);
    confirmCoverage(fixture, ['UM-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).not.toBe('absent');
    expect(result.status).toBe('pending');
  });

  // 11. Mapped employee deliberately managed manually (the CHITANI K KAPANDA production counterexample).
  //
  // POST-REVIEW CORRECTION: this is no longer gated by attendance.source
  // history at all (see the migration's header REVISION) -- a review
  // correctly found that heuristic unreliable in both directions. The
  // gate is now the EXPLICIT, reviewable fingerprint_attendance_enabled
  // flag on the mapping itself. This test simulates exactly the
  // situation the one-time migration backfill protects: a pre-existing
  // mapping with no individual terminal assignment, conservatively left
  // disabled, REGARDLESS of whether it has any attendance history at
  // all (CHITANI/GIFT's actual production state) -- see the dedicated
  // "counterexample A" test below for the zero-history case explicitly.
  it('item 11: a mapped employee who has not been explicitly enabled for fingerprint attendance is NEVER swept into the site-level fallback, even once their site is configured', () => {
    const fixture = createFixture('DELIBERATE MANUAL SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    // Simulates the conservative migration backfill default for a
    // pre-existing mapping with no individual assignment -- never
    // inferred from attendance history.
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], false)`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['DM-DOOR'])`);
    confirmCoverage(fixture, ['DM-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');

    // No scans on 11-16 -- if the site fallback applied, this would resolve Absent. It must not.
    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('pending');
    expect(result.status).not.toBe('absent');

    const [eligibleCount] = queryRow(`SELECT count(*) FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
    expect(eligibleCount).toBe('0');
  });

  // 12. Overnight shifts.
  it('item 12: an overnight (Night) shift resolves correctly through the site-level fallback, crossing midnight', () => {
    const fixture = createFixture('NIGHT SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'night', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['NIGHT-DOOR'])`);
    insertRawEvent(fixture, '2026-11-16T14:05:00Z', 'NIGHT-DOOR'); // 16:05 Blantyre check-in
    insertRawEvent(fixture, '2026-11-17T05:00:00Z', 'NIGHT-DOOR'); // 07:00 Blantyre next-day checkout
    confirmCoverage(fixture, ['NIGHT-DOOR'], '2026-11-16T10:00:00Z', '2026-11-17T06:30:00Z', '2026-11-17T05:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(['present', 'late']).toContain(result.status);
    expect(result.basis).toBe('confirmed');
  });

  // 13. Off-days.
  it('item 13: a scheduled Off day short-circuits before any terminal/coverage logic runs at all -- unaffected by site configuration', () => {
    const fixture = createFixture('OFF DAY SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], 0, NULL, '2026-11-01', NULL)`); // Sunday off
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['OD-DOOR'])`);
    confirmCoverage(fixture, ['OD-DOOR'], '2026-11-01T00:00:00Z', '2026-11-30T23:59:00Z', '2026-11-20T00:00:00Z');

    // 2026-11-15 is a Sunday.
    const result = resolveAndCalculate(fixture.employeeId, '2026-11-15');
    expect(result.status).toBe('off');
  });

  // 14. Duplicate import idempotency.
  it('item 14: repeating attendance_process_import_batch with the identical declaration, after the site fallback resolved an Absent, is idempotent -- no duplicate write, no duplicate confirmation', () => {
    const fixture = createFixture('IDEMPOTENT SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['IDEMPOTENT-DOOR'])`);

    const runBatch = () => queryRow(
      `SELECT r->>'confirmation_id', r->>'applied_count', r->>'unchanged_count' FROM (` +
      `SELECT attendance_process_import_batch('${fixture.batchId}', ARRAY['IDEMPOTENT-DOOR'], ` +
      `'2026-11-16T00:00:00Z'::timestamptz, '2026-11-16T23:59:00Z'::timestamptz, '2026-11-16'::date, '2026-11-16'::date, ` +
      `NULL, NULL, 'No scans at all -- site supervisor confirms genuine absence.', true) AS r) t`
    );
    const first = runBatch();
    expect(first[1]).toBe('1'); // applied
    expect(attendanceRow(fixture.employeeId, '2026-11-16').status).toBe('A');

    const second = runBatch();
    expect(second[0]).toBe(first[0]); // same confirmation reused, never duplicated
    expect(second[1]).toBe('0'); // nothing re-applied
    expect(second[2]).toBe('1'); // unchanged

    const [confirmationCount] = queryRow(`SELECT count(*) FROM fingerprint_coverage_confirmations WHERE tenant_id = '${fixture.tenantId}'::uuid`);
    expect(confirmationCount).toBe('1');
  });

  // 15. Manual correction protection.
  it('item 15: an existing manual correction is never overwritten by automatic processing, even for a site-era employee with their OWN individual terminal assignment (own assignment always wins, unaffected by the new manual-history gate)', () => {
    const fixture = createFixture('PROTECTED MANUAL SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    // An individual assignment -- this employee's own eligible set is
    // decided by it unconditionally, never gated by manual history
    // (that gate only ever applies to the SHARED site fallback).
    exec(`SELECT set_employee_hikcentral_terminals('${fixture.employeeId}', ARRAY['PM-DOOR'])`);
    exec(`SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-16'::date, 'P', 'Manager confirms present despite no scan recorded.')`);
    confirmCoverage(fixture, ['PM-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');

    const [outcome] = queryRow(`SELECT outcome FROM attendance_apply_automatic(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-16'::date, '2026-11-16'::date)`);
    expect(outcome).toBe('skipped_manual_protected');
    expect(attendanceRow(fixture.employeeId, '2026-11-16')).toEqual({ status: 'P', source: 'manual' });
  });

  // 16. Approved payroll protection.
  it('item 16: approved payroll for the month blocks the site-level fallback\'s automatic write just as it already blocks individually-assigned employees', () => {
    const fixture = createFixture('PAYROLL SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`INSERT INTO payroll (tenant_id, employee_id, month, approval_status) VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '2026-11', 'approved')`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['PAYROLL-DOOR'])`);
    confirmCoverage(fixture, ['PAYROLL-DOOR'], '2026-11-05T00:00:00Z', '2026-11-05T23:59:00Z', '2026-11-05T19:00:00Z');

    const [outcome, , , payrollFlag] = queryRow(`SELECT outcome, old_status, new_status, payroll_flag FROM attendance_apply_automatic(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-05'::date, '2026-11-05'::date)`);
    expect(outcome).toBe('skipped_payroll_approved');
    expect(payrollFlag).toBe('approved');
    expect(attendanceRow(fixture.employeeId, '2026-11-05').status).toBeNull();
  });

  // 17. Site-wide terminal outage.
  it('item 17: a site-wide outage (declared coverage with no observed evidence at all) never resolves Absent on its own -- stays Pending until independently verified', () => {
    const fixture = createFixture('OUTAGE SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['OUTAGE-DOOR'])`);
    // A confirmation exists but was never evidence-checked (latest_observed_event_at NULL, exceeds_observed_evidence false) --
    // the 'unsupported_historical' case, distinct from a genuine outage override.
    exec(
      `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY[]::TEXT[], ARRAY['OUTAGE-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z')`
    );
    const [confirmationId] = queryRow(`SELECT id FROM fingerprint_coverage_confirmations WHERE tenant_id = '${fixture.tenantId}'::uuid`);
    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('pending');

    // An administrator who independently verifies a genuine outage CAN
    // still override -- confirmations are append-only, so this revokes
    // the unsupported one and creates a NEW one carrying the override
    // fields (never an in-place edit) -- confirmed site-wide Absent
    // becomes reachable.
    exec(`SELECT attendance_revoke_coverage('${confirmationId}'::uuid, 'Superseded by an independently verified outage confirmation.')`);
    exec(
      `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through, exceeds_observed_evidence, independently_verified, override_reason) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY[]::TEXT[], ARRAY['OUTAGE-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', true, true, 'Site supervisor confirms terminal was down all day; genuine absence.')`
    );
    const resultAfterOverride = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(resultAfterOverride.status).toBe('absent');
  });

  // 18. Tenant/region isolation and permissions.
  it('item 18: an identical site name in a DIFFERENT tenant never leaks that tenant\'s terminal configuration across the boundary', () => {
    const fixtureA = createFixture('SHARED NAME SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixtureA.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('SHARED NAME SITE', ARRAY['TENANT-A-DOOR'])`);

    const fixtureB = createFixture('SHARED NAME SITE');
    // Tenant B deliberately configures a DIFFERENT terminal for the same site name.
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixtureB.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_site_hikcentral_terminals('SHARED NAME SITE', ARRAY['TENANT-B-DOOR'])`);

    const [eligibleA] = queryRow(`SELECT array_agg(access_point) FROM attendance_employee_eligible_terminals('${fixtureA.tenantId}'::uuid, '${fixtureA.employeeId}'::uuid)`);
    const [eligibleB] = queryRow(`SELECT array_agg(access_point) FROM attendance_employee_eligible_terminals('${fixtureB.tenantId}'::uuid, '${fixtureB.employeeId}'::uuid)`);
    expect(eligibleA).toBe('{TENANT-A-DOOR}');
    expect(eligibleB).toBe('{TENANT-B-DOOR}');

    // Confirming coverage for tenant A's door must never satisfy tenant B's employee.
    exec(
      `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through, latest_observed_event_at) ` +
      `VALUES ('${fixtureA.tenantId}', '${fixtureA.callerId}', ARRAY[]::TEXT[], ARRAY['TENANT-A-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T18:00:00Z')`
    );
    const resultB = resolveAndCalculate(fixtureB.employeeId, '2026-11-16');
    expect(resultB.status).toBe('pending'); // tenant B's own TENANT-B-DOOR has no confirmation of its own

    // set_site_hikcentral_terminals itself requires authentication.
    exec(`SELECT set_caller(NULL)`);
    const stderr = execExpectError(`SELECT set_site_hikcentral_terminals('SHARED NAME SITE', ARRAY['SHOULD-FAIL-DOOR'])`);
    expect(stderr).toMatch(/not authenticated/i);
  });

  // 19. No false absences during migration or rollout.
  it('item 19: applying the new migration/seed logic never changes or creates any existing attendance row by itself', () => {
    const fixture = createFixture('MIGRATION SAFETY SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'A', 'Pre-existing historical record, predates this release.')`);

    const [beforeCount] = queryRow(`SELECT count(*) FROM attendance WHERE tenant_id = '${fixture.tenantId}'::uuid`);
    const beforeRow = attendanceRow(fixture.employeeId, '2026-11-10');

    // Simulate "rollout": configure the site and re-run the (idempotent) seed-equivalent rollup logic directly --
    // this must never touch the attendance table at all, only site_hikcentral_terminals.
    exec(`SELECT set_employee_hikcentral_terminals('${fixture.employeeId}', ARRAY['MS-DOOR'])`);
    exec(
      `INSERT INTO site_hikcentral_terminals (tenant_id, site, access_point, source) ` +
      `SELECT t.tenant_id, upper(btrim(regexp_replace(e.workstation, '\\s+', ' ', 'g'))), (array_agg(DISTINCT t.access_point))[1], 'derived_from_employee_assignments' ` +
      `FROM employee_hikcentral_terminals t JOIN employees e ON e.id = t.employee_id AND e.tenant_id = t.tenant_id ` +
      `WHERE t.is_active AND t.tenant_id = '${fixture.tenantId}'::uuid GROUP BY t.tenant_id, upper(btrim(regexp_replace(e.workstation, '\\s+', ' ', 'g'))) ` +
      `HAVING count(DISTINCT t.access_point) = 1 ON CONFLICT DO NOTHING`
    );

    const [afterCount] = queryRow(`SELECT count(*) FROM attendance WHERE tenant_id = '${fixture.tenantId}'::uuid`);
    const afterRow = attendanceRow(fixture.employeeId, '2026-11-10');
    expect(afterCount).toBe(beforeCount);
    expect(afterRow).toEqual(beforeRow);
    expect(afterRow).toEqual({ status: 'A', source: 'manual' });
  });

  // 20. No attendance mutations during identity mapping.
  it('item 20: confirming a HikCentral person mapping, and configuring a site\'s terminals, never themselves write any attendance row', () => {
    const fixture = createFixture('MAPPING SAFETY SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    const [beforeCount] = queryRow(`SELECT count(*) FROM attendance WHERE tenant_id = '${fixture.tenantId}'::uuid`);

    const otherEmployeeId = randomUUID();
    const otherPersonNo = `P${randomUUID().slice(0, 8)}`;
    exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${otherEmployeeId}', '${fixture.tenantId}', 'E-${otherEmployeeId.slice(0, 8)}', 'Other Mapping Safety Employee', 'Active', false, '${fixture.site}')`);
    // confirm_hikcentral_person_mappings validates the Person No. actually appears in this tenant's raw events before accepting a mapping.
    exec(`INSERT INTO hikcentral_raw_events (tenant_id, import_batch_id, hikcentral_person_no, event_time, access_point, authentication_result, event_type, event_fingerprint) VALUES ('${fixture.tenantId}', '${fixture.batchId}', '${otherPersonNo}', '2026-11-16T04:05:00Z', 'MAP-SAFE-DOOR', 'Authorization', 'Access Granted by Fingerprint', '${randomUUID()}')`);
    exec(
      `SELECT confirm_hikcentral_person_mappings('[{"hikcentral_person_no":"${otherPersonNo}","employee_id":"${otherEmployeeId}","match_method":"manual"}]'::jsonb)`
    );
    exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['MAP-SAFE-DOOR'])`);

    const [afterCount] = queryRow(`SELECT count(*) FROM attendance WHERE tenant_id = '${fixture.tenantId}'::uuid`);
    expect(afterCount).toBe(beforeCount);
  });

  // POST-REVIEW CORRECTION: the two concrete counterexamples the review
  // asked for, plus direct coverage of the migration's one-time backfill
  // and the new explicit set_fingerprint_attendance_enabled RPC.
  describe('explicit fingerprint_attendance_enabled flag (post-review correction)', () => {
    it('migration backfill: a pre-existing mapping with no individual assignment is backfilled to disabled regardless of attendance history, while one with an individual assignment is backfilled to enabled', () => {
      const fixtureGap = createFixture('BACKFILL GAP SITE');
      // Simulate a mapping that predates this feature where some other
      // process had left the column at its true default -- the backfill
      // statement itself must still correct it down to false, since this
      // employee has no individual employee_hikcentral_terminals row.
      exec(`UPDATE hikcentral_person_mappings SET fingerprint_attendance_enabled = true WHERE employee_id = '${fixtureGap.employeeId}'::uuid`);

      const fixtureAssigned = createFixture('BACKFILL ASSIGNED SITE');
      exec(`SELECT set_employee_hikcentral_terminals('${fixtureAssigned.employeeId}', ARRAY['BF-DOOR'])`);
      exec(`UPDATE hikcentral_person_mappings SET fingerprint_attendance_enabled = false WHERE employee_id = '${fixtureAssigned.employeeId}'::uuid`);

      // The exact one-time backfill statement from the migration (PART 1B), re-run directly.
      exec(
        `UPDATE hikcentral_person_mappings m SET fingerprint_attendance_enabled = EXISTS (` +
        `SELECT 1 FROM employee_hikcentral_terminals t WHERE t.tenant_id = m.tenant_id AND t.employee_id = m.employee_id AND t.is_active` +
        `) WHERE m.is_active`
      );

      const [gapEnabled] = queryRow(`SELECT fingerprint_attendance_enabled FROM hikcentral_person_mappings WHERE employee_id = '${fixtureGap.employeeId}'::uuid`);
      expect(gapEnabled).toBe('f');
      const [assignedEnabled] = queryRow(`SELECT fingerprint_attendance_enabled FROM hikcentral_person_mappings WHERE employee_id = '${fixtureAssigned.employeeId}'::uuid`);
      expect(assignedEnabled).toBe('t');
    });

    it('a freshly-confirmed mapping defaults to enabled with no extra admin step (confirm_hikcentral_person_mappings is unmodified -- the column default alone establishes intent)', () => {
      const fixture = createFixture('FRESH CONFIRM DEFAULT SITE');
      const [enabled] = queryRow(`SELECT fingerprint_attendance_enabled FROM hikcentral_person_mappings WHERE employee_id = '${fixture.employeeId}'::uuid AND is_active`);
      expect(enabled).toBe('t');

      const otherEmployeeId = randomUUID();
      const otherPersonNo = `P${randomUUID().slice(0, 8)}`;
      exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${otherEmployeeId}', '${fixture.tenantId}', 'E-${otherEmployeeId.slice(0, 8)}', 'Fresh Confirm Via RPC', 'Active', false, '${fixture.site}')`);
      exec(`INSERT INTO hikcentral_raw_events (tenant_id, import_batch_id, hikcentral_person_no, event_time, access_point, authentication_result, event_type, event_fingerprint) VALUES ('${fixture.tenantId}', '${fixture.batchId}', '${otherPersonNo}', '2026-11-16T04:05:00Z', 'FRESH-DOOR', 'Authorization', 'Access Granted by Fingerprint', '${randomUUID()}')`);
      exec(`SELECT confirm_hikcentral_person_mappings('[{"hikcentral_person_no":"${otherPersonNo}","employee_id":"${otherEmployeeId}","match_method":"manual"}]'::jsonb)`);

      const [enabledViaRpc] = queryRow(`SELECT fingerprint_attendance_enabled FROM hikcentral_person_mappings WHERE employee_id = '${otherEmployeeId}'::uuid AND is_active`);
      expect(enabledViaRpc).toBe('t');
    });

    // COUNTEREXAMPLE A (required by review): a mapped, deliberately-manual
    // employee with ZERO attendance history -- the exact case the
    // superseded attendance.source heuristic could not protect, since
    // there is no manual row to read. Left disabled by the conservative
    // migration default, it must never become Absent-eligible just
    // because their site happens to be configured.
    it('counterexample A: a mapped employee with ZERO attendance history, left disabled by the conservative migration default, is never automatically Absent-eligible merely because their site is configured', () => {
      const fixture = createFixture('COUNTEREXAMPLE A SITE');
      exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], false)`);

      const [attendanceCountBefore] = queryRow(`SELECT count(*) FROM attendance WHERE employee_id = '${fixture.employeeId}'::uuid`);
      expect(attendanceCountBefore).toBe('0');

      exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['CA-DOOR'])`);
      confirmCoverage(fixture, ['CA-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');
      // No scans at all -- if the site fallback silently applied, this would resolve Absent. It must not.
      const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
      expect(result.status).toBe('pending');
      expect(result.status).not.toBe('absent');

      // Once explicitly, reviewably enabled, the exact same configuration now correctly resolves Absent.
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
      const resultAfterEnable = resolveAndCalculate(fixture.employeeId, '2026-11-16');
      expect(resultAfterEnable.status).toBe('absent');
    });

    // COUNTEREXAMPLE B (required by review): a genuine fingerprint
    // employee with exactly one historical manual correction must not
    // permanently lose site-shared automation. Removing the
    // attendance.source heuristic entirely (rather than refining it)
    // fixes this as a direct consequence: the one manual-corrected date
    // stays protected by attendance_write_one's own, unrelated, per-date
    // manual-source precedence, while every other date keeps resolving
    // normally through the site-level fallback.
    it('counterexample B: a genuine fingerprint employee with exactly one historical manual correction retains normal site-shared eligibility on every other, unprotected date', () => {
      const fixture = createFixture('COUNTEREXAMPLE B SITE');
      exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
      // Default enabled=true for this freshly-confirmed mapping -- no extra step.
      exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['CB-DOOR'])`);
      // One historical manual correction, on an unrelated earlier date (e.g. a device outage that day).
      exec(`SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-01'::date, 'P', 'One-off manual correction for a device outage that day.')`);
      confirmCoverage(fixture, ['CB-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');

      const [eligibleCount] = queryRow(`SELECT count(*) FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
      expect(eligibleCount).toBe('1');

      // 11-16 is unrelated to the one manual correction -- it still resolves normally (no scans, genuinely complete coverage -> Absent).
      const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
      expect(result.status).toBe('absent');

      // The one manual correction itself remains completely untouched.
      expect(attendanceRow(fixture.employeeId, '2026-11-01')).toEqual({ status: 'P', source: 'manual' });
    });

    it('set_fingerprint_attendance_enabled requires authentication, only affects the caller\'s own tenant, and bulk-updates every employee_id supplied', () => {
      const fixtureA = createFixture('ENABLE RPC TENANT A SITE');
      const fixtureB = createFixture('ENABLE RPC TENANT B SITE'); // createFixture switches the active caller to tenant B -- switch back explicitly below.

      // Bulk, as tenant A's own caller: both tenant A's own mapping, and
      // a second employee in the same array, are affected in one call.
      exec(`SELECT set_caller('${fixtureA.callerId}')`);
      const secondEmployeeId = randomUUID();
      exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${secondEmployeeId}', '${fixtureA.tenantId}', 'E-${secondEmployeeId.slice(0, 8)}', 'Second Bulk Employee', 'Active', false, '${fixtureA.site}')`);
      exec(`INSERT INTO hikcentral_person_mappings (tenant_id, hikcentral_person_no, employee_id, match_method, is_active) VALUES ('${fixtureA.tenantId}', 'P-SECOND-${secondEmployeeId.slice(0, 8)}', '${secondEmployeeId}', 'manual', true)`);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixtureA.employeeId}']::uuid[], false)`); // flip tenant A's own employee off first
      const [result] = queryRow(`SELECT (set_fingerprint_attendance_enabled(ARRAY['${fixtureA.employeeId}', '${secondEmployeeId}']::uuid[], true))->>'updated_count'`);
      expect(result).toBe('2');

      const [enabledA] = queryRow(`SELECT fingerprint_attendance_enabled FROM hikcentral_person_mappings WHERE employee_id = '${fixtureA.employeeId}'::uuid AND is_active`);
      expect(enabledA).toBe('t');

      // Tenant isolation, still as tenant A's own caller: cannot flip
      // tenant B's mapping, even naming its employee_id explicitly.
      const [untouchedResult] = queryRow(`SELECT (set_fingerprint_attendance_enabled(ARRAY['${fixtureB.employeeId}']::uuid[], false))->>'updated_count'`);
      expect(untouchedResult).toBe('0');

      exec(`SELECT set_caller('${fixtureB.callerId}')`);
      const [stillEnabledB] = queryRow(`SELECT fingerprint_attendance_enabled FROM hikcentral_person_mappings WHERE employee_id = '${fixtureB.employeeId}'::uuid AND is_active`);
      expect(stillEnabledB).toBe('t'); // untouched, still its own default

      exec(`SELECT set_caller(NULL)`);
      const stderr = execExpectError(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixtureA.employeeId}']::uuid[], true)`);
      expect(stderr).toMatch(/not authenticated/i);
    });
  });

  // Additional direct coverage of attendance_coverage_explain's new provenance values (Part 5 diagnostic transparency).
  describe('attendance_coverage_explain: new site-level provenance values', () => {
    it('reports "fingerprint_not_enabled" (not a plain gap) for a mapped, site-configured employee who has not been explicitly enabled', () => {
      const fixture = createFixture('EXPLAIN MANUAL SITE');
      exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], false)`);
      exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['EM-DOOR'])`);

      const [provenance, sufficientEvidence] = queryRow(
        `SELECT coverage_provenance, sufficient_evidence FROM attendance_coverage_explain(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-16'::date, '2026-11-16'::date)`
      );
      expect(provenance).toBe('fingerprint_not_enabled');
      expect(sufficientEvidence).toBe('f');
    });

    it('reports "no_assigned_terminal" (a genuine gap) for a mapped employee at a completely unconfigured site', () => {
      const fixture = createFixture('EXPLAIN GAP SITE');
      exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
      const [provenance] = queryRow(
        `SELECT coverage_provenance FROM attendance_coverage_explain(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-16'::date, '2026-11-16'::date)`
      );
      expect(provenance).toBe('no_assigned_terminal');
    });
  });

  describe('attendance_process_import_batch: needs_terminal_configuration / fingerprint_not_enabled_mapped_employees transparency', () => {
    it('lists a mapped, unconfigured employee under needs_terminal_configuration, and a mapped, not-yet-enabled employee separately under fingerprint_not_enabled_mapped_employees', () => {
      const fixture = createFixture('BATCH TRANSPARENCY SITE');
      exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], false)`);
      exec(`SELECT set_site_hikcentral_terminals('${fixture.site}', ARRAY['BT-DOOR'])`);
      insertRawEvent(fixture, '2026-11-16T04:05:00Z', 'BT-DOOR'); // in observed scope via a real event

      const [needsConfig, notEnabled] = queryRow(
        `SELECT r->>'needs_terminal_configuration', r->>'fingerprint_not_enabled_mapped_employees' FROM (` +
        `SELECT attendance_process_import_batch('${fixture.batchId}', ARRAY['BT-DOOR'], ` +
        `'2026-11-16T00:00:00Z'::timestamptz, '2026-11-16T06:00:00Z'::timestamptz, '2026-11-16'::date, '2026-11-16'::date) AS r) t`
      );
      expect(needsConfig).toBe('[]');
      expect(notEnabled).toContain(fixture.employeeId);
    });
  });

  // Part 5: hikcentral_mapped_employees_terminal_status -- the bulk
  // status feed for the Person Mapping page's new, honest status text.
  describe('hikcentral_mapped_employees_terminal_status', () => {
    it('reports "employee_assigned" for an employee with their own individual terminal, "site_shared" for one covered only by the shared site fallback, "fingerprint_not_enabled" for one whose site is configured but who has not been explicitly enabled, and "unconfigured" for a genuine gap', () => {
      const fixtureAssigned = createFixture('STATUS SITE ASSIGNED');
      exec(`SELECT set_employee_hikcentral_terminals('${fixtureAssigned.employeeId}', ARRAY['OWN-DOOR'])`);

      const fixtureShared = createFixture('STATUS SITE SHARED');
      exec(`SELECT set_site_hikcentral_terminals('${fixtureShared.site}', ARRAY['SHARED-DOOR'])`);

      const fixtureNotEnabled = createFixture('STATUS SITE NOT ENABLED');
      exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixtureNotEnabled.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixtureNotEnabled.employeeId}']::uuid[], false)`);
      exec(`SELECT set_site_hikcentral_terminals('${fixtureNotEnabled.site}', ARRAY['PROTECTED-DOOR'])`);

      const fixtureGap = createFixture('STATUS SITE GAP');
      // No individual assignment, no site config at all for this site.

      exec(`SELECT set_caller('${fixtureAssigned.callerId}')`);
      const [[, provenanceAssigned]] = queryRows(`SELECT employee_id, provenance FROM hikcentral_mapped_employees_terminal_status() WHERE employee_id = '${fixtureAssigned.employeeId}'::uuid`);
      expect(provenanceAssigned).toBe('employee_assigned');

      exec(`SELECT set_caller('${fixtureShared.callerId}')`);
      const [[, provenanceShared]] = queryRows(`SELECT employee_id, provenance FROM hikcentral_mapped_employees_terminal_status() WHERE employee_id = '${fixtureShared.employeeId}'::uuid`);
      expect(provenanceShared).toBe('site_shared');

      exec(`SELECT set_caller('${fixtureNotEnabled.callerId}')`);
      const [[, provenanceNotEnabled]] = queryRows(`SELECT employee_id, provenance FROM hikcentral_mapped_employees_terminal_status() WHERE employee_id = '${fixtureNotEnabled.employeeId}'::uuid`);
      expect(provenanceNotEnabled).toBe('fingerprint_not_enabled');

      exec(`SELECT set_caller('${fixtureGap.callerId}')`);
      const [[, provenanceGap]] = queryRows(`SELECT employee_id, provenance FROM hikcentral_mapped_employees_terminal_status() WHERE employee_id = '${fixtureGap.employeeId}'::uuid`);
      expect(provenanceGap).toBe('unconfigured');
    });

    it('requires authentication and the same attendance.map_hikcentral_persons permission the page itself already requires', () => {
      exec(`SELECT set_caller(NULL)`);
      const stderr = execExpectError(`SELECT * FROM hikcentral_mapped_employees_terminal_status()`);
      expect(stderr).toMatch(/not authenticated/i);
    });
  });
});
