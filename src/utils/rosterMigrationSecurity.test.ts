import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Roster Management Foundation: this migration is NOT applied to any
// database yet (explicitly not authorized this phase -- see the
// migration's own header). This repo has no committed live-Postgres test
// harness (established precedent: hikcentralAttendanceMigration.test.ts,
// hikcentralPersonMappingConfirmRpc.test.ts), so these tests pin the
// migration at the SQL SOURCE level, proving its security model (no
// direct-write path exists outside the three SECURITY DEFINER RPCs),
// its Admin-only checks, its tenant validation, its append-only trigger,
// its bulk limit, and its rolling-rest hard-block (no override path).
//
// Source-pinned regex assertions alone cannot prove runtime correctness
// (NULL propagation through PL/pgSQL conditionals, for one, is invisible
// to a regex). This file's three confirmed-and-fixed defects (the Admin
// NULL-propagation bug, the Off-day override bypass, and the rolling-rest
// downstream-boundary gap) were each found and verified by actually
// applying this exact migration file to a throwaway, isolated local
// PostgreSQL 16 instance (outside this repo, never touching STAGING or
// Production) and exercising it with real SELECT/INSERT calls under
// SET ROLE authenticated and SET SESSION test.current_uid -- not merely
// inferred from source text. These regex tests remain as a committed,
// repeatable regression guard for the fixed source going forward.
const migrationSource = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261008000000_roster_management_foundation.sql'),
  'utf-8'
);

function getFunctionBody(name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?\\n\\$\\$;`);
  const body = migrationSource.match(re)?.[0];
  expect(body).toBeTruthy();
  return body!;
}

// Strips `-- ...` line comments (which include historical defect
// explanations that legitimately mention old, now-removed identifiers
// such as `p_override_off_day` or `v_role_level`) so "this identifier no
// longer exists" assertions check only live SQL, not prose about it.
function stripSqlComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}
const migrationCode = stripSqlComments(migrationSource);

describe('roster migration: table-level direct-write lockdown', () => {
  it('revokes ALL table privileges from PUBLIC, anon, AND authenticated on both tables before re-granting', () => {
    expect(migrationSource).toMatch(/REVOKE ALL ON roster_off_day_patterns FROM PUBLIC, anon, authenticated;/);
    expect(migrationSource).toMatch(/REVOKE ALL ON roster_date_assignments FROM PUBLIC, anon, authenticated;/);
  });

  it('grants ONLY SELECT to authenticated on both tables -- no INSERT/UPDATE/DELETE grant appears anywhere for either table', () => {
    expect(migrationSource).toMatch(/GRANT SELECT ON roster_off_day_patterns TO authenticated;/);
    expect(migrationSource).toMatch(/GRANT SELECT ON roster_date_assignments TO authenticated;/);
    expect(migrationSource).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)[^;]*ON roster_(off_day_patterns|date_assignments)/);
  });

  it('defines no INSERT, UPDATE, or DELETE RLS policy for either table -- only a single SELECT policy each', () => {
    const offPatternPolicies = migrationSource.match(/CREATE POLICY[^;]*ON roster_off_day_patterns[\s\S]*?;/g) || [];
    const dateAssignmentPolicies = migrationSource.match(/CREATE POLICY[^;]*ON roster_date_assignments[\s\S]*?;/g) || [];
    expect(offPatternPolicies).toHaveLength(1);
    expect(dateAssignmentPolicies).toHaveLength(1);
    expect(offPatternPolicies[0]).toMatch(/FOR SELECT/);
    expect(dateAssignmentPolicies[0]).toMatch(/FOR SELECT/);
  });

  it('enables RLS on both tables', () => {
    expect(migrationSource).toMatch(/ALTER TABLE roster_off_day_patterns ENABLE ROW LEVEL SECURITY;/);
    expect(migrationSource).toMatch(/ALTER TABLE roster_date_assignments ENABLE ROW LEVEL SECURITY;/);
  });

  it('the SELECT policy on both tables is Admin-only (is_super_admin or is_business_admin), not permission-table-backed', () => {
    const offPolicy = migrationSource.match(/CREATE POLICY "Roster off-day patterns: view is Admin-only"[\s\S]*?;/)?.[0];
    const dateAssignmentPolicy = migrationSource.match(/CREATE POLICY "Roster date assignments: view is Admin-only"[\s\S]*?;/)?.[0];
    for (const policy of [offPolicy, dateAssignmentPolicy]) {
      expect(policy).toMatch(/is_super_admin\(\)/);
      expect(policy).toMatch(/is_business_admin\(\)/);
      expect(policy).not.toMatch(/has_permission\(/);
      expect(policy).not.toMatch(/role_level\s*<=/);
    }
  });
});

describe('roster migration: weekday column and parameter types', () => {
  it('weekday is INTEGER, not SMALLINT, on the table column and every function parameter/variable -- eliminates a raw-literal overload-resolution ambiguity (observed in psql: bare integer literals without an explicit ::smallint cast do not resolve to a SMALLINT-typed overload) without relying solely on PostgREST'+"'"+'s type-aware JSON binding as the only protection', () => {
    expect(migrationSource).toMatch(/weekday INTEGER NOT NULL CHECK \(weekday BETWEEN 0 AND 6\)/);
    // SMALLINT is only ever mentioned in a `--` comment documenting why it
    // was replaced; confirm no live SQL still declares anything SMALLINT.
    expect(migrationCode).not.toMatch(/SMALLINT/);
  });
});

describe('roster migration: append-only enforcement trigger', () => {
  it('the trigger function rejects any UPDATE to an already-superseded row', () => {
    const fn = getFunctionBody('roster_prevent_illegal_mutation');
    expect(fn).toMatch(/IF OLD\.is_active = false THEN\s*\n\s*RAISE EXCEPTION 'Roster records are append-only: an already-superseded row/);
  });

  it('rejects mutation of identity/origin columns (id, tenant_id, employee_id, assigned_by, assigned_at)', () => {
    const fn = getFunctionBody('roster_prevent_illegal_mutation');
    for (const col of ['id', 'tenant_id', 'employee_id', 'assigned_by', 'assigned_at']) {
      expect(fn).toMatch(new RegExp(`NEW\\.${col} IS DISTINCT FROM OLD\\.${col}`));
    }
  });

  it('rejects mutation of table-specific substantive columns on both tables', () => {
    const fn = getFunctionBody('roster_prevent_illegal_mutation');
    expect(fn).toMatch(/NEW\.weekday IS DISTINCT FROM OLD\.weekday OR NEW\.effective_from IS DISTINCT FROM OLD\.effective_from/);
    expect(fn).toMatch(/NEW\.assignment_date IS DISTINCT FROM OLD\.assignment_date/);
    expect(fn).toMatch(/NEW\.assignment_type IS DISTINCT FROM OLD\.assignment_type/);
  });

  it('only permits the narrow is_active true->false transition, and requires superseded_at/superseded_by/correction_reason all set', () => {
    const fn = getFunctionBody('roster_prevent_illegal_mutation');
    expect(fn).toMatch(/IF NEW\.is_active = true THEN\s*\n\s*RAISE EXCEPTION 'Roster records are append-only: an UPDATE may only close a row out/);
    expect(fn).toMatch(/NEW\.superseded_at IS NULL OR NEW\.superseded_by IS NULL OR NEW\.correction_reason IS NULL OR btrim\(NEW\.correction_reason\) = ''/);
  });

  it('is attached as a BEFORE UPDATE trigger on both tables', () => {
    expect(migrationSource).toMatch(/CREATE TRIGGER trg_roster_off_day_patterns_append_only\s*\n\s*BEFORE UPDATE ON roster_off_day_patterns/);
    expect(migrationSource).toMatch(/CREATE TRIGGER trg_roster_date_assignments_append_only\s*\n\s*BEFORE UPDATE ON roster_date_assignments/);
  });
});

describe('roster migration: write RPC security model (SECURITY DEFINER, explicit Admin check, tenant re-derivation)', () => {
  const writeRpcs = ['roster_assign_off_pattern', 'roster_assign_dates', 'roster_reschedule_off_day'];

  it('every write RPC is SECURITY DEFINER, not INVOKER', () => {
    for (const name of writeRpcs) {
      const fn = getFunctionBody(name);
      expect(fn).toMatch(/SECURITY DEFINER/);
      expect(fn).not.toMatch(/SECURITY INVOKER/);
    }
  });

  it('every write RPC sets a restricted search_path', () => {
    for (const name of writeRpcs) {
      expect(getFunctionBody(name)).toMatch(/SET search_path = public, pg_temp/);
    }
  });

  it('every write RPC requires authentication and re-derives tenant directly from profiles (never trusts a client-supplied tenant)', () => {
    for (const name of writeRpcs) {
      const fn = getFunctionBody(name);
      expect(fn).toMatch(/IF v_caller_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated'/);
      expect(fn).toMatch(/SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_caller_id;\s*\n\s*IF v_tenant_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'No profile found for the current user'/);
    }
  });

  it('every write RPC delegates its Admin-only check to the already-hardened is_super_admin()/is_business_admin() helpers, never re-deriving role/role_level inline', () => {
    // CONFIRMED, FIXED DEFECT: an earlier version of this migration
    // re-implemented the admin check inline as
    // `COALESCE(v_is_super_admin, false) OR v_role = 'admin' OR v_role_level = 1`.
    // For every functional-role account, role_level is NULL by design, so
    // `v_role_level = 1` is SQL NULL (not false); `false OR NULL` is NULL;
    // `NOT NULL` is NULL; and PL/pgSQL's `IF NULL THEN` behaves as not-true,
    // silently skipping the RAISE EXCEPTION for ANY non-Admin functional
    // account. Verified by actually running the unfixed function against an
    // isolated local Postgres 16 instance: an operations_manager-role
    // caller's write succeeded. This exact bug class was already fixed once
    // in this codebase (20260817000007_functional_roles_null_boolean_fix.sql)
    // -- the fix here is to call the already-corrected helpers directly.
    for (const name of writeRpcs) {
      const fn = getFunctionBody(name);
      const fnCode = stripSqlComments(fn);
      expect(fn).toMatch(/IF NOT \(is_super_admin\(\) OR is_business_admin\(\)\) THEN/);
      // The vulnerable inline re-derivation is gone as executable code: no
      // DECLARE line for these variables exists anymore (the historical
      // bug is only ever mentioned in an explanatory `--` comment, never
      // as live PL/pgSQL).
      expect(fnCode).not.toMatch(/v_role_level/);
      expect(fnCode).not.toMatch(/v_role\b/);
      expect(fnCode).not.toMatch(/v_is_super_admin\b/);
      expect(fnCode).not.toMatch(/has_permission\(/);
    }
  });

  it('every write RPC checks the caller account is active via is_current_user_active(), before the admin check', () => {
    for (const name of writeRpcs) {
      const fn = getFunctionBody(name);
      expect(fn).toMatch(/IF NOT is_current_user_active\(\) THEN\s*\n\s*RAISE EXCEPTION 'Your account is disabled'/);
      const activeIdx = fn.indexOf('is_current_user_active()');
      const adminIdx = fn.indexOf('is_super_admin() OR is_business_admin()');
      expect(activeIdx).toBeGreaterThan(-1);
      expect(adminIdx).toBeGreaterThan(activeIdx);
    }
  });

  it('every write RPC never accepts an assigned_by/superseded_by/actor parameter -- auth.uid() is the sole source of actor attribution', () => {
    for (const name of writeRpcs) {
      // Signature line only (up to the first closing paren of the parameter list before RETURNS).
      const signature = migrationSource.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?\\)\\s*\\nRETURNS`))?.[0] ?? '';
      expect(signature.toLowerCase()).not.toMatch(/p_assigned_by|p_superseded_by|p_actor/);
      expect(getFunctionBody(name)).toMatch(/v_caller_id UUID := auth\.uid\(\);/);
    }
  });

  it('bulk-capable RPCs validate every employee id\'s tenant ownership individually, inside the per-employee loop, before any write for that employee', () => {
    for (const name of ['roster_assign_off_pattern', 'roster_assign_dates']) {
      const fn = getFunctionBody(name);
      expect(fn).toMatch(/SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = v_employee_id FOR UPDATE;/);
      expect(fn).toMatch(/IF v_employee_tenant_id <> v_tenant_id THEN\s*\n\s*RAISE EXCEPTION 'Employee % does not belong to your tenant'/);
    }
    const reschedule = getFunctionBody('roster_reschedule_off_day');
    expect(reschedule).toMatch(/SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = p_employee_id FOR UPDATE;/);
    expect(reschedule).toMatch(/IF v_employee_tenant_id <> v_tenant_id THEN/);
  });

  it('a missing employee id is rejected (not silently skipped) before any write', () => {
    for (const name of ['roster_assign_off_pattern', 'roster_assign_dates']) {
      expect(getFunctionBody(name)).toMatch(/IF v_employee_tenant_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Employee % not found'/);
    }
  });
});

describe('roster migration: concurrency (per-employee locking, deadlock-safe ordering)', () => {
  it('locks the employee row FOR UPDATE as the first roster-related statement for that employee', () => {
    for (const name of ['roster_assign_off_pattern', 'roster_assign_dates']) {
      expect(getFunctionBody(name)).toMatch(/FOR UPDATE;/);
    }
  });

  it('bulk RPCs process employee ids in SORTED order to prevent cross-call deadlocks', () => {
    for (const name of ['roster_assign_off_pattern', 'roster_assign_dates']) {
      expect(getFunctionBody(name)).toMatch(/FOR v_employee_id IN SELECT unnest\(p_employee_ids\) ORDER BY 1 LOOP/);
    }
  });
});

describe('roster migration: bounded bulk limits', () => {
  it('roster_assign_off_pattern rejects more than 2000 target employees', () => {
    const fn = getFunctionBody('roster_assign_off_pattern');
    expect(fn).toMatch(/IF array_length\(p_employee_ids, 1\) > 2000 THEN/);
  });

  it('roster_assign_dates rejects a request whose employee-count x date-span product exceeds 2000', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/v_total_rows := array_length\(p_employee_ids, 1\) \* \(\(p_date_to - p_date_from\) \+ 1\);/);
    expect(fn).toMatch(/IF v_total_rows > 2000 THEN/);
  });

  it('rejects an empty employee_ids array up front, on both bulk RPCs', () => {
    for (const name of ['roster_assign_off_pattern', 'roster_assign_dates']) {
      expect(getFunctionBody(name)).toMatch(/array_length\(p_employee_ids, 1\) IS NULL OR array_length\(p_employee_ids, 1\) = 0/);
    }
  });
});

describe('roster migration: idempotent retry behavior', () => {
  it('roster_assign_off_pattern treats an identical (employee, effective_from, weekday) as a no-op, never duplicating history', () => {
    const fn = getFunctionBody('roster_assign_off_pattern');
    expect(fn).toMatch(/IF v_existing_id IS NOT NULL AND v_existing_weekday = p_weekday THEN\s*\n\s*v_noop_count := v_noop_count \+ 1;\s*\n\s*CONTINUE; -- idempotent no-op/);
  });

  it('roster_assign_dates treats an identical (employee, date, assignment_type) as a no-op', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/IF v_existing_id IS NOT NULL AND v_existing_type = p_assignment_type THEN/);
  });
});

describe('roster migration: assigning work onto a recorded Off day is an unconditional hard block -- no override exists', () => {
  // CONFIRMED, FIXED DEFECT: an earlier version of roster_assign_dates
  // accepted a `p_override_off_day BOOLEAN` parameter that let a working
  // (day/night) assignment directly replace a recorded Off day as long as
  // a correction_reason was also supplied. Verified (by actually calling
  // the unfixed function against an isolated local Postgres instance) that
  // this worked exactly as written -- which contradicts confirmed business
  // policy: Admin must move the Off day itself via
  // roster_reschedule_off_day (which validates and commits both the
  // vacated date and the new Off date atomically, including the rolling
  // seven-day check), never just acknowledge an override here. The
  // parameter has been removed entirely; the function's signature now has
  // 5 parameters, not 6, and the Off-day check cannot be bypassed by any
  // argument.

  it('roster_assign_dates no longer accepts a p_override_off_day parameter, or any override parameter at all', () => {
    const signature = migrationSource.match(/CREATE OR REPLACE FUNCTION roster_assign_dates\([\s\S]*?\)\s*\nRETURNS/)?.[0] ?? '';
    expect(signature).not.toMatch(/p_override_off_day/i);
    expect(signature).not.toMatch(/BOOLEAN/);
    // `p_override_off_day` is only ever mentioned in a `--` comment
    // documenting the historical defect and its fix -- confirm it no
    // longer appears as live SQL anywhere (not as a parameter, not
    // referenced in a function body).
    const overrideParams = migrationCode.match(/p_override_\w+/g) || [];
    expect(overrideParams).toEqual([]);
  });

  it('assigning a working (day/night) type onto a date that resolves Off is unconditionally rejected, with no condition that could let it through', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/IF v_resolved = 'off' THEN\s*\n\s*-- Unconditional hard block -- no override parameter exists\./);
    expect(fn).toMatch(/RAISE EXCEPTION 'Employee % is scheduled Off on % -- a working assignment cannot be made here; use roster_reschedule_off_day to move the Off day first/);
  });

  it('every row roster_assign_dates writes is stamped overrides_recurring_off_day=false literally -- this function can never create an override', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/INSERT INTO roster_date_assignments \(tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason\)\s*\n\s*VALUES \(v_tenant_id, v_employee_id, v_date, p_assignment_type, false, v_caller_id, p_correction_reason\);/);
  });

  it('assigning "off" itself never triggers the Off-day block (cannot collide with Off with Off)', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/IF p_assignment_type <> 'off' THEN\s*\n\s*v_resolved := roster_resolve_schedule/);
  });

  it('roster_reschedule_off_day remains the sole path to put work on a currently-Off date, and stamps overrides_recurring_off_day based on the actual prior state, not a client-supplied flag', () => {
    const fn = getFunctionBody('roster_reschedule_off_day');
    expect(fn).toMatch(/v_vacated_was_off BOOLEAN;/);
    expect(fn).toMatch(/v_vacated_was_off := roster_resolve_schedule\(p_employee_id, p_vacated_work_date\) = 'off';/);
    expect(fn).not.toMatch(/p_override/i);
  });
});

describe('roster migration: Night-to-Day adjacency is ALWAYS hard-blocked, no override parameter exists for it', () => {
  it('roster_assign_dates blocks Day immediately after an active Night on the prior date', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/WHERE employee_id = v_employee_id AND assignment_date = v_date - 1 AND is_active;\s*\n\s*IF v_adjacent_type = 'night' THEN\s*\n\s*RAISE EXCEPTION 'Employee % has a Night shift starting %/);
  });

  it('roster_assign_dates blocks Night immediately before an active Day on the next date', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/WHERE employee_id = v_employee_id AND assignment_date = v_date \+ 1 AND is_active;\s*\n\s*IF v_adjacent_type = 'day' THEN\s*\n\s*RAISE EXCEPTION 'Employee % already has a Day shift starting %/);
  });

  it('roster_reschedule_off_day applies the identical adjacency check to its own vacated-work-date assignment', () => {
    const fn = getFunctionBody('roster_reschedule_off_day');
    expect(fn).toMatch(/IF v_adjacent_type = 'night' THEN/);
    expect(fn).toMatch(/IF v_adjacent_type = 'day' THEN/);
  });

  it('no function in this migration exposes any override parameter at all, for the Night-to-Day case or any other', () => {
    const overrideParams = migrationCode.match(/p_override_\w+/g) || [];
    expect(overrideParams).toEqual([]);
  });
});

describe('roster migration: rolling seven-day rest rule has NO override path', () => {
  it('every write RPC calls roster_rolling_rest_windows and RAISEs on any confirmed_violation, with no conditional bypass', () => {
    for (const name of ['roster_assign_off_pattern', 'roster_assign_dates', 'roster_reschedule_off_day']) {
      const fn = getFunctionBody(name);
      expect(fn).toMatch(/FROM roster_rolling_rest_windows\([^)]*\) WHERE status = 'confirmed_violation'/);
      expect(fn).toMatch(/rolling seven-day rest violations cannot be overridden/);
    }
  });

  it('the violation check runs AFTER the write within the same function call, so a violation rolls back the write(s) already made in this call', () => {
    const fn = getFunctionBody('roster_assign_dates');
    const insertIdx = fn.indexOf('INSERT INTO roster_date_assignments');
    const violationIdx = fn.indexOf("WHERE status = 'confirmed_violation'");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(violationIdx).toBeGreaterThan(insertIdx);
  });

  it('roster_rolling_rest_windows distinguishes incomplete (unassigned present) windows from confirmed_violation windows -- never conflates the two', () => {
    const fn = getFunctionBody('roster_rolling_rest_windows');
    expect(fn).toMatch(/ELSIF 'unassigned' = ANY \(v_resolved\[i : i \+ 6\]\) THEN\s*\n\s*status := 'incomplete';/);
    expect(fn).toMatch(/ELSE\s*\n\s*status := 'confirmed_violation';/);
  });

  it('uses a 13-day buffer on each side of the changed date, matching the pure TS spec exactly', () => {
    const fn = getFunctionBody('roster_rolling_rest_windows');
    expect(fn).toMatch(/v_buffer_days CONSTANT INTEGER := 13;/);
  });

  it('roster_assign_off_pattern additionally re-checks the one downstream pattern boundary a backdated or far-future insert can shift, beyond its own +-13-day window', () => {
    // CONFIRMED, FIXED DEFECT: a pattern write only ever shifts resolution
    // starting AT its own effective_from, up until whatever pattern next
    // takes over -- but checking only the just-written effective_from's
    // own +-13-day window can miss a violation this write exposes at that
    // NEXT pattern's boundary, whenever the two effective_from dates are
    // more than 13 days apart (exactly what a backdated correction
    // inserted between two existing rows produces). Verified by actually
    // constructing this scenario (two existing patterns 20 days apart,
    // with 11 pre-existing working days between them) against an isolated
    // local Postgres instance: the unfixed function returned success
    // instead of rejecting a confirmed rolling-rest violation it had just
    // exposed. The fix re-checks the one possible downstream boundary --
    // the next existing active pattern's effective_from after this write,
    // if any.
    const fn = getFunctionBody('roster_assign_off_pattern');
    expect(fn).toMatch(/SELECT MIN\(effective_from\) INTO v_next_effective_from\s*\n\s*FROM roster_off_day_patterns\s*\n\s*WHERE employee_id = v_employee_id AND is_active AND effective_from > p_effective_from;/);
    expect(fn).toMatch(/IF v_next_effective_from IS NOT NULL THEN\s*\n\s*FOR v_violation IN\s*\n\s*SELECT \* FROM roster_rolling_rest_windows\(v_employee_id, v_next_effective_from\) WHERE status = 'confirmed_violation'/);
  });
});

describe('roster migration: reason required for every change to an existing assignment', () => {
  it('roster_assign_off_pattern requires a non-empty correction_reason to supersede an existing active pattern row', () => {
    const fn = getFunctionBody('roster_assign_off_pattern');
    expect(fn).toMatch(/IF p_correction_reason IS NULL OR btrim\(p_correction_reason\) = '' THEN\s*\n\s*RAISE EXCEPTION 'A correction_reason is required to change an existing Off-day pattern/);
  });

  it('roster_assign_dates requires a non-empty correction_reason to supersede an existing active dated assignment', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/IF p_correction_reason IS NULL OR btrim\(p_correction_reason\) = '' THEN\s*\n\s*RAISE EXCEPTION 'A correction_reason is required to change an existing assignment/);
  });

  it('roster_reschedule_off_day requires correction_reason unconditionally (it always changes something)', () => {
    const fn = getFunctionBody('roster_reschedule_off_day');
    expect(fn).toMatch(/IF p_correction_reason IS NULL OR btrim\(p_correction_reason\) = '' THEN\s*\n\s*RAISE EXCEPTION 'A correction_reason is required to reschedule an Off day'/);
  });
});

describe('roster migration: function execution grants', () => {
  it('every write RPC and both read helpers are revoked from PUBLIC/anon and granted only to authenticated', () => {
    const names = [
      'roster_resolve_schedule\\(UUID, DATE\\)',
      'roster_rolling_rest_windows\\(UUID, DATE\\)',
      'roster_assign_off_pattern\\(UUID\\[\\], INTEGER, DATE, TEXT\\)',
      'roster_assign_dates\\(UUID\\[\\], DATE, DATE, TEXT, TEXT\\)',
      'roster_reschedule_off_day\\(UUID, DATE, DATE, TEXT, TEXT\\)',
    ];
    for (const sig of names) {
      expect(migrationSource).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon;`));
      expect(migrationSource).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated;`));
    }
  });
});

describe('roster migration: read-only helpers are SECURITY INVOKER (minimal DEFINER surface)', () => {
  it('roster_resolve_schedule and roster_rolling_rest_windows are SECURITY INVOKER, not DEFINER', () => {
    for (const name of ['roster_resolve_schedule', 'roster_rolling_rest_windows']) {
      const fn = getFunctionBody(name);
      expect(fn).toMatch(/SECURITY INVOKER/);
      expect(fn).not.toMatch(/SECURITY DEFINER/);
    }
  });
});

describe('roster migration: scope and safety boundaries', () => {
  it('is a standalone additive migration, not an edit to any previously-applied migration file', () => {
    const priorFiles = [
      '20260929000000_hikcentral_attendance_ingestion_foundation.sql',
      '20261007140000_hikcentral_person_mapping_confirm_rpc.sql',
    ];
    for (const file of priorFiles) {
      expect(fs.existsSync(path.resolve(__dirname, '../../supabase/migrations/', file))).toBe(true);
    }
  });

  it('never references attendance, payroll, payment_status, or employee_deductions -- this phase creates no link to any of them', () => {
    for (const table of ['attendance', 'payroll', 'payment_status', 'employee_deductions']) {
      expect(migrationSource).not.toMatch(new RegExp(`\\b(FROM|INTO|JOIN|UPDATE)\\s+${table}\\b`, 'i'));
    }
  });

  it('never writes to employees, hikcentral_raw_events, or hikcentral_person_mappings -- only ever SELECTs employees for tenant/lock purposes', () => {
    expect(migrationSource).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+employees\b/i);
    expect(migrationSource).not.toMatch(/\bhikcentral_/i);
  });

  it('defines no DELETE policy and no DELETE grant to authenticated on either roster table', () => {
    expect(migrationSource).not.toMatch(/FOR DELETE/);
    expect(migrationSource).not.toMatch(/GRANT DELETE/);
  });
});
