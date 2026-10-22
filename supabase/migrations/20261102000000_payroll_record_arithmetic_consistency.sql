-- ============================================================
-- MIGRATION: Phase 4B Part 6 -- payroll record arithmetic consistency
-- check at the single combined processing entry point
-- Date: 2026-11-02
-- ============================================================
--
-- WHAT WAS REVIEWED
-- -----------------------------------------------------------
-- Phase 4A's financial snapshot already guarantees IMMUTABILITY: once an
-- Accountant submits a payroll processing request, `payroll_processing_
-- requests.payroll_records`/`financial_snapshot` cannot be altered by
-- anyone before an Admin approves/processes it. `payroll_processing_
-- requests` has table-level INSERT/UPDATE/DELETE REVOKEd from
-- authenticated/PUBLIC/anon (20261028000000) -- every write goes through
-- a SECURITY DEFINER RPC, and none of approve_payroll_processing_
-- request()/process_approved_payroll_request() ever touches
-- payroll_records or financial_snapshot after the initial INSERT. So: an
-- Admin approving a request is GUARANTEED to be looking at the exact same
-- figures that will later be committed -- no tampering window exists
-- between submission and commit.
--
-- IMMUTABILITY IS NOT THE SAME AS CORRECTNESS. Nothing anywhere in this
-- chain -- not submit_payroll_processing_request(), not process_payroll_
-- batch() (which only validates numeric FORMAT and non-negativity, see
-- its own STEP 1.5) -- ever checks that a record's own figures are
-- internally consistent. A caller (an Accountant's own browser session,
-- or a forged RPC call carrying any arbitrary JSONB a valid session
-- token can submit) could submit a record where net_pay does not equal
-- gross_pay minus its own stated deductions, or where gross_pay does not
-- equal the sum of its own stated basic_salary/allowances/overtime/bonus
-- -- e.g. an inflated net_pay with no supporting arithmetic -- and it
-- would sail through submission, review, and commitment unchanged,
-- because nothing anywhere recomputes or cross-checks it. The Admin
-- reviewing the Phase 4A snapshot sees exactly these same (possibly
-- internally-inconsistent) totals; nothing forces them to manually
-- re-derive the arithmetic themselves.
--
-- THE FIX, DELIBERATELY NARROW
-- -----------------------------------------------------------
-- This is a PURE ARITHMETIC CHECK over fields already present in
-- p_records -- it requires no knowledge of attendance, rates, or any
-- other external configuration, so it is not "porting the calculation
-- engine" in any sense: it checks that the numbers AGREE WITH EACH OTHER,
-- not that they were derived using the "correct" formula/rate (that
-- remains the acknowledged, unresolved, out-of-scope gap: manually-typed
-- allowances/overtime/bonus still have no independent second source to
-- verify against, as reported in Phase 4A). Added to process_payroll_
-- with_terminal_dues() -- the ONE function both the Accountant-submitted
-- path (via process_approved_payroll_request()) and the Admin-direct-
-- process path actually call to commit -- so a single check protects
-- both, before any write.
--
-- Two checks, each with a 1-currency-unit tolerance for integer rounding:
--   1. gross_pay ~= basic_salary + allowances + overtime + bonus
--   2. net_pay ~= gross_pay - paye - pension - uniform_deduction
--      (net_pay is deliberately the PRE-salary-advance figure here, same
--      as process_payroll_batch()'s own documented convention -- the
--      advance deduction is computed and subtracted separately, inside
--      process_payroll_batch() itself, after this check runs)
--
-- A failure RAISEs EXCEPTION naming the employee and the mismatch amount,
-- before process_payroll_batch() is even called -- nothing is written,
-- full rollback, exactly like every other validation in this function.
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
  v_bad_record RECORD;
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

  -- NEW: internal arithmetic consistency -- every record's own stated
  -- figures must agree with each other. This is NOT a rate/formula
  -- correctness check (see this migration's own header); it only catches
  -- a record whose numbers do not add up at all.
  SELECT r->>'employee_id' AS employee_id,
         (r->>'gross_pay')::NUMERIC AS gross_pay,
         (r->>'basic_salary')::NUMERIC AS basic_salary,
         COALESCE((r->>'allowances')::NUMERIC, 0) AS allowances,
         COALESCE((r->>'overtime')::NUMERIC, 0) AS overtime,
         COALESCE((r->>'bonus')::NUMERIC, 0) AS bonus,
         (r->>'net_pay')::NUMERIC AS net_pay,
         COALESCE((r->>'paye')::NUMERIC, 0) AS paye,
         COALESCE((r->>'pension')::NUMERIC, 0) AS pension,
         COALESCE((r->>'uniform_deduction')::NUMERIC, 0) AS uniform_deduction
    INTO v_bad_record
  FROM jsonb_array_elements(p_records) AS r
  WHERE
    ABS((r->>'gross_pay')::NUMERIC - ((r->>'basic_salary')::NUMERIC + COALESCE((r->>'allowances')::NUMERIC, 0) + COALESCE((r->>'overtime')::NUMERIC, 0) + COALESCE((r->>'bonus')::NUMERIC, 0))) > 1
    OR ABS((r->>'net_pay')::NUMERIC - ((r->>'gross_pay')::NUMERIC - COALESCE((r->>'paye')::NUMERIC, 0) - COALESCE((r->>'pension')::NUMERIC, 0) - COALESCE((r->>'uniform_deduction')::NUMERIC, 0))) > 1
  LIMIT 1;

  IF v_bad_record.employee_id IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to process: employee %''s submitted figures do not reconcile internally (gross_pay %, computed from basic+allowances+overtime+bonus as %; net_pay %, computed from gross-PAYE-pension-uniform as %) -- nothing has been committed. This may indicate a corrupted or tampered submission; verify and resubmit.',
      v_bad_record.employee_id,
      v_bad_record.gross_pay, (v_bad_record.basic_salary + v_bad_record.allowances + v_bad_record.overtime + v_bad_record.bonus),
      v_bad_record.net_pay, (v_bad_record.gross_pay - v_bad_record.paye - v_bad_record.pension - v_bad_record.uniform_deduction);
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
-- RUN ONCE / RUN TWICE: idempotent -- CREATE OR REPLACE FUNCTION, same
-- REVOKE/GRANT pairs.
--
-- DEPENDENCIES: 20261101000000 (this function's immediately prior shape).
--
-- PREFLIGHT: none -- no table/column/RLS change, pure function body edit.
--
-- BEHAVIOR CHANGE: a record whose own gross/net figures do not add up
-- (within 1 currency unit) is now refused at processing time, for BOTH
-- the Admin-direct path and the Accountant-submitted-then-approved path.
-- Any genuinely correctly-calculated submission (the universal case --
-- every existing calculatePayroll()/calculateLivePayroll() output already
-- satisfies both equalities by construction) is completely unaffected.
--
-- VERIFICATION SQL:
--   SELECT prosrc FROM pg_proc WHERE proname = 'process_payroll_with_terminal_dues';
--   -- expected: contains 'do not reconcile internally'
--
-- ROLLBACK SQL:
--   -- Re-apply 20261101000000's own CREATE OR REPLACE body for this
--   -- function (removes the new consistency check only).
-- ============================================================
