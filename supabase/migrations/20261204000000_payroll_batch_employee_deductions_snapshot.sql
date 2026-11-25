-- PROPOSAL -- NOT APPLIED. Written for review alongside the Salary
-- Advances + Payroll & Payslip Financial Transparency audit; per that
-- task's explicit instructions this has deliberately NOT been run against
-- any database (see mcp__Supabase__apply_migration -- not called for this
-- file). An authorized reviewer should apply it only after independently
-- re-diffing this body against the function's then-current production
-- definition (pg_get_functiondef('process_payroll_batch'::regproc)), in
-- case something else has changed it since this file was written.
--
-- ROOT CAUSE THIS ADDRESSES (read-only production investigation, see the
-- accompanying report): payroll.uniform_deduction is a bundled total
-- (uniform + absence + late + lecture + appearance). It can only be
-- honestly decomposed for a processed month when a frozen
-- `employee_deductions` row exists for that employee/month --
-- deriveItemizedAttendanceDeduction() (src/utils/payrollDeductionBreakdown.ts)
-- already implements that rule correctly and never guesses. The reason so
-- much of every month's total lands in the Payroll Manager's "Not
-- itemized" bucket (confirmed on production: August 2026 100% of
-- MK8,873,600; September 2026 795 of 867 non-zero employees / MK12,869,200;
-- October 2026 832 of 1001 / MK9,973,600 -- an EXACT match to what the
-- Payroll page itself reports) is that `employee_deductions` rows are
-- currently only ever created by an HR user manually opening Attendance.tsx
-- for one employee at a time and clicking Save (see that page's
-- saveDeductions()) -- never automatically, for every employee, at the
-- moment their payroll is actually committed. An employee with zero
-- attendance infractions that month (pure uniform charge only) has no
-- reason for HR to ever open that editor, so they never get a row, and
-- their otherwise-100%-explainable uniform-only charge is reported as
-- unexplained.
--
-- FIX (additive, future-processing only): process_payroll_batch() already
-- loops over every employee in the batch and INSERTs their committed
-- `payroll` row inside one atomic transaction. This adds exactly one
-- further INSERT in that same loop, immediately after the payroll row is
-- committed: a default employee_deductions row (all-zero) for that
-- employee/month, ONLY if one does not already exist (ON CONFLICT
-- (employee_id, month) DO NOTHING -- employee_deductions_employee_id_month_key,
-- confirmed on production via pg_constraint). This:
--   * NEVER touches any month already processed before this migration is
--     applied (it only runs inside this function's own INSERT loop, for
--     whatever batch is passed to a FUTURE call);
--   * NEVER overwrites an employee_deductions row HR already entered for
--     this employee/month (ON CONFLICT ... DO NOTHING; HR's own entry,
--     whenever it happens -- before or after processing -- always wins);
--   * NEVER changes any payroll figure, rate, or approval/arithmetic
--     check already in this function -- every other line below is
--     reproduced unchanged from the live production definition (captured
--     2026-11-25 via pg_get_functiondef) for diff-ability;
--   * makes the employee's uniform/attendance total itemizable going
--     forward even when every attendance category is genuinely zero (an
--     explicit, confirmed "MK0 absence/late/lecture/appearance, the rest
--     is Uniform" is categorically different from "no record exists at
--     all" -- this never fabricates a non-zero figure, only confirms
--     zeroes that were never written down).
--
-- This does NOT, by itself, backfill August/September/October 2026 or any
-- other already-processed month -- those stay exactly as this audit found
-- them, with their real itemization gaps still reported honestly as "Not
-- itemized" by the existing deriveItemizedAttendanceDeduction() logic,
-- per that task's explicit instruction never to recalculate or rewrite
-- already-processed payroll.

CREATE OR REPLACE FUNCTION public.process_payroll_batch(p_month text, p_records jsonb, p_user_email text DEFAULT NULL::text, p_audit_context jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_ineligible_count INTEGER;
  v_approved_count INTEGER;
  v_inserted_count INTEGER;
  v_deleted_count INTEGER;
  v_old_rows JSONB;
  v_record JSONB;
  v_employee_id UUID;
  v_base_net_pay NUMERIC;
  v_advance_deduction NUMERIC;
  v_pool_remaining NUMERIC;
  v_pool_advance RECORD;
  v_alloc NUMERIC;
  v_remaining_balance NUMERIC;
  v_existing_ledger_amount NUMERIC;
  v_advance_deductions_applied INTEGER := 0;
  v_paye_rate_raw TEXT;
  v_paye_threshold_raw TEXT;
  v_pension_rate_raw TEXT;
  v_paye_rate NUMERIC;
  v_paye_threshold NUMERIC;
  v_pension_rate NUMERIC;
  v_gross_pay NUMERIC;
  v_submitted_paye NUMERIC;
  v_submitted_pension NUMERIC;
  v_expected_paye NUMERIC;
  v_expected_pension NUMERIC;
  v_refund_amount NUMERIC;
  v_new_payroll_id UUID;
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

  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled';
  END IF;

  IF NOT (v_is_super_admin OR COALESCE(v_role_level = 1, false) OR has_permission('payroll.process')) THEN
    RAISE EXCEPTION 'Only Admins or super admins may process payroll';
  END IF;

  IF p_records IS NULL OR jsonb_array_length(p_records) = 0 THEN
    RAISE EXCEPTION 'No payroll records supplied';
  END IF;

  SELECT
    MAX(CASE WHEN key = 'paye_rate' THEN value END),
    MAX(CASE WHEN key = 'paye_threshold' THEN value END),
    MAX(CASE WHEN key = 'pension_employee_rate' THEN value END)
  INTO v_paye_rate_raw, v_paye_threshold_raw, v_pension_rate_raw
  FROM system_settings
  WHERE tenant_id = v_tenant_id AND key IN ('paye_rate', 'paye_threshold', 'pension_employee_rate');

  IF v_paye_rate_raw IS NULL OR v_paye_threshold_raw IS NULL OR v_pension_rate_raw IS NULL THEN
    RAISE EXCEPTION 'Refusing to process payroll: PAYE/pension rate settings have not been configured for this tenant (paye_rate, paye_threshold, and pension_employee_rate must all be set -- an explicit 0 is a valid configured value). An authorized user must configure them in Settings first.';
  END IF;

  IF NOT (v_paye_rate_raw ~ '^[0-9]+(\.[0-9]+)?$')
     OR NOT (v_paye_threshold_raw ~ '^[0-9]+(\.[0-9]+)?$')
     OR NOT (v_pension_rate_raw ~ '^[0-9]+(\.[0-9]+)?$')
  THEN
    RAISE EXCEPTION 'Refusing to process payroll: one or more PAYE/pension rate settings for this tenant is not a valid non-negative number. Fix it in Settings before processing.';
  END IF;

  v_paye_rate := v_paye_rate_raw::NUMERIC;
  v_paye_threshold := v_paye_threshold_raw::NUMERIC;
  v_pension_rate := v_pension_rate_raw::NUMERIC;

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

  v_employee_ids := ARRAY(SELECT (r->>'employee_id')::UUID FROM jsonb_array_elements(p_records) AS r);

  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || p_month));

  SELECT COUNT(*) INTO v_foreign_employee_count
  FROM unnest(v_employee_ids) AS eid
  WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = eid AND e.tenant_id = v_tenant_id);

  IF v_foreign_employee_count > 0 THEN
    RAISE EXCEPTION 'Refusing to process: % of the supplied employee(s) do not belong to your tenant', v_foreign_employee_count;
  END IF;

  SELECT COUNT(*) INTO v_ineligible_count
  FROM employees e
  WHERE e.id = ANY(v_employee_ids) AND (e.is_deleted OR e.status NOT IN ('Active', 'On Leave'));

  IF v_ineligible_count > 0 THEN
    RAISE EXCEPTION 'Refusing to process: % of the supplied employee(s) are soft-deleted or not in a payable status (Active or On Leave) -- remove them from this batch', v_ineligible_count;
  END IF;

  IF NOT (v_is_super_admin OR is_business_admin()) THEN
    SELECT COUNT(*) INTO v_out_of_region_count
    FROM employees e WHERE e.id = ANY(v_employee_ids) AND NOT region_allowed(e.region_id);

    IF v_out_of_region_count > 0 THEN
      RAISE EXCEPTION 'Refusing to process: % of the supplied employee(s) are outside your assigned region', v_out_of_region_count;
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_approved_count
  FROM payroll
  WHERE month = p_month AND tenant_id = v_tenant_id AND employee_id = ANY(v_employee_ids) AND approval_status = 'approved';

  IF v_approved_count > 0 THEN
    RAISE EXCEPTION 'Cannot reprocess %: % of the targeted employees already have approved payroll for this month. Reject the existing approval first.', p_month, v_approved_count;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::JSONB) INTO v_old_rows
  FROM payroll p WHERE p.month = p_month AND p.tenant_id = v_tenant_id AND p.employee_id = ANY(v_employee_ids);

  DELETE FROM payroll WHERE month = p_month AND tenant_id = v_tenant_id AND employee_id = ANY(v_employee_ids);
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  FOR v_record IN SELECT * FROM jsonb_array_elements(p_records)
  LOOP
    v_employee_id := (v_record->>'employee_id')::UUID;
    v_base_net_pay := ROUND((v_record->>'net_pay')::NUMERIC, 2);
    v_advance_deduction := 0;

    v_gross_pay := ROUND((v_record->>'gross_pay')::NUMERIC, 2);
    v_submitted_paye := ROUND(COALESCE((v_record->>'paye')::NUMERIC, 0), 2);
    v_submitted_pension := ROUND(COALESCE((v_record->>'pension')::NUMERIC, 0), 2);
    v_expected_paye := ROUND(GREATEST(v_gross_pay - v_paye_threshold, 0) * v_paye_rate);
    v_expected_pension := ROUND(v_gross_pay * v_pension_rate);

    IF ABS(v_submitted_paye - v_expected_paye) > 1 THEN
      RAISE EXCEPTION 'Refusing to process payroll for employee %: submitted PAYE (%) does not match the amount computed from this tenant''s configured PAYE rate for gross pay % (expected %) -- nothing has been applied and the transaction has been rolled back. This may indicate a forged, stale, or miscalculated submission.',
        v_employee_id, v_submitted_paye, v_gross_pay, v_expected_paye;
    END IF;

    IF ABS(v_submitted_pension - v_expected_pension) > 1 THEN
      RAISE EXCEPTION 'Refusing to process payroll for employee %: submitted pension (%) does not match the amount computed from this tenant''s configured pension rate for gross pay % (expected %) -- nothing has been applied and the transaction has been rolled back. This may indicate a forged, stale, or miscalculated submission.',
        v_employee_id, v_submitted_pension, v_gross_pay, v_expected_pension;
    END IF;

    SELECT combined_monthly_deduction INTO v_pool_remaining FROM salary_advance_repayment_plans WHERE employee_id = v_employee_id;
    v_pool_remaining := COALESCE(v_pool_remaining, 0);

    FOR v_pool_advance IN
      SELECT sa.id, sa.advance_amount, sa.status
      FROM salary_advances sa
      WHERE sa.employee_id = v_employee_id AND sa.tenant_id = v_tenant_id
        AND (
          (sa.status = 'active' AND sa.deduction_start_month <= p_month)
          OR EXISTS (SELECT 1 FROM salary_advance_deductions sad WHERE sad.salary_advance_id = sa.id AND sad.payroll_month = p_month)
        )
      ORDER BY sa.application_date ASC, sa.created_at ASC, sa.id ASC
    LOOP
      SELECT deduction_amount INTO v_existing_ledger_amount
      FROM salary_advance_deductions WHERE salary_advance_id = v_pool_advance.id AND payroll_month = p_month;

      IF v_existing_ledger_amount IS NOT NULL THEN
        v_alloc := v_existing_ledger_amount;
      ELSE
        SELECT v_pool_advance.advance_amount - COALESCE(SUM(sad.deduction_amount), 0) INTO v_remaining_balance
        FROM salary_advance_deductions sad WHERE sad.salary_advance_id = v_pool_advance.id;

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

    SELECT COALESCE(amount, 0) INTO v_refund_amount
    FROM payroll_refund_drafts
    WHERE tenant_id = v_tenant_id AND employee_id = v_employee_id AND month = p_month AND status <> 'cancelled';
    v_refund_amount := COALESCE(v_refund_amount, 0);

    IF (v_base_net_pay - v_advance_deduction + v_refund_amount) < 0 THEN
      RAISE EXCEPTION 'Refusing to process payroll for employee %: this would produce a negative net pay of % (net pay % minus a salary advance deduction of % plus a refund of %). Final payroll net pay must never be negative -- resolve this before processing -- nothing has been applied and the transaction has been rolled back.',
        v_employee_id, (v_base_net_pay - v_advance_deduction + v_refund_amount), v_base_net_pay, v_advance_deduction, v_refund_amount;
    END IF;

    DELETE FROM salary_advance_repayment_plans
    WHERE employee_id = v_employee_id
      AND NOT EXISTS (SELECT 1 FROM salary_advances WHERE employee_id = v_employee_id AND status = 'active');

    INSERT INTO payroll (
      tenant_id, employee_id, month, basic_salary, allowances, overtime, bonus,
      gross_pay, paye, pension, uniform_deduction, salary_advance_deduction, refund, net_pay,
      processed_at, approval_status, approved_by, approved_at, approval_notes, updated_at
    ) VALUES (
      v_tenant_id, v_employee_id, p_month,
      ROUND((v_record->>'basic_salary')::NUMERIC, 2),
      ROUND(COALESCE((v_record->>'allowances')::NUMERIC, 0), 2),
      ROUND(COALESCE((v_record->>'overtime')::NUMERIC, 0), 2),
      ROUND(COALESCE((v_record->>'bonus')::NUMERIC, 0), 2),
      v_gross_pay, v_submitted_paye, v_submitted_pension,
      ROUND(COALESCE((v_record->>'uniform_deduction')::NUMERIC, 0), 2),
      v_advance_deduction, v_refund_amount,
      v_base_net_pay - v_advance_deduction + v_refund_amount,
      NOW(), 'pending', NULL, NULL, NULL, NOW()
    )
    RETURNING id INTO v_new_payroll_id;

    -- ===== NEW (this migration): guarantee an itemizable snapshot exists
    -- for this employee/month going forward =====
    -- All-zero unless/until HR enters real figures via Attendance.tsx --
    -- DO NOTHING on conflict means an HR-entered row (before or after this
    -- processing run) is never overwritten by this default. This is the
    -- ONLY new statement in this function; every line above and below it
    -- is unchanged from the current production definition.
    INSERT INTO employee_deductions (tenant_id, employee_id, month)
    VALUES (v_tenant_id, v_employee_id, p_month)
    ON CONFLICT (employee_id, month) DO NOTHING;

    IF v_refund_amount > 0 THEN
      UPDATE payroll_refund_drafts
      SET status = 'applied', applied_payroll_id = v_new_payroll_id, applied_at = NOW()
      WHERE tenant_id = v_tenant_id AND employee_id = v_employee_id AND month = p_month;
    END IF;
  END LOOP;

  v_inserted_count := jsonb_array_length(p_records);

  INSERT INTO audit_logs (
    tenant_id, user_id, user_email, user_role, region_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    v_tenant_id, v_caller_id, p_user_email,
    CASE WHEN v_is_super_admin THEN 'super_admin' ELSE 'admin' END, NULL, 'CREATE', 'payroll', NULL,
    jsonb_build_object('deletedCount', v_deleted_count, 'deletedRows', v_old_rows),
    p_audit_context || jsonb_build_object(
      'month', p_month, 'employeeCount', array_length(v_employee_ids, 1),
      'recordsSaved', v_inserted_count, 'salaryAdvanceDeductionsApplied', v_advance_deductions_applied,
      'status', 'pending_approval'
    )
  );

  RETURN jsonb_build_object(
    'success', true, 'month', p_month, 'deletedCount', v_deleted_count,
    'insertedCount', v_inserted_count, 'advanceDeductionsApplied', v_advance_deductions_applied
  );
END;
$function$;
