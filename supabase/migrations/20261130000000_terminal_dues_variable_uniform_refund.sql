-- Terminal Dues Calculator: variable uniform refund breakdown.
--
-- PROBLEM: the uniform refund was computed as ONE blended rate applied to
-- a total month count (deductionMonths x ratePerMonth). Historical uniform
-- deductions actually varied month to month (e.g. MK 5,000 for 4 months,
-- MK 8,000 for 2 months, MK 10,000 for 4 months -- correct total MK
-- 76,000), so a single blended rate x 10 months produced a materially
-- wrong figure (MK 100,000 in that example). HR already holds the correct
-- per-period amounts on paper; there is no automated evidence system and
-- none is being added here -- HR enters the breakdown rows directly.
--
-- FIX: HR now enters a list of rows (months, amountPerMonth) in the
-- Calculator (and the entitlement revision panel); each row's subtotal is
-- months x amountPerMonth rounded up to the whole Kwacha, and the uniform
-- refund is the sum of those subtotals (see
-- calculateUniformRefundBreakdown() in terminalDuesEngine.ts, which this
-- migration mirrors exactly in SQL). The breakdown is stored as part of
-- the existing `inputs`/`breakdown` JSONB columns on
-- terminal_due_calculations -- no new column or table is needed, since
-- those columns already hold the full structured record; a submitted
-- calculation's row (and therefore its breakdown) is never deleted, so an
-- approver viewing the resulting terminal_dues entitlement can still read
-- the itemised rows via the existing submitted_terminal_due_id link
-- (see TerminalDues.tsx's LinkedUniformRefundBreakdown).
--
-- This migration is a TRUE CREATE OR REPLACE of the two RPCs that
-- independently re-derive and validate the uniform refund server-side --
-- update_terminal_due_calculation_draft() (live definition:
-- 20261105000000_terminal_dues_calculator_safety_enforcement.sql, never
-- replaced since) and submit_terminal_due_calculation() (live definition:
-- 20261129000000_terminal_dues_batch_management.sql) -- both keep their
-- EXACT existing signatures. Every other check (authentication, tenant/
-- region, draft-status, authoritative dateJoined via employees.hire_date,
-- the pension-months-override correction-reason rule, the pension-arrears
-- recomputation, the total_payable consistency check, the audit-log
-- writes, the two terminal_dues INSERT column lists including
-- employee_exit_id/batch_id) is carried forward byte-for-byte unchanged.
--
-- REMOVED along with the old formula (now meaningless under the new
-- model, not weakened protections): the `terminal_dues_uniform_refund_rate`
-- system-setting lookup/match check (there is no single "current rate"
-- any more -- every row carries its own amount), and the payroll-evidence-
-- months-vs-entered-months correction-reason requirement (there is no
-- single "entered months" scalar to compare against payroll evidence any
-- more, and per the explicit business decision for this feature,
-- payroll.uniform_deduction -- a bundled uniform+attendance+lecture/
-- appearance figure, see payrollDeductionBreakdown.ts's own header -- is
-- never treated as uniform-only evidence in the first place).
--
-- ADDED in their place: independent server-side validation of the
-- breakdown itself -- `uniformRefundBreakdown` must be a JSON array (or
-- absent/null, meaning no rows); every row's `months` must cast to a
-- finite positive whole number and `amountPerMonth` to a finite positive
-- amount. PostgreSQL's NUMERIC type accepts the literal values 'NaN',
-- 'Infinity' and '-Infinity' and compares 'NaN' as greater than every
-- ordinary value (so a naive "> 0" check alone would wrongly accept a
-- client-crafted 'NaN' row) -- there is no isfinite() overload for
-- NUMERIC/float8 in this Postgres version, so each row is explicitly
-- checked against all three special values before the ordinary
-- range/whole-number checks run. The recomputed total (sum of each row's
-- own rounded-up subtotal) must equal breakdown.uniformRefund exactly.
-- Nothing is ever silently zeroed or guessed: any row that fails
-- validation blocks the save/submit with a clear exception, exactly like
-- every other field this pair of RPCs already enforces.

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

  -- Safety enforcement: correction reasons, authoritative employment
  -- dates, uniform refund breakdown arithmetic and total_payable
  -- consistency (see migration header comment for the full rationale).
  DECLARE
    v_employee_hire_date DATE;
    v_employee_tenant_id UUID;
    v_date_joined DATE;
    v_date_left DATE;
    v_system_months INTEGER;
    v_override_months NUMERIC;
    v_override_reason TEXT;
    v_effective_months NUMERIC;
    v_uniform_breakdown JSONB;
    v_uniform_row JSONB;
    v_row_months NUMERIC;
    v_row_amount NUMERIC;
    v_final_salary NUMERIC;
    v_computed_pension_arrears NUMERIC;
    v_breakdown_pension_arrears NUMERIC;
    v_computed_uniform_refund NUMERIC;
    v_breakdown_uniform_refund NUMERIC;
    v_computed_entitlements NUMERIC;
    v_computed_total_payable NUMERIC;
    v_breakdown_total_payable NUMERIC;
  BEGIN
    -- Authoritative dateJoined: for an existing employee, employees.hire_date
    -- (verified to belong to this tenant) -- p_inputs.dateJoined is never
    -- read for this computation, so it can no longer be manipulated to
    -- bypass the correction-reason check below. Historical subjects have
    -- no linked employee record, so their dateJoined still comes from the
    -- submitted inputs, exactly as before. dateLeft has no authoritative
    -- source anywhere in this schema and is read from the submitted inputs
    -- for both subject types, same as before -- it is not independently
    -- verified.
    IF v_row.employee_id IS NOT NULL THEN
      SELECT hire_date, tenant_id INTO v_employee_hire_date, v_employee_tenant_id
      FROM employees WHERE id = v_row.employee_id;

      IF v_employee_hire_date IS NULL OR (v_employee_tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
        RAISE EXCEPTION 'The employee for this calculation could not be found';
      END IF;

      v_date_joined := v_employee_hire_date;
    ELSE
      BEGIN
        v_date_joined := (p_inputs->>'dateJoined')::date;
      EXCEPTION WHEN OTHERS THEN
        v_date_joined := NULL;
      END;
    END IF;

    BEGIN
      v_date_left := (p_inputs->>'dateLeft')::date;
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
      v_override_months := (p_inputs->>'pensionMonthsOverride')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_override_months := NULL;
    END;
    v_override_reason := trim(coalesce(p_inputs->>'pensionMonthsOverrideReason', ''));

    IF v_override_months IS NOT NULL AND v_override_months <> v_system_months AND v_override_reason = '' THEN
      RAISE EXCEPTION 'A correction reason is required: the entered completed months (%) differ from the system-calculated months (%)', v_override_months, v_system_months;
    END IF;

    v_effective_months := CASE
      WHEN v_override_months IS NOT NULL AND v_override_months >= 0 THEN v_override_months
      ELSE v_system_months
    END;

    -- Uniform refund breakdown: a JSON array of {months, amountPerMonth}
    -- rows, or absent/null (no rows -- refund is 0). Every row must be
    -- independently valid; nothing is ever dropped or zeroed silently.
    v_uniform_breakdown := p_inputs->'uniformRefundBreakdown';
    IF v_uniform_breakdown IS NOT NULL AND jsonb_typeof(v_uniform_breakdown) <> 'array' THEN
      RAISE EXCEPTION 'The uniform refund breakdown must be a list of rows';
    END IF;

    v_computed_uniform_refund := 0;
    IF v_uniform_breakdown IS NOT NULL THEN
      FOR v_uniform_row IN SELECT * FROM jsonb_array_elements(v_uniform_breakdown)
      LOOP
        BEGIN
          v_row_months := (v_uniform_row->>'months')::numeric;
        EXCEPTION WHEN OTHERS THEN
          v_row_months := NULL;
        END;
        BEGIN
          v_row_amount := (v_uniform_row->>'amountPerMonth')::numeric;
        EXCEPTION WHEN OTHERS THEN
          v_row_amount := NULL;
        END;

        IF v_row_months IS NULL OR v_row_months IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
           OR v_row_months <= 0 OR v_row_months <> TRUNC(v_row_months)
           OR v_row_amount IS NULL OR v_row_amount IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
           OR v_row_amount <= 0
        THEN
          RAISE EXCEPTION 'Every uniform refund breakdown row must have a whole number of months greater than zero and a positive amount per month';
        END IF;

        v_computed_uniform_refund := v_computed_uniform_refund + CEIL(ROUND(v_row_months * v_row_amount, 6));
      END LOOP;
    END IF;
    v_computed_uniform_refund := CEIL(ROUND(v_computed_uniform_refund, 6));

    BEGIN
      v_final_salary := (p_inputs->>'finalSalary')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_final_salary := NULL;
    END;
    IF v_final_salary IS NULL OR v_final_salary <= 0 THEN
      RAISE EXCEPTION 'Final salary must be greater than zero';
    END IF;

    -- Recompute the two entitlement components this migration now has an
    -- authoritative basis for (effective months via employees.hire_date;
    -- uniform refund via the validated breakdown rows above), mirroring
    -- calculatePensionArrears()/calculateUniformRefundBreakdown() in
    -- terminalDuesEngine.ts exactly, including its rounding rule -- and
    -- reject if the supplied breakdown disagrees, rather than silently
    -- rewriting it.
    v_computed_pension_arrears := CEIL(ROUND(v_effective_months * v_final_salary * 0.1, 6));
    BEGIN
      v_breakdown_pension_arrears := (p_breakdown->>'pensionArrears')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_breakdown_pension_arrears := NULL;
    END;
    IF v_breakdown_pension_arrears IS NULL OR v_breakdown_pension_arrears <> v_computed_pension_arrears THEN
      RAISE EXCEPTION 'The pension arrears in this calculation (%) do not match the validated amount of % for % effective months at a final salary of %', v_breakdown_pension_arrears, v_computed_pension_arrears, v_effective_months, v_final_salary;
    END IF;

    BEGIN
      v_breakdown_uniform_refund := (p_breakdown->>'uniformRefund')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_breakdown_uniform_refund := NULL;
    END;
    IF v_breakdown_uniform_refund IS NULL OR v_breakdown_uniform_refund <> v_computed_uniform_refund THEN
      RAISE EXCEPTION 'The uniform refund in this calculation (%) does not match the validated amount of % derived from its breakdown rows', v_breakdown_uniform_refund, v_computed_uniform_refund;
    END IF;

    -- total_payable consistency: the engine's exact combination formula
    -- (sum the four entitlement components, round up, subtract the notice
    -- deduction, floor at zero) applied to the breakdown's OWN stated
    -- values for the two components not independently re-derived here
    -- (annualLeaveRefund, outstandingSalaryTotal, lessNoticeDeduction --
    -- see migration header comment for why). This does not amount to full
    -- server-side recomputation of those three fields, only to the total
    -- being internally consistent with whatever they claim, plus the two
    -- components above being independently correct.
    v_computed_entitlements := CEIL(ROUND(
      v_computed_pension_arrears
      + coalesce((p_breakdown->>'annualLeaveRefund')::numeric, 0)
      + v_computed_uniform_refund
      + coalesce((p_breakdown->>'outstandingSalaryTotal')::numeric, 0)
    , 6));
    v_computed_total_payable := GREATEST(0, v_computed_entitlements - coalesce((p_breakdown->>'lessNoticeDeduction')::numeric, 0));

    BEGIN
      v_breakdown_total_payable := (p_breakdown->>'totalPayable')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_breakdown_total_payable := NULL;
    END;

    IF v_breakdown_total_payable IS NULL OR v_breakdown_total_payable <> v_computed_total_payable OR p_total_payable <> v_computed_total_payable THEN
      RAISE EXCEPTION 'The total payable in this calculation does not match the validated amount of % derived from its own breakdown', v_computed_total_payable;
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

  -- Safety enforcement: correction reasons, authoritative employment
  -- dates, uniform refund breakdown arithmetic and total_payable
  -- consistency. Runs on the stored draft
  -- (v_row.inputs/v_row.breakdown/v_row.total_payable), not on
  -- client-supplied parameters -- submit_terminal_due_calculation() takes
  -- no inputs of its own, so this closes the bypass where a draft saved
  -- with a mismatch (however it got that way, including a raw INSERT
  -- that never went through update_terminal_due_calculation_draft()) is
  -- promoted into the authoritative terminal_dues workflow without ever
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
    v_uniform_breakdown JSONB;
    v_uniform_row JSONB;
    v_row_months NUMERIC;
    v_row_amount NUMERIC;
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

    v_uniform_breakdown := v_row.inputs->'uniformRefundBreakdown';
    IF v_uniform_breakdown IS NOT NULL AND jsonb_typeof(v_uniform_breakdown) <> 'array' THEN
      RAISE EXCEPTION 'The uniform refund breakdown must be a list of rows';
    END IF;

    v_computed_uniform_refund := 0;
    IF v_uniform_breakdown IS NOT NULL THEN
      FOR v_uniform_row IN SELECT * FROM jsonb_array_elements(v_uniform_breakdown)
      LOOP
        BEGIN
          v_row_months := (v_uniform_row->>'months')::numeric;
        EXCEPTION WHEN OTHERS THEN
          v_row_months := NULL;
        END;
        BEGIN
          v_row_amount := (v_uniform_row->>'amountPerMonth')::numeric;
        EXCEPTION WHEN OTHERS THEN
          v_row_amount := NULL;
        END;

        IF v_row_months IS NULL OR v_row_months IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
           OR v_row_months <= 0 OR v_row_months <> TRUNC(v_row_months)
           OR v_row_amount IS NULL OR v_row_amount IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
           OR v_row_amount <= 0
        THEN
          RAISE EXCEPTION 'Every uniform refund breakdown row must have a whole number of months greater than zero and a positive amount per month';
        END IF;

        v_computed_uniform_refund := v_computed_uniform_refund + CEIL(ROUND(v_row_months * v_row_amount, 6));
      END LOOP;
    END IF;
    v_computed_uniform_refund := CEIL(ROUND(v_computed_uniform_refund, 6));

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

    BEGIN
      v_breakdown_uniform_refund := (v_row.breakdown->>'uniformRefund')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_breakdown_uniform_refund := NULL;
    END;
    IF v_breakdown_uniform_refund IS NULL OR v_breakdown_uniform_refund <> v_computed_uniform_refund THEN
      RAISE EXCEPTION 'The uniform refund in this calculation (%) does not match the validated amount of % derived from its breakdown rows', v_breakdown_uniform_refund, v_computed_uniform_refund;
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
