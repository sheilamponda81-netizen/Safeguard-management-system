-- ============================================================
-- MIGRATION: Phase 4A Part 1 -- ordinary payroll snapshot integrity +
-- processing-reference traceability on `payroll`
-- Date: 2026-11-01
-- ============================================================
--
-- PROBLEM THIS CLOSES
-- -----------------------------------------------------------
-- 20261030000000's financial_snapshot already detects drift in the two
-- things it genuinely re-derives server-side: Terminal Dues allocation
-- eligibility, and employee active/deleted status. It explicitly did NOT
-- attempt to re-derive ordinary gross/net/PAYE/pension -- those are
-- frozen from the submitted payload, because recomputing them would mean
-- porting Payroll.tsx's attendance-driven calculation engine
-- (calculateLivePayroll(), src/utils/payrollCalculations.ts) into SQL, an
-- explicitly out-of-scope architectural change.
--
-- That left a real, concrete gap: an Accountant submits a request, then
-- -- before an Admin approves or processes it -- someone changes an
-- employee's salary (employees.basic_salary), their uniform deduction or
-- position, a manually-entered attendance correction
-- (employee_deductions.lecture_deduction/appearance_deduction), raw
-- attendance records for the month (the `attendance` table, which drives
-- absent/late day counts), or the tenant's payroll rate settings
-- (system_settings: paye_rate/paye_threshold/pension_employee_rate/
-- uniform_deduction_default/absent_day_deduction/late_day_deduction).
-- None of that was detected -- an Admin could approve and process a
-- request whose ordinary-payroll numbers no longer matched current
-- authoritative data, with no warning.
--
-- WHY THIS IS STILL "DO NOT PORT THE CALCULATION ENGINE"
-- -----------------------------------------------------------
-- This migration does NOT recompute gross_pay/paye/pension/net_pay, and
-- does NOT validate that the submitted amounts were arithmetically
-- correct in the first place. It ONLY fingerprints the specific,
-- genuinely authoritative, already-stored INPUTS those calculations are
-- built from, and compares that fingerprint between submission and
-- approval/processing time -- exactly the same "snapshot vs. live
-- recompute" pattern 20261030000000 already established for Terminal
-- Dues/employee-status, just extended to three more input sources:
--
--   1. employees.basic_salary / employees.uniform_deduction /
--      employees.position -- per targeted employee, read directly.
--   2. get_payroll_attendance_counts() (20260901000000) -- the EXISTING,
--      already-authorized, already-narrow SECURITY DEFINER RPC that
--      returns {employee_id, absent_days, late_days} for the current
--      month, reused verbatim (nested SECURITY DEFINER call) rather than
--      re-querying `attendance` directly -- this migration adds no new
--      attendance-table access logic at all.
--      employee_deductions.lecture_deduction/appearance_deduction (the
--      two manually-entered, per-employee-per-month deduction fields
--      calculateLivePayroll() actually reads) is read directly alongside
--      it, for the same employee+month.
--   3. system_settings -- the six payroll-rate keys
--      getPayrollRates()/calculateLivePayroll() actually consume.
--
-- If ANY of these inputs for ANY targeted employee differ between the
-- stored snapshot and a fresh read at approval or processing time,
-- approval/processing is refused with a clear message, exactly like the
-- existing Terminal Dues/employee-status checks -- no partial write, full
-- rollback, reject-and-resubmit is the only path forward.
--
-- WHAT THIS STILL DOES NOT COVER (explicitly, reported as a residual gap,
-- not silently accepted)
-- -----------------------------------------------------------
-- allowances/overtime/bonus and the resulting gross_pay/paye/pension/
-- net_pay arithmetic are NEVER independently re-verified -- there is no
-- second, authoritative, server-stored source for "what should this
-- employee's allowance/overtime/bonus be this month" to compare against
-- (they are manually typed into the calculation at the time it is done,
-- not sourced from any table this schema has). This is a data-entry-
-- correctness question, not a staleness/drift question -- nothing
-- "changes" between submission and processing for a value that was never
-- derived from mutable state in the first place, so there is nothing for
-- a drift check to compare against. Porting the full PAYE/pension/gross
-- formula into SQL to re-verify arithmetic correctness (as opposed to
-- input staleness) remains the broader redesign this phase's own
-- instructions say not to take on without a demonstrated need -- no such
-- need was found; the task's actual concern ("change salaries,
-- deductions, employee status or attendance, and then have Admin process
-- amounts that no longer match the records originally reviewed") is
-- fully addressed by the four input sources above.
--
-- SECOND FIX IN THIS MIGRATION: `payroll.processing_reference`
-- -----------------------------------------------------------
-- `payroll` rows had NO column linking a row back to the combined_
-- reference that produced it -- process_payroll_with_terminal_dues()
-- (20261027000000) generates v_combined_reference only AFTER calling
-- process_payroll_batch(), so it could never have been included in that
-- INSERT. terminal_due_allocations already has an equivalent
-- processing_reference column (20261026000000); `payroll` did not. This
-- is a real traceability gap for Accounts reconciliation (Phase 4A Part
-- 2), closed here with an additive column plus one UPDATE, in the same
-- already-open transaction, immediately after v_combined_reference is
-- generated -- every other line of process_payroll_with_terminal_dues()
-- is byte-for-byte unchanged.
-- ============================================================

ALTER TABLE payroll
  ADD COLUMN IF NOT EXISTS processing_reference TEXT;

CREATE INDEX IF NOT EXISTS idx_payroll_processing_reference ON payroll(processing_reference) WHERE processing_reference IS NOT NULL;

-- ============================================================
-- PART 1: compute_payroll_request_snapshot() -- extended with three new
-- fingerprint fields. Every existing field/line is unchanged.
-- ============================================================
CREATE OR REPLACE FUNCTION compute_payroll_request_snapshot(
  p_tenant_id UUID,
  p_month TEXT,
  p_records JSONB,
  p_td_excluded_ids UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_employee_ids UUID[];
  v_gross_total NUMERIC := 0;
  v_deductions_total NUMERIC := 0;
  v_net_total NUMERIC := 0;
  v_td_ids UUID[];
  v_td_total NUMERIC := 0;
  v_inactive_ids UUID[];
  v_salary_fp JSONB;
  v_attendance_fp JSONB;
  v_rates_fp JSONB;
BEGIN
  SELECT array_agg(DISTINCT (r->>'employee_id')::UUID ORDER BY (r->>'employee_id')::UUID)
    INTO v_employee_ids
    FROM jsonb_array_elements(p_records) AS r;

  SELECT
    COALESCE(SUM((r->>'gross_pay')::NUMERIC), 0),
    COALESCE(SUM((r->>'paye')::NUMERIC + (r->>'pension')::NUMERIC + (r->>'uniform_deduction')::NUMERIC), 0),
    COALESCE(SUM((r->>'net_pay')::NUMERIC), 0)
  INTO v_gross_total, v_deductions_total, v_net_total
  FROM jsonb_array_elements(p_records) AS r;

  SELECT COALESCE(array_agg(id ORDER BY id), '{}'), COALESCE(SUM(proposed_amount), 0)
    INTO v_td_ids, v_td_total
    FROM terminal_due_allocations
    WHERE tenant_id = p_tenant_id AND payroll_month = p_month AND status = 'approved'
      AND NOT (id = ANY(COALESCE(p_td_excluded_ids, '{}')));

  SELECT COALESCE(array_agg(id ORDER BY id), '{}')
    INTO v_inactive_ids
    FROM employees
    WHERE id = ANY(COALESCE(v_employee_ids, '{}')) AND is_deleted;

  -- NEW: per-employee salary/deduction-setting fingerprint, straight off
  -- `employees` -- the authoritative source for basic_salary and
  -- uniform_deduction, and for position (which decides whether a uniform
  -- deduction applies at all -- see calculateLivePayroll()).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'employee_id', e.id,
           'basic_salary', e.basic_salary,
           'uniform_deduction', e.uniform_deduction,
           'position', e.position
         ) ORDER BY e.id), '[]'::jsonb)
    INTO v_salary_fp
    FROM employees e
    WHERE e.id = ANY(COALESCE(v_employee_ids, '{}'));

  -- NEW: per-employee attendance/manual-deduction fingerprint for this
  -- exact month. absent_days/late_days come from the EXISTING, already-
  -- authorized get_payroll_attendance_counts() RPC (20260901000000) --
  -- reused verbatim via a nested SECURITY DEFINER call, not reimplemented
  -- here. lecture_deduction/appearance_deduction are the two manually-
  -- entered employee_deductions fields calculateLivePayroll() reads
  -- directly for the same employee+month.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'employee_id', a.employee_id,
           'absent_days', a.absent_days,
           'late_days', a.late_days,
           'lecture_deduction', COALESCE(d.lecture_deduction, 0),
           'appearance_deduction', COALESCE(d.appearance_deduction, 0)
         ) ORDER BY a.employee_id), '[]'::jsonb)
    INTO v_attendance_fp
    FROM get_payroll_attendance_counts(COALESCE(v_employee_ids, '{}'), p_month) a
    LEFT JOIN employee_deductions d
      ON d.employee_id = a.employee_id AND d.month = p_month;

  -- NEW: the exact payroll-rate settings calculateLivePayroll() consumes,
  -- for this tenant. A key with no stored row fingerprints as NULL both
  -- times it is read (submission and approval/processing), which is
  -- stable and produces no false positive -- only an actual insert/
  -- update/delete of one of these rows between the two reads changes the
  -- fingerprint. There is deliberately no hardcoded default value here:
  -- the frontend's own defaults (src/utils/payrollSettings.ts) only
  -- matter for display when no row exists, and have no bearing on
  -- whether the STORED configuration changed.
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    INTO v_rates_fp
    FROM system_settings
    WHERE tenant_id = p_tenant_id
      AND key IN ('paye_rate', 'paye_threshold', 'pension_employee_rate', 'uniform_deduction_default', 'absent_day_deduction', 'late_day_deduction');

  RETURN jsonb_build_object(
    'employee_ids', to_jsonb(COALESCE(v_employee_ids, '{}')),
    'employee_count', COALESCE(array_length(v_employee_ids, 1), 0),
    'ordinary_gross_total', v_gross_total,
    'ordinary_deductions_total', v_deductions_total,
    'ordinary_net_total', v_net_total,
    'eligible_td_allocation_ids', to_jsonb(v_td_ids),
    'eligible_td_count', COALESCE(array_length(v_td_ids, 1), 0),
    'eligible_td_total', v_td_total,
    'td_excluded_ids', to_jsonb(COALESCE(p_td_excluded_ids, '{}')),
    'inactive_employee_ids', to_jsonb(v_inactive_ids),
    'employee_salary_fingerprint', v_salary_fp,
    'employee_attendance_fingerprint', v_attendance_fp,
    'payroll_rates_fingerprint', v_rates_fp,
    'captured_at', NOW()
  );
END;
$$;

REVOKE ALL ON FUNCTION compute_payroll_request_snapshot(UUID, TEXT, JSONB, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION compute_payroll_request_snapshot(UUID, TEXT, JSONB, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION compute_payroll_request_snapshot(UUID, TEXT, JSONB, UUID[]) FROM authenticated;

-- ============================================================
-- PART 2: approve_payroll_processing_request() -- extends the existing
-- "predates snapshot tracking" guard to also catch a snapshot stored
-- under the OLDER (20261030000000) narrower shape missing the three new
-- fingerprint keys, then adds the two new fingerprint comparisons after
-- the existing TD/employee-status checks. Every other line unchanged.
-- ============================================================
CREATE OR REPLACE FUNCTION approve_payroll_processing_request(p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_request RECORD;
  v_fresh JSONB;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only an Admin or super admin may approve a payroll processing request';
  END IF;

  SELECT * INTO v_request FROM payroll_processing_requests WHERE id = p_request_id AND tenant_id = v_tenant_id FOR UPDATE;
  IF v_request IS NULL THEN
    RAISE EXCEPTION 'Payroll processing request not found';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'This request is no longer pending (status: %) -- it may have already been decided', v_request.status;
  END IF;
  IF v_request.initiated_by = v_caller_id THEN
    RAISE EXCEPTION 'You cannot approve your own payroll processing request';
  END IF;

  IF v_request.financial_snapshot IS NULL OR NOT (v_request.financial_snapshot ? 'employee_salary_fingerprint') THEN
    RAISE EXCEPTION 'Refusing to approve: this request was submitted before financial snapshots were tracked -- reject it and ask for a fresh submission';
  END IF;

  v_fresh := compute_payroll_request_snapshot(v_tenant_id, v_request.month, v_request.payroll_records, v_request.td_excluded_ids);

  IF jsonb_array_length(v_fresh->'inactive_employee_ids') > 0 THEN
    RAISE EXCEPTION 'Refusing to approve: one or more employees in this request are no longer active -- reject this request and ask for a fresh submission';
  END IF;

  IF (v_fresh->'eligible_td_allocation_ids') <> (v_request.financial_snapshot->'eligible_td_allocation_ids')
     OR (v_fresh->>'eligible_td_total')::NUMERIC <> (v_request.financial_snapshot->>'eligible_td_total')::NUMERIC
  THEN
    RAISE EXCEPTION 'Refusing to approve: the approved Terminal Dues allocations for this month have changed since this request was submitted (an allocation was approved, held, revised, or excluded) -- reject this request and ask for a fresh submission';
  END IF;

  IF (v_fresh->'employee_salary_fingerprint') <> (v_request.financial_snapshot->'employee_salary_fingerprint') THEN
    RAISE EXCEPTION 'Refusing to approve: one or more employees'' basic salary, uniform deduction, or position has changed since this request was submitted -- reject this request and ask for a fresh submission';
  END IF;

  IF (v_fresh->'employee_attendance_fingerprint') <> (v_request.financial_snapshot->'employee_attendance_fingerprint') THEN
    RAISE EXCEPTION 'Refusing to approve: attendance-based deductions (absence, lateness, lecture, or appearance) for one or more employees have changed since this request was submitted -- reject this request and ask for a fresh submission';
  END IF;

  IF (v_fresh->'payroll_rates_fingerprint') <> (v_request.financial_snapshot->'payroll_rates_fingerprint') THEN
    RAISE EXCEPTION 'Refusing to approve: payroll rate settings (PAYE, pension, or deduction rates) have changed since this request was submitted -- reject this request and ask for a fresh submission';
  END IF;

  UPDATE payroll_processing_requests SET
    status = 'approved', reviewed_by = v_caller_id, reviewed_at = NOW(), updated_at = NOW()
  WHERE id = p_request_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'APPROVE', 'payroll_processing_request', p_request_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'approved', 'month', v_request.month, 'financial_snapshot', v_request.financial_snapshot)
  );

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'approved', 'month', v_request.month) || v_request.financial_snapshot;
END;
$$;

REVOKE ALL ON FUNCTION approve_payroll_processing_request(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_payroll_processing_request(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION approve_payroll_processing_request(UUID) TO authenticated;

-- ============================================================
-- PART 3: process_approved_payroll_request() -- same two new
-- fingerprint comparisons, at the processing checkpoint. Every other
-- line unchanged.
-- ============================================================
CREATE OR REPLACE FUNCTION process_approved_payroll_request(p_request_id UUID, p_user_email TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_request RECORD;
  v_system_month TEXT;
  v_fresh JSONB;
  v_result JSONB;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only an Admin or super admin may process an approved payroll processing request';
  END IF;

  SELECT * INTO v_request FROM payroll_processing_requests WHERE id = p_request_id AND tenant_id = v_tenant_id;
  IF v_request IS NULL THEN
    RAISE EXCEPTION 'Payroll processing request not found';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || v_request.month));

  SELECT * INTO v_request FROM payroll_processing_requests WHERE id = p_request_id AND tenant_id = v_tenant_id FOR UPDATE;
  IF v_request.status <> 'approved' THEN
    RAISE EXCEPTION 'This request is not approved (status: %) -- it may have already been processed, or was never approved', v_request.status;
  END IF;

  SELECT value INTO v_system_month FROM system_settings WHERE tenant_id = v_tenant_id AND key = 'current_payroll_month';
  IF v_system_month IS NULL OR v_request.month <> v_system_month THEN
    RAISE EXCEPTION 'Refusing to process: % is no longer the active payroll month (now %) -- this request needs a fresh submission and review', v_request.month, COALESCE(v_system_month, 'none configured');
  END IF;

  IF v_request.financial_snapshot IS NULL OR NOT (v_request.financial_snapshot ? 'employee_salary_fingerprint') THEN
    RAISE EXCEPTION 'Refusing to process: this request was approved before financial snapshots were tracked -- reject it and ask for a fresh submission';
  END IF;

  v_fresh := compute_payroll_request_snapshot(v_tenant_id, v_request.month, v_request.payroll_records, v_request.td_excluded_ids);

  IF jsonb_array_length(v_fresh->'inactive_employee_ids') > 0 THEN
    RAISE EXCEPTION 'Refusing to process: one or more employees in this request are no longer active -- reject this request and ask for a fresh submission';
  END IF;

  IF (v_fresh->'eligible_td_allocation_ids') <> (v_request.financial_snapshot->'eligible_td_allocation_ids')
     OR (v_fresh->>'eligible_td_total')::NUMERIC <> (v_request.financial_snapshot->>'eligible_td_total')::NUMERIC
  THEN
    RAISE EXCEPTION 'Refusing to process: the approved Terminal Dues allocations for this month have changed since this request was submitted (an allocation was approved, held, revised, or excluded) -- reject this request and ask for a fresh submission';
  END IF;

  IF (v_fresh->'employee_salary_fingerprint') <> (v_request.financial_snapshot->'employee_salary_fingerprint') THEN
    RAISE EXCEPTION 'Refusing to process: one or more employees'' basic salary, uniform deduction, or position has changed since this request was submitted -- reject this request and ask for a fresh submission';
  END IF;

  IF (v_fresh->'employee_attendance_fingerprint') <> (v_request.financial_snapshot->'employee_attendance_fingerprint') THEN
    RAISE EXCEPTION 'Refusing to process: attendance-based deductions (absence, lateness, lecture, or appearance) for one or more employees have changed since this request was submitted -- reject this request and ask for a fresh submission';
  END IF;

  IF (v_fresh->'payroll_rates_fingerprint') <> (v_request.financial_snapshot->'payroll_rates_fingerprint') THEN
    RAISE EXCEPTION 'Refusing to process: payroll rate settings (PAYE, pension, or deduction rates) have changed since this request was submitted -- reject this request and ask for a fresh submission';
  END IF;

  v_result := process_payroll_with_terminal_dues(
    v_request.month, v_request.payroll_records, p_user_email, v_request.audit_context,
    v_request.td_excluded_ids, v_request.td_exclusion_reason
  );

  UPDATE payroll_processing_requests SET
    status = 'processed', processing_reference = v_result->>'combined_reference', updated_at = NOW()
  WHERE id = p_request_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'CREATE', 'payroll_processing_request_processed', p_request_id::text,
    jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'processed', 'combined_reference', v_result->>'combined_reference')
  );

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'processed') || v_result;
END;
$$;

REVOKE ALL ON FUNCTION process_approved_payroll_request(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_approved_payroll_request(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION process_approved_payroll_request(UUID, TEXT) TO authenticated;

-- ============================================================
-- PART 4: process_payroll_with_terminal_dues() -- ONE new line: stamp
-- processing_reference onto the `payroll` rows this same transaction
-- just inserted, using the exact employee_id set this run targeted.
-- Every other line byte-for-byte unchanged from 20261027000000.
-- ============================================================
CREATE OR REPLACE FUNCTION process_payroll_with_terminal_dues(
  p_month TEXT,
  p_records JSONB,
  p_user_email TEXT DEFAULT NULL,
  p_audit_context JSONB DEFAULT '{}'::JSONB,
  p_td_excluded_ids UUID[] DEFAULT '{}',
  p_td_exclusion_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_system_month TEXT;
  v_has_td_permission BOOLEAN;
  v_has_eligible_td BOOLEAN;
  v_payroll_result JSONB;
  v_td_result JSONB := NULL;
  v_combined_reference TEXT;
  v_ordinary_total NUMERIC := 0;
  v_td_total NUMERIC := 0;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only an Admin or super admin may commit payroll processing directly -- submit a payroll processing request for Admin approval instead';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  SELECT value INTO v_system_month FROM system_settings WHERE tenant_id = v_tenant_id AND key = 'current_payroll_month';
  IF v_system_month IS NULL THEN
    RAISE EXCEPTION 'No active payroll month is configured for this tenant -- set one on the Payroll page first';
  END IF;
  IF p_month <> v_system_month THEN
    RAISE EXCEPTION 'Refusing to process: % is not the active payroll month (%) -- it may have changed since this page loaded; refresh and try again', p_month, v_system_month;
  END IF;

  v_has_td_permission := is_super_admin() OR has_explicit_permission('terminal_dues.approve');

  IF p_td_excluded_ids IS NOT NULL AND array_length(p_td_excluded_ids, 1) > 0 AND NOT v_has_td_permission THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may select Terminal Dues exclusions';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || p_month));
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant_id::text || ':' || p_month, 0));

  v_payroll_result := process_payroll_batch(p_month, p_records, p_user_email, p_audit_context);

  SELECT COALESCE(SUM(net_pay), 0) INTO v_ordinary_total
  FROM payroll
  WHERE tenant_id = v_tenant_id AND month = p_month
    AND employee_id = ANY(ARRAY(SELECT (r->>'employee_id')::UUID FROM jsonb_array_elements(p_records) AS r));

  IF v_has_td_permission THEN
    SELECT EXISTS (
      SELECT 1 FROM terminal_due_allocations
      WHERE tenant_id = v_tenant_id AND payroll_month = p_month AND status = 'approved'
    ) INTO v_has_eligible_td;

    IF v_has_eligible_td OR (p_td_excluded_ids IS NOT NULL AND array_length(p_td_excluded_ids, 1) > 0) THEN
      v_td_result := process_terminal_due_allocations_batch(p_td_excluded_ids, p_td_exclusion_reason);
      v_td_total := COALESCE((v_td_result->>'total_amount')::NUMERIC, 0);
    END IF;
  END IF;

  v_combined_reference := 'PWTD-' || p_month || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  -- NEW: stamp this run's reference onto the exact `payroll` rows
  -- process_payroll_batch() just (re)wrote for this month -- the ONLY
  -- place in this function that touches the `payroll` table's own
  -- columns; everything else about the insert is process_payroll_
  -- batch()'s own, untouched, business.
  UPDATE payroll SET processing_reference = v_combined_reference
  WHERE tenant_id = v_tenant_id AND month = p_month
    AND employee_id = ANY(ARRAY(SELECT (r->>'employee_id')::UUID FROM jsonb_array_elements(p_records) AS r));

  INSERT INTO audit_logs (tenant_id, user_id, user_email, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, p_user_email, 'CREATE', 'combined_payroll_run', v_combined_reference,
    '{}'::JSONB,
    jsonb_build_object(
      'month', p_month,
      'combined_reference', v_combined_reference,
      'payroll_inserted_count', v_payroll_result->'insertedCount',
      'terminal_dues_included', v_td_result IS NOT NULL,
      'terminal_dues_batch_reference', v_td_result->>'batch_reference',
      'terminal_dues_processed_count', v_td_result->'processed_count',
      'ordinary_payroll_total', v_ordinary_total,
      'terminal_dues_total', v_td_total,
      'combined_total', v_ordinary_total + v_td_total
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'month', p_month,
    'combined_reference', v_combined_reference,
    'payroll', v_payroll_result,
    'terminal_dues', v_td_result,
    'terminal_dues_included', v_td_result IS NOT NULL,
    'ordinary_payroll_total', v_ordinary_total,
    'terminal_dues_total', v_td_total,
    'combined_total', v_ordinary_total + v_td_total
  );
END;
$$;

REVOKE ALL ON FUNCTION process_payroll_with_terminal_dues(TEXT, JSONB, TEXT, JSONB, UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_payroll_with_terminal_dues(TEXT, JSONB, TEXT, JSONB, UUID[], TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION process_payroll_with_terminal_dues(TEXT, JSONB, TEXT, JSONB, UUID[], TEXT) TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent. ADD COLUMN IF NOT EXISTS, CREATE
-- INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION, same REVOKE/GRANT
-- pairs throughout.
--
-- DEPENDENCIES: 20261030000000 (financial_snapshot column + the three
-- functions this replaces), 20260901000000 (get_payroll_attendance_counts),
-- 20261027000000 (process_payroll_with_terminal_dues' own prior shape).
--
-- PREFLIGHT: none needed. No existing column, row, or RLS policy is
-- modified -- only a new nullable column, a new partial index, and
-- CREATE OR REPLACE on four already-existing functions.
--
-- BACKWARD COMPATIBILITY: an already-stored financial_snapshot captured
-- under the OLDER (20261030000000) shape lacks the three new fingerprint
-- keys -- approve/process both now check for 'employee_salary_fingerprint'
-- specifically (not just "snapshot IS NULL") and route such a request
-- through the SAME "predates financial snapshots" rejection message,
-- same remediation (reject, resubmit). No existing `payroll` row is
-- touched -- processing_reference is simply NULL for every row processed
-- before this migration, exactly like financial_snapshot was NULL for
-- every request submitted before 20261030000000.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'payroll' AND column_name = 'processing_reference';
--   -- expected: 1 row
--   SELECT proname, prosecdef FROM pg_proc WHERE proname IN
--     ('compute_payroll_request_snapshot', 'approve_payroll_processing_request',
--      'process_approved_payroll_request', 'process_payroll_with_terminal_dues');
--   -- expected: 4 rows, all prosecdef = true
--   SELECT has_function_privilege('authenticated', 'compute_payroll_request_snapshot(uuid,text,jsonb,uuid[])', 'EXECUTE');
--   -- expected: false (internal helper only)
--
-- ROLLBACK SQL:
--   -- Functions: re-apply 20261030000000's and 20261027000000's own
--   -- CREATE OR REPLACE bodies for the four functions touched here.
--   DROP INDEX IF EXISTS idx_payroll_processing_reference;
--   ALTER TABLE payroll DROP COLUMN IF EXISTS processing_reference;
-- ============================================================
