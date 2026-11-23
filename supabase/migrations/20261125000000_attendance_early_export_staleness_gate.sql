-- ============================================================
-- MIGRATION: Early-export check-in-only credit gated on real
-- wall-clock staleness, not merely on coverage confirmation.
-- Date: 2026-11-25
-- ============================================================
--
-- CONFIRMED PRODUCTION INVESTIGATION (read-only, no row touched):
-- attendance_engine_calculate()'s early-export rule credits a valid
-- check-in alone as provisional Present/Late (calculation_basis =
-- 'check_in_only_provisional') whenever the checkout window is not
-- CONFIRMED closed by evidence-backed coverage -- gated purely on
-- coverage-confirmation data, never on real time. HILIA MAKHASU
-- (SFG-S-216, Nov 3 2026 Night shift) and SAMU ELIA MAKUNGWA
-- (SFG-S-432, Nov 4 2026 Day shift) were confirmed, via direct raw
-- fingerprint-event queries, to have genuinely missing checkouts (not
-- a mapping/pairing/dedup bug) on an access point whose only coverage
-- confirmations are, per the 2026-11-22 evidence-trust fix,
-- 'unsupported_historical' -- correctly never evidence-backed, and so
-- correctly never 'confirmed_complete'. The consequence: once an
-- export is weeks old, there is no realistic way for a fresh,
-- evidence-backed confirmation to ever retroactively appear for that
-- already-closed historical window, so the live calculation stays
-- "provisional Present, pending checkout window closure" forever --
-- a state that can never resolve, even though real wall-clock time has
-- long since passed the point where a checkout could still show up.
--
-- CONFIRMED NOT A VIOLATION OF THE OFFICIAL WRITE PATH:
-- attendance_apply_automatic already explicitly skips writing any
-- check_in_only_provisional result (outcome :=
-- 'skipped_provisional_' || status) -- a direct production query
-- confirmed ZERO attendance rows exist with
-- calculation_basis = 'check_in_only_provisional'. This migration does
-- not change that -- it fixes the underlying CALCULATION result that
-- Evidence Centre and the comparison tooling surface to operators,
-- which otherwise misleadingly shows a permanently-stuck "live
-- calculated Present" against an official "Absent" with no path to
-- ever converge.
--
-- THE FIX (smallest safe change, mirrors the TypeScript engine's own
-- fix in src/utils/attendanceCalculationEngine.ts exactly): add an
-- explicit p_as_of TIMESTAMPTZ parameter (default NULL, so every
-- existing caller/signature keeps working unchanged) to
-- attendance_engine_calculate. When a check-in-only shift's checkout
-- window has ALREADY genuinely passed as of p_as_of, and coverage is
-- still not confirmed complete, the result is 'pending' (calculation_
-- basis NULL) instead of the permanently-stuck provisional Present/
-- Late. Per the explicit policy, this is NEVER 'absent' (coverage is
-- still unconfirmed -- an unsupported final Absent is exactly as
-- forbidden as an unsupported final Present) and NEVER silently
-- changes any already-written historical attendance row (this
-- migration touches no table, only how a FUTURE calculation call is
-- computed). attendance_resolve_and_calculate now passes
-- clock_timestamp() (the real current time at evaluation) as p_as_of
-- on both of its own calls into attendance_engine_calculate.
--
-- IMMUTABLE preserved correctly: attendance_engine_calculate takes
-- p_as_of as an explicit argument rather than calling now()/
-- clock_timestamp() itself, so its result is still a pure function of
-- its arguments (unlike clock_timestamp(), now() is also unsuitable
-- here even as an internal call, since it is fixed for an entire
-- transaction -- an explicit argument, supplied by the one caller that
-- is allowed to consult the real clock, is the correct way to keep
-- this function both IMMUTABLE and genuinely real-time-aware).
--
-- WHY THIS CANNOT WEAKEN CORRECTNESS ELSEWHERE:
--   - Every branch above the early-export rule (confirmed Present/
--     Late, Off, Unassigned, the Absent-once-genuinely-confirmed-
--     closed branches, the no-check-in Pending branch) is completely
--     untouched -- p_as_of is read in exactly one new branch.
--   - attendance_apply_automatic already skips both 'pending' and
--     'check_in_only_provisional' results identically (neither is ever
--     written) -- this migration only changes WHICH of those two
--     non-writing outcomes a stale check-in-only shift reports, never
--     whether it is written.
--   - Omitting p_as_of (NULL, the default) reproduces the exact prior
--     behavior -- any caller not yet updated is unaffected.
-- ============================================================

CREATE OR REPLACE FUNCTION attendance_engine_calculate(
  p_shift_date DATE,
  p_resolved_shift TEXT,
  p_event_times TIMESTAMPTZ[],
  p_coverage_status TEXT,
  p_coverage_verified_through TIMESTAMPTZ,
  p_as_of TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  status TEXT,
  calculation_basis TEXT,
  check_in_at TIMESTAMPTZ,
  check_out_at TIMESTAMPTZ,
  reason TEXT
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_day_check_in CONSTANT TEXT[] := ARRAY['04:00', '08:00'];
  v_day_check_out CONSTANT TEXT[] := ARRAY['16:00', '20:00'];
  v_day_late_after CONSTANT TEXT := '06:15';
  v_night_check_in CONSTANT TEXT[] := ARRAY['16:00', '20:00'];
  v_night_check_out CONSTANT TEXT[] := ARRAY['04:00', '08:00'];
  v_night_late_after CONSTANT TEXT := '18:15';

  v_checkout_date DATE;
  v_checkin_window_start TIMESTAMPTZ;
  v_checkin_window_end TIMESTAMPTZ;
  v_checkout_window_start TIMESTAMPTZ;
  v_checkout_window_end TIMESTAMPTZ;
  v_late_after TIMESTAMPTZ;

  v_check_in_at TIMESTAMPTZ;
  v_check_out_at TIMESTAMPTZ;
  v_checkout_window_confirmed_closed BOOLEAN;
  v_t TIMESTAMPTZ;
BEGIN
  IF p_resolved_shift = 'off' THEN
    RETURN QUERY SELECT 'off'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, 'Scheduled Off day.'::TEXT;
    RETURN;
  END IF;
  IF p_resolved_shift = 'unassigned' THEN
    RETURN QUERY SELECT 'unassigned'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, 'No roster assignment recorded for this date.'::TEXT;
    RETURN;
  END IF;
  IF p_resolved_shift NOT IN ('day', 'night') THEN
    RAISE EXCEPTION 'attendance_engine_calculate: unrecognized resolved shift %', p_resolved_shift;
  END IF;

  -- Both shifts' check-in windows fall on the shift's own starting
  -- date; only a Night shift's checkout window crosses to the next date.
  v_checkout_date := CASE WHEN p_resolved_shift = 'night' THEN p_shift_date + 1 ELSE p_shift_date END;

  IF p_resolved_shift = 'day' THEN
    v_checkin_window_start := attendance_blantyre_to_utc(p_shift_date, v_day_check_in[1]);
    v_checkin_window_end := attendance_blantyre_to_utc(p_shift_date, v_day_check_in[2]);
    v_checkout_window_start := attendance_blantyre_to_utc(v_checkout_date, v_day_check_out[1]);
    v_checkout_window_end := attendance_blantyre_to_utc(v_checkout_date, v_day_check_out[2]);
    v_late_after := attendance_blantyre_to_utc(p_shift_date, v_day_late_after);
  ELSE
    v_checkin_window_start := attendance_blantyre_to_utc(p_shift_date, v_night_check_in[1]);
    v_checkin_window_end := attendance_blantyre_to_utc(p_shift_date, v_night_check_in[2]);
    v_checkout_window_start := attendance_blantyre_to_utc(v_checkout_date, v_night_check_out[1]);
    v_checkout_window_end := attendance_blantyre_to_utc(v_checkout_date, v_night_check_out[2]);
    v_late_after := attendance_blantyre_to_utc(p_shift_date, v_night_late_after);
  END IF;

  -- Earliest event within each window -- mirrors earliestEventInWindow()
  -- exactly (inclusive bounds, earliest wins, repeats never penalize).
  v_check_in_at := NULL;
  v_check_out_at := NULL;
  IF p_event_times IS NOT NULL THEN
    FOREACH v_t IN ARRAY p_event_times LOOP
      IF v_t >= v_checkin_window_start AND v_t <= v_checkin_window_end THEN
        IF v_check_in_at IS NULL OR v_t < v_check_in_at THEN v_check_in_at := v_t; END IF;
      END IF;
      IF v_t >= v_checkout_window_start AND v_t <= v_checkout_window_end THEN
        IF v_check_out_at IS NULL OR v_t < v_check_out_at THEN v_check_out_at := v_t; END IF;
      END IF;
    END LOOP;
  END IF;

  IF v_check_in_at IS NOT NULL AND v_check_out_at IS NOT NULL THEN
    IF v_check_in_at <= v_late_after THEN
      RETURN QUERY SELECT 'present'::TEXT, 'confirmed'::TEXT, v_check_in_at, v_check_out_at,
        'Valid check-in within grace period and valid checkout recorded.'::TEXT;
    ELSE
      RETURN QUERY SELECT 'late'::TEXT, 'confirmed'::TEXT, v_check_in_at, v_check_out_at,
        'Valid checkout recorded, but check-in was after the grace period.'::TEXT;
    END IF;
    RETURN;
  END IF;

  -- Completeness gate: can only finalize Absent once the LATER window
  -- (checkout, which always closes after check-in for both shift types)
  -- is confirmed closed by genuinely verified coverage. Unknown coverage
  -- (NULL status, or status not literally 'confirmed_complete') is
  -- NEVER treated as early-export proof of anything -- it falls through
  -- to the exact same branch as an explicit 'insufficient' status.
  v_checkout_window_confirmed_closed :=
    p_coverage_status = 'confirmed_complete'
    AND p_coverage_verified_through IS NOT NULL
    AND p_coverage_verified_through >= v_checkout_window_end;

  IF NOT v_checkout_window_confirmed_closed THEN
    IF v_check_in_at IS NOT NULL THEN
      -- Staleness gate (2026-11-25): once the checkout window has
      -- ALREADY genuinely passed as of the real p_as_of, there is no
      -- remaining opportunity for a checkout to appear in some later
      -- export -- the early-export credit below would otherwise stay
      -- permanently, incorrectly provisional. Falls to Pending, never
      -- Absent (coverage is still unconfirmed) and never a forever-
      -- stuck provisional Present/Late.
      IF p_as_of IS NOT NULL AND p_as_of >= v_checkout_window_end THEN
        RETURN QUERY SELECT 'pending'::TEXT, NULL::TEXT, v_check_in_at, NULL::TIMESTAMPTZ,
          'Valid check-in recorded, but the checkout window has already passed with no checkout observed and data coverage is still not confirmed complete; held as Pending for reconciliation rather than assumed Present or Absent.'::TEXT;
        RETURN;
      END IF;
      IF v_check_in_at <= v_late_after THEN
        RETURN QUERY SELECT 'present'::TEXT, 'check_in_only_provisional'::TEXT, v_check_in_at, NULL::TIMESTAMPTZ,
          'Valid check-in within grace period; credited Present under the early-export policy pending checkout window closure (no checkout observed yet).'::TEXT;
      ELSE
        RETURN QUERY SELECT 'late'::TEXT, 'check_in_only_provisional'::TEXT, v_check_in_at, NULL::TIMESTAMPTZ,
          'Check-in was after the grace period; credited Late under the early-export policy pending checkout window closure (no checkout observed yet).'::TEXT;
      END IF;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'pending'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
      'No valid check-in recorded yet -- the check-in window is not yet confirmed closed or data coverage is insufficient.'::TEXT;
    RETURN;
  END IF;

  IF v_check_in_at IS NOT NULL AND v_check_out_at IS NULL THEN
    RETURN QUERY SELECT 'absent'::TEXT, NULL::TEXT, v_check_in_at, NULL::TIMESTAMPTZ,
      'Valid check-in recorded, but no valid checkout was recorded after the checkout window closed.'::TEXT;
  ELSIF v_check_in_at IS NULL AND v_check_out_at IS NOT NULL THEN
    RETURN QUERY SELECT 'absent'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, v_check_out_at,
      'Valid checkout recorded, but no valid check-in was recorded.'::TEXT;
  ELSE
    RETURN QUERY SELECT 'absent'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
      'No valid fingerprint scans recorded for this scheduled shift after data coverage was confirmed complete.'::TEXT;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION attendance_engine_calculate(DATE, TEXT, TIMESTAMPTZ[], TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_engine_calculate(DATE, TEXT, TIMESTAMPTZ[], TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- attendance_resolve_and_calculate now supplies the real current time
-- as p_as_of on both of its calls into attendance_engine_calculate --
-- this orchestration function was never IMMUTABLE (SECURITY DEFINER,
-- reads live tables), so consulting the real clock here, exactly once,
-- is the correct place for it; attendance_engine_calculate itself still
-- never calls now()/clock_timestamp() internally. Otherwise byte-for-
-- byte identical to the 20261122000000 migration's definition -- no
-- other logic in this function changes.
CREATE OR REPLACE FUNCTION attendance_resolve_and_calculate(p_employee_id uuid, p_shift_date date)
RETURNS TABLE(status text, calculation_basis text, check_in_at timestamptz, check_out_at timestamptz, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
  v_resolved_shift TEXT;
  v_has_active_mapping BOOLEAN;
  v_event_times TIMESTAMPTZ[];
  v_checkin_window_start TIMESTAMPTZ;
  v_checkout_window_end TIMESTAMPTZ;
  v_coverage_status TEXT := 'insufficient';
  v_coverage_through TIMESTAMPTZ := NULL;
  v_assigned_terminals TEXT[];
  v_all_terminals_covered BOOLEAN;
BEGIN
  SELECT tenant_id INTO v_tenant_id FROM employees WHERE id = p_employee_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'attendance_resolve_and_calculate: no such employee %', p_employee_id;
  END IF;

  v_resolved_shift := roster_resolve_schedule(p_employee_id, p_shift_date);

  IF v_resolved_shift IN ('off', 'unassigned') THEN
    RETURN QUERY SELECT * FROM attendance_engine_calculate(p_shift_date, v_resolved_shift, NULL, 'insufficient', NULL, clock_timestamp());
    RETURN;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM hikcentral_person_mappings m
    WHERE m.employee_id = p_employee_id AND m.is_active AND m.tenant_id = v_tenant_id
  ) INTO v_has_active_mapping;

  IF v_has_active_mapping THEN
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

    -- Coverage completeness still requires EVERY one of this employee's
    -- own ACTIVE assigned terminals (never employees.workstation) to
    -- have a non-revoked, evidence-backed-or-independently-verified
    -- confirmation whose access_points include that terminal and whose
    -- covers_from/covers_through fully spans this shift's check-in-to-
    -- checkout window. An employee with zero assigned terminals simply
    -- never reaches 'confirmed_complete' here -- never an error, never
    -- a fabricated Absent; attendance_process_import_batch separately
    -- surfaces that as a configuration flag.
    SELECT COALESCE(array_agg(DISTINCT access_point), ARRAY[]::TEXT[]) INTO v_assigned_terminals
    FROM employee_hikcentral_terminals
    WHERE employee_id = p_employee_id AND tenant_id = v_tenant_id AND is_active;

    IF v_assigned_terminals IS NOT NULL AND array_length(v_assigned_terminals, 1) IS NOT NULL THEN
      SELECT bool_and(x.covered), MIN(x.covers_through) FILTER (WHERE x.covered)
        INTO v_all_terminals_covered, v_coverage_through
      FROM (
        SELECT
          EXISTS (
            SELECT 1 FROM fingerprint_coverage_confirmations c
            WHERE c.tenant_id = v_tenant_id
              AND c.revoked_at IS NULL
              AND c.access_points IS NOT NULL
              AND ap = ANY(c.access_points)
              AND c.covers_from <= v_checkin_window_start
              AND c.covers_through >= v_checkout_window_end
              AND (c.latest_observed_event_at IS NOT NULL OR (c.exceeds_observed_evidence AND c.independently_verified))
          ) AS covered,
          (
            SELECT c2.covers_through FROM fingerprint_coverage_confirmations c2
            WHERE c2.tenant_id = v_tenant_id
              AND c2.revoked_at IS NULL
              AND c2.access_points IS NOT NULL
              AND ap = ANY(c2.access_points)
              AND c2.covers_from <= v_checkin_window_start
              AND c2.covers_through >= v_checkout_window_end
              AND (c2.latest_observed_event_at IS NOT NULL OR (c2.exceeds_observed_evidence AND c2.independently_verified))
            ORDER BY c2.covers_through DESC LIMIT 1
          ) AS covers_through
        FROM unnest(v_assigned_terminals) AS ap
      ) x;

      IF v_all_terminals_covered THEN
        v_coverage_status := 'confirmed_complete';
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM attendance_engine_calculate(p_shift_date, v_resolved_shift, v_event_times, v_coverage_status, v_coverage_through, clock_timestamp());
END;
$$;
