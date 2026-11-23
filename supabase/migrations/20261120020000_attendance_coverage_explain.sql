-- ============================================================
-- MIGRATION: Attendance Review coverage-consistency improvement --
-- a new, read-only, server-authoritative coverage explanation RPC.
-- Date: 2026-11-20
-- ============================================================
--
-- WHY: the Main Attendance Review and Stage C's client-side "JS
-- preview" have always decided coverage completeness from a SESSION-
-- LOCAL, operator-typed export-time/workstation claim
-- (resolveCoveragePolicy in attendanceCalculationPreview.ts) -- never
-- from the REAL, persisted fingerprint_coverage_confirmations +
-- employee_hikcentral_terminals evidence that attendance_resolve_and_
-- calculate already reads for the official engine and for Stage C's
-- own "server" column. That made the client systematically under-
-- report Absent as Pending whenever real coverage evidence already
-- existed server-side, and made Stage C's plain match/mismatch count
-- misleading. Confirmed investigating FALESI MLOTHO (SFG-S-274): after
-- PR #66's roster fix, Nov 3-4 still showed Server=Absent / JS=Pending
-- purely from this coverage-input asymmetry, not a calculation-engine
-- bug.
--
-- COVERAGE TRUST FINDING THIS FUNCTION DELIBERATELY DOES NOT
-- REPRODUCE: the 2026-11-17 migration
-- (fingerprint_coverage_evidence_validation.sql) added
-- latest_observed_event_at / exceeds_observed_evidence /
-- independently_verified columns and gates NEW confirmation writes on
-- them -- but attendance_resolve_and_calculate's own coverage EXISTS
-- check was never updated to read them, and EVERY unrevoked
-- confirmation currently in production predates that migration
-- (latest_observed_event_at IS NULL AND exceeds_observed_evidence =
-- false on all of them, confirmed by direct read-only inspection --
-- never evidence-checked at all, which is NOT the same claim as
-- "confirmed trustworthy"). This function classifies that exact
-- condition as 'unsupported_historical' and -- UNLIKE attendance_
-- resolve_and_calculate -- treats it as INSUFFICIENT evidence
-- (sufficient_evidence = false), per the explicit instruction not to
-- make the client blindly reproduce the official engine's current,
-- not-yet-trust-checked behavior. official_engine_trusts_this is
-- returned separately so a caller can explain the exact source of any
-- remaining Server/JS difference without it being misread as a
-- calculation-engine defect.
--
-- This migration does NOT touch attendance_resolve_and_calculate,
-- attendance_apply_automatic, attendance_write_one, attendance_
-- process_import_batch, or any other existing function, table, or
-- row -- it is purely additive (one new function). Fixing the
-- official engine's own current trust of unverified historical
-- confirmations is a separate, larger decision (it would retroactively
-- change what today resolves as Absent, tenant-wide, since 100% of
-- today's confirmations are 'unsupported_historical') and is reported,
-- not silently implemented, here -- see this PR's report for the
-- smallest safe corrective proposal.
-- ============================================================

CREATE OR REPLACE FUNCTION attendance_coverage_explain(
  p_employee_ids UUID[],
  p_date_from DATE,
  p_date_to DATE
)
RETURNS TABLE(
  employee_id UUID,
  shift_date DATE,
  resolved_shift TEXT,
  assigned_terminal_count INTEGER,
  checkout_window_end TIMESTAMPTZ,
  checkout_window_covered BOOLEAN,
  coverage_provenance TEXT,
  sufficient_evidence BOOLEAN,
  official_engine_trusts_this BOOLEAN,
  confirmed_through TIMESTAMPTZ,
  reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_employee_id UUID; v_date DATE;
  v_resolved_shift TEXT;
  v_checkin_window_start TIMESTAMPTZ;
  v_checkout_window_end TIMESTAMPTZ;
  v_has_active_mapping BOOLEAN;
  v_terminals TEXT[];
  v_terminal TEXT;
  v_all_covered BOOLEAN;
  v_any_unsupported BOOLEAN;
  v_any_verified_override BOOLEAN;
  v_min_covers_through TIMESTAMPTZ;
  v_m_covers_through TIMESTAMPTZ;
  v_m_latest_observed TIMESTAMPTZ;
  v_m_exceeds BOOLEAN;
  v_m_verified BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_from > p_date_to THEN
    RAISE EXCEPTION 'A valid p_date_from <= p_date_to is required' USING ERRCODE = '22023';
  END IF;
  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_employee_ids must not be empty' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  -- Same permission that already gates the Attendance Review tab and
  -- attendance_preview_calculate -- this RPC only ever explains an
  -- existing read-only comparison, never writes anything.
  IF NOT (v_is_super_admin OR has_permission('attendance.map_hikcentral_persons')) THEN
    RAISE EXCEPTION 'Not authorized to view attendance coverage evidence' USING ERRCODE = '42501';
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
      v_resolved_shift := roster_resolve_schedule(v_employee_id, v_date);

      IF v_resolved_shift IN ('off', 'unassigned') THEN
        employee_id := v_employee_id; shift_date := v_date; resolved_shift := v_resolved_shift;
        assigned_terminal_count := 0; checkout_window_end := NULL; checkout_window_covered := false;
        coverage_provenance := 'not_applicable'; sufficient_evidence := false;
        official_engine_trusts_this := false; confirmed_through := NULL;
        reason := CASE WHEN v_resolved_shift = 'off' THEN 'Scheduled Off day -- coverage is not applicable.'
                       ELSE 'No roster assignment recorded for this date -- coverage is not applicable.' END;
        RETURN NEXT;
        v_date := v_date + 1;
        CONTINUE;
      END IF;

      SELECT w.check_in_window_start, w.check_out_window_end
        INTO v_checkin_window_start, v_checkout_window_end
      FROM attendance_engine_shift_windows(v_date, v_resolved_shift) w;

      employee_id := v_employee_id; shift_date := v_date; resolved_shift := v_resolved_shift;
      checkout_window_end := v_checkout_window_end;

      -- Mirrors attendance_resolve_and_calculate's own FIRST check,
      -- performed before it ever looks at assigned terminals or
      -- confirmations: an employee with no ACTIVE HikCentral person
      -- mapping always stays 'insufficient' there, regardless of what
      -- employee_hikcentral_terminals might otherwise show (e.g. a
      -- terminal assignment left over after a mapping was deactivated).
      -- Matches the client's own existing hasActiveMapping distinction
      -- in attendanceCalculationPreview.ts -- never conflate "no terminal
      -- assigned" with "not actively mapped at all", they are different
      -- gaps with different remedies.
      SELECT EXISTS(
        SELECT 1 FROM hikcentral_person_mappings m
        WHERE m.employee_id = v_employee_id AND m.is_active AND m.tenant_id = v_tenant_id
      ) INTO v_has_active_mapping;

      IF NOT v_has_active_mapping THEN
        assigned_terminal_count := 0; checkout_window_covered := false;
        coverage_provenance := 'no_active_mapping'; sufficient_evidence := false;
        official_engine_trusts_this := false; confirmed_through := NULL;
        reason := 'No active HikCentral person mapping is confirmed for this employee yet -- coverage cannot be established regardless of any terminal assignment.';
        RETURN NEXT;
        v_date := v_date + 1;
        CONTINUE;
      END IF;

      SELECT COALESCE(array_agg(DISTINCT t.access_point), ARRAY[]::TEXT[]) INTO v_terminals
      FROM employee_hikcentral_terminals t
      WHERE t.employee_id = v_employee_id AND t.tenant_id = v_tenant_id AND t.is_active;

      assigned_terminal_count := COALESCE(array_length(v_terminals, 1), 0);

      IF assigned_terminal_count = 0 THEN
        checkout_window_covered := false; coverage_provenance := 'no_assigned_terminal';
        sufficient_evidence := false; official_engine_trusts_this := false; confirmed_through := NULL;
        reason := 'No fingerprint terminal is assigned to this employee yet -- coverage cannot be established.';
        RETURN NEXT;
        v_date := v_date + 1;
        CONTINUE;
      END IF;

      v_all_covered := true; v_any_unsupported := false; v_any_verified_override := false; v_min_covers_through := NULL;

      FOREACH v_terminal IN ARRAY v_terminals LOOP
        v_m_covers_through := NULL; v_m_latest_observed := NULL; v_m_exceeds := NULL; v_m_verified := NULL;

        SELECT c.covers_through, c.latest_observed_event_at, c.exceeds_observed_evidence, c.independently_verified
          INTO v_m_covers_through, v_m_latest_observed, v_m_exceeds, v_m_verified
        FROM fingerprint_coverage_confirmations c
        WHERE c.tenant_id = v_tenant_id
          AND c.revoked_at IS NULL
          AND c.access_points IS NOT NULL
          AND v_terminal = ANY(c.access_points)
          AND c.covers_from <= v_checkin_window_start
          AND c.covers_through >= v_checkout_window_end
        ORDER BY c.covers_through DESC
        LIMIT 1;

        IF v_m_covers_through IS NULL THEN
          v_all_covered := false;
        ELSE
          IF v_min_covers_through IS NULL OR v_m_covers_through < v_min_covers_through THEN
            v_min_covers_through := v_m_covers_through;
          END IF;
          IF v_m_latest_observed IS NULL AND NOT v_m_exceeds THEN
            v_any_unsupported := true;
          ELSIF v_m_exceeds AND v_m_verified THEN
            v_any_verified_override := true;
          END IF;
        END IF;
      END LOOP;

      checkout_window_covered := v_all_covered;
      -- Mirrors attendance_resolve_and_calculate's CURRENT (unmodified)
      -- coverage EXISTS check exactly: existence + window containment
      -- only, blind to provenance. Returned purely for explanatory
      -- comparison -- never used to decide sufficient_evidence below.
      official_engine_trusts_this := v_all_covered;

      IF NOT v_all_covered THEN
        coverage_provenance := 'no_coverage'; sufficient_evidence := false; confirmed_through := NULL;
        reason := 'Not every assigned terminal has a confirmed-coverage declaration spanning this shift''s checkout window -- treated as Pending, never a false Absent.';
      ELSIF v_any_unsupported THEN
        coverage_provenance := 'unsupported_historical'; sufficient_evidence := false; confirmed_through := v_min_covers_through;
        reason := 'Coverage is declared, but the declaration predates this tenant''s evidence-validation safeguard and was never checked against observed fingerprint events -- treated as Pending until a freshly evidence-checked confirmation exists, even though the server''s automatic engine currently still accepts it as-is.';
      ELSIF v_any_verified_override THEN
        coverage_provenance := 'independently_verified_override'; sufficient_evidence := true; confirmed_through := v_min_covers_through;
        reason := 'Coverage exceeds the observed fingerprint evidence, but an administrator explicitly, independently verified it was genuinely complete.';
      ELSE
        coverage_provenance := 'evidence_backed'; sufficient_evidence := true; confirmed_through := v_min_covers_through;
        reason := 'Coverage is confirmed and consistent with the observed fingerprint evidence for this period.';
      END IF;

      RETURN NEXT;
      v_date := v_date + 1;
    END LOOP;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION attendance_coverage_explain(UUID[], DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_coverage_explain(UUID[], DATE, DATE) TO authenticated;
