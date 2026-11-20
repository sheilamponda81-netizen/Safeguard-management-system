// Attendance coverage-consistency improvement: real SQL integration
// coverage for attendance_coverage_explain
// (20261120020000_attendance_coverage_explain.sql), the new read-only
// RPC the Main Attendance Review and Stage C's JS preview now consult
// instead of a session-local, operator-typed coverage claim. Same
// disposable-Postgres convention as every other attendance-engine
// integration test in this directory -- never connects to production.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';

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

// Tab-separated, not comma -- this function's own reason text contains
// commas (same pitfall attendanceCorrectMandatoryReason.test.ts already
// solved the same way).
function queryRow(sql: string): string[] {
  const out = execFileSync('psql', ['-t', '-A', '-F', '\t', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split('\t') : [];
}

function expectRpcError(sql: string, matchMessage: string): void {
  try {
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] });
    throw new Error(`Expected this call to raise an error containing "${matchMessage}", but it succeeded: ${sql}`);
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    expect(stderr).toContain(matchMessage);
  }
}

interface Fixture { tenantId: string; callerId: string; employeeId: string; personNo: string }

/** Same fixture shape/convention as monthEndAttendanceProtection.test.ts and attendancePipelineIntegration.test.ts. */
function createFixture(site = 'COVERAGE SITE'): Fixture {
  const tenantId = randomUUID();
  const callerId = randomUUID();
  const employeeId = randomUUID();
  const personNo = `P${randomUUID().slice(0, 8)}`;
  exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', 'Integration Test Tenant', 'ITT-${tenantId.slice(0, 8)}')`);
  exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
  exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active) VALUES ('${callerId}', '${tenantId}', true, true)`);
  exec(`SELECT set_caller('${callerId}')`);
  exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${employeeId}', '${tenantId}', 'E-${employeeId.slice(0, 8)}', 'Integration Test Employee', 'Active', false, '${site}')`);
  exec(`INSERT INTO hikcentral_person_mappings (tenant_id, hikcentral_person_no, employee_id, match_method, is_active) VALUES ('${tenantId}', '${personNo}', '${employeeId}', 'manual', true)`);
  return { tenantId, callerId, employeeId, personNo };
}

function assignTerminal(fixture: Fixture, accessPoint: string): void {
  exec(`SELECT set_employee_hikcentral_terminals('${fixture.employeeId}', ARRAY['${accessPoint}'])`);
}

function assignRecurringDay(fixture: Fixture, shiftType: 'day' | 'night', effectiveFrom = '2026-10-25'): void {
  exec(`SELECT roster_assign_recurring_pattern(ARRAY['${fixture.employeeId}']::uuid[], NULL, '${shiftType}', '${effectiveFrom}', NULL)`);
}

/** Direct INSERT (never through attendance_process_import_batch), matching this repo's own established fixture convention for this table -- INSERT is not restricted by the append-only guard, only UPDATE is. */
function insertConfirmation(
  fixture: Fixture,
  accessPoints: string[],
  coversFrom: string,
  coversThrough: string,
  evidence: { latestObservedEventAt?: string; exceedsObservedEvidence?: boolean; independentlyVerified?: boolean; overrideReason?: string } = {}
): void {
  const points = `ARRAY[${accessPoints.map((p) => `'${p}'`).join(',')}]::TEXT[]`;
  const latest = evidence.latestObservedEventAt ? `'${evidence.latestObservedEventAt}'` : 'NULL';
  const exceeds = evidence.exceedsObservedEvidence ? 'true' : 'false';
  const verified = evidence.independentlyVerified ? 'true' : 'false';
  const reason = evidence.overrideReason ? `'${evidence.overrideReason}'` : 'NULL';
  exec(
    `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through, latest_observed_event_at, exceeds_observed_evidence, override_reason, independently_verified) ` +
    `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY[]::TEXT[], ${points}, '${coversFrom}', '${coversThrough}', ${latest}, ${exceeds}, ${reason}, ${verified})`
  );
}

function explain(fixture: Fixture, date: string): { resolvedShift: string; terminals: string; checkoutCovered: string; provenance: string; sufficient: string; officialTrusts: string; reason: string } {
  const [resolvedShift, terminals, , checkoutCovered, provenance, sufficient, officialTrusts, , reason] = queryRow(
    `SELECT resolved_shift, assigned_terminal_count, checkout_window_end, checkout_window_covered, coverage_provenance, sufficient_evidence, official_engine_trusts_this, confirmed_through, reason ` +
    `FROM attendance_coverage_explain(ARRAY['${fixture.employeeId}']::uuid[], '${date}'::date, '${date}'::date)`
  );
  return { resolvedShift, terminals, checkoutCovered, provenance, sufficient, officialTrusts, reason };
}

describe.skipIf(!dbAvailable && !dbRequired)('attendance_coverage_explain (real SQL function, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error('ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable -- this suite must run for real in CI, never silently skip.');
      }
      console.warn('attendanceCoverageExplain.test.ts: no reachable Postgres -- skipping.');
    }
  });

  // Scenarios 1, 4, 5: evidence-backed, confirmed-complete coverage is
  // classified sufficient regardless of the actual scan pattern
  // underneath it (check-in+checkout present, checkout-only, or no
  // scans at all) -- this RPC explains COVERAGE, never events, so its
  // classification must never depend on what scans exist.
  it('evidence-backed confirmed coverage is sufficient regardless of scan pattern (confirmed-complete coverage, independent of check-in/checkout)', () => {
    const fixture = createFixture();
    assignTerminal(fixture, 'GATE1');
    assignRecurringDay(fixture, 'day');
    insertConfirmation(fixture, ['GATE1'], '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z', { latestObservedEventAt: '2026-11-03T17:50:00Z' });

    const result = explain(fixture, '2026-11-03');
    expect(result.resolvedShift).toBe('day');
    expect(result.checkoutCovered).toBe('t');
    expect(result.provenance).toBe('evidence_backed');
    expect(result.sufficient).toBe('t');
    expect(result.officialTrusts).toBe('t');
  });

  // Scenarios 2, 3: no coverage confirmation recorded at all --
  // insufficient regardless of whether a check-in-only or checkout-only
  // scan exists (this RPC's classification depends only on whether a
  // confirmation exists for the full checkout window, never on events).
  it('no coverage confirmation at all is insufficient (covers scenarios with check-in-only or checkout-only scans underneath, since this RPC never reads events)', () => {
    const fixture = createFixture();
    assignTerminal(fixture, 'GATE1');
    assignRecurringDay(fixture, 'day');
    // Deliberately no fingerprint_coverage_confirmations row at all.

    const result = explain(fixture, '2026-11-03');
    expect(result.checkoutCovered).toBe('f');
    expect(result.provenance).toBe('no_coverage');
    expect(result.sufficient).toBe('f');
    expect(result.officialTrusts).toBe('f');
    expect(result.reason).toContain('never a false Absent');
  });

  // Scenario 6: an early export's declared covers_through ends BEFORE
  // this shift's checkout window closes -- the window-containment
  // filter never matches it, so it is correctly treated exactly like
  // no confirmation at all, never silently truncated/rounded up.
  it('an early export that ends before the checkout window closes cannot prove completeness -- treated as no coverage, never Absent', () => {
    const fixture = createFixture();
    assignTerminal(fixture, 'GATE1');
    assignRecurringDay(fixture, 'day');
    // Day shift on 2026-11-03: checkout window ends 2026-11-03T18:00:00Z.
    // This export was generated mid-morning -- long before that.
    insertConfirmation(fixture, ['GATE1'], '2026-11-03T00:00:00Z', '2026-11-03T09:00:00Z', { latestObservedEventAt: '2026-11-03T08:50:00Z' });

    const result = explain(fixture, '2026-11-03');
    expect(result.checkoutCovered).toBe('f');
    expect(result.provenance).toBe('no_coverage');
    expect(result.sufficient).toBe('f');
  });

  // Scenario 7, and the central coverage-trust finding of this PR: a
  // confirmation shaped exactly like every one of the 8 currently in
  // production (never evidence-checked at all -- latest_observed_event_at
  // NULL, exceeds_observed_evidence false by default) is accepted by the
  // UNMODIFIED official engine's own existence+containment check
  // (official_engine_trusts_this = true) but this RPC deliberately does
  // NOT let the client reproduce that -- it reports insufficient evidence
  // instead, exactly the divergence this whole PR exists to explain.
  it('an unsupported historical declaration (the exact shape of every confirmation currently in production) is insufficient here, even though the official engine still currently accepts it as-is', () => {
    const fixture = createFixture();
    assignTerminal(fixture, 'GATE1');
    assignRecurringDay(fixture, 'day');
    insertConfirmation(fixture, ['GATE1'], '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z'); // no evidence fields at all -- defaults match production exactly

    const result = explain(fixture, '2026-11-03');
    expect(result.checkoutCovered).toBe('t'); // the official engine's own EXISTS check is satisfied
    expect(result.provenance).toBe('unsupported_historical');
    expect(result.sufficient).toBe('f'); // but this RPC does not trust it
    expect(result.officialTrusts).toBe('t'); // ...while reporting plainly that the official engine currently still would
    expect(result.reason).toContain("automatic engine currently still accepts it as-is");
  });

  // An independently-verified override (a genuine administrator
  // attestation, not merely a typed reason) IS trusted -- the one way
  // coverage exceeding observed evidence can still become sufficient.
  it('an independently-verified override is trusted as sufficient evidence', () => {
    const fixture = createFixture();
    assignTerminal(fixture, 'GATE1');
    assignRecurringDay(fixture, 'day');
    insertConfirmation(fixture, ['GATE1'], '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z', {
      latestObservedEventAt: '2026-11-03T09:00:00Z',
      exceedsObservedEvidence: true,
      independentlyVerified: true,
      overrideReason: 'Site supervisor personally confirmed the export was complete despite the scanner going offline early.',
    });

    const result = explain(fixture, '2026-11-03');
    expect(result.provenance).toBe('independently_verified_override');
    expect(result.sufficient).toBe('t');
  });

  // Scenario 8: recurring Day vs Night both resolve correctly via the
  // same real roster_resolve_schedule() the official engine uses.
  it('recurring Day and Night shifts both resolve the correct shift type', () => {
    const dayFixture = createFixture('DAY SITE');
    assignRecurringDay(dayFixture, 'day');
    const dayResult = explain(dayFixture, '2026-11-03');
    expect(dayResult.resolvedShift).toBe('day');

    const nightFixture = createFixture('NIGHT SITE');
    assignRecurringDay(nightFixture, 'night');
    const nightResult = explain(nightFixture, '2026-11-03');
    expect(nightResult.resolvedShift).toBe('night');
  });

  // Scenario 9: a Night shift's checkout window genuinely crosses
  // midnight onto the NEXT calendar date -- a confirmation that only
  // covers through the shift's own starting date (never reaching the
  // following morning) must NOT be accepted as covering it.
  it('an overnight Night shift requires coverage reaching the following morning, not just through midnight', () => {
    const fixture = createFixture();
    assignTerminal(fixture, 'GATE1');
    assignRecurringDay(fixture, 'night');
    // Night shift on 2026-11-03: checkout window ends 2026-11-04T06:00:00Z.
    // This confirmation stops at midnight -- short of the real checkout window.
    insertConfirmation(fixture, ['GATE1'], '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z', { latestObservedEventAt: '2026-11-03T16:00:00Z' });
    const shortResult = explain(fixture, '2026-11-03');
    expect(shortResult.checkoutCovered).toBe('f');
    expect(shortResult.provenance).toBe('no_coverage');

    // A confirmation that genuinely reaches the next morning's checkout window IS accepted.
    insertConfirmation(fixture, ['GATE1'], '2026-11-03T00:00:00Z', '2026-11-04T07:00:00Z', { latestObservedEventAt: '2026-11-04T06:30:00Z' });
    const fullResult = explain(fixture, '2026-11-03');
    expect(fullResult.checkoutCovered).toBe('t');
    expect(fullResult.provenance).toBe('evidence_backed');
  });

  // Scenario 10: an employee assigned to MULTIPLE terminals needs EVERY
  // one of them covered -- one covered and one not is still insufficient,
  // exactly like attendance_resolve_and_calculate's own bool_and() check.
  it('an employee assigned to multiple terminals requires ALL of them covered, not merely one', () => {
    const fixture = createFixture();
    assignTerminal(fixture, 'GATE1'); // set_employee_hikcentral_terminals replaces the whole set
    exec(`SELECT set_employee_hikcentral_terminals('${fixture.employeeId}', ARRAY['GATE1', 'GATE2'])`);
    assignRecurringDay(fixture, 'day');
    insertConfirmation(fixture, ['GATE1'], '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z', { latestObservedEventAt: '2026-11-03T17:00:00Z' });
    // GATE2 has no confirmation at all.

    const result = explain(fixture, '2026-11-03');
    expect(result.terminals).toBe('2');
    expect(result.checkoutCovered).toBe('f');
    expect(result.provenance).toBe('no_coverage');
    expect(result.sufficient).toBe('f');
  });

  // Scenario 11: missing or ambiguous terminal mapping -- two distinct
  // gaps, each with its own distinct, non-misleading explanation.
  it('a mapped employee with zero assigned terminals is distinguished from one with no active mapping at all', () => {
    const noTerminalFixture = createFixture('NO TERMINAL SITE');
    assignRecurringDay(noTerminalFixture, 'day');
    // Mapped (createFixture always inserts an active mapping), but no terminal assigned at all.
    const noTerminalResult = explain(noTerminalFixture, '2026-11-03');
    expect(noTerminalResult.provenance).toBe('no_assigned_terminal');
    expect(noTerminalResult.sufficient).toBe('f');

    const noMappingFixture = createFixture('NO MAPPING SITE');
    exec(`UPDATE hikcentral_person_mappings SET is_active = false WHERE employee_id = '${noMappingFixture.employeeId}'`);
    assignTerminal(noMappingFixture, 'GATE1'); // a terminal row left over despite the mapping being deactivated
    assignRecurringDay(noMappingFixture, 'day');
    const noMappingResult = explain(noMappingFixture, '2026-11-03');
    expect(noMappingResult.provenance).toBe('no_active_mapping');
    expect(noMappingResult.sufficient).toBe('f');
    expect(noMappingResult.terminals).toBe('0'); // never reports a terminal count that could imply coverage was even checked
  });

  // Scenarios 12, 13: this RPC is purely explanatory -- it must never be
  // able to touch official attendance or payroll, so manual-correction
  // and approved-payroll protection are structurally impossible for it
  // to affect. Confirmed both by the migration's own SQL text (it never
  // references those tables or any write statement) and by running it
  // alongside the real, unmodified protections and observing them
  // completely unaffected.
  it('never references the attendance or payroll tables, and performs no write of any kind -- structurally cannot affect manual-correction or approved-payroll protection', () => {
    const migrationSource = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/20261120020000_attendance_coverage_explain.sql'),
      'utf-8'
    );
    const functionBody = migrationSource.slice(migrationSource.indexOf('AS $$'), migrationSource.lastIndexOf('$$;'));
    expect(functionBody).not.toMatch(/\bFROM\s+attendance\b/i);
    expect(functionBody).not.toMatch(/\bFROM\s+payroll\b/i);
    expect(functionBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
  });

  it('a manual correction and an approved-payroll row for the same employee/date are completely unaffected by calling this RPC', () => {
    const fixture = createFixture();
    assignTerminal(fixture, 'GATE1');
    assignRecurringDay(fixture, 'day');
    exec(`SELECT attendance_correct('${fixture.employeeId}'::uuid, '2026-11-03'::date, 'P', 'Guard confirmed present, verified against site log')`);
    exec(`INSERT INTO payroll (tenant_id, employee_id, month, approval_status) VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '2026-11', 'approved')`);

    explain(fixture, '2026-11-03'); // call the new RPC -- must change nothing below

    const [status, source] = queryRow(`SELECT status, source FROM attendance WHERE employee_id = '${fixture.employeeId}' AND date = '2026-11-03'`);
    expect(status).toBe('P');
    expect(source).toBe('manual');
    const [approvalStatus] = queryRow(`SELECT approval_status FROM payroll WHERE employee_id = '${fixture.employeeId}' AND month = '2026-11'`);
    expect(approvalStatus).toBe('approved');
  });

  // Scenario 14: tenant/region isolation -- a non-super-admin caller
  // cannot explain coverage for an employee outside their own tenant.
  it('rejects a non-super-admin caller attempting to view an employee outside their own tenant', () => {
    const otherTenantFixture = createFixture('OTHER TENANT SITE');
    assignTerminal(otherTenantFixture, 'GATE1');
    assignRecurringDay(otherTenantFixture, 'day');

    const callerTenantId = randomUUID();
    const callerId = randomUUID();
    exec(`INSERT INTO tenants (id, name, code) VALUES ('${callerTenantId}', 'Caller Tenant', 'CT-${callerTenantId.slice(0, 8)}')`);
    exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
    exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, role_level) VALUES ('${callerId}', '${callerTenantId}', false, true, 1)`);
    exec(`INSERT INTO role_permissions (role, permission) SELECT 'manager', 'attendance.map_hikcentral_persons' WHERE NOT EXISTS (SELECT 1 FROM role_permissions WHERE role = 'manager' AND permission = 'attendance.map_hikcentral_persons')`);
    exec(`UPDATE profiles SET role = 'manager' WHERE id = '${callerId}'`);
    exec(`SELECT set_caller('${callerId}')`);

    expectRpcError(
      `SELECT * FROM attendance_coverage_explain(ARRAY['${otherTenantFixture.employeeId}']::uuid[], '2026-11-03'::date, '2026-11-03'::date)`,
      'outside the caller'
    );
  });

  it('rejects a caller with no attendance.map_hikcentral_persons permission and no super-admin flag', () => {
    const fixture = createFixture();
    const tenantId = randomUUID();
    const callerId = randomUUID();
    exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', 'Permission Test Tenant', 'PTT-${tenantId.slice(0, 8)}')`);
    exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
    exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, role_level, role) VALUES ('${callerId}', '${tenantId}', false, true, 99, 'unpermissioned_role_${callerId.slice(0, 8)}')`);
    exec(`SELECT set_caller('${callerId}')`);

    expectRpcError(
      `SELECT * FROM attendance_coverage_explain(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-03'::date, '2026-11-03'::date)`,
      'Not authorized to view attendance coverage evidence'
    );
  });

  it('Off and Unassigned dates are explicitly marked not_applicable, never silently reported as insufficient coverage', () => {
    const fixture = createFixture();
    assignTerminal(fixture, 'GATE1');
    assignRecurringDay(fixture, 'day');
    exec(`INSERT INTO roster_off_day_patterns (tenant_id, employee_id, weekday, effective_from, is_active, assigned_by) VALUES ('${fixture.tenantId}', '${fixture.employeeId}', 1, '2026-10-25', true, '${fixture.callerId}')`); // Monday = 1

    // 2026-11-02 is a Monday.
    const offResult = explain(fixture, '2026-11-02');
    expect(offResult.resolvedShift).toBe('off');
    expect(offResult.provenance).toBe('not_applicable');
    expect(offResult.sufficient).toBe('f');

    const unassignedFixture = createFixture('UNASSIGNED SITE');
    const unassignedResult = explain(unassignedFixture, '2026-11-03'); // no roster evidence configured at all
    expect(unassignedResult.resolvedShift).toBe('unassigned');
    expect(unassignedResult.provenance).toBe('not_applicable');
  });
});
