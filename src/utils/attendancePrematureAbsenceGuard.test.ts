// Real database regression for a historically premature full-day coverage declaration.
// Uses disposable Postgres only; never production.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function pgAvailable(): boolean {
  try {
    execFileSync('psql', ['-t', '-A', '-c', 'select 1'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch { return false; }
}
const available = pgAvailable();
const required = process.env.ATTENDANCE_PARITY_REQUIRE_DB === '1';
const run = (sql: string) => execFileSync('psql', ['-v','ON_ERROR_STOP=1','-t','-A','-c',sql], { encoding:'utf8' }).trim();

describe.skipIf(!available && !required)('Attendance: premature absence evidence guard (real SQL)', () => {
  it('an ongoing Nov 27 day shift cannot be Absent even with future-dated coverage', () => {
    const status = run("select status from attendance_engine_calculate('2026-11-27'::date,'day',null,'confirmed_complete','2026-11-27 21:59:00+00','2026-11-27 09:33:00+00')");
    expect(status).toBe('pending');
  });

  it('same complete evidence after actual checkout can determine Absent', () => {
    const status = run("select status from attendance_engine_calculate('2026-11-27'::date,'day',null,'confirmed_complete','2026-11-27 21:59:00+00','2026-11-28 07:00:00+00')");
    expect(status).toBe('absent');
  });

  it('one check-in before shift completion is only provisional under incomplete coverage', () => {
    const status = run("select status from attendance_engine_calculate('2026-11-27'::date,'day',array['2026-11-27 04:10:00+00'::timestamptz],'confirmed_complete','2026-11-27 21:59:00+00','2026-11-27 09:33:00+00')");
    expect(status).toBe('present');
  });

  it('resolver refuses an absence where the coverage was confirmed before checkout closed', () => {
    const tenant = randomUUID(),actor=randomUUID(),emp=randomUUID(),mapping=randomUUID();
    const terminal='TEST-'+randomUUID().slice(0,8);
    run(`insert into tenants(id,name,code) values('${tenant}','Premature guard tenant','PG-${tenant.slice(0,6)}')`);
    run(`insert into auth.users(id) values('${actor}')`);
    run(`insert into profiles(id,tenant_id,is_super_admin,is_active) values('${actor}','${tenant}',true,true)`);
    run(`select set_caller('${actor}')`);
    run(`insert into employees(id,tenant_id,employee_number,full_name,status,is_deleted,workstation) values('${emp}','${tenant}','G-${emp.slice(0,8)}','Test Guard','Active',false,'TEST SITE')`);
    run(`insert into hikcentral_person_mappings(id,tenant_id,hikcentral_person_no,employee_id,match_method,is_active,fingerprint_attendance_enabled) values('${mapping}','${tenant}','P${emp.slice(0,8)}','${emp}','manual',true,true)`);
    run(`insert into roster_shift_patterns(tenant_id,employee_id,shift_type,effective_from,is_active,assigned_by) values('${tenant}','${emp}','day','2026-11-01',true,'${actor}')`);
    run(`insert into employee_hikcentral_terminals(tenant_id,employee_id,access_point,is_active,assigned_by) values('${tenant}','${emp}','${terminal}',true,'${actor}')`);
    run(`insert into fingerprint_coverage_confirmations(tenant_id,confirmed_by,workstations,access_points,covers_from,covers_through,latest_observed_event_at,confirmed_at) values('${tenant}','${actor}',array[]::text[],array['${terminal}'],'2026-11-01 00:00+00','2026-11-27 21:59+00','2026-11-27 05:11+00','2026-11-27 09:33+00')`);
    const before = run(`select status from attendance_resolve_and_calculate('${emp}'::uuid,'2026-11-27'::date)`);
    expect(before).toBe('pending');
    run(`insert into fingerprint_coverage_confirmations(tenant_id,confirmed_by,workstations,access_points,covers_from,covers_through,latest_observed_event_at,confirmed_at) values('${tenant}','${actor}',array[]::text[],array['${terminal}'],'2026-11-01 00:00+00','2026-11-27 21:59+00','2026-11-27 19:00+00','2026-11-28 07:33+00')`);
    const after = run(`select status from attendance_resolve_and_calculate('${emp}'::uuid,'2026-11-27'::date)`);
    expect(after).toBe('absent');
  });
});
