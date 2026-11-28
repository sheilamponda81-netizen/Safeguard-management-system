-- PROPOSAL -- NOT APPLIED. Written for review alongside the Salary
-- Advances + Payroll & Payslip Financial Transparency audit (PR #82);
-- per that task's explicit instructions this has deliberately NOT been
-- run against any database (no mcp__Supabase__apply_migration call was
-- made for this file). An authorized reviewer should apply it only after
-- independently re-diffing process_payroll_batch's body against its
-- then-current production definition
-- (pg_get_functiondef('process_payroll_batch'::regproc)), in case
-- something else has changed it since this file was written.
--
-- SUPERSEDES the earlier draft of this proposal
-- (20261204000000_payroll_batch_employee_deductions_snapshot.sql,
-- removed by this same commit), which an independent review correctly
-- rejected: that draft inserted a BLANK, all-zero `employee_deductions`
-- row whenever none existed, and the itemization code
-- (deriveItemizedAttendanceDeduction(), payrollDeductionBreakdown.ts)
-- treats the mere EXISTENCE of an employee_deductions row as proof that
-- the bundled uniform/attendance total can be decomposed. A blank
-- default row is not evidence of zero attendance deductions -- it is an
-- assumption dressed as a record, and could falsely relabel a genuine
-- absence/late/lecture/appearance charge as 100% uniform. That violates
-- this project's central rule: every financial explanation must be
-- grounded in the actual processed data, never fabricated.
--
-- ROOT CAUSE (unchanged from the original investigation, see PR #82's
-- report): `employee_deductions` rows are only ever created by an HR
-- user manually opening Attendance.tsx for ONE employee at a time and
-- clicking Save -- never automatically, for everyone, at the moment
-- their payroll is actually committed. The bundled
-- `payroll.uniform_deduction` total IS always genuinely composed from
-- real, known inputs at the moment of processing (live attendance-table
-- counts x the live configured per-day rates, plus lecture/appearance
-- from any existing employee_deductions row) -- calculateLivePayroll()
-- (src/utils/payrollCalculations.ts) computes exactly this client-side
-- to produce the number that gets submitted. The gap is that this
-- composition is never PERSISTED per-category for most employees, only
-- the bundled total is.
--
-- CORRECTED FIX: capture the genuine composition, not a guess, in a NEW,
-- purpose-built, append-only table (`payroll_deduction_snapshots`) --
-- never in `employee_deductions` itself, which stays exclusively HR's
-- own manually-entered record, completely untouched by this migration
-- (no insert, no update, no read-modify-write) in either direction. This
-- sidesteps the "silently overwriting HR's record" risk entirely by
-- construction rather than by an ON CONFLICT DO NOTHING guard, and keeps
-- the two provenances (HR manual entry vs. system-captured-at-processing)
-- unambiguous. Design:
--
--   * absent_days/late_days are counted LIVE, inside this same
--     transaction, directly from the `attendance` table for this exact
--     employee/month (the same source get_payroll_attendance_counts()
--     and calculateLivePayroll() already treat as authoritative for an
--     unprocessed month) -- never assumed, never defaulted to zero
--     without counting. absent_deduction/late_deduction are then that
--     count times the LIVE configured absent_day_deduction/
--     late_day_deduction rate read from system_settings in this same
--     transaction (the exact rate this processing run is actually
--     charging), frozen into the snapshot row at this moment so a later
--     rate change can never retroactively relabel it.
--   * lecture_deduction/appearance_deduction are read from the existing
--     employee_deductions row for this employee/month, if one exists,
--     else 0 -- this is NOT a fabricated zero: per
--     payrollDeductionBreakdown.ts's own header, lecture/appearance have
--     no other source anywhere in this schema (no rate, no live table);
--     an HR-entered employee_deductions row is the ONLY mechanism that
--     can ever produce a non-zero value for either, so the absence of
--     one genuinely means zero, exactly as calculateLivePayroll() itself
--     already assumes.
--   * uniform (the uniform-only remainder) = the submitted bundled
--     uniform_deduction minus the four categories above. If that
--     remainder would be negative beyond a 1-currency-unit rounding
--     tolerance -- i.e. the four evidenced categories alone exceed what
--     was actually charged -- processing is REFUSED for that employee
--     (fail closed: nothing is committed, matching this function's
--     existing PAYE/pension consistency-check pattern) rather than
--     silently clamping or guessing.
--   * every category row (including a genuine, evidenced zero) is
--     written with its own quantity, rate, source, and a
--     calculation_context JSONB for traceability -- see the table DDL
--     below.
--   * tied to payroll_id with ON DELETE CASCADE: reprocessing a NOT-YET-
--     approved month (this function's existing DELETE-then-reinsert of
--     `payroll` rows, unchanged) cascade-deletes that payroll row's old
--     snapshot rows automatically and replaces them with a fresh
--     computation -- no stale rows, no manual cleanup. Once a month is
--     approved, this function's existing approved-month guard already
--     refuses to reprocess it at all, so its snapshot rows become
--     permanently immutable at that point, same as the payroll row they
--     describe. August/September/October 2026 and any other
--     already-processed month are untouched by this migration -- it only
--     ever runs for a FUTURE call to process_payroll_batch(), and this
--     migration does not backfill anything.
--   * KNOWN, PRE-EXISTING precedence this migration does not change: for
--     a not-yet-processed month, the committed calculation always uses
--     LIVE attendance-table counts for absent/late, never whatever an HR
--     user may have separately, manually entered into employee_deductions
--     for the same employee/month ahead of time (calculateLivePayroll()
--     already does this today). So a pre-existing employee_deductions
--     row's own absent_deduction/late_deduction can legitimately differ
--     from what this snapshot just captured -- that is not evidence of
--     corruption, it is this system's own established rule about which
--     source governs the actual charge. Per item 10 of the review this
--     migration addresses ("checked... instead of silently accepting"),
--     any such difference beyond tolerance is recorded, explicitly and
--     visibly, in this processing run's own audit_logs entry
--     (employeeDeductionSnapshotConflicts) -- never silently dropped --
--     but does NOT block processing, since blocking on an expected,
--     by-design difference would make routine HR pre-entry defeat payroll
--     processing entirely. Redesigning that precedence itself is out of
--     scope here ("do not redesign the entire payroll engine").
--
-- UPDATE (end-to-end completion pass): this table is now wired into
-- Payroll.tsx and Payslips.tsx (see payrollDeductionSnapshotResolution.ts)
-- -- a payroll row with a snapshot uses it as the highest-priority
-- source, tied to that EXACT payroll_id (never mixed across runs); a
-- payroll row with no snapshot (any month processed before this
-- migration existed) falls back to the pre-existing employee_deductions-
-- based logic unchanged; a payroll row with neither stays the existing
-- honest "not itemized" fallback. See that TS module's own header.
--
-- UPDATE (end-to-end completion pass): the uniform category is no
-- longer a blind remainder (submitted total minus the four evidenced
-- categories) -- a remainder is not proof it is genuinely a uniform
-- charge. It is now independently cross-checked against the employee's
-- own uniform_deduction override and position.requires_uniform, BOTH
-- read live in this same transaction and frozen into the snapshot (never
-- re-read at display time, so this never becomes "today's settings
-- explaining historical payroll"). Only when that independent figure
-- agrees with the remainder is it recorded as 'uniform'; otherwise the
-- leftover is recorded as 'unallocated' -- explicitly labeled unresolved
-- evidence, never presented as a legitimate deduction type, and never
-- silently absorbed into any other category. See the per-employee logic
-- below for the exact rule.
--
-- UPDATE (end-to-end completion pass): the unrestricted "Super admins
-- can delete payroll deduction snapshots" policy below has been REMOVED
-- (see the DDL below). payroll_deduction_snapshots now has NO delete
-- policy of any kind -- RLS defaults to deny for every role subject to
-- it, so no ordinary UI/database access (super-admin included) can
-- directly erase a snapshot row. The only deletion path left is the
-- ON DELETE CASCADE fired when process_payroll_batch() deletes a
-- NOT-YET-approved month's payroll row to reprocess it -- that statement
-- runs inside this SECURITY DEFINER function as its owning role, which
-- is exempt from RLS by default (RLS applies to the invoking role for an
-- ordinary table, not to a SECURITY DEFINER function's owner, unless
-- FORCE ROW LEVEL SECURITY is set, which this migration does not set),
-- so the cascade needs no policy of its own -- and that DELETE is
-- already unreachable for an approved month (the v_approved_count check
-- earlier in this function). Verified empirically: see
-- payrollDeductionSnapshotIntegration.test.ts's "K"/"L" cases.

CREATE TABLE IF NOT EXISTS payroll_deduction_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payroll_id UUID NOT NULL REFERENCES payroll(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  -- 'unallocated' is NOT a deduction type -- it is this snapshot's own
  -- honest admission that part of the bundled total could not be
  -- independently attributed to any evidenced category. See
  -- 'unresolved_remainder' below and this migration's header.
  category TEXT NOT NULL CHECK (category IN ('uniform', 'absence', 'late', 'lecture', 'appearance', 'unallocated')),
  amount NUMERIC NOT NULL,
  -- Day count for absence/late; NULL for uniform/lecture/appearance,
  -- which are not quantity x rate in this schema.
  quantity NUMERIC,
  -- Per-unit rate actually applied (live absent_day_deduction/
  -- late_day_deduction at the moment of processing); NULL where this
  -- category is not rate x quantity (uniform is a flat configured
  -- amount; lecture/appearance are HR-entered flat amounts).
  rate NUMERIC,
  -- Where this category's amount came from, for the drill-down UI to
  -- cite as evidence -- never invented wording, one of a fixed set.
  source TEXT NOT NULL CHECK (source IN (
    'live_attendance_count', 'employee_deductions_row', 'uniform_rate_config', 'no_record_zero', 'unresolved_remainder'
  )),
  calculation_context JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payroll_id, category)
);

CREATE INDEX IF NOT EXISTS idx_payroll_deduction_snapshots_employee_month
  ON payroll_deduction_snapshots (employee_id, month);
CREATE INDEX IF NOT EXISTS idx_payroll_deduction_snapshots_tenant
  ON payroll_deduction_snapshots (tenant_id);

ALTER TABLE payroll_deduction_snapshots ENABLE ROW LEVEL SECURITY;

-- Mirrors the existing "Payroll: view within tenant+region, action or
-- legacy permitted" SELECT policy on `payroll` itself exactly (same
-- audience: whoever may see a payroll row may see what it's made of) --
-- reused rather than inventing a new authorization rule.
CREATE POLICY "payroll_deduction_snapshots_view_tenant_region_permitted"
  ON payroll_deduction_snapshots FOR SELECT
  USING (
    is_current_user_active() AND (
      is_super_admin() OR (
        tenant_id = get_current_tenant_id()
        AND employee_region_allowed(employee_id)
        AND (current_user_role_level() <= 2 OR has_permission('payroll.view'))
      )
    )
  );

-- No INSERT/UPDATE/DELETE policy of ANY kind, for ANY role -- every row
-- is written only by process_payroll_batch() below (SECURITY DEFINER,
-- exempt from RLS as the function's owning role), so this table can
-- never be hand-edited, or hand-deleted, by ordinary UI/database access
-- (including an otherwise-unrestricted super-admin DELETE grant, which
-- an earlier draft of this migration had and which this completion pass
-- removes) -- matching this migration's own "future changes... cannot
-- alter historical payslip explanations" requirement, and "an approved
-- payroll's financial explanation must not be independently erased or
-- altered". The only path that ever removes a row is the ON DELETE
-- CASCADE fired by process_payroll_batch() deleting a NOT-YET-approved
-- month's own payroll row to reprocess it -- see this migration's header
-- for why that path needs no RLS grant of its own, and is already
-- unreachable for an approved month.

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
  -- ===== NEW (this migration): deduction snapshot capture =====
  v_absent_rate_raw TEXT;
  v_late_rate_raw TEXT;
  v_uniform_default_raw TEXT;
  v_live_absent_rate NUMERIC;
  v_live_late_rate NUMERIC;
  v_live_uniform_rate NUMERIC;
  v_month_start DATE;
  v_month_end DATE;
  v_submitted_uniform_total NUMERIC;
  v_live_absent_days INTEGER;
  v_live_late_days INTEGER;
  v_absent_deduction NUMERIC;
  v_late_deduction NUMERIC;
  v_existing_deduction RECORD;
  v_lecture_deduction NUMERIC;
  v_appearance_deduction NUMERIC;
  v_uniform_only NUMERIC;
  v_category_sum NUMERIC;
  v_snapshot_conflicts JSONB := '[]'::JSONB;
  -- Uniform-remainder verification (see this migration's header) --
  -- never trust a bare remainder as proof of a genuine uniform charge.
  v_employee_uniform_override NUMERIC;
  v_position_requires_uniform BOOLEAN;
  v_live_uniform_only NUMERIC;
  v_unallocated NUMERIC;
  -- Preserves the remainder exactly as first computed, before either
  -- tolerance branch below resets it to 0 -- so a sub-tolerance amount
  -- is still independently auditable in calculation_context even though
  -- it is, by design, too small to itemize on its own. Never used for
  -- any committed amount; audit-trail only.
  v_raw_remainder NUMERIC;
  v_unresolved_uniform JSONB := '[]'::JSONB;
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
    MAX(CASE WHEN key = 'pension_employee_rate' THEN value END),
    MAX(CASE WHEN key = 'absent_day_deduction' THEN value END),
    MAX(CASE WHEN key = 'late_day_deduction' THEN value END),
    MAX(CASE WHEN key = 'uniform_deduction_default' THEN value END)
  INTO v_paye_rate_raw, v_paye_threshold_raw, v_pension_rate_raw, v_absent_rate_raw, v_late_rate_raw, v_uniform_default_raw
  FROM system_settings
  WHERE tenant_id = v_tenant_id AND key IN ('paye_rate', 'paye_threshold', 'pension_employee_rate', 'absent_day_deduction', 'late_day_deduction', 'uniform_deduction_default');

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

  -- NEW: absent/late rates for the snapshot capture below. Unlike PAYE/
  -- pension above, a missing or non-numeric rate here does NOT block
  -- ordinary payroll processing -- it only means this run's deduction
  -- snapshot falls back to treating the live rate as unavailable, in
  -- which case the snapshot step is skipped for this run (fail closed on
  -- the EXPLANATION, never on the payroll itself; see below).
  v_live_absent_rate := CASE WHEN v_absent_rate_raw ~ '^[0-9]+(\.[0-9]+)?$' THEN v_absent_rate_raw::NUMERIC ELSE NULL END;
  v_live_late_rate := CASE WHEN v_late_rate_raw ~ '^[0-9]+(\.[0-9]+)?$' THEN v_late_rate_raw::NUMERIC ELSE NULL END;
  v_live_uniform_rate := CASE WHEN v_uniform_default_raw ~ '^[0-9]+(\.[0-9]+)?$' THEN v_uniform_default_raw::NUMERIC ELSE NULL END;

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
  -- payroll_deduction_snapshots rows for the deleted payroll rows above
  -- cascade-delete automatically (ON DELETE CASCADE) -- no separate
  -- cleanup needed; see this migration's own header for why that's safe.

  -- NEW: this run's one-time snapshot inputs that don't vary per employee.
  v_month_start := to_date(p_month || '-01', 'YYYY-MM-DD');
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 day')::date;

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

    v_submitted_uniform_total := ROUND(COALESCE((v_record->>'uniform_deduction')::NUMERIC, 0), 2);

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
      v_submitted_uniform_total,
      v_advance_deduction, v_refund_amount,
      v_base_net_pay - v_advance_deduction + v_refund_amount,
      NOW(), 'pending', NULL, NULL, NULL, NOW()
    )
    RETURNING id INTO v_new_payroll_id;

    -- ===== NEW (this migration): capture the genuine deduction
    -- composition behind the bundled uniform_deduction total just
    -- committed above -- see this migration's own header for the full
    -- design and why each source is NOT a fabrication. Skipped entirely
    -- (snapshot step only, payroll itself is unaffected either way) when
    -- this tenant's absent/late rates aren't configured -- fail closed on
    -- the EXPLANATION, never invent a rate to force a snapshot through.
    IF v_live_absent_rate IS NOT NULL AND v_live_late_rate IS NOT NULL THEN
      SELECT
        COUNT(*) FILTER (WHERE att.status = 'A')::INTEGER,
        COUNT(*) FILTER (WHERE att.status = 'L')::INTEGER
      INTO v_live_absent_days, v_live_late_days
      FROM employees e
      LEFT JOIN attendance att
        ON att.employee_id = e.id AND att.tenant_id = e.tenant_id AND att.date BETWEEN v_month_start AND v_month_end
      WHERE e.id = v_employee_id
      GROUP BY e.id;

      v_live_absent_days := COALESCE(v_live_absent_days, 0);
      v_live_late_days := COALESCE(v_live_late_days, 0);
      v_absent_deduction := ROUND(v_live_absent_days * v_live_absent_rate, 2);
      v_late_deduction := ROUND(v_live_late_days * v_live_late_rate, 2);

      SELECT * INTO v_existing_deduction
      FROM employee_deductions WHERE employee_id = v_employee_id AND month = p_month;

      v_lecture_deduction := COALESCE(v_existing_deduction.lecture_deduction, 0);
      v_appearance_deduction := COALESCE(v_existing_deduction.appearance_deduction, 0);

      v_category_sum := v_absent_deduction + v_late_deduction + v_lecture_deduction + v_appearance_deduction;

      IF v_category_sum > v_submitted_uniform_total + 1 THEN
        RAISE EXCEPTION 'Refusing to process payroll for employee %: the evidenced absence (%) + late (%) + lecture (%) + appearance (%) deductions for % total %, which exceeds the submitted uniform/attendance total of % -- nothing has been applied and the transaction has been rolled back. This may indicate a stale or miscalculated submission.',
          v_employee_id, v_absent_deduction, v_late_deduction, v_lecture_deduction, v_appearance_deduction, p_month, v_category_sum, v_submitted_uniform_total;
      END IF;

      -- Uniform verification: a bare remainder (submitted bundled total
      -- minus the four evidenced categories) is NOT by itself proof that
      -- the leftover is genuinely a uniform charge -- see this
      -- migration's header. Cross-check it against the employee's own
      -- uniform_deduction override and the eligibility of their position
      -- (positions.requires_uniform), BOTH read live, right now, inside
      -- this same transaction -- the exact inputs calculateLivePayroll()
      -- itself would have used to build the bundled total just
      -- committed. Frozen here, so a later change to either can never
      -- retroactively relabel this month's explanation ("today's
      -- settings explaining historical payroll").
      SELECT e.uniform_deduction, COALESCE(pos.requires_uniform, true)
        INTO v_employee_uniform_override, v_position_requires_uniform
      FROM employees e
      LEFT JOIN positions pos ON pos.name = e.position AND pos.tenant_id = e.tenant_id
      WHERE e.id = v_employee_id;

      v_live_uniform_only := CASE
        WHEN NOT COALESCE(v_position_requires_uniform, true) THEN 0
        WHEN v_employee_uniform_override IS NOT NULL THEN v_employee_uniform_override
        WHEN v_live_uniform_rate IS NOT NULL THEN v_live_uniform_rate
        ELSE NULL -- no override on record and no tenant default configured -- cannot determine
      END;

      v_unallocated := GREATEST(0, v_submitted_uniform_total - v_category_sum);
      v_raw_remainder := v_unallocated;

      IF v_unallocated <= 1 THEN
        -- Nothing left over to explain either way -- the four evidenced
        -- categories alone already account for the bundled total.
        v_uniform_only := 0;
        v_unallocated := 0;
      ELSIF v_live_uniform_only IS NOT NULL AND ABS(v_live_uniform_only - v_unallocated) <= 1 THEN
        -- The independently-derived figure agrees with the leftover --
        -- safe to record as a genuine, verified Uniform charge.
        v_uniform_only := v_live_uniform_only;
        v_unallocated := 0;
      ELSE
        -- Cannot independently verify this remainder is genuinely
        -- uniform (no determinable live figure, or it disagrees with the
        -- leftover beyond rounding) -- record it honestly as unresolved.
        -- NEVER labeled Uniform, and never silently absorbed into any
        -- other category.
        v_uniform_only := 0;
        v_unresolved_uniform := v_unresolved_uniform || jsonb_build_object(
          'employee_id', v_employee_id,
          'unallocatedAmount', v_unallocated,
          'liveUniformOnly', v_live_uniform_only
        );
      END IF;

      -- A pre-existing employee_deductions row's own absent/late figures
      -- can legitimately differ from what was just counted live -- see
      -- this migration's header on precedence. Recorded, never silent.
      IF v_existing_deduction.employee_id IS NOT NULL AND (
        ABS(COALESCE(v_existing_deduction.absent_deduction, 0) - v_absent_deduction) > 1
        OR ABS(COALESCE(v_existing_deduction.late_deduction, 0) - v_late_deduction) > 1
      ) THEN
        v_snapshot_conflicts := v_snapshot_conflicts || jsonb_build_object(
          'employee_id', v_employee_id,
          'existing_absent_deduction', v_existing_deduction.absent_deduction,
          'existing_late_deduction', v_existing_deduction.late_deduction,
          'live_absent_deduction', v_absent_deduction,
          'live_late_deduction', v_late_deduction
        );
      END IF;

      INSERT INTO payroll_deduction_snapshots (tenant_id, payroll_id, employee_id, month, category, amount, quantity, rate, source, calculation_context)
      VALUES
        (v_tenant_id, v_new_payroll_id, v_employee_id, p_month, 'uniform', v_uniform_only, NULL, NULL, 'uniform_rate_config',
          jsonb_build_object(
            'bundledTotal', v_submitted_uniform_total,
            'employeeOverride', v_employee_uniform_override,
            'positionRequiresUniform', v_position_requires_uniform,
            'liveDefaultRate', v_live_uniform_rate,
            -- Audit trail only -- never a committed amount. The raw
            -- remainder as first computed, before either tolerance
            -- branch above reset it. Lets a reviewer confirm a
            -- sub-1-Kwacha amount was genuinely negligible rounding and
            -- not quietly lost: it is always visible here even on the
            -- two paths (v_unallocated<=1, or it agreed with
            -- v_live_uniform_only within tolerance) that do not write a
            -- separate 'unallocated' row for it.
            'rawRemainderBeforeTolerance', v_raw_remainder
          )),
        (v_tenant_id, v_new_payroll_id, v_employee_id, p_month, 'absence', v_absent_deduction, v_live_absent_days, v_live_absent_rate, 'live_attendance_count', jsonb_build_object('rateSettingKey', 'absent_day_deduction')),
        (v_tenant_id, v_new_payroll_id, v_employee_id, p_month, 'late', v_late_deduction, v_live_late_days, v_live_late_rate, 'live_attendance_count', jsonb_build_object('rateSettingKey', 'late_day_deduction')),
        (v_tenant_id, v_new_payroll_id, v_employee_id, p_month, 'lecture', v_lecture_deduction, NULL, NULL,
          CASE WHEN v_existing_deduction.employee_id IS NOT NULL THEN 'employee_deductions_row' ELSE 'no_record_zero' END,
          jsonb_build_object('lectureMissed', v_existing_deduction.lecture_missed)),
        (v_tenant_id, v_new_payroll_id, v_employee_id, p_month, 'appearance', v_appearance_deduction, NULL, NULL,
          CASE WHEN v_existing_deduction.employee_id IS NOT NULL THEN 'employee_deductions_row' ELSE 'no_record_zero' END,
          '{}'::JSONB);

      -- 'unallocated' is written ONLY when there is genuinely unresolved
      -- money left over -- never a zero-value row (nothing to flag) and
      -- never folded into 'uniform' above.
      IF v_unallocated > 1 THEN
        INSERT INTO payroll_deduction_snapshots (tenant_id, payroll_id, employee_id, month, category, amount, quantity, rate, source, calculation_context)
        VALUES (v_tenant_id, v_new_payroll_id, v_employee_id, p_month, 'unallocated', v_unallocated, NULL, NULL, 'unresolved_remainder',
          jsonb_build_object('reason', 'remainder could not be independently verified as a genuine uniform charge'));
      END IF;
    END IF;

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
      'status', 'pending_approval',
      'employeeDeductionSnapshotConflicts', v_snapshot_conflicts,
      'employeeDeductionSnapshotUnresolvedUniform', v_unresolved_uniform
    )
  );

  RETURN jsonb_build_object(
    'success', true, 'month', p_month, 'deletedCount', v_deleted_count,
    'insertedCount', v_inserted_count, 'advanceDeductionsApplied', v_advance_deductions_applied,
    'employeeDeductionSnapshotConflicts', v_snapshot_conflicts,
    'employeeDeductionSnapshotUnresolvedUniform', v_unresolved_uniform
  );
END;
$function$;
