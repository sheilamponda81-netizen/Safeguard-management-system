// Phase 2 completion, Task 3: attendance_correct now requires a
// non-empty reason for every manual correction, database-enforced, not
// merely a UI convention. Same disposable-Postgres convention as the
// other attendance-engine test files in this directory -- never
// connects to production.
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

// Tab-separated, not comma -- several of this file's own test reasons
// contain commas, which a comma-delimited row would otherwise split on.
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

describe.skipIf(!dbAvailable && !dbRequired)('attendance_correct: mandatory reason (real SQL function, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error('ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable -- this suite must run for real in CI, never silently skip.');
      }
      console.warn('attendanceCorrectMandatoryReason.test.ts: no reachable Postgres -- skipping.');
    }
  });

  it('rejects a NULL reason for a P/A/L correction', () => {
    const fixture = createFixture();
    expectRpcError(
      `SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', NULL)`,
      'A reason is required to correct attendance'
    );
  });

  it('rejects an empty/whitespace-only reason for a P/A/L correction', () => {
    const fixture = createFixture();
    expectRpcError(
      `SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'A', '   ')`,
      'A reason is required to correct attendance'
    );
  });

  it('rejects a missing reason for the LV/SL/"-" path too, not only P/A/L', () => {
    const fixture = createFixture();
    expectRpcError(
      `SELECT * FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'LV', NULL)`,
      'A reason is required to correct attendance'
    );
  });

  it('accepts a genuine reason, writes it into attendance_audit_log, and never fabricates one', () => {
    const fixture = createFixture();
    const [outcome, , newStatus] = queryRow(
      `SELECT outcome, old_status, new_status FROM attendance_correct('${fixture.employeeId}'::uuid, '2026-11-10'::date, 'P', 'Guard confirmed present on site, fingerprint scanner was offline')`
    );
    expect(outcome).toBe('written');
    expect(newStatus).toBe('P');

    const [reason, changeSource] = queryRow(
      `SELECT reason, change_source FROM attendance_audit_log WHERE employee_id = '${fixture.employeeId}' AND attendance_date = '2026-11-10'`
    );
    expect(reason).toBe('Guard confirmed present on site, fingerprint scanner was offline');
    expect(changeSource).toBe('manual');
  });

  it('attendance_bulk_correct is not directly modified by this migration, but its own un-reviewed "optional shared reason" comment no longer reflects reality: it delegates each row to attendance_correct internally, so a NULL reason is now rejected transitively too -- closing what would otherwise be a bypass of the new requirement, not a regression', () => {
    const fixture = createFixture();
    expectRpcError(
      `SELECT * FROM attendance_bulk_correct(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-11'::date, '2026-11-11'::date, 'P', NULL)`,
      'A reason is required to correct attendance'
    );
  });
});
