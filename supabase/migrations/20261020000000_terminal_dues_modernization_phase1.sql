-- ============================================================
-- MIGRATION: Terminal Dues Modernization -- Phase 1 foundation
-- Date: 2026-10-20
-- ============================================================
--
-- WHY THIS IS A NEW, ISOLATED SCHEMA (not an ALTER of `terminal_dues`)
-- -----------------------------------------------------------
-- The existing `terminal_dues` table (20260727000000) and its
-- separation-of-duties hardening (20260905000000, 20260906000000,
-- 20260907000000) are real, incident-driven production security controls:
-- RLS requires `status = 'pending'` on every direct client INSERT/UPDATE,
-- and trigger_protect_terminal_dues_workflow_columns() independently
-- REJECTS any direct client attempt to create a row with any status other
-- than 'pending', or to change status/approval/payment columns outside the
-- three approve/pay/return RPCs. Introducing an earlier "draft" stage, or
-- an employee_id that may be NULL (for a historical former employee not in
-- `employees`), into THAT table would require touching this hardened
-- trigger and both RLS policies -- real risk to a control that staging
-- testing already caught bypassing once. Phase 1 instead adds a brand new,
-- fully isolated pair of tables with their own RLS from scratch. Nothing
-- in this migration ALTERs, DROPs, or CREATE OR REPLACEs any existing
-- table, policy, trigger, or function -- zero conflict surface with
-- `terminal_dues` or anything else. The existing Terminal Dues
-- pending/approved/paid workflow, its RPCs, and its RLS are completely
-- untouched and continue to behave exactly as before.
--
-- WHAT THIS ADDS
-- -----------------------------------------------------------
-- 1. historical_employees -- former employees who left before this system
--    (or before digital records existed) and are not, and must not become,
--    rows in `employees` (so they never appear in active workforce,
--    attendance, or roster data, which all key off `employees`).
-- 2. terminal_due_calculations -- durable DRAFT calculation records with a
--    full itemised breakdown, for either an existing employee OR a
--    historical_employees row (exactly one of the two, enforced by a CHECK
--    constraint). This is the Phase 1 foundation only: 'draft' and
--    'settled' are the only two statuses, and "settled" here carries NO
--    payroll/payment/approval meaning yet -- it is the "Settled tab
--    foundation" the business requirements ask for, nothing more. Later
--    phases decide how (or whether) a settled calculation ever becomes a
--    real `terminal_dues` row subject to the existing approve/pay
--    workflow; this migration makes no such connection.
--
-- Every mutation after INSERT goes through a narrow SECURITY DEFINER RPC
-- (same idiom as approve_terminal_due()/record_terminal_due_payment()):
-- direct client UPDATEs are blocked entirely by RLS, so calculation
-- versioning (revision_history) can never be bypassed by a raw UPDATE.
-- ============================================================

-- ============================================================
-- PART 1: historical_employees
-- ============================================================

CREATE TABLE IF NOT EXISTS historical_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  full_name TEXT NOT NULL,
  historical_reference TEXT,
  date_joined DATE NOT NULL,
  date_left DATE NOT NULL,
  reason_for_leaving TEXT NOT NULL,
  termination_type TEXT,
  -- The business-confirmed salary used for every calculation component.
  -- May start as the position's configured default_salary (suggested, not
  -- assumed -- the frontend requires explicit HR confirmation before
  -- saving), hence no DEFAULT here: every row must carry a value HR
  -- actually confirmed.
  final_salary NUMERIC(14,2) NOT NULL CHECK (final_salary > 0),
  pay_point TEXT,
  account_number TEXT,
  region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (date_left > date_joined)
);

ALTER TABLE historical_employees ENABLE ROW LEVEL SECURITY;

-- Read access: anyone who can at least view terminal dues. Payment-account
-- data (pay_point/account_number) is thereby restricted to the same role
-- set that already handles Terminal Dues -- not exposed to every
-- authenticated user the way employees_general's non-sensitive column
-- subset is.
CREATE POLICY "Historical employees: read within tenant, terminal-dues role" ON historical_employees
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

CREATE POLICY "Historical employees: create, explicit permission only" ON historical_employees
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND has_explicit_permission('terminal_dues.create')
    )
  )
);

CREATE POLICY "Historical employees: correct own-tenant record, explicit permission only" ON historical_employees
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND (has_explicit_permission('terminal_dues.create') OR has_explicit_permission('terminal_dues.edit'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND (has_explicit_permission('terminal_dues.create') OR has_explicit_permission('terminal_dues.edit'))
    )
  )
);

-- No DELETE policy: default-deny. A historical employee record, once
-- created, is never removed by an ordinary client in Phase 1.

GRANT SELECT, INSERT, UPDATE ON historical_employees TO authenticated;

-- ============================================================
-- PART 2: terminal_due_calculations
-- ============================================================

CREATE TABLE IF NOT EXISTS terminal_due_calculations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  historical_employee_id UUID REFERENCES historical_employees(id) ON DELETE CASCADE,
  -- Exactly one of the two subjects, never both, never neither.
  CHECK (num_nonnulls(employee_id, historical_employee_id) = 1),
  -- NULL for a historical subject (not region-scoped workforce data);
  -- resolved from the employee's own region_id for an existing employee.
  region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
  -- Denormalized display snapshot, same pattern as terminal_dues'
  -- employee_name/employee_number/position -- survives the subject
  -- record changing or (for a historical subject sharing a reference)
  -- being looked up differently later.
  subject_name TEXT NOT NULL,
  subject_number TEXT,
  position TEXT,
  -- 'draft' -> 'submitted' only. "submitted" means HR has locked this
  -- calculation and promoted it into the existing terminal_dues
  -- pending/approved/paid workflow via submit_terminal_due_calculation()
  -- below -- it is NOT financial settlement. There is deliberately no
  -- "settled"/"paid" status here: whether an entitlement has actually
  -- been paid is tracked exclusively by the linked terminal_dues row
  -- (submitted_terminal_due_id), which already has its own hardened
  -- approve/pay workflow. HR has no action in this table that can mark a
  -- case financially settled.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  calculation_version INTEGER NOT NULL DEFAULT 1 CHECK (calculation_version >= 1),
  -- Original HR-entered inputs exactly as entered, including any override
  -- reasons (e.g. inputs.pensionMonthsOverride.reason) -- never silently
  -- rewritten by a recalculation.
  inputs JSONB NOT NULL,
  -- Itemised computed breakdown mirroring terminalDuesEngine.ts's
  -- TerminalDuesBreakdown shape, stored verbatim so the UI can render the
  -- exact breakdown that produced total_payable without recomputing it.
  breakdown JSONB NOT NULL,
  total_payable NUMERIC(14,2) NOT NULL CHECK (total_payable >= 0),
  -- Append-only log of every PRIOR version this record has held (pushed
  -- by update_terminal_due_calculation_draft() before applying a new
  -- version) -- "preserve ... calculation versions" without a separate
  -- history table for this Phase 1 foundation.
  revision_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  -- The one authoritative entitlement this calculation was promoted
  -- into, created atomically by submit_terminal_due_calculation(). The
  -- UNIQUE index below enforces, at the database level, that no two
  -- calculations can ever point to the same terminal_dues row -- the
  -- "database-enforced unique relationship" the promotion bridge
  -- requires. ON DELETE SET NULL (rather than CASCADE) because a
  -- terminal_dues row reaching this far into the real approval/payment
  -- workflow must never be silently deleted by an action on this table;
  -- only reopen_terminal_due_calculation() deletes it, and only while it
  -- is still 'pending' (see that function).
  submitted_terminal_due_id UUID REFERENCES terminal_dues(id) ON DELETE SET NULL,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'submitted') = (submitted_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_terminal_due_calculations_employee ON terminal_due_calculations(employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_terminal_due_calculations_historical_employee ON terminal_due_calculations(historical_employee_id) WHERE historical_employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_terminal_due_calculations_tenant_status ON terminal_due_calculations(tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_due_calculations_one_submission_per_terminal_due
  ON terminal_due_calculations(submitted_terminal_due_id) WHERE submitted_terminal_due_id IS NOT NULL;

ALTER TABLE terminal_due_calculations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Terminal due calculations: read within tenant+region, terminal-dues role" ON terminal_due_calculations
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

-- INSERT only ever creates a brand-new draft at version 1 -- recalculation
-- after that point goes through update_terminal_due_calculation_draft()
-- below, never a direct re-INSERT or UPDATE.
CREATE POLICY "Terminal due calculations: create as draft, explicit permission only" ON terminal_due_calculations
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND status = 'draft'
  AND calculation_version = 1
  AND revision_history = '[]'::jsonb
  AND submitted_by IS NULL
  AND submitted_at IS NULL
  AND submitted_terminal_due_id IS NULL
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND (region_id IS NULL OR region_allowed(region_id))
      AND has_explicit_permission('terminal_dues.create')
    )
  )
);

-- Direct client UPDATE is never allowed -- every field change (including
-- status) goes through the SECURITY DEFINER RPCs in PART 3, so
-- calculation_version/revision_history can never be bypassed or forged by
-- a raw client UPDATE. A true super admin's own direct UPDATE (e.g. a
-- support correction) is still permitted, same exception every other
-- Terminal Dues policy in this codebase makes.
CREATE POLICY "Terminal due calculations: no direct client update" ON terminal_due_calculations
FOR UPDATE USING (is_super_admin())
WITH CHECK (is_super_admin());

-- No DELETE policy: default-deny -- "durable draft calculation records".

GRANT SELECT, INSERT ON terminal_due_calculations TO authenticated;
GRANT UPDATE ON terminal_due_calculations TO authenticated; -- gated to is_super_admin() by the policy above; the RPCs below run as owner and are unaffected by this grant either way.

-- ============================================================
-- PART 3: RPCs -- update (versioned draft edit), submit (promotion
-- bridge into terminal_dues), reopen
-- ============================================================
-- Same idiom as approve_terminal_due()/record_terminal_due_payment()/
-- return_terminal_due_for_correction() (20260905000000): SECURITY DEFINER,
-- resolve the caller via auth.uid()/get_current_tenant_id(), lock the
-- target row with FOR UPDATE before checking its state, RAISE EXCEPTION
-- (rolling back the whole transaction) on any authorization or state
-- failure, and insert one audit_logs row per call.
--
-- submit_terminal_due_calculation() is the authoritative-entitlement
-- bridge: rather than building a second, parallel approval/payment
-- system on this table, a submitted calculation is promoted into a
-- brand-new 'pending' terminal_dues row, which then goes through the
-- EXISTING, already-hardened approve/pay workflow unchanged. This table
-- never represents approval or payment state itself past the point of
-- submission -- the linked terminal_dues row is the single source of
-- truth for everything from Admin approval onward.
--
-- Historical employees are explicitly NOT supported by this bridge yet:
-- terminal_dues.employee_id is a mandatory NOT NULL foreign key to
-- `employees` with no historical equivalent, and its approve/pay RPCs
-- assume an `employees` join for the region check. Submitting a
-- historical-employee calculation raises a clear, explicit exception
-- rather than fabricating an `employees` row or a broken terminal_dues
-- row -- see this function's body and the Phase 1.5 report for the
-- proposed (separately reviewed, not-yet-applied) schema extension.
-- ============================================================

CREATE OR REPLACE FUNCTION update_terminal_due_calculation_draft(
  p_id UUID,
  p_subject_name TEXT,
  p_subject_number TEXT,
  p_position TEXT,
  p_inputs JSONB,
  p_breakdown JSONB,
  p_total_payable NUMERIC
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
    RAISE EXCEPTION 'Only an explicitly granted Terminal Dues create/edit role (or a super admin) may edit a draft calculation';
  END IF;

  SELECT * INTO v_row FROM terminal_due_calculations WHERE id = p_id FOR UPDATE;

  IF v_row IS NULL OR (v_row.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due calculation not found';
  END IF;

  IF NOT is_super_admin() AND v_row.region_id IS NOT NULL AND NOT region_allowed(v_row.region_id) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'Cannot edit a % calculation -- reopen it first', v_row.status;
  END IF;

  v_previous_version := jsonb_build_object(
    'version', v_row.calculation_version,
    'subject_name', v_row.subject_name,
    'subject_number', v_row.subject_number,
    'position', v_row.position,
    'inputs', v_row.inputs,
    'breakdown', v_row.breakdown,
    'total_payable', v_row.total_payable,
    'edited_by', v_row.created_by,
    'recorded_at', v_row.updated_at
  );

  UPDATE terminal_due_calculations SET
    subject_name = p_subject_name,
    subject_number = p_subject_number,
    position = p_position,
    inputs = p_inputs,
    breakdown = p_breakdown,
    total_payable = p_total_payable,
    calculation_version = v_row.calculation_version + 1,
    revision_history = v_row.revision_history || jsonb_build_array(v_previous_version),
    updated_at = NOW()
  WHERE id = p_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'UPDATE', 'terminal_due_calculation', p_id::text,
    jsonb_build_object('calculation_version', v_row.calculation_version, 'total_payable', v_row.total_payable),
    jsonb_build_object('calculation_version', v_row.calculation_version + 1, 'total_payable', p_total_payable)
  );

  RETURN jsonb_build_object('success', true, 'id', p_id, 'calculation_version', v_row.calculation_version + 1);
END;
$$;

REVOKE ALL ON FUNCTION update_terminal_due_calculation_draft(UUID, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_terminal_due_calculation_draft(UUID, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC) FROM anon;
GRANT EXECUTE ON FUNCTION update_terminal_due_calculation_draft(UUID, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION submit_terminal_due_calculation(p_id UUID)
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

  -- Idempotency/duplicate-liability guard: this status check, combined
  -- with the FOR UPDATE row lock taken above, means a retried or
  -- concurrent call on the same row can never create a second
  -- terminal_dues row -- the second caller always lands here, not past
  -- it. The UNIQUE index on submitted_terminal_due_id is a second,
  -- independent, database-enforced backstop against the same outcome.
  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'This calculation has already been submitted (status: %)', v_row.status;
  END IF;

  -- STOP: historical employees are not yet supported by this bridge.
  -- terminal_dues.employee_id is a mandatory NOT NULL foreign key to
  -- `employees` -- there is no historical equivalent column, and
  -- approve_terminal_due()/record_terminal_due_payment() both assume an
  -- `employees` join for their region check. Supporting a historical
  -- subject here would require either fabricating a fake `employees` row
  -- (explicitly disallowed) or a separately reviewed schema migration
  -- adding a nullable historical_employee_id path to terminal_dues
  -- itself, including updates to those two RPCs. Neither is done here --
  -- this is an explicit, auditable stop, not a silent gap.
  IF v_row.historical_employee_id IS NOT NULL THEN
    RAISE EXCEPTION 'Historical employee entitlements cannot be submitted into the existing Terminal Dues approval workflow yet -- this requires a separately reviewed schema change. Contact an administrator.';
  END IF;

  SELECT * INTO v_employee FROM employees WHERE id = v_row.employee_id;
  IF v_employee IS NULL OR v_employee.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'The employee for this calculation could not be found';
  END IF;
  IF NOT is_super_admin() AND NOT region_allowed(v_employee.region_id) THEN
    RAISE EXCEPTION 'This employee is outside your assigned region';
  END IF;

  -- Re-derive the entitlement amounts from this calculation's own
  -- inputs/breakdown (never trust a client-supplied amount) and insert a
  -- brand-new 'pending' terminal_dues row -- the authoritative
  -- entitlement from this point forward. If this employee already has
  -- an open (pending/approved) terminal_dues row -- e.g. created
  -- directly via the legacy Records tab -- idx_terminal_dues_one_open_per_employee
  -- rejects the insert; caught below and re-raised as a clear message
  -- rather than a bare constraint-violation error.
  BEGIN
    INSERT INTO terminal_dues (
      tenant_id, employee_id, employee_name, employee_number, position,
      date_joined, date_left, period_months, basic_salary,
      gratuity, annual_leave, uniform_refund, other_benefits,
      subtotal, deductions, total_payable, status
    ) VALUES (
      v_tenant_id, v_employee.id, v_employee.full_name, v_employee.employee_number, v_employee.position,
      (v_row.inputs->>'dateJoined')::date, (v_row.inputs->>'dateLeft')::date,
      (v_row.breakdown->>'effectiveMonths')::integer, (v_row.inputs->>'finalSalary')::numeric,
      (v_row.breakdown->>'pensionArrears')::numeric, (v_row.breakdown->>'annualLeaveRefund')::numeric,
      (v_row.breakdown->>'uniformRefund')::numeric, (v_row.breakdown->>'outstandingSalaryTotal')::numeric,
      (v_row.breakdown->>'totalEntitlements')::numeric, (v_row.breakdown->>'lessNoticeDeduction')::numeric,
      (v_row.breakdown->>'totalPayable')::numeric, 'pending'
    ) RETURNING id INTO v_new_terminal_due_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This employee already has an open Terminal Due in the existing Records workflow -- resolve or complete that one before submitting this calculation.';
  END;

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

CREATE OR REPLACE FUNCTION reopen_terminal_due_calculation(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_row RECORD;
  v_due RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.create') OR has_explicit_permission('terminal_dues.edit')) THEN
    RAISE EXCEPTION 'Only an explicitly granted Terminal Dues create/edit role (or a super admin) may reopen a submitted calculation';
  END IF;

  SELECT * INTO v_row FROM terminal_due_calculations WHERE id = p_id FOR UPDATE;

  IF v_row IS NULL OR (v_row.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due calculation not found';
  END IF;

  IF NOT is_super_admin() AND v_row.region_id IS NOT NULL AND NOT region_allowed(v_row.region_id) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_row.status <> 'submitted' THEN
    RAISE EXCEPTION 'Only a submitted calculation can be reopened (this one is %)', v_row.status;
  END IF;

  -- Only safe to retract while the linked terminal_dues row is still
  -- 'pending' -- i.e. Admin has not yet acted on it. Once it has moved to
  -- 'approved' or 'paid', the authoritative entitlement belongs to that
  -- workflow and must be handled there (e.g. return_terminal_due_for_correction()),
  -- never silently unwound from this side.
  IF v_row.submitted_terminal_due_id IS NOT NULL THEN
    SELECT * INTO v_due FROM terminal_dues WHERE id = v_row.submitted_terminal_due_id FOR UPDATE;
    -- Deliberately `FOUND`, not `v_due IS NOT NULL`: a composite/record
    -- value's own IS NOT NULL is only true when EVERY field is
    -- non-null, which a real terminal_dues row never is (approved_by,
    -- paid_at, etc. are null on an ordinary pending/approved row) --
    -- that silent row-wise-null gotcha would make this whole guard,
    -- and the DELETE below, never fire for any real row. FOUND is the
    -- correct, unambiguous "did the SELECT INTO actually match a row"
    -- check.
    IF FOUND THEN
      IF v_due.status <> 'pending' THEN
        RAISE EXCEPTION 'Cannot reopen -- the linked Terminal Due is already % in the approval workflow. It must be handled there instead.', v_due.status;
      END IF;
      DELETE FROM terminal_dues WHERE id = v_row.submitted_terminal_due_id;
    END IF;
  END IF;

  UPDATE terminal_due_calculations SET
    status = 'draft',
    submitted_terminal_due_id = NULL,
    submitted_by = NULL,
    submitted_at = NULL,
    updated_at = NOW()
  WHERE id = p_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'REOPEN', 'terminal_due_calculation', p_id::text,
    jsonb_build_object('status', 'submitted'),
    jsonb_build_object('status', 'draft')
  );

  RETURN jsonb_build_object('success', true, 'id', p_id, 'status', 'draft');
END;
$$;

REVOKE ALL ON FUNCTION reopen_terminal_due_calculation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION reopen_terminal_due_calculation(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION reopen_terminal_due_calculation(UUID) TO authenticated;
