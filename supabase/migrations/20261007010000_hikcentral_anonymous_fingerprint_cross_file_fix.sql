-- ============================================================
-- MIGRATION: HikCentral Attendance MVP -- cross-file dedup fix for
-- anonymous (no Person No.) successful event fingerprints
-- Date: 2026-10-07
-- ============================================================
--
-- WHAT THIS FIXES
-- -----------------------------------------------------------
-- The anonymous branch of import_hikcentral_raw_events()'s
-- event_fingerprint computation was scoped to the importing file's own
-- content hash (file_fingerprint) plus the row's stable position within
-- it (source_row_ordinal). This made same-file re-import dedup work
-- (confirmed on STAGING: re-uploading the same 349-row HEAD OFFICE
-- workbook produced "0 new / 223 exact duplicates ignored"), but it
-- meant the SAME physical anonymous event appearing in a DIFFERENT,
-- overlapping export would get a DIFFERENT fingerprint purely because
-- the file identity and row position differ -- it would be inserted
-- again as if it were a new event.
--
-- This was confirmed as a REAL risk, not a theoretical one: after the
-- first successful HEAD OFFICE-only import (349 rows, 223 successful,
-- 48 of them anonymous), a newly obtained COMBINED export covering all
-- four terminals re-exports the exact same HEAD OFFICE Oct 1-4 dataset
-- (including those same 48 anonymous events) inside a different
-- workbook with different row positions. Importing that combined file
-- under the old scheme would have inserted those 48 anonymous events a
-- second time instead of recognizing them as duplicates.
--
-- THE FIX
-- -----------------------------------------------------------
-- The anonymous branch is rescoped to the event's own intrinsic,
-- file-independent fields -- exactly like the identified branch, minus
-- person_no:
--
--   OLD: 'ANON|' || tenant_id || '|' || file_fingerprint || '|' ||
--        source_row_ordinal || '|' || access_point || '|' ||
--        card_reader || '|' || authentication_result || '|' ||
--        event_type
--
--   NEW: 'ANON|' || tenant_id || '|' || event_time || '|' ||
--        access_point || '|' || card_reader || '|' ||
--        authentication_result || '|' || event_type
--
-- source_row_ordinal is STILL required by the INSERT...SELECT's WHERE
-- clause for an anonymous row to be admitted at all (unchanged safety
-- invariant: an anonymous row with no recorded file position is still
-- rejected) -- it is simply no longer part of the hash input.
-- v_batch_file_fingerprint is still fetched (used for nothing else
-- currently, kept for minimal diff / potential future use) but no
-- longer influences any fingerprint.
--
-- COLLISION ANALYSIS (performed against real STAGING data BEFORE
-- choosing this design, not assumed)
-- -----------------------------------------------------------
-- Queried all 223 real HEAD OFFICE raw events already on STAGING
-- (175 identified + 48 anonymous) grouped by
-- (event_time, access_point, card_reader, authentication_result,
-- event_type): ZERO groups with more than one row -- including when the
-- query was restricted to only the 48 anonymous rows. Also confirmed:
-- 0 of the 48 anonymous rows carry a non-null first_name/last_name (so
-- no alternative discriminator is being discarded), and attendance_type
-- is the single constant value 'Undefined' across all 223 rows (so it
-- carries no distinguishing information either). This matches the
-- expected physical behavior of a single sequential fingerprint/card
-- reader device, which processes one authentication attempt at a time
-- and cannot produce two distinct successful events at the SAME reader
-- within the same wall-clock second. The new tuple is accepted as
-- collision-safe for this access-control domain on that empirical and
-- physical basis -- this is an explicit, documented design decision,
-- not a silently invented discriminator. (Two anonymous events at
-- DIFFERENT access points or card readers, or at different seconds,
-- remain distinct under the new scheme, since those fields are part of
-- the tuple.)
--
-- BACKFILL OF THE 48 EXISTING ANONYMOUS ROWS
-- -----------------------------------------------------------
-- A function-only fix is not enough: the 48 anonymous rows already on
-- STAGING were inserted under the OLD scheme, so their stored
-- event_fingerprint values would not match what a fresh import of the
-- combined file computes for the same physical events under the NEW
-- scheme -- they would be re-inserted as "new" once more, defeating the
-- fix for exactly the rows it was meant to protect. This migration
-- therefore also backfills event_fingerprint for the existing anonymous
-- rows to the new formula, applied to the STORED event_time column
-- (reconstructed to the identical ISO-8601-with-milliseconds-and-Z
-- string format the client always sends -- parseHikCentralTimeToUtcIso
-- never produces a non-zero millisecond component, so this
-- reconstruction is exact, not approximate).
--
-- SAFETY:
--   - Preflight check 1: aborts (RAISE EXCEPTION, no write performed)
--     if any two anonymous rows would compute to the SAME new
--     fingerprint (would violate the UNIQUE(tenant_id,
--     event_fingerprint) constraint and silently indicates an
--     unexpected real collision, not assumed away).
--   - Preflight check 2: aborts if any anonymous row's new fingerprint
--     would collide with any OTHER existing row's current fingerprint
--     (defense in depth -- the 'ANON|' vs 'ID|' tag makes this
--     effectively impossible, but it is verified here, not assumed).
--   - Only if both checks pass does the UPDATE run.
--   - Idempotent: re-running this migration recomputes the identical
--     target values for rows already on the new scheme (a no-op
--     UPDATE), and the preflight checks still pass.
--   - Does NOT touch any identified row (hikcentral_person_no IS NOT
--     NULL) -- the identified branch was never affected by this bug.
--   - Does NOT touch hikcentral_import_batches (completed batch
--     historical counts -- total_rows/authorization_count/etc. --
--     are untouched; they describe the SUBMITTED file, not the stored
--     fingerprint scheme) or hikcentral_person_mappings.
--   - Does NOT touch the stale "processing" batch from the historic
--     digest() failure.
--   - Does NOT delete or reinsert any row -- only event_fingerprint is
--     updated in place, preserving id/created_at/import_batch_id/all
--     other original event data.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- -----------------------------------------------------------
-- - Does NOT edit any previously-applied migration in place.
-- - Does NOT create, drop, or alter any table or constraint (the
--   UNIQUE(tenant_id, event_fingerprint) constraint is unchanged and
--   still enforced).
-- - Does NOT touch `attendance`, `payroll`, `payment_status`,
--   `employee_deductions`, or `employees` in any way.
-- - Does NOT change the "Authorized"/"Authorization" acceptance, the
--   Failed-event exclusion, extensions.digest() qualification,
--   SECURITY DEFINER status, search_path, or REVOKE/GRANT ACL -- all
--   unchanged from the immediately prior corrective migration
--   (20261007000000).
-- - Does NOT import, insert, or simulate any new HikCentral event --
--   this migration only changes the function definition and backfills
--   existing anonymous rows' fingerprints.
-- ============================================================

-- ---- PART 1: preflight collision checks (no writes if either fails) ----
DO $$
DECLARE
  v_dup_among_new INTEGER;
  v_collides_with_other INTEGER;
BEGIN
  -- Check 1: would any two (or more) anonymous rows compute to the SAME
  -- new fingerprint?
  SELECT count(*) INTO v_dup_among_new
  FROM (
    SELECT
      encode(
        extensions.digest(
          'ANON|' || tenant_id::text || '|' ||
          (to_char(event_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z') || '|' ||
          COALESCE(access_point, '') || '|' || COALESCE(card_reader, '') || '|' ||
          authentication_result || '|' || event_type,
          'sha256'
        ),
        'hex'
      ) AS new_fingerprint,
      count(*) AS n
    FROM hikcentral_raw_events
    WHERE NULLIF(hikcentral_person_no, '') IS NULL
    GROUP BY new_fingerprint
    HAVING count(*) > 1
  ) dupes;

  IF v_dup_among_new > 0 THEN
    RAISE EXCEPTION
      'Anonymous event_fingerprint backfill ABORTED: % new fingerprint value(s) would be shared by more than one anonymous row. No write was performed. This indicates a genuine collision in the chosen identity tuple (event_time, access_point, card_reader, authentication_result, event_type) and must be investigated before retrying -- do not re-run this migration until resolved.',
      v_dup_among_new;
  END IF;

  -- Check 2: would any anonymous row's new fingerprint collide with a
  -- DIFFERENT existing row's CURRENT fingerprint (identified or
  -- anonymous)?
  SELECT count(*) INTO v_collides_with_other
  FROM hikcentral_raw_events anon_row
  JOIN hikcentral_raw_events other_row
    ON other_row.tenant_id = anon_row.tenant_id
   AND other_row.id <> anon_row.id
   AND other_row.event_fingerprint = encode(
         extensions.digest(
           'ANON|' || anon_row.tenant_id::text || '|' ||
           (to_char(anon_row.event_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z') || '|' ||
           COALESCE(anon_row.access_point, '') || '|' || COALESCE(anon_row.card_reader, '') || '|' ||
           anon_row.authentication_result || '|' || anon_row.event_type,
           'sha256'
         ),
         'hex'
       )
  WHERE NULLIF(anon_row.hikcentral_person_no, '') IS NULL;

  IF v_collides_with_other > 0 THEN
    RAISE EXCEPTION
      'Anonymous event_fingerprint backfill ABORTED: % anonymous row(s) would, under the new fingerprint scheme, collide with a DIFFERENT existing row current fingerprint. No write was performed.',
      v_collides_with_other;
  END IF;

  -- ---- PART 2: backfill (only reached if both checks above passed) ----
  UPDATE hikcentral_raw_events
  SET event_fingerprint = encode(
    extensions.digest(
      'ANON|' || tenant_id::text || '|' ||
      (to_char(event_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z') || '|' ||
      COALESCE(access_point, '') || '|' || COALESCE(card_reader, '') || '|' ||
      authentication_result || '|' || event_type,
      'sha256'
    ),
    'hex'
  )
  WHERE NULLIF(hikcentral_person_no, '') IS NULL;
END $$;

-- ---- PART 3: the function fix itself ----
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

  -- FIX: the anonymous (ELSE) branch no longer incorporates
  -- v_batch_file_fingerprint or source_row_ordinal -- see this
  -- migration's header for the full collision analysis and why this is
  -- safe. It now uses the event's own intrinsic fields, exactly like the
  -- identified branch minus hikcentral_person_no.
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
            'ANON|' || v_tenant_id::text || '|' || (r->>'event_time') || '|' ||
            COALESCE(r->>'access_point', '') || '|' ||
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

-- Re-stated, not changed -- identical ACL, kept explicit here so this
-- migration's effect on the function is fully self-contained and
-- independently verifiable.
REVOKE ALL ON FUNCTION import_hikcentral_raw_events(UUID, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION import_hikcentral_raw_events(UUID, JSONB, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION import_hikcentral_raw_events(UUID, JSONB, JSONB) TO authenticated;
