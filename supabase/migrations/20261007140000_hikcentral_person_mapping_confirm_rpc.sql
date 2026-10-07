-- ============================================================
-- MIGRATION: HikCentral Attendance MVP -- Person Mapping workflow:
-- confirm_hikcentral_person_mappings() RPC
-- Date: 2026-10-07
-- ============================================================
--
-- CONTEXT
-- -----------------------------------------------------------
-- The Person Mapping schema foundation (20261007130000) made the
-- cardinality "one exact Person No. -> at most one active employee,
-- one employee -> many active Person Nos" possible at the schema level.
-- This migration adds the write path the Person Mapping UI uses to
-- actually confirm one or more mappings at once, after explicit human
-- review -- no mapping is ever created automatically by this function;
-- every row it writes corresponds to one caller-supplied confirmation.
--
-- DESIGN: SECURITY INVOKER, not SECURITY DEFINER
-- -----------------------------------------------------------
-- Unlike import_hikcentral_raw_events() (which needs SECURITY DEFINER
-- specifically to compute a tamper-proof, server-authoritative
-- event_fingerprint the caller must never be able to forge), this
-- function has no equivalent "value the client must not control"
-- requirement. The existing INSERT/UPDATE RLS policies on
-- hikcentral_person_mappings (tenant_id = get_current_tenant_id() AND
-- employee_region_allowed(employee_id) AND (role_level <= 2 OR
-- has_permission('attendance.map_hikcentral_persons'))) already express
-- the complete authorization rule. Running this function SECURITY
-- INVOKER means those actual INSERT/UPDATE statements execute AS THE
-- CALLING USER, so Postgres enforces those RLS policies on every write
-- this function performs, automatically and for free -- this function
-- does not need to (and does not) re-implement tenant/region/permission
-- logic itself. If a write would violate RLS, Postgres raises and the
-- whole call (see "transactional" below) rolls back -- existing RLS
-- remains the single source of truth, exactly as the task asked.
--
-- What this function DOES validate itself (none of this is expressible
-- by RLS, which only sees one row at a time and knows nothing about
-- hikcentral_raw_events content):
--   - Caller is authenticated (auth.uid() IS NOT NULL).
--   - Each hikcentral_person_no is non-null/non-empty.
--   - Each exact raw Person No. actually appears in the CALLER'S OWN
--     hikcentral_raw_events (read through ordinary RLS-scoped SELECTs,
--     since this function is SECURITY INVOKER -- a caller can never
--     confirm a mapping for a Person No. from a different tenant's
--     data, or one that was never actually imported).
--   - The FUTURE COLLISION GUARDRAIL documented in 20261007130000: if
--     that exact Person No. has more than one distinct non-empty
--     normalized name across its raw events, confirmation is REJECTED
--     outright (a conflicting identity is never confirmable through
--     this function, bulk or otherwise, until resolved by an
--     out-of-band correction to the raw data or a narrower future
--     workflow -- this migration does not add one).
--   - The target employee is Active and not soft-deleted (RLS does not
--     express this either -- it only controls row VISIBILITY, not
--     status).
--   - match_method is one of the values the table's own CHECK
--     constraint already allows (re-validated here too, so a bad value
--     fails with a clear message rather than a raw constraint-violation
--     error).
--
-- REMAP / CORRECTION SEMANTICS
-- -----------------------------------------------------------
-- If the exact Person No. already has a DIFFERENT active mapping, this
-- function supersedes it (is_active = false, superseded_at = NOW(),
-- superseded_by = caller) and inserts the new mapping as the active
-- one -- history is preserved, never deleted, per the existing
-- superseded_at/superseded_by columns' design. If it already points to
-- the SAME employee, that item is a no-op (idempotent re-confirmation,
-- not an error, not a duplicate row).
--
-- TRANSACTIONAL BULK CONFIRMATION
-- -----------------------------------------------------------
-- A single call to this function is one implicit Postgres transaction.
-- Every confirmation in the input array is validated and applied in a
-- loop; the FIRST violation found RAISEs EXCEPTION, which aborts and
-- rolls back the ENTIRE call -- every confirmation in that batch,
-- including ones already applied earlier in the same loop. The caller
-- gets a clear error identifying the offending Person No.; nothing is
-- left half-applied. This is the "transactional... either the intended
-- selected set succeeds correctly or the user gets a clear failure"
-- behavior requested, achieved by Postgres's own per-call atomicity
-- rather than any extra code.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- -----------------------------------------------------------
-- - Does NOT edit any previously-applied migration in place.
-- - Does NOT grant EXECUTE to anon -- authenticated only (REVOKE/GRANT
--   below), matching every other HikCentral RPC in this project.
-- - Does NOT weaken, bypass, or duplicate the existing RLS policies on
--   hikcentral_person_mappings -- it relies on them running as-is.
-- - Does NOT touch hikcentral_raw_events, hikcentral_import_batches,
--   attendance, payroll, payment_status, employee_deductions, or any
--   column on employees -- it only reads those tables (RLS-scoped) and
--   writes hikcentral_person_mappings.
-- - Does NOT normalize, trim-to-equivalence, or numerically cast
--   hikcentral_person_no anywhere -- every comparison against it is a
--   plain exact-string `=`.
-- - Does NOT auto-create a mapping for a "suggested" or "exact name"
--   candidate on its own initiative -- it only ever acts on the exact
--   (hikcentral_person_no, employee_id, match_method) tuples the caller
--   explicitly supplies, one call per explicit human confirmation
--   action in the UI.
-- ============================================================

CREATE OR REPLACE FUNCTION confirm_hikcentral_person_mappings(p_confirmations JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_item JSONB;
  v_person_no TEXT;
  v_employee_id UUID;
  v_match_method TEXT;
  v_distinct_name_count INTEGER;
  v_event_exists BOOLEAN;
  v_employee_status TEXT;
  v_employee_deleted BOOLEAN;
  v_existing_mapping_id UUID;
  v_existing_employee_id UUID;
  v_confirmed_count INTEGER := 0;
  v_skipped_already_mapped_count INTEGER := 0;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF p_confirmations IS NULL OR jsonb_typeof(p_confirmations) <> 'array' OR jsonb_array_length(p_confirmations) = 0 THEN
    RAISE EXCEPTION 'p_confirmations must be a non-empty JSON array' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_confirmations)
  LOOP
    v_person_no := v_item->>'hikcentral_person_no';
    v_match_method := COALESCE(v_item->>'match_method', 'manual');

    IF v_person_no IS NULL OR btrim(v_person_no) = '' THEN
      RAISE EXCEPTION 'hikcentral_person_no must not be null or empty' USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_employee_id := (v_item->>'employee_id')::UUID;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'employee_id is missing or not a valid UUID for Person No %', v_person_no USING ERRCODE = '22023';
    END;
    IF v_employee_id IS NULL THEN
      RAISE EXCEPTION 'employee_id is required for Person No %', v_person_no USING ERRCODE = '22023';
    END IF;

    IF v_match_method NOT IN ('manual', 'suggested_name', 'suggested_employee_number') THEN
      RAISE EXCEPTION 'Invalid match_method "%" for Person No %', v_match_method, v_person_no USING ERRCODE = '22023';
    END IF;

    -- Exact raw Person No. must actually exist in the caller's own
    -- HikCentral raw events (RLS-scoped SELECT, SECURITY INVOKER) --
    -- never numerically normalized, compared as a plain exact string.
    SELECT EXISTS (
      SELECT 1 FROM hikcentral_raw_events WHERE hikcentral_person_no = v_person_no
    ) INTO v_event_exists;
    IF NOT v_event_exists THEN
      RAISE EXCEPTION 'Person No % was not found in your HikCentral raw events' , v_person_no USING ERRCODE = '22023';
    END IF;

    -- Future collision guardrail: reject if this EXACT Person No. has
    -- more than one distinct non-empty normalized name across its raw
    -- events. Mirrors hikcentralPersonMapping.ts's hasConflictingNames.
    SELECT COUNT(DISTINCT upper(btrim(regexp_replace(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''), '\s+', ' ', 'g'))))
      INTO v_distinct_name_count
    FROM hikcentral_raw_events
    WHERE hikcentral_person_no = v_person_no
      AND btrim(COALESCE(first_name, '') || COALESCE(last_name, '')) <> '';
    IF v_distinct_name_count > 1 THEN
      RAISE EXCEPTION 'Person No % has conflicting names in the raw data and cannot be confirmed until resolved', v_person_no USING ERRCODE = '22023';
    END IF;

    -- Employee must be visible to the caller (RLS-scoped SELECT, which
    -- already enforces tenant/region), Active, and not soft-deleted.
    SELECT status, is_deleted INTO v_employee_status, v_employee_deleted
    FROM employees WHERE id = v_employee_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Employee not found or not accessible for Person No %', v_person_no USING ERRCODE = '42501';
    END IF;
    IF v_employee_status IS DISTINCT FROM 'Active' OR COALESCE(v_employee_deleted, false) THEN
      RAISE EXCEPTION 'Employee is not an active employee (Person No %)', v_person_no USING ERRCODE = '22023';
    END IF;

    -- Existing active mapping for this exact Person No., if any
    -- (tenant-scoped explicitly here since this is a plain SELECT, not
    -- itself gated by the table's SELECT policy in the same way an
    -- ordinary client query would be -- get_current_tenant_id() still
    -- resolves to the CALLING user's own tenant, SECURITY INVOKER).
    SELECT id, employee_id INTO v_existing_mapping_id, v_existing_employee_id
    FROM hikcentral_person_mappings
    WHERE tenant_id = get_current_tenant_id() AND hikcentral_person_no = v_person_no AND is_active;

    IF FOUND AND v_existing_employee_id = v_employee_id THEN
      v_skipped_already_mapped_count := v_skipped_already_mapped_count + 1;
      CONTINUE; -- idempotent no-op: already mapped to this same employee
    END IF;

    IF FOUND THEN
      -- Remap/correction: supersede the old row, preserve history.
      UPDATE hikcentral_person_mappings
      SET is_active = false, superseded_at = NOW(), superseded_by = v_caller_id
      WHERE id = v_existing_mapping_id;
    END IF;

    -- The actual write -- RLS's own INSERT policy on
    -- hikcentral_person_mappings enforces tenant/region/permission here;
    -- a violation raises and aborts this entire call (see header).
    INSERT INTO hikcentral_person_mappings (
      tenant_id, hikcentral_person_no, employee_id, match_method,
      confirmed_by, confirmed_at, is_active
    ) VALUES (
      get_current_tenant_id(), v_person_no, v_employee_id, v_match_method,
      v_caller_id, NOW(), true
    );

    v_confirmed_count := v_confirmed_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'confirmed_count', v_confirmed_count,
    'already_mapped_count', v_skipped_already_mapped_count
  );
END;
$$;

REVOKE ALL ON FUNCTION confirm_hikcentral_person_mappings(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_hikcentral_person_mappings(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION confirm_hikcentral_person_mappings(JSONB) TO authenticated;
