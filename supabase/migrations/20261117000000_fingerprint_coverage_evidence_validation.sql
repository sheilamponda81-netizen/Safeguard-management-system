-- ============================================================
-- MIGRATION: Attendance Automation -- Phase 3: fingerprint coverage
-- evidence validation.
-- Date: 2026-11-17
-- ============================================================
--
-- ROOT CAUSE THIS FIXES (confirmed by production investigation, Phase 2):
-- fingerprint_coverage_confirmations.covers_through has always been a
-- bare administrator-supplied value (attendance_process_import_batch's
-- p_covers_through), accepted with NO check against what the imported
-- file's own raw events actually prove. The HikCentral Attendance Import
-- page derives this period purely from two CALENDAR DATES, extended to
-- 23:59 Blantyre regardless of what time the export was actually
-- generated (periodToCoverageWindow, attendanceImportAutoApplyService.ts)
-- -- so an export taken at 09:15 covering only the morning, imported with
-- its default same-day period, silently became a declared "complete
-- through 23:59" confirmation. Two real cases (2026-10-22 and 2026-10-26)
-- confirmed this exact mechanism: declared covers_through of 23:59
-- Blantyre same day, against import batches whose filenames (and whose
-- raw events) proved the real export cut off before 10:00.
--
-- CORRECTED PRINCIPLE (per explicit instruction): a latest fingerprint
-- event timestamp is diagnostic evidence only, never proof of export
-- completeness by itself -- this migration does NOT invert that and
-- start trusting MAX(event_time) as proof either. It uses the latest
-- OBSERVED event only as a floor to warn against a declaration that
-- contradicts the data we do have. The administrator's own declaration
-- remains the thing that decides coverage (unchanged) -- this migration
-- only adds a fail-closed speed bump: when that declaration reaches
-- further than the observed evidence supports, it can no longer be
-- recorded silently -- an explicit, durable, human-authored reason is
-- now required to proceed, and until one is given, NOTHING is written
-- (no confirmation row, no attendance calculation) -- raw fingerprint
-- data already imported is never touched either way.
--
-- SCOPE (additive only):
--   PART 1: four new nullable/defaulted columns on the existing,
--     already-append-only fingerprint_coverage_confirmations table, plus
--     a CHECK constraint and an updated append-only guard trigger.
--   PART 2: attendance_process_import_batch gains two new, optional,
--     trailing parameters (p_override_reason, p_independently_verified).
--     When the declared coverage exceeds the observed evidence by more
--     than a documented threshold and EITHER a reason is missing OR
--     independent verification is not explicitly asserted true, the
--     function now returns a distinct 'needs_override_reason' JSON
--     response and returns BEFORE inserting anything or calling
--     attendance_apply_automatic -- fail-closed, not fail-open. A typed
--     reason ALONE is never sufficient: p_independently_verified must be
--     explicitly true (never inferred from the reason text existing) --
--     this is a SEPARATE, required, explicit attestation that the
--     administrator actually checked the export's completeness against
--     HikCentral or the relevant site, not merely a free-text comment.
--
-- NOTHING else changes: roster resolution, the attendance engine, manual-
-- correction precedence, approved-payroll protection, tenant isolation,
-- the append-only revoke mechanism, and the existing confirmation-reuse
-- (idempotent retry) behavior are all reused completely unchanged.
-- ============================================================

-- ============================================================
-- PART 1: fingerprint_coverage_confirmations -- evidence columns
-- ============================================================

ALTER TABLE fingerprint_coverage_confirmations
  ADD COLUMN IF NOT EXISTS latest_observed_event_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS exceeds_observed_evidence BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS independently_verified BOOLEAN NOT NULL DEFAULT false;

-- Fail-closed at the data layer too, not only in the RPC: a row can
-- never claim exceeds_observed_evidence=true without BOTH a non-empty
-- override_reason AND independently_verified=true recorded alongside it,
-- regardless of what inserts it. A typed reason alone is deliberately
-- NOT sufficient on its own -- independently_verified is a separate
-- explicit attestation (never inferred from the reason text merely
-- existing) that the administrator actually checked the export's
-- completeness against HikCentral or the relevant site, not just
-- documented a belief. Existing rows all default both to
-- false, so this validates instantly against current data with no
-- table rewrite.
ALTER TABLE fingerprint_coverage_confirmations
  DROP CONSTRAINT IF EXISTS fingerprint_coverage_confirmations_override_reason_required;
ALTER TABLE fingerprint_coverage_confirmations
  ADD CONSTRAINT fingerprint_coverage_confirmations_override_reason_required
  CHECK (NOT exceeds_observed_evidence OR (btrim(COALESCE(override_reason, '')) <> '' AND independently_verified));

-- The append-only guard must treat the four new columns the same as
-- every other identity/content column (immutable after creation --
-- only revoked_at/revoked_by/revoked_reason may ever change).
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
     OR NEW.latest_observed_event_at IS DISTINCT FROM OLD.latest_observed_event_at
     OR NEW.exceeds_observed_evidence IS DISTINCT FROM OLD.exceeds_observed_evidence
     OR NEW.override_reason IS DISTINCT FROM OLD.override_reason
     OR NEW.independently_verified IS DISTINCT FROM OLD.independently_verified
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
-- PART 2: attendance_process_import_batch -- evidence check before
-- recording a NEW confirmation. An idempotent reuse of an existing
-- identical confirmation (unchanged behavior) is NOT re-checked --
-- the check only ever gates the moment a new declaration is written.
--
-- Adding a genuinely new trailing parameter (p_override_reason) changes
-- this function's argument-type signature, so CREATE OR REPLACE alone
-- would create a SECOND overload beside the existing 8-parameter
-- version rather than replacing it -- leaving both installed makes any
-- call omitting p_override_reason ambiguous ("function is not unique").
-- The prior version must be dropped first, same reasoning as the
-- Step 11 migration's own p_workstations rename.
-- ============================================================
DROP FUNCTION IF EXISTS attendance_process_import_batch(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, TEXT, TEXT[]);

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
  -- Must be explicitly TRUE to override an evidence-gap warning -- never
  -- inferred from p_override_reason being non-empty. Defaults to false
  -- (fail-closed): an older or forgotten caller that only sends a reason
  -- is still rejected by the gate below, exactly like sending no reason
  -- at all.
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
  -- Heuristic only, documented and adjustable -- never proof of
  -- anything by itself. Its only job is to decide when a human must be
  -- stopped and asked to look, not to decide what the truth is. Chosen
  -- generously above normal end-of-window scan slack (minutes) so it
  -- only fires on the kind of multi-hour premature-export gap that was
  -- confirmed in production, not on an ordinary last-scan-before-close.
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
    -- EVIDENCE CHECK: only runs for a genuinely NEW declaration -- an
    -- idempotent reuse of an already-created confirmation above never
    -- re-enters this branch. Tenant-scoped, access-point-scoped, and
    -- strictly within the declared window -- this never reads another
    -- tenant's events and never inflates evidence from outside the
    -- period actually being declared.
    SELECT MAX(r.event_time) INTO v_latest_observed_event_at
    FROM hikcentral_raw_events r
    WHERE r.tenant_id = v_tenant_id
      AND r.access_point = ANY(p_access_points)
      AND r.event_time >= p_covers_from
      AND r.event_time <= p_covers_through;

    v_exceeds_evidence := (v_latest_observed_event_at IS NULL)
      OR (p_covers_through - v_latest_observed_event_at > v_evidence_gap_threshold);

    -- A typed reason ALONE is never sufficient to override: COALESCE(p_independently_verified, false)
    -- must be explicitly TRUE too -- this is a separate, required attestation
    -- that the administrator actually checked the export's completeness
    -- against HikCentral or the relevant site, never inferred merely from
    -- the reason text existing.
    IF v_exceeds_evidence AND (btrim(COALESCE(p_override_reason, '')) = '' OR NOT COALESCE(p_independently_verified, false)) THEN
      -- FAIL CLOSED: return the warning, write nothing at all -- no
      -- confirmation row, no attendance calculation. Raw fingerprint
      -- events already imported for this batch are completely untouched
      -- either way; they are never deleted or hidden by this check.
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

  -- OBSERVED: mapped employees with a real event at a declared access
  -- point within the declared window -- the primary scope-inclusion
  -- mechanism now that workstation selection is no longer required.
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

  -- EXPECTED-TERMINAL: mapped employees whose own active assigned
  -- terminal(s) intersect the declared access points -- this is what
  -- makes a genuinely scheduled-but-silent employee Absent-eligible
  -- (attendance_resolve_and_calculate still requires ALL their terminals
  -- confirmed covered before that can actually resolve). Never derived
  -- from workstation.
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

  -- LEGACY (optional, additive): employees.workstation scope inclusion,
  -- preserved only so an existing caller that still supplies
  -- p_workstations keeps working -- can never by itself grant Absent
  -- eligibility.
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

  SELECT
    jsonb_agg(to_jsonb(r)),
    count(*) FILTER (WHERE r.outcome = 'written'),
    count(*) FILTER (WHERE r.outcome = 'skipped_no_change'),
    count(*) FILTER (WHERE r.outcome NOT IN ('written', 'skipped_no_change'))
  INTO v_results, v_applied_count, v_unchanged_count, v_skipped_count
  FROM attendance_apply_automatic(v_employee_ids, p_date_from, p_date_to) r;

  -- Mapped, in-scope employees with NO active assigned terminal at all
  -- -- these can never resolve Absent, by design. Surfaced here so an
  -- operator configures them instead of the gap going unnoticed.
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

REVOKE ALL ON FUNCTION attendance_process_import_batch(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, TEXT, TEXT[], TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_process_import_batch(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, TEXT, TEXT[], TEXT, BOOLEAN) TO authenticated;
