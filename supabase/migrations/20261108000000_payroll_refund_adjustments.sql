-- ============================================================
-- MIGRATION: Durable, server-authoritative payroll refund adjustments
-- Date: 2026-11-08
-- ============================================================
--
-- BUSINESS PROBLEM: an employee sometimes receives an incorrect
-- attendance/lecture/uniform/other deduction in an earlier payroll run.
-- HR needs a controlled way to reimburse that amount through the NEXT
-- eligible payroll, with the payslip explicitly showing "Refund: MK X".
--
-- ROOT CAUSE INVESTIGATED (why the existing Bonus input "disappears"):
-- Payroll.tsx's Basic/Allowances/Overtime/Bonus inputs are held ONLY in
-- client-side React state (`editingValues`, a plain useState, keyed by
-- employee_id only -- see Payroll.tsx). Nothing ever persists that state
-- to the database until the whole month is processed (which calls
-- process_payroll_batch() and clears editingValues immediately after).
-- Leaving the page, refreshing, or logging out discards unsaved React
-- state entirely -- this is normal, expected React behavior, not a
-- Supabase/RLS/permission bug. A second, independent defect was found in
-- the same investigation: editingValues is keyed ONLY by employee_id, not
-- by (employee_id, month) -- switching the month dropdown while an
-- unsaved edit exists would carry that value into a DIFFERENT month's
-- preview. Both are display/client-state issues; no historical `payroll`
-- row or RLS policy was ever at fault.
--
-- WHY A DISTINCT REFUND FIELD, NOT A REUSED BONUS FIELD: calculateLivePayroll()
-- (src/utils/payrollCalculations.ts) adds bonus directly into grossPay,
-- which is then the base for BOTH paye and pension:
--   grossPay = basicSalary + allowances + overtime + bonus
--   paye     = ROUND(MAX(0, grossPay - payeThreshold) * payeRate)
--   pension  = ROUND(grossPay * pensionRate)
-- A genuine bonus is taxable new income, correctly taxed this way. A
-- refund of a PREVIOUSLY, WRONGLY withheld amount is not new income --
-- it is money that should never have left the employee's net pay, and
-- reusing Bonus would tax it a second time (and would retroactively
-- relabel every historical genuine bonus transaction's meaning, which
-- the brief explicitly forbids). This migration therefore adds refund as
-- its own column, applied AFTER paye/pension/uniform/salary-advance, at
-- the net-pay level only -- mirroring exactly how salary_advance_deduction
-- already sits outside grossPay/paye/pension for the identical reason
-- (see 20260813001_payroll_salary_advance_integration.sql).
--
-- FINANCE DECISION NEEDED (explicitly flagged, not assumed): this
-- migration's default treats a refund as NEVER taxable (never added to
-- the PAYE/pension base). For THIS tenant, paye_rate/pension_employee_rate
-- are both explicitly configured to 0 -- untouched, unread, and
-- unaffected by this migration either way -- so the decision has no
-- numeric effect here today. It MUST be confirmed by Finance before this
-- is relied upon for a tenant with a nonzero PAYE/pension rate: is a
-- refund of a wrongly-withheld deduction always non-taxable (this
-- migration's default), or could some refund categories (e.g. a
-- reimbursed uniform cost) carry different tax treatment? Nothing here
-- forces an answer either way -- the column and formula are changeable
-- in a future forward-only migration once Finance decides.
--
-- WHY A DEDICATED payroll_refund_drafts TABLE, NOT A CLIENT-SUBMITTED
-- JSON FIELD: mirrors the existing, already-established pattern for
-- salary_advance_deduction -- process_payroll_batch() never trusts a
-- client-submitted advance figure; it independently re-derives it from
-- salary_advance_repayment_plans/salary_advances. The same discipline
-- applies here: process_payroll_batch() (below) independently reads this
-- table itself for the exact (tenant, employee, month) being processed --
-- a forged or stale client-submitted "refund" value in the JSON payload
-- (there isn't one -- the payload shape is unchanged) cannot affect what
-- actually gets committed.
-- ============================================================

-- ============================================================
-- PART 1: payroll.refund -- the committed, authoritative amount actually
-- applied to a processed payroll row. Separate from the draft table
-- below (which is the pre-processing, editable, auditable INPUT; this
-- column is the post-processing, frozen OUTPUT -- exactly the same
-- draft/committed split salary_advance_deduction already has against
-- salary_advance_repayment_plans).
-- ============================================================
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS refund NUMERIC(14,2) NOT NULL DEFAULT 0;

-- ============================================================
-- PART 2: payroll_refund_drafts -- one editable slot per (tenant,
-- employee, month), auto-saved as HR types, never processed/approved/
-- posted by saving alone. UNIQUE(tenant_id, employee_id, month) makes
-- duplication across repeated saves or a reprocess structurally
-- impossible -- there is only ever one row to read, not an appended
-- ledger.
-- ============================================================
CREATE TABLE IF NOT EXISTS payroll_refund_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  -- Structured reason (required whenever amount > 0) plus optional free-text
  -- notes (required when reason_code = 'other', since "other" alone is not
  -- a meaningful reason). Kept as a CHECK, not a separate lookup table --
  -- this mirrors role_permissions' own "small fixed vocabulary" style
  -- rather than over-engineering a new settings table for 6 values.
  reason_code TEXT CHECK (
    reason_code IS NULL OR reason_code IN (
      'incorrect_absence_deduction',
      'incorrect_lecture_deduction',
      'incorrect_late_deduction',
      'incorrect_uniform_deduction',
      'attendance_correction',
      'other'
    )
  ),
  reason_notes TEXT,
  -- Optional reference to WHICH earlier payroll this reimburses -- used
  -- both for human audit ("what is being refunded") and for this
  -- migration's own duplicate-refund detection below.
  reference_month TEXT,
  reference_category TEXT CHECK (
    reference_category IS NULL OR reference_category IN (
      'absent_deduction', 'late_deduction', 'lecture_deduction',
      'appearance_deduction', 'uniform_deduction', 'other'
    )
  ),
  -- 'pending' (editable draft) -> 'applied' (baked into applied_payroll_id
  -- by process_payroll_batch) -> 'cancelled' (a deliberate zero). Only
  -- process_payroll_batch() ever sets 'applied'; upsert_payroll_refund_draft()
  -- below only ever sets 'pending'/'cancelled'.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'cancelled')),
  applied_payroll_id UUID REFERENCES payroll(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- clock_timestamp(), not now()/NOW() -- now() is frozen to the
  -- enclosing transaction's start time, which would make two edits
  -- issued back-to-back within the SAME transaction (e.g. a test
  -- harness, or any future batch path) carry IDENTICAL updated_at
  -- values, defeating the optimistic-concurrency check below that
  -- depends on updated_at actually advancing on every write.
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, employee_id, month)
);

CREATE INDEX IF NOT EXISTS idx_payroll_refund_drafts_tenant_month ON payroll_refund_drafts(tenant_id, month);
CREATE INDEX IF NOT EXISTS idx_payroll_refund_drafts_reference ON payroll_refund_drafts(employee_id, reference_month, reference_category) WHERE reference_month IS NOT NULL;

ALTER TABLE payroll_refund_drafts ENABLE ROW LEVEL SECURITY;

-- Read-only via RLS for anyone who can already view payroll in their own
-- tenant; ALL writes go through upsert_payroll_refund_draft() below
-- (SECURITY DEFINER, bypasses RLS) -- there is deliberately no INSERT/
-- UPDATE/DELETE grant to `authenticated` on this table at all, so a
-- direct client-side .update()/.insert() against it (skipping every
-- validation the RPC performs) is impossible, not merely discouraged.
DROP POLICY IF EXISTS "Users can view refund drafts in their tenant" ON payroll_refund_drafts;
CREATE POLICY "Users can view refund drafts in their tenant" ON payroll_refund_drafts
FOR SELECT USING (
  tenant_id = get_current_tenant_id()
  AND is_current_user_active()
  AND (is_super_admin() OR is_business_admin() OR has_permission('payroll.view') OR has_permission('payroll.process'))
);

REVOKE ALL ON payroll_refund_drafts FROM PUBLIC;
REVOKE ALL ON payroll_refund_drafts FROM anon;
GRANT SELECT ON payroll_refund_drafts TO authenticated;

-- ============================================================
-- PART 3: upsert_payroll_refund_draft() -- the ONLY way to create/edit/
-- cancel a refund draft. Handles auto-save (called on every debounced
-- keystroke from the client), validation, the approved/processed-month
-- lock, optimistic concurrency, and duplicate-refund detection.
-- ============================================================
CREATE OR REPLACE FUNCTION upsert_payroll_refund_draft(
  p_employee_id UUID,
  p_month TEXT,
  p_amount NUMERIC,
  p_reason_code TEXT DEFAULT NULL,
  p_reason_notes TEXT DEFAULT NULL,
  p_reference_month TEXT DEFAULT NULL,
  p_reference_category TEXT DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL,
  p_confirm_duplicate BOOLEAN DEFAULT FALSE
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
  v_employee RECORD;
  v_existing RECORD;
  v_amount NUMERIC;
  v_new_status TEXT;
  v_processed_count INTEGER;
  v_conflict RECORD;
  v_result RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT tenant_id, role_level, is_super_admin, is_active, deleted_at
    INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active, v_deleted_at
  FROM profiles
  WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled';
  END IF;

  -- Same authorization boundary as editing Bonus/Allowances/Overtime on
  -- this exact page today (Payroll.tsx's canEditPayroll -> PAYROLL_PROCESS).
  IF NOT (v_is_super_admin OR COALESCE(v_role_level = 1, false) OR has_permission('payroll.process')) THEN
    RAISE EXCEPTION 'You do not have permission to edit payroll refund adjustments';
  END IF;

  IF p_month IS NULL OR NOT (p_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') THEN
    RAISE EXCEPTION 'Invalid month format -- expected YYYY-MM';
  END IF;

  IF p_amount IS NULL THEN
    RAISE EXCEPTION 'Refund amount is required';
  END IF;
  IF p_amount < 0 THEN
    RAISE EXCEPTION 'Refund amount cannot be negative';
  END IF;
  v_amount := ROUND(p_amount, 2);

  SELECT e.id, e.tenant_id, e.region_id INTO v_employee
  FROM employees e
  WHERE e.id = p_employee_id;

  IF v_employee.id IS NULL OR v_employee.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'Employee not found in your tenant';
  END IF;

  IF NOT (v_is_super_admin OR is_business_admin()) AND NOT region_allowed(v_employee.region_id) THEN
    RAISE EXCEPTION 'This employee is outside your assigned region';
  END IF;

  -- Reason required whenever a nonzero amount is being saved -- never
  -- create/keep a nonzero refund with no stated reason.
  IF v_amount > 0 THEN
    IF p_reason_code IS NULL OR btrim(p_reason_code) = '' THEN
      RAISE EXCEPTION 'A refund reason is required for a nonzero amount';
    END IF;
    IF p_reason_code = 'other' AND (p_reason_notes IS NULL OR btrim(p_reason_notes) = '') THEN
      RAISE EXCEPTION 'Please describe the reason in the notes when "Other" is selected';
    END IF;
  END IF;

  -- Reject editing a draft for a month that has ALREADY been processed
  -- (pending OR approved) for this employee -- matches the EXISTING lock
  -- already enforced client-side for Bonus/Allowances/Overtime on this
  -- same page (Payroll.tsx's isEditable: !existingRecord && !isMonthProcessed
  -- && !isApproved). An admin who wants to change a refund for an
  -- already-processed month must reprocess (which re-reads this table
  -- fresh), not edit the draft after the fact.
  SELECT COUNT(*) INTO v_processed_count
  FROM payroll
  WHERE tenant_id = v_tenant_id AND employee_id = p_employee_id AND month = p_month;

  IF v_processed_count > 0 THEN
    RAISE EXCEPTION 'Refusing to save: payroll for % has already been processed for this employee -- reprocess the month (which reads this refund fresh) instead of editing the draft, or reject/unapprove first if it is approved', p_month;
  END IF;

  -- Lock any existing draft row for this (tenant, employee, month) before
  -- checking for a concurrent edit.
  SELECT * INTO v_existing
  FROM payroll_refund_drafts
  WHERE tenant_id = v_tenant_id AND employee_id = p_employee_id AND month = p_month
  FOR UPDATE;

  -- Optimistic concurrency: the client must pass back the updated_at it
  -- last saw (NULL if it believed no draft existed yet). A mismatch means
  -- another authorized user's edit landed in between -- refuse rather
  -- than silently overwrite it.
  IF (v_existing.id IS NULL) <> (p_expected_updated_at IS NULL) THEN
    RAISE EXCEPTION 'Refusing to save: this refund draft was changed by someone else since you loaded it -- reload and try again';
  ELSIF v_existing.id IS NOT NULL AND v_existing.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'Refusing to save: this refund draft was changed by someone else since you loaded it -- reload and try again';
  END IF;

  -- Duplicate-refund detection: only meaningful when the caller identifies
  -- WHICH earlier deduction this reimburses. Looks for another active
  -- (pending/applied) nonzero refund already recorded for this SAME
  -- employee against the SAME reference -- this is a warning requiring
  -- explicit human confirmation (p_confirm_duplicate), never a silent
  -- block and never a silent allow.
  IF v_amount > 0 AND p_reference_month IS NOT NULL AND p_reference_category IS NOT NULL AND NOT p_confirm_duplicate THEN
    SELECT id, month, amount, created_at INTO v_conflict
    FROM payroll_refund_drafts
    WHERE tenant_id = v_tenant_id
      AND employee_id = p_employee_id
      AND reference_month = p_reference_month
      AND reference_category = p_reference_category
      AND status IN ('pending', 'applied')
      AND amount > 0
      AND id <> COALESCE(v_existing.id, '00000000-0000-0000-0000-000000000000'::UUID)
    LIMIT 1;

    IF v_conflict.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'duplicate_warning', true,
        'conflicting_draft', jsonb_build_object(
          'month', v_conflict.month,
          'amount', v_conflict.amount,
          'created_at', v_conflict.created_at
        )
      );
    END IF;
  END IF;

  v_new_status := CASE WHEN v_amount = 0 THEN 'cancelled' ELSE 'pending' END;

  INSERT INTO payroll_refund_drafts (
    tenant_id, employee_id, month, amount, reason_code, reason_notes,
    reference_month, reference_category, status, created_by, updated_by
  ) VALUES (
    v_tenant_id, p_employee_id, p_month, v_amount, p_reason_code, p_reason_notes,
    p_reference_month, p_reference_category, v_new_status, v_caller_id, v_caller_id
  )
  ON CONFLICT (tenant_id, employee_id, month) DO UPDATE SET
    amount = v_amount,
    reason_code = p_reason_code,
    reason_notes = p_reason_notes,
    reference_month = p_reference_month,
    reference_category = p_reference_category,
    status = v_new_status,
    updated_by = v_caller_id,
    updated_at = clock_timestamp()
  RETURNING * INTO v_result;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id,
    CASE WHEN v_existing.id IS NULL THEN 'CREATE' ELSE 'UPDATE' END,
    'payroll_refund_draft', v_result.id::text,
    CASE WHEN v_existing.id IS NULL THEN NULL ELSE jsonb_build_object('amount', v_existing.amount, 'reason_code', v_existing.reason_code, 'status', v_existing.status) END,
    jsonb_build_object('amount', v_result.amount, 'reason_code', v_result.reason_code, 'reason_notes', v_result.reason_notes, 'reference_month', v_result.reference_month, 'reference_category', v_result.reference_category, 'status', v_result.status)
  );

  RETURN jsonb_build_object(
    'success', true,
    'duplicate_warning', false,
    'draft', jsonb_build_object(
      'id', v_result.id,
      'employee_id', v_result.employee_id,
      'month', v_result.month,
      'amount', v_result.amount,
      'reason_code', v_result.reason_code,
      'reason_notes', v_result.reason_notes,
      'reference_month', v_result.reference_month,
      'reference_category', v_result.reference_category,
      'status', v_result.status,
      'updated_at', v_result.updated_at,
      'updated_by', v_result.updated_by
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION upsert_payroll_refund_draft(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION upsert_payroll_refund_draft(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION upsert_payroll_refund_draft(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN) TO authenticated;

-- ============================================================
-- PART 4: process_payroll_batch() -- CREATE OR REPLACE continuing from
-- 20261107000000's body verbatim, plus exactly one additive change: the
-- refund amount is read from payroll_refund_drafts (never trusted from
-- the client JSON payload, which carries no refund field at all) and
-- added to net_pay AFTER the salary-advance deduction, outside gross_pay/
-- paye/pension entirely. The draft row is marked 'applied' once its
-- amount has been committed into this new payroll row -- reprocessing
-- the same month simply re-reads the SAME single draft row (the
-- UNIQUE(tenant_id, employee_id, month) constraint makes a duplicate
-- structurally impossible), updating applied_payroll_id to the new row.
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
  -- NEW: refund adjustment variables
  v_refund_amount NUMERIC;
  v_new_payroll_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT tenant_id, role_level, is_super_admin, is_active, deleted_at
    INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active, v_deleted_at
  FROM profiles
  WHERE id = v_caller_id;

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

  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || p_month));

  SELECT COUNT(*) INTO v_foreign_employee_count
  FROM unnest(v_employee_ids) AS eid
  WHERE NOT EXISTS (
    SELECT 1 FROM employees e WHERE e.id = eid AND e.tenant_id = v_tenant_id
  );

  IF v_foreign_employee_count > 0 THEN
    RAISE EXCEPTION 'Refusing to process: % of the supplied employee(s) do not belong to your tenant', v_foreign_employee_count;
  END IF;

  SELECT COUNT(*) INTO v_ineligible_count
  FROM employees e
  WHERE e.id = ANY(v_employee_ids)
    AND (e.is_deleted OR e.status NOT IN ('Active', 'On Leave'));

  IF v_ineligible_count > 0 THEN
    RAISE EXCEPTION 'Refusing to process: % of the supplied employee(s) are soft-deleted or not in a payable status (Active or On Leave) -- remove them from this batch', v_ineligible_count;
  END IF;

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

    -- NEW: refund adjustment -- independently read from payroll_refund_drafts
    -- for THIS (tenant, employee, month). Never taken from p_record (no such
    -- field exists in the submitted JSON at all) -- the client cannot forge,
    -- inflate, or omit this value. Zero (no draft row, or amount 0/cancelled)
    -- is a no-op. Added AFTER the salary-advance deduction, outside
    -- gross_pay/paye/pension entirely -- see this migration's header for why.
    SELECT COALESCE(amount, 0) INTO v_refund_amount
    FROM payroll_refund_drafts
    WHERE tenant_id = v_tenant_id AND employee_id = v_employee_id AND month = p_month
      AND status <> 'cancelled';
    v_refund_amount := COALESCE(v_refund_amount, 0);

    IF (v_base_net_pay - v_advance_deduction + v_refund_amount) < 0 THEN
      RAISE EXCEPTION 'Refusing to process payroll for employee %: this would produce a negative net pay of % (net pay % minus a salary advance deduction of % plus a refund of %). Final payroll net pay must never be negative -- resolve this before processing -- nothing has been applied and the transaction has been rolled back.',
        v_employee_id, (v_base_net_pay - v_advance_deduction + v_refund_amount), v_base_net_pay, v_advance_deduction, v_refund_amount;
    END IF;

    DELETE FROM salary_advance_repayment_plans
    WHERE employee_id = v_employee_id
      AND NOT EXISTS (
        SELECT 1 FROM salary_advances WHERE employee_id = v_employee_id AND status = 'active'
      );

    INSERT INTO payroll (
      tenant_id, employee_id, month, basic_salary, allowances, overtime, bonus,
      gross_pay, paye, pension, uniform_deduction, salary_advance_deduction, refund, net_pay,
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
      v_refund_amount,
      v_base_net_pay - v_advance_deduction + v_refund_amount,
      NOW(),
      'pending',
      NULL,
      NULL,
      NULL,
      NOW()
    )
    RETURNING id INTO v_new_payroll_id;

    IF v_refund_amount > 0 THEN
      UPDATE payroll_refund_drafts
      SET status = 'applied', applied_payroll_id = v_new_payroll_id, applied_at = NOW()
      WHERE tenant_id = v_tenant_id AND employee_id = v_employee_id AND month = p_month;
    END IF;
  END LOOP;

  v_inserted_count := jsonb_array_length(p_records);

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
-- PART 5: compute_payroll_request_snapshot() -- extended with one new
-- fingerprint (refund_fingerprint), so a refund draft edited after an
-- Accountant submits a processing request, but before an Admin approves
-- or processes it, is caught by the EXISTING staleness-revalidation
-- mechanism exactly like every other input already fingerprinted here.
-- Every existing field/line is unchanged.
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
  v_refund_fp JSONB;
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

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'employee_id', e.id,
           'basic_salary', e.basic_salary,
           'uniform_deduction', e.uniform_deduction,
           'position', e.position
         ) ORDER BY e.id), '[]'::jsonb)
    INTO v_salary_fp
    FROM employees e
    WHERE e.id = ANY(COALESCE(v_employee_ids, '{}'));

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

  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    INTO v_rates_fp
    FROM system_settings
    WHERE tenant_id = p_tenant_id
      AND key IN ('paye_rate', 'paye_threshold', 'pension_employee_rate', 'uniform_deduction_default', 'absent_day_deduction', 'late_day_deduction');

  -- NEW: refund-draft fingerprint -- every active (not cancelled) nonzero
  -- refund amount for this month's employees. Reading status/amount
  -- straight from payroll_refund_drafts, the same table
  -- process_payroll_batch() itself reads at actual processing time, so
  -- this can never disagree with what will actually be applied.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'employee_id', rd.employee_id,
           'amount', rd.amount,
           'status', rd.status
         ) ORDER BY rd.employee_id), '[]'::jsonb)
    INTO v_refund_fp
    FROM payroll_refund_drafts rd
    WHERE rd.tenant_id = p_tenant_id
      AND rd.month = p_month
      AND rd.employee_id = ANY(COALESCE(v_employee_ids, '{}'))
      AND rd.status <> 'cancelled'
      AND rd.amount > 0;

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
    'refund_fingerprint', v_refund_fp,
    'captured_at', NOW()
  );
END;
$$;

REVOKE ALL ON FUNCTION compute_payroll_request_snapshot(UUID, TEXT, JSONB, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION compute_payroll_request_snapshot(UUID, TEXT, JSONB, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION compute_payroll_request_snapshot(UUID, TEXT, JSONB, UUID[]) FROM authenticated;

-- ============================================================
-- PART 6: approve_payroll_processing_request() -- extends the existing
-- "predates snapshot tracking" guard to also catch a snapshot missing
-- the new refund_fingerprint key, then adds the one new comparison.
-- Every other line unchanged.
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

  IF v_request.financial_snapshot IS NULL
     OR NOT (v_request.financial_snapshot ? 'employee_salary_fingerprint')
     OR NOT (v_request.financial_snapshot ? 'refund_fingerprint')
  THEN
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

  IF (v_fresh->'refund_fingerprint') <> (v_request.financial_snapshot->'refund_fingerprint') THEN
    RAISE EXCEPTION 'Refusing to approve: a refund adjustment for one or more employees has changed since this request was submitted -- reject this request and ask for a fresh submission';
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
-- PART 7: process_approved_payroll_request() -- same one new fingerprint
-- comparison, at the processing checkpoint. Every other line unchanged.
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

  IF v_request.financial_snapshot IS NULL
     OR NOT (v_request.financial_snapshot ? 'employee_salary_fingerprint')
     OR NOT (v_request.financial_snapshot ? 'refund_fingerprint')
  THEN
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

  IF (v_fresh->'refund_fingerprint') <> (v_request.financial_snapshot->'refund_fingerprint') THEN
    RAISE EXCEPTION 'Refusing to process: a refund adjustment for one or more employees has changed since this request was submitted -- reject this request and ask for a fresh submission';
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
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- CREATE TABLE IF NOT EXISTS, ADD
-- COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION throughout.
--
-- DEPENDENCIES: 20261107000000 (process_payroll_batch()'s immediately
-- prior shape), 20261101000000 (compute_payroll_request_snapshot()/
-- approve_payroll_processing_request()/process_approved_payroll_request()'s
-- immediately prior shape).
--
-- BEHAVIOR CHANGE:
--   1. New table payroll_refund_drafts and new upsert_payroll_refund_draft()
--      RPC -- opt-in, nothing calls either yet without a client change.
--   2. payroll gains a `refund` column, NOT NULL DEFAULT 0 -- every
--      existing historical row reads back refund = 0, changing nothing
--      about its stored net_pay or any other figure.
--   3. process_payroll_batch() now also looks up payroll_refund_drafts
--      for each employee/month being processed and adds any active
--      amount to net_pay. For every employee/month with no draft row (the
--      entire installed base, until the UI change ships), this looks up
--      zero rows and changes nothing.
--   4. compute_payroll_request_snapshot()'s new refund_fingerprint is `[]`
--      for any month with no active refund drafts -- a no-op for every
--      existing in-flight request. A request already pending/approved at
--      the moment this migration is applied will be refused at its next
--      approve/process call (missing refund_fingerprint key), exactly
--      like 20261101000000's own identical, already-accepted behavior
--      for its three fingerprints.
-- Every other check, the salary-advance pooled-allocation algorithm, the
-- audit log shape, and every function's signature/ACL are otherwise
-- byte-for-byte unchanged.
--
-- NO EXISTING ROW IS EVER READ FOR RECALCULATION OR MODIFIED: this
-- migration only adds pre-INSERT lookups/guards for the NEW month being
-- processed in this call. No historical, approved, or otherwise untouched
-- `payroll` row is read, recomputed, or written by this migration.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'payroll' AND column_name = 'refund';
--   -- expected: 1 row
--   SELECT prosrc LIKE '%payroll_refund_drafts%' FROM pg_proc WHERE proname = 'process_payroll_batch';
--   -- expected: true
--   SELECT prosrc LIKE '%refund_fingerprint%' FROM pg_proc WHERE proname = 'compute_payroll_request_snapshot';
--   -- expected: true
--
-- ROLLBACK SQL (restores process_payroll_batch()/compute_payroll_request_snapshot()/
-- approve_payroll_processing_request()/process_approved_payroll_request() to
-- their exact prior bodies from 20261107000000/20261101000000 verbatim;
-- the new table/column are additive and harmless to leave in place, but
-- may be dropped):
--   -- Re-apply 20261107000000's process_payroll_batch() and
--   -- 20261101000000's other three functions verbatim.
--   -- DROP FUNCTION IF EXISTS upsert_payroll_refund_draft(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN);
--   -- DROP TABLE IF EXISTS payroll_refund_drafts;
--   -- ALTER TABLE payroll DROP COLUMN IF EXISTS refund;
-- ============================================================
