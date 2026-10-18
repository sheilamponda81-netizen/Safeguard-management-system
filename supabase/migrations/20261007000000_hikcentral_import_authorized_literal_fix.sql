-- ============================================================
-- MIGRATION: HikCentral Attendance MVP -- corrective fix for
-- import_hikcentral_raw_events()'s "Authorization"-only literal
-- Date: 2026-10-07
-- ============================================================
--
-- WHAT THIS FIXES
-- -----------------------------------------------------------
-- A genuine HikCentral "Person Authentication Record" export
-- (uploaded 2026-10-06, re-tested against PR #44's STAGING Preview)
-- confirmed that a real export's Authentication Result column
-- literally contains the value "Authorized", never "Authorization".
--
-- Root cause, verified against the real workbook's raw XML (not
-- guessed): the sheet has no sharedStrings.xml -- every text cell is
-- an inline string -- and grepping it directly shows "Authorized"
-- appears 223 times while "Authorization" appears zero times.
--
-- The CLIENT-SIDE parser (src/utils/hikcentralExcelParser.ts's
-- isEligibleSuccessfulEvent, fixed in commit 7e34025) had the exact
-- same "Authorization"-only literal bug, so the Preview Summary was
-- already fixed and re-verified end-to-end against the real file
-- (223 Authorized / 126 Failed / 175 with Person No. / 29 unique,
-- matching the file exactly). But this SERVER-SIDE RPC has the
-- identical literal hardcoded independently, in 5 places, and was
-- never touched by that client-side fix:
--   - 4 COUNT(*)/COUNT(DISTINCT) FILTER (WHERE
--     r->>'authentication_result' = 'Authorization' ...) clauses that
--     recompute authorization_count/with_person_no_count/
--     without_person_no_count/unique_person_no_count server-side.
--   - 1 WHERE r->>'authentication_result' = 'Authorization' ... clause
--     on the actual INSERT ... SELECT -- the real row-insert filter.
-- Left unfixed, a real import of a genuine HikCentral file would have
-- the Preview Summary correctly show "223 successful events ready",
-- but the RPC itself would insert ZERO rows, since none of the
-- submitted events' authentication_result would ever equal the
-- literal string this function compared against.
--
-- No real import has ever succeeded against this tenant to date (see
-- the BEFORE-state verification in this fix's PR report: 0 rows in
-- hikcentral_raw_events, 0 in hikcentral_person_mappings, and exactly
-- the one pre-existing "processing" batch row left over from the
-- earlier digest() failure, untouched here) -- so there is no
-- historical row data using the old literal that needs reconciling.
-- This is a forward-looking function-logic fix only.
--
-- THE FIX
-- -----------------------------------------------------------
-- Each of the 5 `r->>'authentication_result' = 'Authorization'`
-- comparisons becomes
-- `r->>'authentication_result' IN ('Authorization', 'Authorized')` --
-- "Authorized" for the genuine export, "Authorization" kept for
-- backward compatibility (mirrors the client-side fix exactly, which
-- also accepts both). No other part of the function changes: the
-- `extensions.digest(...)` schema qualification from the previous
-- corrective migration (20260930000000, commit d9393ab) is preserved
-- verbatim -- this migration does NOT reintroduce the old unqualified
-- `digest(...)` call. Same SECURITY DEFINER, same restricted
-- search_path, same authorization checks, same two-branch (ID|/ANON|)
-- canonical fingerprint construction, same ON CONFLICT DO NOTHING
-- dedup, same REVOKE/GRANT ACL.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- -----------------------------------------------------------
-- - Does NOT edit 20260929000000_hikcentral_attendance_ingestion
--   _foundation.sql or 20260930000000_hikcentral_import_digest_schema
--   _fix.sql in place -- both already applied to STAGING; this is a
--   separate, narrowly-scoped corrective migration layered on top,
--   per the project's established migration-history-integrity
--   convention.
-- - Does NOT create, drop, or alter any table.
-- - Does NOT touch `attendance`, `payroll`, or `employee_deductions`
--   in any way.
-- - Does NOT change the "Without Person No." UI/summary semantics
--   (successful-events-only scoping) -- that is an unrelated, already
--   reviewed and accepted design decision, explicitly out of scope
--   for this fix.
-- - Does NOT change the failed-event storage policy -- Failed rows
--   are still never inserted into hikcentral_raw_events.
-- - Does NOT change the function's SECURITY DEFINER status, its
--   search_path value, or its PUBLIC/anon REVOKE + authenticated GRANT
--   (re-stated at the end of this migration purely to keep the ACL
--   explicit and verifiable in one place; the values are identical to
--   the previous migrations', not a change).
-- - Does NOT delete, update, or otherwise touch the stale "processing"
--   import batch row left behind by the original digest() failure --
--   that remains a separate, deliberately deferred decision.
-- - Does NOT invoke this function with any real payload, insert any
--   event, or perform any import -- this migration only changes the
--   function's definition.
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

  -- FIX: 'Authorization' -> IN ('Authorization', 'Authorized'). A
  -- genuine HikCentral export's Authentication Result column literally
  -- contains "Authorized" (verified against the real workbook's raw
  -- XML -- see this migration's header). "Authorization" is kept
  -- alongside it for backward compatibility, mirroring the client-side
  -- parser fix (commit 7e34025) exactly.
  SELECT
    COUNT(*) FILTER (
      WHERE r->>'authentication_result' IN ('Authorization', 'Authorized')
        AND r->>'event_type' = 'Access Granted by Fingerprint'
    ),
    COUNT(*) FILTER (
      WHERE r->>'authentication_result' IN ('Authorization', 'Authorized')
        AND r->>'event_type' = 'Access Granted by Fingerprint'
        AND NULLIF(r->>'hikcentral_person_no', '') IS NOT NULL
    ),
    COUNT(*) FILTER (
      WHERE r->>'authentication_result' IN ('Authorization', 'Authorized')
        AND r->>'event_type' = 'Access Granted by Fingerprint'
        AND NULLIF(r->>'hikcentral_person_no', '') IS NULL
    ),
    COUNT(DISTINCT r->>'hikcentral_person_no') FILTER (
      WHERE r->>'authentication_result' IN ('Authorization', 'Authorized')
        AND r->>'event_type' = 'Access Granted by Fingerprint'
        AND NULLIF(r->>'hikcentral_person_no', '') IS NOT NULL
    )
  INTO v_authorization_count, v_with_person_no_count, v_without_person_no_count, v_unique_person_no_count
  FROM jsonb_array_elements(p_events) AS r;

  SELECT COUNT(*) INTO v_before_count
  FROM hikcentral_raw_events
  WHERE tenant_id = v_tenant_id;

  -- extensions.digest(...) preserved verbatim from the previous
  -- corrective migration (20260930000000, commit d9393ab) -- NOT
  -- reverted to the old unqualified digest(...) call.
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
  WHERE r->>'authentication_result' IN ('Authorization', 'Authorized')
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

-- Re-stated, not changed, from 20260929000000/20260930000000 --
-- identical ACL, kept explicit here so this migration's effect on the
-- function is fully self-contained and independently verifiable.
REVOKE ALL ON FUNCTION import_hikcentral_raw_events(UUID, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION import_hikcentral_raw_events(UUID, JSONB, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION import_hikcentral_raw_events(UUID, JSONB, JSONB) TO authenticated;
