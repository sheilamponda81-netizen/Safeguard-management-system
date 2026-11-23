// Terminal Dues Phase 2: integrated batch management
// (20261129000000_terminal_dues_batch_management.sql).
//
// Integration coverage for the real, unmodified RPCs
// (create_terminal_due_batch, add_employees_to_batch,
// remove_employee_from_batch, close_terminal_due_batch,
// link_calculation_to_batch) plus submit_terminal_due_calculation's
// additive batch_id carry-through, against a disposable Postgres
// loaded with the exact schema in supabase/migrations/ -- same
// convention as employeeExits.test.ts and
// terminalDuesLegacyPaymentAllocationGuard.test.ts.
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

/** For a single-column query returning one JSONB value -- avoids queryRow's comma-splitting, which would corrupt JSON text containing commas. */
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

function createEmployee(fixture: Fixture, label: string, opts: { deleted?: boolean; regionId?: string } = {}): string {
  const employeeId = randomUUID();
  exec(
    `INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, basic_salary, hire_date, region_id) ` +
    `VALUES ('${employeeId}', '${fixture.tenantId}', 'E-${employeeId.slice(0, 8)}', '${label}', 'Active', ${opts.deleted ? 'true' : 'false'}, 100000, '2020-01-01', ${opts.regionId ? `'${opts.regionId}'` : 'NULL'})`
  );
  return employeeId;
}

function employeeStatus(employeeId: string): string {
  const [status] = queryRow(`SELECT status FROM employees WHERE id = '${employeeId}'`);
  return status;
}

function activeMemberCount(batchId: string): number {
  const [count] = queryRow(`SELECT COUNT(*) FROM terminal_due_batch_members WHERE batch_id = '${batchId}' AND removed_at IS NULL`);
  return Number(count);
}

describe.skipIf(!dbAvailable && !dbRequired)('Terminal Dues Phase 2: batch management (real SQL functions, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      throw new Error('Disposable Postgres is required for this suite (ATTENDANCE_PARITY_REQUIRE_DB=1) but is not reachable.');
    }
  });

  it('1. creating a batch with 50 employees succeeds and the member count matches exactly', () => {
    const fixture = createFixture('Fifty Employee Batch');
    const employeeIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      employeeIds.push(createEmployee(fixture, `Fifty Batch Employee ${i}`));
    }
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('November Retrenchment Round'))->>'id'`);

    const result = queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY[${employeeIds.map(id => `'${id}'::uuid`).join(',')}])`);
    expect((result.added as string[]).length).toBe(50);
    expect((result.skipped as unknown[]).length).toBe(0);
    expect(activeMemberCount(batchId)).toBe(50);
  });

  it('2. duplicate selection is prevented both within the same batch and across a different active batch', () => {
    const fixture = createFixture('Duplicate Prevention');
    const employeeId = createEmployee(fixture, 'Duplicate Target');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Batch A'))->>'id'`);
    const [batch2Id] = queryRow(`SELECT (create_terminal_due_batch('Batch B'))->>'id'`);

    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);

    const withinBatch = queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);
    expect((withinBatch.added as string[]).length).toBe(0);
    expect((withinBatch.skipped as { reason: string }[])[0].reason).toMatch(/already an active member of this batch/i);

    const crossBatch = queryJson(`SELECT add_employees_to_batch('${batch2Id}'::uuid, ARRAY['${employeeId}'::uuid])`);
    expect((crossBatch.added as string[]).length).toBe(0);
    expect((crossBatch.skipped as { reason: string }[])[0].reason).toMatch(/already an active member of another open batch/i);

    expect(activeMemberCount(batchId)).toBe(1);
    expect(activeMemberCount(batch2Id)).toBe(0);
  });

  it('3a. cross-tenant isolation: a different tenant cannot see or mutate this batch', () => {
    const fixture = createFixture('Tenant Isolation Target');
    const employeeId = createEmployee(fixture, 'Tenant Isolation Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Tenant Isolation Batch'))->>'id'`);

    const otherTenantId = randomUUID();
    const otherCallerId = randomUUID();
    const otherRegionId = randomUUID();
    exec(`INSERT INTO tenants (id, name, code) VALUES ('${otherTenantId}', 'Other Tenant', 'OTH-${otherTenantId.slice(0, 8)}')`);
    exec(`INSERT INTO regions (id, tenant_id, name, code) VALUES ('${otherRegionId}', '${otherTenantId}', 'Other Region', 'OTH-R-${otherTenantId.slice(0, 8)}')`);
    exec(`INSERT INTO auth.users (id) VALUES ('${otherCallerId}')`);
    exec(`INSERT INTO profiles (id, tenant_id, region_id, is_super_admin, is_active, role) VALUES ('${otherCallerId}', '${otherTenantId}', '${otherRegionId}', false, true, 'hr_manager')`);
    exec(`SELECT set_caller('${otherCallerId}')`);

    const stderr = execExpectError(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);
    expect(stderr).toMatch(/batch not found/i);

    exec(`SELECT set_caller('${fixture.callerId}')`);
  });

  it('3b. region isolation: a region-restricted HR user cannot add an employee outside their assigned region', () => {
    const fixture = createFixture('Region Isolation');
    const otherRegionId = randomUUID();
    exec(`INSERT INTO regions (id, tenant_id, name, code) VALUES ('${otherRegionId}', '${fixture.tenantId}', 'Other Region In Tenant', 'OTH-REG-${otherRegionId.slice(0, 8)}')`);
    const outOfRegionEmployee = createEmployee(fixture, 'Out Of Region Employee', { regionId: otherRegionId });

    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Region Isolation Batch'))->>'id'`);

    const regionCallerId = randomUUID();
    exec(`INSERT INTO auth.users (id) VALUES ('${regionCallerId}')`);
    exec(`INSERT INTO profiles (id, tenant_id, region_id, is_super_admin, is_active, role) VALUES ('${regionCallerId}', '${fixture.tenantId}', '${fixture.regionId}', false, true, 'hr_manager')`);
    exec(`SELECT set_caller('${regionCallerId}')`);

    const result = queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${outOfRegionEmployee}'::uuid])`);
    expect((result.added as string[]).length).toBe(0);
    expect((result.skipped as { reason: string }[])[0].reason).toMatch(/outside your assigned region/i);

    exec(`SELECT set_caller('${fixture.callerId}')`);
  });

  it('4. a batch member with a merely SCHEDULED exit is unaffected -- batch operations never touch employees.status', () => {
    const fixture = createFixture('Scheduled Exit Member');
    const employeeId = createEmployee(fixture, 'Scheduled Exit Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Scheduled Exit Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);

    queryRow(`SELECT record_employee_exit('${employeeId}'::uuid, '2026-12-10'::date, 'resignation', NULL)`);
    expect(employeeStatus(employeeId)).toBe('Active');

    const [exitStatus] = queryRow(`SELECT status FROM employee_exits WHERE employee_id = '${employeeId}'`);
    expect(exitStatus).toBe('scheduled');
    expect(activeMemberCount(batchId)).toBe(1);
  });

  it('5. a batch member whose exit is FINALIZED flips to Exited only via that explicit action, not via batch membership itself', () => {
    const fixture = createFixture('Finalized Exit Member');
    const employeeId = createEmployee(fixture, 'Finalized Exit Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Finalized Exit Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);
    expect(employeeStatus(employeeId)).toBe('Active'); // adding to a batch alone never changes status

    const [exitId] = queryRow(`SELECT (record_employee_exit('${employeeId}'::uuid, '2026-12-10'::date, 'resignation', NULL))->>'id'`);
    expect(employeeStatus(employeeId)).toBe('Active'); // recording an exit alone never changes status

    queryRow(`SELECT finalize_employee_exit('${exitId}'::uuid)`);
    expect(employeeStatus(employeeId)).toBe('Exited'); // only the explicit finalize action does

    // Batch membership itself is still completely intact.
    expect(activeMemberCount(batchId)).toBe(1);
  });

  it('6. a batch member with an existing settlement: the draft, then the submitted terminal_dues row, both carry the batch_id through', () => {
    const fixture = createFixture('Existing Settlement Member');
    const employeeId = createEmployee(fixture, 'Existing Settlement Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Existing Settlement Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);

    const inputs = JSON.stringify({ dateJoined: '2020-01-01', dateLeft: '2026-11-10', finalSalary: 100000, uniformDeductionMonths: 0, uniformRefundRatePerMonth: 10000 });
    const breakdown = JSON.stringify({ effectiveMonths: 82, pensionArrears: 820000, annualLeaveRefund: 0, uniformRefund: 0, outstandingSalaryTotal: 0, totalEntitlements: 820000, lessNoticeDeduction: 0, totalPayable: 820000 });
    exec(
      `INSERT INTO terminal_due_calculations (tenant_id, employee_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable, created_by) ` +
      `VALUES ('${fixture.tenantId}', '${employeeId}', NULL, 'Existing Settlement Employee', 'E-EXIST', 'Guard', '${inputs}'::jsonb, '${breakdown}'::jsonb, 820000, '${fixture.callerId}')`
    );
    const [draftId] = queryRow(`SELECT id FROM terminal_due_calculations WHERE employee_id = '${employeeId}'`);

    queryRow(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchId}'::uuid)`);
    expect(queryRow(`SELECT batch_id FROM terminal_due_calculations WHERE id = '${draftId}'`)).toEqual([batchId]);

    const [dueId] = queryRow(`SELECT (submit_terminal_due_calculation('${draftId}'::uuid))->>'terminal_due_id'`);
    expect(queryRow(`SELECT batch_id FROM terminal_dues WHERE id = '${dueId}'`)).toEqual([batchId]);
  });

  it('6b. linking a calculation whose employee is NOT an active member of the target batch is rejected', () => {
    const fixture = createFixture('Non Member Link Attempt');
    const employeeId = createEmployee(fixture, 'Non Member Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Non Member Batch'))->>'id'`);
    // Deliberately never added to the batch.

    const inputs = JSON.stringify({ dateJoined: '2020-01-01', dateLeft: '2026-11-10', finalSalary: 100000, uniformDeductionMonths: 0, uniformRefundRatePerMonth: 10000 });
    const breakdown = JSON.stringify({ effectiveMonths: 82, pensionArrears: 820000, annualLeaveRefund: 0, uniformRefund: 0, outstandingSalaryTotal: 0, totalEntitlements: 820000, lessNoticeDeduction: 0, totalPayable: 820000 });
    exec(
      `INSERT INTO terminal_due_calculations (tenant_id, employee_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable, created_by) ` +
      `VALUES ('${fixture.tenantId}', '${employeeId}', NULL, 'Non Member Employee', 'E-NONMEM', 'Guard', '${inputs}'::jsonb, '${breakdown}'::jsonb, 820000, '${fixture.callerId}')`
    );
    const [draftId] = queryRow(`SELECT id FROM terminal_due_calculations WHERE employee_id = '${employeeId}'`);

    const stderr = execExpectError(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchId}'::uuid)`);
    expect(stderr).toMatch(/not an active member of the target batch/i);
  });

  it('7. soft-deleted employees (and nonexistent ids, standing in for historical-only employees) are skipped, never added', () => {
    const fixture = createFixture('Soft Deleted Skip');
    const deletedEmployee = createEmployee(fixture, 'Soft Deleted Employee', { deleted: true });
    const nonexistentId = randomUUID();
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Soft Delete Batch'))->>'id'`);

    const result = queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${deletedEmployee}'::uuid, '${nonexistentId}'::uuid])`);
    expect((result.added as string[]).length).toBe(0);
    const skipped = result.skipped as { employee_id: string; reason: string }[];
    expect(skipped.find(s => s.employee_id === deletedEmployee)?.reason).toMatch(/soft-deleted/i);
    expect(skipped.find(s => s.employee_id === nonexistentId)?.reason).toMatch(/not found/i);
    expect(activeMemberCount(batchId)).toBe(0);
  });

  it('8. batch draft totals are exactly the sum of its members\' own draft calculations, nothing invented', () => {
    const fixture = createFixture('Draft Totals');
    const emp1 = createEmployee(fixture, 'Draft Totals Employee One');
    const emp2 = createEmployee(fixture, 'Draft Totals Employee Two');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Draft Totals Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${emp1}'::uuid, '${emp2}'::uuid])`);

    const makeDraft = (employeeId: string, total: number) => {
      const inputs = JSON.stringify({ dateJoined: '2020-01-01', dateLeft: '2026-11-10', finalSalary: 100000, uniformDeductionMonths: 0, uniformRefundRatePerMonth: 10000 });
      const breakdown = JSON.stringify({ effectiveMonths: 10, pensionArrears: total, annualLeaveRefund: 0, uniformRefund: 0, outstandingSalaryTotal: 0, totalEntitlements: total, lessNoticeDeduction: 0, totalPayable: total });
      exec(
        `INSERT INTO terminal_due_calculations (tenant_id, employee_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable, created_by) ` +
        `VALUES ('${fixture.tenantId}', '${employeeId}', NULL, 'x', 'x', 'Guard', '${inputs}'::jsonb, '${breakdown}'::jsonb, ${total}, '${fixture.callerId}')`
      );
      const [id] = queryRow(`SELECT id FROM terminal_due_calculations WHERE employee_id = '${employeeId}'`);
      queryRow(`SELECT link_calculation_to_batch('${id}'::uuid, '${batchId}'::uuid)`);
    };
    makeDraft(emp1, 300000);
    makeDraft(emp2, 450000);

    const [sum] = queryRow(`SELECT SUM(total_payable) FROM terminal_due_calculations WHERE batch_id = '${batchId}' AND status = 'draft'`);
    expect(Number(sum)).toBe(750000);
  });

  it('9. partial payment leaves an accurate remaining liability -- never derived from allocation approval alone', () => {
    const fixture = createFixture('Partial Payment Liability');
    const employeeId = createEmployee(fixture, 'Partial Payment Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Partial Payment Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);

    exec(
      `INSERT INTO terminal_dues (tenant_id, employee_id, employee_name, employee_number, position, date_joined, date_left, period_months, basic_salary, gratuity, annual_leave, uniform_refund, other_benefits, subtotal, deductions, total_payable, status, batch_id) ` +
      `VALUES ('${fixture.tenantId}', '${employeeId}', 'Partial Payment Employee', 'E-PARTIAL', 'Guard', '2020-01-01', '2026-11-10', 82, 100000, 500000, 0, 0, 0, 500000, 0, 500000, 'pending', '${batchId}')`
    );
    const [dueId] = queryRow(`SELECT id FROM terminal_dues WHERE batch_id = '${batchId}'`);
    queryRow(`SELECT approve_terminal_due('${dueId}'::uuid)`);

    const [allocId] = queryRow(`SELECT (propose_terminal_due_allocation('${dueId}'::uuid, 200000))->>'id'`);
    queryRow(`SELECT approve_terminal_due_allocation('${allocId}'::uuid)`);
    queryRow(`SELECT process_terminal_due_allocations_batch()`);

    const [status, totalPayable] = queryRow(`SELECT status, total_payable FROM terminal_dues WHERE id = '${dueId}'`);
    expect(status).toBe('approved'); // NOT 'paid' -- a partial processed allocation never flips the entitlement to paid
    const [processedSum] = queryRow(`SELECT COALESCE(SUM(last_decided_amount), 0) FROM terminal_due_allocations WHERE terminal_due_id = '${dueId}' AND status = 'processed'`);
    const remainingLiability = Number(totalPayable) - Number(processedSum);
    expect(remainingLiability).toBe(300000);
  });

  it('10. an approved-but-unprocessed allocation is never counted as paid', () => {
    const fixture = createFixture('Approved Unprocessed');
    const employeeId = createEmployee(fixture, 'Approved Unprocessed Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Approved Unprocessed Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);

    exec(
      `INSERT INTO terminal_dues (tenant_id, employee_id, employee_name, employee_number, position, date_joined, date_left, period_months, basic_salary, gratuity, annual_leave, uniform_refund, other_benefits, subtotal, deductions, total_payable, status, batch_id) ` +
      `VALUES ('${fixture.tenantId}', '${employeeId}', 'Approved Unprocessed Employee', 'E-APPUNP', 'Guard', '2020-01-01', '2026-11-10', 82, 100000, 400000, 0, 0, 0, 400000, 0, 400000, 'pending', '${batchId}')`
    );
    const [dueId] = queryRow(`SELECT id FROM terminal_dues WHERE batch_id = '${batchId}'`);
    queryRow(`SELECT approve_terminal_due('${dueId}'::uuid)`);
    const [allocId] = queryRow(`SELECT (propose_terminal_due_allocation('${dueId}'::uuid, 400000))->>'id'`);
    queryRow(`SELECT approve_terminal_due_allocation('${allocId}'::uuid)`);

    const [allocStatus] = queryRow(`SELECT status FROM terminal_due_allocations WHERE id = '${allocId}'`);
    expect(allocStatus).toBe('approved'); // reserved, not processed
    const [dueStatus] = queryRow(`SELECT status FROM terminal_dues WHERE id = '${dueId}'`);
    expect(dueStatus).toBe('approved'); // still not 'paid'
  });

  it('11. multiple monthly allocations for the same batch-linked entitlement are capped correctly across months (regression)', () => {
    const fixture = createFixture('Multiple Monthly Allocations');
    const employeeId = createEmployee(fixture, 'Multi Month Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Multi Month Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);

    exec(
      `INSERT INTO terminal_dues (tenant_id, employee_id, employee_name, employee_number, position, date_joined, date_left, period_months, basic_salary, gratuity, annual_leave, uniform_refund, other_benefits, subtotal, deductions, total_payable, status, batch_id) ` +
      `VALUES ('${fixture.tenantId}', '${employeeId}', 'Multi Month Employee', 'E-MULTI', 'Guard', '2020-01-01', '2026-11-10', 82, 100000, 600000, 0, 0, 0, 600000, 0, 600000, 'pending', '${batchId}')`
    );
    const [dueId] = queryRow(`SELECT id FROM terminal_dues WHERE batch_id = '${batchId}'`);
    queryRow(`SELECT approve_terminal_due('${dueId}'::uuid)`);

    const [alloc1] = queryRow(`SELECT (propose_terminal_due_allocation('${dueId}'::uuid, 300000))->>'id'`);
    queryRow(`SELECT approve_terminal_due_allocation('${alloc1}'::uuid)`);
    queryRow(`SELECT process_terminal_due_allocations_batch()`);

    exec(`UPDATE system_settings SET value = '2026-12' WHERE tenant_id = '${fixture.tenantId}' AND key = 'current_payroll_month'`);
    const [alloc2] = queryRow(`SELECT (propose_terminal_due_allocation('${dueId}'::uuid, 300000))->>'id'`);
    queryRow(`SELECT approve_terminal_due_allocation('${alloc2}'::uuid)`);
    queryRow(`SELECT process_terminal_due_allocations_batch()`);

    const [totalProcessed] = queryRow(`SELECT SUM(last_decided_amount) FROM terminal_due_allocations WHERE terminal_due_id = '${dueId}' AND status = 'processed'`);
    expect(Number(totalProcessed)).toBe(600000);
    expect(queryRow(`SELECT COUNT(DISTINCT payroll_month) FROM terminal_due_allocations WHERE terminal_due_id = '${dueId}'`)).toEqual(['2']);

    // Over-allocating a third month is still rejected (pre-existing cap, re-confirmed in the batch context).
    exec(`UPDATE system_settings SET value = '2027-01' WHERE tenant_id = '${fixture.tenantId}' AND key = 'current_payroll_month'`);
    const stderr = execExpectError(`SELECT propose_terminal_due_allocation('${dueId}'::uuid, 1)`);
    expect(stderr).toMatch(/exceeds the available outstanding balance/i);
  });

  it('12. no duplicate payment: a batch-linked due fully processed via allocations still cannot be paid again directly (PR #74 protection unaffected)', () => {
    const fixture = createFixture('No Duplicate Payment');
    const employeeId = createEmployee(fixture, 'No Duplicate Payment Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('No Duplicate Payment Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);

    exec(
      `INSERT INTO terminal_dues (tenant_id, employee_id, employee_name, employee_number, position, date_joined, date_left, period_months, basic_salary, gratuity, annual_leave, uniform_refund, other_benefits, subtotal, deductions, total_payable, status, batch_id) ` +
      `VALUES ('${fixture.tenantId}', '${employeeId}', 'No Duplicate Payment Employee', 'E-NODUP', 'Guard', '2020-01-01', '2026-11-10', 82, 100000, 500000, 0, 0, 0, 500000, 0, 500000, 'pending', '${batchId}')`
    );
    const [dueId] = queryRow(`SELECT id FROM terminal_dues WHERE batch_id = '${batchId}'`);
    queryRow(`SELECT approve_terminal_due('${dueId}'::uuid)`);
    const [allocId] = queryRow(`SELECT (propose_terminal_due_allocation('${dueId}'::uuid, 500000))->>'id'`);
    queryRow(`SELECT approve_terminal_due_allocation('${allocId}'::uuid)`);
    queryRow(`SELECT process_terminal_due_allocations_batch()`);

    const stderr = execExpectError(`SELECT record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-BATCH-NODUP', NULL)`);
    expect(stderr).toMatch(/active or processed payment allocation/i);
    expect(queryRow(`SELECT status FROM terminal_dues WHERE id = '${dueId}'`)).toEqual(['approved']);
  });

  it('13. no unintended employee status changes across a full batch lifecycle (create, add, link, submit, remove, close)', () => {
    const fixture = createFixture('No Unintended Status Change');
    const emp1 = createEmployee(fixture, 'Lifecycle Employee One');
    const emp2 = createEmployee(fixture, 'Lifecycle Employee Two');
    const before = [employeeStatus(emp1), employeeStatus(emp2)];

    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Lifecycle Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${emp1}'::uuid, '${emp2}'::uuid])`);

    const inputs = JSON.stringify({ dateJoined: '2020-01-01', dateLeft: '2026-11-10', finalSalary: 100000, uniformDeductionMonths: 0, uniformRefundRatePerMonth: 10000 });
    const breakdown = JSON.stringify({ effectiveMonths: 82, pensionArrears: 820000, annualLeaveRefund: 0, uniformRefund: 0, outstandingSalaryTotal: 0, totalEntitlements: 820000, lessNoticeDeduction: 0, totalPayable: 820000 });
    exec(
      `INSERT INTO terminal_due_calculations (tenant_id, employee_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable, created_by) ` +
      `VALUES ('${fixture.tenantId}', '${emp1}', NULL, 'x', 'x', 'Guard', '${inputs}'::jsonb, '${breakdown}'::jsonb, 820000, '${fixture.callerId}')`
    );
    const [draftId] = queryRow(`SELECT id FROM terminal_due_calculations WHERE employee_id = '${emp1}'`);
    queryRow(`SELECT link_calculation_to_batch('${draftId}'::uuid, '${batchId}'::uuid)`);
    queryRow(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);

    queryRow(`SELECT remove_employee_from_batch('${batchId}'::uuid, '${emp2}'::uuid, 'left the company directly, handled outside this batch')`);
    queryRow(`SELECT close_terminal_due_batch('${batchId}'::uuid)`);

    expect([employeeStatus(emp1), employeeStatus(emp2)]).toEqual(before);
    expect(before).toEqual(['Active', 'Active']);
  });

  it('14. no historical payroll changes across the same full batch lifecycle', () => {
    const fixture = createFixture('No Payroll Changes');
    const employeeId = createEmployee(fixture, 'Payroll Unaffected Employee');
    exec(
      `INSERT INTO payroll (tenant_id, employee_id, month, basic_salary, gross_pay, net_pay, uniform_deduction, approval_status) ` +
      `VALUES ('${fixture.tenantId}', '${employeeId}', '2026-10', 100000, 100000, 90000, 10000, 'approved')`
    );
    const before = queryRow(`SELECT basic_salary, gross_pay, net_pay, uniform_deduction, approval_status FROM payroll WHERE employee_id = '${employeeId}'`);

    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Payroll Unaffected Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);
    queryRow(`SELECT remove_employee_from_batch('${batchId}'::uuid, '${employeeId}'::uuid, 'test cleanup')`);
    queryRow(`SELECT close_terminal_due_batch('${batchId}'::uuid)`);

    const after = queryRow(`SELECT basic_salary, gross_pay, net_pay, uniform_deduction, approval_status FROM payroll WHERE employee_id = '${employeeId}'`);
    expect(after).toEqual(before);
  });

  it('15. every batch mutation produces a correctly-attributed audit_logs entry', () => {
    const fixture = createFixture('Audit Attribution');
    const employeeId = createEmployee(fixture, 'Audit Attribution Employee');
    const [batchId] = queryRow(`SELECT (create_terminal_due_batch('Audit Attribution Batch'))->>'id'`);
    queryJson(`SELECT add_employees_to_batch('${batchId}'::uuid, ARRAY['${employeeId}'::uuid])`);
    queryRow(`SELECT remove_employee_from_batch('${batchId}'::uuid, '${employeeId}'::uuid, 'audit trail check')`);
    queryRow(`SELECT close_terminal_due_batch('${batchId}'::uuid)`);

    const rows = queryRows(
      `SELECT action, user_id FROM audit_logs WHERE entity_type = 'terminal_due_batch' AND entity_id = '${batchId}' ORDER BY created_at`
    );
    expect(rows.map(r => r[0])).toEqual(['CREATE', 'UPDATE', 'UPDATE', 'UPDATE']);
    for (const row of rows) {
      expect(row[1]).toBe(fixture.callerId);
    }
  });
});
