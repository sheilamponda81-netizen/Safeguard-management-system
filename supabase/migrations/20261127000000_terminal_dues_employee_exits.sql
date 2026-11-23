-- ============================================================
-- MIGRATION: Terminal Dues Phase 1 -- structured employee exit records
-- Date: 2026-11-27
-- ============================================================
--
-- CONFIRMED GAP (discovery, read-only investigation):
-- `employees` has no termination_date/exit_reason column at all, and its
-- `status` column (free text, no CHECK constraint) is only ever set to
-- 'Active' or 'On Leave' in production -- never anything representing an
-- exit. Exit metadata (date_left/reason_for_termination/termination_type)
-- only ever lived INSIDE a `terminal_dues` row, created at settlement
-- time -- and in production, `terminal_dues` has ZERO rows, so this
-- information has never actually been captured anywhere, structured or
-- not. Separately, 206 employees are soft-deleted (`employees.is_deleted`)
-- with messy, inconsistent free-text `deleted_reason` values mixing real
-- exits (dismissed/resigned/absconded/fired/end of contract/transferred)
-- with unrelated administrative actions (43 import corrections, 4
-- duplicates, 1 fake account) -- this migration does NOT touch, classify,
-- or read `is_deleted`/`deleted_reason` in any way; see the final section
-- of this header.
--
-- THIS MIGRATION ADDS (new, isolated schema -- same "don't touch the
-- hardened terminal_dues/terminal_due_calculations tables themselves"
-- principle 20261020000001 established for historical_employees):
--
-- 1. `employee_exits` -- one row per recorded exit for a CURRENT
--    `employees` row (NOT historical_employees, which already has its
--    own structured date_left/reason_for_leaving/termination_type columns
--    and is out of scope here). Lifecycle: 'scheduled' (just recorded,
--    employment status NOT yet changed) -> 'finalized' (explicit,
--    separate action; this is the ONLY thing in this migration that ever
--    writes employees.status) -> optionally 'cancelled' from either state
--    (undoes the status change if one was made). A partial unique index
--    blocks a second non-cancelled exit record for the same employee.
-- 2. Nullable `employee_exit_id` link columns on BOTH `terminal_due_
--    calculations` and `terminal_dues` -- purely additive, no existing
--    row touched, no existing column removed, no CHECK constraint on
--    either table changed. `submit_terminal_due_calculation` (replaced
--    below with the EXACT SAME signature `(p_id UUID)` -- see the
--    PR #72 lesson this migration deliberately follows: a signature
--    change creates a dangling duplicate overload, so this is a true
--    CREATE OR REPLACE, never a new overload) now carries a draft's
--    `employee_exit_id` through to the `terminal_dues` row it creates,
--    verbatim, with NO other change to that function's extensively
--    safety-enforced validation logic, its two INSERT column lists
--    (otherwise byte-for-byte identical to the 20261105000000 version),
--    or any amount it computes or checks.
--
-- EXPLICITLY NOT CHANGED (per this phase's own scope boundary):
-- severance/gratuity/uniform-refund formulas (terminalDuesEngine.ts,
-- untouched), payroll allocations, settlement approval/payment
-- permissions, historical payroll, any previously approved/paid
-- `terminal_dues` row (none exist in production, but the mechanism is
-- the same regardless), `employees.is_deleted`, Attendance/Payroll's own
-- active-roster queries (which filter on `is_deleted`, not `status` --
-- an employee whose exit is finalized here is NOT automatically removed
-- from those rosters; wiring that integration is explicitly a later
-- phase's decision, not assumed here), and no soft-deleted employee is
-- read, classified, or converted into an exit record by this migration.
-- ============================================================

-- ============================================================
-- PART 1: employee_exits
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_exits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- Denormalized from employees.region_id at creation time, same pattern
  -- as terminal_due_calculations.region_id -- used only for the SELECT
  -- RLS policy below; every mutating RPC re-checks the employee's LIVE
  -- region_id, never trusts this copy for an authorization decision.
  region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
  effective_exit_date DATE NOT NULL,
  exit_category TEXT NOT NULL CHECK (exit_category IN (
    'resignation', 'contract_expiry', 'dismissal', 'redundancy', 'retirement', 'death', 'other'
  )),
  notes TEXT,
  -- 'scheduled': recorded, employment status NOT yet changed.
  -- 'finalized': the one explicit, separate, authorized action
  -- (finalize_employee_exit) that sets employees.status -- never
  -- reachable directly from INSERT.
  -- 'cancelled': terminal; undoes the status change if 'finalized' had
  -- made one. A cancelled row is never reactivated -- record a new one.
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'finalized', 'cancelled')),
  recorded_by UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- finalized_at is intentionally NOT tied to status = 'finalized' alone:
  -- a later-cancelled exit keeps finalized_at as the historical record of
  -- when it WAS finalized, even though status has since moved on.
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

-- At most one non-cancelled (scheduled or finalized) exit per employee at
-- any time -- the database-enforced "no conflicting active exit records"
-- guarantee. A cancelled row never counts, so a corrected/retracted exit
-- never blocks recording a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_exits_one_active_per_employee
  ON employee_exits(employee_id) WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_employee_exits_tenant_status ON employee_exits(tenant_id, status);

ALTER TABLE employee_exits ENABLE ROW LEVEL SECURITY;

-- Read access mirrors terminal_due_calculations' own read policy exactly
-- (same role set already handles Terminal Dues; exit records are the
-- same kind of HR-sensitive data).
CREATE POLICY "Employee exits: read within tenant+region, terminal-dues role" ON employee_exits
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND (region_id IS NULL OR region_allowed(region_id))
      AND (
        has_explicit_permission('terminal_dues.view')
        OR has_explicit_permission('terminal_dues.create')
        OR has_explicit_permission('terminal_dues.edit')
      )
    )
  )
);

-- No direct client INSERT or UPDATE: every mutation (create/correct/
-- finalize/cancel) goes through a narrow SECURITY DEFINER RPC below, so
-- the one-active-per-employee guarantee, the finalize-is-a-separate-
-- explicit-action rule, and the audit trail can never be bypassed by a
-- raw client write. A true super admin's own direct write is still
-- permitted, the same exception every other Terminal Dues policy in this
-- codebase makes.
CREATE POLICY "Employee exits: no direct client write" ON employee_exits
FOR INSERT WITH CHECK (is_super_admin());

CREATE POLICY "Employee exits: no direct client update" ON employee_exits
FOR UPDATE USING (is_super_admin()) WITH CHECK (is_super_admin());

-- No DELETE policy: default-deny. An exit record, once created, is only
-- ever cancelled (a new, auditable status), never removed.

GRANT SELECT ON employee_exits TO authenticated;
GRANT INSERT, UPDATE ON employee_exits TO authenticated; -- gated to is_super_admin() by the policies above; the RPCs below run as owner and are unaffected by this grant either way.

-- ============================================================
-- PART 2: RPCs
-- ============================================================

CREATE OR REPLACE FUNCTION record_employee_exit(
  p_employee_id UUID,
  p_effective_exit_date DATE,
  p_exit_category TEXT,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_employee RECORD;
  v_new_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.create')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.create (or a super admin) may record an employee exit';
  END IF;

  IF p_effective_exit_date IS NULL THEN
    RAISE EXCEPTION 'Effective exit date is required';
  END IF;

  IF p_exit_category IS NULL OR p_exit_category NOT IN (
    'resignation', 'contract_expiry', 'dismissal', 'redundancy', 'retirement', 'death', 'other'
  ) THEN
    RAISE EXCEPTION 'Exit category must be one of resignation, contract_expiry, dismissal, redundancy, retirement, death, other';
  END IF;

  SELECT * INTO v_employee FROM employees WHERE id = p_employee_id;
  IF v_employee IS NULL OR (v_employee.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  IF NOT (is_super_admin() OR is_business_admin()) AND NOT region_allowed(v_employee.region_id) THEN
    RAISE EXCEPTION 'This employee is outside your assigned region';
  END IF;

  BEGIN
    INSERT INTO employee_exits (
      tenant_id, employee_id, region_id, effective_exit_date, exit_category, notes, recorded_by
    ) VALUES (
      v_tenant_id, p_employee_id, v_employee.region_id, p_effective_exit_date, p_exit_category, p_notes, v_caller_id
    ) RETURNING id INTO v_new_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This employee already has an open (scheduled or finalized) exit record -- cancel it first if it is incorrect';
  END;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'CREATE', 'employee_exit', v_new_id::text,
    NULL,
    jsonb_build_object('employee_id', p_employee_id, 'effective_exit_date', p_effective_exit_date, 'exit_category', p_exit_category, 'status', 'scheduled')
  );

  RETURN jsonb_build_object('success', true, 'id', v_new_id, 'status', 'scheduled');
END;
$$;

REVOKE ALL ON FUNCTION record_employee_exit(UUID, DATE, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_employee_exit(UUID, DATE, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION record_employee_exit(UUID, DATE, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION correct_employee_exit(
  p_exit_id UUID,
  p_effective_exit_date DATE,
  p_exit_category TEXT,
  p_notes TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_row RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.edit')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.edit (or a super admin) may correct an employee exit';
  END IF;

  IF trim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A correction reason is required';
  END IF;

  IF p_exit_category IS NULL OR p_exit_category NOT IN (
    'resignation', 'contract_expiry', 'dismissal', 'redundancy', 'retirement', 'death', 'other'
  ) THEN
    RAISE EXCEPTION 'Exit category must be one of resignation, contract_expiry, dismissal, redundancy, retirement, death, other';
  END IF;

  IF p_effective_exit_date IS NULL THEN
    RAISE EXCEPTION 'Effective exit date is required';
  END IF;

  SELECT * INTO v_row FROM employee_exits WHERE id = p_exit_id FOR UPDATE;
  IF v_row IS NULL OR (v_row.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Employee exit record not found';
  END IF;
  IF NOT (is_super_admin() OR is_business_admin()) AND NOT (v_row.region_id IS NULL OR region_allowed(v_row.region_id)) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_row.status <> 'scheduled' THEN
    RAISE EXCEPTION 'Cannot correct a % exit record -- only a scheduled (not yet finalized) exit can be corrected; cancel and record a new one instead', v_row.status;
  END IF;

  UPDATE employee_exits SET
    effective_exit_date = p_effective_exit_date,
    exit_category = p_exit_category,
    notes = p_notes,
    updated_at = NOW()
  WHERE id = p_exit_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'UPDATE', 'employee_exit', p_exit_id::text,
    jsonb_build_object('effective_exit_date', v_row.effective_exit_date, 'exit_category', v_row.exit_category, 'notes', v_row.notes),
    jsonb_build_object('effective_exit_date', p_effective_exit_date, 'exit_category', p_exit_category, 'notes', p_notes, 'reason', p_reason)
  );

  RETURN jsonb_build_object('success', true, 'id', p_exit_id, 'status', 'scheduled');
END;
$$;

REVOKE ALL ON FUNCTION correct_employee_exit(UUID, DATE, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION correct_employee_exit(UUID, DATE, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION correct_employee_exit(UUID, DATE, TEXT, TEXT, TEXT) TO authenticated;

-- finalize_employee_exit: the ONLY RPC in this migration that ever writes
-- employees.status (per Step 3's explicit requirement: "Employment-status
-- changes occur only through an explicit, authorized action"). Requires
-- the same terminal_dues.approve bar as approve_terminal_due() itself --
-- a status-changing action gets the higher permission tier, not the
-- create/edit tier.
CREATE OR REPLACE FUNCTION finalize_employee_exit(p_exit_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_row RECORD;
  v_employee RECORD;
  v_old_employee_status TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may finalize an employee exit';
  END IF;

  SELECT * INTO v_row FROM employee_exits WHERE id = p_exit_id FOR UPDATE;
  IF v_row IS NULL OR (v_row.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Employee exit record not found';
  END IF;
  IF NOT (is_super_admin() OR is_business_admin()) AND NOT (v_row.region_id IS NULL OR region_allowed(v_row.region_id)) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_row.status <> 'scheduled' THEN
    RAISE EXCEPTION 'Cannot finalize a % exit record -- only a scheduled exit can be finalized', v_row.status;
  END IF;

  SELECT * INTO v_employee FROM employees WHERE id = v_row.employee_id FOR UPDATE;
  IF v_employee IS NULL THEN
    RAISE EXCEPTION 'The employee for this exit record could not be found';
  END IF;
  v_old_employee_status := v_employee.status;

  UPDATE employee_exits SET
    status = 'finalized',
    finalized_by = v_caller_id,
    finalized_at = NOW(),
    updated_at = NOW()
  WHERE id = p_exit_id;

  UPDATE employees SET status = 'Exited' WHERE id = v_row.employee_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'FINALIZE', 'employee_exit', p_exit_id::text,
    jsonb_build_object('status', 'scheduled', 'employee_status', v_old_employee_status),
    jsonb_build_object('status', 'finalized', 'employee_status', 'Exited')
  );

  RETURN jsonb_build_object('success', true, 'id', p_exit_id, 'status', 'finalized');
END;
$$;

REVOKE ALL ON FUNCTION finalize_employee_exit(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_employee_exit(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION finalize_employee_exit(UUID) TO authenticated;

-- cancel_employee_exit: terminal state, from either 'scheduled' or
-- 'finalized'. Reverts employees.status back to 'Active' ONLY when the
-- cancelled record had actually reached 'finalized' (i.e. only when THIS
-- mechanism had changed it) -- never otherwise. Same terminal_dues.approve
-- bar as finalize, since undoing a status change is the same tier of
-- authority as making one.
CREATE OR REPLACE FUNCTION cancel_employee_exit(p_exit_id UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_row RECORD;
  v_employee_status TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may cancel an employee exit';
  END IF;

  IF trim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A cancellation reason is required';
  END IF;

  SELECT * INTO v_row FROM employee_exits WHERE id = p_exit_id FOR UPDATE;
  IF v_row IS NULL OR (v_row.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Employee exit record not found';
  END IF;
  IF NOT (is_super_admin() OR is_business_admin()) AND NOT (v_row.region_id IS NULL OR region_allowed(v_row.region_id)) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_row.status = 'cancelled' THEN
    RAISE EXCEPTION 'This exit record is already cancelled';
  END IF;

  UPDATE employee_exits SET
    status = 'cancelled',
    cancelled_by = v_caller_id,
    cancelled_at = NOW(),
    cancellation_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_exit_id;

  -- Deliberately selects a single scalar column (v_employee_status), never
  -- `SELECT * INTO a_record_variable` tested with "IS NOT NULL" -- a
  -- composite/RECORD's "IS NOT NULL" requires EVERY field to be non-null
  -- (the standard SQL row-value-null semantics), not merely "a row was
  -- found"; `employees` has many genuinely nullable columns (phone,
  -- position, department, ...), so that check would silently evaluate to
  -- false for a perfectly real, found row whenever any such column
  -- happened to be null -- exactly the trap that made this revert
  -- silently never fire during this migration's own pre-merge testing.
  IF v_row.status = 'finalized' THEN
    SELECT status INTO v_employee_status FROM employees WHERE id = v_row.employee_id FOR UPDATE;
    IF FOUND AND v_employee_status = 'Exited' THEN
      UPDATE employees SET status = 'Active' WHERE id = v_row.employee_id;
    END IF;
  END IF;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'CANCEL', 'employee_exit', p_exit_id::text,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', 'cancelled', 'reason', p_reason, 'reverted_employee_status', (v_row.status = 'finalized'))
  );

  RETURN jsonb_build_object('success', true, 'id', p_exit_id, 'status', 'cancelled');
END;
$$;

REVOKE ALL ON FUNCTION cancel_employee_exit(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_employee_exit(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION cancel_employee_exit(UUID, TEXT) TO authenticated;

-- ============================================================
-- PART 3: additive linkage columns (no existing row touched)
-- ============================================================

ALTER TABLE terminal_due_calculations ADD COLUMN IF NOT EXISTS employee_exit_id UUID REFERENCES employee_exits(id) ON DELETE SET NULL;
ALTER TABLE terminal_dues ADD COLUMN IF NOT EXISTS employee_exit_id UUID REFERENCES employee_exits(id) ON DELETE SET NULL;

-- ============================================================
-- PART 4: submit_terminal_due_calculation -- TRUE replace, identical
-- signature `(p_id UUID)` to the live 20261105000000 definition. The
-- ONLY functional change anywhere in this body is that both INSERT INTO
-- terminal_dues statements now also carry employee_exit_id through from
-- the draft -- every validation rule, computed amount, and exception
-- message is otherwise byte-for-byte unchanged.
-- ============================================================

CREATE OR REPLACE FUNCTION submit_terminal_due_calculation(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_row RECORD;
  v_employee RECORD;
  v_historical RECORD;
  v_new_terminal_due_id UUID;
  v_previous_version JSONB;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.create') OR has_explicit_permission('terminal_dues.edit')) THEN
    RAISE EXCEPTION 'Only an explicitly granted Terminal Dues create/edit role (or a super admin) may submit a draft calculation';
  END IF;

  SELECT * INTO v_row FROM terminal_due_calculations WHERE id = p_id FOR UPDATE;

  IF v_row IS NULL OR (v_row.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due calculation not found';
  END IF;

  IF NOT is_super_admin() AND v_row.region_id IS NOT NULL AND NOT region_allowed(v_row.region_id) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'This calculation has already been submitted (status: %)', v_row.status;
  END IF;

  -- Safety enforcement: correction reasons, authoritative employment
  -- dates, uniform refund arithmetic and total_payable consistency. Runs
  -- on the stored draft (v_row.inputs/v_row.breakdown/v_row.total_payable),
  -- not on client-supplied parameters -- submit_terminal_due_calculation()
  -- takes no inputs of its own, so this closes the bypass where a draft
  -- saved with a mismatch (however it got that way, including a raw
  -- INSERT that never went through update_terminal_due_calculation_draft())
  -- is promoted into the authoritative terminal_dues workflow without ever
  -- being blocked. See migration header comment for the full rationale.
  DECLARE
    v_employee_hire_date DATE;
    v_employee_tenant_id UUID;
    v_date_joined DATE;
    v_date_left DATE;
    v_system_months INTEGER;
    v_override_months NUMERIC;
    v_override_reason TEXT;
    v_effective_months NUMERIC;
    v_entered_uniform_months NUMERIC;
    v_entered_uniform_reason TEXT;
    v_evidence_months INTEGER;
    v_current_rate NUMERIC;
    v_claimed_rate NUMERIC;
    v_final_salary NUMERIC;
    v_computed_pension_arrears NUMERIC;
    v_breakdown_pension_arrears NUMERIC;
    v_computed_uniform_refund NUMERIC;
    v_breakdown_uniform_refund NUMERIC;
    v_computed_entitlements NUMERIC;
    v_computed_total_payable NUMERIC;
    v_breakdown_total_payable NUMERIC;
  BEGIN
    IF v_row.employee_id IS NOT NULL THEN
      SELECT hire_date, tenant_id INTO v_employee_hire_date, v_employee_tenant_id
      FROM employees WHERE id = v_row.employee_id;

      IF v_employee_hire_date IS NULL OR (v_employee_tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
        RAISE EXCEPTION 'The employee for this calculation could not be found';
      END IF;

      v_date_joined := v_employee_hire_date;
    ELSE
      BEGIN
        v_date_joined := (v_row.inputs->>'dateJoined')::date;
      EXCEPTION WHEN OTHERS THEN
        v_date_joined := NULL;
      END;
    END IF;

    BEGIN
      v_date_left := (v_row.inputs->>'dateLeft')::date;
    EXCEPTION WHEN OTHERS THEN
      v_date_left := NULL;
    END;

    IF v_date_joined IS NOT NULL AND v_date_left IS NOT NULL AND v_date_left > v_date_joined THEN
      v_system_months := (EXTRACT(YEAR FROM v_date_left)::int - EXTRACT(YEAR FROM v_date_joined)::int) * 12
                        + (EXTRACT(MONTH FROM v_date_left)::int - EXTRACT(MONTH FROM v_date_joined)::int);
      IF EXTRACT(DAY FROM v_date_left)::int < EXTRACT(DAY FROM v_date_joined)::int THEN
        v_system_months := v_system_months - 1;
      END IF;
      v_system_months := GREATEST(0, v_system_months);
    ELSE
      v_system_months := 0;
    END IF;

    BEGIN
      v_override_months := (v_row.inputs->>'pensionMonthsOverride')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_override_months := NULL;
    END;
    v_override_reason := trim(coalesce(v_row.inputs->>'pensionMonthsOverrideReason', ''));

    IF v_override_months IS NOT NULL AND v_override_months <> v_system_months AND v_override_reason = '' THEN
      RAISE EXCEPTION 'A correction reason is required: the entered completed months (%) differ from the system-calculated months (%)', v_override_months, v_system_months;
    END IF;

    v_effective_months := CASE
      WHEN v_override_months IS NOT NULL AND v_override_months >= 0 THEN v_override_months
      ELSE v_system_months
    END;

    BEGIN
      v_entered_uniform_months := (v_row.inputs->>'uniformDeductionMonths')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_entered_uniform_months := NULL;
    END;
    IF v_entered_uniform_months IS NULL OR v_entered_uniform_months < 0 THEN
      RAISE EXCEPTION 'Uniform deduction months must be a valid, non-negative number';
    END IF;
    v_entered_uniform_reason := trim(coalesce(v_row.inputs->>'uniformDeductionCorrectionReason', ''));

    IF v_row.employee_id IS NOT NULL THEN
      SELECT COUNT(*) INTO v_evidence_months
      FROM payroll
      WHERE employee_id = v_row.employee_id AND tenant_id = v_tenant_id AND uniform_deduction > 0;

      IF v_entered_uniform_months IS DISTINCT FROM v_evidence_months::numeric AND v_entered_uniform_reason = '' THEN
        RAISE EXCEPTION 'A correction reason is required: the entered uniform-deduction months (%) differ from payroll evidence (%)', v_entered_uniform_months, v_evidence_months;
      END IF;
    END IF;

    BEGIN
      SELECT value::numeric INTO v_current_rate
      FROM system_settings
      WHERE tenant_id = v_tenant_id AND key = 'terminal_dues_uniform_refund_rate';
    EXCEPTION WHEN OTHERS THEN
      v_current_rate := NULL;
    END;
    IF v_current_rate IS NULL OR v_current_rate <= 0 THEN
      v_current_rate := 10000; -- DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH, mirrored from terminalDuesEngine.ts
    END IF;

    BEGIN
      v_claimed_rate := (v_row.inputs->>'uniformRefundRatePerMonth')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_claimed_rate := NULL;
    END;

    IF v_claimed_rate IS NULL OR v_claimed_rate <> v_current_rate THEN
      RAISE EXCEPTION 'The uniform refund rate used in this calculation does not match the current approved rate of %. Reopen the draft, refresh the Calculator and recalculate before submitting.', v_current_rate;
    END IF;

    BEGIN
      v_final_salary := (v_row.inputs->>'finalSalary')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_final_salary := NULL;
    END;
    IF v_final_salary IS NULL OR v_final_salary <= 0 THEN
      RAISE EXCEPTION 'Final salary must be greater than zero';
    END IF;

    v_computed_pension_arrears := CEIL(ROUND(v_effective_months * v_final_salary * 0.1, 6));
    BEGIN
      v_breakdown_pension_arrears := (v_row.breakdown->>'pensionArrears')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_breakdown_pension_arrears := NULL;
    END;
    IF v_breakdown_pension_arrears IS NULL OR v_breakdown_pension_arrears <> v_computed_pension_arrears THEN
      RAISE EXCEPTION 'The pension arrears in this calculation (%) do not match the validated amount of % for % effective months at a final salary of %', v_breakdown_pension_arrears, v_computed_pension_arrears, v_effective_months, v_final_salary;
    END IF;

    v_computed_uniform_refund := CASE WHEN v_entered_uniform_months > 0 THEN CEIL(ROUND(v_entered_uniform_months * v_current_rate, 6)) ELSE 0 END;
    BEGIN
      v_breakdown_uniform_refund := (v_row.breakdown->>'uniformRefund')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_breakdown_uniform_refund := NULL;
    END;
    IF v_breakdown_uniform_refund IS NULL OR v_breakdown_uniform_refund <> v_computed_uniform_refund THEN
      RAISE EXCEPTION 'The uniform refund in this calculation (%) does not match the validated amount of % for % months at the current rate of %', v_breakdown_uniform_refund, v_computed_uniform_refund, v_entered_uniform_months, v_current_rate;
    END IF;

    v_computed_entitlements := CEIL(ROUND(
      v_computed_pension_arrears
      + coalesce((v_row.breakdown->>'annualLeaveRefund')::numeric, 0)
      + v_computed_uniform_refund
      + coalesce((v_row.breakdown->>'outstandingSalaryTotal')::numeric, 0)
    , 6));
    v_computed_total_payable := GREATEST(0, v_computed_entitlements - coalesce((v_row.breakdown->>'lessNoticeDeduction')::numeric, 0));

    BEGIN
      v_breakdown_total_payable := (v_row.breakdown->>'totalPayable')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_breakdown_total_payable := NULL;
    END;

    IF v_breakdown_total_payable IS NULL OR v_breakdown_total_payable <> v_computed_total_payable OR v_row.total_payable <> v_computed_total_payable THEN
      RAISE EXCEPTION 'The total payable in this calculation does not match the validated amount of % derived from its own breakdown', v_computed_total_payable;
    END IF;
  END;

  IF v_row.employee_id IS NOT NULL THEN
    SELECT * INTO v_employee FROM employees WHERE id = v_row.employee_id;
    IF v_employee IS NULL OR v_employee.tenant_id <> v_tenant_id THEN
      RAISE EXCEPTION 'The employee for this calculation could not be found';
    END IF;
    IF NOT is_super_admin() AND NOT region_allowed(v_employee.region_id) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;

    BEGIN
      INSERT INTO terminal_dues (
        tenant_id, employee_id, employee_name, employee_number, position,
        date_joined, date_left, period_months, basic_salary,
        gratuity, annual_leave, uniform_refund, other_benefits,
        subtotal, deductions, total_payable, status, employee_exit_id
      ) VALUES (
        v_tenant_id, v_employee.id, v_employee.full_name, v_employee.employee_number, v_employee.position,
        (v_row.inputs->>'dateJoined')::date, (v_row.inputs->>'dateLeft')::date,
        (v_row.breakdown->>'effectiveMonths')::integer, (v_row.inputs->>'finalSalary')::numeric,
        (v_row.breakdown->>'pensionArrears')::numeric, (v_row.breakdown->>'annualLeaveRefund')::numeric,
        (v_row.breakdown->>'uniformRefund')::numeric, (v_row.breakdown->>'outstandingSalaryTotal')::numeric,
        (v_row.breakdown->>'totalEntitlements')::numeric, (v_row.breakdown->>'lessNoticeDeduction')::numeric,
        (v_row.breakdown->>'totalPayable')::numeric, 'pending', v_row.employee_exit_id
      ) RETURNING id INTO v_new_terminal_due_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'This employee already has an open Terminal Due in the existing Records workflow -- resolve or complete that one before submitting this calculation.';
    END;
  ELSE
    SELECT * INTO v_historical FROM historical_employees WHERE id = v_row.historical_employee_id;
    IF v_historical IS NULL OR v_historical.tenant_id <> v_tenant_id THEN
      RAISE EXCEPTION 'The historical employee for this calculation could not be found';
    END IF;

    BEGIN
      INSERT INTO terminal_dues (
        tenant_id, historical_employee_id, employee_name, employee_number, position,
        date_joined, date_left, period_months, basic_salary,
        gratuity, annual_leave, uniform_refund, other_benefits,
        subtotal, deductions, total_payable, status, employee_exit_id
      ) VALUES (
        v_tenant_id, v_historical.id, v_historical.full_name, v_historical.historical_reference, v_row.position,
        (v_row.inputs->>'dateJoined')::date, (v_row.inputs->>'dateLeft')::date,
        (v_row.breakdown->>'effectiveMonths')::integer, (v_row.inputs->>'finalSalary')::numeric,
        (v_row.breakdown->>'pensionArrears')::numeric, (v_row.breakdown->>'annualLeaveRefund')::numeric,
        (v_row.breakdown->>'uniformRefund')::numeric, (v_row.breakdown->>'outstandingSalaryTotal')::numeric,
        (v_row.breakdown->>'totalEntitlements')::numeric, (v_row.breakdown->>'lessNoticeDeduction')::numeric,
        (v_row.breakdown->>'totalPayable')::numeric, 'pending', v_row.employee_exit_id
      ) RETURNING id INTO v_new_terminal_due_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'This historical employee already has an open Terminal Due -- resolve or complete that one before submitting this calculation.';
    END;
  END IF;

  v_previous_version := jsonb_build_object(
    'version', v_row.calculation_version,
    'subject_name', v_row.subject_name,
    'subject_number', v_row.subject_number,
    'position', v_row.position,
    'inputs', v_row.inputs,
    'breakdown', v_row.breakdown,
    'total_payable', v_row.total_payable,
    'recorded_at', v_row.updated_at
  );

  UPDATE terminal_due_calculations SET
    status = 'submitted',
    submitted_terminal_due_id = v_new_terminal_due_id,
    submitted_by = v_caller_id,
    submitted_at = NOW(),
    revision_history = v_row.revision_history || jsonb_build_array(v_previous_version),
    updated_at = NOW()
  WHERE id = p_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'SUBMIT', 'terminal_due_calculation', p_id::text,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'submitted', 'terminal_due_id', v_new_terminal_due_id)
  );

  RETURN jsonb_build_object('success', true, 'id', p_id, 'status', 'submitted', 'terminal_due_id', v_new_terminal_due_id);
END;
$$;

REVOKE ALL ON FUNCTION submit_terminal_due_calculation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION submit_terminal_due_calculation(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION submit_terminal_due_calculation(UUID) TO authenticated;
