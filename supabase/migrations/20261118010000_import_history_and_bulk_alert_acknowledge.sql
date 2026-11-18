-- ============================================================
-- MIGRATION: HikCentral Import redesign -- read-only import-batch
-- history RPC, and a bulk site-absence-alert acknowledge RPC.
-- Date: 2026-11-18
-- ============================================================
--
-- PART A -- hikcentral_import_batch_history: a paginated, read-only
-- history of import batches for the History tab. Access points and the
-- earliest/latest raw event timestamp per batch are DERIVED (diagnostic
-- display only, never treated as the declared coverage) from
-- hikcentral_raw_events.import_batch_id -- hikcentral_import_batches
-- itself has no durable link to which fingerprint_coverage_confirmations
-- row it produced (confirmations are matched by exact covers_from/
-- covers_through/access_points, not by batch id), and the auto-apply
-- step's applied/unchanged/skipped counts were never persisted either --
-- they are returned once, live, in attendance_process_import_batch's own
-- response. This RPC does not fabricate either of those for historical
-- batches; the frontend states that limitation plainly rather than
-- inventing a number.
--
-- PART B -- attendance_site_alerts_bulk_acknowledge: the existing
-- attendance_site_alert_acknowledge only accepts one alert id. The new
-- Alerts tab needs to acknowledge many at once with one shared note.
-- This function reuses the exact same authorization/validation as the
-- single-alert version, reports a distinct outcome PER alert id
-- ('acknowledged' | 'already_closed' | 'not_found' | 'unauthorized'),
-- and contains no RAISE inside its per-row loop -- so a per-row problem
-- is always reported as a value, never an exception that could abort
-- only some rows. The whole call still runs as one transaction: if
-- something genuinely unexpected aborts the function, nothing in that
-- call is committed (safe to simply retry), rather than silently
-- leaving a partial, hard-to-reconcile mix of applied and un-applied
-- rows. Never touches attendance, payroll, employees, rosters, or
-- fingerprint events -- only this table's own status/closed_* columns,
-- identical in effect to calling the single-alert function N times.
-- ============================================================

CREATE OR REPLACE FUNCTION hikcentral_import_batch_history(p_limit INTEGER DEFAULT 20, p_offset INTEGER DEFAULT 0)
RETURNS TABLE (
  id UUID,
  filename TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  total_rows INTEGER,
  authorization_count INTEGER,
  failed_count INTEGER,
  with_person_no_count INTEGER,
  without_person_no_count INTEGER,
  raw_events_inserted INTEGER,
  exact_duplicates_ignored INTEGER,
  error_message TEXT,
  access_points TEXT[],
  earliest_event_at TIMESTAMPTZ,
  latest_event_at TIMESTAMPTZ,
  total_count BIGINT
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
  -- NOTE: this function's RETURNS TABLE declares an output column also
  -- named "id" (the batch id) -- plpgsql turns that into a variable named
  -- "id" visible throughout this body, so profiles.id must be qualified
  -- below; a bare "id" here is ambiguous against that output variable.
  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE profiles.id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  -- Same authorization as the existing import flow / RLS on
  -- hikcentral_import_batches itself (role_level <= 2 OR the explicit
  -- permission) -- this RPC grants nothing beyond what that RLS policy
  -- already allows a caller to read directly.
  IF NOT (v_is_super_admin OR COALESCE(current_user_role_level(), 99) <= 2 OR has_permission('attendance.import_hikcentral')) THEN
    RAISE EXCEPTION 'Not authorized to view HikCentral import history' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'p_offset must be >= 0' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    b.id, b.filename, b.status, b.created_at, b.completed_at,
    b.total_rows, b.authorization_count, b.failed_count,
    b.with_person_no_count, b.without_person_no_count,
    b.raw_events_inserted, b.exact_duplicates_ignored, b.error_message,
    agg.access_points, agg.earliest_event_at, agg.latest_event_at,
    (SELECT count(*) FROM hikcentral_import_batches WHERE tenant_id = v_tenant_id) AS total_count
  FROM hikcentral_import_batches b
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(array_agg(DISTINCT r.access_point) FILTER (WHERE r.access_point IS NOT NULL), ARRAY[]::TEXT[]) AS access_points,
      MIN(r.event_time) AS earliest_event_at,
      MAX(r.event_time) AS latest_event_at
    FROM hikcentral_raw_events r
    WHERE r.import_batch_id = b.id AND r.tenant_id = v_tenant_id
  ) agg ON true
  WHERE b.tenant_id = v_tenant_id
  ORDER BY b.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;

REVOKE ALL ON FUNCTION hikcentral_import_batch_history(INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION hikcentral_import_batch_history(INTEGER, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION attendance_site_alerts_bulk_acknowledge(p_alert_ids UUID[], p_note TEXT)
RETURNS TABLE (
  alert_id UUID,
  outcome TEXT,
  site TEXT,
  alert_date DATE,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_id UUID;
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
    RAISE EXCEPTION 'A note is required to acknowledge site absence alerts' USING ERRCODE = '22023';
  END IF;
  IF p_alert_ids IS NULL OR array_length(p_alert_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_alert_ids must not be empty' USING ERRCODE = '22023';
  END IF;

  FOREACH v_id IN ARRAY p_alert_ids LOOP
    SELECT * INTO v_row FROM attendance_site_absence_alerts WHERE id = v_id FOR UPDATE;

    IF v_row.id IS NULL THEN
      alert_id := v_id; outcome := 'not_found'; site := NULL; alert_date := NULL; status := NULL;
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_row.tenant_id <> v_tenant_id THEN
      alert_id := v_id; outcome := 'unauthorized'; site := NULL; alert_date := NULL; status := NULL;
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_row.status = 'closed' THEN
      alert_id := v_id; outcome := 'already_closed'; site := v_row.site; alert_date := v_row.alert_date; status := v_row.status;
      RETURN NEXT;
      CONTINUE;
    END IF;

    UPDATE attendance_site_absence_alerts
    SET status = 'closed', closed_by = v_caller_id, closed_at = NOW(), closed_note = p_note
    WHERE id = v_id
    RETURNING * INTO v_row;

    alert_id := v_id; outcome := 'acknowledged'; site := v_row.site; alert_date := v_row.alert_date; status := v_row.status;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION attendance_site_alerts_bulk_acknowledge(UUID[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_site_alerts_bulk_acknowledge(UUID[], TEXT) TO authenticated;
