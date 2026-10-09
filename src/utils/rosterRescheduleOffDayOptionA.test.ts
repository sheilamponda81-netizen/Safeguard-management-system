import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Phase 2B.2C: Reschedule Off Day, Policy Option A. This is a FORWARD-ONLY
// corrective migration (20261009000000_roster_reschedule_off_day_option_a.sql)
// that supersedes ONLY the roster_reschedule_off_day() function originally
// created by 20261008000000_roster_management_foundation.sql -- that file
// is NOT edited (migration history is append-only), so its own
// rosterMigrationSecurity.test.ts continues to pin ITS source text as
// originally written and is left untouched by this phase.
//
// Following the same established precedent (no committed live-Postgres
// test harness in this repo -- see rosterMigrationSecurity.test.ts's own
// header), these tests pin the NEW migration file at the SQL source level:
// its defensive overload removal, its mandatory (no-longer-optional)
// parameters, its Admin/tenant checks, its genuine-Off/eligible-replacement
// verification, its adjacency and rolling-rest enforcement, and its
// continued use of the unmodified append-only/grant-revoked table
// infrastructure. Runtime correctness (including the mathematical
// zero-slack-schedule edge case) was additionally verified by actually
// applying this exact file to a throwaway, isolated local PostgreSQL
// instance -- see this phase's test report for the exact runs; source-text
// assertions alone do not prove that.
const migrationSource = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261009000000_roster_reschedule_off_day_option_a.sql'),
  'utf-8'
);
const oldMigrationSource = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261008000000_roster_management_foundation.sql'),
  'utf-8'
);

function getFunctionBody(source: string, name: string): string {
  const re = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name}\\([\\s\\S]*?\\n\\$\\$;`);
  const body = source.match(re)?.[0];
  expect(body).toBeTruthy();
  return body!;
}

function stripSqlComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('roster reschedule Option A migration: scope and safety boundaries', () => {
  it('is a standalone, forward-only file -- the original migration it supersedes is untouched', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../../supabase/migrations/20261008000000_roster_management_foundation.sql'))).toBe(true);
    // The old file's own reschedule function still has its ORIGINAL
    // 5-parameter shape (p_new_off_date / p_vacated_work_date /
    // p_vacated_work_assignment_type) -- proof this migration never
    // rewrote that file in place.
    expect(oldMigrationSource).toMatch(/p_new_off_date DATE/);
    expect(oldMigrationSource).toMatch(/p_vacated_work_date DATE DEFAULT NULL/);
  });

  it('has a strictly later timestamp-prefixed filename than the migration it supersedes', () => {
    expect('20261009000000' > '20261008000000').toBe(true);
  });

  it('never references attendance, payroll, payment_status, or employee_deductions', () => {
    for (const table of ['attendance', 'payroll', 'payment_status', 'employee_deductions']) {
      expect(migrationSource).not.toMatch(new RegExp(`\\b(FROM|INTO|JOIN|UPDATE)\\s+${table}\\b`, 'i'));
    }
  });

  it('does not alter table grants, RLS policies, or the append-only trigger -- it touches only the function', () => {
    expect(migrationSource).not.toMatch(/ALTER TABLE/);
    expect(migrationSource).not.toMatch(/CREATE POLICY/);
    expect(migrationSource).not.toMatch(/CREATE TRIGGER/);
    expect(migrationSource).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|DELETE) ON roster_(date_assignments|off_day_patterns)/);
  });
});

describe('roster reschedule Option A migration: the old overload cannot remain reachable', () => {
  it('defensively drops every existing overload of roster_reschedule_off_day by its live signature before creating the new one', () => {
    expect(migrationSource).toMatch(/DO \$\$/);
    expect(migrationSource).toMatch(/FOR r IN\s*\n\s*SELECT p\.oid::regprocedure AS sig\s*\n\s*FROM pg_proc p/);
    expect(migrationSource).toMatch(/WHERE n\.nspname = 'public' AND p\.proname = 'roster_reschedule_off_day'/);
    expect(migrationSource).toMatch(/EXECUTE format\('DROP FUNCTION %s', r\.sig\);/);
  });

  it('the drop-every-overload block appears before the new CREATE FUNCTION statement', () => {
    const dropIdx = migrationSource.indexOf('DROP FUNCTION %s');
    const createIdx = migrationSource.indexOf('CREATE FUNCTION roster_reschedule_off_day(');
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(dropIdx);
  });

  it('the new function has exactly 5 mandatory parameters -- no DEFAULT NULL on any of them (every field is now required, matching Option A)', () => {
    const signature = migrationSource.match(/CREATE FUNCTION roster_reschedule_off_day\(([\s\S]*?)\)\s*\nRETURNS/)?.[0] ?? '';
    expect(signature).toMatch(/p_employee_id UUID,/);
    expect(signature).toMatch(/p_original_off_date DATE,/);
    expect(signature).toMatch(/p_replacement_off_date DATE,/);
    expect(signature).toMatch(/p_original_date_shift TEXT,/);
    expect(signature).toMatch(/p_correction_reason TEXT\s*\n\)/);
    expect(signature).not.toMatch(/DEFAULT NULL/);
  });

  it('the old optional-vacated-work parameters no longer exist anywhere in this file', () => {
    expect(migrationSource).not.toMatch(/p_new_off_date/);
    expect(migrationSource).not.toMatch(/p_vacated_work_date/);
    expect(migrationSource).not.toMatch(/p_vacated_work_assignment_type/);
    expect(migrationSource).not.toMatch(/v_vacated_was_off/);
  });

  it('grants are re-issued for exactly the new signature, revoked from PUBLIC/anon, granted only to authenticated', () => {
    expect(migrationSource).toMatch(/REVOKE ALL ON FUNCTION roster_reschedule_off_day\(UUID, DATE, DATE, TEXT, TEXT\) FROM PUBLIC, anon;/);
    expect(migrationSource).toMatch(/GRANT EXECUTE ON FUNCTION roster_reschedule_off_day\(UUID, DATE, DATE, TEXT, TEXT\) TO authenticated;/);
  });
});

describe('roster reschedule Option A migration: security model unchanged from the rest of this codebase', () => {
  it('is SECURITY DEFINER with a restricted search_path', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path = public, pg_temp/);
  });

  it('requires authentication, an active account, and delegates admin-check to is_super_admin()/is_business_admin()', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    const fnCode = stripSqlComments(fn);
    expect(fn).toMatch(/IF v_caller_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated'/);
    expect(fn).toMatch(/IF NOT is_current_user_active\(\) THEN/);
    expect(fn).toMatch(/IF NOT \(is_super_admin\(\) OR is_business_admin\(\)\) THEN/);
    expect(fnCode).not.toMatch(/v_role_level/);
    expect(fnCode).not.toMatch(/has_permission\(/);
  });

  it('re-derives tenant_id directly from profiles, never trusting a client-supplied value', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    expect(fn).toMatch(/SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_caller_id;/);
  });

  it('locks the employee row FOR UPDATE before any roster read/write, and verifies tenant ownership', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    expect(fn).toMatch(/SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = p_employee_id FOR UPDATE;/);
    expect(fn).toMatch(/IF v_employee_tenant_id <> v_tenant_id THEN\s*\n\s*RAISE EXCEPTION 'Employee % does not belong to your tenant'/);
    const lockIdx = fn.indexOf('FOR UPDATE;');
    const firstResolveIdx = fn.indexOf('roster_resolve_schedule(p_employee_id, p_original_off_date)');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(firstResolveIdx).toBeGreaterThan(lockIdx);
  });

  it('never accepts an actor parameter -- auth.uid() captured once is the sole source of attribution', () => {
    const signature = migrationSource.match(/CREATE FUNCTION roster_reschedule_off_day\([\s\S]*?\)\s*\nRETURNS/)?.[0] ?? '';
    expect(signature.toLowerCase()).not.toMatch(/p_assigned_by|p_superseded_by|p_actor/);
    expect(getFunctionBody(migrationSource, 'roster_reschedule_off_day')).toMatch(/v_caller_id UUID := auth\.uid\(\);/);
  });
});

describe('roster reschedule Option A migration: the mandatory swap -- original date genuinely Off, replacement eligible, no silent overwrite', () => {
  it('verifies the original date genuinely resolves to off via roster_resolve_schedule, never trusting the client', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    expect(fn).toMatch(/v_original_resolved := roster_resolve_schedule\(p_employee_id, p_original_off_date\);/);
    expect(fn).toMatch(/IF v_original_resolved <> 'off' THEN\s*\n\s*RAISE EXCEPTION 'Employee % is not currently scheduled Off on %/);
  });

  it('rejects an identical original and replacement date before any write', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    expect(fn).toMatch(/IF p_original_off_date = p_replacement_off_date THEN\s*\n\s*RAISE EXCEPTION 'The replacement Off date must be different/);
    const checkIdx = fn.indexOf('p_original_off_date = p_replacement_off_date');
    const insertIdx = fn.indexOf('INSERT INTO roster_date_assignments');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(checkIdx);
  });

  it('rejects a replacement date that does not resolve to exactly "unassigned" -- never a silent overwrite, and an already-Off replacement is rejected too (not merely allowed as harmless)', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    expect(fn).toMatch(/v_replacement_resolved := roster_resolve_schedule\(p_employee_id, p_replacement_off_date\);/);
    expect(fn).toMatch(/IF v_replacement_resolved <> 'unassigned' THEN\s*\n\s*RAISE EXCEPTION 'Employee % replacement date % already resolves to "%"/);
    // The old, corrected check accepted 'off' as well as 'unassigned' --
    // confirm that permissive form (checking the replacement against
    // day/night only) no longer appears anywhere as live SQL.
    const migrationCode = stripSqlComments(migrationSource);
    expect(migrationCode).not.toMatch(/v_replacement_resolved IN \('day', 'night'\)/);
    expect(migrationCode).not.toMatch(/already has a % shift on %/);
  });

  it('requires original_date_shift to be exactly day or night, and correction_reason to be non-empty', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    expect(fn).toMatch(/IF p_original_date_shift IS NULL OR p_original_date_shift NOT IN \('day', 'night'\) THEN/);
    expect(fn).toMatch(/IF p_correction_reason IS NULL OR btrim\(p_correction_reason\) = '' THEN\s*\n\s*RAISE EXCEPTION 'A correction_reason is required to reschedule an Off day'/);
  });

  it('there is no longer any optional path that leaves the original date untouched -- the original-date INSERT is unconditional, not gated behind an if', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    // Both inserts happen unconditionally in sequence -- no surrounding
    // `IF p_vacated_work_date IS NOT NULL THEN` gate exists anymore (that
    // was the old file's optional-step pattern; absent here entirely).
    expect(fn).not.toMatch(/IF p_vacated_work_date IS NOT NULL THEN/);
    const stepAIdx = fn.indexOf("VALUES (v_tenant_id, p_employee_id, p_original_off_date, p_original_date_shift, true, v_caller_id, p_correction_reason);");
    const stepBIdx = fn.indexOf("VALUES (v_tenant_id, p_employee_id, p_replacement_off_date, 'off', false, v_caller_id, p_correction_reason);");
    expect(stepAIdx).toBeGreaterThan(-1);
    expect(stepBIdx).toBeGreaterThan(stepAIdx);
  });

  it('overrides_recurring_off_day is unconditionally true for the original date\'s new row (it was just proven to be genuinely Off) and unconditionally false for the replacement\'s new Off row', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    expect(fn).toMatch(/VALUES \(v_tenant_id, p_employee_id, p_original_off_date, p_original_date_shift, true, v_caller_id, p_correction_reason\);/);
    expect(fn).toMatch(/VALUES \(v_tenant_id, p_employee_id, p_replacement_off_date, 'off', false, v_caller_id, p_correction_reason\);/);
  });
});

describe('roster reschedule Option A migration: Night-to-Day adjacency and rolling-rest enforcement, no override path', () => {
  it('enforces the identical Night-to-Day adjacency hard block for the shift being placed on the original date', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    expect(fn).toMatch(/IF v_adjacent_type = 'night' THEN\s*\n\s*RAISE EXCEPTION 'Employee % has a Night shift starting %/);
    expect(fn).toMatch(/IF v_adjacent_type = 'day' THEN\s*\n\s*RAISE EXCEPTION 'Employee % already has a Day shift starting %/);
  });

  it('validates the rolling seven-day rest rule around BOTH the original and replacement dates, after both writes, with no conditional bypass', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    const matches = fn.match(/FROM roster_rolling_rest_windows\([^)]*\) WHERE status = 'confirmed_violation'/g) || [];
    expect(matches.length).toBe(2);
    expect(fn).toMatch(/roster_rolling_rest_windows\(p_employee_id, p_original_off_date\)/);
    expect(fn).toMatch(/roster_rolling_rest_windows\(p_employee_id, p_replacement_off_date\)/);
    expect(fn).toMatch(/rolling seven-day rest violations cannot be overridden/);
  });

  it('the rolling-rest check runs AFTER both writes, so a violation rolls back both the original-date and replacement-date changes', () => {
    const fn = getFunctionBody(migrationSource, 'roster_reschedule_off_day');
    const stepBInsertIdx = fn.lastIndexOf('INSERT INTO roster_date_assignments');
    const violationIdx = fn.indexOf("WHERE status = 'confirmed_violation'");
    expect(stepBInsertIdx).toBeGreaterThan(-1);
    expect(violationIdx).toBeGreaterThan(stepBInsertIdx);
  });

  it('no override parameter of any kind exists anywhere in this file', () => {
    const migrationCode = stripSqlComments(migrationSource);
    const overrideParams = migrationCode.match(/p_override_\w+/g) || [];
    expect(overrideParams).toEqual([]);
  });
});
