-- ============================================================
-- FIX: compute_payroll_request_snapshot() -- ordinary_deductions_total
-- NULL-skip. Confirmed display-only (see IMPACT below); does not affect
-- any security, validation, approval, or processing gate.
-- Date: 2026-11-04
-- ============================================================
--
-- ROOT CAUSE
-- -----------------------------------------------------------
-- The deductions aggregation in compute_payroll_request_snapshot()
-- (20261030000000, carried forward unchanged by 20261101000000's
-- fingerprint addition) computed:
--   COALESCE(SUM((r->>'paye')::NUMERIC + (r->>'pension')::NUMERIC + (r->>'uniform_deduction')::NUMERIC), 0)
-- If any ONE of paye/pension/uniform_deduction is NULL (or absent) for
-- a given record, the inner addition is NULL for that whole row
-- (NULL + x = NULL in SQL), and SUM() silently skips it -- understating
-- ordinary_deductions_total by that employee's ENTIRE deductions
-- figure, not just the missing field, with no error.
--
-- CONFIRMED live against a disposable Postgres database: three
-- employees with gross deductions 160/85/80 (one with pension = NULL,
-- one with uniform_deduction absent) summed to 160 under the old
-- formula (employees 2 and 3 silently contributed 0) vs. the correct
-- 325 under the fixed formula.
--
-- IMPACT -- CONFIRMED DISPLAY-ONLY
-- -----------------------------------------------------------
-- ordinary_deductions_total is returned in the snapshot JSONB and shown
-- to the Accountant/Admin reviewing a payroll processing request
-- (Payroll.tsx's request-review panel), but it is NEVER compared
-- against anything: approve_payroll_processing_request() and
-- process_approved_payroll_request() (20261101000000) only compare
-- eligible_td_allocation_ids/eligible_td_total (20261030000000) and
-- employee_salary_fingerprint/employee_attendance_fingerprint/
-- payroll_rates_fingerprint (20261101000000) between the stored and a
-- freshly recomputed snapshot -- never ordinary_gross_total,
-- ordinary_deductions_total, or ordinary_net_total. This bug can show a
-- reviewer an understated deductions figure; it cannot cause a wrong
-- approval decision, a wrong processed amount, or any security effect.
-- No other code reads ordinary_deductions_total -- it is written once
-- into the snapshot JSONB and only ever displayed.
--
-- EXISTING DATA
-- -----------------------------------------------------------
-- STAGING has 0 rows in payroll_processing_requests as of this
-- migration (verified immediately beforehand) -- there is no existing
-- stored snapshot to recompute or backfill.
--
-- THE FIX
-- -----------------------------------------------------------
-- Every line below is unchanged from the CURRENT live definition
-- (which already includes 20261101000000's three fingerprint fields)
-- EXCEPT: the deductions aggregation now applies COALESCE to each of
-- paye/pension/uniform_deduction independently before summing them, so
-- one employee's missing optional field no longer zeroes out their
-- entire row's contribution.
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
    -- FIX: COALESCE each optional field independently before summing --
    -- see this migration's header.
    COALESCE(SUM(
      COALESCE((r->>'paye')::NUMERIC, 0)
      + COALESCE((r->>'pension')::NUMERIC, 0)
      + COALESCE((r->>'uniform_deduction')::NUMERIC, 0)
    ), 0),
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
-- Internal helper only -- called from within submit/approve/reject/process_payroll_processing_request() (same SECURITY DEFINER execution context), never directly by a client.

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
-- RUN ONCE / RUN TWICE: idempotent -- CREATE OR REPLACE FUNCTION and the
-- same REVOKE statements every time. No table/column/data change.
--
-- EXISTING DATA: STAGING has 0 rows in payroll_processing_requests as of
-- this migration -- no existing stored snapshot needs recomputation. In
-- an environment with existing requests, a stored financial_snapshot's
-- ordinary_deductions_total would remain whatever was captured under
-- the old (buggy) formula until that specific request is re-submitted
-- -- harmless, since nothing compares that field (see IMPACT above). No
-- backfill is required or provided here.
--
-- ROLLBACK: re-apply 20261101000000_payroll_ordinary_snapshot_integrity.sql's
-- own CREATE OR REPLACE FUNCTION block for compute_payroll_request_snapshot(),
-- verbatim. Safe at any time -- this migration changes no stored data,
-- only a display-only aggregate's NULL-handling.
-- ============================================================
