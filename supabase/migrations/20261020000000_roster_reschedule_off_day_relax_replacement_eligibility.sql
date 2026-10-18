-- ============================================================
-- MIGRATION: Roster Management -- Stage C Step 12: relax
-- roster_reschedule_off_day's replacement-date eligibility rule.
-- Date: 2026-10-20
-- ============================================================
--
-- BUSINESS CONTEXT: Stage C Step 12 introduces a weekday-based
-- "Temporary Off-day change" workflow (e.g. "Wednesday Off -> Sunday
-- Off for three weeks") built on top of this existing RPC, called once
-- per affected week. Since Stage C Step 6B, most employees now also
-- carry a recurring Day/Night shift pattern (roster_shift_patterns)
-- covering every date that is not their Off weekday -- so the
-- REPLACEMENT (new Off) date in a realistic swap is, by design, a
-- perfectly normal WORKING day (it resolves 'day' or 'night'), not
-- 'unassigned'. The previous rule --
--   IF v_replacement_resolved IS DISTINCT FROM 'unassigned' THEN RAISE
-- -- was written before recurring shift patterns existed everywhere and
-- made the realistic case (swapping Off onto an already-scheduled
-- working day) impossible to complete: every such call was rejected
-- with "the replacement date must be unassigned, not already Off, Day,
-- or Night", even though converting a normal working day into the new
-- Off day for one week is exactly the intended operation.
--
-- THE FIX: reject the replacement date ONLY when it is already Off
-- (which would be a meaningless or rest-reducing no-op -- the original
-- date's rest would convert to work with no new rest gained in
-- exchange, the exact risk this check exists to prevent). A replacement
-- date that resolves 'day', 'night', or 'unassigned' is now accepted.
-- This is the ONLY change in this migration -- every other validation
-- (the original date must genuinely resolve 'off', the Night-to-Day
-- adjacency hard block, the rolling-seven-day rest check around BOTH
-- dates with no override path, tenant/permission checks, append-only
-- history, atomicity) is byte-for-byte identical to the currently
-- installed version (20261015000000, Part 7). Same signature (UUID,
-- DATE, DATE, TEXT, TEXT) -- no DROP needed, CREATE OR REPLACE is
-- sufficient since no parameter is renamed or reordered.
-- ============================================================

CREATE OR REPLACE FUNCTION roster_reschedule_off_day(
  p_employee_id UUID,
  p_original_off_date DATE,
  p_replacement_off_date DATE,
  p_original_date_shift TEXT,
  p_correction_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_employee_tenant_id UUID;
  v_original_resolved TEXT;
  v_replacement_resolved TEXT;
  v_existing_id UUID;
  v_violation RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF is_current_user_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;
  IF (is_super_admin() OR is_business_admin()) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only Admin may reschedule roster Off days' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user' USING ERRCODE = '42501';
  END IF;

  IF p_original_off_date IS NULL OR p_replacement_off_date IS NULL THEN
    RAISE EXCEPTION 'Both the original Off date and the replacement Off date are required' USING ERRCODE = '22023';
  END IF;
  IF p_original_off_date = p_replacement_off_date THEN
    RAISE EXCEPTION 'The replacement Off date must be different from the original Off date' USING ERRCODE = '22023';
  END IF;
  IF p_original_date_shift IS NULL OR p_original_date_shift NOT IN ('day', 'night') THEN
    RAISE EXCEPTION 'original_date_shift must be day or night' USING ERRCODE = '22023';
  END IF;
  IF p_correction_reason IS NULL OR btrim(p_correction_reason) = '' THEN
    RAISE EXCEPTION 'A correction_reason is required to reschedule an Off day' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = p_employee_id FOR UPDATE;
  IF v_employee_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Employee % not found', p_employee_id USING ERRCODE = '22023';
  END IF;
  IF v_employee_tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'Employee % does not belong to your tenant', p_employee_id USING ERRCODE = '42501';
  END IF;

  v_original_resolved := roster_resolve_schedule(p_employee_id, p_original_off_date);
  IF v_original_resolved IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'Employee % is not currently scheduled Off on % (it currently resolves to "%") -- rescheduling requires a genuine existing Off date', p_employee_id, p_original_off_date, v_original_resolved USING ERRCODE = '23514';
  END IF;

  -- Stage C Step 12 CHANGE: reject ONLY an already-Off replacement date
  -- (see this migration's header). A normal working day ('day'/'night')
  -- or an 'unassigned' date are both valid targets now.
  v_replacement_resolved := roster_resolve_schedule(p_employee_id, p_replacement_off_date);
  IF v_replacement_resolved = 'off' THEN
    RAISE EXCEPTION 'Employee % replacement date % is already Off -- choose a date that is not already Off (a normal working day or an unassigned date is fine)', p_employee_id, p_replacement_off_date USING ERRCODE = '23514';
  END IF;

  -- Night-to-Day adjacency for the NEW shift being placed on the original
  -- date -- the identical hard-block rule roster_assign_dates enforces.
  -- Checked via roster_resolve_schedule (not a raw roster_date_assignments
  -- lookup) so a recurring-pattern-derived neighbor is caught exactly the
  -- same as a dated one; no override parameter exists for it here either.
  IF p_original_date_shift = 'day' THEN
    IF roster_resolve_schedule(p_employee_id, p_original_off_date - 1) = 'night' THEN
      RAISE EXCEPTION 'Employee % has a Night shift resolved on % -- a Day shift cannot start the following morning', p_employee_id, (p_original_off_date - 1) USING ERRCODE = '23514';
    END IF;
  ELSE
    IF roster_resolve_schedule(p_employee_id, p_original_off_date + 1) = 'day' THEN
      RAISE EXCEPTION 'Employee % already has a Day shift resolved on % -- a Night shift cannot start the night before it', p_employee_id, (p_original_off_date + 1) USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT id INTO v_existing_id FROM roster_date_assignments
  WHERE employee_id = p_employee_id AND assignment_date = p_original_off_date AND is_active;
  IF v_existing_id IS NOT NULL THEN
    UPDATE roster_date_assignments
    SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
    WHERE id = v_existing_id;
  END IF;
  INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
  VALUES (v_tenant_id, p_employee_id, p_original_off_date, p_original_date_shift, true, v_caller_id, p_correction_reason);

  SELECT id INTO v_existing_id FROM roster_date_assignments
  WHERE employee_id = p_employee_id AND assignment_date = p_replacement_off_date AND is_active;
  IF v_existing_id IS NOT NULL THEN
    UPDATE roster_date_assignments
    SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
    WHERE id = v_existing_id;
  END IF;
  INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
  VALUES (v_tenant_id, p_employee_id, p_replacement_off_date, 'off', false, v_caller_id, p_correction_reason);

  FOR v_violation IN
    SELECT * FROM roster_rolling_rest_windows(p_employee_id, p_original_off_date) WHERE status = 'confirmed_violation'
  LOOP
    RAISE EXCEPTION 'This reschedule would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden', p_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
  END LOOP;
  FOR v_violation IN
    SELECT * FROM roster_rolling_rest_windows(p_employee_id, p_replacement_off_date) WHERE status = 'confirmed_violation'
  LOOP
    RAISE EXCEPTION 'This reschedule would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden', p_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'employee_id', p_employee_id,
    'original_off_date', p_original_off_date,
    'original_date_shift', p_original_date_shift,
    'replacement_off_date', p_replacement_off_date
  );
END;
$$;

-- Unchanged from the currently installed version -- restated for a clean
-- final grant state after this CREATE OR REPLACE.
REVOKE ALL ON FUNCTION roster_reschedule_off_day(UUID, DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_reschedule_off_day(UUID, DATE, DATE, TEXT, TEXT) TO authenticated;
