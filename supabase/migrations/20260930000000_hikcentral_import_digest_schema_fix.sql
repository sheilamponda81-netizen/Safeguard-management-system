-- ============================================================
-- MIGRATION: HikCentral Attendance MVP -- corrective fix for
-- import_hikcentral_raw_events()'s unqualified digest() call
-- Date: 2026-09-30
-- ============================================================
--
-- WHAT THIS FIXES
-- -----------------------------------------------------------
-- The FIRST real-file import attempt against STAGING (2026-09-29)
-- failed at the database layer with:
--
--   function digest(text, unknown) does not exist
--
-- Root cause, verified on STAGING (not guessed):
--   - pgcrypto is installed in schema `extensions` (confirmed via
--     pg_extension/pg_namespace), NOT `public`.
--   - digest(bytea, text) and digest(text, text) both live ONLY in
--     `extensions` (confirmed via pg_proc/pg_namespace).
--   - import_hikcentral_raw_events() is SECURITY DEFINER with
--     SET search_path = 'public', 'pg_temp' (20260929000000's own
--     deliberate hardening -- see that migration's header). `extensions`
--     is not on that path, so the function's unqualified `digest(...)`
--     call cannot resolve.
--   - encode(bytea, text) was also checked and does NOT need
--     qualification -- it lives in `pg_catalog`, which Postgres always
--     searches implicitly regardless of an explicit `SET search_path`.
--
-- THE FIX
-- -----------------------------------------------------------
-- Schema-qualify the digest() call as `extensions.digest(...)`, per the
-- schema actually discovered on STAGING, rather than widening
-- search_path to include `extensions` -- the function's SECURITY
-- DEFINER search_path hardening (public, pg_temp only) is a deliberate
-- security property from 20260929000000 and is preserved unchanged here.
-- No other part of the function changes: same authorization checks,
-- same two-branch (ID|/ANON|) canonical fingerprint construction, same
-- server-side-only inputs, same RLS/ACL.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- -----------------------------------------------------------
-- - Does NOT re-run/edit 20260929000000_hikcentral_attendance_ingestion
--   _foundation.sql, which is already applied to STAGING -- this is a
--   separate, narrowly-scoped corrective migration, per the project's
--   migration-history-integrity convention (foundation migration kept
--   intact; corrective migrations layer on top of it).
-- - Does NOT create or drop any table.
-- - Does NOT touch `attendance`, `payroll`, or `employee_deductions` in
--   any way.
-- - Does NOT change any permission/role_permissions seed.
-- - Does NOT change the function's SECURITY DEFINER status, its
--   search_path value, or its PUBLIC/anon REVOKE + authenticated GRANT
--   (re-stated at the end of this migration purely to keep the ACL
--   explicit and verifiable in one place; the values are identical to
--   20260929000000's, not a change).
-- - Does NOT delete or otherwise touch the import batch row left behind
--   by the failed first attempt (status='processing', 0 raw events
--   inserted, confirmed via read-only inspection) -- that is a separate,
--   deliberately deferred decision.
-- ============================================================

CREATE OR REPLACE FUNCTION import_hikcentral_raw_events(
  p_batch_id UUID,
  p_events JSONB,
  p_summary_counts JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_role_level INTEGER;
  v_is_super_admin BOOLEAN;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
  v_batch_tenant_id UUID;
  v_batch_file_fingerprint TEXT;
  v_before_count INTEGER;
  v_after_count INTEGER;
  v_inserted_count INTEGER;
  v_submitted_count INTEGER;
  v_authorization_count INTEGER;
  v_with_person_no_count INTEGER;
  v_without_person_no_count INTEGER;
  v_unique_person_no_count INTEGER;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id, role_level, is_super_admin, is_active, deleted_at
    INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active, v_deleted_at
  FROM profiles
  WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user' USING ERRCODE = '42501';
  END IF;

  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    COALESCE(v_is_super_admin, false)
    OR COALESCE(v_role_level <= 2, false)
    OR has_permission('attendance.import_hikcentral')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to import HikCentral attendance data' USING ERRCODE = '42501';
  END IF;

  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'No import batch id supplied' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id, file_fingerprint INTO v_batch_tenant_id, v_batch_file_fingerprint
  FROM hikcentral_import_batches
  WHERE id = p_batch_id;

  IF v_batch_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Import batch not found' USING ERRCODE = '22023';
  END IF;

  IF v_batch_tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'Import batch does not belong to your tenant' USING ERRCODE = '42501';
  END IF;

  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'p_events must be a JSON array' USING ERRCODE = '22023';
  END IF;

  v_submitted_count := jsonb_array_length(p_events);

  SELECT
    COUNT(*) FILTER (
      WHERE r->>'authentication_result' = 'Authorization'
        AND r->>'event_type' = 'Access Granted by Fingerprint'
    ),
    COUNT(*) FILTER (
      WHERE r->>'authentication_result' = 'Authorization'
        AND r->>'event_type' = 'Access Granted by Fingerprint'
        AND NULLIF(r->>'hikcentral_person_no', '') IS NOT NULL
    ),
    COUNT(*) FILTER (
      WHERE r->>'authentication_result' = 'Authorization'
        AND r->>'event_type' = 'Access Granted by Fingerprint'
        AND NULLIF(r->>'hikcentral_person_no', '') IS NULL
    ),
    COUNT(DISTINCT r->>'hikcentral_person_no') FILTER (
      WHERE r->>'authentication_result' = 'Authorization'
        AND r->>'event_type' = 'Access Granted by Fingerprint'
        AND NULLIF(r->>'hikcentral_person_no', '') IS NOT NULL
    )
  INTO v_authorization_count, v_with_person_no_count, v_without_person_no_count, v_unique_person_no_count
  FROM jsonb_array_elements(p_events) AS r;

  SELECT COUNT(*) INTO v_before_count
  FROM hikcentral_raw_events
  WHERE tenant_id = v_tenant_id;

  -- FIX: digest(...) -> extensions.digest(...). pgcrypto's digest() lives
  -- in the `extensions` schema on this project (verified, not assumed --
  -- see this migration's header), and this function's SECURITY DEFINER
  -- search_path is deliberately restricted to `public, pg_temp`, which
  -- does not include `extensions`. encode() needs no such qualification
  -- -- it is a pg_catalog builtin, always implicitly on the search path.
  INSERT INTO hikcentral_raw_events (
    tenant_id, import_batch_id, source, hikcentral_person_no, first_name,
    last_name, event_time, access_point, card_reader,
    authentication_result, event_type, attendance_type,
    event_fingerprint, raw_payload
  )
  SELECT
    v_tenant_id,
    p_batch_id,
    COALESCE(r->>'source', 'excel'),
    r->>'hikcentral_person_no',
    r->>'first_name',
    r->>'last_name',
    (r->>'event_time')::TIMESTAMPTZ,
    r->>'access_point',
    r->>'card_reader',
    r->>'authentication_result',
    r->>'event_type',
    r->>'attendance_type',
    encode(
      extensions.digest(
        CASE
          WHEN NULLIF(r->>'hikcentral_person_no', '') IS NOT NULL THEN
            'ID|' || v_tenant_id::text || '|' || (r->>'hikcentral_person_no') || '|' ||
            (r->>'event_time') || '|' || COALESCE(r->>'access_point', '') || '|' ||
            COALESCE(r->>'card_reader', '') || '|' || (r->>'authentication_result') || '|' ||
            (r->>'event_type')
          ELSE
            'ANON|' || v_tenant_id::text || '|' || COALESCE(v_batch_file_fingerprint, '') || '|' ||
            (r->>'source_row_ordinal') || '|' || COALESCE(r->>'access_point', '') || '|' ||
            COALESCE(r->>'card_reader', '') || '|' || (r->>'authentication_result') || '|' ||
            (r->>'event_type')
        END,
        'sha256'
      ),
      'hex'
    ),
    r->'raw_payload'
  FROM jsonb_array_elements(p_events) AS r
  WHERE r->>'authentication_result' = 'Authorization'
    AND r->>'event_type' = 'Access Granted by Fingerprint'
    AND r->>'event_time' IS NOT NULL
    AND (
      NULLIF(r->>'hikcentral_person_no', '') IS NOT NULL
      OR r->>'source_row_ordinal' IS NOT NULL
    )
  ON CONFLICT (tenant_id, event_fingerprint) DO NOTHING;

  SELECT COUNT(*) INTO v_after_count
  FROM hikcentral_raw_events
  WHERE tenant_id = v_tenant_id;

  v_inserted_count := v_after_count - v_before_count;

  UPDATE hikcentral_import_batches SET
    status = 'completed',
    total_rows = v_submitted_count + GREATEST(COALESCE((p_summary_counts->>'failed_count')::INTEGER, 0), 0),
    authorization_count = v_authorization_count,
    failed_count = GREATEST(COALESCE((p_summary_counts->>'failed_count')::INTEGER, 0), 0),
    with_person_no_count = v_with_person_no_count,
    without_person_no_count = v_without_person_no_count,
    unique_person_no_count = v_unique_person_no_count,
    raw_events_inserted = v_inserted_count,
    exact_duplicates_ignored = v_submitted_count - v_inserted_count,
    imported_by = COALESCE(imported_by, v_caller_id),
    completed_at = NOW()
  WHERE id = p_batch_id
    AND tenant_id = v_tenant_id;

  RETURN jsonb_build_object(
    'batch_id', p_batch_id,
    'submitted_count', v_submitted_count,
    'inserted_count', v_inserted_count,
    'duplicates_ignored', v_submitted_count - v_inserted_count
  );
END;
$$;

-- Re-stated, not changed, from 20260929000000 -- identical ACL, kept
-- explicit here so this migration's effect on the function is fully
-- self-contained and independently verifiable.
REVOKE ALL ON FUNCTION import_hikcentral_raw_events(UUID, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION import_hikcentral_raw_events(UUID, JSONB, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION import_hikcentral_raw_events(UUID, JSONB, JSONB) TO authenticated;
