-- ============================================================
-- MIGRATION: get_payroll_attendance_counts() scope correction
-- Date: 2026-09-01 (follow-up to 20260901000000, same day)
-- ============================================================
--
-- WHY THIS EXISTS
-- -----------------------------------------------------------
-- 20260901000000_payroll_attendance_aggregate_rpc.sql restricted the RPC
-- to `e.tenant_id = v_tenant_id` for EVERY caller, including super admin.
-- That was wrong: it does not match this app's actual, pre-existing
-- super-admin semantics.
--
-- PROVEN from source, not assumed:
--   - `employees` SELECT RLS (20260817000001:188-199) and `payroll` SELECT
--     RLS (20260817000002:31-42) both read:
--       is_super_admin() OR (tenant_id = get_current_tenant_id() AND ...)
--     `is_super_admin()` is OR'd at the TOP level -- it bypasses the
--     tenant_id condition entirely, not just the region check.
--   - `Payroll.tsx`'s own current/future employee query (fetchData(),
--     the `employeesQuery` built from `employees`) and historical payroll
--     query add NO tenant filter of their own for any caller, and their
--     ONLY region filter is explicitly skipped for a super admin
--     (`if (!userProfile?.is_super_admin && userProfile?.region_id) {...}`,
--     both branches). So today, a super admin viewing Payroll already
--     relies entirely on this RLS bypass and can see employees/payroll
--     rows from every tenant, not just their own.
--
-- This means the ORIGINAL RPC's `e.tenant_id = v_tenant_id` check could
-- silently drop a legitimately-authorized (per existing RLS/UI semantics)
-- cross-tenant employee id from the result -- and the frontend's
-- `calculatePayroll()` treats a missing map entry as
-- `absentDays: 0, lateDays: 0` (`inputs.attendance?.absentDays || 0`),
-- not as an error. That reintroduces the exact silently-understated-
-- payroll risk this whole RPC exists to close, this time for super admin
-- instead of Accountant.
--
-- FIX (two parts):
--
-- 1. SCOPE: super admin's authorized-employee check no longer requires
--    `e.tenant_id = v_tenant_id` -- it matches the SAME bypass
--    `employees`/`payroll` RLS already grants (is_super_admin() sees any
--    tenant). Every other caller (business admin included) is UNCHANGED:
--    still `e.tenant_id = v_tenant_id AND region_allowed(e.region_id)` --
--    business admin is NOT is_super_admin() and gets no tenant bypass in
--    the RLS this mirrors, only the region bypass region_allowed() itself
--    already grants business admins.
--
-- 2. COMPLETENESS: this function now counts how many of the (deduplicated)
--    requested employee ids are actually authorized, and RAISEs if that
--    count doesn't match the number requested -- instead of silently
--    returning a partial result. A tampered, mis-scoped, or genuinely
--    unauthorized id in the batch fails the WHOLE call, exactly like
--    approve_payroll_run()'s own requested-vs-updated all-or-nothing
--    check (20260831010000). The caller (Payroll.tsx) already treats ANY
--    RPC error as `attendanceCountsUnavailable` and fails closed (blocking
--    banner, Process Payroll disabled) -- no frontend change was needed
--    for this half of the fix, only the RPC's own contract.
--
-- The attendance JOIN itself is also corrected: it was
-- `att.tenant_id = v_tenant_id`, which is wrong for a super-admin-
-- authorized employee from a DIFFERENT tenant (their attendance rows
-- belong to THEIR OWN tenant, not the caller's). Changed to
-- `att.tenant_id = e.tenant_id` -- the employee's own tenant -- which is
-- exactly equivalent to `att.tenant_id = v_tenant_id` for every
-- non-super-admin caller (already tenant-scoped by the authorization
-- check above) and correct for a cross-tenant super-admin lookup too.
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
  v_requested_count INTEGER;
  v_authorized_count INTEGER;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT p.tenant_id, p.role_level, p.is_super_admin, p.is_active, p.deleted_at
    INTO v_tenant_id, v_role_level, v_is_super_admin, v_is_active, v_deleted_at
  FROM public.profiles p
  WHERE p.id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- SECURITY (2026-09-08 production preflight): reject an inactive/
  -- deleted caller before considering super-admin/role_level/permission
  -- authority -- this function previously had no such check at all (raw
  -- v_is_super_admin/v_role_level column reads, existence-only check).
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled';
  END IF;

  -- AUTHORIZATION RULE: unchanged from 20260901000000 -- identical shape
  -- to `payroll` table's own SELECT RLS.
  IF NOT (v_is_super_admin OR v_role_level IS NOT NULL OR has_permission('payroll.view')) THEN
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

  v_employee_ids := ARRAY(SELECT DISTINCT t.id FROM unnest(p_employee_ids) AS t(id));
  v_requested_count := array_length(v_employee_ids, 1);

  -- SCOPE: super admin -- any tenant (matches employees/payroll RLS's own
  -- is_super_admin() bypass). Every other caller (business admin
  -- included) -- own tenant + region_allowed() (region_allowed() itself
  -- already exempts business admin from the region check).
  SELECT COUNT(*) INTO v_authorized_count
  FROM public.employees e
  WHERE e.id = ANY(v_employee_ids)
    AND (
      v_is_super_admin
      OR (e.tenant_id = v_tenant_id AND region_allowed(e.region_id))
    );

  -- COMPLETENESS: all-or-nothing. A requested id that isn't authorized
  -- (wrong tenant for a non-super-admin, wrong region, or doesn't exist at
  -- all) fails the WHOLE call rather than silently vanishing from the
  -- result -- the caller must never be able to read "missing row" as
  -- "zero attendance".
  IF v_authorized_count <> v_requested_count THEN
    RAISE EXCEPTION 'One or more supplied employees are outside your authorized scope';
  END IF;

  RETURN QUERY
  SELECT
    e.id AS employee_id,
    COUNT(*) FILTER (WHERE att.status = 'A')::INTEGER AS absent_days,
    COUNT(*) FILTER (WHERE att.status = 'L')::INTEGER AS late_days
  FROM public.employees e
  LEFT JOIN public.attendance att
    ON att.employee_id = e.id
    AND att.tenant_id = e.tenant_id
    AND att.date BETWEEN v_month_start AND v_month_end
  WHERE e.id = ANY(v_employee_ids)
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
-- REVOKE/GRANT pairs.
--
-- DEPENDENCIES: requires 20260901000000 (creates the function this
-- replaces) and 20260817000000 (has_permission, region_allowed).
--
-- PREFLIGHT: none -- pure function body replacement, no schema change.
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS:
--   - Non-super-admin callers (Accountant, business Admin, legacy
--     accounts): NONE. The authorization/scope check for them is
--     unchanged (`e.tenant_id = v_tenant_id AND region_allowed(...)`);
--     they could never have supplied a cross-tenant id in the first place
--     (Payroll.tsx only ever loads their own tenant's roster), so the new
--     all-or-nothing check is a no-op for them in practice.
--   - Super admin: WIDENS what the RPC will successfully return counts
--     for (cross-tenant employee ids, matching what Payroll.tsx already
--     shows them via employees/payroll RLS) -- this is a correction, not
--     a new capability: the super admin could already SEE these
--     employees/payroll rows before this RPC existed; this migration only
--     stops that existing visibility from silently degrading into
--     zeroed-out attendance deductions.
--
-- VERIFICATION SQL (run immediately after applying, as documented in
-- 20260901000000's own footer, plus):
--   -- As a super-admin session, call with an employee_id from a
--   -- DIFFERENT tenant than the caller's own profile.tenant_id -- expect
--   -- SUCCESS, with a row returned for that employee's real attendance
--   -- counts, not silence.
--   -- As an Accountant (non-super-admin) session, call with one
--   -- authorized id and one id from a different tenant mixed in the same
--   -- array -- expect the WHOLE call to RAISE
--   -- ('One or more supplied employees are outside your authorized
--   -- scope'), not a partial 1-row result.
--
-- ROLLBACK SQL: re-apply 20260901000000's CREATE OR REPLACE body verbatim
-- (not recommended -- reintroduces the super-admin scope bug this fixes).
-- ============================================================
