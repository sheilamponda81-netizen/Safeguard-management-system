-- Safeguard: prohibit premature absence when an import's declared coverage
-- extends into a shift that had not finished when coverage was confirmed.
-- November 27 export contained events only through ~07:12 Africa/Blantyre
-- but was confirmed as covering the entire date at ~13:35 local. The
-- erroneous confirmation generated 27 auto-absent rows at ~11:33 local.
-- Keep the verified absence policy for historic completed shifts, including
-- one-scan days. Never turn a scheduled Off/unassigned shift into Absent.
-- Store exact production definitions here, changing ONLY temporal evidence checks.
CREATE OR REPLACE FUNCTION public.attendance_engine_calculate(p_shift_date date, p_resolved_shift text, p_event_times timestamp with time zone[], p_coverage_status text, p_coverage_verified_through timestamp with time zone, p_as_of timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(status text, calculation_basis text, check_in_at timestamp with time zone, check_out_at timestamp with time zone, reason text)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    AND p_coverage_verified_through >= v_checkout_window_end
    -- A coverage statement must never turn a still-open shift into Absent.
    AND (p_as_of IS NULL OR p_as_of >= v_checkout_window_end);

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
    -- Part 1, rule E (new): distinguish "fingerprints exist but none
    -- qualify" from "no fingerprints at all" -- both are Absent
    -- (unchanged), only the explanation differs. p_event_times is the
    -- same wide surrounding-window event list the caller already
    -- supplies; a non-empty array here, with both windows above having
    -- matched nothing, means scans were detected outside the assigned
    -- shift's valid check-in/checkout windows.
    IF p_event_times IS NOT NULL AND array_length(p_event_times, 1) > 0 THEN
      RETURN QUERY SELECT 'absent'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
        'Fingerprint scans were detected for this employee, but none fell within the assigned shift''s valid check-in or checkout windows, and data coverage was confirmed complete.'::TEXT;
    ELSE
      RETURN QUERY SELECT 'absent'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
        'No valid fingerprint scans recorded for this scheduled shift after data coverage was confirmed complete.'::TEXT;
    END IF;
  END IF;
END;
$function$


CREATE OR REPLACE FUNCTION public.attendance_resolve_and_calculate(p_employee_id uuid, p_shift_date date)
 RETURNS TABLE(status text, calculation_basis text, check_in_at timestamp with time zone, check_out_at timestamp with time zone, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

    -- Automatic fingerprint terminal resolution: the employee's own
    -- assignment if any, else the shared site-level fallback (never
    -- both, never neither-then-invent) -- see attendance_employee_
    -- eligible_terminals's own header. An employee with an empty
    -- result here simply never reaches 'confirmed_complete' below --
    -- never an error, never a fabricated Absent; attendance_process_
    -- import_batch separately surfaces that as a configuration flag.
    SELECT COALESCE(array_agg(DISTINCT access_point), ARRAY[]::TEXT[]) INTO v_assigned_terminals
    FROM attendance_employee_eligible_terminals(v_tenant_id, p_employee_id);

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
              -- Coverage cannot certify a shift that had not finished when it was confirmed.
              AND c.confirmed_at >= v_checkout_window_end
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
              -- Coverage cannot certify a shift that had not finished when it was confirmed.
              AND c2.confirmed_at >= v_checkout_window_end
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
$function$


CREATE OR REPLACE FUNCTION public.attendance_coverage_explain(p_employee_ids uuid[], p_date_from date, p_date_to date)
 RETURNS TABLE(employee_id uuid, shift_date date, resolved_shift text, assigned_terminal_count integer, checkout_window_end timestamp with time zone, checkout_window_covered boolean, coverage_provenance text, sufficient_evidence boolean, official_engine_trusts_this boolean, confirmed_through timestamp with time zone, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_site_config_exists BOOLEAN;
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

      SELECT COALESCE(array_agg(DISTINCT access_point), ARRAY[]::TEXT[]) INTO v_terminals
      FROM attendance_employee_eligible_terminals(v_tenant_id, v_employee_id);

      assigned_terminal_count := COALESCE(array_length(v_terminals, 1), 0);

      IF assigned_terminal_count = 0 THEN
        checkout_window_covered := false;
        -- Distinguish a genuine configuration gap (nothing at all
        -- exists for this employee yet) from an employee whose site
        -- already has a shared terminal configuration but who has not
        -- been explicitly enabled for automatic fingerprint attendance
        -- -- governed solely by the explicit fingerprint_attendance_
        -- enabled flag (PART 1B/3), never inferred from attendance
        -- history. Both still correctly report sufficient_evidence =
        -- false (never a fabricated Absent either way), but the REASON
        -- a reviewer sees must never conflate "nobody has configured
        -- this yet" with "this employee just hasn't been turned on".
        SELECT EXISTS (
          SELECT 1 FROM site_hikcentral_terminals s
          JOIN employees e ON e.id = v_employee_id
          WHERE s.tenant_id = v_tenant_id AND s.is_active
            AND s.site = upper(btrim(regexp_replace(COALESCE(e.workstation, ''), '\s+', ' ', 'g')))
        ) INTO v_site_config_exists;

        IF v_site_config_exists AND NOT EXISTS (
          SELECT 1 FROM hikcentral_person_mappings m
          WHERE m.tenant_id = v_tenant_id AND m.employee_id = v_employee_id AND m.is_active
            AND m.fingerprint_attendance_enabled
        ) THEN
          coverage_provenance := 'fingerprint_not_enabled';
          reason := 'A shared site-level terminal configuration exists for this employee''s workstation, but automatic fingerprint attendance has not been explicitly enabled for this employee yet -- enable it individually or in bulk for the site to begin automatic processing.';
        ELSE
          coverage_provenance := 'no_assigned_terminal';
          reason := 'No fingerprint terminal is assigned to this employee, and no shared site-level terminal configuration exists for their workstation yet -- coverage cannot be established.';
        END IF;
        sufficient_evidence := false; official_engine_trusts_this := false; confirmed_through := NULL;
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
           -- Match the official engine's no-future-confirmation safeguard.
           AND c.confirmed_at >= v_checkout_window_end
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
      official_engine_trusts_this := v_all_covered;

      IF NOT v_all_covered THEN
        coverage_provenance := 'no_coverage'; sufficient_evidence := false; confirmed_through := NULL;
        reason := 'Not every eligible terminal has a confirmed-coverage declaration spanning this shift''s checkout window -- treated as Pending, never a false Absent.';
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
$function$


-- Undo ONLY demonstrably premature automated November 27 absences:
-- all 27 were recorded before their 20:00 local checkout window closed.
-- Preserve every original audit row and add a compensating audit record.
-- Do not mutate any payroll, manually edited attendance, or other dates.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.payroll p
    WHERE p.tenant_id = 'deaeb8c9-20d1-47e3-8631-513108f6bb17'::uuid
      AND p.month = '2026-11'
  ) THEN
    RAISE EXCEPTION 'Nov 2026 payroll exists; stop premature-absence remediation for manual review';
  END IF;
END $$;

WITH invalidated AS (
  DELETE FROM public.attendance a
  WHERE a.tenant_id = 'deaeb8c9-20d1-47e3-8631-513108f6bb17'::uuid
    AND a.date = DATE '2026-11-27'
    AND a.source = 'automatic'
    AND a.status = 'A'
    AND EXISTS (
      SELECT 1 FROM public.attendance_audit_log l
      WHERE l.tenant_id = a.tenant_id
        AND l.employee_id = a.employee_id
        AND l.attendance_date = a.date
        AND l.change_source = 'automatic'
        AND l.new_status = 'A'
        AND l.changed_at >= TIMESTAMPTZ '2026-11-27 09:30:00+00'
        AND l.changed_at < TIMESTAMPTZ '2026-11-27 09:40:00+00'
        AND l.old_status IS NULL
    )
  RETURNING a.tenant_id, a.employee_id, a.date, a.status, a.calculation_basis
)
INSERT INTO public.attendance_audit_log (
  tenant_id, employee_id, attendance_date, old_status, new_status,
  old_calculation_basis, new_calculation_basis, changed_by, change_source, reason
)
SELECT tenant_id, employee_id, date, status, NULL,
       calculation_basis, NULL, NULL, 'automatic',
       '2026-11-28 controlled reversal: Nov 27 attendance was finalized Absent from a coverage declaration made before that shift checkout window closed. Pending until a later complete export; original audit rows retained.'
FROM invalidated;
