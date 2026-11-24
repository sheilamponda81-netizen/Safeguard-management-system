// Terminal Dues Phase 3: batch-to-calculator integration.
//
// This feature adds NO new migration, RPC, or financial logic -- it only
// wires the EXISTING, already-reviewed `link_calculation_to_batch` and
// `submit_terminal_due_calculation` RPCs into a new client-side navigation
// handoff between the Batches tab and the Calculator tab (see
// TerminalDues.tsx/TerminalDuesBatches.tsx/TerminalDuesCalculator.tsx).
//
// Because there is no new SQL, these tests instead exercise the exact call
// sequences the new UI code makes against the real, disposable-Postgres
// schema -- the same convention as terminalDuesBatchManagement.test.ts --
// to prove the client's assumptions hold: that an employee's existing draft
// (found by employee_id, not by batch_id) is reused rather than duplicated,
// that linking only ever reaches a draft, never a submitted/approved/paid
// settlement, and that tenant/region/closed-batch restrictions are enforced
// by the RPC exactly as the UI relies on.
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
  const out = execFileSync('psql', ['-t', '-A', '-F', ',', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split(',') : [];
}

function queryRows(sql: string): string[][] {
  const out = execFileSync('psql', ['-t', '-A', '-F', ',', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split('\n').map((line) => line.split(',')) : [];
}

/** For a single-column query returning one JSONB value -- avoids queryRow's comma-splitting. */
function queryJson(sql: string): Record<string, unknown> {
  const out = execFileSync('psql', ['-t', '-A', '-c', sql], { encoding: 'utf-8' }).trim();
  return JSON.parse(out);
}

interface Fixture {
  tenantId: string;
  callerId: string;
  regionId: string;
}

function createFixture(label: string): Fixture {
  const tenantId = randomUUID();
  const callerId = randomUUID();
  const regionId = randomUUID();

  exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', '${label}', 'ITT-${tenantId.slice(0, 8)}')`);
  exec(`INSERT INTO regions (id, tenant_id, name, code) VALUES ('${regionId}', '${tenantId}', 'Main Region', 'MAIN-${regionId.slice(0, 8)}')`);
  exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
  exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active) VALUES ('${callerId}', '${tenantId}', true, true)`);
  exec(`SELECT set_caller('${callerId}')`);
  exec(`INSERT INTO system_settings (tenant_id, key, value) VALUES ('${tenantId}', 'current_payroll_month', '2026-11')`);

  return { tenantId, callerId, regionId };
}

function createEmployee(fixture: Fixture, label: string, opts: { regionId?: string } = {}): string {
  const employeeId = randomUUID();
  exec(
    `INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, basic_salary, hire_date, region_id) ` +
    `VALUES ('${employeeId}', '${fixture.tenantId}', 'E-${employeeId.slice(0, 8)}', '${label}', 'Active', false, 100000, '2018-01-01', ${opts.regionId ? `'${opts.regionId}'` : 'NULL'})`
  );
  return employeeId;
}

/** Mirrors the Calculator tab's own saveDraft() insert -- a plain INSERT
 * with no batch_id, exactly as the real client code produces before this
 * feature ever touches it. */
function createDraftCalculation(fixture: Fixture, employeeId: string, regionId: string | null): string {
  // 2018-01-01 -> 2026-11-01 is exactly 106 completed months; pension
  // arrears = months * finalSalary * 0.1, enforced byte-for-byte by
  // submit_terminal_due_calculation's own safety check.
  const breakdown = {
    effectiveMonths: 106, pensionArrears: 1060000, annualLeaveRefund: 0, uniformRefund: 0,
    outstandingSalaryTotal: 0, totalEntitlements: 1060000, lessNoticeDeduction: 0, totalPayable: 1060000, excessDeduction: 0,
  };
  const inputs = {
    dateJoined: '2018-01-01', dateLeft: '2026-11-01', finalSalary: 100000,
    uniformDeductionMonths: 0, uniformDeductionPayrollEvidenceMonths: 0,
    outstandingSalaryEntries: [], noticeStatus: 'on_time', requiredNoticeDays: 26,
    uniformRefundRatePerMonth: 10000,
  };
  const id = randomUUID();
  exec(
    `INSERT INTO terminal_due_calculations (id, tenant_id, employee_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable) ` +
    `VALUES ('${id}', '${fixture.tenantId}', '${employeeId}', ${regionId ? `'${regionId}'` : 'NULL'}, 'Test Employee', 'E-TEST', 'Guard', '${JSON.stringify(inputs)}'::jsonb, '${JSON.stringify(breakdown)}'::jsonb, 1060000)`
  );
  return id;
}

/** Mirrors the Calculator tab's new "look for an existing draft first"
 * query -- keyed by employee_id alone, regardless of batch linkage. */
function findExistingDraftForEmployee(employeeId: string): string | null {
  const rows = queryRows(
    `SELECT id FROM terminal_due_calculations WHERE employee_id = '${employeeId}' AND status = 'draft' ORDER BY updated_at DESC LIMIT 1`
  );
  return rows.length > 0 ? rows[0][0] : null;
}

function draftCountForEmployee(employeeId: string): number {
  const [count] = queryRow(`SELECT COUNT(*) FROM terminal_due_calculations WHERE employee_id = '${employeeId}' AND status = 'draft'`);
  return Number(count);
}

describe.skipIf(!dbAvailable && !dbRequired)('Terminal Dues Phase 3: batch-to-calculator integration (real SQL functions, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      throw new Error('Disposable Postgres is required for this suite (ATTENDANCE_PARITY_REQUIRE_DB=1) but is not reachable.');
    }
  });

  it('1. employee+batch preselection data: an active batch member is discoverable for the Prepare Settlement handoff', () => {
    const fixture = createFixture('Preselection');
    const employeeId = createEmployee(fixture, 'Preselect Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Preselection Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);

    const [isMember] = queryRow(
      `SELECT EXISTS (SELECT 1 FROM terminal_due_batch_members WHERE batch_id = '${batchId}' AND employee_id = '${employeeId}' AND removed_at IS NULL)`
    );
    expect(isMember).toBe('t');
  });

  it('2. navigating to the calculator for an employee with NO existing draft finds nothing to reuse (fresh-start path)', () => {
    const fixture = createFixture('No Existing Draft');
    const employeeId = createEmployee(fixture, 'Fresh Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Fresh Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);

    expect(findExistingDraftForEmployee(employeeId)).toBeNull();
  });

  it('3. existing draft handling: a draft created BEFORE batch membership (unlinked) is found and reused, not duplicated', () => {
    const fixture = createFixture('Existing Draft Reuse');
    const employeeId = createEmployee(fixture, 'Existing Draft Employee', { regionId: fixture.regionId });
    const draftId = createDraftCalculation(fixture, employeeId, fixture.regionId);

    // Employee joins a batch only AFTER the draft already existed.
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Reuse Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);

    const found = findExistingDraftForEmployee(employeeId);
    expect(found).toBe(draftId);
    expect(draftCountForEmployee(employeeId)).toBe(1);

    // Linking the found (pre-existing) draft to the batch it's now being prepared for.
    const linkResult = queryJson(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchId}'::uuid)`);
    expect(linkResult.success).toBe(true);
    const [storedBatchId] = queryRow(`SELECT batch_id FROM terminal_due_calculations WHERE id = '${draftId}'`);
    expect(storedBatchId).toBe(batchId);
  });

  it('4. repeated-click idempotency: re-opening and re-linking the same draft never creates a duplicate or a second audit surprise', () => {
    const fixture = createFixture('Repeated Click');
    const employeeId = createEmployee(fixture, 'Repeated Click Employee', { regionId: fixture.regionId });
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Repeated Click Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);
    const draftId = createDraftCalculation(fixture, employeeId, fixture.regionId);

    // Simulate three repeated "Prepare Settlement" clicks: each one looks up
    // the existing draft fresh and re-links it -- never inserts a new row.
    for (let i = 0; i < 3; i++) {
      const found = findExistingDraftForEmployee(employeeId);
      expect(found).toBe(draftId);
      const linkResult = queryJson(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchId}'::uuid)`);
      expect(linkResult.success).toBe(true);
    }

    expect(draftCountForEmployee(employeeId)).toBe(1);
    const [memberCount] = queryRow(`SELECT COUNT(*) FROM terminal_due_batch_members WHERE batch_id = '${batchId}' AND employee_id = '${employeeId}' AND removed_at IS NULL`);
    expect(memberCount).toBe('1');
  });

  it('5. correct batch linkage: linking is rejected for an employee who is not an active member of the target batch', () => {
    const fixture = createFixture('Wrong Batch Linkage');
    const employeeId = createEmployee(fixture, 'Unlinked Employee', { regionId: fixture.regionId });
    const draftId = createDraftCalculation(fixture, employeeId, fixture.regionId);
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Unrelated Batch'))->>'id'`);
    // Employee is never added to this batch.

    const stderr = execExpectError(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchId}'::uuid)`);
    expect(stderr).toMatch(/not an active member of the target batch/i);
    const [storedBatchId] = queryRow(`SELECT batch_id FROM terminal_due_calculations WHERE id = '${draftId}'`);
    expect(storedBatchId).toBeUndefined();
  });

  it('6. closed-batch restriction: Prepare Settlement cannot link a draft into a closed batch', () => {
    const fixture = createFixture('Closed Batch Restriction');
    const employeeId = createEmployee(fixture, 'Closed Batch Employee', { regionId: fixture.regionId });
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Soon Closed Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);
    queryRow(`SELECT (close_terminal_due_batch('${batchId}'::uuid))->>'status'`);
    const draftId = createDraftCalculation(fixture, employeeId, fixture.regionId);

    const stderr = execExpectError(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchId}'::uuid)`);
    expect(stderr).toMatch(/cannot link a calculation to a closed batch/i);
  });

  it('7. tenant isolation: a different tenant\'s (non-super-admin) caller cannot find or link another tenant\'s draft', () => {
    const fixtureA = createFixture('Tenant A Draft Owner');
    const employeeA = createEmployee(fixtureA, 'Tenant A Employee', { regionId: fixtureA.regionId });
    const draftId = createDraftCalculation(fixtureA, employeeA, fixtureA.regionId);
    const [batchIdA] = queryRow(`SELECT (create_terminal_due_batch('Tenant A Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchIdA}'::uuid, ARRAY['${employeeA}'::uuid])`);

    // A regular (non-super-admin) Tenant B caller -- the super-admin profile
    // createFixture() creates by default would bypass tenant scoping
    // entirely, so this test needs its own ordinary functional-role caller.
    const fixtureB = createFixture('Tenant B Intruder');
    const regularCallerId = randomUUID();
    exec(`INSERT INTO auth.users (id) VALUES ('${regularCallerId}')`);
    exec(
      `INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, role, region_id) ` +
      `VALUES ('${regularCallerId}', '${fixtureB.tenantId}', false, true, 'hr_manager', '${fixtureB.regionId}')`
    );
    exec(`SELECT set_caller('${regularCallerId}')`);

    const stderr = execExpectError(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchIdA}'::uuid)`);
    expect(stderr).toMatch(/terminal due calculation not found/i);
  });

  it('8. region isolation: a region-restricted HR user cannot link a calculation outside their assigned region', () => {
    const fixture = createFixture('Region Isolation Linkage');
    const otherRegionId = randomUUID();
    exec(`INSERT INTO regions (id, tenant_id, name, code) VALUES ('${otherRegionId}', '${fixture.tenantId}', 'Other Region', 'OTHER-${otherRegionId.slice(0, 8)}')`);
    const employeeId = createEmployee(fixture, 'Other Region Employee', { regionId: otherRegionId });
    const draftId = createDraftCalculation(fixture, employeeId, otherRegionId);
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Region Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);

    const restrictedCallerId = randomUUID();
    exec(`INSERT INTO auth.users (id) VALUES ('${restrictedCallerId}')`);
    exec(
      `INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, role, region_id) ` +
      `VALUES ('${restrictedCallerId}', '${fixture.tenantId}', false, true, 'hr_manager', '${fixture.regionId}')`
    );
    exec(`SELECT set_caller('${restrictedCallerId}')`);

    const stderr = execExpectError(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchId}'::uuid)`);
    expect(stderr).toMatch(/outside your assigned region/i);
  });

  it('9. batch ID survives settlement submission end-to-end (create -> link after the fact -> submit)', () => {
    const fixture = createFixture('Batch Id Survives Submission');
    const employeeId = createEmployee(fixture, 'Survives Submission Employee', { regionId: fixture.regionId });
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Survives Submission Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);
    // Draft created the way the Calculator's plain INSERT does -- no batch_id yet.
    const draftId = createDraftCalculation(fixture, employeeId, fixture.regionId);
    queryJson(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchId}'::uuid)`);

    const submitResult = queryJson(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    expect(submitResult.success).toBe(true);
    const terminalDueId = submitResult.terminal_due_id as string;
    const [storedBatchId] = queryRow(`SELECT batch_id FROM terminal_dues WHERE id = '${terminalDueId}'`);
    expect(storedBatchId).toBe(batchId);
  });

  it('10. a confirmed settlement cannot be silently moved between batches even if its spent draft row is re-linked', () => {
    const fixture = createFixture('Confirmed Settlement Immutable');
    const employeeId = createEmployee(fixture, 'Immutable Settlement Employee', { regionId: fixture.regionId });
    const [batchAId] = queryRow(`SELECT (create_terminal_due_batch('Batch A Immutable'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchAId}'::uuid, ARRAY['${employeeId}'::uuid])`);
    const draftId = createDraftCalculation(fixture, employeeId, fixture.regionId);
    queryJson(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchAId}'::uuid)`);
    const submitResult = queryJson(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    const terminalDueId = submitResult.terminal_due_id as string;

    // Move the employee to a different batch, then try to "re-link" the now-
    // SUBMITTED draft row (the UI never does this -- it only ever links a
    // draft -- but prove the confirmed terminal_dues row is immune either way).
    queryRow(`SELECT remove_employee_from_batch('${batchAId}'::uuid, '${employeeId}'::uuid, 'moving')`);
    const [batchBId] = queryRow(`SELECT (create_terminal_due_batch('Batch B Immutable'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchBId}'::uuid, ARRAY['${employeeId}'::uuid])`);
    queryJson(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchBId}'::uuid)`);

    const [confirmedBatchId] = queryRow(`SELECT batch_id FROM terminal_dues WHERE id = '${terminalDueId}'`);
    expect(confirmedBatchId).toBe(batchAId);
  });

  it('11. no unexpected status, payroll or payment writes across the full prepare-settlement lifecycle', () => {
    const fixture = createFixture('No Unexpected Writes');
    const employeeId = createEmployee(fixture, 'No Side Effects Employee', { regionId: fixture.regionId });
    const [payrollBefore] = queryRow(`SELECT COUNT(*) FROM payroll`);
    const [allocationsBefore] = queryRow(`SELECT COUNT(*) FROM terminal_due_allocations`);
    const [exitsBefore] = queryRow(`SELECT COUNT(*) FROM employee_exits`);

    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('No Side Effects Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);
    const draftId = createDraftCalculation(fixture, employeeId, fixture.regionId);
    queryJson(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchId}'::uuid)`);
    queryJson(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);

    expect(employeeStatus(employeeId)).toBe('Active');
    const [payrollAfter] = queryRow(`SELECT COUNT(*) FROM payroll`);
    const [allocationsAfter] = queryRow(`SELECT COUNT(*) FROM terminal_due_allocations`);
    const [exitsAfter] = queryRow(`SELECT COUNT(*) FROM employee_exits`);
    expect(payrollAfter).toBe(payrollBefore);
    expect(allocationsAfter).toBe(allocationsBefore);
    expect(exitsAfter).toBe(exitsBefore);
    const [paidStatus] = queryRow(`SELECT status FROM terminal_dues WHERE employee_id = '${employeeId}'`);
    expect(paidStatus).toBe('pending');
  });

  function employeeStatus(employeeId: string): string {
    const [status] = queryRow(`SELECT status FROM employees WHERE id = '${employeeId}'`);
    return status;
  }
});
