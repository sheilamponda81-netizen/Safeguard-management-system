-- ============================================================
-- MIGRATION: Close the blanket legacy-role bypass on employees/attendance/payroll
-- Date: 2026-09-08
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- -----------------------------------------------------------
-- Empirically confirmed against a local Postgres instance running the full
-- current migration chain (not inferred from reading policy text alone):
--
--   employees (SELECT/INSERT/UPDATE), attendance (SELECT), and payroll
--   (SELECT) all used `current_user_role_level() IS NOT NULL OR
--   has_permission(...)`. `IS NOT NULL` is true for EVERY legacy account
--   (role_level 1, 2, 3, OR 4) -- it does not check WHICH level, only
--   whether the account is legacy at all. This is the exact same class of
--   bug already found and fixed for Terminal Dues in 20260905000000 (there
--   it was `current_user_role_level() <= 2`, which at least picked a
--   threshold; here it was `IS NOT NULL`, which picks none).
--
-- Confirmed exploitable, empirically:
--   - Legacy Supervisor (role_level=3) and Legacy Staff (role_level=4) --
--     NEITHER of whom has Employees in their nav (`roleMenuItems`/
--     `rolePages` only list "employees" for levels 1 and 2) -- could
--     directly INSERT and UPDATE arbitrary `employees` rows via a raw API
--     call, including salary/position/status fields.
--   - Legacy Staff (role_level=4) could SELECT the entire `attendance`
--     table despite having no Attendance nav access at all.
--   - Legacy Staff (role_level=4) could SELECT every `payroll` row in
--     their region -- not just their own -- confirmed by directly querying
--     a DIFFERENT employee's payroll row and getting it back. Payslips.tsx
--     itself already fetches the whole month's payroll unfiltered by
--     employee and only narrows to "my region" CLIENT-SIDE, so this was
--     visible in the raw network response already, not just reachable via
--     a crafted request.
--
-- THE FIX -- smallest safe change, no redesign
-- -----------------------------------------------------------
-- Replace the blanket `IS NOT NULL` with the SAME real threshold each
-- table's own existing, correctly-scoped policies already use elsewhere,
-- rather than inventing a new rule:
--
--   employees:  `<= 2`  -- matches `roleMenuItems`/`rolePages`: levels 1
--               (legacy Admin) and 2 (legacy Manager) are the only legacy
--               levels with Employees nav access today. Level 1 is also
--               already covered independently via has_permission()'s own
--               is_business_admin() shortcut (current_user_role_level() =
--               1) -- the `<= 2` bypass is what actually preserves level
--               2's access, which has no matching role_permissions row
--               (legacy accounts' free-text `role` values, e.g. 'manager',
--               are never seeded in role_permissions -- that table only
--               has rows for the 4 new functional-role keys).
--
--   attendance (SELECT only -- INSERT/UPDATE on this table ALREADY use
--               `<= 3` correctly, confirmed empirically, untouched here):
--               `<= 3`, so SELECT matches the write policies exactly --
--               levels 1/2/3 (Admin/Manager/Supervisor) can see what they
--               can already write, level 4 (Staff, no Attendance nav at
--               all) cannot.
--
--   payroll (SELECT only -- INSERT/UPDATE/DELETE untouched, out of scope,
--               and must not risk the payroll approval RPC / duplicate-row
--               protections): `<= 2` -- level 1 (Payroll+Payslips nav) and
--               level 2 (Payments nav, and Payments.tsx reads directly
--               from `payroll`) both need this; level 3 never had any
--               payroll/payments/payslips nav item, so excluding it is not
--               a behavior change. Level 4 (Staff, Payslips nav only) is
--               DELIBERATELY excluded -- this is the "temporarily disable
--               Legacy Staff payslip access" decision: `profiles` has no
--               `employee_id` column at all, so there is currently no way
--               to express "only this Staff account's OWN payroll row" in
--               RLS at all. Rather than inventing an unsound substitute
--               (email/name/employee-number matching, or a client-side-
--               only restriction), Staff payroll/payslip access is fully
--               disabled at the database level until a real profile<->
--               employee identity link exists (planned for a later PR).
--               The matching frontend change (removing "payslips" from
--               Staff's nav/route-guard maps) ships in this same commit.
--
-- NOT touched, deliberately: is_current_user_active()/is_super_admin()/
-- tenant_id/region_allowed() checks (unchanged in every policy below),
-- employees DELETE (already super-admin-only, 20260803000000), payroll
-- INSERT/UPDATE/DELETE (out of scope -- process_payroll_batch()/
-- approve_payroll_run() are unaffected, neither reads through these
-- SELECT policies for their own authorization, both are SECURITY DEFINER
-- and self-enforce), every SECURITY DEFINER function's search_path/
-- privilege grants (untouched), employees_general (security_invoker=true
-- -- automatically inherits the corrected employees SELECT policy below,
-- no separate change needed), employees_security (has its own, separate
-- `IS NOT NULL` predicate for Security Personnel access -- NOT part of
-- this migration's scope; it was not empirically tested this pass and
-- touching it now would be outside what was gated).
--
-- A SECOND EMPIRICAL FINDING, discovered while re-testing this fix locally
-- (not assumed from reading policy text): tightening `employees`' own
-- SELECT policy has a real cascading side effect on every OTHER policy
-- that checks a row's region via `EXISTS (SELECT 1 FROM employees e WHERE
-- e.id = <table>.employee_id AND region_allowed(e.region_id))` --
-- Attendance's SELECT/INSERT/UPDATE policies all do exactly this. That
-- inline subquery is plain SQL, not wrapped in a SECURITY DEFINER
-- function, so it is itself subject to the CALLING role's own RLS on
-- `employees` -- meaning a caller who newly fails `employees`' tightened
-- SELECT policy (Legacy Supervisor, role_level=3) also silently fails
-- Attendance's EXISTS check even though Attendance's OWN condition
-- (`current_user_role_level() <= 3`) should still grant them access.
-- Confirmed empirically: after applying only PART 1 below, a Legacy
-- Supervisor's `SELECT * FROM attendance` returned 0 rows and INSERT
-- failed RLS, despite Attendance's own policy being untouched and
-- already correct. (Before PART 1, this worked only because `employees`'
-- old blanket `IS NOT NULL` bypass let role_level=3 read `employees`
-- freely -- the same over-broad access PART 1 exists to close.)
--
-- FIX (PART 2 below): a new SECURITY DEFINER helper,
-- employee_region_id(UUID), resolves an employee's region_id bypassing
-- RLS entirely -- the same trust pattern every other SECURITY DEFINER
-- function in this schema already uses (region_allowed()/
-- get_current_tenant_id()/is_business_admin(), etc. all bypass RLS on the
-- tables they read). Attendance's 3 policies are rewritten to call
-- `region_allowed(employee_region_id(attendance.employee_id))` instead of
-- the inline EXISTS-against-employees subquery -- semantically IDENTICAL
-- (same region_allowed() call against the same employee's region_id), it
-- only removes the dependency on the CALLING role's own employees-table
-- SELECT privilege. INSERT/UPDATE's own `current_user_role_level() <= 3`
-- condition is NOT changed by this -- only the structurally-broken region
-- check underneath it is.
-- ============================================================

-- ============================================================
-- PART 1: employees -- SELECT/INSERT/UPDATE
-- ============================================================

DROP POLICY IF EXISTS "Employees: view within tenant+region, action or legacy permitted" ON employees;
CREATE POLICY "Employees: view within tenant+region, action or legacy permitted" ON employees
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() <= 2 OR has_permission('employees.view'))
    )
  )
);

DROP POLICY IF EXISTS "Employees: create within tenant+region, action or legacy permitted" ON employees;
CREATE POLICY "Employees: create within tenant+region, action or legacy permitted" ON employees
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() <= 2 OR has_permission('employees.create'))
    )
  )
);

DROP POLICY IF EXISTS "Employees: update within tenant+region, action or legacy permitted" ON employees;
CREATE POLICY "Employees: update within tenant+region, action or legacy permitted" ON employees
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() <= 2 OR has_permission('employees.edit'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() <= 2 OR has_permission('employees.edit'))
    )
  )
);

-- ============================================================
-- PART 2: attendance -- SELECT (new threshold) + INSERT/UPDATE
-- (threshold unchanged, but restructured to fix the cascading dependency
-- on `employees`' own SELECT policy -- see header)
-- ============================================================

-- SECURITY DEFINER helper: resolves an employee's region_id bypassing
-- RLS, the same trust pattern every other helper in this schema already
-- uses. Needed because a caller who lawfully passes Attendance's own
-- `current_user_role_level() <= 3` (or `<= 2`/`has_permission` elsewhere)
-- must not ALSO be required to pass `employees`' own, separately-scoped
-- SELECT policy just to resolve a region for a security check -- that
-- coupling is exactly what broke Legacy Supervisor's Attendance access
-- once `employees` SELECT was tightened in PART 1. Does not check
-- tenant_id: neither does the EXISTS-subquery pattern it replaces, since
-- the calling policy's own `tenant_id = get_current_tenant_id()` check on
-- the ATTENDANCE row plus the FK from attendance.employee_id ->
-- employees.id already guarantee the referenced employee is in the same
-- tenant.
CREATE OR REPLACE FUNCTION employee_region_id(p_employee_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_region_id UUID;
BEGIN
  SELECT region_id INTO v_region_id FROM employees WHERE id = p_employee_id;
  RETURN v_region_id;
END;
$$;

REVOKE ALL ON FUNCTION employee_region_id(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION employee_region_id(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION employee_region_id(UUID) TO authenticated;

DROP POLICY IF EXISTS "Attendance: view within tenant+region, action or legacy permitted" ON attendance;
CREATE POLICY "Attendance: view within tenant+region, action or legacy permitted" ON attendance
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(employee_region_id(attendance.employee_id))
      AND (current_user_role_level() <= 3 OR has_permission('attendance.view'))
    )
  )
);

DROP POLICY IF EXISTS "Attendance: create within tenant+region, legacy Supervisor+ or new permission" ON attendance;
CREATE POLICY "Attendance: create within tenant+region, legacy Supervisor+ or new permission" ON attendance
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(employee_region_id(attendance.employee_id))
      AND (current_user_role_level() <= 3 OR has_permission('attendance.create'))
    )
  )
);

DROP POLICY IF EXISTS "Attendance: update within tenant+region, legacy Supervisor+ or new permission" ON attendance;
CREATE POLICY "Attendance: update within tenant+region, legacy Supervisor+ or new permission" ON attendance
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(employee_region_id(attendance.employee_id))
      AND (current_user_role_level() <= 3 OR has_permission('attendance.edit'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(employee_region_id(attendance.employee_id))
      AND (current_user_role_level() <= 3 OR has_permission('attendance.edit'))
    )
  )
);

-- ============================================================
-- PART 3: payroll -- SELECT only (INSERT/UPDATE/DELETE out of scope)
-- ============================================================

DROP POLICY IF EXISTS "Payroll: view within tenant+region, action or legacy permitted" ON payroll;
CREATE POLICY "Payroll: view within tenant+region, action or legacy permitted" ON payroll
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = payroll.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('payroll.view'))
    )
  )
);

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- DROP POLICY IF EXISTS then CREATE
-- POLICY, same names, same tables.
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS:
--   - Legacy Supervisor (3) and Legacy Staff (4): lose direct SELECT/
--     INSERT/UPDATE on `employees` via the legacy bypass. Neither had any
--     Employees nav access, so no legitimate workflow used this path.
--   - Legacy Staff (4) ONLY: loses direct SELECT on `attendance`. No nav
--     access existed for this either.
--   - Legacy Staff (4) ONLY: loses direct SELECT on `payroll` -- this is
--     the intended, documented, TEMPORARY restriction (see header). Their
--     Payslips.tsx page will now receive zero payroll rows; the
--     accompanying frontend change removes the Payslips nav item and
--     route-guard entry for role_level 4 so this isn't a broken/blank
--     page, it's simply no longer reachable.
--   - Every functional role (HR/Accountant/Ops Manager/Admin), true super
--     admin, and Legacy Admin(1)/Manager(2) see NO change at all -- their
--     access was already governed entirely by has_permission()/
--     is_super_admin(), never by the IS NOT NULL branch this migration
--     replaces.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT tablename, policyname, qual FROM pg_policies
--     WHERE tablename IN ('employees','attendance','payroll') AND cmd = 'SELECT'
--     ORDER BY tablename;
--   -- expected: employees and payroll show "<= 2", attendance shows "<= 3";
--   -- none show "IS NOT NULL" as the legacy-bypass condition any more.
--
--   SELECT tablename, policyname, qual FROM pg_policies
--     WHERE tablename = 'employees' AND cmd IN ('INSERT','UPDATE');
--   -- expected: both show "<= 2", not "IS NOT NULL".
--
-- ROLLBACK SQL:
--   -- Re-apply 20260817000001's original 3 employees policies and
--   -- 20260817000002's original attendance/payroll SELECT policies
--   -- (all reproduced in this file's own history, substituting
--   -- `IS NOT NULL` back in for `<= 2`/`<= 3`).
-- ============================================================
