// Terminal Dues: variable uniform refund breakdown.
//
// update_terminal_due_calculation_draft() and submit_terminal_due_calculation()
// (see 20261130000000_terminal_dues_variable_uniform_refund.sql) now
// independently recompute the uniform refund from a list of HR-entered
// {months, amountPerMonth} rows (mirroring calculateUniformRefundBreakdown()
// in terminalDuesEngine.ts) instead of a single months x flat-rate formula.
// These tests exercise that validation directly against the real RPCs on
// disposable Postgres -- the same convention as
// terminalDuesBatchCalculatorIntegration.test.ts.
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

function queryJson(sql: string): Record<string, unknown> {
  const out = execFileSync('psql', ['-t', '-A', '-c', sql], { encoding: 'utf-8' }).trim();
  return JSON.parse(out);
}

/** For a single-column query returning one JSON array value -- avoids
 * queryRow's comma-splitting, which would wrongly split a JSON array's own
 * commas. */
function queryJsonArray(sql: string): unknown[] {
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

  exec(`INSERT INTO tenants (id, name, code) VALUES ('${tenantId}', '${label}', 'UR-${tenantId.slice(0, 8)}')`);
  exec(`INSERT INTO regions (id, tenant_id, name, code) VALUES ('${regionId}', '${tenantId}', 'Main Region', 'MAIN-${regionId.slice(0, 8)}')`);
  exec(`INSERT INTO auth.users (id) VALUES ('${callerId}')`);
  exec(`INSERT INTO profiles (id, tenant_id, is_super_admin, is_active) VALUES ('${callerId}', '${tenantId}', true, true)`);
  exec(`SELECT set_caller('${callerId}')`);

  return { tenantId, callerId, regionId };
}

function createEmployee(fixture: Fixture, label: string): string {
  const employeeId = randomUUID();
  exec(
    `INSERT INTO employees (id, tenant_id, employee_number, full_name, status, is_deleted, basic_salary, hire_date, region_id) ` +
    `VALUES ('${employeeId}', '${fixture.tenantId}', 'E-${employeeId.slice(0, 8)}', '${label}', 'Active', false, 100000, '2018-01-01', '${fixture.regionId}')`
  );
  return employeeId;
}

// pensionArrears/effectiveMonths are fixed across these tests (2018-01-01 ->
// 2026-11-01 = 106 completed months; 106 * 100000 * 0.1 = 1,060,000) so only
// the uniform refund portion of each payload varies between cases.
const EFFECTIVE_MONTHS = 106;
const PENSION_ARREARS = 1060000;

function buildPayload(uniformRefundBreakdown: unknown, uniformRefund: number) {
  const inputs = {
    dateJoined: '2018-01-01', dateLeft: '2026-11-01', finalSalary: 100000,
    uniformRefundBreakdown, outstandingSalaryEntries: [], noticeStatus: 'on_time', requiredNoticeDays: 26,
  };
  const breakdown = {
    effectiveMonths: EFFECTIVE_MONTHS, pensionArrears: PENSION_ARREARS, annualLeaveRefund: 0, uniformRefund,
    uniformRefundBreakdown, outstandingSalaryTotal: 0, totalEntitlements: PENSION_ARREARS + uniformRefund, lessNoticeDeduction: 0,
    totalPayable: PENSION_ARREARS + uniformRefund, excessDeduction: 0,
  };
  return { inputs, breakdown, totalPayable: PENSION_ARREARS + uniformRefund };
}

function createDraft(fixture: Fixture, employeeId: string, uniformRefundBreakdown: unknown, uniformRefund: number): string {
  const { inputs, breakdown, totalPayable } = buildPayload(uniformRefundBreakdown, uniformRefund);
  const id = randomUUID();
  exec(
    `INSERT INTO terminal_due_calculations (id, tenant_id, employee_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable) ` +
    `VALUES ('${id}', '${fixture.tenantId}', '${employeeId}', '${fixture.regionId}', 'Test Employee', 'E-TEST', 'Guard', '${JSON.stringify(inputs).replace(/'/g, "''")}'::jsonb, '${JSON.stringify(breakdown).replace(/'/g, "''")}'::jsonb, ${totalPayable})`
  );
  return id;
}

function updateDraftSql(id: string, uniformRefundBreakdown: unknown, uniformRefund: number): string {
  const { inputs, breakdown, totalPayable } = buildPayload(uniformRefundBreakdown, uniformRefund);
  return `SELECT update_terminal_due_calculation_draft(` +
    `'${id}'::uuid, 'Test Employee', 'E-TEST', 'Guard', ` +
    `'${JSON.stringify(inputs).replace(/'/g, "''")}'::jsonb, ` +
    `'${JSON.stringify(breakdown).replace(/'/g, "''")}'::jsonb, ${totalPayable})`;
}

describe.skipIf(!dbAvailable && !dbRequired)('Terminal Dues: variable uniform refund breakdown (real SQL functions, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      throw new Error('Disposable Postgres is required for this suite (ATTENDANCE_PARITY_REQUIRE_DB=1) but is not reachable.');
    }
  });

  it('1. the worked example (4@5,000 + 2@8,000 + 4@10,000 = 76,000) submits successfully end to end', () => {
    const fixture = createFixture('Worked Example');
    const employeeId = createEmployee(fixture, 'Worked Example Employee');
    const rows = [
      { months: 4, amountPerMonth: 5000 },
      { months: 2, amountPerMonth: 8000 },
      { months: 4, amountPerMonth: 10000 },
    ];
    const draftId = createDraft(fixture, employeeId, rows, 76000);

    const submitResult = queryJson(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    expect(submitResult.success).toBe(true);
    const terminalDueId = submitResult.terminal_due_id as string;
    const [storedUniformRefund] = queryRow(`SELECT uniform_refund FROM terminal_dues WHERE id = '${terminalDueId}'`);
    expect(Number(storedUniformRefund)).toBe(76000);
  });

  it('2. a single blended rate x total months would be rejected: the 100,000 mismatch is caught, not silently allowed', () => {
    const fixture = createFixture('Blended Rate Mismatch');
    const employeeId = createEmployee(fixture, 'Blended Rate Employee');
    const rows = [
      { months: 4, amountPerMonth: 5000 },
      { months: 2, amountPerMonth: 8000 },
      { months: 4, amountPerMonth: 10000 },
    ];
    // Breakdown falsely claims the old blended-rate total (10 months x
    // 10,000) instead of the correct per-row sum (76,000).
    const draftId = createDraft(fixture, employeeId, rows, 100000);

    const stderr = execExpectError(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    expect(stderr).toMatch(/uniform refund.*does not match the validated amount of 76000/i);
  });

  it('3. an empty breakdown (no uniform deduction at all) is valid and refunds 0', () => {
    const fixture = createFixture('Empty Breakdown');
    const employeeId = createEmployee(fixture, 'Empty Breakdown Employee');
    const draftId = createDraft(fixture, employeeId, [], 0);

    const submitResult = queryJson(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    expect(submitResult.success).toBe(true);
  });

  it('4. an absent uniformRefundBreakdown field (legacy/pre-existing draft shape) is treated as no rows, not an error', () => {
    const fixture = createFixture('Absent Field');
    const employeeId = createEmployee(fixture, 'Absent Field Employee');
    // Build the payload manually without the uniformRefundBreakdown key at all.
    const inputs = { dateJoined: '2018-01-01', dateLeft: '2026-11-01', finalSalary: 100000, outstandingSalaryEntries: [], noticeStatus: 'on_time', requiredNoticeDays: 26 };
    const breakdown = { effectiveMonths: EFFECTIVE_MONTHS, pensionArrears: PENSION_ARREARS, annualLeaveRefund: 0, uniformRefund: 0, outstandingSalaryTotal: 0, totalEntitlements: PENSION_ARREARS, lessNoticeDeduction: 0, totalPayable: PENSION_ARREARS, excessDeduction: 0 };
    const id = randomUUID();
    exec(
      `INSERT INTO terminal_due_calculations (id, tenant_id, employee_id, region_id, subject_name, subject_number, position, inputs, breakdown, total_payable) ` +
      `VALUES ('${id}', '${fixture.tenantId}', '${employeeId}', '${fixture.regionId}', 'Test Employee', 'E-TEST', 'Guard', '${JSON.stringify(inputs)}'::jsonb, '${JSON.stringify(breakdown)}'::jsonb, ${PENSION_ARREARS})`
    );

    const submitResult = queryJson(`SELECT submit_terminal_due_calculation('${id}'::uuid)`);
    expect(submitResult.success).toBe(true);
  });

  it('5. a negative month count in a row is rejected, not silently zeroed', () => {
    const fixture = createFixture('Negative Months');
    const employeeId = createEmployee(fixture, 'Negative Months Employee');
    const rows = [{ months: -2, amountPerMonth: 8000 }];
    const draftId = createDraft(fixture, employeeId, rows, 0);

    const stderr = execExpectError(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    expect(stderr).toMatch(/whole number of months greater than zero/i);
  });

  it('6. a fractional month count in a row is rejected', () => {
    const fixture = createFixture('Fractional Months');
    const employeeId = createEmployee(fixture, 'Fractional Months Employee');
    const rows = [{ months: 2.5, amountPerMonth: 8000 }];
    const draftId = createDraft(fixture, employeeId, rows, 20000);

    const stderr = execExpectError(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    expect(stderr).toMatch(/whole number of months greater than zero/i);
  });

  it('7. a zero or negative amount per month in a row is rejected', () => {
    const fixture = createFixture('Zero Amount');
    const employeeId = createEmployee(fixture, 'Zero Amount Employee');
    const rows = [{ months: 4, amountPerMonth: 0 }];
    const draftId = createDraft(fixture, employeeId, rows, 0);

    const stderr = execExpectError(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    expect(stderr).toMatch(/positive amount per month/i);
  });

  it('8. a NaN numeric literal crafted directly in the stored JSONB (bypassing client validation) is still rejected', () => {
    // Postgres NUMERIC accepts the literal 'NaN' and compares it as larger
    // than any ordinary value, so a naive "> 0" check alone would wrongly
    // accept it -- this proves the isfinite() guard actually catches it.
    const fixture = createFixture('NaN Injection');
    const employeeId = createEmployee(fixture, 'NaN Injection Employee');
    const rows = [{ months: 'NaN', amountPerMonth: 8000 }];
    const draftId = createDraft(fixture, employeeId, rows, 0);

    const stderr = execExpectError(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    expect(stderr).toMatch(/whole number of months greater than zero/i);
  });

  it('9. uniformRefundBreakdown supplied as a non-array JSON value is rejected', () => {
    const fixture = createFixture('Non Array Breakdown');
    const employeeId = createEmployee(fixture, 'Non Array Employee');
    const draftId = createDraft(fixture, employeeId, { months: 4, amountPerMonth: 5000 }, 20000);

    const stderr = execExpectError(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    expect(stderr).toMatch(/must be a list of rows/i);
  });

  it('10. update_terminal_due_calculation_draft independently re-validates the breakdown the same way on every save', () => {
    const fixture = createFixture('Draft Update Validation');
    const employeeId = createEmployee(fixture, 'Draft Update Employee');
    const draftId = createDraft(fixture, employeeId, [{ months: 4, amountPerMonth: 5000 }], 20000);

    // A correct update succeeds.
    const okResult = queryJson(updateDraftSql(draftId, [{ months: 2, amountPerMonth: 8000 }], 16000));
    expect(okResult.success).toBe(true);

    // An update claiming the wrong total for its own rows is rejected.
    const stderr = execExpectError(updateDraftSql(draftId, [{ months: 2, amountPerMonth: 8000 }], 99999));
    expect(stderr).toMatch(/uniform refund.*does not match the validated amount of 16000/i);
  });

  it('11. a saved draft breakdown round-trips exactly through save -> reopen (persisted in inputs/breakdown JSONB)', () => {
    const fixture = createFixture('Round Trip');
    const employeeId = createEmployee(fixture, 'Round Trip Employee');
    const rows = [
      { months: 4, amountPerMonth: 5000 },
      { months: 2, amountPerMonth: 8000 },
      { months: 4, amountPerMonth: 10000 },
    ];
    const draftId = createDraft(fixture, employeeId, rows, 76000);

    const storedRows = queryJsonArray(`SELECT inputs->'uniformRefundBreakdown' FROM terminal_due_calculations WHERE id = '${draftId}'`);
    expect(storedRows).toEqual(rows);
    const [storedTotal] = queryRow(`SELECT breakdown->>'uniformRefund' FROM terminal_due_calculations WHERE id = '${draftId}'`);
    expect(storedTotal).toBe('76000');
  });

  it('12. the breakdown remains readable from terminal_due_calculations after submission, for approver display', () => {
    const fixture = createFixture('Approver Visibility');
    const employeeId = createEmployee(fixture, 'Approver Visibility Employee');
    const rows = [{ months: 4, amountPerMonth: 5000 }, { months: 4, amountPerMonth: 10000 }];
    const draftId = createDraft(fixture, employeeId, rows, 60000);
    const submitResult = queryJson(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);
    const terminalDueId = submitResult.terminal_due_id as string;

    const linkedRows = queryJsonArray(
      `SELECT breakdown->'uniformRefundBreakdown' FROM terminal_due_calculations WHERE submitted_terminal_due_id = '${terminalDueId}'`
    );
    expect(linkedRows).toEqual(rows);
  });

  it('13. an already-submitted calculation is never re-validated or rewritten by a later migration change (frozen row)', () => {
    const fixture = createFixture('Frozen After Submit');
    const employeeId = createEmployee(fixture, 'Frozen Employee');
    const rows = [{ months: 4, amountPerMonth: 5000 }, { months: 4, amountPerMonth: 10000 }];
    const draftId = createDraft(fixture, employeeId, rows, 60000);
    queryJson(`SELECT submit_terminal_due_calculation('${draftId}'::uuid)`);

    // A submitted row can never be edited again via update_terminal_due_calculation_draft.
    const stderr = execExpectError(updateDraftSql(draftId, [{ months: 1, amountPerMonth: 1 }], 1));
    expect(stderr).toMatch(/cannot edit a submitted calculation/i);
  });
});
