-- ============================================================
-- MIGRATION: Attendance Automation -- Final safety correction
-- Date: 2026-10-12
-- ============================================================
--
-- SCOPE: restricts attendance_apply_automatic (20261012000000) to
-- writing ONLY a confirmed Present/Late result -- the policy the
-- frontend (Stage C Step 4, attendanceAutomaticApplyService.ts) already
-- enforces client-side, now enforced independently and authoritatively
-- on the server, since a caller invoking this RPC directly (bypassing
-- the frontend entirely) was not bound by that client-side filter at
-- all. PREPARED ONLY -- not applied to STAGING as part of this change;
-- automatic attendance activation remains out of scope regardless (no
-- frontend code calls this RPC).
--
-- ISSUE (independently confirmed by inspecting the installed STAGING
-- function): the original WHERE condition was
--   IF v_calc.status IN ('present', 'late', 'absent') THEN <write>
-- which let the RPC write:
--   (a) an Absent result -- the architecture round's own corrected
--       resolution was "never write an unverified Absent automatically"
--       (Step 1 correction, Step 4's client-side restriction), but the
--       SERVER never enforced this itself; a direct RPC call bypassing
--       the frontend could still write Absent.
--   (b) a Present/Late result with calculation_basis =
--       'check_in_only_provisional' -- credited under the early-export
--       policy pending the checkout window's closure, not yet a
--       complete, confirmed observation. Writing this automatically
--       risks locking in a result that a later, more complete export
--       could still correct to Absent or Late.
--
-- FIX: only v_calc.status IN ('present', 'late') AND v_calc.
-- calculation_basis = 'confirmed' is ever written. Every other result
-- (Absent, Pending, Off, Unassigned, and a provisional Present/Late) is
-- skipped, with a distinct outcome code so a caller can tell a
-- provisional skip apart from a genuine Off/Unassigned/Pending/Absent
-- skip. Everything else is unchanged: tenant isolation
-- (attendance_assert_employee_in_scope), the attendance.auto_apply
-- permission gate, manual-correction precedence and the approved-
-- payroll block (both inside attendance_write_one), and the same-
-- transaction audit log write are all still enforced by the functions
-- this RPC calls -- this migration only narrows WHICH results ever
-- reach that write path.
CREATE OR REPLACE FUNCTION attendance_apply_automatic(p_employee_ids UUID[], p_date_from DATE, p_date_to DATE)
RETURNS TABLE (employee_id UUID, attendance_date DATE, outcome TEXT, old_status TEXT, new_status TEXT, payroll_flag TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_employee_id UUID; v_employee_tenant_id UUID; v_date DATE;
  v_calc RECORD; v_write RECORD;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_date_from > p_date_to THEN RAISE EXCEPTION 'p_date_from must not be after p_date_to'; END IF;
  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL THEN RAISE EXCEPTION 'p_employee_ids must not be empty'; END IF;

  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  -- Deliberately NO legacy role_level bypass here -- a separate
  -- permission by design (confirmed decision), unlike attendance_correct.
  IF NOT (v_is_super_admin OR has_permission('attendance.auto_apply')) THEN
    RAISE EXCEPTION 'Not authorized to run automatic attendance processing' USING ERRCODE = '42501';
  END IF;

  FOREACH v_employee_id IN ARRAY p_employee_ids LOOP
    v_employee_tenant_id := attendance_assert_employee_in_scope(v_tenant_id, v_is_super_admin, v_employee_id);
    v_date := p_date_from;
    WHILE v_date <= p_date_to LOOP
      SELECT * INTO v_calc FROM attendance_resolve_and_calculate(v_employee_id, v_date);
      -- FINAL SAFETY CORRECTION: only a CONFIRMED Present/Late is ever
      -- written automatically. Pending/Off/Unassigned/Absent are never
      -- written (the single rule that makes "never silently converted
      -- into Absent" structural rather than caller-remembered -- now
      -- also covering a genuinely-resolved Absent, not just the
      -- never-write-Pending/Off/Unassigned cases), and a provisional
      -- (check_in_only_provisional) Present/Late is skipped rather than
      -- locked in before the checkout window has genuinely closed.
      IF v_calc.status IN ('present', 'late') AND v_calc.calculation_basis = 'confirmed' THEN
        SELECT * INTO v_write FROM attendance_write_one(
          v_employee_tenant_id, v_employee_id, v_date,
          (CASE v_calc.status WHEN 'present' THEN 'P' WHEN 'late' THEN 'L' END),
          v_calc.calculation_basis, 'automatic', v_caller_id, NULL
        );
        employee_id := v_employee_id; attendance_date := v_date;
        outcome := v_write.outcome; old_status := v_write.old_status; new_status := v_write.new_status; payroll_flag := v_write.payroll_flag;
      ELSIF v_calc.status IN ('present', 'late') THEN
        -- A provisional (not yet 'confirmed') Present/Late -- distinct
        -- outcome code from the genuine Off/Unassigned/Pending/Absent
        -- skips below, so a caller can tell "this will likely resolve
        -- once the checkout window closes" apart from "this is not an
        -- automatic-write case at all".
        employee_id := v_employee_id; attendance_date := v_date;
        outcome := 'skipped_provisional_' || v_calc.status; old_status := NULL; new_status := NULL; payroll_flag := NULL;
      ELSE
        -- Off, Unassigned, Pending, and now also Absent (never written
        -- automatically, regardless of confirmation).
        employee_id := v_employee_id; attendance_date := v_date;
        outcome := 'skipped_' || v_calc.status; old_status := NULL; new_status := NULL; payroll_flag := NULL;
      END IF;
      RETURN NEXT;
      v_date := v_date + 1;
    END LOOP;
  END LOOP;
END;
$$;

-- Unchanged from Step 1 -- restated for a clean final grant state.
REVOKE ALL ON FUNCTION attendance_apply_automatic(UUID[], DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_apply_automatic(UUID[], DATE, DATE) TO authenticated;
