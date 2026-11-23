-- ============================================================
-- MIGRATION: attendance_resolve_and_calculate now requires
-- evidence-backed (or explicitly independently-verified) coverage,
-- never a never-evidence-checked historical declaration.
-- Date: 2026-11-22
-- ============================================================
--
-- CONFIRMED TRUST GAP (production investigation, read-only):
-- 20261117000000_fingerprint_coverage_evidence_validation.sql added
-- latest_observed_event_at / exceeds_observed_evidence /
-- independently_verified to fingerprint_coverage_confirmations and
-- gated NEW confirmation writes on them -- but this function's own
-- per-terminal coverage check was never updated to read those columns
-- at all: it has only ever asked "does ANY unrevoked confirmation
-- exist whose window contains this shift's check-in-to-checkout
-- span", blind to whether that confirmation was ever actually checked
-- against observed fingerprint evidence.
--
-- Direct read-only inspection of production at the time of this
-- investigation found: 8 of 8 unrevoked confirmations in the system
-- are 'unsupported_historical' (latest_observed_event_at IS NULL AND
-- exceeds_observed_evidence = false -- i.e. never evidence-checked at
-- all, predating the 2026-11-17 safeguard), 0 are evidence_backed, 0
-- are independently_verified_override. Every one of 218 currently-live
-- automatic Absent rows (40 distinct employees, 39 distinct dates,
-- 2026-10-01 to 2026-11-15, one region, 13 workstations) therefore
-- rests entirely on a confirmation this tenant's OWN evidence-
-- validation safeguard would never have allowed to be WRITTEN today --
-- not because the confirmation is known to be false, but because it
-- was simply never checked. A further 389 historical automatic-Absent
-- writes were already caught and corrected by a human reviewer before
-- this fix, independent of it.
--
-- THE FIX (smallest safe change, additive logic only, no table/row
-- touched): a terminal's confirmation now only counts toward
-- 'confirmed_complete' coverage when it is NOT unsupported_historical
-- -- i.e. it must be evidence_backed (latest_observed_event_at IS NOT
-- NULL, within the declared window) OR independently_verified_override
-- (exceeds_observed_evidence AND independently_verified, which the
-- 20261117 migration's own CHECK constraint already requires a
-- documented human reason for). This mirrors, exactly and
-- deliberately, the same classification already shipped read-only in
-- attendance_coverage_explain (20261120020000, Attendance coverage
-- consistency PR) -- the official engine now agrees with what that
-- preview-explanation RPC has been saying all along, instead of the
-- client having to explain away a difference from the server's own
-- more permissive, not-yet-trust-checked behavior.
--
-- WHY THIS CANNOT WEAKEN CORRECTNESS ELSEWHERE:
--   - A genuinely CONFIRMED Present/Late (both a valid check-in AND a
--     valid checkout observed) is decided by attendance_engine_calculate
--     BEFORE coverage is even consulted -- this fix touches only the
--     coverage-adequacy SELECT inside attendance_resolve_and_calculate,
--     never attendance_engine_calculate itself. Confirmed Present/Late
--     outcomes are completely unaffected, by construction, not by
--     this migration's intent alone.
--   - Manual-correction precedence (attendance_write_one: p_source =
--     'automatic' is refused outright against an existing source =
--     'manual' row) and approved-payroll protection (same function,
--     flags + refuses) are untouched -- this migration edits no part
--     of attendance_write_one or attendance_apply_automatic.
--   - No existing fingerprint_coverage_confirmations row, attendance
--     row, or attendance_audit_log row is modified, inserted, or
--     deleted by this migration. The 218 currently-live automatic
--     Absent rows this fix newly disagrees with are NOT backfilled,
--     NOT reverted, and NOT silently left exactly as before either --
--     they simply stop being reproducible by any FUTURE automatic
--     recalculation (a future call to attendance_apply_automatic for
--     one of those exact employee-days will now resolve 'pending'
--     instead of 'absent', and attendance_apply_automatic's own
--     existing rule already never writes Pending over an existing
--     value) until a human reviews them. The exact read-only
--     reconciliation query used to find them is reproduced in this
--     PR's own description for whoever picks that review up; no
--     automatic reconciliation action is taken by this migration.
--   - Because 0 of the 8 existing confirmations have
--     independently_verified = true, this fix rejects zero currently-
--     legitimate independent-verification attestations -- there are
--     none yet to reject.
--
-- NOT FIXED HERE, BY DESIGN: this migration does not touch any
-- existing attendance row, payroll row, or coverage confirmation. A
-- separate, explicitly authorized reconciliation pass (reviewing the
-- 218 flagged employee-days) is a human decision, not a server-side
-- default.
-- ============================================================

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
    RETURN QUERY SELECT * FROM attendance_engine_calculate(p_shift_date, v_resolved_shift, NULL, 'insufficient', NULL);
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

    -- Step 11 (unchanged): coverage completeness still requires EVERY
    -- one of this employee's own ACTIVE assigned terminals (never
    -- employees.workstation) to have a non-revoked confirmation whose
    -- access_points include that terminal and whose covers_from/
    -- covers_through fully spans this shift's check-in-to-checkout
    -- window. An employee with zero assigned terminals simply never
    -- reaches 'confirmed_complete' here -- never an error, never a
    -- fabricated Absent; attendance_process_import_batch separately
    -- surfaces that as a configuration flag.
    SELECT COALESCE(array_agg(DISTINCT access_point), ARRAY[]::TEXT[]) INTO v_assigned_terminals
    FROM employee_hikcentral_terminals
    WHERE employee_id = p_employee_id AND tenant_id = v_tenant_id AND is_active;

    IF v_assigned_terminals IS NOT NULL AND array_length(v_assigned_terminals, 1) IS NOT NULL THEN
      -- 2026-11-22 coverage-trust fix: a matching confirmation now ALSO
      -- has to be evidence-backed or independently-verified-overridden
      -- -- never merely declared. "covered" below is deliberately NOT
      -- just existence+window-containment any more; an
      -- unsupported_historical match (never checked against observed
      -- evidence at all) is treated exactly like no confirmation at
      -- all for this terminal.
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

  RETURN QUERY SELECT * FROM attendance_engine_calculate(p_shift_date, v_resolved_shift, v_event_times, v_coverage_status, v_coverage_through);
END;
$$;
