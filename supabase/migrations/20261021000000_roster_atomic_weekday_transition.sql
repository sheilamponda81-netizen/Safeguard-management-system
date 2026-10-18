-- ============================================================
-- MIGRATION: Roster Management -- Stage C Step 12A: atomic,
-- rest-preserving weekday transitions (Temporary and Permanent).
-- Date: 2026-10-21
-- ============================================================
--
-- BUSINESS CONTEXT: Stage C Step 12 shipped a weekday-based Temporary/
-- Permanent Off-day tab, but testing it (via an isolated-Postgres
-- regression suite, never against STAGING/PRODUCTION) uncovered that
-- administrators' primary real-world use case -- moving an employee's
-- Off day away from an ALREADY-ESTABLISHED, indefinitely-repeating
-- single-weekday pattern (e.g. "Wednesday Off" running for months) --
-- was ALWAYS rejected by the rolling-seven-day-rest check, for ANY
-- nonzero weekday shift, in BOTH Temporary and Permanent mode. This is
-- not a bug in the rolling-rest rule itself (which must be preserved,
-- unweakened, per explicit instruction) -- it is a mathematical
-- consequence of a perfectly periodic single-Off-day pattern having
-- ZERO slack: removing the one Off day that used to cover a run of
-- 7-day windows, and replacing it with an Off day elsewhere in the same
-- Mon-Sun week, necessarily uncovers at least one window UNLESS the
-- shift is exactly zero.
--
-- THE PROOF (forward shift, i.e. the new weekday is LATER in the week
-- than the old one -- e.g. Wednesday(ordinal 2) -> Sunday(ordinal 6),
-- shift d = +4; "ordinal" below means 0=Monday..6=Sunday, the week's own
-- Monday-start position, NOT the 0=Sunday..6=Saturday convention used
-- for p_weekday/p_original_weekday/p_new_weekday elsewhere in this
-- schema):
--   Let X = the last REAL, untouched occurrence of the OLD weekday (the
--   week immediately before the transition). Under the old pattern the
--   next occurrence would be X+7 (same weekday, next week); the
--   transition instead places the new Off day at X+7+d. Every 7-day
--   window entirely contained in (X, X+7+d) that does NOT also contain
--   X or X+7+d has zero Off days -- a confirmed violation whenever
--   d != 0. A SINGLE extra Off day Y bridges every such window if and
--   only if X+d <= Y <= X+7 (so neighbouring windows on both sides of Y
--   are covered) -- a range that is always non-empty for d in [1,6],
--   and Y = X+7 (i.e. keeping the OLD weekday ALSO Off, for exactly the
--   one transition week, instead of converting it to a working day) is
--   always a valid choice, satisfying Y = X+7 <= X+7 trivially. The
--   symmetric argument for a BACKWARD shift (d<0) places the bridge
--   Y = X+7 at the LAST affected week instead (it is a non-issue for
--   backward Permanent changes, which have no "last affected week" to
--   bridge -- the single transition point is already safe, see below).
--
-- THE FIX: this migration adds ONE new RPC,
-- roster_apply_weekday_transition, which computes this bridge
-- automatically and WRITES THE ENTIRE MULTI-WEEK CHANGE (every affected
-- week's swap, plus the single bridge week/date when one is needed) IN
-- ONE ATOMIC CALL -- a single PL/pgSQL function body is one implicit
-- transaction, so ANY failure (including the final, authoritative
-- rolling-rest check) rolls back every week's writes together, never a
-- partial application. This REPLACES the Step 12 UI's old approach of
-- looping a per-week call to the existing, unmodified
-- roster_reschedule_off_day RPC (which risked exactly the partial-
-- application outcome this task was explicit about avoiding). It does
-- NOT replace or modify roster_reschedule_off_day, roster_assign_dates,
-- or roster_assign_recurring_pattern -- all three are reused completely
-- unchanged (Permanent mode literally calls roster_assign_recurring_
-- pattern internally, in the same transaction, for the actual pattern
-- switch -- reusing its own already-tested rolling-rest check as the
-- final authority for that half of the operation).
--
-- WHY NO BRIDGE IS EVER NEEDED FOR A BACKWARD-SHIFT PERMANENT CHANGE:
-- a backward shift's entry gap is 7+d < 7 (safe), and since the new
-- pattern then repeats forever at exactly 7-day spacing, there is no
-- second ("exit") boundary to worry about at all -- confirmed by this
-- round's isolated-Postgres tests.
-- ============================================================

CREATE OR REPLACE FUNCTION roster_apply_weekday_transition(
  p_employee_id UUID,
  p_mode TEXT, -- 'temporary' | 'permanent'
  p_original_weekday INTEGER, -- 0=Sunday .. 6=Saturday (JS convention, matches roster_assign_recurring_pattern's p_weekday)
  p_new_weekday INTEGER,
  p_shift_type TEXT, -- 'day' | 'night' -- the normal working shift a swapped week's original weekday converts to
  p_week_start DATE, -- Monday of the first (temporary) or only (permanent) affected week
  p_duration_weeks INTEGER, -- temporary: number of weeks, 1-104; ignored (treated as 1) for permanent
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
  v_ordinal_original INTEGER;
  v_ordinal_new INTEGER;
  v_shift_direction INTEGER;
  v_bridge_week_index INTEGER;
  v_week_start DATE;
  v_original_date DATE;
  v_new_date DATE;
  v_is_bridge BOOLEAN;
  v_i INTEGER;
  v_existing_id UUID;
  v_original_resolved TEXT;
  v_new_resolved TEXT;
  v_violation RECORD;
  v_weeks_applied INTEGER := 0;
  v_bridge_date DATE := NULL;
  v_pattern_result JSONB;
  v_touched_dates DATE[] := ARRAY[]::DATE[];
  v_touched_date DATE;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF is_current_user_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;
  IF (is_super_admin() OR is_business_admin()) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only Admin may change roster Off-day weekday assignments' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user' USING ERRCODE = '42501';
  END IF;

  IF p_mode IS NULL OR p_mode NOT IN ('temporary', 'permanent') THEN
    RAISE EXCEPTION 'mode must be temporary or permanent' USING ERRCODE = '22023';
  END IF;
  IF p_original_weekday IS NULL OR p_original_weekday < 0 OR p_original_weekday > 6 THEN
    RAISE EXCEPTION 'original_weekday must be between 0 (Sunday) and 6 (Saturday)' USING ERRCODE = '22023';
  END IF;
  IF p_new_weekday IS NULL OR p_new_weekday < 0 OR p_new_weekday > 6 THEN
    RAISE EXCEPTION 'new_weekday must be between 0 (Sunday) and 6 (Saturday)' USING ERRCODE = '22023';
  END IF;
  IF p_original_weekday = p_new_weekday THEN
    RAISE EXCEPTION 'new_weekday must differ from original_weekday' USING ERRCODE = '22023';
  END IF;
  IF p_shift_type IS NULL OR p_shift_type NOT IN ('day', 'night') THEN
    RAISE EXCEPTION 'shift_type must be day or night' USING ERRCODE = '22023';
  END IF;
  IF p_correction_reason IS NULL OR btrim(p_correction_reason) = '' THEN
    RAISE EXCEPTION 'A correction_reason is required' USING ERRCODE = '22023';
  END IF;
  IF p_week_start IS NULL OR EXTRACT(ISODOW FROM p_week_start) <> 1 THEN
    RAISE EXCEPTION 'week_start must be a Monday' USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'temporary' AND (p_duration_weeks IS NULL OR p_duration_weeks < 1 OR p_duration_weeks > 104) THEN
    RAISE EXCEPTION 'duration_weeks must be between 1 and 104' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = p_employee_id FOR UPDATE;
  IF v_employee_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Employee % not found', p_employee_id USING ERRCODE = '22023';
  END IF;
  IF v_employee_tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'Employee % does not belong to your tenant', p_employee_id USING ERRCODE = '42501';
  END IF;

  -- Monday-start ordinal (0=Mon..6=Sun), independent of the 0=Sun..6=Sat
  -- storage convention -- see this migration's header proof.
  v_ordinal_original := CASE WHEN p_original_weekday = 0 THEN 6 ELSE p_original_weekday - 1 END;
  v_ordinal_new := CASE WHEN p_new_weekday = 0 THEN 6 ELSE p_new_weekday - 1 END;
  v_shift_direction := v_ordinal_new - v_ordinal_original;

  IF p_mode = 'permanent' THEN
    IF v_shift_direction > 0 THEN
      v_bridge_date := p_week_start + v_ordinal_original;
      v_original_resolved := roster_resolve_schedule(p_employee_id, v_bridge_date);
      IF v_original_resolved IS DISTINCT FROM 'off' THEN
        RAISE EXCEPTION 'Employee % does not currently resolve Off on % -- a weekday transition requires the employee to be genuinely Off on their current pattern first (it currently resolves "%")', p_employee_id, v_bridge_date, v_original_resolved USING ERRCODE = '23514';
      END IF;

      SELECT id INTO v_existing_id FROM roster_date_assignments WHERE employee_id = p_employee_id AND assignment_date = v_bridge_date AND is_active;
      IF v_existing_id IS NOT NULL THEN
        UPDATE roster_date_assignments
        SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
        WHERE id = v_existing_id;
      END IF;
      INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
      VALUES (v_tenant_id, p_employee_id, v_bridge_date, 'off', true, v_caller_id, p_correction_reason || ' (additional Off day preserved during the transition to maintain the rolling seven-day rest requirement)');
    END IF;

    -- Reuses the existing, unmodified, already-tested RPC for the actual
    -- recurring-pattern switch -- including its own rolling-rest check,
    -- which now sees the bridge date (if any) already in place.
    v_pattern_result := roster_assign_recurring_pattern(ARRAY[p_employee_id], p_new_weekday, NULL, p_week_start, p_correction_reason);

    RETURN jsonb_build_object(
      'success', true,
      'mode', 'permanent',
      'effective_from', p_week_start,
      'bridge_date', v_bridge_date,
      'pattern_result', v_pattern_result
    );
  END IF;

  -- p_mode = 'temporary'
  v_bridge_week_index := CASE
    WHEN v_shift_direction > 0 THEN 0
    WHEN v_shift_direction < 0 THEN p_duration_weeks - 1
    ELSE -1
  END;

  FOR v_i IN 0 .. (p_duration_weeks - 1) LOOP
    v_week_start := p_week_start + (v_i * 7);
    v_original_date := v_week_start + v_ordinal_original;
    v_new_date := v_week_start + v_ordinal_new;
    v_is_bridge := (v_i = v_bridge_week_index);

    v_original_resolved := roster_resolve_schedule(p_employee_id, v_original_date);
    IF v_original_resolved IS DISTINCT FROM 'off' THEN
      RAISE EXCEPTION 'Employee % is not currently scheduled Off on % (week starting %) -- it currently resolves to "%" -- rescheduling requires a genuine existing Off date', p_employee_id, v_original_date, v_week_start, v_original_resolved USING ERRCODE = '23514';
    END IF;
    v_new_resolved := roster_resolve_schedule(p_employee_id, v_new_date);
    IF v_new_resolved = 'off' THEN
      RAISE EXCEPTION 'Employee % is already Off on % (week starting %) -- choose a date that is not already Off', p_employee_id, v_new_date, v_week_start USING ERRCODE = '23514';
    END IF;

    IF NOT v_is_bridge THEN
      -- Full swap for this week: convert the original weekday into a
      -- normal working day. The Night/Day adjacency hard block applies
      -- exactly as it does for roster_reschedule_off_day -- no override
      -- path exists for it here either.
      IF p_shift_type = 'day' THEN
        IF roster_resolve_schedule(p_employee_id, v_original_date - 1) = 'night' THEN
          RAISE EXCEPTION 'Employee % has a Night shift resolved on % -- a Day shift cannot start the following morning', p_employee_id, (v_original_date - 1) USING ERRCODE = '23514';
        END IF;
      ELSE
        IF roster_resolve_schedule(p_employee_id, v_original_date + 1) = 'day' THEN
          RAISE EXCEPTION 'Employee % already has a Day shift resolved on % -- a Night shift cannot start the night before it', p_employee_id, (v_original_date + 1) USING ERRCODE = '23514';
        END IF;
      END IF;

      SELECT id INTO v_existing_id FROM roster_date_assignments WHERE employee_id = p_employee_id AND assignment_date = v_original_date AND is_active;
      IF v_existing_id IS NOT NULL THEN
        UPDATE roster_date_assignments
        SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
        WHERE id = v_existing_id;
      END IF;
      INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
      VALUES (v_tenant_id, p_employee_id, v_original_date, p_shift_type, true, v_caller_id, p_correction_reason);
    ELSE
      v_bridge_date := v_original_date;
      -- Bridge week: deliberately do NOT convert v_original_date -- it
      -- stays Off (whatever currently makes it resolve Off, typically
      -- the untouched recurring pattern) to bridge the rolling-rest gap
      -- this one transition otherwise creates. See this migration's
      -- header for the proof that exactly one such week always suffices.
    END IF;

    SELECT id INTO v_existing_id FROM roster_date_assignments WHERE employee_id = p_employee_id AND assignment_date = v_new_date AND is_active;
    IF v_existing_id IS NOT NULL THEN
      UPDATE roster_date_assignments
      SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
      WHERE id = v_existing_id;
    END IF;
    INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
    VALUES (v_tenant_id, p_employee_id, v_new_date, 'off', false, v_caller_id, p_correction_reason);

    v_touched_dates := v_touched_dates || v_original_date || v_new_date;
    v_weeks_applied := v_weeks_applied + 1;
  END LOOP;

  -- Authoritative check across EVERY touched date, performed ONLY AFTER
  -- every week has been written -- NOT incrementally per week. A
  -- BACKWARD shift's bridge lives in the LAST affected week, so an
  -- EARLIER week's own window can depend on that bridge day existing
  -- (e.g. a window ending right at the bridge week's new Off date);
  -- checking immediately after each week -- before any later week's
  -- bridge has been written -- would reject a transition that is
  -- actually safe once the whole multi-week write completes. Any
  -- violation found here still rolls back EVERY week written in this
  -- call, satisfying "all weeks succeed or none change."
  FOREACH v_touched_date IN ARRAY v_touched_dates LOOP
    FOR v_violation IN
      SELECT * FROM roster_rolling_rest_windows(p_employee_id, v_touched_date) WHERE status = 'confirmed_violation'
    LOOP
      RAISE EXCEPTION 'This change would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden', p_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'mode', 'temporary',
    'weeks_applied', v_weeks_applied,
    'bridge_week_index', v_bridge_week_index,
    'bridge_date', CASE WHEN v_bridge_week_index >= 0 THEN v_bridge_date ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION roster_apply_weekday_transition(UUID, TEXT, INTEGER, INTEGER, TEXT, DATE, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_apply_weekday_transition(UUID, TEXT, INTEGER, INTEGER, TEXT, DATE, INTEGER, TEXT) TO authenticated;
