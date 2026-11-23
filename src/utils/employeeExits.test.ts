// Terminal Dues Phase 1: structured employee exit records.
//
// Integration coverage for the real, unmodified employee_exits RPCs
// (record_employee_exit, correct_employee_exit, finalize_employee_exit,
// cancel_employee_exit) and submit_terminal_due_calculation's additive
// employee_exit_id linkage, against a disposable Postgres loaded with
// the exact schema in supabase/migrations/ -- same convention as
// attendancePipelineIntegration.test.ts (see that file's header for the
// disposable-database setup this suite shares).
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

interface Fixture {
  tenantId: string;
  callerId: string;
  employeeId: string;
}

/**
 * Minimal, self-contained tenant/caller/employee fixture. The caller is a
 * super admin so every RPC's own authorization check passes without
 * needing to seed the full functional-role permission matrix -- a
 * separate, dedicated NON-super-admin fixture is built explicitly for the
 * permission/tenant-isolation tests below.
 */
function createFixture(label: string, status = 'Active'): Fixture {
  const tenantId = randomUUID();
  const callerId = randomUUID();
  const employeeId = randomUUID();

  exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', 'Integration Test Tenant', 'ITT-${tenantId.slice(0, 8)}')`);
  exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
  exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active) VALUES ('${callerId}', '${tenantId}', true, true)`);
  exec(`SELECT set_caller('${callerId}')`);
  exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, basic_salary, hire_date) VALUES ('${employeeId}', '${tenantId}', 'E-${employeeId.slice(0, 8)}', '${label}', '${status}', false, 100000, '2020-01-01')`);

  return { tenantId, callerId, employeeId };
}

function employeeStatus(employeeId: string): string {
  const [status] = queryRow(`SELECT status FROM employees WHERE id = '${employeeId}'`);
  return status;
}

function exitRow(exitId: string): { status: string; cancellationReason: string | null } {
  const rows = queryRows(`SELECT status, COALESCE(cancellation_reason, '') FROM employee_exits WHERE id = '${exitId}'`);
  return { status: rows[0][0], cancellationReason: rows[0][1] || null };
}

describe.skipIf(!dbAvailable && !dbRequired)('Terminal Dues Phase 1: employee exits (real SQL functions, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error(
          'ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable -- this suite must run for real in CI, never silently skip. ' +
          'See attendancePipelineIntegration.test.ts\'s header and supabase/ci/apply_ci_schema.sh.'
        );
      }
      console.warn('employeeExits.test.ts: no reachable Postgres -- skipping (see attendancePipelineIntegration.test.ts\'s header for setup).');
    }
  });

  it('records a new authorized exit as scheduled, never touching employees.status', () => {
    const fixture = createFixture('New Exit Employee');
    const [result] = queryRow(
      `SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-12-01'::date, 'resignation', 'Moving to another city'))->>'id'`
    );
    expect(result).toBeTruthy();
    expect(exitRow(result).status).toBe('scheduled');
    expect(employeeStatus(fixture.employeeId)).toBe('Active');
  });

  it('supports a scheduled exit dated in the future', () => {
    const fixture = createFixture('Future Exit Employee');
    const [exitId] = queryRow(
      `SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2027-06-30'::date, 'contract_expiry', NULL))->>'id'`
    );
    const [effectiveDate, status] = queryRow(`SELECT effective_exit_date, status FROM employee_exits WHERE id = '${exitId}'`);
    expect(effectiveDate).toBe('2027-06-30');
    expect(status).toBe('scheduled');
  });

  it('finalizing is a separate, explicit action that is the ONLY thing setting employees.status', () => {
    const fixture = createFixture('Finalize Me');
    const [exitId] = queryRow(
      `SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-20'::date, 'dismissal', NULL))->>'id'`
    );
    expect(employeeStatus(fixture.employeeId)).toBe('Active'); // creation alone never changes it

    queryRow(`SELECT finalize_employee_exit('${exitId}'::uuid)`);
    expect(exitRow(exitId).status).toBe('finalized');
    expect(employeeStatus(fixture.employeeId)).toBe('Exited');
  });

  it('cancelling a still-scheduled (never finalized) exit leaves employees.status untouched', () => {
    const fixture = createFixture('Cancel Before Finalize');
    const [exitId] = queryRow(
      `SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-25'::date, 'other', NULL))->>'id'`
    );
    queryRow(`SELECT cancel_employee_exit('${exitId}'::uuid, 'Employee withdrew resignation')`);
    const row = exitRow(exitId);
    expect(row.status).toBe('cancelled');
    expect(row.cancellationReason).toBe('Employee withdrew resignation');
    expect(employeeStatus(fixture.employeeId)).toBe('Active');
  });

  it('cancelling a FINALIZED exit reverts employees.status back to Active, fully auditable', () => {
    const fixture = createFixture('Cancel After Finalize');
    const [exitId] = queryRow(
      `SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-15'::date, 'redundancy', NULL))->>'id'`
    );
    queryRow(`SELECT finalize_employee_exit('${exitId}'::uuid)`);
    expect(employeeStatus(fixture.employeeId)).toBe('Exited');

    queryRow(`SELECT cancel_employee_exit('${exitId}'::uuid, 'Redundancy decision reversed by management')`);
    expect(exitRow(exitId).status).toBe('cancelled');
    expect(employeeStatus(fixture.employeeId)).toBe('Active');
  });

  it('corrects a still-scheduled exit\'s date/category/notes with a mandatory reason, logged to audit_logs', () => {
    const fixture = createFixture('Correct Me');
    const [exitId] = queryRow(
      `SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'other', 'typo date'))->>'id'`
    );
    queryRow(
      `SELECT correct_employee_exit('${exitId}'::uuid, '2026-11-12'::date, 'resignation', 'Corrected category and date', 'HR data-entry correction')`
    );
    const [date, category, notes] = queryRow(`SELECT effective_exit_date, exit_category, notes FROM employee_exits WHERE id = '${exitId}'`);
    expect(date).toBe('2026-11-12');
    expect(category).toBe('resignation');
    expect(notes).toBe('Corrected category and date');

    const [auditCount] = queryRow(
      `SELECT count(*) FROM audit_logs WHERE entity_type = 'employee_exit' AND entity_id = '${exitId}' AND action = 'UPDATE'`
    );
    expect(Number(auditCount)).toBeGreaterThanOrEqual(1);
  });

  it('a correction reason is mandatory -- an empty reason is rejected', () => {
    const fixture = createFixture('Correct Without Reason');
    const [exitId] = queryRow(
      `SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'other', NULL))->>'id'`
    );
    const stderr = execExpectError(
      `SELECT correct_employee_exit('${exitId}'::uuid, '2026-11-12'::date, 'resignation', NULL, '')`
    );
    expect(stderr).toMatch(/correction reason is required/i);
  });

  it('a FINALIZED exit cannot be corrected directly -- only cancel and record a new one', () => {
    const fixture = createFixture('Cannot Correct Finalized');
    const [exitId] = queryRow(
      `SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'retirement', NULL))->>'id'`
    );
    queryRow(`SELECT finalize_employee_exit('${exitId}'::uuid)`);
    const stderr = execExpectError(
      `SELECT correct_employee_exit('${exitId}'::uuid, '2026-11-12'::date, 'retirement', NULL, 'late correction attempt')`
    );
    expect(stderr).toMatch(/only a scheduled.*exit can be corrected/i);
  });

  it('no duplicate active exit: a second scheduled/finalized exit for the same employee is rejected while one is still open', () => {
    const fixture = createFixture('No Duplicate');
    queryRow(`SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'resignation', NULL))->>'id'`);
    const stderr = execExpectError(
      `SELECT record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-11'::date, 'dismissal', NULL)`
    );
    expect(stderr).toMatch(/already has an open.*exit record/i);
  });

  it('after cancelling the open exit, a fresh exit CAN be recorded for the same employee', () => {
    const fixture = createFixture('Fresh After Cancel');
    const [firstId] = queryRow(`SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'resignation', NULL))->>'id'`);
    queryRow(`SELECT cancel_employee_exit('${firstId}'::uuid, 'Recorded in error')`);
    const [secondId] = queryRow(`SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-20'::date, 'dismissal', NULL))->>'id'`);
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
  });

  it('existing employee history (hire_date, basic_salary, employee_number) is retained unchanged after finalize', () => {
    const fixture = createFixture('History Retained');
    const [beforeHireDate, beforeSalary, beforeNumber] = queryRow(
      `SELECT hire_date, basic_salary, employee_number FROM employees WHERE id = '${fixture.employeeId}'`
    );
    const [exitId] = queryRow(`SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'retirement', NULL))->>'id'`);
    queryRow(`SELECT finalize_employee_exit('${exitId}'::uuid)`);
    const [afterHireDate, afterSalary, afterNumber] = queryRow(
      `SELECT hire_date, basic_salary, employee_number FROM employees WHERE id = '${fixture.employeeId}'`
    );
    expect(afterHireDate).toBe(beforeHireDate);
    expect(afterSalary).toBe(beforeSalary);
    expect(afterNumber).toBe(beforeNumber);
    // The employee row itself is never removed -- still SELECTable, "accessible for settlement and historical reporting".
    const [stillExists] = queryRow(`SELECT count(*) FROM employees WHERE id = '${fixture.employeeId}' AND is_deleted = false`);
    expect(stillExists).toBe('1');
  });

  it('a soft-deleted employee is left completely untouched -- no exit record is created, read, or inferred for it', () => {
    const fixture = createFixture('Soft Deleted', 'Active');
    exec(`UPDATE employees SET is_deleted = true, deleted_reason = 'October import correction: duty station outside Lilongwe' WHERE id = '${fixture.employeeId}'`);
    const [exitCount] = queryRow(`SELECT count(*) FROM employee_exits WHERE employee_id = '${fixture.employeeId}'`);
    expect(exitCount).toBe('0'); // this migration never reads is_deleted/deleted_reason or bulk-creates anything
    const [stillDeleted, reason] = queryRow(`SELECT is_deleted, deleted_reason FROM employees WHERE id = '${fixture.employeeId}'`);
    expect(stillDeleted).toBe('t');
    expect(reason).toBe('October import correction: duty station outside Lilongwe');
  });

  it('a draft terminal due calculation can be created and optionally linked to an exit record without changing any amount', () => {
    const fixture = createFixture('Draft Compatibility');
    const [exitId] = queryRow(`SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'resignation', NULL))->>'id'`);

    const inputs = JSON.stringify({ dateJoined: '2020-01-01', dateLeft: '2026-11-10', finalSalary: 100000, uniformDeductionMonths: 0, uniformRefundRatePerMonth: 10000 });
    const breakdown = JSON.stringify({ effectiveMonths: 82, pensionArrears: 820000, annualLeaveRefund: 0, uniformRefund: 0, outstandingSalaryTotal: 0, totalEntitlements: 820000, lessNoticeDeduction: 0, totalPayable: 820000 });

    exec(
      `INSERT INTO terminal_due_calculations (tenant_id, employee_id, employee_exit_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable, created_by) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '${exitId}', NULL, 'Draft Compatibility', 'E-1', 'Guard', '${inputs}'::jsonb, '${breakdown}'::jsonb, 820000, '${fixture.callerId}')`
    );
    const [draftId, linkedExitId, totalPayable] = queryRow(
      `SELECT id, employee_exit_id, total_payable FROM terminal_due_calculations WHERE employee_id = '${fixture.employeeId}'`
    );
    expect(draftId).toBeTruthy();
    expect(linkedExitId).toBe(exitId);
    expect(totalPayable).toBe('820000.00');
  });

  it('existing (unlinked) terminal due calculations without an employee_exit_id continue to work exactly as before -- backward compatible', () => {
    const fixture = createFixture('No Exit Link');
    const inputs = JSON.stringify({ dateJoined: '2020-01-01', dateLeft: '2026-11-10', finalSalary: 100000, uniformDeductionMonths: 0, uniformRefundRatePerMonth: 10000 });
    const breakdown = JSON.stringify({ effectiveMonths: 82, pensionArrears: 820000, annualLeaveRefund: 0, uniformRefund: 0, outstandingSalaryTotal: 0, totalEntitlements: 820000, lessNoticeDeduction: 0, totalPayable: 820000 });
    exec(
      `INSERT INTO terminal_due_calculations (tenant_id, employee_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable, created_by) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.employeeId}', NULL, 'No Exit Link', 'E-2', 'Guard', '${inputs}'::jsonb, '${breakdown}'::jsonb, 820000, '${fixture.callerId}')`
    );
    const [draftId, linkedExitId] = queryRow(`SELECT id, COALESCE(employee_exit_id::text, '') FROM terminal_due_calculations WHERE employee_id = '${fixture.employeeId}'`);
    expect(draftId).toBeTruthy();
    expect(linkedExitId).toBe('');

    const [submitResultStatus] = queryRow(`SELECT (submit_terminal_due_calculation('${draftId}'::uuid))->>'status'`);
    expect(submitResultStatus).toBe('submitted');
    const [tdExitId, tdTotal] = queryRow(`SELECT COALESCE(employee_exit_id::text, ''), total_payable FROM terminal_dues WHERE employee_id = '${fixture.employeeId}'`);
    expect(tdExitId).toBe('');
    expect(tdTotal).toBe('820000.00'); // unchanged -- no amount is affected by this migration
  });

  it('submitting a LINKED draft carries employee_exit_id through to the resulting terminal_dues row, with the amount unchanged', () => {
    const fixture = createFixture('Submit Linked Draft');
    const [exitId] = queryRow(`SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'resignation', NULL))->>'id'`);
    const inputs = JSON.stringify({ dateJoined: '2020-01-01', dateLeft: '2026-11-10', finalSalary: 100000, uniformDeductionMonths: 0, uniformRefundRatePerMonth: 10000 });
    const breakdown = JSON.stringify({ effectiveMonths: 82, pensionArrears: 820000, annualLeaveRefund: 0, uniformRefund: 0, outstandingSalaryTotal: 0, totalEntitlements: 820000, lessNoticeDeduction: 0, totalPayable: 820000 });
    exec(
      `INSERT INTO terminal_due_calculations (tenant_id, employee_id, employee_exit_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable, created_by) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '${exitId}', NULL, 'Submit Linked Draft', 'E-3', 'Guard', '${inputs}'::jsonb, '${breakdown}'::jsonb, 820000, '${fixture.callerId}')`
    );
    const [draftId] = queryRow(`SELECT id FROM terminal_due_calculations WHERE employee_id = '${fixture.employeeId}'`);

    queryRow(`SELECT finalize_employee_exit('${exitId}'::uuid)`); // Employee is independently finalized by HR before submission, as the task requires
    const [submitResultStatus] = queryRow(`SELECT (submit_terminal_due_calculation('${draftId}'::uuid))->>'status'`);
    expect(submitResultStatus).toBe('submitted');

    const [tdExitId, tdTotal, tdStatus] = queryRow(
      `SELECT employee_exit_id, total_payable, status FROM terminal_dues WHERE employee_id = '${fixture.employeeId}'`
    );
    expect(tdExitId).toBe(exitId);
    expect(tdTotal).toBe('820000.00');
    expect(tdStatus).toBe('pending');
  });

  it('draft creation alone (no submission) never changes employee status -- "draft settlement creation does not automatically terminate employment"', () => {
    const fixture = createFixture('Draft Never Terminates');
    const inputs = JSON.stringify({ dateJoined: '2020-01-01', dateLeft: '2026-11-10', finalSalary: 100000, uniformDeductionMonths: 0, uniformRefundRatePerMonth: 10000 });
    const breakdown = JSON.stringify({ effectiveMonths: 82, pensionArrears: 820000, annualLeaveRefund: 0, uniformRefund: 0, outstandingSalaryTotal: 0, totalEntitlements: 820000, lessNoticeDeduction: 0, totalPayable: 820000 });
    exec(
      `INSERT INTO terminal_due_calculations (tenant_id, employee_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable, created_by) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.employeeId}', NULL, 'Draft Never Terminates', 'E-4', 'Guard', '${inputs}'::jsonb, '${breakdown}'::jsonb, 820000, '${fixture.callerId}')`
    );
    expect(employeeStatus(fixture.employeeId)).toBe('Active');
  });

  it('submitting a draft/legacy terminal due never silently changes employee status by itself -- only finalize_employee_exit does', () => {
    const fixture = createFixture('Submission Never Terminates');
    const inputs = JSON.stringify({ dateJoined: '2020-01-01', dateLeft: '2026-11-10', finalSalary: 100000, uniformDeductionMonths: 0, uniformRefundRatePerMonth: 10000 });
    const breakdown = JSON.stringify({ effectiveMonths: 82, pensionArrears: 820000, annualLeaveRefund: 0, uniformRefund: 0, outstandingSalaryTotal: 0, totalEntitlements: 820000, lessNoticeDeduction: 0, totalPayable: 820000 });
    exec(
      `INSERT INTO terminal_due_calculations (tenant_id, employee_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable, created_by) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.employeeId}', NULL, 'Submission Never Terminates', 'E-5', 'Guard', '${inputs}'::jsonb, '${breakdown}'::jsonb, 820000, '${fixture.callerId}')`
    );
    const [draftId] = queryRow(`SELECT id FROM terminal_due_calculations WHERE employee_id = '${fixture.employeeId}'`);
    queryRow(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    expect(employeeStatus(fixture.employeeId)).toBe('Active'); // still Active: submission/approval never flips status

    const [terminalDueId] = queryRow(`SELECT id FROM terminal_dues WHERE employee_id = '${fixture.employeeId}'`);
    queryRow(`SELECT approve_terminal_due('${terminalDueId}'::uuid)`);
    expect(employeeStatus(fixture.employeeId)).toBe('Active'); // approval also never flips status
  });

  it('an approved/paid terminal due is unaffected by this migration -- amounts and workflow-column protections are untouched', () => {
    // Uses the legacy direct-create path (a plain INSERT into terminal_dues,
    // with no terminal_due_calculations row behind it), not the modern
    // draft/submit path: a calculator-originated row is a pre-existing,
    // unrelated guard (20261021000001_terminal_dues_legacy_payment_guard.sql)
    // that rejects direct payment regardless of this migration, so it is
    // not the right fixture for "unaffected by this migration".
    const fixture = createFixture('Approved Paid Protection');
    exec(
      `INSERT INTO terminal_dues (tenant_id, employee_id, employee_name, employee_number, position, date_joined, date_left, reason_for_termination, period_months, basic_salary, gratuity, annual_leave, uniform_refund, other_benefits, subtotal, deductions, total_payable, status) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.employeeId}', 'Approved Paid Protection', 'E-6', 'Guard', '2020-01-01', '2026-11-10', 'resignation', 82, 100000, 820000, 0, 0, 0, 820000, 0, 820000, 'pending')`
    );
    const [terminalDueId] = queryRow(`SELECT id FROM terminal_dues WHERE employee_id = '${fixture.employeeId}'`);
    queryRow(`SELECT approve_terminal_due('${terminalDueId}'::uuid)`);
    queryRow(`SELECT record_terminal_due_payment('${terminalDueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-123', NULL)`);

    const [status, totalPayable] = queryRow(`SELECT status, total_payable FROM terminal_dues WHERE id = '${terminalDueId}'`);
    expect(status).toBe('paid');
    expect(totalPayable).toBe('820000.00'); // completely unaffected by this migration's existence

    // Direct client attempt to tamper with a paid record's workflow columns is still blocked (pre-existing protection, re-confirmed unaffected).
    const stderr = execExpectError(`UPDATE terminal_dues SET status = 'pending' WHERE id = '${terminalDueId}'`);
    expect(stderr).toBeTruthy();
  });

  it('audit history: record/correct/finalize/cancel each produce their own distinct audit_logs entry', () => {
    const fixture = createFixture('Full Audit Trail');
    const [exitId] = queryRow(`SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'other', NULL))->>'id'`);
    queryRow(`SELECT correct_employee_exit('${exitId}'::uuid, '2026-11-11'::date, 'resignation', NULL, 'fix category')`);
    queryRow(`SELECT finalize_employee_exit('${exitId}'::uuid)`);
    queryRow(`SELECT cancel_employee_exit('${exitId}'::uuid, 'management reversed the decision')`);

    const actions = queryRows(
      `SELECT action FROM audit_logs WHERE entity_type = 'employee_exit' AND entity_id = '${exitId}' ORDER BY created_at`
    ).map((r) => r[0]);
    expect(actions).toEqual(['CREATE', 'UPDATE', 'FINALIZE', 'CANCEL']);
  });

  it('tenant isolation: a caller cannot record, correct, finalize or cancel an exit for an employee in a different tenant', () => {
    const fixtureA = createFixture('Tenant A Employee');
    const otherTenantId = randomUUID();
    const otherCallerId = randomUUID();
    const otherRegionId = randomUUID();
    exec(`INSERT INTO tenants (id, name, code) VALUES ('${otherTenantId}', 'Other Tenant', 'OTH-${otherTenantId.slice(0, 8)}')`);
    exec(`INSERT INTO regions (id, tenant_id, name, code) VALUES ('${otherRegionId}', '${otherTenantId}', 'Other Region', 'OTH-R-${otherTenantId.slice(0, 8)}')`);
    exec(`INSERT INTO auth.users (id) VALUES ('${otherCallerId}')`);
    // Deliberately NOT super admin and NOT business admin -- a genuinely tenant-scoped, non-privileged caller.
    // role='hr_manager' requires a non-null region_id (profiles_functional_role_region_required).
    exec(`INSERT INTO profiles (id, tenant_id, region_id, is_super_admin, is_active, role, role_level) VALUES ('${otherCallerId}', '${otherTenantId}', '${otherRegionId}', false, true, 'hr_manager', NULL)`);
    // role_permissions is a global (not tenant-scoped) matrix; 'hr_manager' already carries
    // terminal_dues.create in the base schema seed, which is all record_employee_exit needs.

    exec(`SELECT set_caller('${otherCallerId}')`);
    const stderr = execExpectError(
      `SELECT record_employee_exit('${fixtureA.employeeId}'::uuid, '2026-11-10'::date, 'resignation', NULL)`
    );
    expect(stderr).toMatch(/not found/i); // cross-tenant employee lookup fails closed, never leaks existence

    // Restore the original (super admin) caller for subsequent assertions/tests in this file.
    exec(`SELECT set_caller('${fixtureA.callerId}')`);
  });

  it('role isolation: a caller with NO terminal_dues permission at all cannot record an exit, even within the same tenant', () => {
    const fixture = createFixture('No Permission Caller Target');
    const unprivilegedCallerId = randomUUID();
    const unprivilegedRegionId = randomUUID();
    exec(`INSERT INTO auth.users (id) VALUES ('${unprivilegedCallerId}')`);
    exec(`INSERT INTO regions (id, tenant_id, name, code) VALUES ('${unprivilegedRegionId}', '${fixture.tenantId}', 'Unprivileged Region', 'UNP-R-${unprivilegedRegionId.slice(0, 8)}')`);
    // role='operations_manager' requires a non-null region_id (profiles_functional_role_region_required).
    exec(`INSERT INTO profiles (id, tenant_id, region_id, is_super_admin, is_active, role, role_level) VALUES ('${unprivilegedCallerId}', '${fixture.tenantId}', '${unprivilegedRegionId}', false, true, 'operations_manager', NULL)`);
    // role_permissions is a global (not tenant-scoped) matrix; 'operations_manager' already carries
    // only attendance.view (and similar) in the base schema seed -- deliberately never terminal_dues.*.

    exec(`SELECT set_caller('${unprivilegedCallerId}')`);
    const stderr = execExpectError(
      `SELECT record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'resignation', NULL)`
    );
    expect(stderr).toMatch(/terminal_dues\.create/i);

    exec(`SELECT set_caller('${fixture.callerId}')`);
  });

  it('no changes to existing attendance/payroll calculations: payroll rows for the employee are byte-identical before and after finalize', () => {
    const fixture = createFixture('Payroll Unaffected');
    exec(
      `INSERT INTO payroll (tenant_id, employee_id, month, basic_salary, gross_pay, net_pay, uniform_deduction, approval_status) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '2026-10', 100000, 100000, 90000, 10000, 'approved')`
    );
    const before = queryRow(`SELECT basic_salary, gross_pay, net_pay, uniform_deduction, approval_status FROM payroll WHERE employee_id = '${fixture.employeeId}'`);

    const [exitId] = queryRow(`SELECT (record_employee_exit('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'resignation', NULL))->>'id'`);
    queryRow(`SELECT finalize_employee_exit('${exitId}'::uuid)`);

    const after = queryRow(`SELECT basic_salary, gross_pay, net_pay, uniform_deduction, approval_status FROM payroll WHERE employee_id = '${fixture.employeeId}'`);
    expect(after).toEqual(before);
  });
});
