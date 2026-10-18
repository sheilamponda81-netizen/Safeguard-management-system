-- ============================================================
-- MIGRATION: Attendance Automation -- Stage C, Step 11: centralized
-- HikCentral terminal model.
-- Date: 2026-10-18
-- ============================================================
--
-- REAL-WORLD CORRECTION: Safeguard has many employee workstations (site-
-- reporting/HR fields) but only ~4 centrally located HikCentral fingerprint
-- terminals -- guards from many different workstations travel to ONE
-- central terminal to clock in/out. Requiring an administrator to select
-- "which of our ~150 workstations does this export cover" (the Step 8B/10
-- model) is backwards: the real, known fact at import time is which
-- TERMINAL(S) (access points) the file came from, not which employee
-- home-sites happen to be affected. employees.workstation remains
-- completely untouched and keeps driving HR/payroll/site-absence-alert
-- grouping -- it is simply no longer the mechanism that decides who is
-- in scope for automatic attendance or eligible for Absent.
--
-- PART 1: employee_hikcentral_terminals -- a new, minimal, independent
--   table recording which HikCentral access point(s) each employee is
--   genuinely expected to use. Supports multiple terminals per employee
--   (a real "approved terminal group") and multiple employees per
--   terminal (the normal case for one central terminal). Never derived
--   from workstation, never inferred from a single observed fingerprint.
-- PART 2: attendance_resolve_and_calculate -- Absent-eligibility now
--   requires EVERY one of an employee's own active assigned terminals to
--   have confirmed-complete coverage for the full shift window -- not
--   just any one workstation-matched confirmation. An employee with NO
--   assigned terminal can never resolve Absent (stays 'pending'/
--   provisional at worst) -- see PART 3 for how that gets surfaced as a
--   configuration flag instead of silently doing nothing.
-- PART 3: attendance_process_import_batch -- access_points is now the
--   PRIMARY, required declaration (no workstation selection required for
--   a normal import). Employee scope is the union of (a) mapped
--   employees who actually produced an event at a declared access point,
--   and (b) mapped employees whose assigned terminal(s) intersect the
--   declared access points (the new Absent-eligible "expected" set).
--   p_workstations becomes OPTIONAL, additive, legacy scope inclusion
--   only -- it can never by itself make anyone Absent-eligible anymore,
--   since that now flows exclusively through assigned terminals. The
--   response also reports employees who are mapped, in scope, and
--   rostered, but have NO assigned terminal -- "needs_terminal_
--   configuration" -- instead of ever fabricating an Absent for them.
--
-- Nothing about roster resolution, the attendance engine
-- (attendance_engine_calculate), attendance_apply_automatic's write
-- path, manual-correction precedence, approved-payroll protection,
-- duplicate-event protection, tenant isolation, or Night-shift midnight
-- handling changes in this migration -- all reused completely unchanged.
-- ============================================================

-- ============================================================
-- PART 1: employee_hikcentral_terminals
-- ============================================================
CREATE TABLE IF NOT EXISTS employee_hikcentral_terminals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  access_point TEXT NOT NULL CHECK (btrim(access_point) <> ''),
  is_active BOOLEAN NOT NULL DEFAULT true,
  assigned_by UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ NULL,
  revoked_by UUID NULL REFERENCES profiles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_employee_hikcentral_terminals_employee ON employee_hikcentral_terminals(tenant_id, employee_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_employee_hikcentral_terminals_access_point ON employee_hikcentral_terminals(tenant_id, access_point) WHERE is_active;
-- Partial, not a plain UNIQUE(tenant_id, employee_id, access_point):
-- revoked rows are kept forever as history (never deleted), so a flat
-- constraint would permanently block ever reassigning the SAME terminal
-- back to the SAME employee after a single revoke (e.g. a guard
-- temporarily moved off GATE1 and later moved back) -- only ACTIVE rows
-- need to be unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_hikcentral_terminals_unique_active ON employee_hikcentral_terminals(tenant_id, employee_id, access_point) WHERE is_active;

ALTER TABLE employee_hikcentral_terminals ENABLE ROW LEVEL SECURITY;

-- Reuses the EXACT same tenant+region+permission gate as
-- hikcentral_person_mappings (20260929000000) -- configuring which
-- terminal(s) an employee uses is the same administrative action as
-- mapping that employee's HikCentral identity, so no new permission key
-- is introduced.
DROP POLICY IF EXISTS "Employee HikCentral terminals: view within tenant+region, permitted" ON employee_hikcentral_terminals;
CREATE POLICY "Employee HikCentral terminals: view within tenant+region, permitted" ON employee_hikcentral_terminals
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND employee_region_allowed(employee_hikcentral_terminals.employee_id)
      AND (current_user_role_level() <= 2 OR has_permission('attendance.map_hikcentral_persons'))
    )
  )
);

DROP POLICY IF EXISTS "Employee HikCentral terminals: create within tenant+region, permitted" ON employee_hikcentral_terminals;
CREATE POLICY "Employee HikCentral terminals: create within tenant+region, permitted" ON employee_hikcentral_terminals
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND employee_region_allowed(employee_hikcentral_terminals.employee_id)
      AND (current_user_role_level() <= 2 OR has_permission('attendance.map_hikcentral_persons'))
    )
  )
);

DROP POLICY IF EXISTS "Employee HikCentral terminals: revoke within tenant+region, permitted" ON employee_hikcentral_terminals;
CREATE POLICY "Employee HikCentral terminals: revoke within tenant+region, permitted" ON employee_hikcentral_terminals
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND employee_region_allowed(employee_hikcentral_terminals.employee_id)
      AND (current_user_role_level() <= 2 OR has_permission('attendance.map_hikcentral_persons'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND employee_region_allowed(employee_hikcentral_terminals.employee_id)
      AND (current_user_role_level() <= 2 OR has_permission('attendance.map_hikcentral_persons'))
    )
  )
);

REVOKE ALL ON employee_hikcentral_terminals FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON employee_hikcentral_terminals TO authenticated;

-- ============================================================
-- PART 1B: set_employee_hikcentral_terminals -- the one write path.
-- Takes the EMPLOYEE's full desired set of terminals in one call
-- (an "approved terminal group" is simply this set) -- reconciles by
-- revoking whatever's active-but-no-longer-declared and inserting
-- whatever's newly declared, leaving already-active rows untouched.
-- SECURITY INVOKER (same convention as confirm_hikcentral_person_
-- mappings): the real authorization rule already lives in the RLS
-- policies above, so this function does not need to re-implement it.
-- ============================================================
CREATE OR REPLACE FUNCTION set_employee_hikcentral_terminals(p_employee_id UUID, p_access_points TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_desired TEXT[];
  v_added INTEGER := 0;
  v_revoked INTEGER := 0;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_employee_id IS NULL THEN RAISE EXCEPTION 'p_employee_id is required' USING ERRCODE = '22023'; END IF;
  v_tenant_id := get_current_tenant_id();

  SELECT COALESCE(array_agg(DISTINCT ap), ARRAY[]::TEXT[]) INTO v_desired
  FROM unnest(COALESCE(p_access_points, ARRAY[]::TEXT[])) AS ap
  WHERE btrim(ap) <> '';

  UPDATE employee_hikcentral_terminals
  SET is_active = false, revoked_at = NOW(), revoked_by = v_caller_id
  WHERE employee_id = p_employee_id AND tenant_id = v_tenant_id AND is_active
    AND NOT (access_point = ANY(v_desired));
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  INSERT INTO employee_hikcentral_terminals (tenant_id, employee_id, access_point, assigned_by)
  SELECT v_tenant_id, p_employee_id, ap, v_caller_id
  FROM unnest(v_desired) AS ap
  WHERE NOT EXISTS (
    SELECT 1 FROM employee_hikcentral_terminals t
    WHERE t.employee_id = p_employee_id AND t.tenant_id = v_tenant_id AND t.access_point = ap AND t.is_active
  );
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN jsonb_build_object('added_count', v_added, 'revoked_count', v_revoked, 'access_points', v_desired);
END;
$$;

REVOKE ALL ON FUNCTION set_employee_hikcentral_terminals(UUID, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_employee_hikcentral_terminals(UUID, TEXT[]) TO authenticated;

-- ============================================================
-- PART 2: attendance_resolve_and_calculate -- coverage completeness now
-- keyed off the employee's OWN assigned terminals, not employees.
-- workstation. Identity/event resolution (via hikcentral_person_
-- mappings) is completely unchanged.
-- ============================================================
CREATE OR REPLACE FUNCTION attendance_resolve_and_calculate(p_employee_id UUID, p_shift_date DATE)
RETURNS TABLE (status TEXT, calculation_basis TEXT, check_in_at TIMESTAMPTZ, check_out_at TIMESTAMPTZ, reason TEXT)
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

    -- Step 11: coverage completeness now requires EVERY one of this
    -- employee's own ACTIVE assigned terminals (never employees.
    -- workstation) to have a non-revoked confirmation whose
    -- access_points include that terminal and whose covers_from/
    -- covers_through fully spans this shift's check-in-to-checkout
    -- window. An employee with zero assigned terminals simply never
    -- reaches 'confirmed_complete' here -- never an error, never a
    -- fabricated Absent; attendance_process_import_batch separately
    -- surfaces that as a configuration flag (see PART 3).
    SELECT COALESCE(array_agg(DISTINCT access_point), ARRAY[]::TEXT[]) INTO v_assigned_terminals
    FROM employee_hikcentral_terminals
    WHERE employee_id = p_employee_id AND tenant_id = v_tenant_id AND is_active;

    IF v_assigned_terminals IS NOT NULL AND array_length(v_assigned_terminals, 1) IS NOT NULL THEN
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
          ) AS covered,
          (
            SELECT c2.covers_through FROM fingerprint_coverage_confirmations c2
            WHERE c2.tenant_id = v_tenant_id
              AND c2.revoked_at IS NULL
              AND c2.access_points IS NOT NULL
              AND ap = ANY(c2.access_points)
              AND c2.covers_from <= v_checkin_window_start
              AND c2.covers_through >= v_checkout_window_end
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

-- ============================================================
-- PART 3: attendance_process_import_batch -- access_points is now the
-- primary, required declaration; p_workstations becomes optional,
-- additive, legacy scope-inclusion only (can never by itself make
-- anyone Absent-eligible -- that flows exclusively through PART 2's
-- terminal-coverage check now). Confirmation-reuse matching now keys on
-- access_points (sorted) instead of workstations.
--
-- Postgres does not allow CREATE OR REPLACE to rename an existing
-- parameter (even when every position keeps the same type) -- only
-- the DEFAULT can change in place. Parameter 2 is renamed here
-- (p_workstations -> p_access_points, with p_workstations moving to
-- the final, now-optional position), so the prior version (installed
-- by 20261016000000, unchanged in signature by 20261017000000) must be
-- dropped first; its own grants are then re-declared below exactly as
-- before, since DROP FUNCTION clears them.
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
  p_workstations TEXT[] DEFAULT NULL
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
    INSERT INTO fingerprint_coverage_confirmations (
      tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through, export_time_declared, notes
    ) VALUES (
      v_tenant_id, v_caller_id, COALESCE(p_workstations, ARRAY[]::TEXT[]), p_access_points, p_covers_from, p_covers_through, p_covers_through, p_notes
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
  -- (PART 2 still requires ALL their terminals confirmed covered before
  -- that can actually resolve). Never derived from workstation.
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
  -- eligibility (PART 2 no longer reads employees.workstation at all).
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
  -- -- these can never resolve Absent (PART 2), by design. Surfaced here
  -- so an operator configures them instead of the gap going unnoticed.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('employee_id', e.id, 'full_name', e.full_name) ORDER BY e.full_name), '[]'::jsonb)
    INTO v_needs_configuration
  FROM employees e
  WHERE e.id = ANY(v_employee_ids)
    AND NOT EXISTS (
      SELECT 1 FROM employee_hikcentral_terminals t
      WHERE t.employee_id = e.id AND t.tenant_id = v_tenant_id AND t.is_active
    );

  RETURN jsonb_build_object(
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

REVOKE ALL ON FUNCTION attendance_process_import_batch(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_process_import_batch(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, TEXT, TEXT[]) TO authenticated;
