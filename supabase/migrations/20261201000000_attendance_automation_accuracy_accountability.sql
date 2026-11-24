-- ============================================================
-- MIGRATION: Attendance automation accuracy + site-level cluster
-- alert accuracy/accountability improvements.
-- Date: 2026-12-01
-- ============================================================
--
-- CONFIRMED DURING DISCOVERY (read-only investigation, no row touched):
-- the core automatic attendance policy the user described -- Present/
-- Late on a confirmed check-in+checkout pair, and Absent for "no
-- scans", "check-in only", "checkout only" and "scans outside the
-- window" once fingerprint coverage is confirmed_complete for the
-- whole shift -- is ALREADY exactly what attendance_engine_calculate()/
-- attendance_resolve_and_calculate() (live def:
-- 20261125000000_attendance_early_export_staleness_gate.sql) and
-- attendance_apply_automatic() (live def:
-- 20261016000000_attendance_import_auto_apply.sql) implement today.
-- Pending is already preserved correctly for genuinely incomplete
-- evidence (missing/insufficient coverage, an unresolved mapping, or a
-- shift that hasn't finished yet) and never silently decays into
-- Absent. No change to that state machine is needed or made here.
--
-- Two narrowly scoped, confirmed gaps remain, fixed below:
--
-- PART 1 -- distinct explanation for "scans detected but none in
-- window" (business rule E): attendance_engine_calculate's final
-- branch (both check-in and checkout absent, coverage confirmed
-- complete) gave the exact same reason text regardless of whether
-- ZERO fingerprint events existed for this employee anywhere nearby,
-- or events existed but none fell inside the assigned shift's valid
-- check-in/checkout windows. The classification (Absent) was already
-- correct and is UNCHANGED by this migration -- only the explanation
-- text now distinguishes the two cases, using p_event_times/events
-- (already passed into this function) rather than any new input. This
-- also mirrors into the TypeScript engine (src/utils/
-- attendanceCalculationEngine.ts) for parity, verified by
-- attendanceEngineSqlParity.test.ts.
--
-- PART 2 -- site-level cluster alert threshold + accuracy:
-- attendance_site_absence_alerts already exists (20261017000000,
-- lifecycle-repaired in 20261118000000) and already does almost
-- everything Part 2 of this task asks for -- reused completely as-is,
-- no new table or RPC. Two confirmed gaps:
--   (a) the threshold was ">= 5" (the user's own business rule is
--       "more than five", i.e. six or more) -- raised to ">= 6"
--       everywhere it appears (the table's CHECK constraint, the
--       trigger, and its auto-resolve note text).
--   (b) the trigger's and the list RPC's own live count both counted
--       EVERY 'A' row at the site/date, including one written with
--       source = 'manual' -- an HR correction (including, in
--       particular, a correction for an employee who is fundamentally
--       on manual attendance with no fingerprint coverage expectation
--       at all) is never fingerprint-anomaly evidence and must not
--       contribute to a "suspected device/export outage" signal it was
--       never backing. Both now filter to source = 'automatic', which
--       -- by construction, since attendance_resolve_and_calculate can
--       only ever return 'absent' once a genuine, administrator-
--       declared fingerprint_coverage_confirmations row spans the whole
--       shift -- means every counted row really is a confirmed,
--       evidence-gated fingerprint absence.
-- Off/Unassigned/Pending/Leave were already excluded (never written to
-- attendance.status at all), and duplicate attendance rows were already
-- impossible (UNIQUE(employee_id, date) backs attendance_write_one's
-- own upsert) -- both already satisfied, unchanged.
--
-- ADDED (new, additive output column on the list RPC only -- requires a
-- DROP+CREATE since changing RETURNS TABLE's column list is not a
-- CREATE OR REPLACE-compatible change in Postgres): a best-effort,
-- site/date-level "coverage state" summary and a "suspected device or
-- import issue" flag, derived entirely from the SAME
-- fingerprint_coverage_confirmations rows already used to gate Absent,
-- joined through the currently-affected employees' own assigned
-- terminals. This is a DAY-LEVEL approximation (it does not re-derive
-- each individual employee's exact shift window), deliberately
-- advisory only: it flags exceeds_observed_evidence (a confirmation
-- whose declared coverage reaches materially beyond the latest
-- fingerprint event actually observed for that access point) as the
-- signal that a device/export may not have reported for the whole
-- declared window -- never proof of an outage, and this migration
-- never reverses, rewrites or creates any attendance/payroll row as a
-- result of it. A human still acknowledges or investigates.
-- ============================================================

-- ------------------------------------------------------------
-- PART 1: attendance_engine_calculate -- distinct Absent explanation
-- for "scans detected but none in window" vs "no scans at all".
-- Same signature; classification completely unchanged.
-- ------------------------------------------------------------
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
$$;

REVOKE ALL ON FUNCTION attendance_engine_calculate(DATE, TEXT, TIMESTAMPTZ[], TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_engine_calculate(DATE, TEXT, TIMESTAMPTZ[], TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ------------------------------------------------------------
-- PART 2A: raise the site-level cluster alert threshold from "5 or
-- more" to "6 or more" (the user's own rule: "more than five").
--
-- RELEASE SAFETY FIX (post-review): production already holds 73
-- historical attendance_site_absence_alerts rows with
-- absent_count_at_creation = 5 (25 of them still 'open'), all valid
-- under the OLD ">= 5" constraint this replaces. A plain ADD
-- CONSTRAINT validates every existing row by default and would abort
-- this migration part-way through on first production apply --
-- reproduced and confirmed directly against a disposable Postgres
-- seeded with the same precondition. NOT VALID makes Postgres skip
-- that historical validation scan entirely: the constraint still
-- applies in full to every INSERT and every UPDATE of this column
-- from this point forward (confirmed: a new row with
-- absent_count_at_creation = 5 is still rejected), it just never
-- retroactively re-checks rows that already exist. No historical
-- alert is read, closed, or rewritten by this statement -- NOT VALID
-- is pure DDL metadata, not a data scan. Deliberately NOT followed by
-- VALIDATE CONSTRAINT: that would perform the exact full-table
-- historical scan being avoided here, and is explicitly out of scope
-- for this release (see the business rationale above -- those 73 rows
-- predate the "six or more" rule entirely and are not being
-- reconciled as part of it).
-- ------------------------------------------------------------
ALTER TABLE attendance_site_absence_alerts DROP CONSTRAINT IF EXISTS attendance_site_absence_alerts_absent_count_at_creation_check;
ALTER TABLE attendance_site_absence_alerts ADD CONSTRAINT attendance_site_absence_alerts_absent_count_at_creation_check CHECK (absent_count_at_creation >= 6) NOT VALID;

-- ------------------------------------------------------------
-- PART 2B: trigger function -- threshold 6, and scoped to
-- source = 'automatic' only (see migration header). Same trigger
-- (AFTER INSERT OR UPDATE OF status ON attendance) is reused unchanged.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION attendance_check_site_absence_alert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_site TEXT;
  v_count INTEGER;
  v_existing attendance_site_absence_alerts;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT workstation INTO v_site FROM employees WHERE id = NEW.employee_id;
  IF v_site IS NULL OR btrim(v_site) = '' THEN
    RETURN NEW;
  END IF;

  -- source = 'automatic' only -- see migration header: a manual
  -- correction (whatever the reason, including a fundamentally
  -- manual-attendance employee) is never fingerprint-anomaly evidence.
  SELECT count(*) INTO v_count
  FROM attendance a
  JOIN employees e ON e.id = a.employee_id
  WHERE a.tenant_id = NEW.tenant_id
    AND a.date = NEW.date
    AND a.status = 'A'
    AND a.source = 'automatic'
    AND e.workstation = v_site;

  SELECT * INTO v_existing
  FROM attendance_site_absence_alerts
  WHERE tenant_id = NEW.tenant_id AND site = v_site AND alert_date = NEW.date
  FOR UPDATE;

  IF v_count >= 6 THEN
    IF v_existing.id IS NULL THEN
      INSERT INTO attendance_site_absence_alerts (tenant_id, site, alert_date, absent_count_at_creation)
      VALUES (NEW.tenant_id, v_site, NEW.date, v_count)
      ON CONFLICT (tenant_id, site, alert_date) DO NOTHING;
    ELSIF v_existing.status = 'closed' AND v_existing.closed_by IS NULL THEN
      -- The system auto-resolved this earlier; the count has genuinely
      -- recovered back above threshold -- reopen the SAME row (its
      -- original absent_count_at_creation/created_at are untouched,
      -- preserving the original incident's own audit history).
      UPDATE attendance_site_absence_alerts
      SET status = 'open', closed_by = NULL, closed_at = NULL, closed_note = NULL
      WHERE id = v_existing.id;
    END IF;
    -- A human-acknowledged alert (closed_by IS NOT NULL) is deliberately
    -- left exactly as the human left it -- see 20261118000000's header.
  ELSIF v_existing.id IS NOT NULL AND v_existing.status = 'open' THEN
    UPDATE attendance_site_absence_alerts
    SET status = 'closed', closed_by = NULL, closed_at = NOW(),
        closed_note = 'Automatically resolved: automatic (fingerprint-derived) absence count fell below the 6-employee threshold after reconciliation.'
    WHERE id = v_existing.id;
  END IF;

  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- PART 2C: list RPC -- same source='automatic' scoping for the live
-- recomputed count/employee list (so the UI's displayed numbers always
-- agree with what actually opens/closes the alert), plus two new,
-- additive output columns: coverage_state and
-- suspected_device_or_import_issue (see migration header for exactly
-- what they mean and their deliberately advisory-only scope). Changing
-- RETURNS TABLE's column list is not CREATE-OR-REPLACE-compatible, so
-- the old single-signature function is dropped first; there is no
-- other overload of this name/arg-type to leave dangling.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS attendance_site_absence_alerts_list(TEXT);

CREATE OR REPLACE FUNCTION attendance_site_absence_alerts_list(p_status TEXT DEFAULT NULL)
RETURNS TABLE (
  id UUID,
  site TEXT,
  alert_date DATE,
  status TEXT,
  absent_count_at_creation INTEGER,
  current_absent_count INTEGER,
  affected_employees JSONB,
  coverage_state JSONB,
  suspected_device_or_import_issue BOOLEAN,
  created_at TIMESTAMPTZ,
  closed_by UUID,
  closed_at TIMESTAMPTZ,
  closed_note TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE profiles.id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR has_permission('attendance.view')) THEN
    RAISE EXCEPTION 'Not authorized to view attendance' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'p_status must be open or closed' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    al.id, al.site, al.alert_date, al.status, al.absent_count_at_creation,
    (SELECT count(*)::INTEGER FROM attendance a JOIN employees e ON e.id = a.employee_id
       WHERE a.tenant_id = al.tenant_id AND a.date = al.alert_date AND a.status = 'A' AND a.source = 'automatic' AND e.workstation = al.site) AS current_absent_count,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('employee_id', e.id, 'full_name', e.full_name) ORDER BY e.full_name), '[]'::jsonb)
       FROM attendance a JOIN employees e ON e.id = a.employee_id
       WHERE a.tenant_id = al.tenant_id AND a.date = al.alert_date AND a.status = 'A' AND a.source = 'automatic' AND e.workstation = al.site) AS affected_employees,
    -- Best-effort, DAY-LEVEL coverage summary across the currently
    -- affected employees' own assigned terminals -- not a re-derivation
    -- of each individual shift window (that remains
    -- attendance_resolve_and_calculate's own, authoritative job).
    (
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
          'access_points', c.access_points,
          'covers_through', c.covers_through,
          'exceeds_observed_evidence', c.exceeds_observed_evidence,
          'independently_verified', c.independently_verified
        )), '[]'::jsonb)
      FROM employee_hikcentral_terminals t
      JOIN employees e2 ON e2.id = t.employee_id AND e2.workstation = al.site
      JOIN attendance a2 ON a2.employee_id = t.employee_id AND a2.date = al.alert_date AND a2.status = 'A' AND a2.source = 'automatic'
      JOIN fingerprint_coverage_confirmations c ON c.tenant_id = al.tenant_id AND c.revoked_at IS NULL AND t.access_point = ANY(c.access_points)
        AND c.covers_from <= attendance_blantyre_to_utc(al.alert_date, '00:00')
        AND c.covers_through >= attendance_blantyre_to_utc(al.alert_date + 1, '00:00')
      WHERE t.tenant_id = al.tenant_id AND t.is_active
    ) AS coverage_state,
    EXISTS (
      SELECT 1
      FROM employee_hikcentral_terminals t
      JOIN employees e2 ON e2.id = t.employee_id AND e2.workstation = al.site
      JOIN attendance a2 ON a2.employee_id = t.employee_id AND a2.date = al.alert_date AND a2.status = 'A' AND a2.source = 'automatic'
      JOIN fingerprint_coverage_confirmations c ON c.tenant_id = al.tenant_id AND c.revoked_at IS NULL AND t.access_point = ANY(c.access_points)
        AND c.covers_from <= attendance_blantyre_to_utc(al.alert_date, '00:00')
        AND c.covers_through >= attendance_blantyre_to_utc(al.alert_date + 1, '00:00')
        AND c.exceeds_observed_evidence
      WHERE t.tenant_id = al.tenant_id AND t.is_active
    ) AS suspected_device_or_import_issue,
    al.created_at, al.closed_by, al.closed_at, al.closed_note
  FROM attendance_site_absence_alerts al
  WHERE al.tenant_id = v_tenant_id
    AND (p_status IS NULL OR al.status = p_status)
  ORDER BY al.alert_date DESC, al.site;
END;
$$;

REVOKE ALL ON FUNCTION attendance_site_absence_alerts_list(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_site_absence_alerts_list(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- PART 3: resolve_staff_names -- Evidence Centre accountability.
--
-- attendance_audit_log.changed_by and fingerprint_coverage_
-- confirmations.confirmed_by are raw profile ids; no existing code
-- anywhere in this codebase resolves either to a display name (grepped
-- for the pattern -- the Evidence Centre panel and AuditLogs.tsx both
-- show the raw id or nothing). profiles' own RLS ("Users can view own
-- profile or, as Admin, their tenant's") would make a plain client-side
-- select return NOTHING for most functional roles looking up a
-- DIFFERENT user's name. This narrow, read-only, SECURITY DEFINER RPC
-- closes exactly that gap: it returns ONLY id + full_name (never any
-- other profile column, e.g. never role, email, region) for the
-- requested ids, and only within the caller's own tenant (a super
-- admin may cross tenants, same convention as every other RPC in this
-- file). A requested id with no matching profile in scope is simply
-- absent from the result -- the caller (not this function) decides
-- the "identity unavailable" wording, since that is a presentation
-- choice, not a data-access one.
--
-- RELEASE SAFETY FIX (post-review): this RPC exists to serve ONE
-- caller -- the Evidence Centre panel -- which gates its own page
-- access on attendance.map_hikcentral_persons
-- (AttendanceEvidenceCentre.tsx / Attendance.tsx's canReview check),
-- NOT attendance.view. The first draft of this function gated on
-- attendance.view instead, copying attendance_site_absence_alerts_
-- list's own (separate, pre-existing, unrelated) permission rather
-- than matching the page that actually calls it. In production,
-- attendance.map_hikcentral_persons and attendance.view are granted to
-- two non-overlapping roles (hr_manager and operations_manager
-- respectively) -- so an HR Manager who can open the Evidence Centre
-- page at all would have been unable to resolve any actor's name on
-- it, defeating this feature's entire purpose for its real intended
-- user. Gating on attendance.map_hikcentral_persons instead aligns
-- this RPC with the page's own access model exactly -- no caller who
-- could not already open the Evidence Centre gains anything new, and
-- no caller who could open it loses anything. attendance_site_
-- absence_alerts_list's own gate is untouched -- it is a separate,
-- pre-existing function with its own separate caller (the Alerts tab)
-- and is out of scope for this fix.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_staff_names(p_user_ids UUID[])
RETURNS TABLE (user_id UUID, full_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE profiles.id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR has_permission('attendance.map_hikcentral_persons')) THEN
    RAISE EXCEPTION 'Not authorized to view attendance' USING ERRCODE = '42501';
  END IF;

  IF p_user_ids IS NULL OR array_length(p_user_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.full_name
  FROM profiles p
  WHERE p.id = ANY(p_user_ids)
    AND (v_is_super_admin OR p.tenant_id = v_tenant_id);
END;
$$;

REVOKE ALL ON FUNCTION resolve_staff_names(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION resolve_staff_names(UUID[]) TO authenticated;
