-- ============================================================
-- MIGRATION: Attendance Automation -- Stage C, Step 3 corrective fix
-- Date: 2026-10-12
-- ============================================================
--
-- DEPLOYED-STATE NOTE (added after STAGING application): the literal SQL
-- below defines attendance_engine_shift_windows() via DROP + CREATE OR
-- REPLACE, because changing a function's RETURNS TABLE columns requires
-- a DROP first. On STAGING, `DROP FUNCTION` reliably timed out through
-- the migration tool available in that session (confirmed repeatedly,
-- including on a disposable throwaway function, with zero server-side
-- blocking query each time -- a tool-layer limitation, not a Postgres
-- one). As a behavior-equivalent workaround, STAGING instead has this
-- two-boundary version defined under a NEW name,
-- attendance_engine_shift_window_bounds, with attendance_resolve_and_
-- calculate (a plain CREATE OR REPLACE, which needed no DROP) calling
-- that name instead. The OLD single-column attendance_engine_shift_windows
-- is still present on STAGING, now unused by any caller -- harmless dead
-- code. Re-running THIS file's literal text against a fresh/local
-- database (where DROP FUNCTION works normally) is fine and reproduces
-- the intended single-name design; re-running it against STAGING as-is
-- would attempt the same DROP and should be expected to hit the same
-- tool limitation unless that limitation has since cleared. Whoever
-- next touches this function on STAGING should either (a) retry the DROP
-- now that time has passed, reconciling STAGING back to this file's
-- literal names, or (b) deliberately rename this file's function to
-- attendance_engine_shift_window_bounds to match deployed reality -- not
-- silently assume the two already match.
--
-- SCOPE: fixes two concrete safety issues in attendance_resolve_and_calculate
-- (20261012000000_attendance_automation_foundation.sql), identified by
-- independent inspection of the installed STAGING functions, BEFORE
-- automatic attendance is ever enabled. PREPARED ONLY -- not applied to
-- STAGING as part of this change; a separate, explicitly authorized step
-- applies it. Automatic attendance activation remains entirely out of
-- scope regardless (attendance_apply_automatic is still never called by
-- any frontend code).
--
-- ISSUE 1 -- missing tenant scoping on the raw-event lookup: the join
-- between hikcentral_raw_events and hikcentral_person_mappings matched
-- on `hikcentral_person_no` and `is_active` alone, with no explicit
-- tenant_id filter on either side. Both tables DO carry their own
-- tenant_id column (20260929000000_hikcentral_attendance_ingestion_
-- foundation.sql). hikcentral_person_no is a free-text value supplied by
-- each tenant's own HikCentral deployment -- nothing prevents two
-- different tenants from independently assigning the same person number
-- -- so without an explicit tenant filter, a collision could pull another
-- tenant's fingerprint events into this employee's calculation. Fixed by
-- requiring r.tenant_id = v_tenant_id and m.tenant_id = v_tenant_id (and,
-- for defense in depth, m.tenant_id = r.tenant_id on the join itself) --
-- tenant isolation no longer depends on hikcentral_person_no happening to
-- be globally unique.
--
-- ISSUE 2 -- coverage window only checked its trailing edge: the
-- fingerprint_coverage_confirmations lookup required
-- `covers_through >= v_checkout_window_end` but never checked
-- `covers_from` against the START of the shift being evaluated. A
-- confirmation whose covers_from begins partway through (or even after)
-- the check-in window, but whose covers_through happens to extend past
-- the checkout window's end, would already satisfy the old query --
-- "confirmed complete" for a shift it barely overlaps, manufacturing a
-- false Absent for the unobserved portion. Fixed by requiring the
-- confirmation's covers_from/covers_through span to fully contain the
-- shift's own check-in-window-start through checkout-window-end range.
-- Per existing design (correction A/E, Step 1), neither covers_from on
-- its own, an unknown/declared export_time_declared, nor a workstation
-- name typed into a checkbox is ever treated as proof by itself -- only
-- this full-span covers_from/covers_through check (now correctly
-- requiring BOTH ends) decides coverage.
-- ============================================================

-- attendance_engine_shift_windows now also exposes the check-in window's
-- START (mirrors attendance_engine_calculate's own internal window math
-- for day/night exactly) -- needed so attendance_resolve_and_calculate
-- can check the coverage confirmation's covers_from against it. Changing
-- the output column set requires a DROP first (CREATE OR REPLACE cannot
-- change a function's return columns).
DROP FUNCTION IF EXISTS attendance_engine_shift_windows(DATE, TEXT);

CREATE OR REPLACE FUNCTION attendance_engine_shift_windows(p_shift_date DATE, p_resolved_shift TEXT)
RETURNS TABLE (check_in_window_start TIMESTAMPTZ, check_out_window_end TIMESTAMPTZ)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE
      WHEN p_resolved_shift = 'day' THEN attendance_blantyre_to_utc(p_shift_date, '04:00')
      WHEN p_resolved_shift = 'night' THEN attendance_blantyre_to_utc(p_shift_date, '16:00')
    END,
    CASE
      WHEN p_resolved_shift = 'day' THEN attendance_blantyre_to_utc(p_shift_date, '20:00')
      WHEN p_resolved_shift = 'night' THEN attendance_blantyre_to_utc(p_shift_date + 1, '08:00')
    END;
$$;

REVOKE ALL ON FUNCTION attendance_engine_shift_windows(DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_engine_shift_windows(DATE, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION attendance_resolve_and_calculate(p_employee_id UUID, p_shift_date DATE)
RETURNS TABLE (
  status TEXT,
  calculation_basis TEXT,
  check_in_at TIMESTAMPTZ,
  check_out_at TIMESTAMPTZ,
  reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
  v_workstation TEXT;
  v_resolved_shift TEXT;
  v_has_active_mapping BOOLEAN;
  v_event_times TIMESTAMPTZ[];
  v_checkin_window_start TIMESTAMPTZ;
  v_checkout_window_end TIMESTAMPTZ;
  v_coverage_status TEXT := 'insufficient';
  v_coverage_through TIMESTAMPTZ := NULL;
BEGIN
  SELECT tenant_id, workstation INTO v_tenant_id, v_workstation FROM employees WHERE id = p_employee_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'attendance_resolve_and_calculate: no such employee %', p_employee_id;
  END IF;

  v_resolved_shift := roster_resolve_schedule(p_employee_id, p_shift_date);

  IF v_resolved_shift IN ('off', 'unassigned') THEN
    RETURN QUERY SELECT * FROM attendance_engine_calculate(p_shift_date, v_resolved_shift, NULL, 'insufficient', NULL);
    RETURN;
  END IF;

  -- Mapping-gap guard (unchanged from Step 1) -- fix 1 adds an explicit
  -- tenant filter alongside it, since the mapping itself must also be
  -- this employee's OWN tenant's mapping, not merely active.
  SELECT EXISTS(
    SELECT 1 FROM hikcentral_person_mappings m
    WHERE m.employee_id = p_employee_id AND m.is_active AND m.tenant_id = v_tenant_id
  ) INTO v_has_active_mapping;

  IF v_has_active_mapping THEN
    -- FIX 1: explicit tenant_id filter on both sides of the join, plus
    -- tying the join itself to matching tenant_id -- hikcentral_person_no
    -- collisions across tenants can no longer leak events across the
    -- tenant boundary, regardless of whether person numbers happen to
    -- coincide.
    SELECT ARRAY_AGG(r.event_time) INTO v_event_times
    FROM hikcentral_raw_events r
    JOIN hikcentral_person_mappings m
      ON m.hikcentral_person_no = r.hikcentral_person_no
      AND m.is_active
      AND m.tenant_id = r.tenant_id
    WHERE m.employee_id = p_employee_id
      AND m.tenant_id = v_tenant_id
      AND r.tenant_id = v_tenant_id
      AND r.event_time >= attendance_blantyre_to_utc(p_shift_date, '00:00') - interval '4 hours'
      AND r.event_time <= attendance_blantyre_to_utc(p_shift_date + 2, '00:00');

    SELECT w.check_in_window_start, w.check_out_window_end
      INTO v_checkin_window_start, v_checkout_window_end
    FROM attendance_engine_shift_windows(p_shift_date, v_resolved_shift) w;

    -- FIX 2: covers_from must reach back to (or before) the check-in
    -- window's own start, not just covers_through reaching past the
    -- checkout window's end -- a confirmation must span the WHOLE shift
    -- being evaluated to count as complete coverage for it.
    SELECT c.covers_through INTO v_coverage_through
    FROM fingerprint_coverage_confirmations c
    WHERE c.tenant_id = v_tenant_id
      AND c.revoked_at IS NULL
      AND v_workstation = ANY (c.workstations)
      AND c.covers_from <= v_checkin_window_start
      AND c.covers_through >= v_checkout_window_end
    ORDER BY c.covers_through DESC
    LIMIT 1;

    IF v_coverage_through IS NOT NULL THEN
      v_coverage_status := 'confirmed_complete';
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM attendance_engine_calculate(p_shift_date, v_resolved_shift, v_event_times, v_coverage_status, v_coverage_through);
END;
$$;

-- Internal-only, unchanged from Step 1 -- restated for a clean final
-- grant state after the DROP/CREATE above.
REVOKE ALL ON FUNCTION attendance_resolve_and_calculate(UUID, DATE) FROM PUBLIC, anon, authenticated;
