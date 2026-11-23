// Terminal Dues -- legacy direct-payment / allocation-ledger
// double-payment guard (20261128000000_terminal_dues_legacy_payment_
// allocation_guard.sql).
//
// Integration coverage for the real, unmodified RPCs
// (record_terminal_due_payment, propose/approve/reject_terminal_due_
// allocation, process_terminal_due_allocations_batch, approve_terminal_
// due, submit_terminal_due_calculation) against a disposable Postgres
// loaded with the exact schema in supabase/migrations/ -- same
// convention as employeeExits.test.ts (see that file's header for the
// disposable-database setup this suite shares). This suite is
// deliberately independent of PR #73/employee_exits: it exercises only
// pre-existing Terminal Dues tables and RPCs.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'child_process';
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

/** For a single-column query returning one JSONB value -- avoids queryRow's comma-splitting, which would corrupt JSON text containing commas. */
function queryJson(sql: string): Record<string, unknown> {
  const out = execFileSync('psql', ['-t', '-A', '-c', sql], { encoding: 'utf-8' }).trim();
  return JSON.parse(out);
}

/**
 * Holds the SAME entitlement-level advisory lock record_terminal_due_
 * payment/propose_terminal_due_allocation/approve_terminal_due_
 * allocation all take (hashtextextended(terminal_due_id::text, 0)) in a
 * separate, real, concurrent psql session for `holdMs` milliseconds.
 * Resolves `acquired` as soon as that session's log confirms it
 * actually holds the lock, so the caller can then race a real RPC call
 * against it and measure whether it was genuinely blocked.
 */
function spawnLockHolder(terminalDueId: string, holdMs: number): { acquired: Promise<void>; exited: Promise<void> } {
  const proc = spawn('psql', [
    '-c', 'BEGIN;',
    '-c', `SELECT pg_advisory_xact_lock(hashtextextended('${terminalDueId}', 0));`,
    '-c', `SELECT 'LOCK_ACQUIRED_MARKER';`,
    '-c', `SELECT pg_sleep(${(holdMs / 1000).toFixed(3)});`,
    '-c', 'COMMIT;',
  ]);
  let resolveAcquired: () => void;
  const acquired = new Promise<void>((resolve) => { resolveAcquired = resolve; });
  let buf = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf-8');
    if (buf.includes('LOCK_ACQUIRED_MARKER')) resolveAcquired();
  });
  const exited = new Promise<void>((resolve) => proc.on('exit', () => resolve()));
  return { acquired, exited };
}

interface Fixture {
  tenantId: string;
  callerId: string;
  employeeId: string;
}

function createFixture(label: string): Fixture {
  const tenantId = randomUUID();
  const callerId = randomUUID();
  const employeeId = randomUUID();

  exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', 'Integration Test Tenant', 'ITT-${tenantId.slice(0, 8)}')`);
  exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
  exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active) VALUES ('${callerId}', '${tenantId}', true, true)`);
  exec(`SELECT set_caller('${callerId}')`);
  exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, basic_salary, hire_date) VALUES ('${employeeId}', '${tenantId}', 'E-${employeeId.slice(0, 8)}', '${label}', 'Active', false, 100000, '2020-01-01')`);
  exec(`INSERT INTO system_settings (tenant_id, key, value) VALUES ('${tenantId}', 'current_payroll_month', '2026-11')`);

  return { tenantId, callerId, employeeId };
}

/** A legacy direct-create terminal_dues row (NOT via submit_terminal_due_calculation), approved. */
function createApprovedLegacyDue(fixture: Fixture, label: string, totalPayable: number): string {
  exec(
    `INSERT INTO terminal_dues (tenant_id, employee_id, employee_name, employee_number, position, date_joined, date_left, period_months, basic_salary, gratuity, annual_leave, uniform_refund, other_benefits, subtotal, deductions, total_payable, status) ` +
    `VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '${label}', 'E-LEG', 'Guard', '2020-01-01', '2026-11-10', 82, 100000, ${totalPayable}, 0, 0, 0, ${totalPayable}, 0, ${totalPayable}, 'pending')`
  );
  const [id] = queryRow(`SELECT id FROM terminal_dues WHERE employee_id = '${fixture.employeeId}' ORDER BY created_at DESC LIMIT 1`);
  queryRow(`SELECT approve_terminal_due('${id}'::uuid)`);
  return id;
}

function terminalDueStatus(id: string): string {
  const [status] = queryRow(`SELECT status FROM terminal_dues WHERE id = '${id}'`);
  return status;
}

describe.skipIf(!dbAvailable && !dbRequired)('Terminal Dues: legacy payment / allocation-ledger double-payment guard (real SQL functions, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      throw new Error('Disposable Postgres is required for this suite (ATTENDANCE_PARITY_REQUIRE_DB=1) but is not reachable.');
    }
  });

  it('1. an approved legacy settlement with NO allocations can still use the existing direct-payment workflow unchanged', () => {
    const fixture = createFixture('Unallocated Legacy');
    const dueId = createApprovedLegacyDue(fixture, 'Unallocated Legacy', 500000);
    const [status] = queryRow(`SELECT (record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-1', NULL))->>'status'`);
    expect(status).toBe('paid');
    expect(terminalDueStatus(dueId)).toBe('paid');
    expect(queryRow(`SELECT total_payable FROM terminal_dues WHERE id = '${dueId}'`)).toEqual(['500000.00']);
  });

  it('2. an APPROVED (not yet processed) allocation blocks a conflicting direct payment', () => {
    const fixture = createFixture('Approved Allocation Blocks');
    const dueId = createApprovedLegacyDue(fixture, 'Approved Allocation Blocks', 820000);
    const [allocId] = queryRow(`SELECT (propose_terminal_due_allocation('${dueId}'::uuid, 820000))->>'id'`);
    queryRow(`SELECT approve_terminal_due_allocation('${allocId}'::uuid)`);

    const stderr = execExpectError(`SELECT record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-2', NULL)`);
    expect(stderr).toMatch(/active or processed payment allocation/i);
    expect(terminalDueStatus(dueId)).toBe('approved'); // unchanged -- not silently paid
  });

  it('3. a fully PROCESSED allocation (run through a payroll batch) blocks a conflicting direct payment', () => {
    const fixture = createFixture('Processed Allocation Blocks');
    const dueId = createApprovedLegacyDue(fixture, 'Processed Allocation Blocks', 820000);
    const [allocId] = queryRow(`SELECT (propose_terminal_due_allocation('${dueId}'::uuid, 820000))->>'id'`);
    queryRow(`SELECT approve_terminal_due_allocation('${allocId}'::uuid)`);
    queryRow(`SELECT process_terminal_due_allocations_batch()`);
    expect(queryRow(`SELECT status FROM terminal_due_allocations WHERE id = '${allocId}'`)).toEqual(['processed']);

    const stderr = execExpectError(`SELECT record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-3', NULL)`);
    expect(stderr).toMatch(/active or processed payment allocation/i);
    expect(terminalDueStatus(dueId)).toBe('approved'); // the original confirmed double-payment reproduction, now blocked
  });

  it('4. a directly-paid settlement cannot receive a new payable allocation (pre-existing protection, re-confirmed unaffected)', () => {
    const fixture = createFixture('Paid Blocks New Allocation');
    const dueId = createApprovedLegacyDue(fixture, 'Paid Blocks New Allocation', 300000);
    queryRow(`SELECT record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-4', NULL)`);
    expect(terminalDueStatus(dueId)).toBe('paid');

    const stderr = execExpectError(`SELECT propose_terminal_due_allocation('${dueId}'::uuid, 300000)`);
    expect(stderr).toMatch(/only an admin-approved entitlement can receive a payment allocation/i);
  });

  it('5. a modern calculator-originated settlement retains its existing, unconditional direct-payment block', () => {
    const fixture = createFixture('Modern Calculator Settlement');
    const inputs = JSON.stringify({ dateJoined: '2020-01-01', dateLeft: '2026-11-10', finalSalary: 100000, uniformDeductionMonths: 0, uniformRefundRatePerMonth: 10000 });
    const breakdown = JSON.stringify({ effectiveMonths: 82, pensionArrears: 820000, annualLeaveRefund: 0, uniformRefund: 0, outstandingSalaryTotal: 0, totalEntitlements: 820000, lessNoticeDeduction: 0, totalPayable: 820000 });
    exec(
      `INSERT INTO terminal_due_calculations (tenant_id, employee_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable, created_by) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.employeeId}', NULL, 'Modern Calculator Settlement', 'E-MOD', 'Guard', '${inputs}'::jsonb, '${breakdown}'::jsonb, 820000, '${fixture.callerId}')`
    );
    const [draftId] = queryRow(`SELECT id FROM terminal_due_calculations WHERE employee_id = '${fixture.employeeId}'`);
    queryRow(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    const [dueId] = queryRow(`SELECT id FROM terminal_dues WHERE employee_id = '${fixture.employeeId}'`);
    queryRow(`SELECT approve_terminal_due('${dueId}'::uuid)`);

    // No allocation exists at all here -- the NEW guard would not fire on its own.
    // The pre-existing Phase 1.5 guard must still fire first, unconditionally.
    const stderr = execExpectError(`SELECT record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-5', NULL)`);
    expect(stderr).toMatch(/originated from a modern Terminal Dues calculation/i);
  });

  it('6. a REJECTED allocation never counts -- direct payment remains available afterward', () => {
    const fixture = createFixture('Rejected Allocation No Block');
    const dueId = createApprovedLegacyDue(fixture, 'Rejected Allocation No Block', 400000);
    const [allocId] = queryRow(`SELECT (propose_terminal_due_allocation('${dueId}'::uuid, 400000))->>'id'`);
    queryRow(`SELECT reject_terminal_due_allocation('${allocId}'::uuid, 'HR entered the wrong amount')`);
    expect(queryRow(`SELECT status FROM terminal_due_allocations WHERE id = '${allocId}'`)).toEqual(['rejected']);

    const [status] = queryRow(`SELECT (record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-6', NULL))->>'status'`);
    expect(status).toBe('paid');
    expect(terminalDueStatus(dueId)).toBe('paid');
  });

  it('6b. an EXCLUDED allocation (explicitly excluded from a payroll run) never counts -- direct payment remains available afterward', () => {
    const fixture = createFixture('Excluded Allocation No Block');
    const dueId = createApprovedLegacyDue(fixture, 'Excluded Allocation No Block', 400000);
    const [allocId] = queryRow(`SELECT (propose_terminal_due_allocation('${dueId}'::uuid, 400000))->>'id'`);
    queryRow(`SELECT approve_terminal_due_allocation('${allocId}'::uuid)`);
    queryRow(`SELECT process_terminal_due_allocations_batch(ARRAY['${allocId}']::uuid[], 'excluded for this cycle, settling directly instead')`);
    expect(queryRow(`SELECT status FROM terminal_due_allocations WHERE id = '${allocId}'`)).toEqual(['excluded']);

    const [status] = queryRow(`SELECT (record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-6b', NULL))->>'status'`);
    expect(status).toBe('paid');
    expect(terminalDueStatus(dueId)).toBe('paid');
  });

  it('7. multiple partial allocations across different months cannot exceed the entitlement (pre-existing protection, regression-checked)', () => {
    const fixture = createFixture('Partial Allocations Cap');
    const dueId = createApprovedLegacyDue(fixture, 'Partial Allocations Cap', 500000);
    const [alloc1] = queryRow(`SELECT (propose_terminal_due_allocation('${dueId}'::uuid, 300000))->>'id'`);
    queryRow(`SELECT approve_terminal_due_allocation('${alloc1}'::uuid)`);

    // A second allocation for a DIFFERENT payroll month -- the cap is
    // enforced across all months for the same entitlement, not per-month.
    exec(`UPDATE system_settings SET value = '2026-12' WHERE tenant_id = '${fixture.tenantId}' AND key = 'current_payroll_month'`);
    const stderr = execExpectError(`SELECT propose_terminal_due_allocation('${dueId}'::uuid, 250000)`);
    expect(stderr).toMatch(/exceeds the available outstanding balance/i);
  });

  it('8. repeated allocation-batch processing cannot double-pay (idempotent by construction, regression-checked)', () => {
    const fixture = createFixture('Repeated Processing Idempotent');
    const dueId = createApprovedLegacyDue(fixture, 'Repeated Processing Idempotent', 600000);
    const [allocId] = queryRow(`SELECT (propose_terminal_due_allocation('${dueId}'::uuid, 600000))->>'id'`);
    queryRow(`SELECT approve_terminal_due_allocation('${allocId}'::uuid)`);

    const firstRun = queryJson(`SELECT process_terminal_due_allocations_batch()`);
    expect(firstRun.processed_count).toBe(1);
    expect(firstRun.total_amount).toBe(600000);

    const secondRun = queryJson(`SELECT process_terminal_due_allocations_batch()`);
    expect(secondRun.processed_count).toBe(0);
    expect(secondRun.total_amount).toBe(0);
    expect(queryRow(`SELECT last_decided_amount FROM terminal_due_allocations WHERE id = '${allocId}'`)).toEqual(['600000.00']);
  });

  it('9. a concurrent payment request for the same entitlement is genuinely serialized (blocked, not raced) against a held allocation-lock, via the shared advisory lock', async () => {
    const fixture = createFixture('Concurrent Lock Serialization');
    const dueId = createApprovedLegacyDue(fixture, 'Concurrent Lock Serialization', 250000);

    const holdMs = 1500;
    const { acquired, exited } = spawnLockHolder(dueId, holdMs);
    await acquired; // the background session now genuinely holds the SAME advisory lock record_terminal_due_payment takes

    const start = Date.now();
    const [status] = queryRow(`SELECT (record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-9', NULL))->>'status'`);
    const elapsedMs = Date.now() - start;

    expect(status).toBe('paid');
    expect(terminalDueStatus(dueId)).toBe('paid');
    // Proves this call genuinely waited for the background session's lock to release, rather than racing ahead of it.
    expect(elapsedMs).toBeGreaterThan(holdMs * 0.7);

    await exited; // cleanup -- let the background session fully exit before the test ends
  });

  it('10. cross-tenant and unauthorized operations are rejected', () => {
    const fixture = createFixture('Tenant Role Isolation Target');
    const dueId = createApprovedLegacyDue(fixture, 'Tenant Role Isolation Target', 350000);

    // Cross-tenant: a different tenant's accountant cannot even find this row.
    // role='accountant' requires a non-null region_id (profiles_functional_role_region_required).
    const otherTenantId = randomUUID();
    const otherCallerId = randomUUID();
    const otherRegionId = randomUUID();
    exec(`INSERT INTO tenants (id, name, code) VALUES ('${otherTenantId}', 'Other Tenant', 'OTH-${otherTenantId.slice(0, 8)}')`);
    exec(`INSERT INTO regions (id, tenant_id, name, code) VALUES ('${otherRegionId}', '${otherTenantId}', 'Other Region', 'OTH-R-${otherTenantId.slice(0, 8)}')`);
    exec(`INSERT INTO auth.users (id) VALUES ('${otherCallerId}')`);
    // role_permissions is a global (not tenant-scoped) matrix; 'accountant' already carries terminal_dues.pay in the base schema seed.
    exec(`INSERT INTO profiles (id, tenant_id, region_id, is_super_admin, is_active, role) VALUES ('${otherCallerId}', '${otherTenantId}', '${otherRegionId}', false, true, 'accountant')`);
    exec(`SELECT set_caller('${otherCallerId}')`);
    const stderr = execExpectError(`SELECT record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-10a', NULL)`);
    expect(stderr).toMatch(/not found/i);

    // Unauthorized: same tenant, but no terminal_dues.pay permission at all.
    exec(`SELECT set_caller('${fixture.callerId}')`);
    const unprivilegedId = randomUUID();
    const unprivilegedRegionId = randomUUID();
    exec(`INSERT INTO auth.users (id) VALUES ('${unprivilegedId}')`);
    exec(`INSERT INTO regions (id, tenant_id, name, code) VALUES ('${unprivilegedRegionId}', '${fixture.tenantId}', 'Unprivileged Region', 'UNP-R-${unprivilegedRegionId.slice(0, 8)}')`);
    // role='hr_manager' requires a non-null region_id; hr_manager has no terminal_dues.pay permission in the base schema seed.
    exec(`INSERT INTO profiles (id, tenant_id, region_id, is_super_admin, is_active, role) VALUES ('${unprivilegedId}', '${fixture.tenantId}', '${unprivilegedRegionId}', false, true, 'hr_manager')`);
    exec(`SELECT set_caller('${unprivilegedId}')`);
    const stderr2 = execExpectError(`SELECT record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-10b', NULL)`);
    expect(stderr2).toMatch(/terminal_dues\.pay/i);

    exec(`SELECT set_caller('${fixture.callerId}')`);
  });

  it('11. existing ordinary payroll rows for an unrelated employee remain completely unaffected by this migration', () => {
    const fixture = createFixture('Payroll Unaffected By This Migration');
    exec(
      `INSERT INTO payroll (tenant_id, employee_id, month, basic_salary, gross_pay, net_pay, uniform_deduction, approval_status) ` +
      `VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '2026-10', 100000, 100000, 90000, 10000, 'approved')`
    );
    const before = queryRow(`SELECT basic_salary, gross_pay, net_pay, uniform_deduction, approval_status FROM payroll WHERE employee_id = '${fixture.employeeId}'`);

    const dueId = createApprovedLegacyDue(fixture, 'Unrelated Settlement', 200000);
    queryRow(`SELECT record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-11', NULL)`);

    const after = queryRow(`SELECT basic_salary, gross_pay, net_pay, uniform_deduction, approval_status FROM payroll WHERE employee_id = '${fixture.employeeId}'`);
    expect(after).toEqual(before);
  });

  it('12. the audit trail and payment fields for a successful direct payment are completely unchanged by this migration', () => {
    const fixture = createFixture('Audit Trail Unchanged');
    const dueId = createApprovedLegacyDue(fixture, 'Audit Trail Unchanged', 450000);
    queryRow(`SELECT record_terminal_due_payment('${dueId}'::uuid, '2026-11-20'::date, 'bank_transfer', 'REF-12', 'settled in full')`);

    const [status, paymentDate, paymentMethod, paymentReference, paymentNotes] = queryRow(
      `SELECT status, payment_date, payment_method, payment_reference, payment_notes FROM terminal_dues WHERE id = '${dueId}'`
    );
    expect(status).toBe('paid');
    expect(paymentDate).toBe('2026-11-20');
    expect(paymentMethod).toBe('bank_transfer');
    expect(paymentReference).toBe('REF-12');
    expect(paymentNotes).toBe('settled in full');

    const [action, entityType] = queryRow(
      `SELECT action, entity_type FROM audit_logs WHERE entity_id = '${dueId}' AND action = 'UPDATE' AND entity_type = 'terminal_due' ORDER BY created_at DESC LIMIT 1`
    );
    expect(action).toBe('UPDATE');
    expect(entityType).toBe('terminal_due');
  });
});
