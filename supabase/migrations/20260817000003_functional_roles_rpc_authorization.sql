-- ============================================================
-- MIGRATION: Functional-role authorization for SECURITY DEFINER RPCs
-- Date: 2026-08-17 (Phase B, part 3 of the functional-roles rollout --
-- see 20260817000000/1/2 for the security-helper foundation and the
-- direct/indirect regional RLS this migration's checks are modeled on)
-- SECURITY-RECONCILED (2026-09-08, production preflight): process_payroll_batch(),
-- create_salary_advance(), approve_salary_advance(), and
-- adjust_combined_repayment_plan() each read tenant_id/role_level/
-- is_super_admin directly off `profiles` via a raw SELECT, and only
-- checked that the row EXISTED -- never that it was active or
-- non-deleted. A DEACTIVATED super-admin, or a deactivated legacy
-- Admin/Manager (role_level = 1/2), could still call any of these four
-- and have their v_is_super_admin/v_role_level values read as-is from
-- the row, bypassing the account-disabled state entirely. All four now
-- explicitly reject `is_active = false OR deleted_at IS NOT NULL` before
-- considering any authorization branch, matching the same fail-closed
-- guarantee has_permission()/is_business_admin()/region_allowed()
-- (20260817000000) already provide everywhere else. None of these
-- vulnerable forms were ever applied to any real environment; this is
-- the only version that has ever shipped in this migration. Every
-- signature, every tenant/region check, every salary-advance/payroll
-- calculation is otherwise byte-for-byte unchanged.
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- -----------------------------------------------------------
-- Every RPC touched here is SECURITY DEFINER, so it bypasses RLS entirely
-- for its own writes/reads -- each function's own body IS its complete
-- authorization boundary. Redefining the region-scoped RLS on `payroll`/
-- `salary_advances`/`applicants` in 20260817000002 does NOT, by itself,
-- change what these RPCs will accept, since none of them go through RLS.
-- This migration adds a FUNCTIONAL-PERMISSION branch (has_permission(...))
-- alongside every existing LEGACY role_level check, and a REGION check for
-- non-business-admin callers, to each RPC -- so the new hr_manager/
-- accountant functional roles get exactly the RPC access the seeded
-- role_permissions matrix (20260817000000) grants them, scoped to their
-- own region, while every existing legacy caller's behavior is preserved
-- byte-for-byte.
--
-- SAME SAFE-TRANSITION SHAPE AS THE RLS MIGRATIONS
-- -----------------------------------------------------------
--   IF NOT (v_is_super_admin OR <legacy role_level check> OR has_permission('<key>')) THEN RAISE
--   ... then, separately, for non-super-admin/non-business-admin callers only:
--   IF NOT region_allowed(<target employee's region_id>) THEN RAISE
-- is_business_admin() (role='admin' OR role_level=1) is EXEMPT from the
-- region check, matching every RLS policy in this rollout -- an Admin has
-- full authority regardless of region. Because legacy role_level=1 always
-- satisfies is_business_admin(), this uniform region check is a NO-OP for
-- every existing Admin caller and only actually restricts the NEW
-- accountant/hr_manager functional roles -- exactly as intended. Per the
-- explicit "regional RLS must apply to legacy users too" instruction, a
-- legacy role_level=2 Manager (NOT a business admin) using these RPCs IS
-- now region-scoped for the first time -- a real, deliberate, documented
-- behavior tightening, consistent with the same tightening already applied
-- to the `salary_advances`/`payroll` tables' own RLS in 20260817000002.
--
-- generate_guard_id() / generate_employee_number(p_region_id) NEED NO
-- CHANGE -- SEE NOTE BELOW
-- -----------------------------------------------------------
-- Both already resolve the caller's tenant exclusively via
-- get_current_tenant_id(), which was redefined in Part 0 of
-- 20260817000000_functional_role_permissions_foundation.sql to return NULL
-- (raising 'No profile found'/'no tenant resolved') for any caller whose
-- profile is inactive or soft-deleted. That is the exact "every RPC
-- authorization path must reject inactive profiles" requirement -- it was
-- already satisfied for these two functions, for free, by centralizing the
-- check in the shared helper rather than duplicating it in every RPC.
-- Deliberately NOT touched by this migration -- there is nothing to change.
-- ============================================================

-- ============================================================
-- PART 1: process_payroll_batch(TEXT, JSONB, TEXT, JSONB)
-- Legacy: role_level = 1 (Admin) only. New: + has_permission('payroll.process')
-- (accountant, per the seeded matrix). Region: every employee in the batch
-- must be region_allowed() for a non-business-admin caller -- since legacy
-- role_level = 1 always implies is_business_admin(), this is a no-op for
-- every existing caller of this function and only bites the new accountant
-- functional-role path.
-- ============================================================
CREATE OR REPLACE FUNCTION process_payroll_batch(
  p_month TEXT,
  p_records JSONB,
  p_user_email TEXT DEFAULT NULL,
  p_audit_context JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_role_level INTEGER;
  v_is_super_admin BOOLEAN;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
  v_employee_ids UUID[];
  v_foreign_employee_count INTEGER;
  v_out_of_region_count INTEGER;
  v_approved_count INTEGER;
  v_inserted_count INTEGER;
  v_deleted_count INTEGER;
  v_old_rows JSONB;
  -- Salary-advance loop variables
  v_record JSONB;
  v_employee_id UUID;
  v_base_net_pay NUMERIC;
  v_advance_deduction NUMERIC;       -- TOTAL across this employee's (up to 2) advances this month
  v_pool_remaining NUMERIC;          -- this employee's combined monthly budget, decremented as allocated
  v_pool_advance RECORD;             -- cursor var for the oldest-first advance loop
  v_alloc NUMERIC;                   -- this specific advance's allocation this month
  v_remaining_balance NUMERIC;       -- this specific advance's remaining balance before this month
  v_existing_ledger_amount NUMERIC;
  v_advance_deductions_applied INTEGER := 0;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- ============================================================
  -- STEP 1: Resolve the caller's own tenant/role (unchanged).
  -- ============================================================
  SELECT tenant_id, role_level, is_super_admin, is_active, deleted_at
    INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active, v_deleted_at
  FROM profiles
  WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- SECURITY (2026-09-08 production preflight): reject an inactive/
  -- deleted caller BEFORE considering super-admin/role_level/permission
  -- authority. This function previously read v_is_super_admin/
  -- v_role_level as raw column values with no active/deleted_at check at
  -- all -- a DEACTIVATED super-admin or deactivated legacy Admin
  -- (role_level = 1) could still process payroll. Matches the same
  -- fail-closed guarantee has_permission()/is_business_admin()/
  -- region_allowed() (20260817000000) already provide for every other
  -- authorization path in this schema.
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled';
  END IF;

  -- AUTHORIZATION (functional-role branch added -- legacy check unchanged):
  IF NOT (v_is_super_admin OR v_role_level = 1 OR has_permission('payroll.process')) THEN
    RAISE EXCEPTION 'Only Admins or super admins may process payroll';
  END IF;

  IF p_records IS NULL OR jsonb_array_length(p_records) = 0 THEN
    RAISE EXCEPTION 'No payroll records supplied';
  END IF;

  -- ============================================================
  -- STEP 1.5: Payload validation (unchanged).
  -- ============================================================
  IF (SELECT COUNT(*) FROM jsonb_array_elements(p_records) AS r) <>
     (SELECT COUNT(DISTINCT r->>'employee_id') FROM jsonb_array_elements(p_records) AS r)
  THEN
    RAISE EXCEPTION 'Refusing to process: the same employee_id appears more than once in this batch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_records) AS r
    WHERE r->>'employee_id' IS NULL
       OR NOT (r->>'employee_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
       OR r->>'basic_salary' IS NULL OR NOT (r->>'basic_salary' ~ '^[0-9]+(\.[0-9]+)?$')
       OR r->>'gross_pay' IS NULL OR NOT (r->>'gross_pay' ~ '^[0-9]+(\.[0-9]+)?$')
       OR (r ? 'allowances' AND r->>'allowances' IS NOT NULL AND NOT (r->>'allowances' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR (r ? 'overtime' AND r->>'overtime' IS NOT NULL AND NOT (r->>'overtime' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR (r ? 'bonus' AND r->>'bonus' IS NOT NULL AND NOT (r->>'bonus' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR (r ? 'paye' AND r->>'paye' IS NOT NULL AND NOT (r->>'paye' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR (r ? 'pension' AND r->>'pension' IS NOT NULL AND NOT (r->>'pension' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR (r ? 'uniform_deduction' AND r->>'uniform_deduction' IS NOT NULL AND NOT (r->>'uniform_deduction' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR r->>'net_pay' IS NULL OR NOT (r->>'net_pay' ~ '^[0-9]+(\.[0-9]+)?$')
  ) THEN
    RAISE EXCEPTION 'Refusing to process payroll: one or more records has a missing, non-numeric, or negative monetary value -- every amount, including net_pay, must be zero or positive. Final payroll net pay must never be negative; review the deductions for the affected employee(s) and try again.';
  END IF;

  v_employee_ids := ARRAY(
    SELECT (r->>'employee_id')::UUID
    FROM jsonb_array_elements(p_records) AS r
  );

  -- ============================================================
  -- STEP 2: Concurrency control (unchanged).
  -- ============================================================
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || p_month));

  -- ============================================================
  -- STEP 3: Validate BEFORE any destructive change (unchanged tenant
  -- check, plus a NEW region check).
  -- ============================================================
  SELECT COUNT(*) INTO v_foreign_employee_count
  FROM unnest(v_employee_ids) AS eid
  WHERE NOT EXISTS (
    SELECT 1 FROM employees e WHERE e.id = eid AND e.tenant_id = v_tenant_id
  );

  IF v_foreign_employee_count > 0 THEN
    RAISE EXCEPTION 'Refusing to process: % of the supplied employee(s) do not belong to your tenant', v_foreign_employee_count;
  END IF;

  -- NEW: region check. is_business_admin()/is_super_admin() are exempt
  -- (full authority regardless of region, matching every RLS policy in
  -- this rollout); every other caller -- including a legacy role_level = 1
  -- caller who is NOT a business admin, which cannot actually occur since
  -- role_level = 1 always satisfies is_business_admin() -- must have every
  -- targeted employee within their own assigned region.
  IF NOT (v_is_super_admin OR is_business_admin()) THEN
    SELECT COUNT(*) INTO v_out_of_region_count
    FROM employees e
    WHERE e.id = ANY(v_employee_ids)
      AND NOT region_allowed(e.region_id);

    IF v_out_of_region_count > 0 THEN
      RAISE EXCEPTION 'Refusing to process: % of the supplied employee(s) are outside your assigned region', v_out_of_region_count;
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_approved_count
  FROM payroll
  WHERE month = p_month
    AND tenant_id = v_tenant_id
    AND employee_id = ANY(v_employee_ids)
    AND approval_status = 'approved';

  IF v_approved_count > 0 THEN
    RAISE EXCEPTION 'Cannot reprocess %: % of the targeted employees already have approved payroll for this month. Reject the existing approval first.', p_month, v_approved_count;
  END IF;

  -- ============================================================
  -- STEP 4: Delete + insert (unchanged).
  -- ============================================================
  SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::JSONB) INTO v_old_rows
  FROM payroll p
  WHERE p.month = p_month
    AND p.tenant_id = v_tenant_id
    AND p.employee_id = ANY(v_employee_ids);

  DELETE FROM payroll
  WHERE month = p_month
    AND tenant_id = v_tenant_id
    AND employee_id = ANY(v_employee_ids);
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  FOR v_record IN SELECT * FROM jsonb_array_elements(p_records)
  LOOP
    v_employee_id := (v_record->>'employee_id')::UUID;
    v_base_net_pay := ROUND((v_record->>'net_pay')::NUMERIC, 2);
    v_advance_deduction := 0;

    SELECT combined_monthly_deduction INTO v_pool_remaining
    FROM salary_advance_repayment_plans
    WHERE employee_id = v_employee_id;
    v_pool_remaining := COALESCE(v_pool_remaining, 0);

    FOR v_pool_advance IN
      SELECT sa.id, sa.advance_amount, sa.status
      FROM salary_advances sa
      WHERE sa.employee_id = v_employee_id
        AND sa.tenant_id = v_tenant_id
        AND (
          (sa.status = 'active' AND sa.deduction_start_month <= p_month)
          OR EXISTS (
            SELECT 1 FROM salary_advance_deductions sad
            WHERE sad.salary_advance_id = sa.id AND sad.payroll_month = p_month
          )
        )
      ORDER BY sa.application_date ASC, sa.created_at ASC, sa.id ASC
    LOOP
      SELECT deduction_amount INTO v_existing_ledger_amount
      FROM salary_advance_deductions
      WHERE salary_advance_id = v_pool_advance.id AND payroll_month = p_month;

      IF v_existing_ledger_amount IS NOT NULL THEN
        v_alloc := v_existing_ledger_amount;
      ELSE
        SELECT v_pool_advance.advance_amount - COALESCE(SUM(sad.deduction_amount), 0)
          INTO v_remaining_balance
        FROM salary_advance_deductions sad
        WHERE sad.salary_advance_id = v_pool_advance.id;

        v_remaining_balance := GREATEST(v_remaining_balance, 0);
        v_alloc := ROUND(LEAST(v_remaining_balance, v_pool_remaining), 2);

        IF v_alloc > 0 THEN
          INSERT INTO salary_advance_deductions (tenant_id, salary_advance_id, employee_id, payroll_month, deduction_amount)
          VALUES (v_tenant_id, v_pool_advance.id, v_employee_id, p_month, v_alloc);

          v_advance_deductions_applied := v_advance_deductions_applied + 1;
        END IF;

        IF v_pool_advance.status = 'active' AND (v_remaining_balance - v_alloc) <= 0 THEN
          UPDATE salary_advances SET status = 'paid', updated_at = NOW() WHERE id = v_pool_advance.id;
        END IF;
      END IF;

      v_advance_deduction := v_advance_deduction + v_alloc;
      v_pool_remaining := v_pool_remaining - v_alloc;
    END LOOP;

    IF (v_base_net_pay - v_advance_deduction) < 0 THEN
      RAISE EXCEPTION 'Refusing to process payroll for employee %: this would produce a negative net pay of % (net pay % minus a salary advance deduction of %). Final payroll net pay must never be negative -- resolve this before processing (e.g. reduce the combined repayment plan, move this employee''s deduction to a later month, or review their other deductions) -- nothing has been applied and the transaction has been rolled back.',
        v_employee_id, (v_base_net_pay - v_advance_deduction), v_base_net_pay, v_advance_deduction;
    END IF;

    DELETE FROM salary_advance_repayment_plans
    WHERE employee_id = v_employee_id
      AND NOT EXISTS (
        SELECT 1 FROM salary_advances WHERE employee_id = v_employee_id AND status = 'active'
      );

    INSERT INTO payroll (
      tenant_id, employee_id, month, basic_salary, allowances, overtime, bonus,
      gross_pay, paye, pension, uniform_deduction, salary_advance_deduction, net_pay,
      processed_at, approval_status, approved_by, approved_at, approval_notes, updated_at
    ) VALUES (
      v_tenant_id,
      v_employee_id,
      p_month,
      ROUND((v_record->>'basic_salary')::NUMERIC, 2),
      ROUND(COALESCE((v_record->>'allowances')::NUMERIC, 0), 2),
      ROUND(COALESCE((v_record->>'overtime')::NUMERIC, 0), 2),
      ROUND(COALESCE((v_record->>'bonus')::NUMERIC, 0), 2),
      ROUND((v_record->>'gross_pay')::NUMERIC, 2),
      ROUND(COALESCE((v_record->>'paye')::NUMERIC, 0), 2),
      ROUND(COALESCE((v_record->>'pension')::NUMERIC, 0), 2),
      ROUND(COALESCE((v_record->>'uniform_deduction')::NUMERIC, 0), 2),
      v_advance_deduction,
      v_base_net_pay - v_advance_deduction,
      NOW(),
      'pending',
      NULL,
      NULL,
      NULL,
      NOW()
    );
  END LOOP;

  v_inserted_count := jsonb_array_length(p_records);

  -- ============================================================
  -- STEP 5: Audit log (unchanged).
  -- ============================================================
  INSERT INTO audit_logs (
    tenant_id, user_id, user_email, user_role, region_id,
    action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    v_tenant_id,
    v_caller_id,
    p_user_email,
    CASE WHEN v_is_super_admin THEN 'super_admin' ELSE 'admin' END,
    NULL,
    'CREATE',
    'payroll',
    NULL,
    jsonb_build_object('deletedCount', v_deleted_count, 'deletedRows', v_old_rows),
    p_audit_context || jsonb_build_object(
      'month', p_month,
      'employeeCount', array_length(v_employee_ids, 1),
      'recordsSaved', v_inserted_count,
      'salaryAdvanceDeductionsApplied', v_advance_deductions_applied,
      'status', 'pending_approval'
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'month', p_month,
    'deletedCount', v_deleted_count,
    'insertedCount', v_inserted_count,
    'advanceDeductionsApplied', v_advance_deductions_applied
  );
END;
$$;

-- Re-stated (redundant with 20260803000002, this function's original
-- definition, whose ACL survives every later CREATE OR REPLACE unchanged)
-- for this file's own self-sufficiency.
REVOKE ALL ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) TO authenticated;

-- ============================================================
-- PART 2: create_salary_advance(...)
-- Legacy: role_level <= 2. New: + has_permission('salary_advances.create')
-- (hr_manager AND accountant both have this). Region: NEW -- applies to
-- EVERY non-business-admin caller, including a legacy role_level = 2
-- Manager, per the explicit "regional RLS must apply to legacy users too"
-- instruction.
-- ============================================================
CREATE OR REPLACE FUNCTION create_salary_advance(
  p_employee_id UUID,
  p_application_date DATE,
  p_advance_amount NUMERIC,
  p_repayment_method TEXT,
  p_configured_monthly_deduction NUMERIC,
  p_repayment_period_months INTEGER,
  p_final_deduction_amount NUMERIC,
  p_expected_payoff_month TEXT,
  p_deduction_start_month TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_role_level INTEGER;
  v_is_super_admin BOOLEAN;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
  v_open_count INTEGER;
  v_new_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT tenant_id, role_level, is_super_admin, is_active, deleted_at
  INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active, v_deleted_at
  FROM profiles WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- SECURITY (2026-09-08 production preflight): reject an inactive/
  -- deleted caller before considering super-admin/role_level/permission
  -- authority -- see process_payroll_batch's own header note above for
  -- the full rationale, identical here.
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled';
  END IF;

  -- AUTHORIZATION -- functional-role branch added, legacy check unchanged.
  IF NOT (v_is_super_admin OR v_role_level <= 2 OR has_permission('salary_advances.create')) THEN
    RAISE EXCEPTION 'Only Admins, Managers, or super admins may create salary advances';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'Employee does not belong to your tenant';
  END IF;

  -- NEW: region check, exempting is_super_admin()/is_business_admin() --
  -- applies to legacy role_level = 2 Managers too, not just the new
  -- functional roles (see this migration's header).
  IF NOT (v_is_super_admin OR is_business_admin()) THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  IF p_advance_amount IS NULL OR p_advance_amount <= 0 THEN
    RAISE EXCEPTION 'Advance amount must be a positive number';
  END IF;
  IF p_configured_monthly_deduction IS NULL OR p_configured_monthly_deduction <= 0 THEN
    RAISE EXCEPTION 'Monthly deduction must be a positive number';
  END IF;
  IF p_repayment_period_months IS NULL OR p_repayment_period_months <= 0 THEN
    RAISE EXCEPTION 'Repayment period must be a positive whole number of months';
  END IF;
  IF p_final_deduction_amount IS NULL OR p_final_deduction_amount <= 0 THEN
    RAISE EXCEPTION 'Final deduction amount must be a positive number';
  END IF;
  IF p_repayment_method NOT IN ('monthly_amount', 'repayment_period') THEN
    RAISE EXCEPTION 'Repayment method must be either monthly_amount or repayment_period';
  END IF;
  IF p_deduction_start_month IS NULL OR p_deduction_start_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Deduction start month must be in YYYY-MM format';
  END IF;
  IF ROUND(p_advance_amount - p_configured_monthly_deduction * (p_repayment_period_months - 1), 2) <> ROUND(p_final_deduction_amount, 2) THEN
    RAISE EXCEPTION 'Repayment schedule is internally inconsistent -- final deduction does not reconcile with the advance amount, monthly deduction, and period';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('salary_advance:' || p_employee_id::text));

  SELECT COUNT(*) INTO v_open_count
  FROM salary_advances
  WHERE employee_id = p_employee_id AND status IN ('pending', 'active');

  IF v_open_count >= 2 THEN
    RAISE EXCEPTION 'Employee already has the maximum of 2 open salary advances (pending or active). Resolve one before creating another.';
  END IF;

  INSERT INTO salary_advances (
    tenant_id, employee_id, application_date, advance_amount, repayment_method,
    configured_monthly_deduction, repayment_period_months, final_deduction_amount,
    expected_payoff_month, deduction_start_month, reason, status
  ) VALUES (
    v_tenant_id, p_employee_id, p_application_date, ROUND(p_advance_amount, 2), p_repayment_method,
    ROUND(p_configured_monthly_deduction, 2), p_repayment_period_months, ROUND(p_final_deduction_amount, 2),
    p_expected_payoff_month, p_deduction_start_month, p_reason, 'pending'
  ) RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('success', true, 'id', v_new_id);
END;
$$;

-- Re-stated (redundant with 20260813000000, this function's original
-- definition) for this file's own self-sufficiency.
REVOKE ALL ON FUNCTION create_salary_advance(UUID, DATE, NUMERIC, TEXT, NUMERIC, INTEGER, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_salary_advance(UUID, DATE, NUMERIC, TEXT, NUMERIC, INTEGER, NUMERIC, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION create_salary_advance(UUID, DATE, NUMERIC, TEXT, NUMERIC, INTEGER, NUMERIC, TEXT, TEXT, TEXT) TO authenticated;

-- ============================================================
-- PART 3: approve_salary_advance(...)
-- Legacy: role_level <= 2. New: + has_permission('salary_advances.approve').
-- Region: same rule, checked against the LOCKED advance's own employee_id
-- (resolved server-side, never a client-supplied employee id).
-- ============================================================
CREATE OR REPLACE FUNCTION approve_salary_advance(
  p_salary_advance_id UUID,
  p_new_repayment_method TEXT DEFAULT NULL,
  p_new_monthly_deduction NUMERIC DEFAULT NULL,
  p_new_repayment_period_months INTEGER DEFAULT NULL,
  p_new_deduction_start_month TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_role_level INTEGER;
  v_is_super_admin BOOLEAN;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
  v_advance RECORD;
  v_other_active_outstanding NUMERIC;
  v_other_active_count INTEGER;
  v_new_combined_outstanding NUMERIC;
  v_existing_plan RECORD;
  v_method TEXT;
  v_start_month TEXT;
  v_min_start_month TEXT;
  v_last_posted_month TEXT;
  v_new_monthly NUMERIC;
  v_new_months INTEGER;
  v_new_payoff_month TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT tenant_id, role_level, is_super_admin, is_active, deleted_at
  INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active, v_deleted_at
  FROM profiles WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- SECURITY (2026-09-08 production preflight): reject an inactive/
  -- deleted caller before considering super-admin/role_level/permission
  -- authority -- see process_payroll_batch's own header note above for
  -- the full rationale, identical here.
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled';
  END IF;

  -- AUTHORIZATION -- functional-role branch added, legacy check unchanged.
  IF NOT (v_is_super_admin OR v_role_level <= 2 OR has_permission('salary_advances.approve')) THEN
    RAISE EXCEPTION 'Only Admins, Managers, or super admins may approve salary advances';
  END IF;

  -- Step 1: lock the target advance.
  SELECT * INTO v_advance FROM salary_advances WHERE id = p_salary_advance_id FOR UPDATE;

  -- Step 3: tenant check.
  IF v_advance IS NULL OR (v_advance.tenant_id <> v_tenant_id AND NOT v_is_super_admin) THEN
    RAISE EXCEPTION 'Salary advance not found';
  END IF;

  -- NEW: region check against the advance's own (server-resolved) employee.
  IF NOT (v_is_super_admin OR is_business_admin()) THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_advance.employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  -- Step 2: must be pending.
  IF v_advance.status <> 'pending' THEN
    RAISE EXCEPTION 'Cannot approve a % advance -- only pending advances can be approved', v_advance.status;
  END IF;

  -- Step 4: employee-scoped advisory lock -- same key create_salary_advance() uses.
  PERFORM pg_advisory_xact_lock(hashtext('salary_advance:' || v_advance.employee_id::text));

  SELECT COALESCE(SUM(sa.advance_amount - COALESCE(ledger.repaid, 0)), 0), COUNT(*)
    INTO v_other_active_outstanding, v_other_active_count
  FROM salary_advances sa
  LEFT JOIN (
    SELECT salary_advance_id, SUM(deduction_amount) AS repaid
    FROM salary_advance_deductions GROUP BY salary_advance_id
  ) ledger ON ledger.salary_advance_id = sa.id
  WHERE sa.employee_id = v_advance.employee_id AND sa.status = 'active';

  v_new_combined_outstanding := v_other_active_outstanding + v_advance.advance_amount;

  SELECT * INTO v_existing_plan FROM salary_advance_repayment_plans WHERE employee_id = v_advance.employee_id;

  IF v_other_active_count = 0 THEN
    v_method := COALESCE(p_new_repayment_method, v_advance.repayment_method);
    v_start_month := COALESCE(p_new_deduction_start_month, v_advance.deduction_start_month);
  ELSE
    IF p_new_repayment_method IS NULL THEN
      RAISE EXCEPTION 'An existing active advance is already outstanding for this employee -- a new combined repayment method and monthly amount or period must be provided to approve a second advance';
    END IF;
    v_method := p_new_repayment_method;
    v_start_month := COALESCE(p_new_deduction_start_month, v_advance.deduction_start_month);
  END IF;

  IF v_start_month IS NULL OR v_start_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Deduction start month must be in YYYY-MM format';
  END IF;

  SELECT MAX(payroll_month) INTO v_last_posted_month
  FROM salary_advance_deductions WHERE employee_id = v_advance.employee_id;

  IF v_last_posted_month IS NOT NULL THEN
    v_min_start_month := to_char((to_date(v_last_posted_month || '-01', 'YYYY-MM-DD') + INTERVAL '1 month')::date, 'YYYY-MM');
    IF v_start_month < v_min_start_month THEN
      RAISE EXCEPTION 'New deduction start month cannot be earlier than % (the month after the last already-posted deduction)', v_min_start_month;
    END IF;
  END IF;

  IF v_method = 'monthly_amount' THEN
    IF p_new_monthly_deduction IS NULL THEN
      IF v_other_active_count = 0 THEN
        v_new_monthly := ROUND(v_advance.configured_monthly_deduction, 2);
      ELSE
        RAISE EXCEPTION 'A new combined monthly deduction amount must be provided to approve a second advance';
      END IF;
    ELSE
      IF p_new_monthly_deduction <= 0 THEN
        RAISE EXCEPTION 'Monthly deduction must be a positive number';
      END IF;
      v_new_monthly := ROUND(p_new_monthly_deduction, 2);
    END IF;
    v_new_months := CEIL(v_new_combined_outstanding / v_new_monthly);
  ELSIF v_method = 'repayment_period' THEN
    IF p_new_repayment_period_months IS NULL THEN
      IF v_other_active_count = 0 THEN
        v_new_months := v_advance.repayment_period_months;
      ELSE
        RAISE EXCEPTION 'A new combined repayment period (number of months) must be provided to approve a second advance';
      END IF;
    ELSE
      IF p_new_repayment_period_months <= 0 THEN
        RAISE EXCEPTION 'Repayment period must be a positive whole number of months';
      END IF;
      v_new_months := p_new_repayment_period_months;
    END IF;
    v_new_monthly := FLOOR(v_new_combined_outstanding / v_new_months);
    IF v_new_monthly <= 0 THEN
      RAISE EXCEPTION 'Repayment period is too long for the combined outstanding balance -- the monthly deduction would round to zero';
    END IF;
  ELSE
    RAISE EXCEPTION 'Repayment method must be either monthly_amount or repayment_period';
  END IF;

  v_new_payoff_month := to_char(
    (to_date(v_start_month || '-01', 'YYYY-MM-DD') + ((v_new_months - 1) || ' months')::interval)::date,
    'YYYY-MM'
  );

  IF v_existing_plan IS NOT NULL THEN
    INSERT INTO salary_advance_repayment_plan_changes (
      tenant_id, employee_id, changed_by,
      previous_repayment_method, previous_monthly_deduction, previous_repayment_period_months, previous_deduction_start_month,
      new_repayment_method, new_monthly_deduction, new_repayment_period_months, new_deduction_start_month,
      total_outstanding_at_change, reason
    ) VALUES (
      v_tenant_id, v_advance.employee_id, v_caller_id,
      v_existing_plan.repayment_method, v_existing_plan.combined_monthly_deduction, v_existing_plan.repayment_period_months, v_existing_plan.deduction_start_month,
      v_method, v_new_monthly, v_new_months, v_start_month,
      v_new_combined_outstanding, COALESCE(p_reason, 'Additional salary advance approved -- combined repayment plan updated')
    );
  END IF;

  INSERT INTO salary_advance_repayment_plans (
    tenant_id, employee_id, repayment_method, combined_monthly_deduction,
    repayment_period_months, deduction_start_month, expected_payoff_month, changed_by
  ) VALUES (
    v_tenant_id, v_advance.employee_id, v_method, v_new_monthly,
    v_new_months, v_start_month, v_new_payoff_month, v_caller_id
  )
  ON CONFLICT (employee_id) DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id,
    repayment_method = EXCLUDED.repayment_method,
    combined_monthly_deduction = EXCLUDED.combined_monthly_deduction,
    repayment_period_months = EXCLUDED.repayment_period_months,
    deduction_start_month = EXCLUDED.deduction_start_month,
    expected_payoff_month = EXCLUDED.expected_payoff_month,
    changed_by = EXCLUDED.changed_by,
    changed_at = NOW();

  PERFORM set_config('app.allow_salary_advance_approval', 'true', true);

  UPDATE salary_advances SET
    status = 'active',
    approved_by = v_caller_id,
    approved_at = NOW(),
    updated_at = NOW()
  WHERE id = p_salary_advance_id;

  RETURN jsonb_build_object(
    'success', true,
    'id', p_salary_advance_id,
    'combinedMonthlyDeduction', v_new_monthly,
    'repaymentPeriodMonths', v_new_months,
    'expectedPayoffMonth', v_new_payoff_month,
    'combinedOutstanding', v_new_combined_outstanding
  );
END;
$$;

-- Re-stated (redundant with 20260813000000, this function's original
-- definition) for this file's own self-sufficiency.
REVOKE ALL ON FUNCTION approve_salary_advance(UUID, TEXT, NUMERIC, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_salary_advance(UUID, TEXT, NUMERIC, INTEGER, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION approve_salary_advance(UUID, TEXT, NUMERIC, INTEGER, TEXT, TEXT) TO authenticated;

-- ============================================================
-- PART 4: adjust_combined_repayment_plan(...)
-- Legacy: role_level <= 2. New: + has_permission('salary_advances.adjust').
-- Region: same rule, against p_employee_id.
-- ============================================================
CREATE OR REPLACE FUNCTION adjust_combined_repayment_plan(
  p_employee_id UUID,
  p_new_repayment_method TEXT,
  p_new_deduction_start_month TEXT,
  p_new_monthly_deduction NUMERIC DEFAULT NULL,
  p_new_repayment_period_months INTEGER DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_role_level INTEGER;
  v_is_super_admin BOOLEAN;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
  v_plan RECORD;
  v_total_outstanding NUMERIC;
  v_last_posted_month TEXT;
  v_min_start_month TEXT;
  v_new_monthly NUMERIC;
  v_new_months INTEGER;
  v_new_payoff_month TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT tenant_id, role_level, is_super_admin, is_active, deleted_at
  INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active, v_deleted_at
  FROM profiles WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- SECURITY (2026-09-08 production preflight): reject an inactive/
  -- deleted caller before considering super-admin/role_level/permission
  -- authority -- see process_payroll_batch's own header note above for
  -- the full rationale, identical here.
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled';
  END IF;

  -- AUTHORIZATION -- functional-role branch added, legacy check unchanged.
  IF NOT (v_is_super_admin OR v_role_level <= 2 OR has_permission('salary_advances.adjust')) THEN
    RAISE EXCEPTION 'Only Admins, Managers, or super admins may adjust a repayment plan';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'Employee does not belong to your tenant';
  END IF;

  -- NEW: region check, same rule as the other two salary-advance RPCs.
  IF NOT (v_is_super_admin OR is_business_admin()) THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  SELECT * INTO v_plan FROM salary_advance_repayment_plans WHERE employee_id = p_employee_id FOR UPDATE;

  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'This employee has no current repayment plan to adjust -- create a salary advance first';
  END IF;

  SELECT COALESCE(SUM(sa.advance_amount - COALESCE(ledger.repaid, 0)), 0)
    INTO v_total_outstanding
  FROM salary_advances sa
  LEFT JOIN (
    SELECT salary_advance_id, SUM(deduction_amount) AS repaid
    FROM salary_advance_deductions GROUP BY salary_advance_id
  ) ledger ON ledger.salary_advance_id = sa.id
  WHERE sa.employee_id = p_employee_id AND sa.status = 'active';

  IF v_total_outstanding IS NULL OR v_total_outstanding <= 0 THEN
    RAISE EXCEPTION 'This employee has no remaining salary advance balance to adjust';
  END IF;

  SELECT MAX(payroll_month) INTO v_last_posted_month
  FROM salary_advance_deductions WHERE employee_id = p_employee_id;

  IF v_last_posted_month IS NOT NULL THEN
    v_min_start_month := to_char((to_date(v_last_posted_month || '-01', 'YYYY-MM-DD') + INTERVAL '1 month')::date, 'YYYY-MM');
  ELSE
    v_min_start_month := v_plan.deduction_start_month;
  END IF;

  IF p_new_deduction_start_month IS NULL OR p_new_deduction_start_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Deduction start month must be in YYYY-MM format';
  END IF;
  IF p_new_deduction_start_month < v_min_start_month THEN
    RAISE EXCEPTION 'New deduction start month cannot be earlier than % (the month after the last already-posted deduction)', v_min_start_month;
  END IF;

  IF p_new_repayment_method = 'monthly_amount' THEN
    IF p_new_monthly_deduction IS NULL OR p_new_monthly_deduction <= 0 THEN
      RAISE EXCEPTION 'Monthly deduction must be a positive number';
    END IF;
    v_new_monthly := ROUND(p_new_monthly_deduction, 2);
    v_new_months := CEIL(v_total_outstanding / v_new_monthly);
  ELSIF p_new_repayment_method = 'repayment_period' THEN
    IF p_new_repayment_period_months IS NULL OR p_new_repayment_period_months <= 0 THEN
      RAISE EXCEPTION 'Repayment period must be a positive whole number of months';
    END IF;
    v_new_months := p_new_repayment_period_months;
    v_new_monthly := FLOOR(v_total_outstanding / v_new_months);
    IF v_new_monthly <= 0 THEN
      RAISE EXCEPTION 'Repayment period is too long for the remaining balance -- the monthly deduction would round to zero';
    END IF;
  ELSE
    RAISE EXCEPTION 'Repayment method must be either monthly_amount or repayment_period';
  END IF;

  v_new_payoff_month := to_char(
    (to_date(p_new_deduction_start_month || '-01', 'YYYY-MM-DD') + ((v_new_months - 1) || ' months')::interval)::date,
    'YYYY-MM'
  );

  INSERT INTO salary_advance_repayment_plan_changes (
    tenant_id, employee_id, changed_by,
    previous_repayment_method, previous_monthly_deduction, previous_repayment_period_months, previous_deduction_start_month,
    new_repayment_method, new_monthly_deduction, new_repayment_period_months, new_deduction_start_month,
    total_outstanding_at_change, reason
  ) VALUES (
    v_tenant_id, p_employee_id, v_caller_id,
    v_plan.repayment_method, v_plan.combined_monthly_deduction, v_plan.repayment_period_months, v_plan.deduction_start_month,
    p_new_repayment_method, v_new_monthly, v_new_months, p_new_deduction_start_month,
    v_total_outstanding, p_reason
  );

  UPDATE salary_advance_repayment_plans SET
    repayment_method = p_new_repayment_method,
    combined_monthly_deduction = v_new_monthly,
    repayment_period_months = v_new_months,
    deduction_start_month = p_new_deduction_start_month,
    expected_payoff_month = v_new_payoff_month,
    changed_by = v_caller_id,
    changed_at = NOW()
  WHERE employee_id = p_employee_id;

  RETURN jsonb_build_object(
    'success', true,
    'employeeId', p_employee_id,
    'combinedMonthlyDeduction', v_new_monthly,
    'repaymentPeriodMonths', v_new_months,
    'expectedPayoffMonth', v_new_payoff_month,
    'totalOutstanding', v_total_outstanding
  );
END;
$$;

-- Re-stated (redundant with 20260813000000, this function's original
-- definition) for this file's own self-sufficiency.
REVOKE ALL ON FUNCTION adjust_combined_repayment_plan(UUID, TEXT, TEXT, NUMERIC, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION adjust_combined_repayment_plan(UUID, TEXT, TEXT, NUMERIC, INTEGER, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION adjust_combined_repayment_plan(UUID, TEXT, TEXT, NUMERIC, INTEGER, TEXT) TO authenticated;

-- ============================================================
-- PART 5: get_applicant_dashboard_counts()
-- Prior behavior: every authenticated role (1-4), tenant-wide (cross-tenant
-- for super admin), no region filter at all. New behavior (item 13/27/29):
--   * VISIBILITY -- unchanged for every legacy account (role_level IS NOT
--     NULL): still sees these counts regardless of role_level, exactly as
--     before. A NEW functional-role account (role_level IS NULL) additionally
--     needs has_permission('recruitment.view') (currently only hr_manager)
--     or to be a business admin/super admin -- an operations_manager or
--     accountant account gets three zeros back, NOT an exception, so
--     Dashboard.tsx's existing call/render path needs no error handling
--     change.
--   * REGION -- NEW. is_super_admin()/is_business_admin() keep the exact
--     prior unrestricted scope. Every other caller -- legacy OR
--     functional, applying the "regional RLS must apply to legacy users
--     too" rule -- is now scoped to applicants in their own region only.
--     TRANSITIONAL CONSEQUENCE: every existing `applicants` row has
--     region_id = NULL today, so a region-scoped caller (e.g. a legacy
--     Manager, or the new hr_manager role) sees 0/0/0 until
--     Recruitment.tsx (a later step in this pass) starts populating
--     region_id on new applicants going forward -- documented here and in
--     the final report, not a bug.
-- ============================================================
CREATE OR REPLACE FUNCTION get_applicant_dashboard_counts()
RETURNS TABLE (
  pending_count INTEGER,
  shortlisted_count INTEGER,
  interviewed_count INTEGER
)
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_role_level INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for the current user';
  END IF;

  v_role_level := current_user_role_level();

  IF v_role_level IS NULL AND NOT is_business_admin() AND NOT is_super_admin()
     AND NOT has_permission('recruitment.view') THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE interview_status = 'Pending')::INTEGER,
    COUNT(*) FILTER (WHERE interview_status = 'Shortlisted')::INTEGER,
    COUNT(*) FILTER (WHERE interview_status = 'Interviewed')::INTEGER
  FROM applicants
  WHERE (tenant_id = v_tenant_id OR is_super_admin() = true)
    AND (
      is_super_admin() OR is_business_admin()
      OR region_id IS NOT DISTINCT FROM current_user_region_id()
    );
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION get_applicant_dashboard_counts() FROM PUBLIC;
REVOKE EXECUTE
ON FUNCTION public.get_applicant_dashboard_counts()
FROM anon;
GRANT EXECUTE ON FUNCTION get_applicant_dashboard_counts() TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- every statement is `CREATE OR REPLACE
-- FUNCTION` with the SAME signature as the version it replaces, plus the
-- same REVOKE/GRANT pairs. No table, column, or constraint is touched.
--
-- DEPENDENCIES: requires 20260817000000_functional_role_permissions_foundation.sql
-- (has_permission(), is_business_admin(), region_allowed(),
-- current_user_region_id()) to already be applied. Must be applied AFTER
-- 20260813000001_payroll_salary_advance_integration.sql,
-- 20260813000000_salary_advances_schema.sql, and
-- 20260804000002_applicant_dashboard_counts_rpc.sql (whose functions these
-- replace).
--
-- LOCKING / PRODUCTION TRAFFIC IMPACT: catalog-only changes (function
-- redefinition) -- no table alter, no data scan/rewrite.
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS:
--   * process_payroll_batch(): NONE for any Admin (role_level = 1) or super
--     admin caller -- both are always is_business_admin()/is_super_admin(),
--     so the new region check is a no-op for them, and the auth check's
--     added has_permission() branch only ever matters for a caller who was
--     ALREADY being rejected before this migration.
--   * create_salary_advance() / approve_salary_advance() /
--     adjust_combined_repayment_plan(): a legacy role_level = 2 Manager who
--     is NOT also is_business_admin() (role != 'admin') is now REJECTED
--     with 'This employee is outside your assigned region' when acting on
--     an employee outside their own profiles.region_id -- this is a real,
--     deliberate tightening for existing Manager accounts, matching the
--     identical tightening already applied to these same tables' RLS in
--     20260817000002. Any Manager account with region_id = NULL will, per
--     region_allowed()'s NULL-safe equality, only match employees whose own
--     region_id is ALSO NULL -- confirm real STAGING Manager/employee region
--     assignments before relying on this in production.
--   * get_applicant_dashboard_counts(): (a) a legacy Manager/Supervisor/
--     Staff account now sees COUNTS SCOPED TO THEIR OWN REGION rather than
--     the whole tenant -- given every existing `applicants` row has
--     region_id = NULL today, EVERY such caller will see 0/0/0 immediately
--     after this migration is applied, until applicants start being created
--     with a real region_id. This is the single most visible behavior
--     change in this migration -- flag it explicitly before applying to
--     STAGING. (b) an operations_manager/accountant functional-role account
--     (no recruitment.view permission) now gets 0/0/0 instead of an error --
--     there was no such account type before this rollout, so this is net-new
--     behavior, not a regression.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT proname, prosecdef FROM pg_proc WHERE proname IN
--     ('process_payroll_batch','create_salary_advance','approve_salary_advance',
--      'adjust_combined_repayment_plan','get_applicant_dashboard_counts');
--   -- expected: 5 rows, all prosecdef = true
--   SELECT has_function_privilege('authenticated', 'get_applicant_dashboard_counts()', 'EXECUTE');
--   SELECT has_function_privilege('anon', 'get_applicant_dashboard_counts()', 'EXECUTE');
--   -- expected: authenticated = true, anon = false
--
-- ROLLBACK: re-apply the prior CREATE OR REPLACE FUNCTION block for each
-- function verbatim from its ORIGINAL migration
-- (20260813000001/20260813000000/20260804000002) -- same signatures
-- throughout, so this fully reverts without a DROP FUNCTION first.
-- ============================================================
