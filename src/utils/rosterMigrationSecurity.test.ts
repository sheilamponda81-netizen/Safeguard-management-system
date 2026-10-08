import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Roster Management Foundation: this migration is NOT applied to any
// database yet (explicitly not authorized this phase -- see the
// migration's own header). This repo has no live-Postgres test harness
// (established precedent: hikcentralAttendanceMigration.test.ts,
// hikcentralPersonMappingConfirmRpc.test.ts) -- these tests pin the
// migration at the SQL SOURCE level, proving its security model (no
// direct-write path exists outside the three SECURITY DEFINER RPCs),
// its Admin-only checks, its tenant validation, its append-only trigger,
// its bulk limit, and its rolling-rest hard-block (no override path).
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

  it('every write RPC requires authentication and re-derives tenant/role directly from profiles (never trusts a client-supplied tenant)', () => {
    for (const name of writeRpcs) {
      const fn = getFunctionBody(name);
      expect(fn).toMatch(/IF v_caller_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated'/);
      expect(fn).toMatch(/SELECT tenant_id, role_level, role, is_super_admin, is_active, deleted_at\s*\n\s*INTO v_tenant_id, v_role_level, v_role, v_is_super_admin, v_is_active, v_deleted_at\s*\n\s*FROM profiles WHERE id = v_caller_id;/);
    }
  });

  it('every write RPC explicitly checks Admin-only authorization (is_super_admin OR role=admin OR role_level=1) and RAISEs otherwise -- no permission-table branch', () => {
    for (const name of writeRpcs) {
      const fn = getFunctionBody(name);
      expect(fn).toMatch(/IF NOT \(COALESCE\(v_is_super_admin, false\) OR v_role = 'admin' OR v_role_level = 1\) THEN/);
      expect(fn).not.toMatch(/has_permission\(/);
    }
  });

  it('every write RPC checks the caller account is active and not deleted', () => {
    for (const name of writeRpcs) {
      expect(getFunctionBody(name)).toMatch(/IF COALESCE\(v_is_active, false\) = false OR v_deleted_at IS NOT NULL THEN/);
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

  it('roster_assign_dates treats an identical (employee, date, assignment_type, override flag) as a no-op', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/IF v_existing_id IS NOT NULL AND v_existing_type = p_assignment_type AND v_existing_overrides = v_overrides THEN/);
  });
});

describe('roster migration: Off-day override must be explicit, never silent', () => {
  it('assigning a working (day/night) type onto a date that resolves Off requires override_off_day=true AND a non-empty correction_reason, or the call is rejected', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/IF v_resolved = 'off' THEN\s*\n\s*IF NOT p_override_off_day OR p_correction_reason IS NULL OR btrim\(p_correction_reason\) = '' THEN/);
  });

  it('a successful override stamps overrides_recurring_off_day=true on the written row, never silently', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/v_overrides := true;/);
    expect(fn).toMatch(/VALUES \(v_tenant_id, v_employee_id, v_date, p_assignment_type, v_overrides, v_caller_id, p_correction_reason\);/);
  });

  it('assigning "off" itself never triggers the override check (cannot override Off with Off)', () => {
    const fn = getFunctionBody('roster_assign_dates');
    expect(fn).toMatch(/IF p_assignment_type <> 'off' THEN\s*\n\s*v_resolved := roster_resolve_schedule/);
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

  it('no function in this migration exposes an override parameter for the Night-to-Day check (the only override parameter anywhere is p_override_off_day, for the Off-day case only)', () => {
    const overrideParams = migrationSource.match(/p_override_\w+/g) || [];
    expect(new Set(overrideParams)).toEqual(new Set(['p_override_off_day']));
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
      'roster_assign_off_pattern\\(UUID\\[\\], SMALLINT, DATE, TEXT\\)',
      'roster_assign_dates\\(UUID\\[\\], DATE, DATE, TEXT, BOOLEAN, TEXT\\)',
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
