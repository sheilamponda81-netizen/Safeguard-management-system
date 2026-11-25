// SAFEGUARD -- Shared fingerprint terminal networks (Lilongwe).
//
// Drives the real, unmodified RPCs (attendance_resolve_and_calculate,
// attendance_apply_automatic, attendance_process_import_batch,
// set_terminal_network_members, set_site_network_membership,
// set_fingerprint_attendance_enabled, set_employee_hikcentral_terminals)
// against a disposable Postgres loaded with the exact schema in
// supabase/migrations/ -- proving the network model end-to-end, never
// just by reading the migration. Same disposable-database convention
// as attendanceAutomaticTerminalResolution.test.ts; never connects to
// production.
//
// NOTE on terminal names: production's 3 CONFIRMED Lilongwe access
// points are 'AHL - KANENGO_Door_1', 'LL - OCEAN_Door_1', and
// 'LL- MASM_Door_1' (see this release's discovery report). The 4th
// expected location, Office World, has NO confirmed HikCentral
// identifier in production -- this file never guesses one. Tests that
// need a representative "4th network terminal" to exercise the
// mechanism generically use a clearly-labeled placeholder
// ('NETWORK-DOOR-4-PLACEHOLDER'), never a guess at Office World's real
// device identifier.
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

/** Same minimal fixture shape as the sibling site-level test file. */
function createFixture(site: string): Fixture {
  const tenantId = randomUUID();
  const callerId = randomUUID();
  const employeeId = randomUUID();
  const personNo = `P${randomUUID().slice(0, 8)}`;
  const batchId = randomUUID();

  exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', 'Network Test Tenant', 'NTT-${tenantId.slice(0, 8)}')`);
  exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
  exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active) VALUES ('${callerId}', '${tenantId}', true, true)`);
  exec(`SELECT set_caller('${callerId}')`);
  exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${employeeId}', '${tenantId}', 'E-${employeeId.slice(0, 8)}', 'Network Test Employee', 'Active', false, '${site}')`);
  exec(`INSERT INTO hikcentral_person_mappings (tenant_id, hikcentral_person_no, employee_id, match_method, is_active) VALUES ('${tenantId}', '${personNo}', '${employeeId}', 'manual', true)`);
  exec(`INSERT INTO hikcentral_import_batches (id, tenant_id, filename, status, imported_by) VALUES ('${batchId}', '${tenantId}', 'network-test.xlsx', 'completed', '${callerId}')`);

  return { tenantId, callerId, employeeId, personNo, batchId, site };
}

/** Creates a second employee/mapping at the given site within an EXISTING fixture's own tenant. */
function addEmployeeAtSite(fixture: Fixture, site: string): { employeeId: string; personNo: string } {
  const employeeId = randomUUID();
  const personNo = `P${randomUUID().slice(0, 8)}`;
  exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${employeeId}', '${fixture.tenantId}', 'E-${employeeId.slice(0, 8)}', 'Second Network Test Employee', 'Active', false, '${site}')`);
  exec(`INSERT INTO hikcentral_person_mappings (tenant_id, hikcentral_person_no, employee_id, match_method, is_active) VALUES ('${fixture.tenantId}', '${personNo}', '${employeeId}', 'manual', true)`);
  return { employeeId, personNo };
}

function insertRawEvent(tenantId: string, batchId: string, personNo: string, isoTime: string, accessPoint: string): void {
  exec(
    `INSERT INTO hikcentral_raw_events (tenant_id, import_batch_id, hikcentral_person_no, event_time, access_point, authentication_result, event_type, event_fingerprint) ` +
    `VALUES ('${tenantId}', '${batchId}', '${personNo}', '${isoTime}', '${accessPoint}', 'Authorization', 'Access Granted by Fingerprint', '${randomUUID()}')`
  );
}

function attendanceRow(employeeId: string, date: string): { status: string | null; source: string | null } {
  const rows = queryRows(`SELECT status, source FROM attendance WHERE employee_id = '${employeeId}' AND date = '${date}'`);
  if (rows.length === 0) return { status: null, source: null };
  return { status: rows[0][0] || null, source: rows[0][1] || null };
}

function confirmCoverage(fixture: Fixture, accessPoints: string[], coversFromIso: string, coversThroughIso: string, latestObservedIso: string): void {
  const apArray = accessPoints.map((a) => `'${a}'`).join(',');
  exec(
    `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through, latest_observed_event_at) ` +
    `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY[]::TEXT[], ARRAY[${apArray}], '${coversFromIso}', '${coversThroughIso}', '${latestObservedIso}')`
  );
}

/**
 * Fetches an employee's eligible access points and returns them sorted
 * by plain JS string comparison -- never SQL's `ORDER BY`, whose text
 * collation (and therefore space-vs-hyphen ordering) is locale-
 * dependent and genuinely differs between environments (observed:
 * local Postgres vs. the CI postgres:16 container disagree on where
 * "LL - OCEAN_Door_1" sorts relative to "LL- MASM_Door_1").
 */
function eligibleAccessPointsSorted(tenantId: string, employeeId: string): string {
  const [raw] = queryRow(`SELECT array_to_string(array_agg(access_point), '|') FROM attendance_employee_eligible_terminals('${tenantId}'::uuid, '${employeeId}'::uuid)`);
  return (raw ? raw.split('|') : []).sort().join('|');
}

function resolveAndCalculate(employeeId: string, date: string): { status: string; basis: string; reason: string } {
  const [status, basis, , , reason] = queryRow(`SELECT status, COALESCE(calculation_basis,''), check_in_at, check_out_at, reason FROM attendance_resolve_and_calculate('${employeeId}'::uuid, '${date}'::date)`);
  return { status, basis, reason };
}

/** Sets up a fully-registered Lilongwe-style network (3 confirmed doors + a placeholder 4th), with the given sites joined to it. */
function setUpNetwork(network: string, sites: string[], doors: string[]): void {
  exec(`SELECT set_terminal_network_members('${network}', ARRAY[${doors.map((d) => `'${d}'`).join(',')}])`);
  exec(`SELECT set_site_network_membership(ARRAY[${sites.map((s) => `'${s}'`).join(',')}], '${network}')`);
}

const KANENGO = 'AHL - KANENGO_Door_1';
const OCEAN = 'LL - OCEAN_Door_1';
const MASM_LL = 'LL- MASM_Door_1';
const PLACEHOLDER_4TH_DOOR = 'NETWORK-DOOR-4-PLACEHOLDER';

describe.skipIf(!dbAvailable && !dbRequired)('Shared fingerprint terminal networks (real SQL functions, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error('ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable.');
      }
      console.warn('hikcentralTerminalNetwork.test.ts: no reachable Postgres -- skipping.');
    }
  });

  // 1. Different workstations using the same terminal network.
  it('item 1: two employees at two completely different workstations, both joined to the same network, both resolve the SAME eligible terminal set', () => {
    const fixture = createFixture('AREA 12');
    const second = addEmployeeAtSite(fixture, 'KANENGO AHL');
    setUpNetwork('LILONGWE NETWORK', ['AREA 12', 'KANENGO AHL'], [KANENGO, OCEAN, MASM_LL]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}', '${second.employeeId}']::uuid[], true)`);

    const eligibleFirst = eligibleAccessPointsSorted(fixture.tenantId, fixture.employeeId);
    const eligibleSecond = eligibleAccessPointsSorted(fixture.tenantId, second.employeeId);
    expect(eligibleFirst).toBe(eligibleSecond);
    expect(eligibleFirst).toBe([KANENGO, OCEAN, MASM_LL].sort().join('|'));
    const [provenance] = queryRow(`SELECT DISTINCT provenance FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
    expect(provenance).toBe('network_shared');
  });

  // 2. Employee checking in at KANENGO and out at MASM.
  it('item 2: a valid check-in at KANENGO and checkout at the Lilongwe MASM door, both in the same network, count as the same shift\'s evidence', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    setUpNetwork('LILONGWE NETWORK', ['AREA 12'], [KANENGO, OCEAN, MASM_LL]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
    insertRawEvent(fixture.tenantId, fixture.batchId, fixture.personNo, '2026-11-16T04:05:00Z', KANENGO);
    insertRawEvent(fixture.tenantId, fixture.batchId, fixture.personNo, '2026-11-16T14:00:00Z', MASM_LL);
    confirmCoverage(fixture, [KANENGO, OCEAN, MASM_LL], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T14:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('present');
    expect(result.basis).toBe('confirmed');
  });

  // 3. Employee checking in at OCEAN and out at the (placeholder) 4th network door.
  it('item 3: a valid check-in at OCEAN and checkout at a different eligible terminal in the same network both count as the same shift\'s evidence', () => {
    const fixture = createFixture('OCEAN');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    setUpNetwork('LILONGWE NETWORK', ['OCEAN'], [KANENGO, OCEAN, MASM_LL, PLACEHOLDER_4TH_DOOR]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
    insertRawEvent(fixture.tenantId, fixture.batchId, fixture.personNo, '2026-11-16T04:05:00Z', OCEAN);
    insertRawEvent(fixture.tenantId, fixture.batchId, fixture.personNo, '2026-11-16T14:00:00Z', PLACEHOLDER_4TH_DOOR);
    confirmCoverage(fixture, [KANENGO, OCEAN, MASM_LL, PLACEHOLDER_4TH_DOOR], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T14:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('present');
    expect(result.basis).toBe('confirmed');
  });

  // 4. Employee with no individual terminal assignment.
  it('item 4: a mapped employee with NO individual terminal assignment, and no direct site config, resolves Present via the network alone', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    const [ownAssignments] = queryRow(`SELECT count(*) FROM employee_hikcentral_terminals WHERE employee_id = '${fixture.employeeId}'::uuid`);
    expect(ownAssignments).toBe('0');
    setUpNetwork('LILONGWE NETWORK', ['AREA 12'], [KANENGO, OCEAN, MASM_LL]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
    insertRawEvent(fixture.tenantId, fixture.batchId, fixture.personNo, '2026-11-16T04:05:00Z', OCEAN);
    insertRawEvent(fixture.tenantId, fixture.batchId, fixture.personNo, '2026-11-16T14:00:00Z', OCEAN);
    confirmCoverage(fixture, [KANENGO, OCEAN, MASM_LL], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T14:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('present');
  });

  // 5. Mapped manual employee.
  it('item 5: a mapped employee whose site joins the network, but who has not been explicitly enabled, is NEVER swept into network eligibility', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    setUpNetwork('LILONGWE NETWORK', ['AREA 12'], [KANENGO, OCEAN, MASM_LL]);
    // Simulates every one of today's 58 real Lilongwe-area mapped employees -- a pre-existing mapping PR #80's migration backfill conservatively left disabled.
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], false)`);
    confirmCoverage(fixture, [KANENGO, OCEAN, MASM_LL], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('pending');
    expect(result.status).not.toBe('absent');
    const [eligibleCount] = queryRow(`SELECT count(*) FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
    expect(eligibleCount).toBe('0');
  });

  // 6. Missing coverage from one of four terminals.
  it('item 6: a network with 4 registered terminals but only 3 covered stays Pending -- the 4th missing terminal blocks Absent, never assumed covered', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    setUpNetwork('LILONGWE NETWORK', ['AREA 12'], [KANENGO, OCEAN, MASM_LL, PLACEHOLDER_4TH_DOOR]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
    // Only 3 of the 4 registered terminals have a coverage confirmation.
    confirmCoverage(fixture, [KANENGO, OCEAN, MASM_LL], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('pending');
    expect(result.status).not.toBe('absent');
  });

  // 7. All required terminals fully covered.
  it('item 7: all 4 registered network terminals fully covered correctly reaches Absent-eligibility for a no-scan day', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    setUpNetwork('LILONGWE NETWORK', ['AREA 12'], [KANENGO, OCEAN, MASM_LL, PLACEHOLDER_4TH_DOOR]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
    confirmCoverage(fixture, [KANENGO, OCEAN, MASM_LL, PLACEHOLDER_4TH_DOOR], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('absent');
  });

  // 8. No scans with complete coverage.
  it('item 8: no scans at all, with genuinely complete, evidence-backed coverage for the whole network, resolves Absent', () => {
    const fixture = createFixture('KANENGO');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    setUpNetwork('LILONGWE NETWORK', ['KANENGO'], [KANENGO, OCEAN, MASM_LL]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
    confirmCoverage(fixture, [KANENGO, OCEAN, MASM_LL], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');
    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('absent');
  });

  // 9. Overnight shifts.
  it('item 9: an overnight (Night) shift resolves correctly through the network, crossing midnight, check-in and checkout at different network doors', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'night', '2026-11-01', NULL)`);
    setUpNetwork('LILONGWE NETWORK', ['AREA 12'], [KANENGO, OCEAN, MASM_LL]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
    insertRawEvent(fixture.tenantId, fixture.batchId, fixture.personNo, '2026-11-16T14:05:00Z', KANENGO); // 16:05 Blantyre check-in
    insertRawEvent(fixture.tenantId, fixture.batchId, fixture.personNo, '2026-11-17T05:00:00Z', OCEAN); // 07:00 Blantyre next-day checkout
    confirmCoverage(fixture, [KANENGO, OCEAN, MASM_LL], '2026-11-16T10:00:00Z', '2026-11-17T06:30:00Z', '2026-11-17T05:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(['present', 'late']).toContain(result.status);
    expect(result.basis).toBe('confirmed');
  });

  // 10. Off-days.
  it('item 10: a scheduled Off day short-circuits before any network/coverage logic runs at all', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], 0, NULL, '2026-11-01', NULL)`); // Sunday off
    setUpNetwork('LILONGWE NETWORK', ['AREA 12'], [KANENGO, OCEAN, MASM_LL]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
    confirmCoverage(fixture, [KANENGO, OCEAN, MASM_LL], '2026-11-01T00:00:00Z', '2026-11-30T23:59:00Z', '2026-11-20T00:00:00Z');

    const result = resolveAndCalculate(fixture.employeeId, '2026-11-15'); // a Sunday
    expect(result.status).toBe('off');
  });

  // 11. Employee moving workstations.
  it('item 11: an employee moved from one network site to another (same network) keeps the same eligible terminal set with no admin action', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    setUpNetwork('LILONGWE NETWORK', ['AREA 12', 'KANENGO'], [KANENGO, OCEAN, MASM_LL]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);

    const [eligibleBefore] = queryRow(`SELECT array_agg(access_point ORDER BY access_point) FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
    exec(`UPDATE employees SET workstation = 'KANENGO' WHERE id = '${fixture.employeeId}'::uuid`);
    const [eligibleAfter] = queryRow(`SELECT array_agg(access_point ORDER BY access_point) FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
    expect(eligibleAfter).toBe(eligibleBefore);

    // Moving OUT of the network (to an unconfigured site) correctly loses network eligibility.
    exec(`UPDATE employees SET workstation = 'SOME OTHER UNCONFIGURED SITE' WHERE id = '${fixture.employeeId}'::uuid`);
    const [eligibleCountAfterLeaving] = queryRow(`SELECT count(*) FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
    expect(eligibleCountAfterLeaving).toBe('0');
  });

  // 12. Wrong network/region isolation.
  it('item 12: a DIFFERENT network with the SAME site name string, in a different tenant, never leaks its terminal configuration across the boundary; a site joined to Network X never picks up Network Y\'s terminals', () => {
    const fixtureA = createFixture('SHARED NAME SITE');
    setUpNetwork('NETWORK ONE', ['SHARED NAME SITE'], [KANENGO, OCEAN]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixtureA.employeeId}']::uuid[], true)`);

    const fixtureB = createFixture('SHARED NAME SITE');
    setUpNetwork('NETWORK ONE', ['SHARED NAME SITE'], [MASM_LL]); // tenant B deliberately configures a DIFFERENT terminal for the SAME network name
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixtureB.employeeId}']::uuid[], true)`);

    const eligibleA = eligibleAccessPointsSorted(fixtureA.tenantId, fixtureA.employeeId);
    const eligibleB = eligibleAccessPointsSorted(fixtureB.tenantId, fixtureB.employeeId);
    expect(eligibleA).toBe([KANENGO, OCEAN].sort().join('|'));
    expect(eligibleB).toBe(MASM_LL);

    // Within tenant A's own data: a second network ("NETWORK TWO") with different terminals, and a site that only joined NETWORK ONE, must never pick up NETWORK TWO's doors.
    exec(`SELECT set_caller('${fixtureA.callerId}')`);
    exec(`SELECT set_terminal_network_members('NETWORK TWO', ARRAY['${MASM_LL}'])`);
    const stillEligibleA = eligibleAccessPointsSorted(fixtureA.tenantId, fixtureA.employeeId);
    expect(stillEligibleA).toBe([KANENGO, OCEAN].sort().join('|')); // unaffected by a network it never joined
  });

  // 13. Duplicate imports.
  it('item 13: repeating attendance_process_import_batch with an identical declaration, after the network resolved an Absent, is idempotent -- no duplicate write, no duplicate confirmation', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    setUpNetwork('LILONGWE NETWORK', ['AREA 12'], [KANENGO]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);

    const runBatch = () => queryRow(
      `SELECT r->>'confirmation_id', r->>'applied_count', r->>'unchanged_count' FROM (` +
      `SELECT attendance_process_import_batch('${fixture.batchId}', ARRAY['${KANENGO}'], ` +
      `'2026-11-16T00:00:00Z'::timestamptz, '2026-11-16T23:59:00Z'::timestamptz, '2026-11-16'::date, '2026-11-16'::date, ` +
      `NULL, NULL, 'No scans at all -- site supervisor confirms genuine absence.', true) AS r) t`
    );
    const first = runBatch();
    expect(first[1]).toBe('1');
    expect(attendanceRow(fixture.employeeId, '2026-11-16').status).toBe('A');

    const second = runBatch();
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe('0');
    expect(second[2]).toBe('1');

    const [confirmationCount] = queryRow(`SELECT count(*) FROM fingerprint_coverage_confirmations WHERE tenant_id = '${fixture.tenantId}'::uuid`);
    expect(confirmationCount).toBe('1');
  });

  // 14. Protected manual corrections.
  it('item 14: an existing manual correction is never overwritten by automatic network-based processing', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    setUpNetwork('LILONGWE NETWORK', ['AREA 12'], [KANENGO]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
    exec(`SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-16'::date, 'P', 'Manager confirms present despite no scan recorded.')`);
    confirmCoverage(fixture, [KANENGO], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');

    const [outcome] = queryRow(`SELECT outcome FROM attendance_apply_automatic(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-16'::date, '2026-11-16'::date)`);
    expect(outcome).toBe('skipped_manual_protected');
    expect(attendanceRow(fixture.employeeId, '2026-11-16')).toEqual({ status: 'P', source: 'manual' });
  });

  // 15. Approved payroll.
  it('item 15: approved payroll for the month blocks the network\'s automatic write just as it already blocks individually-assigned and site-shared employees', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`INSERT INTO payroll (tenant_id, employee_id, month, approval_status) VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '2026-11', 'approved')`);
    setUpNetwork('LILONGWE NETWORK', ['AREA 12'], [KANENGO]);
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
    confirmCoverage(fixture, [KANENGO], '2026-11-05T00:00:00Z', '2026-11-05T23:59:00Z', '2026-11-05T19:00:00Z');

    const [outcome, , , payrollFlag] = queryRow(`SELECT outcome, old_status, new_status, payroll_flag FROM attendance_apply_automatic(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-05'::date, '2026-11-05'::date)`);
    expect(outcome).toBe('skipped_payroll_approved');
    expect(payrollFlag).toBe('approved');
    expect(attendanceRow(fixture.employeeId, '2026-11-05').status).toBeNull();
  });

  // 16. Legacy individual assignments.
  it('item 16: an employee with a pre-existing individual terminal assignment is completely unaffected by joining their site to a network, in either direction', () => {
    const fixture = createFixture('AREA 12');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT set_employee_hikcentral_terminals('${fixture.employeeId}', ARRAY['LEGACY-OWN-DOOR'])`);
    setUpNetwork('LILONGWE NETWORK', ['AREA 12'], [KANENGO, OCEAN, MASM_LL]);
    // fingerprint_attendance_enabled is irrelevant here either way -- an individual assignment always wins, never gated by it.
    confirmCoverage(fixture, ['LEGACY-OWN-DOOR'], '2026-11-16T00:00:00Z', '2026-11-16T23:59:00Z', '2026-11-16T19:00:00Z');

    const [eligible] = queryRow(`SELECT array_agg(access_point) FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
    expect(eligible).toBe('{LEGACY-OWN-DOOR}'); // never the network's doors
    const result = resolveAndCalculate(fixture.employeeId, '2026-11-16');
    expect(result.status).toBe('absent'); // own assignment alone is sufficient, exactly as before this migration
  });

  // 17. Coverage proof and audit accountability.
  describe('item 17: coverage proof and audit accountability for the new network RPCs', () => {
    it('set_terminal_network_members audits every real add/remove, never a no-op repeat', () => {
      const fixture = createFixture('AUDIT NETWORK SITE');
      const [before] = queryRow(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${fixture.tenantId}'::uuid`);
      expect(before).toBe('0');

      exec(`SELECT set_terminal_network_members('AUDIT NETWORK', ARRAY['${KANENGO}', '${OCEAN}'])`);
      const [afterAdd] = queryRow(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${fixture.tenantId}'::uuid AND action = 'ADD_TERMINAL_NETWORK_MEMBER'`);
      expect(afterAdd).toBe('2');

      // Repeating the identical desired set is a genuine no-op -- no new audit rows.
      exec(`SELECT set_terminal_network_members('AUDIT NETWORK', ARRAY['${KANENGO}', '${OCEAN}'])`);
      const [afterRepeat] = queryRow(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${fixture.tenantId}'::uuid`);
      expect(afterRepeat).toBe('2');

      // Removing one door is audited as a revoke.
      exec(`SELECT set_terminal_network_members('AUDIT NETWORK', ARRAY['${KANENGO}'])`);
      const [afterRemove] = queryRow(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${fixture.tenantId}'::uuid AND action = 'REVOKE_TERMINAL_NETWORK_MEMBER'`);
      expect(afterRemove).toBe('1');
    });

    it('set_site_network_membership audits a genuine reassignment per site, never a no-op, and requires authentication', () => {
      const fixture = createFixture('AUDIT MEMBERSHIP SITE');
      exec(`SELECT set_site_network_membership(ARRAY['AUDIT MEMBERSHIP SITE'], 'NETWORK A')`);
      const [[, actionA]] = queryRows(`SELECT entity_id, action FROM audit_logs WHERE tenant_id = '${fixture.tenantId}'::uuid AND entity_id = 'AUDIT MEMBERSHIP SITE'`);
      expect(actionA).toBe('SET_SITE_NETWORK_MEMBERSHIP');

      // Repeating the SAME assignment is a no-op -- no second row.
      exec(`SELECT set_site_network_membership(ARRAY['AUDIT MEMBERSHIP SITE'], 'NETWORK A')`);
      const [countAfterRepeat] = queryRow(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${fixture.tenantId}'::uuid AND entity_id = 'AUDIT MEMBERSHIP SITE'`);
      expect(countAfterRepeat).toBe('1');

      // Reassigning to a different network IS audited again, carrying the old network for traceability.
      exec(`SELECT set_site_network_membership(ARRAY['AUDIT MEMBERSHIP SITE'], 'NETWORK B')`);
      const [countAfterReassign] = queryRow(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${fixture.tenantId}'::uuid AND entity_id = 'AUDIT MEMBERSHIP SITE'`);
      expect(countAfterReassign).toBe('2');
      const [oldNetwork] = queryRow(`SELECT old_data->>'network' FROM audit_logs WHERE tenant_id = '${fixture.tenantId}'::uuid AND entity_id = 'AUDIT MEMBERSHIP SITE' AND action = 'SET_SITE_NETWORK_MEMBERSHIP' ORDER BY new_data->>'network' DESC LIMIT 1`);
      expect(oldNetwork).toBe('NETWORK A');

      exec(`SELECT set_caller(NULL)`);
      const stderrNetwork = execExpectError(`SELECT set_terminal_network_members('SHOULD-FAIL-NETWORK', ARRAY['SHOULD-FAIL-DOOR'])`);
      expect(stderrNetwork).toMatch(/not authenticated/i);
      const stderrSite = execExpectError(`SELECT set_site_network_membership(ARRAY['SHOULD-FAIL-SITE'], 'SHOULD-FAIL-NETWORK')`);
      expect(stderrSite).toMatch(/not authenticated/i);
    });
  });

  // 18. Zero historical attendance mutations during rollout.
  it('item 18: creating a network, joining sites to it, and registering terminals never themselves write, change, or recalculate any existing attendance row', () => {
    const fixture = createFixture('ROLLOUT SAFETY SITE');
    exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
    exec(`SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-01'::date, 'A', 'Pre-existing historical record, predates this release.')`);

    const [beforeCount] = queryRow(`SELECT count(*) FROM attendance WHERE tenant_id = '${fixture.tenantId}'::uuid`);
    const beforeRow = attendanceRow(fixture.employeeId, '2026-11-01');

    setUpNetwork('LILONGWE NETWORK', ['ROLLOUT SAFETY SITE'], [KANENGO, OCEAN, MASM_LL]);
    // Simulates a pre-existing, PR #80-backfilled mapping (conservatively disabled) -- this employee stays exactly as they were.
    exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], false)`);

    const [afterCount] = queryRow(`SELECT count(*) FROM attendance WHERE tenant_id = '${fixture.tenantId}'::uuid`);
    const afterRow = attendanceRow(fixture.employeeId, '2026-11-01');
    expect(afterCount).toBe(beforeCount);
    expect(afterRow).toEqual(beforeRow);
    expect(afterRow).toEqual({ status: 'A', source: 'manual' });

    // The employee's resolved eligibility is unaffected by the network's mere existence (not yet enabled).
    const [eligibleCount] = queryRow(`SELECT count(*) FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
    expect(eligibleCount).toBe('0');
  });

  // PR #81 FINAL NETWORK RESOLUTION CORRECTION -- precedence must be
  // individual assignment > explicit active network membership (when
  // enabled and the network has terminals) > legacy direct site
  // fallback > nothing. A site that already had a seeded direct
  // configuration (the AHL KANENGO scenario) must actually switch to
  // the network once explicitly joined to one.
  describe('corrected precedence: network membership wins over a legacy direct site configuration', () => {
    it('AHL KANENGO: an old direct site configuration is superseded the moment the site explicitly joins a network with real terminals', () => {
      const fixture = createFixture('AHL KANENGO');
      // The legacy, PR #80-era direct configuration -- e.g. seeded from historical employee_hikcentral_terminals data.
      exec(`SELECT set_site_hikcentral_terminals('AHL KANENGO', ARRAY['LEGACY-DIRECT-DOOR'])`);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);

      const beforeNetwork = eligibleAccessPointsSorted(fixture.tenantId, fixture.employeeId);
      expect(beforeNetwork).toBe('LEGACY-DIRECT-DOOR');
      const [beforeProvenance] = queryRow(`SELECT DISTINCT provenance FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
      expect(beforeProvenance).toBe('site_shared');

      // Administrator explicitly joins AHL KANENGO to the Lilongwe network.
      setUpNetwork('LILONGWE NETWORK', ['AHL KANENGO'], [KANENGO, OCEAN, MASM_LL]);

      const afterNetwork = eligibleAccessPointsSorted(fixture.tenantId, fixture.employeeId);
      expect(afterNetwork).toBe([KANENGO, OCEAN, MASM_LL].sort().join('|'));
      const [afterProvenance] = queryRow(`SELECT DISTINCT provenance FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
      expect(afterProvenance).toBe('network_shared');
    });

    it('an existing individual terminal assignment is unaffected by ANY network, even AHL KANENGO joining one', () => {
      const fixture = createFixture('AHL KANENGO');
      exec(`SELECT set_employee_hikcentral_terminals('${fixture.employeeId}', ARRAY['LEGACY-OWN-DOOR'])`);
      setUpNetwork('LILONGWE NETWORK', ['AHL KANENGO'], [KANENGO, OCEAN, MASM_LL]);
      // Deliberately not enabled -- own assignment must never need it.

      const [provenance] = queryRow(`SELECT DISTINCT provenance FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
      expect(provenance).toBe('employee_assigned');
      const eligible = eligibleAccessPointsSorted(fixture.tenantId, fixture.employeeId);
      expect(eligible).toBe('LEGACY-OWN-DOOR');
    });

    it('a Southern-region (Blantyre-style) employee whose site has no network membership at all keeps resolving via its own direct site configuration, completely unaffected by the Lilongwe network existing elsewhere', () => {
      const fixture = createFixture('MTL CHICHIRI');
      exec(`SELECT set_site_hikcentral_terminals('MTL CHICHIRI', ARRAY['MTL - CHICHIRI_Door_1'])`);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
      // A Lilongwe network exists in the SAME tenant, but this site never joined it.
      exec(`SELECT set_terminal_network_members('LILONGWE NETWORK', ARRAY['${KANENGO}'])`);

      const [provenance] = queryRow(`SELECT DISTINCT provenance FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
      expect(provenance).toBe('site_shared');
      const eligible = eligibleAccessPointsSorted(fixture.tenantId, fixture.employeeId);
      expect(eligible).toBe('MTL - CHICHIRI_Door_1');
    });

    it('fingerprint_attendance_enabled=false blocks BOTH the network and the legacy direct site fallback -- the disabled employee resolves nothing at all', () => {
      const fixture = createFixture('AHL KANENGO');
      exec(`SELECT set_site_hikcentral_terminals('AHL KANENGO', ARRAY['LEGACY-DIRECT-DOOR'])`);
      setUpNetwork('LILONGWE NETWORK', ['AHL KANENGO'], [KANENGO, OCEAN, MASM_LL]);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], false)`);

      const [eligibleCount] = queryRow(`SELECT count(*) FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
      expect(eligibleCount).toBe('0');
    });

    it('a network with an empty terminal list is treated as not yet real -- the site falls through to its legacy direct configuration instead of resolving nothing', () => {
      const fixture = createFixture('AHL KANENGO');
      exec(`SELECT set_site_hikcentral_terminals('AHL KANENGO', ARRAY['LEGACY-DIRECT-DOOR'])`);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
      // The site joins a network, but nobody has registered any terminal for it yet.
      exec(`SELECT set_site_network_membership(ARRAY['AHL KANENGO'], 'LILONGWE NETWORK')`);

      const [provenance] = queryRow(`SELECT DISTINCT provenance FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
      expect(provenance).toBe('site_shared');
      const eligible = eligibleAccessPointsSorted(fixture.tenantId, fixture.employeeId);
      expect(eligible).toBe('LEGACY-DIRECT-DOOR');

      // Once the network actually gets a terminal, it immediately takes over.
      exec(`SELECT set_terminal_network_members('LILONGWE NETWORK', ARRAY['${KANENGO}'])`);
      const [provenanceAfter] = queryRow(`SELECT DISTINCT provenance FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
      expect(provenanceAfter).toBe('network_shared');
    });

    it('removing a site from its network reverts it to the legacy direct configuration, with no admin action on the employee itself', () => {
      const fixture = createFixture('AHL KANENGO');
      exec(`SELECT set_site_hikcentral_terminals('AHL KANENGO', ARRAY['LEGACY-DIRECT-DOOR'])`);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], true)`);
      setUpNetwork('LILONGWE NETWORK', ['AHL KANENGO'], [KANENGO]);

      const [provenanceJoined] = queryRow(`SELECT DISTINCT provenance FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
      expect(provenanceJoined).toBe('network_shared');

      exec(`SELECT set_site_network_membership(ARRAY['AHL KANENGO'], NULL)`);
      const [provenanceAfterRemoval] = queryRow(`SELECT DISTINCT provenance FROM attendance_employee_eligible_terminals('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid)`);
      expect(provenanceAfterRemoval).toBe('site_shared');
      const eligible = eligibleAccessPointsSorted(fixture.tenantId, fixture.employeeId);
      expect(eligible).toBe('LEGACY-DIRECT-DOOR');
    });

    it('tenant isolation: tenant B\'s AHL KANENGO network membership never affects tenant A\'s own AHL KANENGO direct configuration', () => {
      const fixtureA = createFixture('AHL KANENGO');
      exec(`SELECT set_site_hikcentral_terminals('AHL KANENGO', ARRAY['TENANT-A-LEGACY-DOOR'])`);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixtureA.employeeId}']::uuid[], true)`);

      const fixtureB = createFixture('AHL KANENGO'); // switches active caller to tenant B
      setUpNetwork('LILONGWE NETWORK', ['AHL KANENGO'], [KANENGO, OCEAN, MASM_LL]);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixtureB.employeeId}']::uuid[], true)`);

      const eligibleB = eligibleAccessPointsSorted(fixtureB.tenantId, fixtureB.employeeId);
      expect(eligibleB).toBe([KANENGO, OCEAN, MASM_LL].sort().join('|'));

      // Tenant A's own site never joined any network -- still resolves its own legacy direct configuration, unaffected by tenant B's network.
      const eligibleA = eligibleAccessPointsSorted(fixtureA.tenantId, fixtureA.employeeId);
      expect(eligibleA).toBe('TENANT-A-LEGACY-DOOR');
      const [provenanceA] = queryRow(`SELECT DISTINCT provenance FROM attendance_employee_eligible_terminals('${fixtureA.tenantId}'::uuid, '${fixtureA.employeeId}'::uuid)`);
      expect(provenanceA).toBe('site_shared');
    });

    it('none of this precedence correction\'s own write paths (set_site_hikcentral_terminals, set_terminal_network_members, set_site_network_membership) ever write, change, or recalculate any existing attendance row', () => {
      const fixture = createFixture('AHL KANENGO');
      exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, 'day', '2026-11-01', NULL)`);
      exec(`SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-01'::date, 'A', 'Pre-existing historical record, predates this correction.')`);
      const [beforeCount] = queryRow(`SELECT count(*) FROM attendance WHERE tenant_id = '${fixture.tenantId}'::uuid`);
      const beforeRow = attendanceRow(fixture.employeeId, '2026-11-01');

      exec(`SELECT set_site_hikcentral_terminals('AHL KANENGO', ARRAY['LEGACY-DIRECT-DOOR'])`);
      setUpNetwork('LILONGWE NETWORK', ['AHL KANENGO'], [KANENGO, OCEAN, MASM_LL]);
      exec(`SELECT set_site_network_membership(ARRAY['AHL KANENGO'], NULL)`);

      const [afterCount] = queryRow(`SELECT count(*) FROM attendance WHERE tenant_id = '${fixture.tenantId}'::uuid`);
      const afterRow = attendanceRow(fixture.employeeId, '2026-11-01');
      expect(afterCount).toBe(beforeCount);
      expect(afterRow).toEqual(beforeRow);
      expect(afterRow).toEqual({ status: 'A', source: 'manual' });
    });
  });

  // PR #81 FINAL NETWORK RESOLUTION CORRECTION -- status accuracy:
  // hikcentral_mapped_employees_terminal_status must distinguish
  // network_shared from a plain direct site_shared configuration.
  describe('hikcentral_mapped_employees_terminal_status distinguishes network_shared from site_shared', () => {
    it('reports "network_shared" for an employee resolved via a network, and "site_shared" for one resolved via a plain direct site configuration', () => {
      const fixtureNetwork = createFixture('AHL KANENGO');
      setUpNetwork('LILONGWE NETWORK', ['AHL KANENGO'], [KANENGO, OCEAN]);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixtureNetwork.employeeId}']::uuid[], true)`);

      const fixtureSite = createFixture('MTL CHICHIRI');
      exec(`SELECT set_site_hikcentral_terminals('MTL CHICHIRI', ARRAY['MTL - CHICHIRI_Door_1'])`);
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixtureSite.employeeId}']::uuid[], true)`);

      exec(`SELECT set_caller('${fixtureNetwork.callerId}')`);
      const [[, provenanceNetwork]] = queryRows(`SELECT employee_id, provenance FROM hikcentral_mapped_employees_terminal_status() WHERE employee_id = '${fixtureNetwork.employeeId}'::uuid`);
      expect(provenanceNetwork).toBe('network_shared');

      exec(`SELECT set_caller('${fixtureSite.callerId}')`);
      const [[, provenanceSite]] = queryRows(`SELECT employee_id, provenance FROM hikcentral_mapped_employees_terminal_status() WHERE employee_id = '${fixtureSite.employeeId}'::uuid`);
      expect(provenanceSite).toBe('site_shared');
    });

    it('reports "fingerprint_not_enabled" (not a plain "unconfigured" gap) for a mapped employee whose site joined a real network but who has not been explicitly enabled yet', () => {
      const fixture = createFixture('AHL KANENGO');
      setUpNetwork('LILONGWE NETWORK', ['AHL KANENGO'], [KANENGO, OCEAN]);
      // Simulates a pre-existing, PR #80-backfilled mapping (conservatively disabled).
      exec(`SELECT set_fingerprint_attendance_enabled(ARRAY['${fixture.employeeId}']::uuid[], false)`);

      const [[, provenance]] = queryRows(`SELECT employee_id, provenance FROM hikcentral_mapped_employees_terminal_status() WHERE employee_id = '${fixture.employeeId}'::uuid`);
      expect(provenance).toBe('fingerprint_not_enabled');
    });
  });
});
