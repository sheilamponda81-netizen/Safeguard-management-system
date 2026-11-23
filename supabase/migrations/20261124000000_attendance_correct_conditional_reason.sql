-- ============================================================
-- MIGRATION: restore fast, one-click manual attendance entry --
-- a reason is now required ONLY when a human correction overrides an
-- existing, officially persisted AUTOMATIC attendance decision.
-- Date: 2026-11-24
-- ============================================================
--
-- THE OPERATIONAL PROBLEM (explicit user authorization): of ~1,500
-- employees, only ~300-500 use automatic fingerprint attendance -- the
-- rest are recorded manually from physical attendance books.
-- 20261120000000_attendance_correct_mandatory_reason.sql made EVERY
-- manual correction require a written reason, including the other
-- ~1,000-1,200 employees' ordinary, routine entries -- a real
-- regression for day-to-day HR processing, not the behavior that
-- migration intended to fix (it was closing a bypass on accountability
-- for overriding automatic results, not slowing down routine entry).
--
-- THE RESTORED RULE, enforced here at the authoritative database
-- level (never only in the UI):
--   NO reason required -- blank/unmarked -> anything; existing MANUAL
--   record -> any other manual status (Present<->Absent, any
--   LV/SL/-, etc); routine entry for any employee regardless of
--   HikCentral mapping, as long as no existing AUTOMATIC decision is
--   being overridden.
--   REASON required -- only when the EXISTING persisted row's own
--   `source` column is not affirmatively 'manual' (i.e. it is
--   'automatic' today, or -- defensively -- anything else a future
--   schema change might ever allow) and that row is about to be
--   changed by a manual correction. This is deliberately written as
--   an ALLOW-list ("no reason needed only when source IS 'manual'"),
--   never a block-list ("no reason needed unless source IS
--   'automatic'") -- so a legacy or future row whose source is
--   missing/ambiguous/unrecognized can NEVER be silently treated as
--   safe-to-skip; the only way to skip the reason is to affirmatively
--   prove the existing row was already a manual decision, or that no
--   row exists at all. `attendance.source` is NOT NULL and CHECK-
--   constrained to {'manual','automatic'} today (confirmed by direct
--   inspection), so no genuinely ambiguous value can exist right now
--   -- this is a defense-in-depth default, not a response to any
--   currently-reachable data state.
--
-- The condition reads the EXISTING row's persisted `source` column
-- only -- never employee HikCentral mapping/enrollment, and never
-- today's calculated preview status. An employee with a HikCentral
-- mapping whose attendance has never actually been automatically
-- decided (still blank, or already corrected to manual) gets the fast
-- path exactly like any other employee.
--
-- UNCHANGED BY THIS MIGRATION: manual-correction precedence and
-- approved-payroll protection (both live in attendance_write_one,
-- not touched here), tenant/region scope (attendance_assert_employee_
-- in_scope, not touched), role/permission checks (not touched),
-- attendance_audit_log's own columns and the fact that an audit row
-- is written for EVERY correction regardless of whether a reason was
-- required (changed_by/changed_at/old_status/new_status are never
-- conditional -- only whether `reason` may be NULL is). No existing
-- attendance, payroll, or coverage-confirmation row is modified by
-- this migration -- it only redefines two functions' own logic.
--
-- attendance_bulk_correct is ALSO updated here (unlike the 20261120
-- migration, which left it delegating untouched): it now catches a
-- per-row "reason required" rejection (SQLSTATE 22023) and continues
-- the batch instead of aborting every other row in it, reporting
-- 'rejected_reason_required' for that specific employee/date pair.
-- Before this fix, a single automatic-sourced row anywhere in a batch
-- (sharing one optional reason across the whole range/employee list)
-- would have silently aborted the ENTIRE call with zero writes, even
-- though the vast majority of a real batch is ordinary manual entries
-- that need no reason at all -- exactly the kind of all-or-nothing
-- failure the bulk requirement here says must not be falsely reported
-- as success. Any OTHER exception (bad auth, invalid status, unknown
-- employee) still propagates and aborts the whole call, since those
-- are caller-level problems, not a per-row data condition this
-- function should paper over.
-- ============================================================

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
  v_old_status TEXT; v_old_basis TEXT; v_old_source TEXT;
  v_overrides_existing_record BOOLEAN;
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

  -- Locked BEFORE reading the existing row, for both status paths below
  -- (previously only the LV/SL/- path locked at all) -- the override
  -- decision must never race a concurrent write for the same
  -- employee/date. attendance_write_one takes the identical advisory
  -- lock again for the P/A/L path; re-acquiring the same key within
  -- the same transaction is reentrant and safe, never a deadlock.
  PERFORM pg_advisory_xact_lock(hashtext(p_employee_id::text || '|' || p_date::text));

  SELECT status, calculation_basis, source INTO v_old_status, v_old_basis, v_old_source
  FROM attendance WHERE employee_id = p_employee_id AND date = p_date;

  -- THE CONDITIONAL RULE (allow-list, safe-by-default -- see this
  -- migration's own header for why it must be written this way round).
  v_overrides_existing_record := v_old_status IS NOT NULL AND v_old_source IS DISTINCT FROM 'manual';

  IF v_overrides_existing_record AND (p_reason IS NULL OR btrim(p_reason) = '') THEN
    RAISE EXCEPTION 'A reason is required to override an existing automatic attendance decision' USING ERRCODE = '22023';
  END IF;

  IF p_status IN ('P', 'A', 'L') THEN
    RETURN QUERY SELECT * FROM attendance_write_one(v_employee_tenant_id, p_employee_id, p_date, p_status, NULL, 'manual', v_caller_id, p_reason);
  ELSE
    DECLARE
      v_payroll_exists BOOLEAN; v_payroll_approved BOOLEAN; v_month TEXT;
    BEGIN
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

CREATE OR REPLACE FUNCTION attendance_bulk_correct(p_employee_ids UUID[], p_date_from DATE, p_date_to DATE, p_status TEXT, p_reason TEXT DEFAULT NULL)
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
      BEGIN
        SELECT * INTO v_row FROM attendance_correct(v_employee_id, v_date, p_status, p_reason);
        employee_id := v_employee_id; attendance_date := v_date;
        outcome := v_row.outcome; old_status := v_row.old_status; new_status := v_row.new_status; payroll_flag := v_row.payroll_flag;
      EXCEPTION
        WHEN SQLSTATE '22023' THEN
          -- This specific employee/date pair overrides an existing
          -- automatic decision and the shared batch reason (if any)
          -- was blank -- reject only this row and keep going, so one
          -- automatic-sourced row never aborts every ordinary manual
          -- row in the same batch. old_status/new_status/payroll_flag
          -- are left NULL for a rejected row -- the caller already
          -- knows which employee/date it is and can re-query if it
          -- needs the pre-rejection status.
          employee_id := v_employee_id; attendance_date := v_date;
          outcome := 'rejected_reason_required'; old_status := NULL; new_status := NULL; payroll_flag := NULL;
      END;
      RETURN NEXT;
      v_date := v_date + 1;
    END LOOP;
  END LOOP;
END;
$$;
