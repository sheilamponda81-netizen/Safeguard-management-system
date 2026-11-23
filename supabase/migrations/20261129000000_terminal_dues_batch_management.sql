-- ============================================================
-- MIGRATION: Terminal Dues Phase 2 -- integrated batch management
-- Date: 2026-11-29
-- ============================================================
--
-- OBJECTIVE: let HR/Admin manage a named group of departing employees
-- (e.g. 50 people) as one operational unit, while every financial
-- figure continues to come from the EXISTING, hardened settlement
-- ledger (terminal_due_calculations / terminal_dues /
-- terminal_due_allocations) -- this migration adds NO second
-- settlement engine, NO new calculation logic, and NO new way to
-- approve, allocate or pay anything. A batch is purely an
-- organizational grouping layer: who is being processed together, and
-- a read-only aggregation of their existing individual ledgers.
--
-- THIS MIGRATION ADDS:
--   1. terminal_due_batches / terminal_due_batch_members -- the batch
--      header and its membership roster. An employee can be an active
--      (non-removed) member of at most ONE active batch at a time
--      (idx_batch_members_one_active_per_batch_employee prevents a
--      duplicate add within the SAME batch; the
--      guard_batch_member_single_active_batch trigger is a backstop
--      against the cross-batch conflict the RPC below already checks
--      explicitly before every INSERT). Closing a batch (status
--      'closed') frees its members to join a different batch later --
--      a closed batch's own membership and linked settlements remain
--      exactly as they were, for history.
--   2. Nullable batch_id link columns on BOTH terminal_due_calculations
--      and terminal_dues -- purely additive, mirroring EXACTLY the
--      employee_exit_id pattern 20261127000000 established.
--      submit_terminal_due_calculation (replaced below with the EXACT
--      SAME signature `(p_id UUID)` -- same PR #72/#73 lesson: a
--      signature change creates a dangling overload, so this is a true
--      CREATE OR REPLACE, never a new one) now carries a draft's
--      batch_id through to the terminal_dues row it creates, verbatim,
--      with NO other change to that function's validation logic, its
--      two INSERT column lists (otherwise byte-for-byte identical to
--      the 20261127000000 version), or any amount it computes or
--      checks.
--
-- WHY THIS NEEDS NO NEW FINANCIAL LOGIC AT ALL: a batch's "draft
-- estimate" total is just the sum of terminal_due_calculations.
-- total_payable WHERE batch_id = the batch (status = 'draft', not yet
-- submitted). A batch's confirmed/paid/outstanding totals are just
-- terminalDuesOverview.ts's EXISTING, unmodified
-- summarizeTerminalDuesOverview()/computeEntitlementFinancials() fed
-- with terminal_dues rows WHERE batch_id = the batch (plus their
-- terminal_due_allocations, joined by terminal_due_id exactly as
-- Records tab's own financial overview already does) -- the exact
-- same pure, already-reviewed aggregation, just pre-filtered by
-- batch_id instead of "every entitlement in the tenant."
--
-- BATCH MEMBERSHIP NEVER, BY ITSELF: finalizes an exit, creates or
-- submits a calculation, approves a settlement, proposes or approves
-- an allocation, or records a payment. Every one of those remains
-- exactly the explicit, separately-authorized action it already was
-- (finalize_employee_exit, submit_terminal_due_calculation,
-- approve_terminal_due, propose/approve_terminal_due_allocation,
-- record_terminal_due_payment -- none of their own authorization or
-- validation logic is touched here beyond the one additive batch_id
-- carry-through noted above).
-- ============================================================

-- ============================================================
-- PART 1: terminal_due_batches
-- ============================================================

CREATE TABLE IF NOT EXISTS terminal_due_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  name TEXT NOT NULL,
  -- 'active': open for membership changes and for linking calculations.
  -- 'closed': frozen roster, kept for history/reporting; its members
  -- are no longer blocked from joining a different active batch.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_terminal_due_batches_tenant_status ON terminal_due_batches(tenant_id, status);

ALTER TABLE terminal_due_batches ENABLE ROW LEVEL SECURITY;

-- Read access mirrors employee_exits'/terminal_due_calculations' own
-- read policy exactly -- same role set already handles Terminal Dues.
CREATE POLICY "Terminal due batches: read within tenant, terminal-dues role" ON terminal_due_batches
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND (
        has_explicit_permission('terminal_dues.view')
        OR has_explicit_permission('terminal_dues.create')
        OR has_explicit_permission('terminal_dues.edit')
      )
    )
  )
);

-- No direct client INSERT/UPDATE: every mutation goes through a narrow
-- SECURITY DEFINER RPC below, so the single-active-batch-per-employee
-- guarantee and the audit trail can never be bypassed by a raw client
-- write. Same super-admin exception every other Terminal Dues policy
-- in this codebase makes.
CREATE POLICY "Terminal due batches: no direct client write" ON terminal_due_batches
FOR INSERT WITH CHECK (is_super_admin());

CREATE POLICY "Terminal due batches: no direct client update" ON terminal_due_batches
FOR UPDATE USING (is_super_admin()) WITH CHECK (is_super_admin());

-- No DELETE policy: default-deny. A batch is only ever closed, never removed.

GRANT SELECT ON terminal_due_batches TO authenticated;
GRANT INSERT, UPDATE ON terminal_due_batches TO authenticated; -- gated to is_super_admin() by the policies above; the RPCs below run as owner and are unaffected by this grant either way.

-- ============================================================
-- PART 2: terminal_due_batch_members
-- ============================================================

CREATE TABLE IF NOT EXISTS terminal_due_batch_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  batch_id UUID NOT NULL REFERENCES terminal_due_batches(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- Denormalized from employees.region_id at add time, same pattern as
  -- employee_exits.region_id -- used only for the SELECT RLS policy;
  -- every mutating RPC re-checks the employee's LIVE region_id.
  region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
  added_by UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  removed_at TIMESTAMPTZ,
  removal_reason TEXT,
  CHECK ((removed_at IS NOT NULL) = (removal_reason IS NOT NULL))
);

-- Duplicate-selection prevention WITHIN one batch. A removed (soft-
-- deleted) membership row never counts, so re-adding someone after an
-- earlier removal is always allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_members_one_active_per_batch_employee
  ON terminal_due_batch_members(batch_id, employee_id) WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_batch_members_tenant_employee ON terminal_due_batch_members(tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_batch_members_batch ON terminal_due_batch_members(batch_id);

ALTER TABLE terminal_due_batch_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Terminal due batch members: read within tenant+region, terminal-dues role" ON terminal_due_batch_members
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

CREATE POLICY "Terminal due batch members: no direct client write" ON terminal_due_batch_members
FOR INSERT WITH CHECK (is_super_admin());

CREATE POLICY "Terminal due batch members: no direct client update" ON terminal_due_batch_members
FOR UPDATE USING (is_super_admin()) WITH CHECK (is_super_admin());

GRANT SELECT ON terminal_due_batch_members TO authenticated;
GRANT INSERT, UPDATE ON terminal_due_batch_members TO authenticated;

-- Cross-batch conflict guard -- a deliberate BACKSTOP behind
-- add_employees_to_batch()'s own explicit pre-check below (same
-- defense-in-depth pattern as employee_exits' partial unique index
-- backing up record_employee_exit()'s own duplicate handling). Normal
-- operation never relies on this trigger firing; it exists so that no
-- future direct write (even a super admin's) can silently create a
-- double-active-batch-membership state the RPC layer was designed to
-- prevent.
CREATE OR REPLACE FUNCTION guard_batch_member_single_active_batch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_conflicting_batch_name TEXT;
BEGIN
  SELECT b.name INTO v_conflicting_batch_name
  FROM terminal_due_batch_members m
  JOIN terminal_due_batches b ON b.id = m.batch_id
  WHERE m.employee_id = NEW.employee_id
    AND m.removed_at IS NULL
    AND b.status = 'active'
    AND m.batch_id <> NEW.batch_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'This employee is already an active member of another open batch (%) -- remove them from that batch first, or wait until it is closed', v_conflicting_batch_name;
  END IF;

  RETURN NEW;
END;
$$;

-- Fires on INSERT (the normal add path) AND on UPDATE (so that a direct
-- "un-remove" write -- setting removed_at back to NULL without going
-- through add_employees_to_batch -- is caught too; a super admin's raw
-- client write is the only thing RLS lets reach UPDATE directly, since
-- remove_employee_from_batch is the only RPC that ever updates this
-- table and always sets removed_at to a real timestamp, never back to
-- NULL, so this adds no new check on the normal removal path). The WHEN
-- clause limits the check to rows that end up active -- exactly the
-- state the invariant is about.
DROP TRIGGER IF EXISTS guard_batch_member_single_active_batch ON terminal_due_batch_members;
CREATE TRIGGER guard_batch_member_single_active_batch
BEFORE INSERT OR UPDATE ON terminal_due_batch_members
FOR EACH ROW
WHEN (NEW.removed_at IS NULL)
EXECUTE FUNCTION guard_batch_member_single_active_batch();

-- ============================================================
-- PART 3: RPCs
-- ============================================================

CREATE OR REPLACE FUNCTION create_terminal_due_batch(p_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_new_id UUID;
  v_clean_name TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.create')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.create (or a super admin) may create a Terminal Dues batch';
  END IF;

  v_clean_name := trim(coalesce(p_name, ''));
  IF v_clean_name = '' THEN
    RAISE EXCEPTION 'A batch name is required';
  END IF;

  INSERT INTO terminal_due_batches (tenant_id, name, created_by)
  VALUES (v_tenant_id, v_clean_name, v_caller_id)
  RETURNING id INTO v_new_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'CREATE', 'terminal_due_batch', v_new_id::text,
    NULL,
    jsonb_build_object('name', v_clean_name, 'status', 'active')
  );

  RETURN jsonb_build_object('success', true, 'id', v_new_id, 'status', 'active');
END;
$$;

REVOKE ALL ON FUNCTION create_terminal_due_batch(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_terminal_due_batch(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION create_terminal_due_batch(TEXT) TO authenticated;

-- add_employees_to_batch: processes each supplied employee
-- independently within one transaction -- a bad id (not found,
-- soft-deleted, out of region, already in this batch, already in
-- another active batch) is SKIPPED with a specific reason, never
-- aborts the whole call, so adding 49 valid people out of 50 still
-- succeeds for those 49. Never finalizes an exit, creates a
-- calculation, or touches any financial record -- purely roster
-- membership.
CREATE OR REPLACE FUNCTION add_employees_to_batch(p_batch_id UUID, p_employee_ids UUID[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_batch RECORD;
  v_employee RECORD;
  v_employee_id UUID;
  v_added UUID[] := '{}';
  v_skipped JSONB := '[]'::jsonb;
  v_new_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.create') OR has_explicit_permission('terminal_dues.edit')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.create/edit (or a super admin) may add employees to a batch';
  END IF;

  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one employee must be supplied';
  END IF;

  SELECT * INTO v_batch FROM terminal_due_batches WHERE id = p_batch_id FOR UPDATE;
  IF v_batch IS NULL OR (v_batch.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  IF v_batch.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot add employees to a % batch', v_batch.status;
  END IF;

  FOREACH v_employee_id IN ARRAY p_employee_ids LOOP
    SELECT * INTO v_employee FROM employees WHERE id = v_employee_id;

    IF v_employee IS NULL OR (v_employee.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
      v_skipped := v_skipped || jsonb_build_object('employee_id', v_employee_id, 'reason', 'Employee not found');
      CONTINUE;
    END IF;

    IF v_employee.is_deleted THEN
      v_skipped := v_skipped || jsonb_build_object('employee_id', v_employee_id, 'reason', 'Employee is soft-deleted');
      CONTINUE;
    END IF;

    IF NOT (is_super_admin() OR is_business_admin()) AND NOT region_allowed(v_employee.region_id) THEN
      v_skipped := v_skipped || jsonb_build_object('employee_id', v_employee_id, 'reason', 'Outside your assigned region');
      CONTINUE;
    END IF;

    -- Explicit cross-batch pre-check (the trigger above is the
    -- backstop) -- gives a specific, actionable skip reason instead of
    -- a caught exception.
    IF EXISTS (
      SELECT 1 FROM terminal_due_batch_members m
      JOIN terminal_due_batches b ON b.id = m.batch_id
      WHERE m.employee_id = v_employee_id AND m.removed_at IS NULL AND b.status = 'active' AND m.batch_id <> p_batch_id
    ) THEN
      v_skipped := v_skipped || jsonb_build_object('employee_id', v_employee_id, 'reason', 'Already an active member of another open batch');
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO terminal_due_batch_members (tenant_id, batch_id, employee_id, region_id, added_by)
      VALUES (v_tenant_id, p_batch_id, v_employee_id, v_employee.region_id, v_caller_id)
      RETURNING id INTO v_new_id;
      v_added := v_added || v_employee_id;
    EXCEPTION WHEN unique_violation THEN
      v_skipped := v_skipped || jsonb_build_object('employee_id', v_employee_id, 'reason', 'Already an active member of this batch');
    END;
  END LOOP;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'UPDATE', 'terminal_due_batch', p_batch_id::text,
    NULL,
    jsonb_build_object('added_employee_ids', to_jsonb(v_added), 'skipped', v_skipped)
  );

  RETURN jsonb_build_object('success', true, 'added', to_jsonb(v_added), 'skipped', v_skipped);
END;
$$;

REVOKE ALL ON FUNCTION add_employees_to_batch(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION add_employees_to_batch(UUID, UUID[]) FROM anon;
GRANT EXECUTE ON FUNCTION add_employees_to_batch(UUID, UUID[]) TO authenticated;

CREATE OR REPLACE FUNCTION remove_employee_from_batch(p_batch_id UUID, p_employee_id UUID, p_reason TEXT)
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

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.create') OR has_explicit_permission('terminal_dues.edit')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.create/edit (or a super admin) may remove an employee from a batch';
  END IF;

  IF trim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A removal reason is required';
  END IF;

  SELECT * INTO v_row FROM terminal_due_batch_members
  WHERE batch_id = p_batch_id AND employee_id = p_employee_id AND removed_at IS NULL
  FOR UPDATE;

  IF v_row IS NULL OR (v_row.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'This employee is not an active member of this batch';
  END IF;

  UPDATE terminal_due_batch_members SET
    removed_by = v_caller_id,
    removed_at = NOW(),
    removal_reason = p_reason
  WHERE id = v_row.id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'UPDATE', 'terminal_due_batch', p_batch_id::text,
    jsonb_build_object('member_employee_id', p_employee_id, 'active', true),
    jsonb_build_object('member_employee_id', p_employee_id, 'active', false, 'reason', p_reason)
  );

  RETURN jsonb_build_object('success', true, 'batch_id', p_batch_id, 'employee_id', p_employee_id, 'removed', true);
END;
$$;

REVOKE ALL ON FUNCTION remove_employee_from_batch(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION remove_employee_from_batch(UUID, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION remove_employee_from_batch(UUID, UUID, TEXT) TO authenticated;

-- close_terminal_due_batch: freezes the roster for history. Does NOT
-- finalize any exit, approve any settlement, or touch any payment --
-- purely a status flip on the batch header, same tier of authority as
-- creating/editing one.
CREATE OR REPLACE FUNCTION close_terminal_due_batch(p_batch_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_batch RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.create') OR has_explicit_permission('terminal_dues.edit')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.create/edit (or a super admin) may close a batch';
  END IF;

  SELECT * INTO v_batch FROM terminal_due_batches WHERE id = p_batch_id FOR UPDATE;
  IF v_batch IS NULL OR (v_batch.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  IF v_batch.status = 'closed' THEN
    RAISE EXCEPTION 'This batch is already closed';
  END IF;

  UPDATE terminal_due_batches SET
    status = 'closed',
    closed_by = v_caller_id,
    closed_at = NOW(),
    updated_at = NOW()
  WHERE id = p_batch_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'UPDATE', 'terminal_due_batch', p_batch_id::text,
    jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'closed', 'closed_by', v_caller_id)
  );

  RETURN jsonb_build_object('success', true, 'id', p_batch_id, 'status', 'closed');
END;
$$;

REVOKE ALL ON FUNCTION close_terminal_due_batch(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_terminal_due_batch(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION close_terminal_due_batch(UUID) TO authenticated;

-- link_calculation_to_batch: the ONLY way a draft/entitlement's own
-- batch_id is ever set by a user action -- a pure label, applied only
-- to a calculation whose own subject employee is already an active
-- member of the target batch. Never creates, submits, approves or
-- changes any amount on the calculation itself.
CREATE OR REPLACE FUNCTION link_calculation_to_batch(p_calculation_id UUID, p_batch_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_calc RECORD;
  v_batch RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.create') OR has_explicit_permission('terminal_dues.edit')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.create/edit (or a super admin) may link a calculation to a batch';
  END IF;

  SELECT * INTO v_calc FROM terminal_due_calculations WHERE id = p_calculation_id FOR UPDATE;
  IF v_calc IS NULL OR (v_calc.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due calculation not found';
  END IF;
  IF NOT is_super_admin() AND v_calc.region_id IS NOT NULL AND NOT region_allowed(v_calc.region_id) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_calc.employee_id IS NULL THEN
    RAISE EXCEPTION 'Only a current-employee calculation can be linked to a batch -- a historical-employee calculation is out of scope for batch management';
  END IF;

  SELECT * INTO v_batch FROM terminal_due_batches WHERE id = p_batch_id FOR UPDATE;
  IF v_batch IS NULL OR (v_batch.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  IF v_batch.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot link a calculation to a % batch', v_batch.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM terminal_due_batch_members
    WHERE batch_id = p_batch_id AND employee_id = v_calc.employee_id AND removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'This employee is not an active member of the target batch -- add them to the batch first';
  END IF;

  UPDATE terminal_due_calculations SET batch_id = p_batch_id, updated_at = NOW() WHERE id = p_calculation_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'UPDATE', 'terminal_due_calculation', p_calculation_id::text,
    jsonb_build_object('batch_id', v_calc.batch_id),
    jsonb_build_object('batch_id', p_batch_id)
  );

  RETURN jsonb_build_object('success', true, 'id', p_calculation_id, 'batch_id', p_batch_id);
END;
$$;

REVOKE ALL ON FUNCTION link_calculation_to_batch(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION link_calculation_to_batch(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION link_calculation_to_batch(UUID, UUID) TO authenticated;

-- ============================================================
-- PART 4: additive linkage columns (no existing row touched)
-- ============================================================

ALTER TABLE terminal_due_calculations ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES terminal_due_batches(id) ON DELETE SET NULL;
ALTER TABLE terminal_dues ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES terminal_due_batches(id) ON DELETE SET NULL;

-- ============================================================
-- PART 5: submit_terminal_due_calculation -- TRUE replace, identical
-- signature `(p_id UUID)` to the live 20261127000000 definition (which
-- already carries employee_exit_id through). The ONLY functional
-- change anywhere in this body is that both INSERT INTO terminal_dues
-- statements now ALSO carry batch_id through from the draft --
-- every validation rule, computed amount, and exception message is
-- otherwise byte-for-byte unchanged.
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
        subtotal, deductions, total_payable, status, employee_exit_id, batch_id
      ) VALUES (
        v_tenant_id, v_employee.id, v_employee.full_name, v_employee.employee_number, v_employee.position,
        (v_row.inputs->>'dateJoined')::date, (v_row.inputs->>'dateLeft')::date,
        (v_row.breakdown->>'effectiveMonths')::integer, (v_row.inputs->>'finalSalary')::numeric,
        (v_row.breakdown->>'pensionArrears')::numeric, (v_row.breakdown->>'annualLeaveRefund')::numeric,
        (v_row.breakdown->>'uniformRefund')::numeric, (v_row.breakdown->>'outstandingSalaryTotal')::numeric,
        (v_row.breakdown->>'totalEntitlements')::numeric, (v_row.breakdown->>'lessNoticeDeduction')::numeric,
        (v_row.breakdown->>'totalPayable')::numeric, 'pending', v_row.employee_exit_id, v_row.batch_id
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
        subtotal, deductions, total_payable, status, employee_exit_id, batch_id
      ) VALUES (
        v_tenant_id, v_historical.id, v_historical.full_name, v_historical.historical_reference, v_row.position,
        (v_row.inputs->>'dateJoined')::date, (v_row.inputs->>'dateLeft')::date,
        (v_row.breakdown->>'effectiveMonths')::integer, (v_row.inputs->>'finalSalary')::numeric,
        (v_row.breakdown->>'pensionArrears')::numeric, (v_row.breakdown->>'annualLeaveRefund')::numeric,
        (v_row.breakdown->>'uniformRefund')::numeric, (v_row.breakdown->>'outstandingSalaryTotal')::numeric,
        (v_row.breakdown->>'totalEntitlements')::numeric, (v_row.breakdown->>'lessNoticeDeduction')::numeric,
        (v_row.breakdown->>'totalPayable')::numeric, 'pending', v_row.employee_exit_id, v_row.batch_id
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
