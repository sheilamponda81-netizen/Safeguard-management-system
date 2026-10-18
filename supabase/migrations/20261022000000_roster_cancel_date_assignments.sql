-- ============================================================
-- MIGRATION: Roster Management -- Stage C Step 13: correct or
-- cancel special (dated) roster assignments.
-- Date: 2026-10-22
-- ============================================================
--
-- BUSINESS CONTEXT: an administrator can mistakenly place a dated
-- exception on the roster (e.g. "special Off" for a whole week) via
-- roster_assign_dates, and later needs to undo it. Correcting a dated
-- exception to a DIFFERENT type (Day<->Night, or Day/Night->Off) is
-- already fully supported by the existing, unmodified
-- roster_assign_dates RPC -- it already enforces every relevant safety
-- rule (the "cannot convert a genuinely Off date to a working day"
-- hard block, Night-to-Day adjacency, the rolling-seven-day rest check,
-- tenant isolation, append-only history) and needed no change at all.
--
-- The one genuinely missing capability is CANCELLING a dated exception
-- -- restoring whatever the employee's underlying recurring Off-day/
-- shift pattern says for that date, which could be Day, Night, Off, or
-- (if no pattern is configured) unassigned. roster_assign_dates cannot
-- express this: its p_assignment_type is NOT NULL and constrained to
-- ('day','night','off') -- there is no way to tell it "stop overriding,
-- whatever the real answer is." Forcing a specific type instead (e.g.
-- always reassigning 'day') would be WRONG whenever the underlying
-- pattern actually says Night or Off for some of the affected dates --
-- exactly the bug this migration is written to avoid, per the explicit
-- business requirement: "reveal the underlying recurring Day/Night/Off
-- schedule rather than forcing Day on every date."
--
-- THE FIX: one new RPC, roster_cancel_date_assignments. For every
-- selected date that currently has an ACTIVE dated assignment row, it
-- closes that row out (is_active -> false, the one permitted
-- append-only transition -- identical shape to every other roster RPC's
-- own close-out code) and writes NOTHING in its place. Whatever
-- roster_resolve_schedule then returns for that date -- the recurring
-- Off-day pattern, the recurring shift pattern, or 'unassigned' -- is
-- exactly what the employee's schedule becomes, with zero forcing.
-- A date in the selected range that has NO active dated exception (its
-- Off/Day/Night comes directly from the recurring pattern) is left
-- completely untouched and only counted as "skipped" -- this is the
-- requirement's "protect genuine recurring Off days: changing those
-- must use Temporary/Permanent Off Day" guarantee, satisfied by
-- construction (this RPC can only ever touch rows that already exist in
-- roster_date_assignments, never roster_off_day_patterns/
-- roster_shift_patterns).
--
-- TWO-PASS SAFETY CHECK (deliberately NOT checked inline per date):
-- cancelling several adjacent dates in the same call can only be
-- correctly validated once EVERY cancellation in the batch has already
-- been applied -- checking a date's revealed Night/Day adjacency or
-- rolling-rest status against a NEIGHBOUR that is still mid-batch (not
-- yet cancelled, so still showing its old, soon-to-be-superseded value)
-- would check the wrong thing, exactly the class of bug this
-- engagement already found and fixed once in
-- roster_apply_weekday_transition (Stage C Step 12A, see that
-- migration's own header for the full proof). So: Pass 1 closes out
-- every active row found in the requested range for every requested
-- employee (collecting which (employee, date) pairs were actually
-- touched); Pass 2, run only AFTER every closure in the batch has been
-- committed within this same transaction, re-resolves each touched date
-- and checks Night-to-Day adjacency and the rolling seven-day rest rule
-- against the FINAL, fully-revealed state. Any violation found in Pass 2
-- rolls back the ENTIRE call (including every Pass 1 closure) --
-- "all selected dates succeed or none change."
-- ============================================================

CREATE OR REPLACE FUNCTION roster_cancel_date_assignments(
  p_employee_ids UUID[],
  p_date_from DATE,
  p_date_to DATE,
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
  v_employee_id UUID;
  v_employee_tenant_id UUID;
  v_date DATE;
  v_total_rows INTEGER;
  v_existing_id UUID;
  v_cancelled_count INTEGER := 0;
  v_skipped_count INTEGER := 0;
  v_revealed TEXT;
  v_violation RECORD;
  v_touched_employees UUID[] := ARRAY[]::UUID[];
  v_touched_dates DATE[] := ARRAY[]::DATE[];
  i INTEGER;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT is_current_user_active() THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;
  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only Admin may manage roster assignments' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user' USING ERRCODE = '42501';
  END IF;

  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL OR array_length(p_employee_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one employee id is required' USING ERRCODE = '22023';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_to < p_date_from THEN
    RAISE EXCEPTION 'A valid date_from <= date_to is required' USING ERRCODE = '22023';
  END IF;
  IF p_correction_reason IS NULL OR btrim(p_correction_reason) = '' THEN
    RAISE EXCEPTION 'A correction_reason is required to cancel a special date assignment' USING ERRCODE = '22023';
  END IF;

  v_total_rows := array_length(p_employee_ids, 1) * ((p_date_to - p_date_from) + 1);
  IF v_total_rows > 2000 THEN
    RAISE EXCEPTION 'Bulk roster operations are limited to 2000 target assignments per request (this request would produce %) -- split into multiple calls', v_total_rows USING ERRCODE = '22023';
  END IF;

  -- ---- Pass 1: close out every active dated exception in range ----
  FOR v_employee_id IN SELECT unnest(p_employee_ids) ORDER BY 1 LOOP
    SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = v_employee_id FOR UPDATE;
    IF v_employee_tenant_id IS NULL THEN
      RAISE EXCEPTION 'Employee % not found', v_employee_id USING ERRCODE = '22023';
    END IF;
    IF v_employee_tenant_id <> v_tenant_id THEN
      RAISE EXCEPTION 'Employee % does not belong to your tenant', v_employee_id USING ERRCODE = '42501';
    END IF;

    v_date := p_date_from;
    WHILE v_date <= p_date_to LOOP
      SELECT id INTO v_existing_id
      FROM roster_date_assignments
      WHERE employee_id = v_employee_id AND assignment_date = v_date AND is_active;

      IF v_existing_id IS NULL THEN
        -- Nothing to cancel -- this date's schedule already comes
        -- directly from the recurring pattern (or is unassigned), never
        -- a dated exception. Left completely untouched: this is the
        -- "protect genuine recurring Off/working days" guarantee.
        v_skipped_count := v_skipped_count + 1;
      ELSE
        UPDATE roster_date_assignments
        SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
        WHERE id = v_existing_id;
        v_cancelled_count := v_cancelled_count + 1;
        v_touched_employees := v_touched_employees || v_employee_id;
        v_touched_dates := v_touched_dates || v_date;
      END IF;

      v_date := v_date + 1;
    END LOOP;
  END LOOP;

  -- ---- Pass 2: validate the FINAL, fully-revealed state ----
  FOR i IN 1 .. COALESCE(array_length(v_touched_dates, 1), 0) LOOP
    v_employee_id := v_touched_employees[i];
    v_date := v_touched_dates[i];

    -- Whatever now actually governs this date -- the recurring
    -- Off-day/shift pattern, or unassigned. Never forced to any
    -- specific value.
    v_revealed := roster_resolve_schedule(v_employee_id, v_date);

    IF v_revealed = 'day' THEN
      IF roster_resolve_schedule(v_employee_id, v_date - 1) = 'night' THEN
        RAISE EXCEPTION 'Cancelling this assignment would leave employee % with a Day shift resolved on % starting the morning right after a Night shift -- cancel or correct the adjacent date first', v_employee_id, v_date USING ERRCODE = '23514';
      END IF;
    ELSIF v_revealed = 'night' THEN
      IF roster_resolve_schedule(v_employee_id, v_date + 1) = 'day' THEN
        RAISE EXCEPTION 'Cancelling this assignment would leave employee % with a Night shift resolved on % starting the night before an existing Day shift -- cancel or correct the adjacent date first', v_employee_id, v_date USING ERRCODE = '23514';
      END IF;
    END IF;

    FOR v_violation IN
      SELECT * FROM roster_rolling_rest_windows(v_employee_id, v_date) WHERE status = 'confirmed_violation'
    LOOP
      RAISE EXCEPTION 'This change would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden',
        v_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('assigned_count', v_cancelled_count, 'already_set_count', v_skipped_count);
END;
$$;

REVOKE ALL ON FUNCTION roster_cancel_date_assignments(UUID[], DATE, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_cancel_date_assignments(UUID[], DATE, DATE, TEXT) TO authenticated;
