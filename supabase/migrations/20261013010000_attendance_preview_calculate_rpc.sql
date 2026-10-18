-- ============================================================
-- MIGRATION: Attendance Automation -- Stage C, Step 3 read-only preview RPC
-- Date: 2026-10-12
-- ============================================================
--
-- SCOPE: a NEW, read-only RPC that lets Attendance Review show what the
-- SERVER-side engine (attendance_resolve_and_calculate, corrected by
-- 20261013000000) would calculate, for comparison against the existing
-- client-side Stage A/B JavaScript preview. PREPARED ONLY -- not applied
-- to STAGING as part of this change. This RPC NEVER writes anything --
-- no INSERT/UPDATE/DELETE anywhere in its body -- and is entirely
-- separate from attendance_apply_automatic (the write path, still never
-- called by any frontend code, and gated by the separate
-- attendance.auto_apply permission).
--
-- Deliberately does NOT reuse attendance_assert_employee_in_scope: that
-- helper takes a `FOR UPDATE` row lock on the employee row, appropriate
-- for a write path that is about to mutate attendance for that employee,
-- but wrong for a pure read-only preview that never writes -- it would
-- contend with real concurrent writers for no reason. Uses the same
-- underlying employee_region_allowed() check without the lock instead.
CREATE OR REPLACE FUNCTION attendance_preview_calculate(p_employee_ids UUID[], p_date_from DATE, p_date_to DATE)
RETURNS TABLE (employee_id UUID, attendance_date DATE, status TEXT, calculation_basis TEXT, check_in_at TIMESTAMPTZ, check_out_at TIMESTAMPTZ, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_employee_id UUID; v_date DATE;
  v_calc RECORD;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_date_from > p_date_to THEN RAISE EXCEPTION 'p_date_from must not be after p_date_to'; END IF;
  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL THEN RAISE EXCEPTION 'p_employee_ids must not be empty'; END IF;

  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  -- Gated identically to the Attendance Review tab's own visibility
  -- permission (AttendancePage.tsx) -- this RPC only ever computes and
  -- returns a result for READ-ONLY comparison; it deliberately does not
  -- require attendance.auto_apply, which guards the wholly separate,
  -- still-unused action of actually WRITING an automatic result.
  IF NOT (v_is_super_admin OR has_permission('attendance.map_hikcentral_persons')) THEN
    RAISE EXCEPTION 'Not authorized to preview automatic attendance calculations' USING ERRCODE = '42501';
  END IF;

  FOREACH v_employee_id IN ARRAY p_employee_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = v_employee_id) THEN
      RAISE EXCEPTION 'No such employee: %', v_employee_id;
    END IF;
    IF NOT employee_region_allowed(v_employee_id) THEN
      RAISE EXCEPTION 'Employee % is outside the caller''s authorized tenant/region', v_employee_id USING ERRCODE = '42501';
    END IF;

    v_date := p_date_from;
    WHILE v_date <= p_date_to LOOP
      SELECT * INTO v_calc FROM attendance_resolve_and_calculate(v_employee_id, v_date);
      employee_id := v_employee_id; attendance_date := v_date;
      status := v_calc.status; calculation_basis := v_calc.calculation_basis;
      check_in_at := v_calc.check_in_at; check_out_at := v_calc.check_out_at; reason := v_calc.reason;
      RETURN NEXT;
      v_date := v_date + 1;
    END LOOP;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION attendance_preview_calculate(UUID[], DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_preview_calculate(UUID[], DATE, DATE) TO authenticated;
