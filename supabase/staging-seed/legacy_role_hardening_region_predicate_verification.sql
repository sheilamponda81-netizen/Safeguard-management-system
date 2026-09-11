-- ============================================================
-- READ-ONLY VERIFICATION: employees/attendance/payroll legacy-role
-- hardening (Step 27, 20260908000000) -- region-predicate redesign
-- (release-blocking fix, PR #36 pre-production review)
-- ============================================================
-- Every query below is SELECT-only except the BEGIN/ROLLBACK simulation
-- blocks, which roll back unconditionally -- nothing here writes
-- persistent data. Safe to run on staging or production at any time.
--
-- BACKGROUND: Step 27 tightens `employees` SELECT from a blanket legacy
-- `current_user_role_level() IS NOT NULL` bypass to `<= 2`. Because
-- Attendance's and payroll's own region checks originally used an inline
-- `EXISTS (SELECT 1 FROM employees e WHERE ... region_allowed(e.region_id))`
-- subquery -- subject to the CALLING role's own RLS on `employees`, not a
-- SECURITY DEFINER bypass -- this silently broke Legacy Supervisor's
-- Attendance access as a side effect. The first fix draft closed this
-- with a SECURITY DEFINER helper, `employee_region_id(UUID) RETURNS UUID`,
-- but that helper was itself found to be release-blocking: `GRANT EXECUTE
-- ... TO authenticated` makes any such function directly callable via
-- PostgREST (`/rest/v1/rpc/employee_region_id`), and returning a raw
-- region_id let any authenticated same-tenant caller learn an arbitrary
-- same-tenant employee's actual region -- including one OUTSIDE the
-- caller's own permitted region, a genuine (if narrow) same-tenant
-- cross-region metadata disclosure introduced solely to fix an internal
-- RLS dependency. Replaced with `employee_region_allowed(UUID) RETURNS
-- BOOLEAN`, which never returns region_id or any other column, only a
-- true/false answer scoped to the CURRENT caller's own tenant+region.
-- A second real regression was found in the same review:
-- `employee_deductions` (20260817000002, unrelated to Step 27's original
-- scope) has the identical unwrapped EXISTS-against-employees pattern in
-- all 3 of its own policies, and is fixed the same way, in the same
-- migration. Its INSERT/UPDATE legacy gates (`<= 3`) are left completely
-- unchanged. Its SELECT gate is NOT left unchanged -- a THIRD finding,
-- from a later pre-production review pass: the original blanket
-- `current_user_role_level() IS NOT NULL` SELECT gate was justified by
-- Payslips.tsx being reachable by role_level 4 (Legacy Staff), but this
-- same migration's own accompanying frontend change removes Payslips
-- access for role_level 4 entirely (no profiles<->employees identity
-- link to scope a self-only policy -- the same reason Staff payroll
-- SELECT is disabled at the database level). Audited every current
-- frontend read path for employee_deductions (Attendance.tsx,
-- Payroll.tsx, Payments.tsx, Payslips.tsx, Reports.tsx) against
-- rolePages/roleMenuItems as they exist in this same commit: role_level
-- 4's reachable page set (`["dashboard", "user-manual"]`) contains NONE
-- of the 5, so no legitimate role_level 4 workflow remains. SELECT is
-- tightened from `IS NOT NULL` to `<= 3` -- the same threshold already
-- used by Attendance's own SELECT/INSERT/UPDATE and by this table's own
-- INSERT/UPDATE -- so role_level 1/2/3 keep this access unchanged (all 3
-- still have at least one reachable page that reads this table) and only
-- role_level 4 loses it, with no frontend path lost since none remained.
-- The `has_permission('attendance.view')`/`has_permission('payslips.view')`
-- functional branches (Operations Manager / Accountant respectively) are
-- untouched.
-- ============================================================

-- 1. Confirm employee_region_id (the rejected, info-revealing design)
--    does not exist under any signature.
SELECT COUNT(*) AS employee_region_id_must_be_zero
FROM pg_proc WHERE proname = 'employee_region_id';

-- 2. Confirm employee_region_allowed exists, returns boolean, is
--    SECURITY DEFINER, has search_path locked down, and has the expected
--    ACLs (authenticated only -- never PUBLIC or anon).
SELECT p.proname, p.prorettype::regtype AS return_type,
       p.prosecdef AS is_security_definer,
       (SELECT array_agg(cfg) FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%') AS search_path,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p WHERE p.oid = 'employee_region_allowed(uuid)'::regprocedure;
-- expected: return_type=boolean, is_security_definer=true,
-- search_path={search_path=public,pg_temp}, public_can_execute=false,
-- anon_can_execute=false, authenticated_can_execute=true.

-- 3. Confirm employees/attendance/payroll/employee_deductions's legacy
--    thresholds are the real per-table values, not the old blanket
--    IS NOT NULL bypass.
SELECT tablename, policyname, cmd, qual
FROM pg_policies
WHERE tablename IN ('employees','attendance','payroll','employee_deductions') AND cmd = 'SELECT';
-- expected: employees and payroll show "<= 2", attendance and
-- employee_deductions show "<= 3"; none show "IS NOT NULL" as the
-- legacy-bypass condition any more.

-- 4. Confirm every policy that used to couple to employees' own RLS now
--    calls employee_region_allowed() instead of an inline EXISTS
--    subquery against employees.
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename IN ('attendance', 'payroll', 'employee_deductions')
  AND (qual LIKE '%employee_region_allowed%' OR with_check LIKE '%employee_region_allowed%');
-- expected: attendance (SELECT/INSERT/UPDATE, 3 rows), payroll (SELECT
-- only, 1 row), employee_deductions (SELECT/INSERT/UPDATE, 3 rows) -- 7
-- rows total. payroll's own INSERT/UPDATE policies (out of scope, never
-- touched) correctly do NOT appear here -- they still use the original
-- EXISTS-against-employees form, which is fine since neither is gated by
-- a legacy role_level threshold this migration tightens.

SELECT tablename, policyname, cmd
FROM pg_policies
WHERE tablename IN ('attendance', 'payroll', 'employee_deductions')
  AND (qual LIKE '%EXISTS (SELECT 1 FROM employees%' OR with_check LIKE '%EXISTS (SELECT 1 FROM employees%');
-- expected: only payroll's INSERT and UPDATE policies (both untouched,
-- out of scope, gated by current_user_role_level() = 1 -- always <= 2,
-- so never actually broken by the employees SELECT tightening).

-- ============================================================
-- LIVE SIMULATION -- requires real profile ids for: a Legacy Admin
-- (role_level=1), Legacy Manager (role_level=2, region-scoped), Legacy
-- Supervisor (role_level=3, region-scoped), Legacy Staff (role_level=4,
-- region-scoped), an HR Manager / Accountant / Operations Manager
-- (functional roles, each with a region_id), a true super admin, and two
-- real employee ids in two DIFFERENT regions of the same tenant. Every
-- block is wrapped in BEGIN/ROLLBACK; nothing persists.
-- ============================================================

-- 5. employee_region_allowed() direct behavior.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<LEGACY_MANAGER_PROFILE_ID>', true);
-- SELECT employee_region_allowed('<EMPLOYEE_ID_OWN_REGION>') AS expect_true,
--        employee_region_allowed('<EMPLOYEE_ID_OTHER_REGION>') AS expect_false,
--        employee_region_allowed('00000000-0000-0000-0000-000000000000') AS expect_false_nonexistent;
-- ROLLBACK;

-- 6. Legacy Supervisor (3): loses employees SELECT, but Attendance and
--    employee_deductions SELECT/write continue to work exactly as before
--    -- this is the specific regression the redesign exists to prevent.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<LEGACY_SUPERVISOR_PROFILE_ID>', true);
-- SELECT COUNT(*) AS employees_expect_0 FROM employees;
-- SELECT COUNT(*) AS attendance_expect_gt_0_own_region FROM attendance
--   WHERE employee_id = '<EMPLOYEE_ID_OWN_REGION>';
-- SELECT COUNT(*) AS deductions_expect_gt_0_own_region FROM employee_deductions
--   WHERE employee_id = '<EMPLOYEE_ID_OWN_REGION>';
-- ROLLBACK;

-- 7. Legacy Staff (4): loses employees, attendance, AND employee_deductions
--    SELECT -- no frontend page reads any of the three for this role_level
--    after this migration's own Payslips removal.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<LEGACY_STAFF_PROFILE_ID>', true);
-- SELECT COUNT(*) AS employees_expect_0 FROM employees;
-- SELECT COUNT(*) AS attendance_expect_0 FROM attendance;
-- SELECT COUNT(*) AS deductions_expect_0 FROM employee_deductions
--   WHERE employee_id = '<EMPLOYEE_ID_OWN_REGION>';
-- ROLLBACK;

-- 8. Region and tenant isolation still hold for every table above.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<LEGACY_MANAGER_PROFILE_ID>', true);
-- SELECT COUNT(*) AS employees_expect_0_other_region FROM employees WHERE id = '<EMPLOYEE_ID_OTHER_REGION>';
-- SELECT COUNT(*) AS attendance_expect_0_other_region FROM attendance WHERE employee_id = '<EMPLOYEE_ID_OTHER_REGION>';
-- SELECT COUNT(*) AS payroll_expect_0_other_region FROM payroll WHERE employee_id = '<EMPLOYEE_ID_OTHER_REGION>';
-- SELECT COUNT(*) AS deductions_expect_0_other_region FROM employee_deductions WHERE employee_id = '<EMPLOYEE_ID_OTHER_REGION>';
-- ROLLBACK;

-- 9. Super admin bypass remains intact everywhere.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<SUPER_ADMIN_PROFILE_ID>', true);
-- SELECT employee_region_allowed('<EMPLOYEE_ID_OTHER_REGION>') AS expect_true;
-- SELECT COUNT(*) AS employees_expect_all FROM employees;
-- ROLLBACK;
-- ============================================================

-- ============================================================
-- employees_security AUDIT CONCLUSION (informational -- NOT changed by
-- this migration or this verification pass; recorded here because Step
-- 27's own header explicitly calls it out as unexamined)
-- ============================================================
-- employees_security (20260817000008) is a VIEW, not a table, declared
-- `security_invoker = false, security_barrier = true` -- it runs with the
-- VIEW OWNER's privileges, NOT the calling role's, so it never goes
-- through `employees`' own RLS at all and is structurally unaffected by
-- (and cannot undermine) Step 27's employees SELECT tightening. Its own
-- WHERE clause is a self-contained tenant+region+permission check
-- (`is_current_user_active() AND (is_super_admin() OR (tenant_id =
-- get_current_tenant_id() AND region_allowed(region_id) AND
-- (current_user_role_level() IS NOT NULL OR
-- has_permission('security_personnel.view'))))`), exposing 21 curated,
-- non-financial columns (guard/security-status fields -- no salary,
-- national_id, address, or dob).
--
-- Its own `current_user_role_level() IS NOT NULL` legacy branch DOES let
-- every legacy role_level (1-4) query it, including role_level 3/4 --
-- but this is confirmed INTENTIONAL, not an orphaned bypass, by directly
-- reading its two frontend consumers:
--   * Security.tsx (guard management) -- reachable only by role_level
--     1/2/3 (role_level 4 has no "security" nav entry) and functional
--     roles holding security_personnel.view. Consistent with the view.
--   * Dashboard.tsx's "Renew Expiring Licenses" widget -- reachable by
--     EVERY role_level (1-4), gated client-side by `canViewSecurity`
--     (src/utils/dashboardPermissions.ts), which resolves via
--     `canAccess(isLegacy, SECURITY_PERSONNEL_VIEW)`. `canAccess()`
--     (src/utils/permissions.ts) returns `true` unconditionally whenever
--     `isLegacy` is true, REGARDLESS of the actual role_level value -- the
--     client-side gate is a deliberate, exact mirror of the view's own
--     `IS NOT NULL` predicate, not a narrower rule the database
--     under-enforces. Role_level 4 seeing this one dashboard stat tile is
--     therefore the CURRENT, intended design, not a residual gap.
-- CONCLUSION: no change made to employees_security. Its level 3/4 access
-- is a deliberately, consistently mirrored blanket-legacy design (client
-- and server agree exactly), unlike employee_deductions' SELECT gate
-- (PART 4 above), where the frontend's OWN reachability had narrowed
-- since the gate was last written and the database gate had not followed.
-- ============================================================
