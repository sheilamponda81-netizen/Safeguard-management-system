// Attendance coverage-trust fix: attendance_resolve_and_calculate now
// requires a matching confirmation to be evidence-backed or
// independently-verified-overridden, never merely a never-checked
// historical declaration. Same disposable-Postgres convention as every
// other attendance-engine integration test in this directory -- never
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

function queryRow(sql: string): string[] {
  const out = execFileSync('psql', ['-t', '-A', '-F', '\t', '-c', sql], { encoding: 'utf-8' }).trim();
  return out ? out.split('\t') : [];
}

interface Fixture { tenantId: string; callerId: string; employeeId: string; personNo: string }

function createFixture(site = 'TRUST FIX SITE'): Fixture {
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
  exec(`SELECT set_employee_hikcentral_terminals('${employeeId}', ARRAY['GATE1'])`);
  exec(`SELECT roster_assign_recurring_pattern(ARRAY['${employeeId}']::uuid[], NULL, 'day', '2026-10-25', NULL)`);
  return { tenantId, callerId, employeeId, personNo };
}

function insertRawEvent(fixture: Fixture, isoTime: string): void {
  const batchId = randomUUID();
  exec(`INSERT INTO hikcentral_import_batches (id, tenant_id, filename, status, imported_by) VALUES ('${batchId}', '${fixture.tenantId}', 'x.xlsx', 'completed', '${fixture.callerId}')`);
  exec(
    `INSERT INTO hikcentral_raw_events (tenant_id, import_batch_id, hikcentral_person_no, event_time, access_point, authentication_result, event_type, event_fingerprint) ` +
    `VALUES ('${fixture.tenantId}', '${batchId}', '${fixture.personNo}', '${isoTime}', 'GATE1', 'Authorization', 'Access Granted by Fingerprint', '${randomUUID()}')`
  );
}

function insertConfirmation(
  fixture: Fixture,
  coversFrom: string,
  coversThrough: string,
  evidence: { latestObservedEventAt?: string; exceedsObservedEvidence?: boolean; independentlyVerified?: boolean; overrideReason?: string } = {}
): void {
  const latest = evidence.latestObservedEventAt ? `'${evidence.latestObservedEventAt}'` : 'NULL';
  const exceeds = evidence.exceedsObservedEvidence ? 'true' : 'false';
  const verified = evidence.independentlyVerified ? 'true' : 'false';
  const reason = evidence.overrideReason ? `'${evidence.overrideReason}'` : 'NULL';
  exec(
    `INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through, latest_observed_event_at, exceeds_observed_evidence, override_reason, independently_verified) ` +
    `VALUES ('${fixture.tenantId}', '${fixture.callerId}', ARRAY[]::TEXT[], ARRAY['GATE1'], '${coversFrom}', '${coversThrough}', ${latest}, ${exceeds}, ${reason}, ${verified})`
  );
}

function resolve(fixture: Fixture, date: string): { status: string; basis: string } {
  const [status, basis] = queryRow(`SELECT status, calculation_basis FROM attendance_resolve_and_calculate('${fixture.employeeId}'::uuid, '${date}'::date)`);
  return { status, basis };
}

describe.skipIf(!dbAvailable && !dbRequired)('attendance_resolve_and_calculate: evidence-backed coverage fix (real SQL function, disposable Postgres)', () => {
  beforeAll(() => {
    if (!dbAvailable) {
      if (dbRequired) {
        throw new Error('ATTENDANCE_PARITY_REQUIRE_DB=1 is set but no Postgres is reachable -- this suite must run for real in CI, never silently skip.');
      }
      console.warn('attendanceResolveEvidenceBackedCoverage.test.ts: no reachable Postgres -- skipping.');
    }
  });

  it('CENTRAL FIX: an unsupported-historical confirmation (never evidence-checked -- the exact shape of every confirmation in production before this fix) no longer independently justifies Absent -- resolves Pending instead, with only a checkout scan and no check-in', () => {
    const fixture = createFixture();
    // Day shift, 2026-11-03: checkout window ends 18:00Z. Checkout-only scan, no check-in.
    insertRawEvent(fixture, '2026-11-03T16:30:00Z');
    // Unsupported historical: no evidence fields at all -- matches every production confirmation exactly.
    insertConfirmation(fixture, '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z');

    const result = resolve(fixture, '2026-11-03');
    expect(result.status).toBe('pending'); // NOT 'absent' -- the fix's whole point
  });

  it('evidence-backed coverage (latest_observed_event_at set) STILL supports the strict two-fingerprint rule -- a confirmed, genuinely-covered missing checkout still resolves Absent', () => {
    const fixture = createFixture('EVIDENCE BACKED SITE');
    insertConfirmation(fixture, '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z', { latestObservedEventAt: '2026-11-03T17:50:00Z' });
    // No scans at all for this employee -- genuinely absent, with trustworthy coverage.
    const result = resolve(fixture, '2026-11-03');
    expect(result.status).toBe('absent');
  });

  it('an independently-verified override STILL supports Absent (the one legitimate way unverified-exceeding coverage can count)', () => {
    const fixture = createFixture('VERIFIED OVERRIDE SITE');
    insertConfirmation(fixture, '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z', {
      exceedsObservedEvidence: true,
      independentlyVerified: true,
      overrideReason: 'Site supervisor personally confirmed the export was complete.',
    });
    const result = resolve(fixture, '2026-11-03');
    expect(result.status).toBe('absent');
  });

  it('a valid COMPLETE check-in and checkout pair still resolves confirmed Present/Late regardless of coverage trust -- coverage is never even consulted for this case', () => {
    const fixture = createFixture('CONFIRMED PAIR SITE');
    insertRawEvent(fixture, '2026-11-03T04:05:00Z');
    insertRawEvent(fixture, '2026-11-03T16:30:00Z');
    // Deliberately NO coverage confirmation at all -- proving this path never needs one.
    const result = resolve(fixture, '2026-11-03');
    expect(result.status).toBe('present');
    expect(result.basis).toBe('confirmed');
  });

  it('manual-correction precedence is unaffected: an existing manual record is never overwritten by a re-run automatic pass, before or after this fix', () => {
    const fixture = createFixture('MANUAL PROTECTED SITE');
    insertConfirmation(fixture, '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z'); // unsupported historical
    exec(`SELECT attendance_correct('${fixture.employeeId}'::uuid, '2026-11-03'::date, 'L', 'Guard confirmed late arrival on site')`);
    queryRow(`SELECT outcome FROM attendance_apply_automatic(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-03'::date, '2026-11-03'::date)`);
    const [status, source] = queryRow(`SELECT status, source FROM attendance WHERE employee_id = '${fixture.employeeId}' AND date = '2026-11-03'`);
    expect(status).toBe('L');
    expect(source).toBe('manual');
  });

  it('approved-payroll protection is unaffected: an automatic pass for an approved-payroll month is still refused and flagged, before or after this fix', () => {
    const fixture = createFixture('PAYROLL PROTECTED SITE');
    insertConfirmation(fixture, '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z', { latestObservedEventAt: '2026-11-03T17:50:00Z' }); // genuinely evidence-backed -- would resolve Absent
    exec(`INSERT INTO payroll (tenant_id, employee_id, month, approval_status) VALUES ('${fixture.tenantId}', '${fixture.employeeId}', '2026-11', 'approved')`);
    const [outcome] = queryRow(`SELECT outcome FROM attendance_apply_automatic(ARRAY['${fixture.employeeId}']::uuid[], '2026-11-03'::date, '2026-11-03'::date)`);
    expect(outcome).toBe('skipped_payroll_approved');
  });

  it('this migration touches no attendance, payroll, or confirmation row -- it only redefines a function', () => {
    const migrationSource = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/20261122000000_attendance_resolve_evidence_backed_coverage.sql'),
      'utf-8'
    );
    const codeOnly = migrationSource.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
    expect(codeOnly).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
    expect(codeOnly).toMatch(/CREATE OR REPLACE FUNCTION attendance_resolve_and_calculate/);
  });
});
