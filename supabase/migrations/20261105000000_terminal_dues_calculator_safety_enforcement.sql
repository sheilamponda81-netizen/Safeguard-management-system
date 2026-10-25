-- Terminal Dues Calculator: server-side safety enforcement.
--
-- A read-only safety audit of the current-rate uniform refund fix (commit
-- f47288e) confirmed two gaps in update_terminal_due_calculation_draft()
-- and submit_terminal_due_calculation():
--
--  1. Both correction-reason rules (pension-months override vs the
--     system-calculated completed months; uniform-deduction months vs
--     trusted payroll evidence) were enforced only in client-side JS
--     (TerminalDuesCalculator.tsx's saveDraft()) and were fully bypassable
--     by calling either RPC directly.
--  2. The uniform refund rate recorded in a saved calculation's `inputs`
--     was never checked against the live, Admin-controlled
--     `terminal_dues_uniform_refund_rate` system setting, so a stale
--     browser tab (left open after an Admin changed the rate) or a
--     manipulated RPC call could silently persist a refund computed at
--     the wrong rate.
--
-- This migration re-derives every value these checks compare against
-- directly from server-side data (employment dates already in the
-- submitted inputs, the `payroll` table, and the live `system_settings`
-- row) -- it never trusts a client-supplied "system" value, evidence
-- count, or rate. Per the explicit business policy already implemented in
-- terminalDuesEngine.ts, the uniform refund always uses the CURRENT
-- approved rate for every eligible month, never a historical one -- so a
-- draft's recorded rate must always equal the live setting at the exact
-- moment it is saved or submitted; there is deliberately no notion of an
-- "authorised old rate" to carry forward and no new rate-history table.
-- Once a calculation is submitted, `terminal_due_calculations` is frozen
-- for that row (status moves to 'submitted', and TerminalDuesSubmittedTab
-- never recomputes it), so the rate captured AT SUBMISSION time becomes
-- that calculation's own permanent, authorised historical record on its
-- own, with no extra bookkeeping needed.
--
-- Historical employees (no employee_id, no payroll trail) are explicitly
-- exempted from the uniform-evidence check -- missing evidence is never
-- treated as a confirmed zero, matching
-- uniformRefundNeedsCorrectionReason()'s existing rule in
-- terminalDuesEngine.ts.
--
-- All numeric extraction from the caller-supplied `p_inputs` JSONB is
-- wrapped to fail safely (treated as absent) rather than raising a raw
-- cast error, so a malformed or manipulated payload surfaces as one of
-- the clear validation messages below instead of an opaque database
-- error.
--
-- Signatures, permission checks, tenant/region ownership checks, draft
-- status checks and audit-log behavior are all preserved unchanged from
-- the live definitions this migration replaces (confirmed by a fresh
-- pg_get_functiondef() pull from STAGING immediately before drafting
-- this file). Compatibility: this validation only runs when a row is
-- saved or submitted going forward -- no existing stored row is read or
-- modified by this migration itself. A pre-existing draft that already
-- has an undocumented correction will be blocked at its *next* save or
-- submit attempt until a reason is added; this is the intended effect of
-- closing the gap, not a data loss. Already-submitted/approved/paid
-- `terminal_dues` entitlements are never touched, since both functions
-- only act on rows with status = 'draft'.

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
SET search_path TO 'public', 'pg_temp'
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

  -- Safety enforcement: correction reasons + uniform refund rate (see
  -- migration header comment for the full rationale).
  DECLARE
    v_date_joined DATE;
    v_date_left DATE;
    v_system_months INTEGER;
    v_override_months NUMERIC;
    v_override_reason TEXT;
    v_entered_uniform_months NUMERIC;
    v_entered_uniform_reason TEXT;
    v_evidence_months INTEGER;
    v_current_rate NUMERIC;
    v_claimed_rate NUMERIC;
  BEGIN
    BEGIN
      v_date_joined := (p_inputs->>'dateJoined')::date;
      v_date_left := (p_inputs->>'dateLeft')::date;
    EXCEPTION WHEN OTHERS THEN
      v_date_joined := NULL;
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
      v_override_months := (p_inputs->>'pensionMonthsOverride')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_override_months := NULL;
    END;
    v_override_reason := trim(coalesce(p_inputs->>'pensionMonthsOverrideReason', ''));

    IF v_override_months IS NOT NULL AND v_override_months <> v_system_months AND v_override_reason = '' THEN
      RAISE EXCEPTION 'A correction reason is required: the entered completed months (%) differ from the system-calculated months (%)', v_override_months, v_system_months;
    END IF;

    BEGIN
      v_entered_uniform_months := (p_inputs->>'uniformDeductionMonths')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_entered_uniform_months := 0;
    END;
    v_entered_uniform_reason := trim(coalesce(p_inputs->>'uniformDeductionCorrectionReason', ''));

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
      v_claimed_rate := (p_inputs->>'uniformRefundRatePerMonth')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_claimed_rate := NULL;
    END;

    IF v_claimed_rate IS NULL OR v_claimed_rate <> v_current_rate THEN
      RAISE EXCEPTION 'The uniform refund rate used in this calculation does not match the current approved rate of %. Refresh the Calculator and recalculate before saving.', v_current_rate;
    END IF;
  END;

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

  -- Safety enforcement: correction reasons + uniform refund rate. Runs on
  -- the stored draft (v_row.inputs), not on client-supplied parameters --
  -- submit_terminal_due_calculation() takes no inputs of its own, so this
  -- closes the bypass where a draft saved with a mismatch (however it got
  -- that way) is promoted into the authoritative terminal_dues workflow
  -- without ever being blocked. See migration header comment.
  DECLARE
    v_date_joined DATE;
    v_date_left DATE;
    v_system_months INTEGER;
    v_override_months NUMERIC;
    v_override_reason TEXT;
    v_entered_uniform_months NUMERIC;
    v_entered_uniform_reason TEXT;
    v_evidence_months INTEGER;
    v_current_rate NUMERIC;
    v_claimed_rate NUMERIC;
  BEGIN
    BEGIN
      v_date_joined := (v_row.inputs->>'dateJoined')::date;
      v_date_left := (v_row.inputs->>'dateLeft')::date;
    EXCEPTION WHEN OTHERS THEN
      v_date_joined := NULL;
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

    BEGIN
      v_entered_uniform_months := (v_row.inputs->>'uniformDeductionMonths')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_entered_uniform_months := 0;
    END;
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

REVOKE ALL ON FUNCTION submit_terminal_due_calculation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION submit_terminal_due_calculation(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION submit_terminal_due_calculation(UUID) TO authenticated;
