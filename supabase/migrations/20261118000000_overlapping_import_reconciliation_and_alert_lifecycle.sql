-- ============================================================
-- MIGRATION: Attendance Automation -- Phase 2 Release B2: automatic
-- reconciliation across overlapping import batches, and site absence
-- alert lifecycle repair.
-- Date: 2026-11-18
-- ============================================================
--
-- PART A -- overnight-boundary reconciliation (confirmed gap):
-- attendance_process_import_batch already re-runs
-- attendance_apply_automatic for every employee it finds in scope, but
-- only over the caller's own declared [p_date_from, p_date_to] -- the
-- exact period the administrator is importing right now. A Night shift
-- that STARTS on the day before that period (e.g. the last date of the
-- PREVIOUS batch) has its checkout window on the morning of p_date_from
-- itself -- so when that checkout event arrives in THIS batch's export,
-- it is already visible to attendance_resolve_and_calculate's own event
-- window (which already looks backward independent of any batch
-- boundary), but the previous day's shift is never actually
-- RECALCULATED, because p_date_from-1 was never in either batch's own
-- declared range. Confirmed exactly: "Nov 1-10" then "Nov 10-18" never
-- revisits Nov 9's Night shift once its checkout lands in the second
-- batch's data -- it stays Pending forever unless someone manually
-- re-runs it.
--
-- FIX: widen the automatic re-apply window by exactly one day backward
-- (p_date_from - 1), reusing the SAME already-resolved employee scope
-- (which is batch/date-agnostic -- OBSERVED and EXPECTED-TERMINAL scope
-- are both scoped by access point, not by shift date). This is bounded
-- (exactly one extra day), idempotent (attendance_write_one's own
-- no-op guard), concurrency-safe (same per-employee-day advisory lock),
-- and respects every existing protection unchanged: manual-override
-- precedence and approved-payroll refusal both still apply via the same
-- unmodified attendance_write_one call. Never reaches back further than
-- one day, so this never becomes an expensive tenant-wide recalculation.
--
-- PART B -- site absence alert lifecycle repair (confirmed gap):
-- attendance_check_site_absence_alert() returns immediately whenever
-- NEW.status <> 'A' -- so the one event that should trigger
-- re-evaluation (an employee's status moving AWAY from Absent, e.g. a
-- later checkout reconciling a Pending/Absent back to Present, or a
-- manual correction) was silently ignored. Combined with
-- attendance_site_alert_acknowledge() being the ONLY way an alert's
-- status ever changes, this is exactly why production can show an
-- "open" alert with a live count of 0, 2, 3 or 4: the alert row is
-- frozen at creation and nothing ever re-evaluates it unless a human
-- manually acknowledges it, regardless of what the data now shows.
--
-- FIX: the trigger now fires on every status change (not just writes
-- that land on 'A') and recomputes the live count:
--   - count >= 5: create (or leave) the alert OPEN, exactly as before.
--   - count < 5 AND an OPEN alert exists for this (tenant, site, date):
--     auto-resolve it -- but ONLY if the system itself opened/last
--     touched it (closed_by IS NULL on the open row is not meaningful
--     since open rows never have closed_by set; the real distinction is
--     applied on CLOSE: an auto-resolution sets closed_by = NULL, a
--     human acknowledgement always sets closed_by = the caller's id).
--   - count >= 5 again AND the existing alert was auto-resolved
--     (status = 'closed' AND closed_by IS NULL): reopen it -- this is
--     just correcting the system's own prior record back to reality,
--     never overriding a human's judgment.
--
-- DOCUMENTED POLICY DECISION (per instruction to document reasonable
-- choices within the spec rather than ask): a HUMAN-acknowledged alert
-- (closed_by IS NOT NULL) is NEVER automatically reopened or re-closed
-- by this trigger, even if the count later rises back above threshold.
-- Once a human has reviewed and closed it, the system defers to that
-- judgment permanently for that exact (tenant, site, alert_date) row --
-- the UNIQUE constraint on that triple means a materially worse
-- recurrence on the SAME date cannot create a second alert either. This
-- is a known, narrow limitation (not fixed here, since redesigning
-- alert identity to support multiple acknowledgement cycles per day is
-- a genuinely separate design decision, not a bug in this lifecycle
-- fix) -- surfaced explicitly rather than silently worked around.
--
-- Nothing else changes: alert creation's own threshold/dedup logic,
-- the acknowledge RPC, RLS, and every attendance/payroll protection are
-- all reused completely unchanged.
-- ============================================================

-- ============================================================
-- PART A: attendance_process_import_batch -- widen the automatic
-- re-apply window by exactly one day backward. Same signature, so
-- CREATE OR REPLACE alone is sufficient (no DROP needed).
-- ============================================================
CREATE OR REPLACE FUNCTION attendance_process_import_batch(
  p_import_batch_id UUID,
  p_access_points TEXT[],
  p_covers_from TIMESTAMPTZ,
  p_covers_through TIMESTAMPTZ,
  p_date_from DATE,
  p_date_to DATE,
  p_notes TEXT DEFAULT NULL,
  p_workstations TEXT[] DEFAULT NULL,
  p_override_reason TEXT DEFAULT NULL,
  p_independently_verified BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_batch_tenant_id UUID; v_batch_status TEXT;
  v_sorted_access_points TEXT[];
  v_confirmation_id UUID;
  v_employee_ids UUID[];
  v_observed_ids UUID[];
  v_expected_terminal_ids UUID[];
  v_workstation_ids UUID[];
  v_results JSONB;
  v_applied_count INTEGER := 0;
  v_unchanged_count INTEGER := 0;
  v_skipped_count INTEGER := 0;
  v_needs_configuration JSONB;
  v_latest_observed_event_at TIMESTAMPTZ;
  v_exceeds_evidence BOOLEAN;
  v_evidence_gap_threshold INTERVAL := INTERVAL '2 hours';
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR has_permission('attendance.confirm_coverage')) THEN
    RAISE EXCEPTION 'Not authorized to confirm fingerprint coverage' USING ERRCODE = '42501';
  END IF;
  IF NOT (v_is_super_admin OR has_permission('attendance.auto_apply')) THEN
    RAISE EXCEPTION 'Not authorized to run automatic attendance processing' USING ERRCODE = '42501';
  END IF;

  IF p_import_batch_id IS NULL THEN RAISE EXCEPTION 'No import batch id supplied' USING ERRCODE = '22023'; END IF;
  SELECT tenant_id, status INTO v_batch_tenant_id, v_batch_status
  FROM hikcentral_import_batches WHERE id = p_import_batch_id;
  IF v_batch_tenant_id IS NULL THEN RAISE EXCEPTION 'Import batch not found' USING ERRCODE = '22023'; END IF;
  IF v_batch_tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'Import batch does not belong to your tenant' USING ERRCODE = '42501';
  END IF;
  IF v_batch_status <> 'completed' THEN
    RAISE EXCEPTION 'Import batch % is not completed (status=%)', p_import_batch_id, v_batch_status USING ERRCODE = '22023';
  END IF;

  IF p_access_points IS NULL OR array_length(p_access_points, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one access point must be declared' USING ERRCODE = '22023';
  END IF;
  IF p_covers_from IS NULL OR p_covers_through IS NULL OR p_covers_through <= p_covers_from THEN
    RAISE EXCEPTION 'p_covers_through must be after p_covers_from' USING ERRCODE = '22023';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_from > p_date_to THEN
    RAISE EXCEPTION 'A valid p_date_from <= p_date_to is required' USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(SELECT unnest(p_access_points) ORDER BY 1) INTO v_sorted_access_points;

  SELECT c.id INTO v_confirmation_id
  FROM fingerprint_coverage_confirmations c
  WHERE c.tenant_id = v_tenant_id
    AND c.revoked_at IS NULL
    AND c.covers_from = p_covers_from
    AND c.covers_through = p_covers_through
    AND c.access_points IS NOT NULL
    AND (SELECT ARRAY(SELECT unnest(c.access_points) ORDER BY 1)) = v_sorted_access_points
  LIMIT 1;

  IF v_confirmation_id IS NULL THEN
    SELECT MAX(r.event_time) INTO v_latest_observed_event_at
    FROM hikcentral_raw_events r
    WHERE r.tenant_id = v_tenant_id
      AND r.access_point = ANY(p_access_points)
      AND r.event_time >= p_covers_from
      AND r.event_time <= p_covers_through;

    v_exceeds_evidence := (v_latest_observed_event_at IS NULL)
      OR (p_covers_through - v_latest_observed_event_at > v_evidence_gap_threshold);

    IF v_exceeds_evidence AND (btrim(COALESCE(p_override_reason, '')) = '' OR NOT COALESCE(p_independently_verified, false)) THEN
      RETURN jsonb_build_object(
        'status', 'needs_override_reason',
        'latest_observed_event_at', v_latest_observed_event_at,
        'declared_covers_through', p_covers_through,
        'access_points', p_access_points
      );
    END IF;

    INSERT INTO fingerprint_coverage_confirmations (
      tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through,
      export_time_declared, notes, latest_observed_event_at, exceeds_observed_evidence, override_reason, independently_verified
    ) VALUES (
      v_tenant_id, v_caller_id, COALESCE(p_workstations, ARRAY[]::TEXT[]), p_access_points, p_covers_from, p_covers_through,
      p_covers_through, p_notes, v_latest_observed_event_at, v_exceeds_evidence,
      CASE WHEN btrim(COALESCE(p_override_reason, '')) = '' THEN NULL ELSE btrim(p_override_reason) END,
      COALESCE(p_independently_verified, false)
    )
    RETURNING id INTO v_confirmation_id;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT m.employee_id), ARRAY[]::UUID[]) INTO v_observed_ids
  FROM hikcentral_raw_events r
  JOIN hikcentral_person_mappings m
    ON m.hikcentral_person_no = r.hikcentral_person_no
    AND m.is_active
    AND m.tenant_id = r.tenant_id
  JOIN employees e ON e.id = m.employee_id
  WHERE r.tenant_id = v_tenant_id
    AND m.tenant_id = v_tenant_id
    AND r.access_point = ANY(p_access_points)
    AND r.event_time >= p_covers_from
    AND r.event_time <= p_covers_through
    AND e.tenant_id = v_tenant_id
    AND e.status = 'Active'
    AND e.is_deleted = false;

  SELECT COALESCE(array_agg(DISTINCT t.employee_id), ARRAY[]::UUID[]) INTO v_expected_terminal_ids
  FROM employee_hikcentral_terminals t
  JOIN employees e ON e.id = t.employee_id
  JOIN hikcentral_person_mappings m ON m.employee_id = t.employee_id AND m.is_active AND m.tenant_id = t.tenant_id
  WHERE t.tenant_id = v_tenant_id
    AND t.is_active
    AND t.access_point = ANY(p_access_points)
    AND e.tenant_id = v_tenant_id
    AND e.status = 'Active'
    AND e.is_deleted = false;

  IF p_workstations IS NOT NULL AND array_length(p_workstations, 1) IS NOT NULL THEN
    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[]) INTO v_workstation_ids
    FROM employees
    WHERE tenant_id = v_tenant_id
      AND workstation = ANY(p_workstations)
      AND status = 'Active'
      AND is_deleted = false;
  ELSE
    v_workstation_ids := ARRAY[]::UUID[];
  END IF;

  SELECT COALESCE(array_agg(DISTINCT eid), ARRAY[]::UUID[]) INTO v_employee_ids
  FROM unnest(v_observed_ids || v_expected_terminal_ids || v_workstation_ids) AS eid;

  IF array_length(v_employee_ids, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'applied',
      'confirmation_id', v_confirmation_id,
      'employee_count', 0,
      'applied_count', 0,
      'unchanged_count', 0,
      'skipped_count', 0,
      'failed_count', 0,
      'rows', '[]'::jsonb,
      'needs_terminal_configuration', '[]'::jsonb
    );
  END IF;

  -- PART A fix: p_date_from - 1, not p_date_from -- so a Night shift
  -- starting the day before this declared period, whose checkout
  -- arrives in THIS batch's events, is automatically re-evaluated
  -- rather than staying stuck exactly where the previous batch left it.
  SELECT
    jsonb_agg(to_jsonb(r)),
    count(*) FILTER (WHERE r.outcome = 'written'),
    count(*) FILTER (WHERE r.outcome = 'skipped_no_change'),
    count(*) FILTER (WHERE r.outcome NOT IN ('written', 'skipped_no_change'))
  INTO v_results, v_applied_count, v_unchanged_count, v_skipped_count
  FROM attendance_apply_automatic(v_employee_ids, p_date_from - 1, p_date_to) r;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('employee_id', e.id, 'full_name', e.full_name) ORDER BY e.full_name), '[]'::jsonb)
    INTO v_needs_configuration
  FROM employees e
  WHERE e.id = ANY(v_employee_ids)
    AND NOT EXISTS (
      SELECT 1 FROM employee_hikcentral_terminals t
      WHERE t.employee_id = e.id AND t.tenant_id = v_tenant_id AND t.is_active
    );

  RETURN jsonb_build_object(
    'status', 'applied',
    'confirmation_id', v_confirmation_id,
    'employee_count', array_length(v_employee_ids, 1),
    'applied_count', COALESCE(v_applied_count, 0),
    'unchanged_count', COALESCE(v_unchanged_count, 0),
    'skipped_count', COALESCE(v_skipped_count, 0),
    'failed_count', 0,
    'rows', COALESCE(v_results, '[]'::jsonb),
    'needs_terminal_configuration', COALESCE(v_needs_configuration, '[]'::jsonb)
  );
END;
$$;

-- ============================================================
-- PART B: site absence alert lifecycle -- fire on every status change,
-- not just writes landing on 'A'; auto-resolve/reopen alerts the
-- system itself owns (closed_by IS NULL), never touch a human-
-- acknowledged one (closed_by IS NOT NULL).
-- ============================================================
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
  -- Only re-evaluate when status actually changed (or this is a fresh
  -- INSERT) -- an UPDATE that leaves status untouched never reaches
  -- here per the trigger's own column list below, but TG_OP='INSERT'
  -- has no OLD row to compare, so always proceed for inserts.
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT workstation INTO v_site FROM employees WHERE id = NEW.employee_id;
  IF v_site IS NULL OR btrim(v_site) = '' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_count
  FROM attendance a
  JOIN employees e ON e.id = a.employee_id
  WHERE a.tenant_id = NEW.tenant_id
    AND a.date = NEW.date
    AND a.status = 'A'
    AND e.workstation = v_site;

  SELECT * INTO v_existing
  FROM attendance_site_absence_alerts
  WHERE tenant_id = NEW.tenant_id AND site = v_site AND alert_date = NEW.date
  FOR UPDATE;

  IF v_count >= 5 THEN
    IF v_existing.id IS NULL THEN
      INSERT INTO attendance_site_absence_alerts (tenant_id, site, alert_date, absent_count_at_creation)
      VALUES (NEW.tenant_id, v_site, NEW.date, v_count)
      ON CONFLICT (tenant_id, site, alert_date) DO NOTHING;
    ELSIF v_existing.status = 'closed' AND v_existing.closed_by IS NULL THEN
      -- The system auto-resolved this earlier; the count has genuinely
      -- recovered back above threshold -- reopen the SAME row (its
      -- original absent_count_at_creation/created_at are untouched,
      -- preserving the original incident's own audit history) rather
      -- than attempting a second INSERT, which the UNIQUE constraint
      -- would reject anyway.
      UPDATE attendance_site_absence_alerts
      SET status = 'open', closed_by = NULL, closed_at = NULL, closed_note = NULL
      WHERE id = v_existing.id;
    END IF;
    -- A human-acknowledged alert (closed_by IS NOT NULL) is deliberately
    -- left exactly as the human left it -- see migration header.
  ELSIF v_existing.id IS NOT NULL AND v_existing.status = 'open' THEN
    -- Count has genuinely fallen below threshold (a later checkout,
    -- reconciliation, or correction resolved it) -- auto-resolve. This
    -- is the system closing its OWN alert, never a human's, so
    -- closed_by is explicitly NULL, distinguishing it from a real
    -- acknowledgement at a glance.
    UPDATE attendance_site_absence_alerts
    SET status = 'closed', closed_by = NULL, closed_at = NOW(),
        closed_note = 'Automatically resolved: absence count fell below the 5-employee threshold after reconciliation.'
    WHERE id = v_existing.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_check_site_absence_alert ON attendance;
CREATE TRIGGER trg_attendance_check_site_absence_alert
  AFTER INSERT OR UPDATE OF status ON attendance
  FOR EACH ROW EXECUTE FUNCTION attendance_check_site_absence_alert();
