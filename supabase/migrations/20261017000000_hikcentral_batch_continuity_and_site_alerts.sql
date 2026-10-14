-- ============================================================
-- MIGRATION: Attendance Automation -- Stage C, Step 10: daily
-- operational workflow -- batch continuity (gap detection across
-- HikCentral exports) and site-level absence alerts.
-- Date: 2026-10-17
-- ============================================================
--
-- SCOPE: this migration does NOT redesign attendance calculation,
-- roster resolution, or the existing one-click import->auto-apply flow
-- (Stage C Steps 8/8B) -- all of that is reused completely unchanged.
-- It adds exactly two independent, additive capabilities operators need
-- for *regular* (not one-off) HikCentral exports:
--   PART 1: per-terminal/workstation coverage-timeline visibility, so an
--     operator can see what is already covered, what is missing, and
--     what to upload next -- without ever inferring "missing export" as
--     "confirmed Absent" (that distinction is already enforced by
--     attendance_resolve_and_calculate; this part is purely informational).
--   PART 2: a minimal in-app alert when 5+ employees at the same
--     SCHEDULED (roster) site are Absent on the same date -- grouped by
--     where they were supposed to be, never by who did or didn't
--     fingerprint.
--
-- "Accept legitimate overlap between exports", "never delete/duplicate
-- earlier attendance", "reuse existing dedup/idempotency", and "process
-- valid covered dates without forcing manual ticking" are ALL already
-- true of the existing attendance_process_import_batch/
-- attendance_write_one/hikcentral_raw_events design (Stage C Steps 1-9) --
-- each call already processes only its own declared, independent
-- date range, and every underlying write is already idempotent. Nothing
-- about that needs to change here; this migration only adds visibility
-- into gaps between calls, and records one new fact (access_points) per
-- confirmation so that visibility can be per-terminal, not just
-- per-workstation.
-- ============================================================

-- ============================================================
-- PART 1A: fingerprint_coverage_confirmations -- record declared
-- access_points too (previously accepted by attendance_process_import_
-- batch's p_access_points but never persisted -- without this, a
-- per-terminal coverage timeline has nothing to read).
-- ============================================================
ALTER TABLE fingerprint_coverage_confirmations
  ADD COLUMN IF NOT EXISTS access_points TEXT[] NULL;

-- The append-only guard must treat the new column the same as every
-- other identity/content column (immutable after creation, only
-- revoked_at/revoked_by/revoked_reason may ever change).
CREATE OR REPLACE FUNCTION fingerprint_coverage_confirmation_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Coverage confirmations are append-only: an already-revoked record can never be modified again' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.workstations IS DISTINCT FROM OLD.workstations
     OR NEW.access_points IS DISTINCT FROM OLD.access_points
     OR NEW.covers_from IS DISTINCT FROM OLD.covers_from
     OR NEW.covers_through IS DISTINCT FROM OLD.covers_through
     OR NEW.export_time_declared IS DISTINCT FROM OLD.export_time_declared
     OR NEW.notes IS DISTINCT FROM OLD.notes
  THEN
    RAISE EXCEPTION 'Coverage confirmations are append-only: identity/content columns cannot be modified -- revoke and create a new confirmation instead' USING ERRCODE = '42501';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Coverage confirmations are append-only: an UPDATE may only revoke a record, never leave it unrevoked' USING ERRCODE = '42501';
  END IF;
  IF NEW.revoked_by IS NULL THEN
    RAISE EXCEPTION 'revoked_by is required when revoking a coverage confirmation' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- PART 1B: attendance_process_import_batch -- persist p_access_points
-- (already accepted, already used for scope-building since Step 8B) into
-- the new access_points column. Signature, scope logic, permission
-- gates, and the idempotent confirmation-reuse match key (workstations +
-- covers_from + covers_through) are completely UNCHANGED -- only the
-- INSERT gains one more column.
-- ============================================================
CREATE OR REPLACE FUNCTION attendance_process_import_batch(
  p_import_batch_id UUID,
  p_workstations TEXT[],
  p_covers_from TIMESTAMPTZ,
  p_covers_through TIMESTAMPTZ,
  p_date_from DATE,
  p_date_to DATE,
  p_notes TEXT DEFAULT NULL,
  p_access_points TEXT[] DEFAULT NULL
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
  v_sorted_workstations TEXT[];
  v_confirmation_id UUID;
  v_employee_ids UUID[];
  v_observed_employee_ids UUID[];
  v_results JSONB;
  v_applied_count INTEGER := 0;
  v_unchanged_count INTEGER := 0;
  v_skipped_count INTEGER := 0;
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

  IF p_workstations IS NULL OR array_length(p_workstations, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one workstation must be named' USING ERRCODE = '22023';
  END IF;
  IF p_covers_from IS NULL OR p_covers_through IS NULL OR p_covers_through <= p_covers_from THEN
    RAISE EXCEPTION 'p_covers_through must be after p_covers_from' USING ERRCODE = '22023';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_from > p_date_to THEN
    RAISE EXCEPTION 'A valid p_date_from <= p_date_to is required' USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(SELECT unnest(p_workstations) ORDER BY 1) INTO v_sorted_workstations;

  SELECT c.id INTO v_confirmation_id
  FROM fingerprint_coverage_confirmations c
  WHERE c.tenant_id = v_tenant_id
    AND c.revoked_at IS NULL
    AND c.covers_from = p_covers_from
    AND c.covers_through = p_covers_through
    AND (SELECT ARRAY(SELECT unnest(c.workstations) ORDER BY 1)) = v_sorted_workstations
  LIMIT 1;

  IF v_confirmation_id IS NULL THEN
    INSERT INTO fingerprint_coverage_confirmations (
      tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through, export_time_declared, notes
    ) VALUES (
      v_tenant_id, v_caller_id, p_workstations, p_access_points, p_covers_from, p_covers_through, p_covers_through, p_notes
    )
    RETURNING id INTO v_confirmation_id;
  END IF;

  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[]) INTO v_employee_ids
  FROM employees
  WHERE tenant_id = v_tenant_id
    AND workstation = ANY(p_workstations)
    AND status = 'Active'
    AND is_deleted = false;

  IF p_access_points IS NOT NULL AND array_length(p_access_points, 1) IS NOT NULL THEN
    SELECT COALESCE(array_agg(DISTINCT m.employee_id), ARRAY[]::UUID[]) INTO v_observed_employee_ids
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

    SELECT COALESCE(array_agg(DISTINCT eid), ARRAY[]::UUID[]) INTO v_employee_ids
    FROM unnest(v_employee_ids || v_observed_employee_ids) AS eid;
  END IF;

  IF array_length(v_employee_ids, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'confirmation_id', v_confirmation_id,
      'employee_count', 0,
      'applied_count', 0,
      'unchanged_count', 0,
      'skipped_count', 0,
      'failed_count', 0,
      'rows', '[]'::jsonb
    );
  END IF;

  SELECT
    jsonb_agg(to_jsonb(r)),
    count(*) FILTER (WHERE r.outcome = 'written'),
    count(*) FILTER (WHERE r.outcome = 'skipped_no_change'),
    count(*) FILTER (WHERE r.outcome NOT IN ('written', 'skipped_no_change'))
  INTO v_results, v_applied_count, v_unchanged_count, v_skipped_count
  FROM attendance_apply_automatic(v_employee_ids, p_date_from, p_date_to) r;

  RETURN jsonb_build_object(
    'confirmation_id', v_confirmation_id,
    'employee_count', array_length(v_employee_ids, 1),
    'applied_count', COALESCE(v_applied_count, 0),
    'unchanged_count', COALESCE(v_unchanged_count, 0),
    'skipped_count', COALESCE(v_skipped_count, 0),
    'failed_count', 0,
    'rows', COALESCE(v_results, '[]'::jsonb)
  );
END;
$$;

-- ============================================================
-- PART 1C: hikcentral_coverage_timeline -- read-only gap/continuity
-- report, per declared workstation AND per declared access_point.
-- ============================================================
-- Per scope_key (one workstation or one access_point string), expands
-- every non-revoked confirmation's covers_from..covers_through into its
-- Africa/Blantyre calendar dates (fixed UTC+2, no DST -- same 1-day-step
-- idiom used throughout this feature), then reports the earliest/latest
-- declared-covered date, the next date an operator should upload next,
-- and any calendar dates BETWEEN the earliest and latest that are NOT
-- covered by any declared confirmation -- a genuine gap in the declared
-- timeline, never inferred from whether anyone actually fingerprinted.
-- Bounded to a lookback window so this stays cheap regardless of how
-- much confirmation history accumulates.
CREATE OR REPLACE FUNCTION hikcentral_coverage_timeline(p_lookback_days INTEGER DEFAULT 120)
RETURNS TABLE (
  scope_type TEXT,
  scope_key TEXT,
  first_covered_date DATE,
  last_covered_date DATE,
  next_expected_date DATE,
  missing_dates DATE[]
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_window_start DATE;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR is_business_admin() OR has_permission('attendance.import_hikcentral') OR has_permission('attendance.confirm_coverage')) THEN
    RAISE EXCEPTION 'Not authorized to view HikCentral coverage status' USING ERRCODE = '42501';
  END IF;
  IF p_lookback_days IS NULL OR p_lookback_days <= 0 THEN
    RAISE EXCEPTION 'p_lookback_days must be positive' USING ERRCODE = '22023';
  END IF;
  v_window_start := CURRENT_DATE - p_lookback_days;

  RETURN QUERY
  WITH scopes AS (
    SELECT 'workstation'::TEXT AS scope_type, unnest(c.workstations) AS scope_key, c.covers_from, c.covers_through
    FROM fingerprint_coverage_confirmations c
    WHERE c.tenant_id = v_tenant_id AND c.revoked_at IS NULL
    UNION ALL
    SELECT 'access_point'::TEXT, unnest(c.access_points), c.covers_from, c.covers_through
    FROM fingerprint_coverage_confirmations c
    WHERE c.tenant_id = v_tenant_id AND c.revoked_at IS NULL AND c.access_points IS NOT NULL
  ),
  covered_days AS (
    SELECT DISTINCT s.scope_type, s.scope_key, (gs.d AT TIME ZONE 'Africa/Blantyre')::DATE AS covered_date
    FROM scopes s
    CROSS JOIN LATERAL generate_series(s.covers_from, s.covers_through, interval '1 day') AS gs(d)
    WHERE (gs.d AT TIME ZONE 'Africa/Blantyre')::DATE >= v_window_start
  ),
  per_scope AS (
    SELECT cd.scope_type, cd.scope_key, min(cd.covered_date) AS first_covered_date, max(cd.covered_date) AS last_covered_date
    FROM covered_days cd
    GROUP BY cd.scope_type, cd.scope_key
  )
  SELECT
    p.scope_type,
    p.scope_key,
    p.first_covered_date,
    p.last_covered_date,
    p.last_covered_date + 1 AS next_expected_date,
    COALESCE(ARRAY(
      SELECT gs2::DATE
      FROM generate_series(p.first_covered_date, p.last_covered_date, interval '1 day') AS gs2
      WHERE gs2::DATE NOT IN (
        SELECT cd2.covered_date FROM covered_days cd2
        WHERE cd2.scope_type = p.scope_type AND cd2.scope_key = p.scope_key
      )
      ORDER BY gs2
    ), ARRAY[]::DATE[]) AS missing_dates
  FROM per_scope p
  ORDER BY p.scope_type, p.scope_key;
END;
$$;

REVOKE ALL ON FUNCTION hikcentral_coverage_timeline(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION hikcentral_coverage_timeline(INTEGER) TO authenticated;

-- ============================================================
-- PART 2A: attendance_site_absence_alerts -- minimal operational alert
-- ============================================================
-- site = employees.workstation (the SCHEDULED/roster site, same column
-- already used throughout this feature as the "expected" scope and the
-- only basis Absent can ever be calculated from) -- never derived from
-- an access_point or from who did/didn't fingerprint. One row per
-- (tenant, site, date) -- UNIQUE constraint is the dedup mechanism for
-- "avoid duplicate alerts when the same export is reprocessed" and for
-- any later correction that keeps the count at/above 5.
CREATE TABLE IF NOT EXISTS attendance_site_absence_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  site TEXT NOT NULL,
  alert_date DATE NOT NULL,
  absent_count_at_creation INTEGER NOT NULL CHECK (absent_count_at_creation >= 5),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by UUID NULL REFERENCES profiles(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ NULL,
  closed_note TEXT NULL,
  UNIQUE (tenant_id, site, alert_date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_site_absence_alerts_tenant_status ON attendance_site_absence_alerts(tenant_id, status);

ALTER TABLE attendance_site_absence_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Site absence alerts: view within tenant" ON attendance_site_absence_alerts;
CREATE POLICY "Site absence alerts: view within tenant" ON attendance_site_absence_alerts
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (tenant_id = get_current_tenant_id() AND (current_user_role_level() IS NOT NULL OR has_permission('attendance.view')))
  )
);

-- No INSERT/UPDATE/DELETE policy -- every write happens exclusively
-- inside the trigger below (creation) or attendance_site_alert_
-- acknowledge (closing), both SECURITY DEFINER, bypassing RLS. Same
-- "second wall" convention as attendance_audit_log.
REVOKE ALL ON attendance_site_absence_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON attendance_site_absence_alerts TO authenticated;

-- ============================================================
-- PART 2B: auto-creation trigger -- fires on every attendance row that
-- becomes (or already is) 'A', recounts the CURRENT number of Absent
-- rows at that employee's scheduled site for that date, and opens an
-- alert (once) if the threshold is met. Attendance writing itself is
-- completely unchanged -- this never blocks, rewrites, or second-guesses
-- an Absent write, it only observes the result after the fact.
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
BEGIN
  IF NEW.status <> 'A' THEN
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

  IF v_count >= 5 THEN
    INSERT INTO attendance_site_absence_alerts (tenant_id, site, alert_date, absent_count_at_creation)
    VALUES (NEW.tenant_id, v_site, NEW.date, v_count)
    ON CONFLICT (tenant_id, site, alert_date) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_check_site_absence_alert ON attendance;
CREATE TRIGGER trg_attendance_check_site_absence_alert
  AFTER INSERT OR UPDATE OF status ON attendance
  FOR EACH ROW EXECUTE FUNCTION attendance_check_site_absence_alert();

-- ============================================================
-- PART 2C: read RPC -- live-recomputed current count and affected
-- employees (never a frozen snapshot), so a later manual correction
-- that reduces the count is reflected immediately WITHOUT deleting or
-- rewriting the alert row itself -- its own created_at/
-- absent_count_at_creation stay exactly as first recorded (audit
-- history preserved).
-- ============================================================
CREATE OR REPLACE FUNCTION attendance_site_absence_alerts_list(p_status TEXT DEFAULT NULL)
RETURNS TABLE (
  id UUID,
  site TEXT,
  alert_date DATE,
  status TEXT,
  absent_count_at_creation INTEGER,
  current_absent_count INTEGER,
  affected_employees JSONB,
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
  -- Qualified as profiles.id: this function's own RETURNS TABLE
  -- introduces an OUT parameter also named "id" (the alert's id), which
  -- would otherwise make a bare "id" reference here ambiguous.
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
       WHERE a.tenant_id = al.tenant_id AND a.date = al.alert_date AND a.status = 'A' AND e.workstation = al.site) AS current_absent_count,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('employee_id', e.id, 'full_name', e.full_name) ORDER BY e.full_name), '[]'::jsonb)
       FROM attendance a JOIN employees e ON e.id = a.employee_id
       WHERE a.tenant_id = al.tenant_id AND a.date = al.alert_date AND a.status = 'A' AND e.workstation = al.site) AS affected_employees,
    al.created_at, al.closed_by, al.closed_at, al.closed_note
  FROM attendance_site_absence_alerts al
  WHERE al.tenant_id = v_tenant_id
    AND (p_status IS NULL OR al.status = p_status)
  ORDER BY al.alert_date DESC, al.site;
END;
$$;

REVOKE ALL ON FUNCTION attendance_site_absence_alerts_list(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_site_absence_alerts_list(TEXT) TO authenticated;

-- ============================================================
-- PART 2D: acknowledge/close -- the only permitted mutation of an
-- alert row after creation. Never touches attendance.
-- ============================================================
CREATE OR REPLACE FUNCTION attendance_site_alert_acknowledge(p_alert_id UUID, p_note TEXT)
RETURNS attendance_site_absence_alerts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_row attendance_site_absence_alerts;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR has_permission('attendance.manage_site_alerts')) THEN
    RAISE EXCEPTION 'Not authorized to acknowledge site absence alerts' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NULL OR btrim(p_note) = '' THEN
    RAISE EXCEPTION 'A note is required to acknowledge a site absence alert' USING ERRCODE = '22023';
  END IF;
  IF p_alert_id IS NULL THEN
    RAISE EXCEPTION 'p_alert_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM attendance_site_absence_alerts WHERE id = p_alert_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Alert not found' USING ERRCODE = '22023';
  END IF;
  IF v_row.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'Alert does not belong to your tenant' USING ERRCODE = '42501';
  END IF;

  IF v_row.status = 'closed' THEN
    RETURN v_row;
  END IF;

  UPDATE attendance_site_absence_alerts
  SET status = 'closed', closed_by = v_caller_id, closed_at = NOW(), closed_note = p_note
  WHERE id = p_alert_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION attendance_site_alert_acknowledge(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_site_alert_acknowledge(UUID, TEXT) TO authenticated;

-- ============================================================
-- PART 3: permission seeding -- attendance.manage_site_alerts
-- ============================================================
INSERT INTO role_permissions (role, permission) VALUES
  ('hr_manager', 'attendance.manage_site_alerts')
ON CONFLICT (role, permission) DO NOTHING;
