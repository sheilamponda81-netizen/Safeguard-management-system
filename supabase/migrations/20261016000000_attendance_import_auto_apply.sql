-- ============================================================
-- MIGRATION: Attendance Automation -- Stage C, Step 8: connect
-- HikCentral import to automatic calculation and write-through
-- Date: 2026-10-13
-- ============================================================
--
-- SCOPE: closes the one remaining gap in the automation pipeline built
-- across Stage C Steps 1-4 -- importing a HikCentral export and
-- calculating/applying attendance were two completely disconnected
-- actions (import_hikcentral_raw_events never calls anything
-- attendance-related; attendance_apply_automatic was never called by any
-- frontend code except a single-employee, manual, opt-in "Server
-- Calculation Preview" tool). This migration adds ONE new orchestration
-- RPC, attendance_process_import_batch(), that an import's own success
-- handler calls automatically (see HikCentralImport.tsx / this round's
-- frontend change) -- no new button, no second confirmation screen for
-- the normal import flow.
--
-- It also makes ONE deliberate policy change to the existing
-- attendance_apply_automatic(): Absent becomes writable again. This is
-- NOT a reversion of the 2026-10-12 safety correction's reasoning --
-- that migration's documented concern was a caller bypassing the
-- frontend entirely and writing an UNVERIFIED Absent, because at the
-- time nothing forced "Absent" to mean anything more than "no event
-- found yet". That is still true of attendance_engine_calculate() in
-- isolation, but attendance_resolve_and_calculate() (its caller) has
-- always gated 'absent' behind a genuine, explicit,
-- administrator-declared fingerprint_coverage_confirmations row whose
-- covers_from/covers_through fully spans the shift's own check-in-window
-- start through checkout-window end (20261013000000's fix 2). That
-- confirmation can now ONLY be created via attendance_process_import_batch
-- below (or the pre-existing attendance_confirm_coverage, unused by any
-- UI until this round) -- both gated on attendance.confirm_coverage. In
-- other words: the thing that made Absent unsafe to auto-write was the
-- absence of a trustworthy completeness signal, not the status code
-- itself -- now that a trustworthy signal exists and is the ONLY path to
-- an 'absent' result, allowing attendance_apply_automatic to write it is
-- the intended, safe conclusion of the design the 2026-10-12 and
-- 2026-10-13 migrations were building toward, not a weakening of them.
-- Every other restriction from those migrations (tenant/region scope,
-- manual-correction precedence, approved-payroll block, idempotent
-- no-op, audit trail, provisional-basis skip) is completely unchanged.
--
-- WHY NOT A SEPARATE PARALLEL FUNCTION: attendance_resolve_and_calculate
-- can only ever RETURN 'absent' when coverage is already confirmed
-- complete for that exact shift -- there is no way for a caller to make
-- it return an unverified Absent, confirmed or not. Re-opening the exact
-- same write path to include 'absent' is therefore strictly safe and
-- keeps one single write rule instead of two near-duplicate RPCs to keep
-- in lockstep.
-- ============================================================

-- ============================================================
-- PART 1: attendance_apply_automatic -- Absent becomes writable
-- ============================================================
CREATE OR REPLACE FUNCTION attendance_apply_automatic(p_employee_ids UUID[], p_date_from DATE, p_date_to DATE)
RETURNS TABLE (employee_id UUID, attendance_date DATE, outcome TEXT, old_status TEXT, new_status TEXT, payroll_flag TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_employee_id UUID; v_employee_tenant_id UUID; v_date DATE;
  v_calc RECORD; v_write RECORD;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_date_from > p_date_to THEN RAISE EXCEPTION 'p_date_from must not be after p_date_to'; END IF;
  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL THEN RAISE EXCEPTION 'p_employee_ids must not be empty'; END IF;

  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  -- Deliberately NO legacy role_level bypass here -- a separate
  -- permission by design (confirmed decision), unlike attendance_correct.
  IF NOT (v_is_super_admin OR has_permission('attendance.auto_apply')) THEN
    RAISE EXCEPTION 'Not authorized to run automatic attendance processing' USING ERRCODE = '42501';
  END IF;

  FOREACH v_employee_id IN ARRAY p_employee_ids LOOP
    v_employee_tenant_id := attendance_assert_employee_in_scope(v_tenant_id, v_is_super_admin, v_employee_id);
    v_date := p_date_from;
    WHILE v_date <= p_date_to LOOP
      SELECT * INTO v_calc FROM attendance_resolve_and_calculate(v_employee_id, v_date);
      -- Stage C Step 8: a CONFIRMED Present/Late, OR a genuinely-resolved
      -- Absent (which attendance_resolve_and_calculate can only ever
      -- return once a real fingerprint_coverage_confirmations row spans
      -- the whole shift -- see this migration's header), is written.
      -- Off/Unassigned/Pending are never written -- still structural, not
      -- caller-remembered -- and a provisional (check_in_only_provisional)
      -- Present/Late is still skipped rather than locked in early.
      IF (v_calc.status IN ('present', 'late') AND v_calc.calculation_basis = 'confirmed')
         OR v_calc.status = 'absent' THEN
        SELECT * INTO v_write FROM attendance_write_one(
          v_employee_tenant_id, v_employee_id, v_date,
          (CASE v_calc.status WHEN 'present' THEN 'P' WHEN 'late' THEN 'L' WHEN 'absent' THEN 'A' END),
          v_calc.calculation_basis, 'automatic', v_caller_id, NULL
        );
        employee_id := v_employee_id; attendance_date := v_date;
        outcome := v_write.outcome; old_status := v_write.old_status; new_status := v_write.new_status; payroll_flag := v_write.payroll_flag;
      ELSIF v_calc.status IN ('present', 'late') THEN
        -- A provisional (not yet 'confirmed') Present/Late -- distinct
        -- outcome code from the genuine Off/Unassigned/Pending skips
        -- below, so a caller can tell "this will likely resolve once the
        -- checkout window closes" apart from "this is not an
        -- automatic-write case at all".
        employee_id := v_employee_id; attendance_date := v_date;
        outcome := 'skipped_provisional_' || v_calc.status; old_status := NULL; new_status := NULL; payroll_flag := NULL;
      ELSE
        -- Off, Unassigned, Pending -- never written automatically.
        employee_id := v_employee_id; attendance_date := v_date;
        outcome := 'skipped_' || v_calc.status; old_status := NULL; new_status := NULL; payroll_flag := NULL;
      END IF;
      RETURN NEXT;
      v_date := v_date + 1;
    END LOOP;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION attendance_apply_automatic(UUID[], DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_apply_automatic(UUID[], DATE, DATE) TO authenticated;

-- ============================================================
-- PART 2: attendance_process_import_batch -- the new orchestration RPC
-- ============================================================
-- Called automatically by the frontend immediately after
-- import_hikcentral_raw_events() reports success, in the SAME button
-- click -- no separate confirmation screen. Does exactly three things,
-- all already-existing, already-tested mechanisms, composed together:
--   1. Validates the import batch (must be this caller's own tenant and
--      already 'completed').
--   2. Records (or reuses, if byte-identical, for idempotent reprocessing)
--      a fingerprint_coverage_confirmations row for the administrator-
--      declared workstations and period -- this IS the one fact an
--      administrator uploading a real export already knows (which
--      gate(s)/terminal(s) the export came from, and what period it
--      covers) and is asked for ONCE, on the same upload screen, not as
--      a separate subsequent confirmation action.
--   3. Resolves the employee scope (active, non-deleted employees at the
--      declared workstations, within the caller's own tenant) and calls
--      the existing attendance_apply_automatic() for that scope and the
--      declared date range -- the exact same write path, with the exact
--      same tenant/region/manual/payroll/idempotency protections, Step 8
--      Part 1 above makes Absent-capable.
--
-- Deliberately narrow idempotent confirmation reuse: an import of the
-- EXACT SAME declared workstations + period that has already been
-- recorded (and not revoked) reuses that confirmation's id rather than
-- inserting a duplicate metadata row -- re-processing the same import
-- (or re-running this RPC again for safety) never multiplies coverage
-- rows, and the underlying attendance writes are already naturally
-- idempotent via attendance_write_one's own no-op guard.
--
-- Permission model: reuses the two permissions that already separately
-- gate the two actions this composes (attendance.confirm_coverage,
-- attendance.auto_apply) -- no new permission key. Both are newly seeded
-- to 'hr_manager' in PART 3 below, the same role that already holds
-- attendance.import_hikcentral -- without that seed, the person who
-- actually uploads exports could never trigger the now-automatic step,
-- which would defeat this round's entire purpose.
CREATE OR REPLACE FUNCTION attendance_process_import_batch(
  p_import_batch_id UUID,
  p_workstations TEXT[],
  p_covers_from TIMESTAMPTZ,
  p_covers_through TIMESTAMPTZ,
  p_date_from DATE,
  p_date_to DATE,
  p_notes TEXT DEFAULT NULL
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

  -- Order-independent comparison against any existing confirmation --
  -- two callers naming the same set of workstations in a different order
  -- must still be recognized as the same declared coverage.
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
      tenant_id, confirmed_by, workstations, covers_from, covers_through, export_time_declared, notes
    ) VALUES (
      v_tenant_id, v_caller_id, p_workstations, p_covers_from, p_covers_through, p_covers_through, p_notes
    )
    RETURNING id INTO v_confirmation_id;
  END IF;

  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[]) INTO v_employee_ids
  FROM employees
  WHERE tenant_id = v_tenant_id
    AND workstation = ANY(p_workstations)
    AND status = 'Active'
    AND is_deleted = false;

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

  -- Reuses attendance_apply_automatic() entirely unchanged (beyond Part
  -- 1's Absent extension above) -- same per-employee tenant/region scope
  -- assertion (raises, aborting this whole call, on any out-of-scope
  -- employee -- never a silent partial skip), same manual-correction
  -- precedence, same approved-payroll block, same no-op idempotency
  -- guard, same audit trail.
  SELECT
    jsonb_agg(to_jsonb(r)),
    count(*) FILTER (WHERE r.outcome = 'written'),
    count(*) FILTER (WHERE r.outcome = 'skipped_no_change'),
    count(*) FILTER (WHERE r.outcome NOT IN ('written', 'skipped_no_change'))
  INTO v_results, v_applied_count, v_unchanged_count, v_skipped_count
  FROM attendance_apply_automatic(v_employee_ids, p_date_from, p_date_to) r;

  -- failed_count is always 0 here BY CONSTRUCTION: any genuine failure
  -- (an out-of-scope employee, a disabled account, a missing permission)
  -- raises and aborts this entire call rather than returning a partial
  -- result -- so the pipeline can never report success alongside a
  -- failed calculation/application; the caller either gets this full
  -- JSONB result or an exception, never both. Field kept for a stable,
  -- self-describing response shape (and the frontend's own four-count
  -- summary), not because a per-row failure is possible here.
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

REVOKE ALL ON FUNCTION attendance_process_import_batch(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_process_import_batch(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, TEXT) TO authenticated;

-- ============================================================
-- PART 3: permission seeding
-- ============================================================
-- attendance.auto_apply and attendance.confirm_coverage were
-- deliberately seeded to NOBODY in the Step 1 foundation migration
-- ("automatic processing is not activated this round, so there is no
-- legitimate non-admin caller for either"). This round activates it for
-- real, so the role that already imports HikCentral exports
-- (attendance.import_hikcentral, attendance.map_hikcentral_persons, both
-- seeded to hr_manager in the ingestion foundation migration) must also
-- hold these two, or the only person who can trigger an import could
-- never trigger the now-automatic processing that is supposed to follow
-- it with no second manual step.
INSERT INTO role_permissions (role, permission) VALUES
  ('hr_manager', 'attendance.auto_apply'),
  ('hr_manager', 'attendance.confirm_coverage')
ON CONFLICT (role, permission) DO NOTHING;
