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
  // uniform_deduction_default (4200) is the tenant-wide uniform rate --
  // every employee below has no employees.uniform_deduction override and
  // no `positions` row (so requires_uniform defaults to true), so this is
  // the figure the new uniform-verification logic should independently
  // derive and match against the submitted bundle's remainder.
  exec(`INSERT INTO system_settings (tenant_id, key, value) VALUES
    ('${tenantId}', 'paye_rate', '0'),
    ('${tenantId}', 'paye_threshold', '0'),
    ('${tenantId}', 'pension_employee_rate', '0'),
    ('${tenantId}', 'absent_day_deduction', '5000'),
    ('${tenantId}', 'late_day_deduction', '2000'),
    ('${tenantId}', 'uniform_deduction_default', '4200')`);
  return { tenantId, callerId };
}

// uniformDeduction defaults to 4200 -- matching this suite's assumed
// uniform component throughout -- mirroring how this app actually
// populates employees.uniform_deduction explicitly at creation time
// (Employees.tsx), not left at the schema's bare `0` default. Pass NULL
// explicitly to simulate a legacy employee whose own override was never
// set (the "fall back to the tenant's live default rate" case).
function createEmployee(fixture: Fixture, fullName: string, uniformDeduction: number | null = 4200): string {
  const employeeId = randomUUID();
  const uniformLiteral = uniformDeduction === null ? 'NULL' : String(uniformDeduction);
  exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, basic_salary, hire_date, uniform_deduction) VALUES ('${employeeId}', '${fixture.tenantId}', 'E-${employeeId.slice(0, 8)}', '${fullName}', 'Active', false, 100000, '2020-01-01', ${uniformLiteral})`);
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

  // ===== Uniform-remainder verification (completion-pass review item 2) =====
  // A bare remainder (submitted total minus the four evidenced
  // categories) is not by itself proof it is a genuine uniform charge --
  // these prove the independent cross-check against the employee's own
  // profile/position actually gates whether it is ever labeled 'uniform'.

  it('uniform-verified: an employee\'s own uniform_deduction override (not the tenant default) is matched and labeled Uniform', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Uniform Override Employee', 3000); // tenant default is 4200
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 3000 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    expect(snapshotByCategory(rows, 'uniform')).toMatchObject({ amount: 3000, source: 'uniform_rate_config' });
    expect(rows.find(r => r.category === 'unallocated')).toBeUndefined();
  });

  it('uniform-verified: a position ineligible for a uniform (requires_uniform = false) verifies a genuine zero, not unallocated', () => {
    const fixture = createFixture();
    exec(`INSERT INTO positions (tenant_id, name, requires_uniform) VALUES ('${fixture.tenantId}', 'Office Clerk', false)`);
    const employeeId = randomUUID();
    exec(`INSERT INTO employees (id, tenant_id, employee_number, full_name, position, status, is_deleted, basic_salary, hire_date, uniform_deduction) VALUES ('${employeeId}', '${fixture.tenantId}', 'E-${employeeId.slice(0, 8)}', 'Clerk Employee', 'Office Clerk', 'Active', false, 100000, '2020-01-01', 4200)`);
    insertAttendance(fixture, employeeId, '2026-11-03', 'A');
    // Position doesn't require a uniform -- the bundled total should be
    // ONLY the absence charge, nothing uniform-shaped left over.
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 5000 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    expect(snapshotByCategory(rows, 'uniform')).toMatchObject({ amount: 0, source: 'uniform_rate_config' });
    expect(rows.find(r => r.category === 'unallocated')).toBeUndefined();
  });

  it('F: an unexplained remainder with no determinable uniform figure is recorded as unallocated, never relabeled Uniform', () => {
    const fixture = createFixture();
    // No employees.uniform_deduction override, AND no tenant-configured
    // uniform_deduction_default -- nothing to verify the remainder against.
    exec(`DELETE FROM system_settings WHERE tenant_id = '${fixture.tenantId}' AND key = 'uniform_deduction_default'`);
    const employeeId = createEmployee(fixture, 'Unverifiable Remainder Employee', null);
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    expect(snapshotByCategory(rows, 'uniform')).toMatchObject({ amount: 0 });
    expect(snapshotByCategory(rows, 'unallocated')).toMatchObject({ amount: 4200, source: 'unresolved_remainder' });

    const unresolved = queryScalar(`SELECT new_data->>'employeeDeductionSnapshotUnresolvedUniform' FROM audit_logs WHERE entity_type = 'payroll' ORDER BY created_at DESC LIMIT 1`);
    expect(unresolved).toContain(employeeId);
  });

  it('F (continued): an employee\'s override that disagrees with the actual remainder is never trusted either -- still unallocated, never a fabricated Uniform figure', () => {
    const fixture = createFixture();
    // Override claims 3000, but the submitted bundle only leaves 1000
    // unaccounted for (after a genuine 4200-worth-is-impossible scenario
    // -- here the bundle itself is smaller than the stated override).
    const employeeId = createEmployee(fixture, 'Mismatched Override Employee', 3000);
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 1000 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    expect(snapshotByCategory(rows, 'uniform')).toMatchObject({ amount: 0 });
    expect(snapshotByCategory(rows, 'unallocated')).toMatchObject({ amount: 1000, source: 'unresolved_remainder' });
  });

  it('rounding (instruction #10): a sub-1-Kwacha remainder is discarded as negligible but never vanishes without a trace -- it stays visible in the uniform row\'s own calculation_context', () => {
    const fixture = createFixture();
    // No override and no tenant default -- the remainder cannot be
    // independently verified either way, so without this audit trail it
    // would otherwise disappear leaving zero evidence it ever existed.
    exec(`DELETE FROM system_settings WHERE tenant_id = '${fixture.tenantId}' AND key = 'uniform_deduction_default'`);
    const employeeId = createEmployee(fixture, 'Sub-Tolerance Remainder Employee', null);
    // Bundle is 0.60 more than the zero evidenced categories -- within
    // the 1-Kwacha tolerance, so no 'unallocated' row is written.
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 0.6 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    expect(snapshotByCategory(rows, 'uniform')).toMatchObject({ amount: 0 });
    expect(rows.find(r => r.category === 'unallocated')).toBeUndefined();

    const uniformContext = queryScalar(`SELECT calculation_context->>'rawRemainderBeforeTolerance' FROM payroll_deduction_snapshots WHERE payroll_id = '${payroll.id}' AND category = 'uniform'`);
    expect(Number(uniformContext)).toBeCloseTo(0.6, 5);
  });

  it('rounding (instruction #10): when the remainder agrees with the live-verified uniform figure within tolerance, the recorded amount is the verified figure, and the true pre-tolerance remainder is still independently auditable', () => {
    const fixture = createFixture();
    // Tenant default is 4200; the submitted bundle leaves 4200.4 unaccounted
    // for (0.4 off from the live-verified figure, within tolerance).
    const employeeId = createEmployee(fixture, 'Within-Tolerance Verified Employee', null);
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200.4 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    // Recorded as the independently-verified live figure (4200), not the
    // raw 4200.4 remainder -- this is the deliberate "trust the verified
    // source over the bare leftover" rule, never a fabrication beyond
    // the shared 1-Kwacha tolerance.
    expect(snapshotByCategory(rows, 'uniform')).toMatchObject({ amount: 4200 });
    expect(rows.find(r => r.category === 'unallocated')).toBeUndefined();

    const uniformContext = queryScalar(`SELECT calculation_context->>'rawRemainderBeforeTolerance' FROM payroll_deduction_snapshots WHERE payroll_id = '${payroll.id}' AND category = 'uniform'`);
    expect(Number(uniformContext)).toBeCloseTo(4200.4, 5);
  });

  it('rounding (instruction #10): a remainder beyond the tolerance is always fully recorded as unallocated -- nothing beyond 1 Kwacha is ever silently dropped or folded into uniform', () => {
    const fixture = createFixture();
    exec(`DELETE FROM system_settings WHERE tenant_id = '${fixture.tenantId}' AND key = 'uniform_deduction_default'`);
    const employeeId = createEmployee(fixture, 'Beyond-Tolerance Remainder Employee', null);
    // 2.50 is beyond the 1-Kwacha tolerance -- must be fully preserved as
    // 'unallocated', not clamped, rounded away, or partially dropped.
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 2.5 }]);

    const payroll = getPayrollRow(employeeId, '2026-11');
    const rows = getSnapshotRows(payroll.id);
    expect(snapshotByCategory(rows, 'uniform')).toMatchObject({ amount: 0 });
    expect(snapshotByCategory(rows, 'unallocated')).toMatchObject({ amount: 2.5, source: 'unresolved_remainder' });

    // The sum of every recorded category row reconciles EXACTLY with the
    // committed bundled total -- nothing lost, nothing double-counted.
    const total = rows.reduce((sum, r) => sum + r.amount, 0);
    expect(total).toBeCloseTo(2.5, 5);
  });

  it('uniform-verified + rate change: a verified uniform snapshot keeps its frozen amount even after the employee\'s own override later changes', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Uniform Rate Change Employee', 3000);
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 3000 }]);
    const payroll = getPayrollRow(employeeId, '2026-11');
    approvePayroll(payroll.id);

    exec(`UPDATE employees SET uniform_deduction = 9999 WHERE id = '${employeeId}'`);

    const rows = getSnapshotRows(payroll.id);
    expect(snapshotByCategory(rows, 'uniform').amount).toBe(3000);
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

    // C: the salary advance repayment (10000) is never folded into the
    // uniform/attendance snapshot -- the snapshot only ever decomposes
    // payroll.uniform_deduction (4200 here), a wholly separate column
    // from payroll.salary_advance_deduction.
    const rows = getSnapshotRows(payroll.id);
    const snapshotTotal = rows.reduce((sum, r) => sum + r.amount, 0);
    expect(snapshotTotal).toBe(4200);
    expect(rows.some(r => r.category.toLowerCase().includes('advance'))).toBe(false);
  });

  // ===== Snapshot immutability (completion-pass review item 3) =====
  it('K2: payroll_deduction_snapshots has NO delete policy of any kind -- RLS denies DELETE to every ordinary role by default', () => {
    // This repo's disposable-Postgres integration tests always connect as
    // the bootstrap's own Postgres superuser (see this file's header and
    // bootstrap_stub.sql's own "every RPC call runs as the bootstrap's
    // own superuser" note) -- RLS is never enforced for a superuser or
    // table owner regardless of policy, so a real restricted-role DELETE
    // attempt cannot be exercised through this harness (true of every
    // other integration test in this repo, not unique to this file).
    // What CAN be verified directly, and is the actual fix: the policy
    // catalog itself has zero DELETE policies on this table, so under
    // Supabase's real `authenticated` role (subject to RLS), a bare
    // DELETE is denied by RLS's default-deny with no matching policy --
    // there is no "is_super_admin() = true" grant left to exploit.
    const [deletePolicyCount] = queryRows(`SELECT count(*) FROM pg_policy WHERE polrelid = 'payroll_deduction_snapshots'::regclass AND polcmd = 'd'`)[0];
    expect(Number(deletePolicyCount)).toBe(0);

    const [rlsEnabled] = queryRows(`SELECT relrowsecurity FROM pg_class WHERE oid = 'payroll_deduction_snapshots'::regclass`)[0];
    expect(rlsEnabled).toBe('t');
  });

  it('L2: the only path that removes a snapshot row -- cascading from a not-yet-approved payroll row\'s own delete -- still works with zero delete policies on this table', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'Cascade Without Policy Employee');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);
    const payroll = getPayrollRow(employeeId, '2026-11');
    expect(getSnapshotRows(payroll.id).length).toBeGreaterThan(0);

    // Reprocessing (not yet approved) deletes+reinserts the payroll row --
    // this must still cascade-delete the old snapshot despite there
    // being no DELETE policy granting that directly.
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);
    expect(queryRows(`SELECT id FROM payroll_deduction_snapshots WHERE payroll_id = '${payroll.id}'`)).toHaveLength(0);
  });
});

// ===== RLS under the REAL `authenticated` role (instruction #9) =====
// Every other test in this file -- and, per bootstrap_stub.sql's own
// header, every other integration test in this repo -- connects as the
// bootstrap's own Postgres superuser, which bypasses RLS entirely
// regardless of policy content (true of K2 above too, which could only
// verify the *policy catalog*, not actual enforcement). This block is
// the one place that genuinely switches the acting Postgres role to
// `authenticated` mid-session and exercises the real RLS engine against
// it, closing that gap directly.
function grantAuthenticatedBlanketPrivileges(): void {
  // A real Supabase project grants blanket SELECT/INSERT/UPDATE/DELETE
  // on every public-schema table to the `authenticated` role automatically,
  // OUTSIDE of any migration file -- RLS is the actual access-control
  // layer, not the GRANT. supabase/ci/bootstrap_stub.sql deliberately does
  // NOT replicate this platform default (see its own header), so without
  // this, every query below would fail at the GRANT layer and never
  // reach RLS at all -- this simulates exactly what production already
  // does, it does not loosen anything beyond that.
  exec('GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_deduction_snapshots TO authenticated');
  exec('GRANT SELECT ON payroll TO authenticated');
}

/**
 * Runs `sql` as the real `authenticated` Postgres role, not the
 * bootstrap's own superuser. set_caller() and SET ROLE MUST be sent in
 * the SAME psql invocation as `sql` (hence the one semicolon-joined -c
 * string) -- each separate execFileSync('psql', ...) call opens a brand
 * new connection, so a role switch (or set_caller's effect, which is
 * itself connection-local only insofar as it's committed -- it IS
 * committed, but the role switch is not) made in one call never carries
 * over to the next. set_caller() is called here while still the
 * superuser, since in production an ordinary authenticated role has no
 * reason to be grantable write access to this test-only table either.
 */
function execAsAuthenticated(callerId: string, sql: string): string {
  const combined = `SELECT set_caller('${callerId}'); SET ROLE authenticated; ${sql}; RESET ROLE;`;
  const out = execFileSync('psql', ['-t', '-A', '-c', combined], { encoding: 'utf-8' });
  // Strips the SET/RESET command-tag lines and the blank line the void
  // set_caller() call prints in tuples-only mode, leaving just `sql`'s
  // own output -- the only thing any caller here actually wants.
  return out.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l !== 'SET' && l !== 'RESET').join('\n');
}

function execAsAuthenticatedExpectError(callerId: string, sql: string): string {
  const combined = `SELECT set_caller('${callerId}'); SET ROLE authenticated; ${sql}; RESET ROLE;`;
  try {
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-c', combined], { stdio: ['ignore', 'pipe', 'pipe'] });
    throw new Error('Expected this statement to fail under the authenticated role, but it succeeded: ' + sql);
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr;
    return stderr ? stderr.toString('utf-8') : String(err);
  }
}

describe.skipIf(!dbAvailable && !dbRequired)('payroll_deduction_snapshots RLS under the real `authenticated` role (not the bootstrap superuser)', () => {
  beforeAll(() => {
    grantAuthenticatedBlanketPrivileges();
  });

  it('an authorized super-admin reading as `authenticated` sees the rows their own policy grants -- genuine RLS enforcement, not a superuser bypass', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'RLS Authorized Super-Admin Employee');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);
    const payroll = getPayrollRow(employeeId, '2026-11');

    const count = execAsAuthenticated(fixture.callerId, `SELECT count(*) FROM payroll_deduction_snapshots WHERE payroll_id = '${payroll.id}'`);
    expect(Number(count)).toBeGreaterThan(0);
  });

  it('an unauthorized same-tenant viewer (role_level 5, no payroll.view permission) reading as `authenticated` sees zero rows for payroll they have no business viewing', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'RLS Unauthorized Viewer Employee');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);
    const payroll = getPayrollRow(employeeId, '2026-11');

    const restrictedViewerId = randomUUID();
    exec(`INSERT INTO auth.users (id) VALUES ('${restrictedViewerId}')`);
    exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, role_level) VALUES ('${restrictedViewerId}', '${fixture.tenantId}', false, true, 5)`);

    const count = execAsAuthenticated(restrictedViewerId, `SELECT count(*) FROM payroll_deduction_snapshots WHERE payroll_id = '${payroll.id}'`);
    expect(Number(count)).toBe(0);
  });

  it('tenant isolation holds even for a role_level <=2 viewer that bypasses the permission check -- a different tenant\'s rows are still zero', () => {
    const fixtureA = createFixture();
    const employeeA = createEmployee(fixtureA, 'RLS Tenant A Employee');
    processBatch('2026-11', [{ employee_id: employeeA, basic_salary: 100000, uniform_deduction: 4200 }]);
    const payrollA = getPayrollRow(employeeA, '2026-11');

    const fixtureB = createFixture();
    const viewerInTenantB = randomUUID();
    exec(`INSERT INTO auth.users (id) VALUES ('${viewerInTenantB}')`);
    // role_level 2 bypasses the has_permission('payroll.view') check
    // entirely ("current_user_role_level() <= 2 OR has_permission(...)")
    // -- the tenant_id equality check is the ONLY thing standing between
    // this profile and tenant A's rows, so this specifically proves that
    // check still holds under the real role, not merely in the policy text.
    exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active, role_level) VALUES ('${viewerInTenantB}', '${fixtureB.tenantId}', false, true, 2)`);

    const count = execAsAuthenticated(viewerInTenantB, `SELECT count(*) FROM payroll_deduction_snapshots WHERE payroll_id = '${payrollA.id}'`);
    expect(Number(count)).toBe(0);
  });

  it('INSERT as `authenticated` is rejected by RLS even for an otherwise-fully-authorized super-admin -- there is no write path except process_payroll_batch()', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'RLS Insert Rejection Employee');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);
    const payroll = getPayrollRow(employeeId, '2026-11');

    const stderr = execAsAuthenticatedExpectError(
      fixture.callerId,
      `INSERT INTO payroll_deduction_snapshots (tenant_id, payroll_id, employee_id, month, category, amount, source) VALUES ('${fixture.tenantId}', '${payroll.id}', '${employeeId}', '2026-11', 'unallocated', 99999, 'uniform_rate_config')`
    );
    expect(stderr).toContain('row-level security policy');
  });

  it('UPDATE as `authenticated` affects zero rows, even for a super-admin, and the row\'s original values are left exactly as committed', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'RLS Update Rejection Employee');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);
    const payroll = getPayrollRow(employeeId, '2026-11');
    const before = getSnapshotRows(payroll.id);

    const result = execAsAuthenticated(fixture.callerId, `UPDATE payroll_deduction_snapshots SET amount = 1 WHERE payroll_id = '${payroll.id}'`);
    expect(result).toBe('UPDATE 0');
    expect(getSnapshotRows(payroll.id)).toEqual(before);
  });

  it('DELETE as `authenticated` affects zero rows, even for a super-admin, and every row survives untouched', () => {
    const fixture = createFixture();
    const employeeId = createEmployee(fixture, 'RLS Delete Rejection Employee');
    processBatch('2026-11', [{ employee_id: employeeId, basic_salary: 100000, uniform_deduction: 4200 }]);
    const payroll = getPayrollRow(employeeId, '2026-11');
    const before = getSnapshotRows(payroll.id);
    expect(before.length).toBeGreaterThan(0);

    const result = execAsAuthenticated(fixture.callerId, `DELETE FROM payroll_deduction_snapshots WHERE payroll_id = '${payroll.id}'`);
    expect(result).toBe('DELETE 0');
    expect(getSnapshotRows(payroll.id)).toEqual(before);
  });
});
