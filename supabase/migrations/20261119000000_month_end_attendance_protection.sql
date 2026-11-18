-- ============================================================
-- MIGRATION: Phase 2 completion, Task 2 -- Month-End Attendance
-- Protection.
-- Date: 2026-11-19
-- ============================================================
--
-- AUDIT FIRST (per instruction -- reuse existing protections, add only
-- what's genuinely missing): read attendance_write_one, attendance_
-- correct, approve_payroll_processing_request, Payroll.tsx, and the
-- existing attendance_reconciliation_flags mechanism before writing
-- anything. Findings:
--   - "A Nov 30 overnight shift can receive Dec 1 checkout evidence":
--     already true, unconditionally -- attendance_process_import_batch's
--     p_date_from - 1 widening (PR #59) is plain DATE arithmetic with no
--     month/year special-casing, so it already rolls over a month
--     boundary exactly like any other day boundary. Covered by a new
--     integration test below, not a code change.
--   - "Changing the visible month does not finalize attendance":
--     already true -- Payroll.tsx's selectedMonth is read-only state;
--     every attendance-affecting RPC call in that file fires only from
--     an explicit button handler, never from a month-selection effect.
--     No code change; nothing to add.
--   - "Incomplete coverage remains Pending" / "only confirmed complete
--     coverage permits automatic Absent": already true and exhaustively
--     covered by the existing SQL/TS parity suite -- not retested here.
--   - "Previously processed and approved payroll is not silently
--     changed": already true -- approve_payroll_processing_request
--     re-derives and compares a full financial-snapshot fingerprint
--     (including attendance-based deductions) before allowing approval,
--     and attendance_write_one refuses every AUTOMATIC write once that
--     month's payroll is approved.
--   - "Any necessary human confirmation is at period level, not
--     employee by employee": already true -- payroll_processing_requests/
--     approve_payroll_processing_request operate on one month for the
--     whole request, never per employee.
--   - "Every authorized finalization is audited": already true --
--     approve_payroll_processing_request writes to audit_logs.
--
-- GENUINE GAPS FOUND, fixed below (both reuse the existing
-- attendance_reconciliation_flags mechanism -- no second, parallel
-- month-close system introduced):
--
-- PART A -- "late evidence for protected periods is retained for
-- review" was NOT true for the specific case of AUTOMATIC evidence.
-- attendance_write_one's 'written' branch already raises an
-- attendance_reconciliation_flags row (reason 'payroll_approved') any
-- time a write touches a month with approved payroll -- but its EARLIER
-- 'skipped_payroll_approved' branch (the one that fires when fresh
-- fingerprint evidence arrives for an already-approved month and is
-- correctly refused) returns immediately with NO flag at all. The
-- refusal itself is correct and unchanged; what was missing is any
-- durable record that it happened, so late evidence for an approved
-- period was silently dropped on the floor the moment that RPC call's
-- response was discarded, with nothing for a human to ever go review.
-- FIX: the exact same, already-established INSERT -- same table, same
-- reason value, no new flagged_reason, no dedup/uniqueness logic added
-- (matching the existing 'written' branch's own append-only behavior:
-- every touch gets its own flag row, not a single deduplicated
-- indicator -- this migration does not change that design).
--
-- PART B -- "a month-end summary shows unresolved Pending records" had
-- no equivalent anywhere (get_payroll_attendance_counts only ever
-- returns Absent/Late counts for payroll deduction math, for an
-- explicit employee list the caller already has, never a period-level
-- Pending/unresolved view). New, narrow, read-only RPC:
-- attendance_month_end_summary(p_month). Reuses the exact same
-- authorization bar as get_payroll_attendance_counts (payroll.view),
-- the same tenant/region scoping as every other payroll-period RPC,
-- and roster_resolve_schedule (not a reimplementation) to determine
-- which past dates in the month were actually scheduled to work at
-- all -- an Off/Unassigned date is never counted as "unresolved".
-- ============================================================

-- ============================================================
-- PART A: attendance_write_one -- flag late/refused automatic evidence
-- against an approved-payroll month, same mechanism the 'written'
-- branch already uses. Same signature, so CREATE OR REPLACE alone is
-- sufficient (no DROP needed).
-- ============================================================
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
    RAISE EXCEPTION 'attendance_write_one: p_new_status must be one of P/A/L, got %', p_new_status;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_employee_id::text || '|' || p_date::text));

  SELECT status, calculation_basis, source INTO v_old_status, v_old_basis, v_old_source
  FROM attendance WHERE employee_id = p_employee_id AND date = p_date;

  IF p_source = 'automatic' AND v_old_source = 'manual' THEN
    RETURN QUERY SELECT 'skipped_manual_protected'::TEXT, v_old_status, v_old_status, NULL::TEXT;
    RETURN;
  END IF;

  v_month := to_char(p_date, 'YYYY-MM');
  SELECT EXISTS(SELECT 1 FROM payroll WHERE employee_id = p_employee_id AND month = v_month),
         EXISTS(SELECT 1 FROM payroll WHERE employee_id = p_employee_id AND month = v_month AND approval_status = 'approved')
    INTO v_payroll_exists, v_payroll_approved;

  IF p_source = 'automatic' AND v_payroll_approved THEN
    -- Month-end protection (new): this refusal is correct and
    -- unchanged, but it must not be the end of the story -- fresh
    -- evidence arrived for a month that's already closed out, and a
    -- human needs the chance to see that and decide whether it matters.
    -- Reuses the EXACT same mechanism the 'written' branch below
    -- already relies on for the same flagged_reason.
    INSERT INTO attendance_reconciliation_flags (tenant_id, employee_id, attendance_date, flagged_reason)
    VALUES (p_tenant_id, p_employee_id, p_date, 'payroll_approved');

    RETURN QUERY SELECT 'skipped_payroll_approved'::TEXT, v_old_status, v_old_status, 'approved'::TEXT;
    RETURN;
  END IF;

  IF v_old_status = p_new_status AND v_old_basis IS NOT DISTINCT FROM p_new_basis AND v_old_source = p_source THEN
    RETURN QUERY SELECT 'skipped_no_change'::TEXT, v_old_status, v_old_status, NULL::TEXT;
    RETURN;
  END IF;

  INSERT INTO attendance (tenant_id, employee_id, date, status, calculation_basis, source)
  VALUES (p_tenant_id, p_employee_id, p_date, p_new_status, p_new_basis, p_source)
  ON CONFLICT (employee_id, date) DO UPDATE
    SET status = EXCLUDED.status, calculation_basis = EXCLUDED.calculation_basis, source = EXCLUDED.source;

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

-- ============================================================
-- PART B: attendance_month_end_summary -- period-level, read-only.
-- Never writes anything; purely informational for a human deciding
-- whether a month is actually ready to close out.
-- ============================================================
CREATE OR REPLACE FUNCTION attendance_month_end_summary(p_month TEXT)
RETURNS TABLE (
  scheduled_employee_count INTEGER,
  present_days INTEGER,
  late_days INTEGER,
  absent_days INTEGER,
  pending_days INTEGER,
  employees_with_pending_count INTEGER,
  open_reconciliation_flags INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_role_level INTEGER; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_month_start DATE; v_month_end DATE; v_last_relevant_date DATE;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT tenant_id, role_level, is_super_admin, is_active INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active
  FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  -- Same authorization bar as get_payroll_attendance_counts (this is
  -- the same class of payroll-period concern) -- no new permission key.
  IF NOT (
    COALESCE(v_is_super_admin, false)
    OR COALESCE(v_role_level <= 2, false)
    OR COALESCE(has_permission('payroll.view'), false)
  ) THEN
    RAISE EXCEPTION 'You do not have permission to view the month-end attendance summary' USING ERRCODE = '42501';
  END IF;

  IF p_month IS NULL OR p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Month must be in YYYY-MM format' USING ERRCODE = '22023';
  END IF;

  v_month_start := to_date(p_month || '-01', 'YYYY-MM-DD');
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 day')::date;
  -- Never counts a future date as "unresolved Pending" -- a date that
  -- simply hasn't happened yet is not a gap.
  v_last_relevant_date := LEAST(v_month_end, CURRENT_DATE);

  RETURN QUERY
  WITH scope AS (
    SELECT e.id AS employee_id
    FROM employees e
    WHERE e.status = 'Active' AND e.is_deleted = false
      AND (v_is_super_admin OR (e.tenant_id = v_tenant_id AND region_allowed(e.region_id)))
  ),
  written AS (
    SELECT a.employee_id, a.status
    FROM attendance a
    JOIN scope s ON s.employee_id = a.employee_id
    WHERE a.date BETWEEN v_month_start AND v_month_end
  ),
  scheduled_days AS (
    -- One row per (employee, date) in [month_start, last_relevant_date]
    -- actually resolved to a working shift (day/night) -- an Off or
    -- Unassigned date is never "unresolved", by the same rule the
    -- engine itself already applies.
    SELECT s.employee_id, d.shift_date
    FROM scope s
    CROSS JOIN LATERAL generate_series(v_month_start, v_last_relevant_date, INTERVAL '1 day') AS d(shift_date)
    WHERE roster_resolve_schedule(s.employee_id, d.shift_date::date) IN ('day', 'night')
  ),
  pending AS (
    SELECT sd.employee_id, sd.shift_date
    FROM scheduled_days sd
    LEFT JOIN attendance a ON a.employee_id = sd.employee_id AND a.date = sd.shift_date::date
    WHERE a.id IS NULL
  )
  SELECT
    (SELECT count(*) FROM scope)::INTEGER,
    (SELECT count(*) FROM written WHERE status = 'P')::INTEGER,
    (SELECT count(*) FROM written WHERE status = 'L')::INTEGER,
    (SELECT count(*) FROM written WHERE status = 'A')::INTEGER,
    (SELECT count(*) FROM pending)::INTEGER,
    (SELECT count(DISTINCT employee_id) FROM pending)::INTEGER,
    (SELECT count(*) FROM attendance_reconciliation_flags f
       JOIN scope s ON s.employee_id = f.employee_id
       WHERE f.resolved_at IS NULL AND f.attendance_date BETWEEN v_month_start AND v_month_end)::INTEGER;
END;
$$;

REVOKE ALL ON FUNCTION attendance_month_end_summary(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_month_end_summary(TEXT) TO authenticated;
