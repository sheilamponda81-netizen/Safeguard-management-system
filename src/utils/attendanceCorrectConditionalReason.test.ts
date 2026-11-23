// Restore fast manual attendance entry: attendance_correct now requires
// a non-empty reason ONLY when the write would override an existing,
// officially persisted AUTOMATIC decision -- never for a blank/unmarked
// day, and never for an existing MANUAL record, regardless of which
// status it's being changed to. Supersedes
// attendanceCorrectMandatoryReason.test.ts's "always required" rule
// (20261120000000_attendance_correct_mandatory_reason.sql), which this
// migration (20261124000000_attendance_correct_conditional_reason.sql)
// replaces. Same disposable-Postgres convention as every other
// attendance-engine integration test in this directory -- never
// connects to production.
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

// Tab-separated, not comma -- several reasons used below contain commas.
function queryRow(sql: string): string[] {
  const out = execFileSync('psql', ['-t', '-A', '-F', '\t', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split('\t') : [];
}

function queryRows(sql: string): string[][] {
  const out = execFileSync('psql', ['-t', '-A', '-F', '\t', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split('\n').map((line) => line.split('\t')) : [];
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

interface Fixture { tenantId: string; callerId: string; employeeId: string }

function createFixture(): Fixture {
  const tenantId = randomUUID();
  const callerId = randomUUID();
  const employeeId = randomUUID();
  exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', 'Integration Test Tenant', 'ITT-${tenantId.slice(0, 8)}')`);
  exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
  exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active) VALUES ('${callerId}', '${tenantId}', true, true)`);
  exec(`SELECT set_caller('${callerId}')`);
  exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${employeeId}', '${tenantId}', 'E-${employeeId.slice(0, 8)}', 'Integration Test Employee', 'Active', false, 'SITE')`);
  return { tenantId, callerId, employeeId };
}

// Directly seeds an EXISTING attendance row with a given status/source --
// bypassing attendance_correct entirely, exactly as a prior fingerprint
// import (source='automatic') or a prior manual edit (source='manual')
// would have left it, so each test's precondition is unambiguous.
function seedExistingAttendance(fixture: Fixture, date: string, status: string, source: 'manual' | 'automatic'): void {
  exec(
    `INSERT INTO attendance (tenant_id, employee_id, date, status, calculation_basis, source) VALUES ` +
    `('${fixture.tenantId}', '${fixture.employeeId}', '${date}', '${status}', NULL, '${source}')`
  );
}

const REASON_REQUIRED_MESSAGE = 'A reason is required to override an existing automatic attendance decision';

describe.skipIf(!dbAvailable && !dbRequired)('attendance_correct: conditional reason, based on the EXISTING row\'s persisted source (real SQL function, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error('ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable -- this suite must run for real in CI, never silently skip.');
      }
      console.warn('attendanceCorrectConditionalReason.test.ts: no reachable Postgres -- skipping.');
    }
  });

  // ---- NO REASON REQUIRED ----

  it('1. Blank -> Present without reason succeeds', () => {
    const fixture = createFixture();
    const [outcome, , newStatus] = queryRow(
      `SELECT outcome, old_status, new_status FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', NULL)`
    );
    expect(outcome).toBe('written');
    expect(newStatus).toBe('P');
  });

  it('2. Blank -> Absent without reason succeeds', () => {
    const fixture = createFixture();
    const [outcome] = queryRow(
      `SELECT outcome FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'A', NULL)`
    );
    expect(outcome).toBe('written');
  });

  it('3. Manual Present -> Absent without reason succeeds', () => {
    const fixture = createFixture();
    seedExistingAttendance(fixture, '2026-11-10', 'P', 'manual');
    const [outcome, oldStatus, newStatus] = queryRow(
      `SELECT outcome, old_status, new_status FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'A', NULL)`
    );
    expect(outcome).toBe('written');
    expect(oldStatus).toBe('P');
    expect(newStatus).toBe('A');
  });

  it('4. Manual Absent -> Present without reason succeeds', () => {
    const fixture = createFixture();
    seedExistingAttendance(fixture, '2026-11-10', 'A', 'manual');
    const [outcome] = queryRow(
      `SELECT outcome FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', NULL)`
    );
    expect(outcome).toBe('written');
  });

  it('other authorized manual-to-manual corrections (e.g. manual Present -> Leave) succeed without a reason too', () => {
    const fixture = createFixture();
    seedExistingAttendance(fixture, '2026-11-10', 'P', 'manual');
    const [outcome] = queryRow(
      `SELECT outcome FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'LV', NULL)`
    );
    expect(outcome).toBe('written');
  });

  it('routine entry for an employee with no HikCentral mapping/enrollment at all is unaffected -- it is simply blank, same fast path as any other blank day', () => {
    const fixture = createFixture();
    // No hikcentral_person_mappings row inserted at all for this employee.
    const [outcome] = queryRow(
      `SELECT outcome FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', NULL)`
    );
    expect(outcome).toBe('written');
  });

  // ---- REASON REQUIRED ----

  it('5. Automatic Absent -> Present without reason fails', () => {
    const fixture = createFixture();
    seedExistingAttendance(fixture, '2026-11-10', 'A', 'automatic');
    expectRpcError(
      `SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', NULL)`,
      REASON_REQUIRED_MESSAGE
    );
  });

  it('6. Automatic Absent -> Present with valid reason succeeds', () => {
    const fixture = createFixture();
    seedExistingAttendance(fixture, '2026-11-10', 'A', 'automatic');
    const [outcome, oldStatus, newStatus] = queryRow(
      `SELECT outcome, old_status, new_status FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', 'Guard confirmed present on site, fingerprint scanner was offline')`
    );
    expect(outcome).toBe('written');
    expect(oldStatus).toBe('A');
    expect(newStatus).toBe('P');

    const [reason, changeSource] = queryRow(
      `SELECT reason, change_source FROM attendance_audit_log WHERE employee_id = '${fixture.employeeId}' AND attendance_date = '2026-11-10'`
    );
    expect(reason).toBe('Guard confirmed present on site, fingerprint scanner was offline');
    expect(changeSource).toBe('manual');
  });

  it('7. Automatic Present -> Absent without reason fails', () => {
    const fixture = createFixture();
    seedExistingAttendance(fixture, '2026-11-10', 'P', 'automatic');
    expectRpcError(
      `SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'A', NULL)`,
      REASON_REQUIRED_MESSAGE
    );
  });

  it('8. Automatic Late -> another status (Present) without reason fails', () => {
    const fixture = createFixture();
    seedExistingAttendance(fixture, '2026-11-10', 'L', 'automatic');
    expectRpcError(
      `SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', NULL)`,
      REASON_REQUIRED_MESSAGE
    );
  });

  it('9. Clearing an automatic decision (to Off, "-") without reason fails', () => {
    const fixture = createFixture();
    seedExistingAttendance(fixture, '2026-11-10', 'P', 'automatic');
    expectRpcError(
      `SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, '-', NULL)`,
      REASON_REQUIRED_MESSAGE
    );
  });

  it('10. A blank or whitespace-only override reason is rejected exactly like a NULL one', () => {
    const fixture = createFixture();
    seedExistingAttendance(fixture, '2026-11-10', 'A', 'automatic');
    expectRpcError(
      `SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', '   ')`,
      REASON_REQUIRED_MESSAGE
    );
  });

  it('an employee WITH a HikCentral mapping, but whose attendance has never actually been automatically decided yet (still blank), still gets the fast no-reason path', () => {
    const fixture = createFixture();
    exec(`INSERT INTO hikcentral_person_mappings (tenant_id, hikcentral_person_no, employee_id, match_method, is_active) VALUES ('${fixture.tenantId}', 'P${fixture.employeeId.slice(0, 8)}', '${fixture.employeeId}', 'manual', true)`);
    const [outcome] = queryRow(
      `SELECT outcome FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', NULL)`
    );
    expect(outcome).toBe('written');
  });

  // ---- SAFETY: PAYROLL / TENANT / AUDIT ----

  it('12. Existing approved-payroll protection remains effective: a manual override of an automatic Absent is still allowed through (manual precedence, unchanged) but still flagged for reconciliation, exactly as before this migration', () => {
    const fixture = createFixture();
    seedExistingAttendance(fixture, '2026-11-10', 'A', 'automatic');
    exec(`INSERT INTO payroll (tenant_id, employee_id, month, approval_status) VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '2026-11', 'approved')`);

    const [outcome, , , payrollFlag] = queryRow(
      `SELECT outcome, old_status, new_status, payroll_flag FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', 'Guard confirmed present on review of CCTV footage')`
    );
    expect(outcome).toBe('written');
    expect(payrollFlag).toBe('approved');

    const [flaggedReason] = queryRow(
      `SELECT flagged_reason FROM attendance_reconciliation_flags WHERE employee_id = '${fixture.employeeId}' AND attendance_date = '2026-11-10'`
    );
    expect(flaggedReason).toBe('payroll_approved');
  });

  it('13. Tenant/region isolation remains effective: correcting an employee from a DIFFERENT tenant than the caller still fails, with or without a reason', () => {
    // A NON-super-admin caller, specifically -- createFixture()'s caller
    // is a super admin, who legitimately bypasses tenant scoping by
    // design (is_super_admin() short-circuits employee_region_allowed),
    // so proving isolation needs an ordinary regional caller instead.
    const tenantId = randomUUID();
    const callerId = randomUUID();
    const employeeId = randomUUID();
    exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', 'Integration Test Tenant', 'ITT-${tenantId.slice(0, 8)}')`);
    exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
    exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, role_level) VALUES ('${callerId}', '${tenantId}', false, true, 1)`);
    exec(`SELECT set_caller('${callerId}')`);
    exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${employeeId}', '${tenantId}', 'E-${employeeId.slice(0, 8)}', 'Integration Test Employee', 'Active', false, 'SITE')`);

    const otherTenantId = randomUUID();
    const otherEmployeeId = randomUUID();
    exec(`INSERT INTO tenants (id, name, code) VALUES ('${otherTenantId}', 'Other Tenant', 'OTH-${otherTenantId.slice(0, 8)}')`);
    exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${otherEmployeeId}', '${otherTenantId}', 'E-${otherEmployeeId.slice(0, 8)}', 'Other Tenant Employee', 'Active', false, 'SITE')`);

    // Sanity: this same non-admin caller CAN correct their own tenant's
    // employee -- isolates the failure below to tenant scope specifically,
    // not some other defect in the non-super-admin authorization path.
    const [outcome] = queryRow(
      `SELECT outcome FROM attendance_correct('${employeeId}'::uuid, '2026-11-10'::date, 'P', NULL)`
    );
    expect(outcome).toBe('written');

    expectRpcError(
      `SELECT * FROM attendance_correct('${otherEmployeeId}'::uuid, '2026-11-10'::date, 'P', NULL)`,
      "is outside the caller's authorized tenant/region"
    );
  });

  it('14. Audit records still capture who changed attendance and when, even when no reason was required (reason column is simply NULL, never fabricated)', () => {
    const fixture = createFixture();
    const [outcome] = queryRow(
      `SELECT outcome FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', NULL)`
    );
    expect(outcome).toBe('written');

    const [changedBy, reason, changedAtIsNull] = queryRow(
      `SELECT changed_by::text, reason, (changed_at IS NULL)::text FROM attendance_audit_log WHERE employee_id = '${fixture.employeeId}' AND attendance_date = '2026-11-10'`
    );
    expect(changedBy).toBe(fixture.callerId);
    expect(reason).toBe('');
    expect(changedAtIsNull).toBe('false');
  });

  // ---- SAFE-DEFAULT STRUCTURE (no silent "ambiguous source == manual" loophole) ----

  it('17. The migration codes the exemption as an explicit ALLOW-list ("no reason needed only when the existing source IS manual"), never a block-list ("no reason needed unless it IS automatic") -- so a future/legacy source value this check does not recognize can never be silently treated as safe to skip', () => {
    const migrationSource = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/20261124000000_attendance_correct_conditional_reason.sql'),
      'utf-8'
    );
    expect(migrationSource).toMatch(/v_old_source IS DISTINCT FROM 'manual'/);
    // The unsafe inverse form would read "v_old_source = 'automatic'" as
    // the trigger for requiring a reason -- explicitly absent.
    expect(migrationSource).not.toMatch(/v_overrides_existing_record\s*:=.*v_old_source\s*=\s*'automatic'/);
  });

  it('18. Fingerprint-import automatic writes (attendance_write_one with p_source=\'automatic\') are completely unaffected -- this migration touches attendance_correct/attendance_bulk_correct only, never attendance_write_one or attendance_apply_automatic', () => {
    const fixture = createFixture();
    const [outcome, , newStatus] = queryRow(
      `SELECT outcome, old_status, new_status FROM attendance_write_one('${fixture.tenantId}'::uuid, '${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', NULL, 'automatic', '${fixture.callerId}'::uuid, NULL)`
    );
    expect(outcome).toBe('written');
    expect(newStatus).toBe('P');
    const [source] = queryRow(`SELECT source FROM attendance WHERE employee_id = '${fixture.employeeId}' AND date = '2026-11-10'`);
    expect(source).toBe('automatic');
  });

  it('this migration touches no attendance, payroll, or audit-log row directly -- it only redefines two functions', () => {
    const migrationSource = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/20261124000000_attendance_correct_conditional_reason.sql'),
      'utf-8'
    );
    const codeOnly = migrationSource.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
    // The functions' OWN bodies legitimately contain INSERT/UPDATE
    // statements (that is how a correction is written at all) -- what
    // must be absent is a bare, unconditional top-level data-correction
    // statement outside of CREATE OR REPLACE FUNCTION, which there is
    // none of; this just pins that both redefinitions are present and
    // nothing else was slipped in alongside them.
    expect(codeOnly).toMatch(/CREATE OR REPLACE FUNCTION attendance_correct/);
    expect(codeOnly).toMatch(/CREATE OR REPLACE FUNCTION attendance_bulk_correct/);
  });
});

describe.skipIf(!dbAvailable && !dbRequired)('attendance_bulk_correct: a shared batch reason covers only the rows that actually need one -- mixed-source batches no longer abort entirely (real SQL function, disposable Postgres)', () => {
  it('15. Bulk manual entries (all blank/manual) succeed without any reason, across several employees and dates, with no per-row prompt needed', () => {
    const fixture = createFixture();
    const otherEmployeeId = randomUUID();
    exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${otherEmployeeId}', '${fixture.tenantId}', 'E-${otherEmployeeId.slice(0, 8)}', 'Second Employee', 'Active', false, 'SITE')`);

    const rows = queryRows(
      `SELECT outcome FROM attendance_bulk_correct(ARRAY['${fixture.employeeId}', '${otherEmployeeId}']::uuid[], '2026-11-01'::date, '2026-11-02'::date, 'P', NULL)`
    );
    expect(rows).toHaveLength(4);
    for (const [outcome] of rows) expect(outcome).toBe('written');
  });

  it('16. A mixed-source batch (one employee already automatic, the other blank) rejects ONLY the automatic-override row when the shared reason is blank -- every ordinary row in the SAME batch still succeeds, not silently skipped and not aborting the whole call', () => {
    const fixture = createFixture();
    const blankEmployeeId = randomUUID();
    exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, workstation) VALUES ('${blankEmployeeId}', '${fixture.tenantId}', 'E-${blankEmployeeId.slice(0, 8)}', 'Blank Employee', 'Active', false, 'SITE')`);
    seedExistingAttendance(fixture, '2026-11-05', 'A', 'automatic');

    const rows = queryRows(
      `SELECT employee_id, attendance_date, outcome FROM attendance_bulk_correct(ARRAY['${fixture.employeeId}', '${blankEmployeeId}']::uuid[], '2026-11-05'::date, '2026-11-05'::date, 'P', NULL) ORDER BY employee_id`
    );
    expect(rows).toHaveLength(2);
    const byEmployee = new Map(rows.map(([empId, , outcome]) => [empId, outcome]));
    expect(byEmployee.get(fixture.employeeId)).toBe('rejected_reason_required');
    expect(byEmployee.get(blankEmployeeId)).toBe('written');

    // And the automatic row's underlying attendance record was genuinely
    // left untouched -- the rejection was not a silent partial write.
    const [status, source] = queryRow(`SELECT status, source FROM attendance WHERE employee_id = '${fixture.employeeId}' AND date = '2026-11-05'`);
    expect(status).toBe('A');
    expect(source).toBe('automatic');
  });

  it('a shared batch reason DOES cover every automatic-override row it applies to, once supplied', () => {
    const fixture = createFixture();
    seedExistingAttendance(fixture, '2026-11-05', 'A', 'automatic');
    seedExistingAttendance(fixture, '2026-11-06', 'A', 'automatic');

    const rows = queryRows(
      `SELECT attendance_date, outcome FROM attendance_bulk_correct(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-05'::date, '2026-11-06'::date, 'P', 'Batch-reviewed CCTV footage confirms presence both days') ORDER BY attendance_date`
    );
    expect(rows).toHaveLength(2);
    for (const [, outcome] of rows) expect(outcome).toBe('written');
  });

  it('a genuinely unrelated error (invalid status) still aborts the whole call -- only the reason-required condition is caught per-row', () => {
    const fixture = createFixture();
    expectRpcError(
      `SELECT * FROM attendance_bulk_correct(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-05'::date, '2026-11-05'::date, 'NOT_A_STATUS', NULL)`,
      'Invalid status'
    );
  });
});
