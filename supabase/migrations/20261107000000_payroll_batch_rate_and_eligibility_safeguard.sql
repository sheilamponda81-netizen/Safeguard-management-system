-- ============================================================
-- MIGRATION: Server-side PAYE/pension rate verification and employee
-- eligibility safeguard for process_payroll_batch()
-- Date: 2026-11-07
-- ============================================================
--
-- EXACT VULNERABILITIES THIS CLOSES (confirmed by reading the final,
-- live CREATE OR REPLACE body of process_payroll_batch() in
-- 20260817000003_functional_roles_rpc_authorization.sql -- the chronologically
-- last redefinition of this function before this migration -- and the
-- commit-path chain process_payroll_with_terminal_dues() ->
-- process_payroll_batch() and submit_payroll_processing_request() ->
-- approve_payroll_processing_request() -> process_approved_payroll_request()
-- -> process_payroll_with_terminal_dues() -> process_payroll_batch()):
--
-- VULNERABILITY 1 -- PAYE/pension rate bypass. process_payroll_batch()
-- validates every monetary field's FORMAT (numeric, non-negative) and,
-- as of 20261102000000, that gross_pay/net_pay are internally SELF-
-- consistent with the record's own other stated fields -- but nothing
-- anywhere checks that the submitted paye/pension were actually derived
-- from this tenant's CONFIGURED paye_rate/paye_threshold/
-- pension_employee_rate. A client (a forged RPC call, a tampered browser
-- session, or simply a bug) could submit internally-consistent figures
-- built from any rate it chooses -- e.g. paye computed at a fictitious
-- 30% while the tenant has deliberately configured paye_rate=0 pending
-- Accountant sign-off -- and it would be accepted, stored, and (if
-- caught before approval) even survive the existing snapshot-freshness
-- re-check in 20261101000000, which only verifies the CONFIGURATION
-- itself hasn't drifted since submission, never that the submitted
-- figures were correctly DERIVED from it.
--
-- VULNERABILITY 2 -- employee eligibility bypass. process_payroll_batch()
-- validates that every supplied employee_id belongs to the caller's own
-- tenant and (region_allowed()) region, but never checks employees.status
-- or employees.is_deleted. A client could submit a payroll record for a
-- Terminated, Suspended, or soft-deleted employee and it would be
-- accepted -- there is no server-side enforcement of the
-- PAYABLE_EMPLOYEE_STATUSES (Active, On Leave) whitelist
-- src/utils/employeeStatus.ts documents as the business rule; only the
-- CLIENT's own roster query filters by it today.
--
-- VERIFIED FORMULAS (src/utils/payrollCalculations.ts calculateLivePayroll(),
-- read in full before writing this migration -- not invented):
--   grossPay = basicSalary + allowances + overtime + bonus
--   paye     = Math.round( Math.max(0, grossPay - payeThreshold) * payeRate )
--   pension  = Math.round( grossPay * pensionEmployeeRate )
--   netPay   = grossPay - paye - pension - totalUniformDeduction   (PRE
--              salary-advance, matching 20261102000000's own documented
--              convention and this function's own v_base_net_pay/
--              v_advance_deduction split below)
-- JavaScript's Math.round() rounds to the nearest INTEGER (0 decimal
-- places), not 2 -- replicated below with Postgres's single-argument
-- ROUND(numeric), which has the same "round half away from zero to the
-- nearest integer" behavior for the non-negative values in play here
-- (gross_pay, rates, and thresholds are already format-validated as
-- non-negative above this point in the function).
--
-- THE FIX, DELIBERATELY NARROW (same "do not port the calculation engine"
-- discipline 20261030000000/20261101000000/20261102000000 each already
-- established and explain in their own headers):
--   1. PAYE/pension verification needs ONLY gross_pay (already present
--      and already format/consistency-validated) and the tenant's own
--      configured rate -- no attendance, uniform, or allowance/overtime/
--      bonus data-entry logic is replicated. This is the "smallest
--      server-side remedy" identified during this hotfix's own release-
--      gate review.
--   2. Eligibility verification is a single, tenant-scoped SELECT against
--      `employees` -- the exact same shape as the existing tenant/region
--      checks a few lines above it -- requiring no new table, no new
--      column, no new RPC.
-- Employee eligibility and PAYE/pension are independent concerns from the
-- rest of this function's unchanged logic (authorization, payload
-- validation, concurrency, approved-month protection, salary-advance
-- pooled allocation, audit logging) -- all of that is preserved
-- byte-for-byte below.
--
-- FAIL-CLOSED ON MISSING/INVALID CONFIGURATION: if paye_rate,
-- paye_threshold, or pension_employee_rate has no row at all for this
-- tenant, or its value is not a valid number, this function now REFUSES
-- to process ANY payroll for that tenant -- it does not substitute a
-- guessed statutory default (mirroring the identical, deliberate decision
-- already made client-side in getPayrollRatesStrict(), payrollSettings.ts,
-- during this hotfix's prior round). An EXPLICIT 0 is a valid configured
-- value and is read and applied exactly as configured -- this is not
-- "missing", and is the tenant's actual current, intentional
-- configuration per the business owner's own directive.
--
-- WHY THIS CANNOT BE BYPASSED CLIENT-SIDE: process_payroll_batch() is
-- SECURITY DEFINER and is the ONLY function (besides the already-REVOKEd,
-- directly-inaccessible process_payroll_batch() callers) that ever writes
-- to `payroll` -- both commit paths (Admin-direct via
-- process_payroll_with_terminal_dues(), and the Accountant-submitted-then-
-- approved path via process_approved_payroll_request()) funnel through
-- this exact function, so a single check here protects both, and nothing
-- the client sends (p_records' own paye/pension fields) can skip it --
-- the check runs unconditionally on the SERVER, reading the rate from
-- `system_settings` itself, never from the request payload.
--
-- WHAT THIS DOES NOT CHANGE: gross_pay's own attendance/uniform/
-- allowance/overtime/bonus arithmetic remains exactly as un-reverified as
-- it already was (the same, already-reported, already-accepted residual
-- gap 20261101000000/20261102000000 each explicitly document -- no second
-- authoritative source exists for manually-entered allowance/overtime/
-- bonus to compare against, so there is nothing new to check there). No
-- existing approved or historical payroll row is read, recalculated, or
-- modified by this migration -- it only gates a NEW INSERT for the month
-- currently being processed, exactly like every other check already in
-- this function.
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
  v_ineligible_count INTEGER;
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
  -- NEW: PAYE/pension rate verification variables
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
  -- RELEASE-BLOCKING FIX (2026-09-10, production preflight): v_role_level
  -- is NULL for every functional-role account (by design). A bare
  -- `v_role_level = 1` comparison against NULL evaluates to SQL NULL, not
  -- false, which makes the whole `IF NOT (...)` condition NULL for a
  -- functional-role caller who also lacks has_permission('payroll.process')
  -- -- and PL/pgSQL treats a NULL IF condition the same as false, silently
  -- skipping the RAISE EXCEPTION below instead of rejecting the caller.
  -- Wrapped in COALESCE(..., false) so the comparison is always a real
  -- boolean, closing that bypass without changing behavior for any legacy
  -- account (whose role_level is never NULL) or any functional account
  -- that legitimately holds payroll.process.
  IF NOT (v_is_super_admin OR COALESCE(v_role_level = 1, false) OR has_permission('payroll.process')) THEN
    RAISE EXCEPTION 'Only Admins or super admins may process payroll';
  END IF;

  IF p_records IS NULL OR jsonb_array_length(p_records) = 0 THEN
    RAISE EXCEPTION 'No payroll records supplied';
  END IF;

  -- ============================================================
  -- STEP 1.4 (NEW): PAYE/pension rate configuration -- fail closed.
  -- Tenant-level precondition, independent of p_records, so it runs
  -- before the payload is even inspected: no point validating a forged
  -- or stale submission's numbers against a rate this tenant hasn't
  -- actually configured yet.
  -- ============================================================
  SELECT
    MAX(CASE WHEN key = 'paye_rate' THEN value END),
    MAX(CASE WHEN key = 'paye_threshold' THEN value END),
    MAX(CASE WHEN key = 'pension_employee_rate' THEN value END)
  INTO v_paye_rate_raw, v_paye_threshold_raw, v_pension_rate_raw
  FROM system_settings
  WHERE tenant_id = v_tenant_id
    AND key IN ('paye_rate', 'paye_threshold', 'pension_employee_rate');

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
  -- STEP 3: Validate BEFORE any destructive change (unchanged tenant and
  -- region checks, plus a NEW eligibility check).
  -- ============================================================
  SELECT COUNT(*) INTO v_foreign_employee_count
  FROM unnest(v_employee_ids) AS eid
  WHERE NOT EXISTS (
    SELECT 1 FROM employees e WHERE e.id = eid AND e.tenant_id = v_tenant_id
  );

  IF v_foreign_employee_count > 0 THEN
    RAISE EXCEPTION 'Refusing to process: % of the supplied employee(s) do not belong to your tenant', v_foreign_employee_count;
  END IF;

  -- NEW: employee eligibility, read from DATABASE STATE (never from the
  -- client-submitted payload, which carries no status field at all).
  -- Matches PAYABLE_EMPLOYEE_STATUSES (src/utils/employeeStatus.ts) --
  -- Active or On Leave, and not soft-deleted. Terminal Dues / final
  -- settlement processing is a completely separate table
  -- (terminal_due_allocations) and RPC
  -- (process_terminal_due_allocations_batch()) -- neither this check nor
  -- this function is on that path, so a legitimate final settlement for a
  -- terminated employee is never affected by this. This check only gates
  -- a NEW row about to be inserted for p_month -- it never reads, re-
  -- validates, or touches any existing historical payroll row for a past
  -- month.
  SELECT COUNT(*) INTO v_ineligible_count
  FROM employees e
  WHERE e.id = ANY(v_employee_ids)
    AND (e.is_deleted OR e.status NOT IN ('Active', 'On Leave'));

  IF v_ineligible_count > 0 THEN
    RAISE EXCEPTION 'Refusing to process: % of the supplied employee(s) are soft-deleted or not in a payable status (Active or On Leave) -- remove them from this batch', v_ineligible_count;
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
  -- STEP 4: Delete + insert (unchanged, plus a NEW per-record PAYE/
  -- pension verification immediately before each INSERT).
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

    -- NEW: PAYE/pension verification -- this employee's gross_pay against
    -- this tenant's CONFIGURED rate (fetched once, above, from
    -- system_settings -- never from the client). Formula verified against
    -- calculateLivePayroll() (src/utils/payrollCalculations.ts), see this
    -- migration's own header. Single-argument ROUND() matches
    -- JavaScript's Math.round() (nearest integer, not 2 decimal places).
    -- A 1-currency-unit tolerance, consistent with the identical tolerance
    -- 20261102000000 already established for its own arithmetic-
    -- consistency check, absorbs any transient floating-point/precision
    -- difference between JS float64 and Postgres NUMERIC arithmetic for a
    -- genuinely correctly-calculated submission.
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
      v_gross_pay,
      v_submitted_paye,
      v_submitted_pension,
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

REVOKE ALL ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- CREATE OR REPLACE FUNCTION, same
-- REVOKE/GRANT pairs as every prior redefinition of this function.
--
-- DEPENDENCIES: 20260817000003 (this function's immediately prior shape,
-- including the salary-advance pooled-allocation loop and region check),
-- 20261102000000 (the internal arithmetic-consistency check in
-- process_payroll_with_terminal_dues(), which calls this function and is
-- unaffected/unchanged by this migration).
--
-- BEHAVIOR CHANGE:
--   1. A tenant with no configured paye_rate/paye_threshold/
--      pension_employee_rate (or a malformed value for any of them)
--      can no longer process ANY payroll at all -- previously there was
--      no server-side check of this at all (only the client-side
--      getPayrollRatesStrict() guarded against it, and only for a client
--      that actually uses it). The current production tenant this
--      hotfix targets already has explicit '0' rows for all three (per
--      the business owner's own directive), so this is a no-op for it.
--   2. A submission whose paye/pension does not match this tenant's
--      configured rate for the record's own gross_pay (beyond a
--      1-currency-unit tolerance) is now refused -- any genuinely
--      correctly-calculated submission (every existing
--      calculateLivePayroll() output, by construction) is unaffected.
--   3. A payroll record for a soft-deleted or non-payable-status
--      (not Active/On Leave) employee is now refused -- any existing,
--      correctly-filtered client submission (Payroll.tsx's own roster
--      query already only offers Active/On Leave employees) is
--      unaffected. Terminal Dues/final-settlement processing is on a
--      completely separate code path and table, never affected.
-- Every other check, the salary-advance pooled-allocation algorithm, the
-- audit log shape, and the function's signature/ACL are byte-for-byte
-- unchanged.
--
-- NO EXISTING ROW IS EVER READ FOR RECALCULATION OR MODIFIED: this
-- migration only adds pre-INSERT guards for the NEW month being
-- processed in this call. No historical, approved, or otherwise
-- untouched `payroll` row is read, recomputed, or written by this
-- migration.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT prosrc LIKE '%does not match the amount computed from this tenant%'
--   FROM pg_proc WHERE proname = 'process_payroll_batch';
--   -- expected: true
--   SELECT prosrc LIKE '%soft-deleted or not in a payable status%'
--   FROM pg_proc WHERE proname = 'process_payroll_batch';
--   -- expected: true
--
-- ROLLBACK SQL (restores the EXACT prior body from
-- 20260817000003_functional_roles_rpc_authorization.sql verbatim,
-- removing both new checks):
--   -- Re-apply 20260817000003's own CREATE OR REPLACE FUNCTION
--   -- process_payroll_batch block verbatim.
-- ============================================================
