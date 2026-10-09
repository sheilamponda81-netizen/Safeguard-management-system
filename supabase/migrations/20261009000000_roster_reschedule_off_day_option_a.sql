-- Safeguard HikCentral Attendance MVP -- Phase 2B.2C: Reschedule Off Day,
-- Policy Option A (forward-only corrective migration).
--
-- SCOPE: supersedes ONLY the roster_reschedule_off_day() function created
-- by 20261008000000_roster_management_foundation.sql, which remains
-- completely unedited -- migration files are append-only history, never
-- rewritten in place. That file's own committed regression tests
-- (rosterMigrationSecurity.test.ts) still correctly pin ITS source text as
-- it was written; they are not invalidated by this migration, they simply
-- no longer describe what is live in the database once this file is
-- applied. Nothing else from that migration changes here: both tables,
-- their RLS policies, their table grants, the append-only trigger, the
-- other two write RPCs (roster_assign_off_pattern, roster_assign_dates),
-- and the two read-only helpers (roster_resolve_schedule,
-- roster_rolling_rest_windows) are all untouched and reused as-is.
--
-- CONFIRMED FINAL BUSINESS POLICY (Option A), replacing the prior
-- "add a second Off day, optionally also assign work elsewhere" design,
-- which the Phase 2B.2C read-only STAGING preflight identified as able to
-- silently leave the employee's real recurring Off day untouched while
-- adding an unrelated second one -- never what "reschedule" should mean.
-- Rescheduling an Off day is now a mandatory, symmetric swap:
--   - Admin must name the employee's genuine, CURRENTLY-Off original
--     date -- verified server-side by actually resolving it, never
--     trusted from the client.
--   - Admin must name a different replacement date, which must currently
--     resolve to 'unassigned' -- not already Off, Day, or Night. An
--     already-Off replacement is REJECTED (not silently accepted as
--     "harmless"): letting it through would allow Admin to believe a
--     genuine swap happened while the employee's real weekly rest
--     entitlement was actually reduced (the original date's rest is
--     converted to work, with no new rest gained in exchange, since the
--     "replacement" was already going to be a rest day regardless). This
--     was corrected after review identified the risk in an earlier
--     version of this same (still-unapplied) file, which accepted
--     'unassigned' OR already-'off' replacements.
--   - Admin must choose what shift (day or night) the original date
--     becomes -- there is no longer any way to add a replacement Off day
--     without also converting the genuine original Off date into a real
--     shift, in the same atomic call.
--   - Both changes commit together or not at all; the rolling seven-day
--     rest rule is re-verified around BOTH dates with no override path.
--
-- MATHEMATICAL EDGE CASE (explicitly required to be handled, never
-- assumed safe): an employee with exactly one recurring Off day per week
-- has zero slack. Moving it forward by a day (e.g. Wed -> Thu) leaves the
-- window [original_date - 6, original_date] with no Off day at all,
-- because the replacement date falls one day OUTSIDE that specific
-- window. Moving it backward (e.g. Wed -> Tue) symmetrically breaks the
-- window [replacement_date, replacement_date + 6]. This is NOT a defect
-- to patch around with a hidden override -- it is the rolling seven-day
-- rest rule correctly catching a genuine, mathematically unavoidable gap
-- in a zero-slack schedule. The minimal safe way to support such a swap
-- is for Admin to first add slack (e.g. one extra, independently-reasoned
-- Off day via Assign Dates, or a broader pattern change via Recurring Off
-- Day) and only then reschedule -- never a parameter on this function
-- that waives the check. Verified by actually constructing both
-- directions (Wed->Thu and Wed->Tue against a maximally tight, zero-slack
-- recurring schedule) in an isolated local Postgres instance: both are
-- correctly rejected; adding one extra Off day first makes the identical
-- reschedule succeed. See this phase's test report for the exact runs.

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Defensively drop EVERY existing overload of roster_reschedule_off_day,
  -- regardless of its exact parameter signature, rather than relying on
  -- CREATE OR REPLACE matching the old 5-parameter
  -- (UUID, DATE, DATE, TEXT, TEXT) signature exactly. The function created
  -- below happens to share that same parameter TYPE signature (its
  -- meaning has changed; UUID/DATE/DATE/TEXT/TEXT is still the shape), so
  -- CREATE OR REPLACE would in fact cleanly replace it in place with no
  -- overload left reachable -- but this explicit drop-every-overload step
  -- removes any dependency on that coincidence, and guards against a
  -- mismatched signature if an environment's applied history ever
  -- diverges from this repository's committed migration text for any
  -- reason. After this block, at most one function named
  -- roster_reschedule_off_day can possibly exist in this schema -- the
  -- one created immediately below -- so the old "add a second Off day"
  -- behavior can never remain reachable through an overlooked overload.
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'roster_reschedule_off_day'
  LOOP
    EXECUTE format('DROP FUNCTION %s', r.sig);
  END LOOP;
END;
$$;

CREATE FUNCTION roster_reschedule_off_day(
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
  v_adjacent_type TEXT;
  v_violation RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT is_current_user_active() THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;
  IF NOT (is_super_admin() OR is_business_admin()) THEN
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

  -- Lock FIRST, before any roster read/write for this employee -- the
  -- same pattern as every other write RPC in this codebase, serializing
  -- ALL roster mutations for this employee (including this employee's
  -- very first write) against concurrent calls, including a concurrent
  -- call targeting the identical employee/date.
  SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = p_employee_id FOR UPDATE;
  IF v_employee_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Employee % not found', p_employee_id USING ERRCODE = '22023';
  END IF;
  IF v_employee_tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'Employee % does not belong to your tenant', p_employee_id USING ERRCODE = '42501';
  END IF;

  -- The original date must GENUINELY resolve to Off right now -- never
  -- assumed, never trusted from the client.
  v_original_resolved := roster_resolve_schedule(p_employee_id, p_original_off_date);
  IF v_original_resolved <> 'off' THEN
    RAISE EXCEPTION 'Employee % is not currently scheduled Off on % (it currently resolves to "%") -- rescheduling requires a genuine existing Off date', p_employee_id, p_original_off_date, v_original_resolved USING ERRCODE = '23514';
  END IF;

  -- CONFIRMED FINAL POLICY: the replacement date must resolve to EXACTLY
  -- 'unassigned' -- an existing 'day'/'night' would silently overwrite
  -- real work, and an already-'off' replacement contributes no new rest
  -- day at all (see this migration's header for why that is rejected,
  -- not merely allowed-as-harmless).
  v_replacement_resolved := roster_resolve_schedule(p_employee_id, p_replacement_off_date);
  IF v_replacement_resolved <> 'unassigned' THEN
    RAISE EXCEPTION 'Employee % replacement date % already resolves to "%" -- the replacement date must be unassigned, not already Off, Day, or Night', p_employee_id, p_replacement_off_date, v_replacement_resolved USING ERRCODE = '23514';
  END IF;

  -- Night-to-Day adjacency for the NEW shift being placed on the original
  -- date -- the identical hard-block rule roster_assign_dates enforces;
  -- no override parameter exists for it here either.
  IF p_original_date_shift = 'day' THEN
    SELECT assignment_type INTO v_adjacent_type FROM roster_date_assignments
    WHERE employee_id = p_employee_id AND assignment_date = p_original_off_date - 1 AND is_active;
    IF v_adjacent_type = 'night' THEN
      RAISE EXCEPTION 'Employee % has a Night shift starting % -- a Day shift cannot start the following morning', p_employee_id, (p_original_off_date - 1) USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT assignment_type INTO v_adjacent_type FROM roster_date_assignments
    WHERE employee_id = p_employee_id AND assignment_date = p_original_off_date + 1 AND is_active;
    IF v_adjacent_type = 'day' THEN
      RAISE EXCEPTION 'Employee % already has a Day shift starting % -- a Night shift cannot start the night before it', p_employee_id, (p_original_off_date + 1) USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Step A: the original date becomes the chosen working shift. It was
  -- just confirmed to genuinely resolve 'off' above, so
  -- overrides_recurring_off_day is unconditionally true for this row
  -- (truthful provenance, not assumed).
  SELECT id INTO v_existing_id FROM roster_date_assignments
  WHERE employee_id = p_employee_id AND assignment_date = p_original_off_date AND is_active;
  IF v_existing_id IS NOT NULL THEN
    UPDATE roster_date_assignments
    SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
    WHERE id = v_existing_id;
  END IF;
  INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
  VALUES (v_tenant_id, p_employee_id, p_original_off_date, p_original_date_shift, true, v_caller_id, p_correction_reason);

  -- Step B: the replacement date becomes Off.
  SELECT id INTO v_existing_id FROM roster_date_assignments
  WHERE employee_id = p_employee_id AND assignment_date = p_replacement_off_date AND is_active;
  IF v_existing_id IS NOT NULL THEN
    UPDATE roster_date_assignments
    SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
    WHERE id = v_existing_id;
  END IF;
  INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
  VALUES (v_tenant_id, p_employee_id, p_replacement_off_date, 'off', false, v_caller_id, p_correction_reason);

  -- Validate the NET effect of BOTH changes together, around BOTH dates
  -- -- a violation here rolls back Step A and Step B atomically. No
  -- override path exists for a confirmed rolling-rest violation. This is
  -- exactly where the "exactly-one-Off-day-per-week has zero slack"
  -- mathematical edge case is caught -- see this migration's header.
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

REVOKE ALL ON FUNCTION roster_reschedule_off_day(UUID, DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_reschedule_off_day(UUID, DATE, DATE, TEXT, TEXT) TO authenticated;
