-- ============================================================
-- MIGRATION: Payroll-safe attendance aggregate RPC
-- Date: 2026-09-01
-- ============================================================
--
-- WHY THIS EXISTS (design approved for PR #36 -- Option A only;
-- Option B, server-side recomputation inside process_payroll_batch(),
-- is explicitly deferred, see Finding A24 added to AUDIT_REPORT.md)
-- -----------------------------------------------------------
-- Payroll.tsx's live calculation for the CURRENT/FUTURE month reads
-- `attendance` directly client-side (`.from('attendance').select(...)`).
-- Accountant is intentionally authorized to view/process Payroll
-- (payroll.view/payroll.process seeded in role_permissions) but is
-- intentionally NOT granted attendance.view (no such row exists for
-- 'accountant' anywhere in the seed matrix). attendance's own SELECT RLS
-- (20260817000002, "Attendance: view within tenant+region, action or
-- legacy permitted") gates on
-- `(current_user_role_level() IS NOT NULL OR has_permission('attendance.view'))`
-- -- Accountant satisfies neither branch, so RLS silently returns ZERO
-- rows (no error), and the live calculation treats missing attendance as
-- zero absent/late days -- an Accountant could persist a real month's
-- payroll with genuinely understated deductions with no error or warning
-- anywhere in the UI.
--
-- This migration does NOT touch attendance's RLS and does NOT grant
-- Accountant attendance.view (both explicitly rejected approaches -- see
-- the design report this migration implements). Instead it adds one
-- narrow SECURITY DEFINER RPC that returns ONLY the two integer day-counts
-- Payroll's calculation actually consumes (verified against
-- src/utils/payrollCalculations.ts: calculateLivePayroll() reads only
-- inputs.attendance?.absentDays / inputs.attendance?.lateDays, nothing
-- else -- no dates, times, notes, or raw status rows), gated by the same
-- permission (payroll.view) that already authorizes reading the `payroll`
-- table itself, not by any reporting or attendance permission.
--
-- NOT REUSING get_report_attendance_summary() (20260817000006): that
-- function returns raw per-day {employee_id, status} rows (broader than
-- necessary for this use) and is gated by reports.operational.view -- a
-- reporting-visibility permission, not a payroll-calculation-input
-- permission. Hanging Payroll's live calculation off a Reports permission
-- would be a fragile, semantically wrong dependency (an Accountant who
-- somehow lost reports.operational.view but kept payroll.view would break
-- Payroll for a Reports-unrelated reason). This RPC is authorized purely
-- by payroll.view/legacy role_level, matching `payroll` table RLS exactly.
--
-- SEARCH_PATH: this migration was written after 20260831010000 (production
-- failure: a SECURITY DEFINER function with SET search_path = '' calling
-- helper functions that did an unqualified `FROM profiles` under that same
-- empty search_path raised `relation "profiles" does not exist`). This
-- function instead follows the SAME pattern already proven safe and in
-- production use by process_payroll_batch() and get_report_attendance_summary()
-- (and every helper in 20260817000000): `SET search_path = public, pg_temp`
-- (non-empty), plus every table relation explicitly schema-qualified
-- (public.profiles/public.employees/public.attendance) as defense in
-- depth. has_permission()/is_super_admin()/region_allowed() are all
-- called with this same non-empty search_path already in effect, and each
-- of those helpers ALSO independently declares its own
-- `SET search_path = public, pg_temp` (20260817000000000/20260817000007),
-- so they are safe to call from here regardless.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_payroll_attendance_counts(
  p_employee_ids UUID[],
  p_month TEXT
)
RETURNS TABLE (
  employee_id UUID,
  absent_days INTEGER,
  late_days INTEGER
)
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
  v_month_start DATE;
  v_month_end DATE;
  v_employee_ids UUID[];
BEGIN
  -- Fail closed: no authenticated caller at all.
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Caller's own tenant/role/super-admin, read directly and
  -- schema-qualified -- never trust a tenant/role/region asserted by the
  -- client, this function bypasses RLS entirely (SECURITY DEFINER) so its
  -- own body is the complete authorization boundary.
  SELECT p.tenant_id, p.role_level, p.is_super_admin, p.is_active, p.deleted_at
    INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active, v_deleted_at
  FROM public.profiles p
  WHERE p.id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- SECURITY (2026-09-08 production preflight): reject an inactive/
  -- deleted caller before considering super-admin/role_level/permission
  -- authority -- this function (superseded by 20260901010000's scope-fix
  -- version, which carries the same fix) previously had no such check at
  -- all.
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled';
  END IF;

  -- AUTHORIZATION RULE (2026-09-08 legacy-scope correction): was
  -- `v_role_level IS NOT NULL`, which admits EVERY legacy account
  -- regardless of level -- the same blanket-bypass class already closed
  -- for the `employees`/`attendance`/`payroll` tables themselves in
  -- 20260908000000 (which uses `current_user_role_level() <= 2` for
  -- payroll SELECT). This RPC backs the exact same live payroll preview
  -- as that table's SELECT policy, so it must use the same threshold --
  -- legacy role_level 3 (Supervisor)/4 (Staff) never had Payroll nav
  -- access and must not be able to call this RPC either. Functional
  -- Accountant access is unaffected -- unchanged, still via
  -- has_permission('payroll.view') (has_permission() itself already
  -- returns true for is_business_admin()). Deliberately payroll.view, not
  -- payroll.process: this data backs the live PREVIEW shown while simply
  -- viewing the Payroll page, before any processing action is taken.
  --
  -- SECURITY (release-blocking, found during PR #36 audit): `v_role_level`
  -- is NULL for every functional-role account (by design). A bare
  -- `v_role_level <= 2` comparison against NULL evaluates to SQL NULL, not
  -- false, which makes the whole `IF NOT (...)` condition NULL for a
  -- functional-role caller who also lacks has_permission('payroll.view')
  -- -- and PL/pgSQL treats a NULL IF condition the same as false, silently
  -- skipping the RAISE EXCEPTION below instead of rejecting the caller.
  -- Empirically reproduced against this exact function body: an
  -- Operations Manager session (role_level NULL, payroll.view NOT
  -- granted) received real attendance day-counts instead of an error.
  -- Every operand is now wrapped in COALESCE(..., false) so the whole
  -- expression is always a real boolean, closing that bypass without
  -- changing behavior for any legacy account (whose role_level is never
  -- NULL) or any functional account that legitimately holds
  -- payroll.view/is a super admin.
  IF NOT (
    COALESCE(v_is_super_admin, false)
    OR COALESCE(v_role_level <= 2, false)
    OR COALESCE(has_permission('payroll.view'), false)
  ) THEN
    RAISE EXCEPTION 'You do not have permission to view payroll attendance totals';
  END IF;

  IF p_month IS NULL OR p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Month must be in YYYY-MM format';
  END IF;

  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No employee ids supplied';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(p_employee_ids) AS t(id) WHERE t.id IS NULL) THEN
    RAISE EXCEPTION 'Employee id list contains a null value';
  END IF;

  v_month_start := to_date(p_month || '-01', 'YYYY-MM-DD');
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 day')::date;

  -- Deduplicate defensively -- this function's correctness never depends
  -- on the client having already deduplicated its own input array.
  v_employee_ids := ARRAY(SELECT DISTINCT t.id FROM unnest(p_employee_ids) AS t(id));

  -- One row per requested id that is BOTH in the caller's own tenant AND
  -- region-allowed (region_allowed() itself already covers the
  -- super-admin/business-admin "sees everything in tenant" bypass) -- an
  -- id that fails either check is simply absent from the result set, never
  -- an error and never a leaked row for another tenant/region. LEFT JOIN
  -- against attendance guarantees a deterministic {absent_days: 0,
  -- late_days: 0} row for every authorized employee with no attendance
  -- rows this month, rather than the caller having to interpret a missing
  -- row as ambiguous.
  RETURN QUERY
  SELECT
    e.id AS employee_id,
    COUNT(*) FILTER (WHERE att.status = 'A')::INTEGER AS absent_days,
    COUNT(*) FILTER (WHERE att.status = 'L')::INTEGER AS late_days
  FROM public.employees e
  LEFT JOIN public.attendance att
    ON att.employee_id = e.id
    AND att.tenant_id = v_tenant_id
    AND att.date BETWEEN v_month_start AND v_month_end
  WHERE e.id = ANY(v_employee_ids)
    AND e.tenant_id = v_tenant_id
    AND region_allowed(e.region_id)
  GROUP BY e.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_payroll_attendance_counts(UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payroll_attendance_counts(UUID[], TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_payroll_attendance_counts(UUID[], TEXT) TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- CREATE OR REPLACE FUNCTION, same
-- REVOKE/GRANT pairs throughout.
--
-- DEPENDENCIES: requires 20260817000000 (has_permission, region_allowed,
-- is_business_admin, is_super_admin) and the profiles/employees/attendance
-- tables.
--
-- PREFLIGHT: none needed -- pure addition, no existing table/column/RLS
-- policy is modified. attendance's own RLS is completely untouched.
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS: none for any table's RLS or any
-- existing RPC. The only NEW capability is any caller who already holds
-- payroll.view (or a legacy role_level, or is a super/business admin)
-- gaining a way to read pre-aggregated attendance day-counts for
-- employees they are already authorized to view payroll for -- it grants
-- no new ability to browse raw Attendance records, dates, or any other
-- Attendance column, and no ability to read attendance for an employee
-- outside the caller's own tenant/region.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'get_payroll_attendance_counts';
--   -- expected: 1 row, prosecdef = true
--   SELECT has_function_privilege('anon', 'get_payroll_attendance_counts(uuid[],text)', 'EXECUTE');
--   -- expected: false
--   SELECT has_function_privilege('authenticated', 'get_payroll_attendance_counts(uuid[],text)', 'EXECUTE');
--   -- expected: true
--   -- Functional check: as an Accountant session (role_level NULL,
--   -- payroll.view seeded, attendance.view NOT seeded), call this
--   -- function with a valid p_employee_ids/p_month -- confirm it
--   -- SUCCEEDS and returns only employee_id/absent_days/late_days, no
--   -- raw attendance rows. Separately confirm the SAME session's direct
--   -- `select * from attendance` still returns ZERO rows (RLS unchanged).
--   -- As an Operations Manager session (attendance.view seeded, NO
--   -- payroll.view), call this function -- confirm it RAISES.
--   -- Tamper test: call with an employee_id belonging to a different
--   -- tenant or region than the caller -- confirm that id is simply
--   -- absent from the returned rows, not an error and not a leaked row.
--
-- ROLLBACK SQL:
--   DROP FUNCTION IF EXISTS public.get_payroll_attendance_counts(UUID[], TEXT);
-- ============================================================
