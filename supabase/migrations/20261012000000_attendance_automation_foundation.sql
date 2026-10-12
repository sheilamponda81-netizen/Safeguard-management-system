-- ============================================================
-- MIGRATION: Attendance Automation -- Phase 2C, Stage C, Step 1
-- Date: 2026-10-12
-- ============================================================
--
-- SCOPE OF THIS MIGRATION (explicit, per authorization): database
-- FOUNDATION only -- schema, server-side calculation mirroring the
-- existing Stage A TypeScript engine (src/utils/attendanceCalculationEngine.ts),
-- secure write RPCs, audit history, coverage-confirmation records,
-- payroll-reconciliation flags, and a roster-change detector. NOTHING
-- in this migration is wired to automatic attendance processing yet --
-- no frontend code calls any new RPC introduced here, and the existing
-- `attendance` table's direct INSERT/UPDATE table grants to
-- `authenticated` (base schema + 20260817000002's RLS policies) are
-- LEFT COMPLETELY UNTOUCHED, so the currently-deployed Monthly Register
-- (Attendance.tsx's direct `.insert()/.update()` calls) keeps working
-- exactly as it does today. Revoking those grants in favor of the new
-- RPC-only write path is an explicit LATER step, done only once
-- Attendance.tsx has actually been switched over -- see this file's
-- final section for the precise plan.
--
-- WHY A SERVER-SIDE SQL MIRROR OF THE ENGINE, NOT JUST VALIDATION
-- (Step 1 correction B): a `apply_automatic_attendance`-style RPC that
-- accepted a browser-submitted status/basis/coverage object would only
-- be as trustworthy as client-side input validation, which a modified
-- client can bypass entirely. The only way to make a caller unable to
-- fabricate "Present"/"Absent"/confirmed-coverage is for the SERVER to
-- compute the result itself from data it already trusts (roster tables,
-- hikcentral_raw_events, and the new append-only coverage-confirmation
-- table below) and to accept NO calculated fields as RPC input at all --
-- only a worklist of (employee_id, date) pairs. This mirrors the EXACT
-- precedent already set by this codebase for roster resolution
-- (rosterSchedule.ts's own header: "the EXECUTABLE SPEC the migration's
-- PL/pgSQL functions mirror -- every rule enforced server-side is
-- implemented here FIRST and unit-tested, then transcribed into SQL").
-- attendance_engine_calculate() below is that same kind of transcription
-- of calculateAttendanceStatus() -- parity-tested against it directly
-- (see src/utils/attendanceEngineSqlParity.test.ts). It is a deliberate,
-- bounded piece of duplicated logic, not an oversight: Stage A/B remain
-- the single source of truth for the read-only preview UI, and this SQL
-- version is the single source of truth for what can ever actually be
-- WRITTEN. Keeping them in lockstep via shared fixtures is the
-- accepted cost of a genuinely tamper-resistant write boundary.
-- ============================================================

-- ============================================================
-- PART 1: attendance -- new columns only, no RLS/grant changes
-- ============================================================
-- DEFAULT 'manual' is deliberate and does double duty:
--  (a) backfills every pre-existing row (written before this migration,
--      by definition through the old direct-write UI) as protected --
--      satisfying "legacy rows must be protected as manual by default,
--      automatic processing must never silently overwrite them" with a
--      single column default, no backfill UPDATE needed.
--  (b) ALSO protects every NEW row the *still-live* old direct-write
--      path creates during the transition window before Attendance.tsx
--      is switched to the new RPCs -- a human using today's UI IS
--      making a manual edit, so 'manual' is the correct value for that
--      path too, not merely a safe placeholder.
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'automatic'));

-- NULL for every manual row (no calculation was performed). Mirrors
-- AttendanceCalculationBasis exactly -- 'confirmed' (both check-in and
-- checkout observed, or genuinely-confirmed-absent), 'check_in_only_provisional'
-- (Early Export Rule credit), 'not_applicable' is never stored here for
-- an automatic row (an automatic write only ever happens for a
-- present/late/absent result, and absent is always 'not_applicable' at
-- the TS layer -- this column being NULL for absent rows is therefore
-- expected, not a bug; see attendance_write_one's comments).
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS calculation_basis TEXT NULL
    CHECK (calculation_basis IS NULL OR calculation_basis IN ('confirmed', 'check_in_only_provisional'));

CREATE INDEX IF NOT EXISTS idx_attendance_source ON attendance(tenant_id, source);

-- ============================================================
-- PART 2: attendance_audit_log -- purpose-built, typed, append-only
-- ============================================================
-- NOT the generic `audit_logs` table (jsonb old_data/new_data, no
-- attendance-specific columns, written by a SEPARATE client-side call
-- today -- non-atomic with the write, and only ever records the NEW
-- status). This table exists specifically so an attendance change and
-- its audit record are the SAME transaction (see attendance_write_one)
-- and so old/new status AND old/new calculation_basis are both first-
-- class columns (correction C: a provisional-to-confirmed transition
-- must be recorded even when the official code does not change).
CREATE TABLE IF NOT EXISTS attendance_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  old_status TEXT NULL,
  new_status TEXT NOT NULL,
  old_calculation_basis TEXT NULL,
  new_calculation_basis TEXT NULL,
  changed_by UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  change_source TEXT NOT NULL CHECK (change_source IN ('manual', 'automatic')),
  reason TEXT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attendance_audit_log_employee_date ON attendance_audit_log(tenant_id, employee_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_attendance_audit_log_changed_at ON attendance_audit_log(tenant_id, changed_at);

-- Append-only: reject EVERY update and delete, no exceptions (unlike
-- Roster's own append-only trigger, which permits one narrow "close out"
-- transition -- an audit row records a historical fact and is never
-- itself revised, only ever added to).
CREATE OR REPLACE FUNCTION attendance_audit_log_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'attendance_audit_log is append-only: % is not permitted', TG_OP USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_audit_log_no_update ON attendance_audit_log;
CREATE TRIGGER trg_attendance_audit_log_no_update
  BEFORE UPDATE ON attendance_audit_log
  FOR EACH ROW EXECUTE FUNCTION attendance_audit_log_immutable();

DROP TRIGGER IF EXISTS trg_attendance_audit_log_no_delete ON attendance_audit_log;
CREATE TRIGGER trg_attendance_audit_log_no_delete
  BEFORE DELETE ON attendance_audit_log
  FOR EACH ROW EXECUTE FUNCTION attendance_audit_log_immutable();

ALTER TABLE attendance_audit_log ENABLE ROW LEVEL SECURITY;

-- Readable by anyone who could view the underlying attendance row --
-- same tenant+region+permission gate as "Attendance: view within
-- tenant+region" (20260817000002), expressed directly rather than by
-- joining attendance (a row here must stay visible even if the
-- attendance row it describes is later changed again).
DROP POLICY IF EXISTS "Attendance audit log: view within tenant+region" ON attendance_audit_log;
CREATE POLICY "Attendance audit log: view within tenant+region" ON attendance_audit_log
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = attendance_audit_log.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() IS NOT NULL OR has_permission('attendance.view'))
    )
  )
);

-- No INSERT/UPDATE/DELETE policy of any kind: every write happens
-- exclusively inside attendance_write_one() (SECURITY DEFINER, bypasses
-- RLS). Table grants revoked below as a second wall, matching Roster's
-- "REVOKE ALL ... FROM PUBLIC, anon, authenticated" convention.
REVOKE ALL ON attendance_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON attendance_audit_log TO authenticated;

-- ============================================================
-- PART 3: fingerprint_coverage_confirmations -- immutable, attributable
-- ============================================================
-- Correction E / confirmed decision 5: a checkbox and a workstation name
-- typed into the Stage B preview UI are transient component state --
-- gone on refresh, never attributable, never independently verifiable
-- by the write path. This table is the durable replacement: creating a
-- row IS the confirming act (requires attendance.confirm_coverage,
-- records who/when/which workstations/which time window), and the
-- calculation path (attendance_resolve_and_calculate) reads ONLY this
-- table -- never an inline object a caller supplies -- to decide whether
-- coverage is 'confirmed_complete' for a given employee's workstation
-- at write time. A mistaken confirmation is REVOKED (one narrow,
-- audited transition), never edited or deleted.
--
-- KNOWN LIMITATION (documented, not silently assumed solved): this
-- table records confirmed WORKSTATIONS, the same free-text
-- `employees.workstation` values the Stage B preview already uses --
-- it does NOT yet record which specific HikCentral access_point/
-- terminal(s) back that workstation. No mapping from workstation to
-- terminal exists anywhere in this codebase today (confirmed during the
-- Stage A/B investigation: ~4 real access points vs ~148 free-text
-- workstation values, no join table between them). Terminal-level
-- confirmation granularity is a real gap, called out here rather than
-- papered over, and is a candidate for a later step once such a mapping
-- exists -- it does not block Step 1's foundation.
CREATE TABLE IF NOT EXISTS fingerprint_coverage_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  confirmed_by UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workstations TEXT[] NOT NULL CHECK (array_length(workstations, 1) > 0),
  covers_from TIMESTAMPTZ NOT NULL,
  covers_through TIMESTAMPTZ NOT NULL CHECK (covers_through > covers_from),
  -- Administrator-declared export time, kept STRICTLY SEPARATE from
  -- covers_through (correction E / Step 1 correction A): never read by
  -- any calculation function. Present only so the confirming operator's
  -- stated reason is itself part of the durable record, for later human
  -- review -- never a computed input.
  export_time_declared TIMESTAMPTZ NULL,
  notes TEXT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_by UUID NULL REFERENCES profiles(id) ON DELETE SET NULL,
  revoked_reason TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_fingerprint_coverage_confirmations_tenant ON fingerprint_coverage_confirmations(tenant_id) WHERE revoked_at IS NULL;

-- Append-only except for the one narrow revoke transition -- directly
-- mirrors roster_prevent_illegal_mutation's own shape (permit ONLY
-- revoked_at NULL -> NOT NULL, with revoked_by required, no other
-- column allowed to change).
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
    RAISE EXCEPTION 'Revoking a coverage confirmation requires revoked_by to be set' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fingerprint_coverage_confirmations_guard ON fingerprint_coverage_confirmations;
CREATE TRIGGER trg_fingerprint_coverage_confirmations_guard
  BEFORE UPDATE ON fingerprint_coverage_confirmations
  FOR EACH ROW EXECUTE FUNCTION fingerprint_coverage_confirmation_guard();

DROP TRIGGER IF EXISTS trg_fingerprint_coverage_confirmations_no_delete ON fingerprint_coverage_confirmations;
CREATE TRIGGER trg_fingerprint_coverage_confirmations_no_delete
  BEFORE DELETE ON fingerprint_coverage_confirmations
  FOR EACH ROW EXECUTE FUNCTION attendance_audit_log_immutable();

ALTER TABLE fingerprint_coverage_confirmations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Coverage confirmations: view within tenant" ON fingerprint_coverage_confirmations;
CREATE POLICY "Coverage confirmations: view within tenant" ON fingerprint_coverage_confirmations
FOR SELECT USING (
  is_current_user_active()
  AND (is_super_admin() OR (tenant_id = get_current_tenant_id() AND (current_user_role_level() IS NOT NULL OR has_permission('attendance.view'))))
);

REVOKE ALL ON fingerprint_coverage_confirmations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fingerprint_coverage_confirmations TO authenticated;

-- ============================================================
-- PART 4: attendance_reconciliation_flags
-- ============================================================
-- One shared mechanism for BOTH confirmed decisions that need it:
--  - decision 1 (Off/Unassigned): roster changes after an automatic
--    P/L/A was written ('roster_invalidated_auto_entry', raised by the
--    trigger in Part 7).
--  - decision 2 / correction D (payroll): any write touching a month
--    that already has a `payroll` row, raised by attendance_write_one.
-- Resolving a flag is its own narrow, audited transition (never a
-- silent clear) -- see attendance_resolve_reconciliation_flag in Part 6.
CREATE TABLE IF NOT EXISTS attendance_reconciliation_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  flagged_reason TEXT NOT NULL CHECK (flagged_reason IN ('payroll_processed_pending', 'payroll_approved', 'roster_invalidated_auto_entry')),
  flagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,
  resolved_by UUID NULL REFERENCES profiles(id) ON DELETE SET NULL,
  resolution_notes TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_attendance_reconciliation_flags_open ON attendance_reconciliation_flags(tenant_id, employee_id, attendance_date) WHERE resolved_at IS NULL;

CREATE OR REPLACE FUNCTION attendance_reconciliation_flag_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'Reconciliation flags are append-only: an already-resolved flag can never be modified again' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.attendance_date IS DISTINCT FROM OLD.attendance_date
     OR NEW.flagged_reason IS DISTINCT FROM OLD.flagged_reason OR NEW.flagged_at IS DISTINCT FROM OLD.flagged_at
  THEN
    RAISE EXCEPTION 'Reconciliation flags are append-only: identity/content columns cannot be modified' USING ERRCODE = '42501';
  END IF;
  IF NEW.resolved_at IS NULL OR NEW.resolved_by IS NULL THEN
    RAISE EXCEPTION 'Resolving a reconciliation flag requires both resolved_at and resolved_by to be set' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_reconciliation_flags_guard ON attendance_reconciliation_flags;
CREATE TRIGGER trg_attendance_reconciliation_flags_guard
  BEFORE UPDATE ON attendance_reconciliation_flags
  FOR EACH ROW EXECUTE FUNCTION attendance_reconciliation_flag_guard();

DROP TRIGGER IF EXISTS trg_attendance_reconciliation_flags_no_delete ON attendance_reconciliation_flags;
CREATE TRIGGER trg_attendance_reconciliation_flags_no_delete
  BEFORE DELETE ON attendance_reconciliation_flags
  FOR EACH ROW EXECUTE FUNCTION attendance_audit_log_immutable();

ALTER TABLE attendance_reconciliation_flags ENABLE ROW LEVEL SECURITY;

-- Confirmed decision 4: ONLY attendance.resolve_reconciliation holders
-- (or super-admin) may even SEE flags, not every attendance.view holder
-- -- these are payroll-sensitive by nature (two of the three reasons are
-- literally about payroll periods).
DROP POLICY IF EXISTS "Reconciliation flags: view with resolve permission" ON attendance_reconciliation_flags;
CREATE POLICY "Reconciliation flags: view with resolve permission" ON attendance_reconciliation_flags
FOR SELECT USING (
  is_current_user_active()
  AND (is_super_admin() OR (tenant_id = get_current_tenant_id() AND has_permission('attendance.resolve_reconciliation')))
);

REVOKE ALL ON attendance_reconciliation_flags FROM PUBLIC, anon, authenticated;
GRANT SELECT ON attendance_reconciliation_flags TO authenticated;

-- ============================================================
-- PART 5: server-side calculation -- mirrors Stage A exactly
-- ============================================================
-- Africa/Blantyre is a fixed UTC+2 offset, no DST -- same constant as
-- AFRICA_BLANTYRE_OFFSET_MINUTES (hikcentralExcelParser.ts) and the same
-- formula as blantyreDateTimeToUtcIso (attendanceCalculationEngine.ts):
-- treat (date + wall-clock time) as if it were already UTC, then
-- subtract the 2-hour offset to get the real UTC instant.
CREATE OR REPLACE FUNCTION attendance_blantyre_to_utc(p_date DATE, p_time TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT (p_date::timestamp + p_time::interval) AT TIME ZONE 'UTC' - interval '2 hours';
$$;

-- Direct transcription of calculateAttendanceStatus()
-- (src/utils/attendanceCalculationEngine.ts). Takes the SAME shape of
-- inputs that function takes (resolved shift, raw event timestamps,
-- coverage), and must be kept in lockstep with it via the shared
-- fixtures in src/utils/attendanceEngineSqlParity.test.ts -- any future
-- change to the TypeScript engine's decision rules MUST be mirrored
-- here in the same change, or the parity test will fail.
--
-- p_resolved_shift: 'day' | 'night' | 'off' | 'unassigned'
-- p_event_times: this employee's successful/authorized scan instants in
--   a reasonably wide surrounding window -- this function does its own
--   windowing, exactly like the TS engine.
-- p_coverage_status: 'confirmed_complete' | 'insufficient'
-- p_coverage_verified_through: required/meaningful only when
--   p_coverage_status = 'confirmed_complete'; NULL otherwise.
CREATE OR REPLACE FUNCTION attendance_engine_calculate(
  p_shift_date DATE,
  p_resolved_shift TEXT,
  p_event_times TIMESTAMPTZ[],
  p_coverage_status TEXT,
  p_coverage_verified_through TIMESTAMPTZ
)
RETURNS TABLE (
  status TEXT,
  calculation_basis TEXT,
  check_in_at TIMESTAMPTZ,
  check_out_at TIMESTAMPTZ,
  reason TEXT
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_day_check_in CONSTANT TEXT[] := ARRAY['04:00', '08:00'];
  v_day_check_out CONSTANT TEXT[] := ARRAY['16:00', '20:00'];
  v_day_late_after CONSTANT TEXT := '06:15';
  v_night_check_in CONSTANT TEXT[] := ARRAY['16:00', '20:00'];
  v_night_check_out CONSTANT TEXT[] := ARRAY['04:00', '08:00'];
  v_night_late_after CONSTANT TEXT := '18:15';

  v_checkout_date DATE;
  v_checkin_window_start TIMESTAMPTZ;
  v_checkin_window_end TIMESTAMPTZ;
  v_checkout_window_start TIMESTAMPTZ;
  v_checkout_window_end TIMESTAMPTZ;
  v_late_after TIMESTAMPTZ;

  v_check_in_at TIMESTAMPTZ;
  v_check_out_at TIMESTAMPTZ;
  v_checkout_window_confirmed_closed BOOLEAN;
  v_t TIMESTAMPTZ;
BEGIN
  IF p_resolved_shift = 'off' THEN
    RETURN QUERY SELECT 'off'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, 'Scheduled Off day.'::TEXT;
    RETURN;
  END IF;
  IF p_resolved_shift = 'unassigned' THEN
    RETURN QUERY SELECT 'unassigned'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, 'No roster assignment recorded for this date.'::TEXT;
    RETURN;
  END IF;
  IF p_resolved_shift NOT IN ('day', 'night') THEN
    RAISE EXCEPTION 'attendance_engine_calculate: unrecognized resolved shift %', p_resolved_shift;
  END IF;

  -- Both shifts' check-in windows fall on the shift's own starting
  -- date; only a Night shift's checkout window crosses to the next date.
  v_checkout_date := CASE WHEN p_resolved_shift = 'night' THEN p_shift_date + 1 ELSE p_shift_date END;

  IF p_resolved_shift = 'day' THEN
    v_checkin_window_start := attendance_blantyre_to_utc(p_shift_date, v_day_check_in[1]);
    v_checkin_window_end := attendance_blantyre_to_utc(p_shift_date, v_day_check_in[2]);
    v_checkout_window_start := attendance_blantyre_to_utc(v_checkout_date, v_day_check_out[1]);
    v_checkout_window_end := attendance_blantyre_to_utc(v_checkout_date, v_day_check_out[2]);
    v_late_after := attendance_blantyre_to_utc(p_shift_date, v_day_late_after);
  ELSE
    v_checkin_window_start := attendance_blantyre_to_utc(p_shift_date, v_night_check_in[1]);
    v_checkin_window_end := attendance_blantyre_to_utc(p_shift_date, v_night_check_in[2]);
    v_checkout_window_start := attendance_blantyre_to_utc(v_checkout_date, v_night_check_out[1]);
    v_checkout_window_end := attendance_blantyre_to_utc(v_checkout_date, v_night_check_out[2]);
    v_late_after := attendance_blantyre_to_utc(p_shift_date, v_night_late_after);
  END IF;

  -- Earliest event within each window -- mirrors earliestEventInWindow()
  -- exactly (inclusive bounds, earliest wins, repeats never penalize).
  v_check_in_at := NULL;
  v_check_out_at := NULL;
  IF p_event_times IS NOT NULL THEN
    FOREACH v_t IN ARRAY p_event_times LOOP
      IF v_t >= v_checkin_window_start AND v_t <= v_checkin_window_end THEN
        IF v_check_in_at IS NULL OR v_t < v_check_in_at THEN v_check_in_at := v_t; END IF;
      END IF;
      IF v_t >= v_checkout_window_start AND v_t <= v_checkout_window_end THEN
        IF v_check_out_at IS NULL OR v_t < v_check_out_at THEN v_check_out_at := v_t; END IF;
      END IF;
    END LOOP;
  END IF;

  IF v_check_in_at IS NOT NULL AND v_check_out_at IS NOT NULL THEN
    IF v_check_in_at <= v_late_after THEN
      RETURN QUERY SELECT 'present'::TEXT, 'confirmed'::TEXT, v_check_in_at, v_check_out_at,
        'Valid check-in within grace period and valid checkout recorded.'::TEXT;
    ELSE
      RETURN QUERY SELECT 'late'::TEXT, 'confirmed'::TEXT, v_check_in_at, v_check_out_at,
        'Valid checkout recorded, but check-in was after the grace period.'::TEXT;
    END IF;
    RETURN;
  END IF;

  -- Completeness gate: can only finalize Absent once the LATER window
  -- (checkout, which always closes after check-in for both shift types)
  -- is confirmed closed by genuinely verified coverage. Step 1
  -- correction A/E: unknown coverage (NULL status, or status not
  -- literally 'confirmed_complete') is NEVER treated as early-export
  -- proof of anything -- it falls through to the exact same branch as
  -- an explicit 'insufficient' status.
  v_checkout_window_confirmed_closed :=
    p_coverage_status = 'confirmed_complete'
    AND p_coverage_verified_through IS NOT NULL
    AND p_coverage_verified_through >= v_checkout_window_end;

  IF NOT v_checkout_window_confirmed_closed THEN
    IF v_check_in_at IS NOT NULL THEN
      IF v_check_in_at <= v_late_after THEN
        RETURN QUERY SELECT 'present'::TEXT, 'check_in_only_provisional'::TEXT, v_check_in_at, NULL::TIMESTAMPTZ,
          'Valid check-in within grace period; credited Present under the early-export policy pending checkout window closure (no checkout observed yet).'::TEXT;
      ELSE
        RETURN QUERY SELECT 'late'::TEXT, 'check_in_only_provisional'::TEXT, v_check_in_at, NULL::TIMESTAMPTZ,
          'Check-in was after the grace period; credited Late under the early-export policy pending checkout window closure (no checkout observed yet).'::TEXT;
      END IF;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'pending'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
      'No valid check-in recorded yet -- the check-in window is not yet confirmed closed or data coverage is insufficient.'::TEXT;
    RETURN;
  END IF;

  IF v_check_in_at IS NOT NULL AND v_check_out_at IS NULL THEN
    RETURN QUERY SELECT 'absent'::TEXT, NULL::TEXT, v_check_in_at, NULL::TIMESTAMPTZ,
      'Valid check-in recorded, but no valid checkout was recorded after the checkout window closed.'::TEXT;
  ELSIF v_check_in_at IS NULL AND v_check_out_at IS NOT NULL THEN
    RETURN QUERY SELECT 'absent'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, v_check_out_at,
      'Valid checkout recorded, but no valid check-in was recorded.'::TEXT;
  ELSE
    RETURN QUERY SELECT 'absent'::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
      'No valid fingerprint scans recorded for this scheduled shift after data coverage was confirmed complete.'::TEXT;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION attendance_engine_calculate(DATE, TEXT, TIMESTAMPTZ[], TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_engine_calculate(DATE, TEXT, TIMESTAMPTZ[], TEXT, TIMESTAMPTZ) TO authenticated;
REVOKE ALL ON FUNCTION attendance_blantyre_to_utc(DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_blantyre_to_utc(DATE, TEXT) TO authenticated;

-- ============================================================
-- PART 6: orchestration -- roster resolution + mapping-gap guard +
-- coverage lookup, mirroring the Stage B TypeScript orchestration layer
-- (attendanceCalculationPreview.ts). This is the ONLY function that
-- decides what coverage actually applies -- it NEVER accepts a coverage
-- object or confirmation id from a caller, only looks up active,
-- unrevoked confirmations itself.
-- ============================================================
CREATE OR REPLACE FUNCTION attendance_resolve_and_calculate(p_employee_id UUID, p_shift_date DATE)
RETURNS TABLE (
  status TEXT,
  calculation_basis TEXT,
  check_in_at TIMESTAMPTZ,
  check_out_at TIMESTAMPTZ,
  reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
  v_workstation TEXT;
  v_resolved_shift TEXT;
  v_has_active_mapping BOOLEAN;
  v_event_times TIMESTAMPTZ[];
  v_checkout_window_end TIMESTAMPTZ;
  v_coverage_status TEXT := 'insufficient';
  v_coverage_through TIMESTAMPTZ := NULL;
BEGIN
  SELECT tenant_id, workstation INTO v_tenant_id, v_workstation FROM employees WHERE id = p_employee_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'attendance_resolve_and_calculate: no such employee %', p_employee_id;
  END IF;

  v_resolved_shift := roster_resolve_schedule(p_employee_id, p_shift_date);

  IF v_resolved_shift IN ('off', 'unassigned') THEN
    RETURN QUERY SELECT * FROM attendance_engine_calculate(p_shift_date, v_resolved_shift, NULL, 'insufficient', NULL);
    RETURN;
  END IF;

  -- Mapping-gap guard (Stage B's own rule, mirrored exactly): zero
  -- events because nobody has confirmed this employee's HikCentral
  -- identity yet is a DIFFERENT fact than zero events because they
  -- didn't scan. Without an active mapping, coverage is forced
  -- 'insufficient' regardless of any confirmation on file, and events
  -- are not even looked up (there is no trustworthy identity to look
  -- them up by).
  SELECT EXISTS(
    SELECT 1 FROM hikcentral_person_mappings m WHERE m.employee_id = p_employee_id AND m.is_active
  ) INTO v_has_active_mapping;

  IF v_has_active_mapping THEN
    SELECT ARRAY_AGG(r.event_time) INTO v_event_times
    FROM hikcentral_raw_events r
    JOIN hikcentral_person_mappings m ON m.hikcentral_person_no = r.hikcentral_person_no AND m.is_active
    WHERE m.employee_id = p_employee_id
      AND r.event_time >= attendance_blantyre_to_utc(p_shift_date, '00:00') - interval '4 hours'
      AND r.event_time <= attendance_blantyre_to_utc(p_shift_date + 2, '00:00');

    v_checkout_window_end := (SELECT check_out_window_end FROM attendance_engine_shift_windows(p_shift_date, v_resolved_shift));

    SELECT c.covers_through INTO v_coverage_through
    FROM fingerprint_coverage_confirmations c
    WHERE c.tenant_id = v_tenant_id
      AND c.revoked_at IS NULL
      AND v_workstation = ANY (c.workstations)
      AND c.covers_through >= v_checkout_window_end
    ORDER BY c.covers_through DESC
    LIMIT 1;

    IF v_coverage_through IS NOT NULL THEN
      v_coverage_status := 'confirmed_complete';
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM attendance_engine_calculate(p_shift_date, v_resolved_shift, v_event_times, v_coverage_status, v_coverage_through);
END;
$$;

-- Small helper so the orchestration function above can ask "what is the
-- checkout window end for this shift" without duplicating the window
-- math a second time -- exposes just that one boundary from the engine's
-- internal window computation.
CREATE OR REPLACE FUNCTION attendance_engine_shift_windows(p_shift_date DATE, p_resolved_shift TEXT)
RETURNS TABLE (check_out_window_end TIMESTAMPTZ)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_resolved_shift = 'day' THEN attendance_blantyre_to_utc(p_shift_date, '20:00')
    WHEN p_resolved_shift = 'night' THEN attendance_blantyre_to_utc(p_shift_date + 1, '08:00')
  END;
$$;

REVOKE ALL ON FUNCTION attendance_engine_shift_windows(DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_engine_shift_windows(DATE, TEXT) TO authenticated;
-- attendance_resolve_and_calculate is INTERNAL-ONLY, not granted to
-- `authenticated` at all: it resolves coverage/results from the named
-- employee's OWN tenant with no check of the CALLER's own tenant/region
-- against that employee -- correct when called from inside
-- attendance_apply_automatic (which already validated the caller against
-- every employee_id in its worklist before reaching this), but unsafe
-- to expose directly, since it would let any authenticated user query
-- another tenant's employee by id. A future read-only dry-run surface
-- (explicitly out of scope this round) must add its own caller-scoping
-- check before this function is ever granted more broadly.
REVOKE ALL ON FUNCTION attendance_resolve_and_calculate(UUID, DATE) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- PART 7: secure write path
-- ============================================================

-- Internal helper -- NOT exposed to `authenticated` (no GRANT below).
-- Every public write RPC in this file funnels through this ONE function
-- so the lock/no-op/manual-priority/payroll-flag/audit logic exists in
-- exactly one place.
--
-- Concurrency (Step 1 correction B): `SELECT ... FOR UPDATE` cannot lock
-- a row that does not exist yet, which is exactly the race a first
-- INSERT for a given (employee_id, date) is exposed to. A session-level
-- advisory transaction lock keyed on (employee_id, date) has no such
-- gap -- it serializes every caller for that exact key regardless of
-- whether a row currently exists, and is released automatically at
-- transaction end (commit or rollback), so it can never be left locked
-- by a crashed session.
CREATE OR REPLACE FUNCTION attendance_write_one(
  p_tenant_id UUID,
  p_employee_id UUID,
  p_date DATE,
  p_new_status TEXT,
  p_new_basis TEXT,
  p_source TEXT,
  p_actor_id UUID,
  p_reason TEXT
)
RETURNS TABLE (outcome TEXT, old_status TEXT, new_status TEXT, payroll_flag TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_status TEXT;
  v_old_basis TEXT;
  v_old_source TEXT;
  v_month TEXT;
  v_payroll_exists BOOLEAN;
  v_payroll_approved BOOLEAN;
BEGIN
  IF p_source NOT IN ('manual', 'automatic') THEN
    RAISE EXCEPTION 'attendance_write_one: invalid source %', p_source;
  END IF;
  IF p_new_status NOT IN ('P', 'A', 'L') THEN
    -- This function only ever WRITES a real attendance outcome -- never
    -- called for Pending/Off/Unassigned (callers must filter those out
    -- before reaching here; see attendance_apply_automatic).
    RAISE EXCEPTION 'attendance_write_one: p_new_status must be one of P/A/L, got %', p_new_status;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_employee_id::text || '|' || p_date::text));

  SELECT status, calculation_basis, source INTO v_old_status, v_old_basis, v_old_source
  FROM attendance WHERE employee_id = p_employee_id AND date = p_date;

  -- Manual priority (confirmed decision, every round): an automatic
  -- write never overwrites a row a human has touched.
  IF p_source = 'automatic' AND v_old_source = 'manual' THEN
    RETURN QUERY SELECT 'skipped_manual_protected'::TEXT, v_old_status, v_old_status, NULL::TEXT;
    RETURN;
  END IF;

  v_month := to_char(p_date, 'YYYY-MM');
  SELECT EXISTS(SELECT 1 FROM payroll WHERE employee_id = p_employee_id AND month = v_month),
         EXISTS(SELECT 1 FROM payroll WHERE employee_id = p_employee_id AND month = v_month AND approval_status = 'approved')
    INTO v_payroll_exists, v_payroll_approved;

  -- Automatic writes are refused outright for an approved month --
  -- never silent, and never even attempted (manual corrections to an
  -- approved month are a separate, explicitly-allowed path below).
  IF p_source = 'automatic' AND v_payroll_approved THEN
    RETURN QUERY SELECT 'skipped_payroll_approved'::TEXT, v_old_status, v_old_status, 'approved'::TEXT;
    RETURN;
  END IF;

  -- No-op (correction C): identical status AND basis AND source already
  -- present -- covers a repeated automatic run producing the same
  -- conclusion, and also a provisional->provisional "recalculation"
  -- that genuinely changed nothing. A provisional->confirmed transition
  -- with the SAME status code is intentionally NOT caught by this
  -- guard (old_basis IS DISTINCT FROM p_new_basis makes it fall through
  -- to a real write + audit row below), per correction C.
  IF v_old_status = p_new_status AND v_old_basis IS NOT DISTINCT FROM p_new_basis AND v_old_source = p_source THEN
    RETURN QUERY SELECT 'skipped_no_change'::TEXT, v_old_status, v_old_status, NULL::TEXT;
    RETURN;
  END IF;

  INSERT INTO attendance (tenant_id, employee_id, date, status, calculation_basis, source)
  VALUES (p_tenant_id, p_employee_id, p_date, p_new_status, p_new_basis, p_source)
  ON CONFLICT (employee_id, date) DO UPDATE
    SET status = EXCLUDED.status, calculation_basis = EXCLUDED.calculation_basis, source = EXCLUDED.source;

  -- Same transaction as the write above -- if this insert fails for any
  -- reason, the whole function raises and the attendance write rolls
  -- back with it (correction: "an attendance update and its audit
  -- record succeed or fail together").
  INSERT INTO attendance_audit_log (
    tenant_id, employee_id, attendance_date, old_status, new_status,
    old_calculation_basis, new_calculation_basis, changed_by, change_source, reason
  ) VALUES (
    p_tenant_id, p_employee_id, p_date, v_old_status, p_new_status,
    v_old_basis, p_new_basis, p_actor_id, p_source, p_reason
  );

  IF v_payroll_exists THEN
    INSERT INTO attendance_reconciliation_flags (tenant_id, employee_id, attendance_date, flagged_reason)
    VALUES (p_tenant_id, p_employee_id, p_date, CASE WHEN v_payroll_approved THEN 'payroll_approved' ELSE 'payroll_processed_pending' END);
  END IF;

  RETURN QUERY SELECT
    'written'::TEXT, v_old_status, p_new_status,
    (CASE WHEN v_payroll_approved THEN 'approved' WHEN v_payroll_exists THEN 'processed_pending' ELSE NULL END)::TEXT;
END;
$$;

-- Shared authorization preflight for every public RPC below: resolves
-- the caller's own tenant/role/active status directly from `profiles`
-- (SECURITY DEFINER, never trusts anything the client asserts), and
-- locks + validates one target employee's tenant+region membership.
-- Raises (aborting the WHOLE calling transaction) rather than returning
-- a boolean, so an out-of-scope employee_id anywhere in a batch aborts
-- the entire call with a clear error -- never a silent partial skip
-- (explicit resolution from the architecture round).
-- Reuses employee_region_allowed(p_employee_id) -- the SAME helper the
-- real `attendance` RLS policy itself now calls (20260908000000-era
-- refinement, confirmed against this migration's own target database)
-- -- rather than re-deriving tenant+region scoping by hand. That helper
-- already encapsulates "this employee is in my tenant AND my region, OR
-- I am a super/business admin", so this wrapper only needs to turn a
-- false into a hard abort (never a silent skip, per the architecture
-- round's explicit resolution) and hand back the employee's own
-- tenant_id (needed so a super-admin's cross-tenant write still records
-- the EMPLOYEE's real tenant_id on the attendance row, never the
-- caller's).
CREATE OR REPLACE FUNCTION attendance_assert_employee_in_scope(p_caller_tenant_id UUID, p_is_super_admin BOOLEAN, p_employee_id UUID)
RETURNS UUID -- the employee's tenant_id, for the caller's own use
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_employee_tenant_id UUID;
BEGIN
  PERFORM 1 FROM employees WHERE id = p_employee_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such employee: %', p_employee_id;
  END IF;
  IF NOT employee_region_allowed(p_employee_id) THEN
    RAISE EXCEPTION 'Employee % is outside the caller''s authorized tenant/region', p_employee_id USING ERRCODE = '42501';
  END IF;
  SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = p_employee_id;
  RETURN v_employee_tenant_id;
END;
$$;

-- ---- Manual single-edit -------------------------------------------
-- Gated EXACTLY like the existing direct-table UPDATE/INSERT policy on
-- `attendance` (20260817000002: legacy role_level<=3 OR
-- attendance.create/attendance.edit) -- this RPC is additive, not yet a
-- replacement, so its authorization must match today's real behavior,
-- not invent a new bar. No reason required (confirmed decision).
CREATE OR REPLACE FUNCTION attendance_correct(p_employee_id UUID, p_date DATE, p_status TEXT, p_reason TEXT DEFAULT NULL)
RETURNS TABLE (outcome TEXT, old_status TEXT, new_status TEXT, payroll_flag TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_role_level INTEGER; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_employee_tenant_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_status NOT IN ('P', 'A', 'L', 'LV', 'SL', '-') THEN RAISE EXCEPTION 'Invalid status %', p_status; END IF;

  SELECT tenant_id, role_level, is_super_admin, is_active INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active
  FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR COALESCE(v_role_level, 99) <= 3 OR has_permission('attendance.create') OR has_permission('attendance.edit')) THEN
    RAISE EXCEPTION 'Not authorized to edit attendance' USING ERRCODE = '42501';
  END IF;

  v_employee_tenant_id := attendance_assert_employee_in_scope(v_tenant_id, v_is_super_admin, p_employee_id);

  -- A manual edit writing P/A/L uses this same protected path; LV/SL/'-'
  -- are not calculation outcomes at all (leave/sick-leave/blank), so
  -- they bypass attendance_write_one's P/A/L-only guard and are written
  -- directly here -- still audited, still source='manual', still
  -- payroll-flagged if applicable. basis is NULL for all of these (no
  -- calculation backs a manual value).
  IF p_status IN ('P', 'A', 'L') THEN
    RETURN QUERY SELECT * FROM attendance_write_one(v_employee_tenant_id, p_employee_id, p_date, p_status, NULL, 'manual', v_caller_id, p_reason);
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext(p_employee_id::text || '|' || p_date::text));
    DECLARE
      v_old_status TEXT; v_old_basis TEXT; v_payroll_exists BOOLEAN; v_payroll_approved BOOLEAN; v_month TEXT;
    BEGIN
      SELECT status, calculation_basis INTO v_old_status, v_old_basis FROM attendance WHERE employee_id = p_employee_id AND date = p_date;
      IF v_old_status = p_status THEN
        RETURN QUERY SELECT 'skipped_no_change'::TEXT, v_old_status, v_old_status, NULL::TEXT;
        RETURN;
      END IF;
      v_month := to_char(p_date, 'YYYY-MM');
      SELECT EXISTS(SELECT 1 FROM payroll WHERE employee_id = p_employee_id AND month = v_month),
             EXISTS(SELECT 1 FROM payroll WHERE employee_id = p_employee_id AND month = v_month AND approval_status = 'approved')
        INTO v_payroll_exists, v_payroll_approved;

      INSERT INTO attendance (tenant_id, employee_id, date, status, calculation_basis, source)
      VALUES (v_employee_tenant_id, p_employee_id, p_date, p_status, NULL, 'manual')
      ON CONFLICT (employee_id, date) DO UPDATE SET status = EXCLUDED.status, calculation_basis = NULL, source = 'manual';

      INSERT INTO attendance_audit_log (tenant_id, employee_id, attendance_date, old_status, new_status, old_calculation_basis, new_calculation_basis, changed_by, change_source, reason)
      VALUES (v_employee_tenant_id, p_employee_id, p_date, v_old_status, p_status, v_old_basis, NULL, v_caller_id, 'manual', p_reason);

      IF v_payroll_exists THEN
        INSERT INTO attendance_reconciliation_flags (tenant_id, employee_id, attendance_date, flagged_reason)
        VALUES (v_employee_tenant_id, p_employee_id, p_date, CASE WHEN v_payroll_approved THEN 'payroll_approved' ELSE 'payroll_processed_pending' END);
      END IF;

      RETURN QUERY SELECT 'written'::TEXT, v_old_status, p_status, (CASE WHEN v_payroll_approved THEN 'approved' WHEN v_payroll_exists THEN 'processed_pending' ELSE NULL END)::TEXT;
    END;
  END IF;
END;
$$;

-- ---- Manual bulk correction -----------------------------------------
-- One optional shared reason for the whole batch (confirmed decision),
-- no per-row reason. Same authorization bar as attendance_correct.
CREATE OR REPLACE FUNCTION attendance_bulk_correct(
  p_employee_ids UUID[], p_date_from DATE, p_date_to DATE, p_status TEXT, p_reason TEXT DEFAULT NULL
)
RETURNS TABLE (employee_id UUID, attendance_date DATE, outcome TEXT, old_status TEXT, new_status TEXT, payroll_flag TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_employee_id UUID;
  v_date DATE;
  v_row RECORD;
BEGIN
  IF p_date_from > p_date_to THEN RAISE EXCEPTION 'p_date_from must not be after p_date_to'; END IF;
  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL THEN RAISE EXCEPTION 'p_employee_ids must not be empty'; END IF;

  FOREACH v_employee_id IN ARRAY p_employee_ids LOOP
    v_date := p_date_from;
    WHILE v_date <= p_date_to LOOP
      SELECT * INTO v_row FROM attendance_correct(v_employee_id, v_date, p_status, p_reason);
      employee_id := v_employee_id; attendance_date := v_date;
      outcome := v_row.outcome; old_status := v_row.old_status; new_status := v_row.new_status; payroll_flag := v_row.payroll_flag;
      RETURN NEXT;
      v_date := v_date + 1;
    END LOOP;
  END LOOP;
END;
$$;

-- ---- Automatic apply -------------------------------------------------
-- The ONLY input is a worklist of (employee, date) -- no status, basis,
-- or coverage id is ever accepted from the caller (correction B). This
-- function is complete and correct as written, but per the explicit
-- authorization for this round, NOTHING in the frontend calls it yet.
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
      -- Pending/Off/Unassigned are NEVER written -- the single rule that
      -- makes "never silently converted into Absent" structural rather
      -- than caller-remembered.
      IF v_calc.status IN ('present', 'late', 'absent') THEN
        SELECT * INTO v_write FROM attendance_write_one(
          v_employee_tenant_id, v_employee_id, v_date,
          (CASE v_calc.status WHEN 'present' THEN 'P' WHEN 'late' THEN 'L' WHEN 'absent' THEN 'A' END),
          v_calc.calculation_basis, 'automatic', v_caller_id, NULL
        );
        employee_id := v_employee_id; attendance_date := v_date;
        outcome := v_write.outcome; old_status := v_write.old_status; new_status := v_write.new_status; payroll_flag := v_write.payroll_flag;
      ELSE
        employee_id := v_employee_id; attendance_date := v_date;
        outcome := 'skipped_' || v_calc.status; old_status := NULL; new_status := NULL; payroll_flag := NULL;
      END IF;
      RETURN NEXT;
      v_date := v_date + 1;
    END LOOP;
  END LOOP;
END;
$$;

-- ---- Coverage confirmation / revocation -----------------------------
CREATE OR REPLACE FUNCTION attendance_confirm_coverage(
  p_workstations TEXT[], p_covers_from TIMESTAMPTZ, p_covers_through TIMESTAMPTZ,
  p_export_time_declared TIMESTAMPTZ DEFAULT NULL, p_notes TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR has_permission('attendance.confirm_coverage')) THEN
    RAISE EXCEPTION 'Not authorized to confirm fingerprint coverage' USING ERRCODE = '42501';
  END IF;
  IF p_workstations IS NULL OR array_length(p_workstations, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one workstation must be named';
  END IF;
  IF p_covers_through <= p_covers_from THEN RAISE EXCEPTION 'p_covers_through must be after p_covers_from'; END IF;

  INSERT INTO fingerprint_coverage_confirmations (tenant_id, confirmed_by, workstations, covers_from, covers_through, export_time_declared, notes)
  VALUES (v_tenant_id, v_caller_id, p_workstations, p_covers_from, p_covers_through, p_export_time_declared, p_notes)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION attendance_revoke_coverage(p_confirmation_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_confirmation_tenant_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR has_permission('attendance.confirm_coverage')) THEN
    RAISE EXCEPTION 'Not authorized to revoke fingerprint coverage confirmations' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id INTO v_confirmation_tenant_id FROM fingerprint_coverage_confirmations WHERE id = p_confirmation_id;
  IF v_confirmation_tenant_id IS NULL THEN RAISE EXCEPTION 'No such confirmation %', p_confirmation_id; END IF;
  IF NOT v_is_super_admin AND v_confirmation_tenant_id IS DISTINCT FROM v_tenant_id THEN
    RAISE EXCEPTION 'Confirmation % is not in the caller''s tenant', p_confirmation_id USING ERRCODE = '42501';
  END IF;

  UPDATE fingerprint_coverage_confirmations
  SET revoked_at = NOW(), revoked_by = v_caller_id, revoked_reason = p_reason
  WHERE id = p_confirmation_id;
END;
$$;

-- ---- Reconciliation flag resolution ----------------------------------
CREATE OR REPLACE FUNCTION attendance_resolve_reconciliation_flag(p_flag_id UUID, p_notes TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_flag_tenant_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  -- Confirmed decision 4: ONLY attendance.resolve_reconciliation
  -- holders (payroll/finance admins) may resolve a flag -- no legacy
  -- role_level bypass, same deliberate narrowness as attendance.auto_apply.
  IF NOT (v_is_super_admin OR has_permission('attendance.resolve_reconciliation')) THEN
    RAISE EXCEPTION 'Not authorized to resolve payroll reconciliation flags' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id INTO v_flag_tenant_id FROM attendance_reconciliation_flags WHERE id = p_flag_id;
  IF v_flag_tenant_id IS NULL THEN RAISE EXCEPTION 'No such flag %', p_flag_id; END IF;
  IF NOT v_is_super_admin AND v_flag_tenant_id IS DISTINCT FROM v_tenant_id THEN
    RAISE EXCEPTION 'Flag % is not in the caller''s tenant', p_flag_id USING ERRCODE = '42501';
  END IF;

  UPDATE attendance_reconciliation_flags
  SET resolved_at = NOW(), resolved_by = v_caller_id, resolution_notes = p_notes
  WHERE id = p_flag_id;
END;
$$;

REVOKE ALL ON FUNCTION attendance_correct(UUID, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_correct(UUID, DATE, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION attendance_bulk_correct(UUID[], DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_bulk_correct(UUID[], DATE, DATE, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION attendance_apply_automatic(UUID[], DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_apply_automatic(UUID[], DATE, DATE) TO authenticated;
REVOKE ALL ON FUNCTION attendance_confirm_coverage(TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_confirm_coverage(TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION attendance_revoke_coverage(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_revoke_coverage(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION attendance_resolve_reconciliation_flag(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_resolve_reconciliation_flag(UUID, TEXT) TO authenticated;
-- attendance_write_one / attendance_assert_employee_in_scope: no GRANT
-- to authenticated at all -- internal-only, callable only from the
-- other SECURITY DEFINER functions in this file (which run as the
-- function owner, same role that owns these helpers).
REVOKE ALL ON FUNCTION attendance_write_one(UUID, UUID, DATE, TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION attendance_assert_employee_in_scope(UUID, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- PART 8: roster-change detector (correction F)
-- ============================================================
-- Documented scope: this trigger covers `roster_date_assignments`
-- INSERTs only -- a dated override/correction being added or changed,
-- which is the concrete, common case ("an Admin corrected an employee's
-- Day/Night/Off for a specific date after an automatic P/L/A had
-- already been written for it"). `roster_off_day_patterns` changes are
-- NOT covered by this migration: a pattern change can retroactively
-- affect resolution for many dates at once, and detecting which of
-- those dates already have an automatic attendance row would require
-- re-running roster_resolve_schedule for every affected date on every
-- pattern insert -- a real feature, deliberately deferred rather than
-- half-implemented here. Flagged as a known gap, not silently assumed
-- solved.
CREATE OR REPLACE FUNCTION attendance_flag_roster_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
  v_already_flagged BOOLEAN;
BEGIN
  IF NOT NEW.is_active THEN
    RETURN NEW;
  END IF;

  SELECT a.tenant_id INTO v_tenant_id
  FROM attendance a
  WHERE a.employee_id = NEW.employee_id AND a.date = NEW.assignment_date AND a.source = 'automatic';

  IF v_tenant_id IS NOT NULL THEN
    SELECT EXISTS(
      SELECT 1 FROM attendance_reconciliation_flags f
      WHERE f.employee_id = NEW.employee_id AND f.attendance_date = NEW.assignment_date
        AND f.flagged_reason = 'roster_invalidated_auto_entry' AND f.resolved_at IS NULL
    ) INTO v_already_flagged;

    IF NOT v_already_flagged THEN
      INSERT INTO attendance_reconciliation_flags (tenant_id, employee_id, attendance_date, flagged_reason)
      VALUES (v_tenant_id, NEW.employee_id, NEW.assignment_date, 'roster_invalidated_auto_entry');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_flag_roster_change ON roster_date_assignments;
CREATE TRIGGER trg_attendance_flag_roster_change
  AFTER INSERT ON roster_date_assignments
  FOR EACH ROW EXECUTE FUNCTION attendance_flag_roster_change();

-- ============================================================
-- PART 9: new permission keys (seeded minimally -- see report)
-- ============================================================
-- Deliberately narrow seeding for this round: nobody except
-- is_business_admin() (the existing special-case bypass in
-- has_permission()) can use attendance.auto_apply or
-- attendance.confirm_coverage yet -- automatic processing is not
-- activated this round, so there is no legitimate non-admin caller for
-- either. attendance.resolve_reconciliation is seeded to 'accountant'
-- (confirmed decision: "only authorized payroll/finance administrators"),
-- matching that role's existing payroll.view/payroll.approve authority.
-- Who ELSE should get auto_apply/confirm_coverage is an explicit open
-- question for Step 2+, not decided here.
INSERT INTO role_permissions (role, permission) VALUES
  ('accountant', 'attendance.resolve_reconciliation')
ON CONFLICT (role, permission) DO NOTHING;
