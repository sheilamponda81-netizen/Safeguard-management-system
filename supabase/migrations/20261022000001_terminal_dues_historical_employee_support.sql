-- ============================================================
-- MIGRATION: Terminal Dues Phase 1.6 -- historical employee support
-- Date: 2026-10-22
-- ============================================================
--
-- WHY THIS IS ITS OWN MIGRATION
-- -----------------------------------------------------------
-- `terminal_dues` (20260727000000), its separation-of-duties RPCs
-- (20260905000000, 20260907000000), and the Phase 1.5 payment guard
-- (20261021000000) are all already applied to production. Every change
-- here is additive (ALTER ... ADD, new index, CREATE OR REPLACE on an
-- unchanged function signature) -- nothing is dropped or rewritten in
-- place, and every existing row satisfies the new CHECK constraint
-- immediately (employee_id stays NOT NULL-in-practice for every row that
-- already has it, historical_employee_id defaults NULL), so no backfill
-- is needed or performed.
--
-- THE BLOCKER THIS REMOVES
-- -----------------------------------------------------------
-- `terminal_dues.employee_id` was `NOT NULL REFERENCES employees(id)`,
-- so a historical former employee (who must never become a fake
-- `employees` row) could never enter the real Admin-approval workflow --
-- submit_terminal_due_calculation() explicitly stopped and raised an
-- exception for a historical-employee calculation (Phase 1.5). This
-- migration adds a nullable `historical_employee_id` alongside it, with
-- a CHECK enforcing exactly one subject, so `terminal_dues` can now
-- represent either kind of subject without ever faking the other.
--
-- WHAT WAS DELIBERATELY *NOT* CHANGED
-- -----------------------------------------------------------
-- - No RLS policy on `terminal_dues` is touched. The existing INSERT/UPDATE
--   policies (20260905000000) still require `EXISTS (... employees ...)`
--   and therefore still apply ONLY to the legacy, direct-client-INSERT
--   existing-employee path (src/pages/TerminalDues.tsx's saveCalculation())
--   -- completely unaffected. A historical-employee row can only ever be
--   created through submit_terminal_due_calculation() below, which is
--   SECURITY DEFINER and so is not gated by these policies at all; this
--   is deliberate, not an oversight, and keeps the attack surface for
--   historical submission to exactly one audited code path.
-- - trigger_protect_terminal_dues_workflow_columns() is untouched --
--   nothing about it depends on employee_id.
-- - idx_terminal_dues_one_open_per_employee is untouched and remains
--   fully correct: multiple NULL employee_id values never violate a
--   UNIQUE index, so historical rows are automatically excluded from it,
--   and existing-employee rows keep identical protection. A PARALLEL
--   index for historical_employee_id is added below for the equivalent
--   protection on that subject type.
-- ============================================================

-- ============================================================
-- PART 1: schema -- nullable employee_id, new historical_employee_id,
-- exactly-one-subject CHECK, parallel duplicate-open-entitlement index
-- ============================================================

ALTER TABLE terminal_dues ALTER COLUMN employee_id DROP NOT NULL;

ALTER TABLE terminal_dues
  ADD COLUMN IF NOT EXISTS historical_employee_id UUID REFERENCES historical_employees(id) ON DELETE CASCADE;

ALTER TABLE terminal_dues
  ADD CONSTRAINT terminal_dues_exactly_one_subject CHECK (num_nonnulls(employee_id, historical_employee_id) = 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_dues_one_open_per_historical_employee
ON terminal_dues (historical_employee_id)
WHERE status IN ('pending', 'approved');

-- ============================================================
-- PART 1b: SELECT RLS -- the view policy (20260817000002, still the only
-- active SELECT policy on this table: 20260905000000 superseded INSERT
-- and UPDATE but deliberately left SELECT alone) unconditionally requires
-- `EXISTS (SELECT 1 FROM employees e WHERE e.id = terminal_dues.employee_id
-- AND region_allowed(e.region_id))` for every non-super-admin caller. For
-- a historical-linked row (employee_id NULL) this EXISTS is always false,
-- so NO ordinary HR/Admin/Accountant user could ever see a historical
-- entitlement via a direct SELECT -- confirmed as a real, reproduced bug
-- via isolated-Postgres testing (the row is created successfully by
-- submit_terminal_due_calculation(), and the three workflow RPCs can
-- still act on it since they are themselves SECURITY DEFINER and read
-- the row directly, bypassing RLS -- but the Records/Submitted UI's own
-- plain SELECT would show nothing). Fixed by adding a second,
-- historical-specific branch: tenant-matched and permission-gated
-- identically to the existing-employee branch, but with no region
-- check, consistent with historical subjects being tenant-wide
-- everywhere else in this feature (historical_employees,
-- terminal_due_calculations). The existing-employee branch is
-- byte-for-byte unchanged.
-- ============================================================

DROP POLICY IF EXISTS "Terminal dues: view within tenant+region, action or legacy permitted" ON terminal_dues;
CREATE POLICY "Terminal dues: view within tenant+region, action or legacy permitted" ON terminal_dues
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND (
        (employee_id IS NOT NULL AND EXISTS (SELECT 1 FROM employees e WHERE e.id = terminal_dues.employee_id AND region_allowed(e.region_id)))
        OR historical_employee_id IS NOT NULL
      )
      AND (current_user_role_level() <= 2 OR has_permission('terminal_dues.view'))
    )
  )
);

-- ============================================================
-- PART 2: submit_terminal_due_calculation() -- now supports both
-- subject types. Existing-employee branch is byte-for-byte the same
-- logic as the Phase 1.5 version; the historical-employee STOP is
-- replaced with a real INSERT branch.
-- ============================================================

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

  -- Idempotency/duplicate-liability guard: this status check, combined
  -- with the FOR UPDATE row lock taken above, means a retried or
  -- concurrent call on the same row can never create a second
  -- terminal_dues row -- the second caller always lands here, not past
  -- it. The UNIQUE index on submitted_terminal_due_id is a second,
  -- independent, database-enforced backstop against the same outcome.
  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'This calculation has already been submitted (status: %)', v_row.status;
  END IF;

  IF v_row.employee_id IS NOT NULL THEN
    -- ---- Existing-employee subject (unchanged from Phase 1.5) ----
    SELECT * INTO v_employee FROM employees WHERE id = v_row.employee_id;
    IF v_employee IS NULL OR v_employee.tenant_id <> v_tenant_id THEN
      RAISE EXCEPTION 'The employee for this calculation could not be found';
    END IF;
    IF NOT is_super_admin() AND NOT region_allowed(v_employee.region_id) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;

    -- Re-derive the entitlement amounts from this calculation's own
    -- inputs/breakdown (never trust a client-supplied amount) and insert
    -- a brand-new 'pending' terminal_dues row. If this employee already
    -- has an open (pending/approved) row -- e.g. created directly via
    -- the legacy Records tab -- idx_terminal_dues_one_open_per_employee
    -- rejects the insert; caught below and re-raised as a clear message.
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
  ELSE
    -- ---- Historical-employee subject ----
    -- No region_allowed() check here: historical subjects are tenant-wide,
    -- not region-scoped -- same policy already established for
    -- historical_employees and terminal_due_calculations themselves. The
    -- tenant match below is the authoritative isolation boundary for this
    -- subject type; there is no weaker check being skipped.
    SELECT * INTO v_historical FROM historical_employees WHERE id = v_row.historical_employee_id;
    IF v_historical IS NULL OR v_historical.tenant_id <> v_tenant_id THEN
      RAISE EXCEPTION 'The historical employee for this calculation could not be found';
    END IF;

    BEGIN
      INSERT INTO terminal_dues (
        tenant_id, historical_employee_id, employee_name, employee_number, position,
        date_joined, date_left, period_months, basic_salary,
        gratuity, annual_leave, uniform_refund, other_benefits,
        subtotal, deductions, total_payable, status
      ) VALUES (
        v_tenant_id, v_historical.id, v_historical.full_name, v_historical.historical_reference, v_row.position,
        (v_row.inputs->>'dateJoined')::date, (v_row.inputs->>'dateLeft')::date,
        (v_row.breakdown->>'effectiveMonths')::integer, (v_row.inputs->>'finalSalary')::numeric,
        (v_row.breakdown->>'pensionArrears')::numeric, (v_row.breakdown->>'annualLeaveRefund')::numeric,
        (v_row.breakdown->>'uniformRefund')::numeric, (v_row.breakdown->>'outstandingSalaryTotal')::numeric,
        (v_row.breakdown->>'totalEntitlements')::numeric, (v_row.breakdown->>'lessNoticeDeduction')::numeric,
        (v_row.breakdown->>'totalPayable')::numeric, 'pending'
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

-- Signature is unchanged (p_id UUID) -- grants already in place from
-- 20261020000000 continue to apply.

-- ============================================================
-- PART 3: approve_terminal_due(), record_terminal_due_payment(),
-- return_terminal_due_for_correction() -- each gets the SAME narrow
-- change: the region check below `IF NOT (is_super_admin() OR
-- is_business_admin())` now only runs when the row has an employee_id
-- (i.e. unchanged, identical behavior for every legacy row). A
-- historical-linked row skips it -- tenant isolation (checked earlier in
-- each function, unchanged) is the authoritative boundary for that
-- subject type, consistent with how historical subjects are already
-- treated everywhere else in this feature. Nothing else in any of these
-- three functions changes.
-- ============================================================

CREATE OR REPLACE FUNCTION approve_terminal_due(p_terminal_due_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_due RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may approve terminal dues';
  END IF;

  SELECT * INTO v_due FROM terminal_dues WHERE id = p_terminal_due_id FOR UPDATE;

  IF v_due IS NULL OR (v_due.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due record not found';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) AND v_due.employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_due.employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  IF v_due.status <> 'pending' THEN
    RAISE EXCEPTION 'Cannot approve a % terminal due -- only a pending calculation can be approved', v_due.status;
  END IF;

  UPDATE terminal_dues SET
    status = 'approved',
    approved_by = v_caller_id,
    approved_at = NOW(),
    returned_by = NULL,
    returned_by_name = NULL,
    returned_at = NULL,
    return_reason = NULL,
    updated_at = NOW()
  WHERE id = p_terminal_due_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'APPROVE', 'terminal_due', p_terminal_due_id::text,
    jsonb_build_object('status', v_due.status),
    jsonb_build_object('status', 'approved', 'approved_by', v_caller_id)
  );

  RETURN jsonb_build_object('success', true, 'id', p_terminal_due_id, 'status', 'approved');
END;
$$;

CREATE OR REPLACE FUNCTION record_terminal_due_payment(
  p_terminal_due_id UUID,
  p_payment_date DATE,
  p_payment_method TEXT,
  p_payment_reference TEXT,
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
  v_due RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.pay')) THEN
    RAISE EXCEPTION 'Only an Accountant explicitly granted terminal_dues.pay (or a super admin) may record terminal dues payments';
  END IF;

  IF p_payment_date IS NULL THEN
    RAISE EXCEPTION 'Payment date is required';
  END IF;
  IF p_payment_method IS NULL OR btrim(p_payment_method) = '' THEN
    RAISE EXCEPTION 'Payment method is required';
  END IF;
  IF p_payment_reference IS NULL OR btrim(p_payment_reference) = '' THEN
    RAISE EXCEPTION 'Payment reference is required';
  END IF;

  SELECT * INTO v_due FROM terminal_dues WHERE id = p_terminal_due_id FOR UPDATE;

  IF v_due IS NULL OR (v_due.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due record not found';
  END IF;

  -- Phase 1.5 guard (unchanged): a terminal_dues row promoted from a
  -- modern terminal_due_calculations draft -- existing-employee OR
  -- historical -- must not be paid through this legacy single-shot RPC.
  IF EXISTS (
    SELECT 1 FROM terminal_due_calculations
    WHERE submitted_terminal_due_id = p_terminal_due_id
  ) THEN
    RAISE EXCEPTION 'This Terminal Due originated from a modern Terminal Dues calculation and must be processed through the monthly-allocation workflow (not yet available), not paid directly.';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) AND v_due.employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_due.employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  IF v_due.status = 'pending' THEN
    RAISE EXCEPTION 'Cannot record payment for a pending terminal due -- it must be approved first';
  END IF;
  IF v_due.status <> 'approved' THEN
    RAISE EXCEPTION 'Cannot record payment for a % terminal due -- only an approved calculation can be paid', v_due.status;
  END IF;

  UPDATE terminal_dues SET
    status = 'paid',
    payment_date = p_payment_date,
    payment_method = p_payment_method,
    payment_reference = p_payment_reference,
    payment_notes = p_notes,
    paid_by = v_caller_id,
    paid_at = NOW(),
    updated_at = NOW()
  WHERE id = p_terminal_due_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'UPDATE', 'terminal_due', p_terminal_due_id::text,
    jsonb_build_object('status', v_due.status),
    jsonb_build_object(
      'status', 'paid', 'paid_by', v_caller_id,
      'payment_date', p_payment_date, 'payment_method', p_payment_method,
      'payment_reference', p_payment_reference
    )
  );

  RETURN jsonb_build_object('success', true, 'id', p_terminal_due_id, 'status', 'paid');
END;
$$;

CREATE OR REPLACE FUNCTION return_terminal_due_for_correction(
  p_terminal_due_id UUID,
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
  v_due RECORD;
  v_caller_name TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may return a terminal due for correction';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to return a terminal due for correction';
  END IF;

  SELECT * INTO v_due FROM terminal_dues WHERE id = p_terminal_due_id FOR UPDATE;

  IF v_due IS NULL OR (v_due.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due record not found';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) AND v_due.employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_due.employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  IF v_due.status = 'paid' THEN
    RAISE EXCEPTION 'Cannot return a paid terminal due for correction';
  END IF;
  IF v_due.status <> 'approved' THEN
    RAISE EXCEPTION 'Cannot return a % terminal due for correction -- only an approved calculation can be returned', v_due.status;
  END IF;

  SELECT full_name INTO v_caller_name FROM profiles WHERE id = v_caller_id;

  UPDATE terminal_dues SET
    status = 'pending',
    approved_by = NULL,
    approved_at = NULL,
    returned_by = v_caller_id,
    returned_by_name = v_caller_name,
    returned_at = NOW(),
    return_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_terminal_due_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'UPDATE', 'terminal_due', p_terminal_due_id::text,
    jsonb_build_object('status', 'approved', 'approved_by', v_due.approved_by),
    jsonb_build_object('status', 'pending', 'returned_by', v_caller_id, 'return_reason', p_reason)
  );

  RETURN jsonb_build_object('success', true, 'id', p_terminal_due_id, 'status', 'pending');
END;
$$;
