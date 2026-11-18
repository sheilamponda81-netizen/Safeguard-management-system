-- ============================================================
-- MIGRATION: Phase 2 completion, Task 3 -- mandatory, meaningful
-- reasons for manual attendance corrections, enforced by the database.
-- Date: 2026-11-20
-- ============================================================
--
-- attendance_correct's own existing header comment says "No reason
-- required (confirmed decision)" -- that was a real, deliberate prior
-- decision, not an oversight. This migration is an explicit, current
-- instruction to reverse it, not a unilateral re-litigation: every
-- manual correction must now supply a non-empty reason, enforced here
-- so the UI is never the only thing standing between a careless click
-- and an unexplained attendance change.
--
-- Scope, deliberately narrow: ONLY attendance_correct's own body is
-- edited here (the single-record manual-correction RPC, and the only
-- one the app's UI actually calls -- confirmed by reading every call
-- site). attendance_bulk_correct's own migration/body is NOT touched,
-- but its behavior changes anyway: it delegates each employee/date in
-- its batch to attendance_correct internally (confirmed by reading it
-- -- "SELECT * FROM attendance_correct(v_employee_id, v_date, p_status,
-- p_reason)"), so a NULL/blank shared reason is now rejected there too,
-- transitively. Its own header comment ("One optional shared reason for
-- the whole batch (confirmed decision), no per-row reason") is now
-- stale as a result -- left as-is rather than edited, since this
-- migration's job is attendance_correct, not re-litigating that
-- comment's own separate decision -- but called out explicitly here so
-- a future reader isn't misled by it. This is treated as closing a
-- bypass, not a regression: without it, the bulk RPC would be the one
-- remaining way to write a manual correction with no reason at all; it
-- also has zero current callers in this codebase.
--
-- Never modifies or fabricates a reason for any EXISTING
-- attendance_audit_log row -- this only changes what a NEW call
-- requires going forward; every past correction's reason (including
-- every past NULL one) is left exactly as it is.
--
-- The one caller this affects in practice is Attendance.tsx's
-- quick-click grid cell (processSingleUpdate), which previously called
-- attendance_correct with no reason at all. That now prompts for one
-- before ever reaching this RPC (see that file's own change, same PR)
-- -- the other call site (copying a day's attendance from another
-- month) already supplied an auto-generated reason and needs no change.
-- ============================================================

CREATE OR REPLACE FUNCTION attendance_correct(p_employee_id UUID, p_date DATE, p_status TEXT, p_reason TEXT DEFAULT NULL)
RETURNS TABLE (outcome TEXT, old_status TEXT, new_status TEXT, payroll_flag TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_role_level INTEGER; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_employee_tenant_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_status NOT IN ('P', 'A', 'L', 'LV', 'SL', '-') THEN RAISE EXCEPTION 'Invalid status %', p_status; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to correct attendance' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id, role_level, is_super_admin, is_active INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active
  FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR COALESCE(v_role_level, 99) <= 3 OR has_permission('attendance.create') OR has_permission('attendance.edit')) THEN
    RAISE EXCEPTION 'Not authorized to edit attendance' USING ERRCODE = '42501';
  END IF;

  v_employee_tenant_id := attendance_assert_employee_in_scope(v_tenant_id, v_is_super_admin, p_employee_id);

  IF p_status IN ('P', 'A', 'L') THEN
    RETURN QUERY SELECT * FROM attendance_write_one(v_employee_tenant_id, p_employee_id, p_date, p_status, NULL, 'manual', v_caller_id, p_reason);
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext(p_employee_id::text || '|' || p_date::text));
    DECLARE
      v_old_status TEXT; v_old_basis TEXT; v_payroll_exists BOOLEAN; v_payroll_approved BOOLEAN; v_month TEXT;
    BEGIN
      SELECT status, calculation_basis INTO v_old_status, v_old_basis FROM attendance WHERE employee_id = p_employee_id AND date = p_date;
      IF v_old_status = p_status THEN
        RETURN QUERY SELECT 'skipped_no_change'::TEXT, v_old_status, v_old_status, NULL::TEXT;
        RETURN;
      END IF;
      v_month := to_char(p_date, 'YYYY-MM');
      SELECT EXISTS(SELECT 1 FROM payroll WHERE employee_id = p_employee_id AND month = v_month),
             EXISTS(SELECT 1 FROM payroll WHERE employee_id = p_employee_id AND month = v_month AND approval_status = 'approved')
        INTO v_payroll_exists, v_payroll_approved;

      INSERT INTO attendance (tenant_id, employee_id, date, status, calculation_basis, source)
      VALUES (v_employee_tenant_id, p_employee_id, p_date, p_status, NULL, 'manual')
      ON CONFLICT (employee_id, date) DO UPDATE SET status = EXCLUDED.status, calculation_basis = NULL, source = 'manual';

      INSERT INTO attendance_audit_log (tenant_id, employee_id, attendance_date, old_status, new_status, old_calculation_basis, new_calculation_basis, changed_by, change_source, reason)
      VALUES (v_employee_tenant_id, p_employee_id, p_date, v_old_status, p_status, v_old_basis, NULL, v_caller_id, 'manual', p_reason);

      IF v_payroll_exists THEN
        INSERT INTO attendance_reconciliation_flags (tenant_id, employee_id, attendance_date, flagged_reason)
        VALUES (v_employee_tenant_id, p_employee_id, p_date, CASE WHEN v_payroll_approved THEN 'payroll_approved' ELSE 'payroll_processed_pending' END);
      END IF;

      RETURN QUERY SELECT 'written'::TEXT, v_old_status, p_status, (CASE WHEN v_payroll_approved THEN 'approved' WHEN v_payroll_exists THEN 'processed_pending' ELSE NULL END)::TEXT;
    END;
  END IF;
END;
$$;
