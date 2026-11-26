// Salary Advances + Payroll & Payslip Financial Transparency audit
// (PR #82) -- integration coverage for the REAL, unmodified
// process_payroll_batch() (supabase/migrations/
// 20261204000000_payroll_deduction_snapshot_capture.sql) against a
// disposable Postgres loaded with the exact schema in
// supabase/migrations/. Same disposable-database convention as
// attendancePipelineIntegration.test.ts/employeeExits.test.ts -- see
// either file's header for the setup and supabase/ci/apply_ci_schema.sh.
// Never connects to production: PGHOST/PGPORT/PGUSER/PGPASSWORD/
// PGDATABASE (standard libpq env vars) must point at a disposable
// database for these tests to run at all.
//
// This file exists specifically because a string-matching test (the
// absentDeductionDisplay.test.ts style) cannot prove the snapshot
// capture is evidence-based rather than fabricated -- only running the
// real SQL function against real attendance/system_settings/
// employee_deductions rows and inspecting what it actually commits can.
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
  const out = execFileSync('psql', ['-t', '-A', '-F', ',', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split('\n').map((line) => line.split(',')) : [];
}

/** Single scalar field, no delimiter splitting -- safe for a value that may itself contain commas (e.g. jsonb text). */
function queryScalar(sql: string): string {
  return execFileSync('psql', ['-t', '-A', '-c', sql], { encoding: 'utf-8' }).trim();
}

function jsonbLiteral(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

interface Fixture {
  tenantId: string;
  callerId: string;
}

function createFixture(): Fixture {
  const tenantId = randomUUID();
  const callerId = randomUUID();
  exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', 'Integration Test Tenant', 'ITT-${tenantId.slice(0, 8)}')`);
  exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
  exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active) VALUES ('${callerId}', '${tenantId}', true, true)`);
  exec(`SELECT set_caller('${callerId}')`);
  // Rates this suite's expectations are all computed against. absent_day_deduction
  // and late_day_deduction are deliberately different amounts so a test
  // mixing both categories can never pass by both reading the same number.
  exec(`INSERT INTO system_settings (tenant_id, key, value) VALUES
    ('${tenantId}', 'paye_rate', '0'),
    ('${tenantId}', 'paye_threshold', '0'),
    ('${tenantId}', 'pension_employee_rate', '0'),
    ('${tenantId}', 'absent_day_deduction', '5000'),
    ('${tenantId}', 'late_day_deduction', '2000')`);
  return { tenantId, callerId };
}

function createEmployee(fixture: Fixture, fullName: string): string {
  const employeeId = randomUUID();
  exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, basic_salary, hire_date) VALUES ('${employeeId}', '${fixture.tenantId}', 'E-${employeeId.slice(0, 8)}', '${fullName}', 'Active', false, 100000, '2020-01-01')`);
  return employeeId;
}

function insertAttendance(fixture: Fixture, employeeId: string, date: string, status: 'A' | 'L' | 'P'): void {
  exec(`INSERT INTO attendance (tenant_id, employee_id, date, status, source) VALUES ('${fixture.tenantId}', '${employeeId}', '${date}', '${status}', 'manual')`);
}

interface DeductionRowInput {
  absentDays?: number;
  lateDays?: number;
  absentDeduction?: number;
  lateDeduction?: number;
  lectureDeduction?: number;
  appearanceDeduction?: number;
}

function insertEmployeeDeductionsRow(employeeId: string, month: string, d: DeductionRowInput): void {
  exec(`INSERT INTO employee_deductions (employee_id, month, absent_days, late_days, absent_deduction, late_deduction, lecture_deduction, appearance_deduction, total_deductions) VALUES (
    '${employeeId}', '${month}', ${d.absentDays ?? 0}, ${d.lateDays ?? 0}, ${d.absentDeduction ?? 0}, ${d.lateDeduction ?? 0}, ${d.lectureDeduction ?? 0}, ${d.appearanceDeduction ?? 0},
    ${(d.absentDeduction ?? 0) + (d.lateDeduction ?? 0) + (d.lectureDeduction ?? 0) + (d.appearanceDeduction ?? 0)}
  )`);
}

interface PayrollRecordInput {
  employee_id: string;
  basic_salary: number;
  uniform_deduction: number;
  net_pay?: number;
  gross_pay?: number;
}

function batchRecord(r: PayrollRecordInput) {
  const gross = r.gross_pay ?? r.basic_salary;
  return {
    employee_id: r.employee_id,
    basic_salary: r.basic_salary,
    allowances: 0,
    overtime: 0,
    bonus: 0,
    gross_pay: gross,
    paye: 0,
    pension: 0,
    uniform_deduction: r.uniform_deduction,
    net_pay: r.net_pay ?? (gross - r.uniform_deduction),
  };
}

function processBatch(month: string, records: PayrollRecordInput[]): void {
  exec(`SELECT process_payroll_batch('${month}', ${jsonbLiteral(records.map(batchRecord))}, 'tester@example.com', '{}'::jsonb)`);
}

function processBatchExpectError(month: string, records: PayrollRecordInput[]): string {
  return execExpectError(`SELECT process_payroll_batch('${month}', ${jsonbLiteral(records.map(batchRecord))}, 'tester@example.com', '{}'::jsonb)`);
}

interface PayrollRow {
  id: string;
  uniformDeduction: number;
  netPay: number;
  approvalStatus: string;
}

function getPayrollRow(employeeId: string, month: string): PayrollRow {
  const rows = queryRows(`SELECT id, uniform_deduction, net_pay, approval_status FROM payroll WHERE employee_id = '${employeeId}' AND month = '${month}'`);
  if (rows.length === 0) throw new Error(`No payroll row for ${employeeId}/${month}`);
  return { id: rows[0][0], uniformDeduction: Number(rows[0][1]), netPay: Number(rows[0][2]), approvalStatus: rows[0][3] };
}

interface SnapshotRow {
  category: string;
  amount: number;
  quantity: number | null;
  rate: number | null;
  source: string;
}

function getSnapshotRows(payrollId: string): SnapshotRow[] {
  const rows = queryRows(`SELECT category, amount, COALESCE(quantity::text, ''), COALESCE(rate::text, ''), source FROM payroll_deduction_snapshots WHERE payroll_id = '${payrollId}' ORDER BY category`);
  return rows.map(r => ({
    category: r[0],
    amount: Number(r[1]),
    quantity: r[2] === '' ? null : Number(r[2]),
    rate: r[3] === '' ? null : Number(r[3]),
    source: r[4],
  }));
}

function snapshotByCategory(rows: SnapshotRow[], category: string): SnapshotRow {
  const row = rows.find(r => r.category === category);
  if (!row) throw new Error(`No snapshot row for category ${category}`);
  return row;
}

function approvePayroll(payrollId: string): void {
  exec(`UPDATE payroll SET approval_status = 'approved' WHERE id = '${payrollId}'`);
}

function latestAuditConflicts(): string {
  return queryScalar(`SELECT new_data->>'employeeDeductionSnapshotConflicts' FROM audit_logs WHERE entity_type = 'payroll' ORDER BY created_at DESC LIMIT 1`);
}

describe.skipIf(!dbAvailable && !dbRequired)('process_payroll_batch: deduction snapshot capture (real SQL function, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error(
          'ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable -- this suite must run for real in CI, never silently skip. ' +
          'See this file\'s header and supabase/ci/apply_ci_schema.sh.'
        );
      }
      console.warn('payrollDeductionSnapshotIntegration.test.ts: no reachable Postgres -- skipping (see this file\'s header for setup).');
    }
  });

  // A. Uniform-only employee, no attendance penalties.
  it('A: a uniform-only employee (no attendance penalties) gets a genuine, evidenced zero for absence/late/lecture/appearance, and the full uniform amount under "uniform"', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Uniform Only Employee');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    expect(rows).toHaveLength(5);
    expect(snapshotByCategory(rows, 'uniform').amount).toBe(4200);
    expect(snapshotByCategory(rows, 'absence')).toMatchObject({ amount: 0, quantity: 0, rate: 5000, source: 'live_attendance_count' });
    expect(snapshotByCategory(rows, 'late')).toMatchObject({ amount: 0, quantity: 0, rate: 2000, source: 'live_attendance_count' });
    expect(snapshotByCategory(rows, 'lecture')).toMatchObject({ amount: 0, source: 'no_record_zero' });
    expect(snapshotByCategory(rows, 'appearance')).toMatchObject({ amount: 0, source: 'no_record_zero' });
  });

  // B. Employee with two absent days and a uniform deduction.
  it('B: two absent days are counted live from the attendance table and charged at the configured rate, never a hardcoded or stale one', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Two Absences Employee');
    insertAttendance(fixture, employeeId, '2026-11-03', 'A');
    insertAttendance(fixture, employeeId, '2026-11-10', 'A');
    // Bundled total = uniform (4200) + 2 absences x 5000 = 14200.
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 14200 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    expect(snapshotByCategory(rows, 'absence')).toMatchObject({ amount: 10000, quantity: 2, rate: 5000, source: 'live_attendance_count' });
    expect(snapshotByCategory(rows, 'uniform').amount).toBe(4200);
  });

  // C. Employee with late attendance and another deduction.
  it('C: late days and absence days are counted and rated independently, never conflated', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Late Plus Absence Employee');
    insertAttendance(fixture, employeeId, '2026-11-03', 'A');
    insertAttendance(fixture, employeeId, '2026-11-04', 'L');
    insertAttendance(fixture, employeeId, '2026-11-05', 'L');
    // uniform(4200) + 1 absence(5000) + 2 late(2 x 2000 = 4000) = 13200.
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 13200 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    expect(snapshotByCategory(rows, 'absence')).toMatchObject({ amount: 5000, quantity: 1, rate: 5000 });
    expect(snapshotByCategory(rows, 'late')).toMatchObject({ amount: 4000, quantity: 2, rate: 2000 });
    expect(snapshotByCategory(rows, 'uniform').amount).toBe(4200);
  });

  // D. Employee with lecture or appearance deductions.
  it('D: lecture and appearance amounts are read from the HR-entered employee_deductions row, the only source either category can ever have', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Lecture Appearance Employee');
    insertEmployeeDeductionsRow(employeeId, '2026-11', { lectureDeduction: 1500, appearanceDeduction: 800 });
    // uniform(4200) + lecture(1500) + appearance(800) = 6500.
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 6500 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    expect(snapshotByCategory(rows, 'lecture')).toMatchObject({ amount: 1500, source: 'employee_deductions_row' });
    expect(snapshotByCategory(rows, 'appearance')).toMatchObject({ amount: 800, source: 'employee_deductions_row' });
    expect(snapshotByCategory(rows, 'uniform').amount).toBe(4200);
  });

  // E. Employee with a valid existing HR deduction record (consistent with live attendance).
  it('E: an existing employee_deductions row whose absent/late figures agree with live attendance logs no conflict', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Consistent HR Record Employee');
    insertAttendance(fixture, employeeId, '2026-11-03', 'A');
    insertEmployeeDeductionsRow(employeeId, '2026-11', { absentDays: 1, absentDeduction: 5000 });
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 9200 }]);

    const conflicts = latestAuditConflicts();
    expect(conflicts).toBe('[]');
  });

  // F. Employee with an inconsistent existing deduction record.
  it('F: an existing employee_deductions row that disagrees with live attendance is flagged as a conflict, never silently accepted, and is never overwritten', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Inconsistent HR Record Employee');
    insertAttendance(fixture, employeeId, '2026-11-03', 'A');
    insertAttendance(fixture, employeeId, '2026-11-10', 'A');
    // HR's own record claims only 1 absence (5000) -- live attendance shows 2 (10000).
    insertEmployeeDeductionsRow(employeeId, '2026-11', { absentDays: 1, absentDeduction: 5000 });
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 14200 }]);

    const conflicts = latestAuditConflicts();
    expect(conflicts).not.toBe('[]');
    expect(conflicts).toContain(employeeId);
    expect(conflicts).toContain('5000');

    // employee_deductions itself is untouched -- HR's record still reads exactly as entered.
    const [storedAbsentDeduction] = queryRows(`SELECT absent_deduction FROM employee_deductions WHERE employee_id = '${employeeId}' AND month = '2026-11'`)[0];
    expect(Number(storedAbsentDeduction)).toBe(5000);

    // The snapshot itself still reflects the live-counted truth, not HR's stale figure.
    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    expect(snapshotByCategory(rows, 'absence').amount).toBe(10000);
  });

  // G. Historical rate changes after payroll processing.
  it('G: a snapshot already written keeps its original rate/amount even after the configured rate later changes', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Rate Change Employee');
    insertAttendance(fixture, employeeId, '2026-11-03', 'A');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 9200 }]);
    const payroll = getPayrollRow(employeeId, '2026-11');
    const beforeRateChange = snapshotByCategory(getSnapshotRows(payroll.id), 'absence');
    expect(beforeRateChange).toMatchObject({ amount: 5000, rate: 5000 });

    // Approve so this month can never be reprocessed, then change the live rate.
    approvePayroll(payroll.id);
    exec(`UPDATE system_settings SET value = '9999' WHERE tenant_id = '${fixture.tenantId}' AND key = 'absent_day_deduction'`);

    const afterRateChange = snapshotByCategory(getSnapshotRows(payroll.id), 'absence');
    expect(afterRateChange).toMatchObject({ amount: 5000, rate: 5000 });
    expect(afterRateChange.rate).not.toBe(9999);
  });

  // H. No fabricated zero itemization.
  it('H: when the tenant has no configured absent/late rate, no snapshot rows are written at all -- the gap stays honestly unexplained rather than a fabricated zero', () => {
    const fixture = createFixture();
    exec(`DELETE FROM system_settings WHERE tenant_id = '${fixture.tenantId}' AND key IN ('absent_day_deduction', 'late_day_deduction')`);
    const employeeId = createEmployee(fixture, 'No Rate Configured Employee');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    // Payroll itself still processed successfully -- only the snapshot step was skipped.
    expect(payroll.uniformDeduction).toBe(4200);
    const rows = getSnapshotRows(payroll.id);
    expect(rows).toHaveLength(0);
  });

  it('H (continued): the evidenced categories can never be made to exceed the submitted bundled total -- refused, nothing committed, rather than a clamped/guessed split', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Overclaimed Categories Employee');
    insertAttendance(fixture, employeeId, '2026-11-03', 'A');
    insertAttendance(fixture, employeeId, '2026-11-10', 'A');
    // 2 absences = 10000, but the submitted bundled total is only 4200 --
    // internally inconsistent, must be refused.
    const err = processBatchExpectError('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);
    expect(err).toMatch(/exceeds the submitted uniform\/attendance total/);
    expect(queryRows(`SELECT id FROM payroll WHERE employee_id = '${employeeId}'`)).toHaveLength(0);
  });

  // I. Payroll deduction totals reconcile exactly.
  it('I: the sum of every category snapshot row equals the committed bundled uniform_deduction exactly', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Reconciliation Employee');
    insertAttendance(fixture, employeeId, '2026-11-03', 'A');
    insertAttendance(fixture, employeeId, '2026-11-04', 'L');
    insertEmployeeDeductionsRow(employeeId, '2026-11', { lectureDeduction: 300, appearanceDeduction: 200 });
    // uniform(4200) + absence(5000) + late(2000) + lecture(300) + appearance(200) = 11700.
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 11700 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    const total = rows.reduce((sum, r) => sum + r.amount, 0);
    expect(total).toBe(payroll.uniformDeduction);
    expect(total).toBe(11700);
  });

  // K. Duplicate processing and idempotency.
  it('K: reprocessing the same not-yet-approved month/employee replaces the old snapshot with a fresh one (cascade-deleted with the old payroll row), never duplicating or leaving stale rows', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Reprocessed Employee');
    insertAttendance(fixture, employeeId, '2026-11-03', 'A');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 9200 }]);
    const firstPayroll = getPayrollRow(employeeId, '2026-11');
    expect(snapshotByCategory(getSnapshotRows(firstPayroll.id), 'absence').amount).toBe(5000);

    // A second absence is logged, then the SAME month is reprocessed before approval.
    insertAttendance(fixture, employeeId, '2026-11-10', 'A');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 14200 }]);

    const secondPayroll = getPayrollRow(employeeId, '2026-11');
    expect(secondPayroll.id).not.toBe(firstPayroll.id);
    // The old payroll row (and its snapshot rows, via ON DELETE CASCADE) is gone.
    expect(queryRows(`SELECT id FROM payroll WHERE id = '${firstPayroll.id}'`)).toHaveLength(0);
    expect(queryRows(`SELECT id FROM payroll_deduction_snapshots WHERE payroll_id = '${firstPayroll.id}'`)).toHaveLength(0);
    // The new snapshot reflects the updated count -- no duplicate rows for the new payroll id either.
    const secondRows = getSnapshotRows(secondPayroll.id);
    expect(secondRows).toHaveLength(5);
    expect(snapshotByCategory(secondRows, 'absence').amount).toBe(10000);
  });

  // L. Approved payroll stays unchanged.
  it('L: an approved month can never be reprocessed, and its snapshot rows are left exactly as they were', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Approved Employee');
    insertAttendance(fixture, employeeId, '2026-11-03', 'A');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 9200 }]);
    const payroll = getPayrollRow(employeeId, '2026-11');
    approvePayroll(payroll.id);

    insertAttendance(fixture, employeeId, '2026-11-10', 'A');
    const err = processBatchExpectError('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 14200 }]);
    expect(err).toMatch(/already have approved payroll/);

    const unchanged = getPayrollRow(employeeId, '2026-11');
    expect(unchanged.id).toBe(payroll.id);
    expect(unchanged.uniformDeduction).toBe(9200);
    expect(snapshotByCategory(getSnapshotRows(payroll.id), 'absence').amount).toBe(5000);
  });

  // M. Cross-tenant protection.
  it('M: an employee belonging to a different tenant is refused, exactly as before this migration', () => {
    const fixtureA = createFixture();
    const fixtureB = createFixture();
    const otherTenantEmployeeId = createEmployee(fixtureB, 'Other Tenant Employee');
    // Act as fixtureA's caller (already set by createFixture(B) overwriting
    // set_caller -- re-assert A's caller explicitly for clarity).
    exec(`SELECT set_caller('${fixtureA.callerId}')`);
    const err = processBatchExpectError('2026-11', [{ employee_id: otherTenantEmployeeId, basic_salary: 100000, uniform_deduction: 4200 }]);
    expect(err).toMatch(/do not belong to your tenant/);
  });

  // N. Salary Advances repayment remains unchanged.
  it('N: a salary advance\'s repayment ledger and balance are computed exactly as before this migration, unaffected by the new snapshot step', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Advance Repayment Employee');
    const advanceId = randomUUID();
    exec(`INSERT INTO salary_advances (id, tenant_id, employee_id, advance_amount, status, application_date, deduction_start_month, repayment_period_months, repayment_method, configured_monthly_deduction, final_deduction_amount, expected_payoff_month) VALUES ('${advanceId}', '${fixture.tenantId}', '${employeeId}', 30000, 'active', '2026-10-01', '2026-11', 3, 'repayment_period', 10000, 10000, '2027-01')`);
    exec(`INSERT INTO salary_advance_repayment_plans (employee_id, tenant_id, combined_monthly_deduction, repayment_method, repayment_period_months, deduction_start_month, expected_payoff_month) VALUES ('${employeeId}', '${fixture.tenantId}', 10000, 'repayment_period', 3, '2026-11', '2027-01')`);

    // net_pay is deliberately submitted as the BASE figure (gross - uniform_deduction,
    // no advance subtracted yet) -- process_payroll_batch() always re-applies its
    // OWN server-computed advance deduction on top, exactly as Payroll.tsx's own
    // processPayroll() submits it (see that function's own comment on why).
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);

    const [ledgerAmount] = queryRows(`SELECT deduction_amount FROM salary_advance_deductions WHERE salary_advance_id = '${advanceId}' AND payroll_month = '2026-11'`)[0];
    expect(Number(ledgerAmount)).toBe(10000);

    const [advanceStatus] = queryRows(`SELECT status FROM salary_advances WHERE id = '${advanceId}'`)[0];
    expect(advanceStatus).toBe('active'); // 30000 - 10000 = 20000 remaining, not yet paid off.

    const payroll = getPayrollRow(employeeId, '2026-11');
    expect(payroll.netPay).toBe(100000 - 4200 - 10000);
  });
});
