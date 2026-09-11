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
-- employee_region_allowed(UUID), resolves an employee's region ALLOWED-ness
-- (a boolean) bypassing RLS entirely -- the same trust pattern every other
-- SECURITY DEFINER function in this schema already uses (region_allowed()/
-- get_current_tenant_id()/is_business_admin(), etc. all bypass RLS on the
-- tables they read). Attendance's 3 policies are rewritten to call
-- `employee_region_allowed(attendance.employee_id)` instead of the inline
-- EXISTS-against-employees subquery -- semantically IDENTICAL (same
-- region_allowed() check against the same employee's region_id), it only
-- removes the dependency on the CALLING role's own employees-table SELECT
-- privilege. INSERT/UPDATE's own `current_user_role_level() <= 3` condition
-- is NOT changed by this -- only the structurally-broken region check
-- underneath it is.
--
-- DESIGN CORRECTED before this migration was ever applied anywhere: an
-- earlier draft of this fix used a helper named employee_region_id(UUID)
-- that RETURNED the employee's raw region_id (`RETURNS UUID`), wrapped by
-- the policy in `region_allowed(employee_region_id(...))`. Directly
-- callable via PostgREST (`GRANT EXECUTE ... TO authenticated` makes any
-- SECURITY DEFINER function reachable at `/rest/v1/rpc/<name>`, not just
-- from inside a policy), that design let ANY authenticated same-tenant
-- caller learn an arbitrary same-tenant employee's actual region_id --
-- including an employee OUTSIDE the caller's own permitted region, whom
-- `employees` RLS itself would hide entirely. The internal tenant check
-- added at the time closed the CROSS-TENANT disclosure, but a same-tenant,
-- cross-REGION metadata leak remained: a strictly WORSE information
-- surface than the coupling bug it existed to fix, introduced solely to
-- fix an internal RLS dependency. Replaced below with
-- employee_region_allowed(UUID) RETURNS BOOLEAN, which never exposes
-- region_id (or any other employee column) to the caller under any
-- circumstance, in policy use or via direct RPC call alike -- only ever a
-- true/false answer to "is this specific employee_id within a region the
-- CURRENT caller is already allowed to see." A second real finding from
-- the same review, addressed in PART 4 below: `employee_deductions`' own
-- SELECT/INSERT/UPDATE policies (20260817000002) contain the SAME
-- unwrapped `EXISTS (SELECT 1 FROM employees e WHERE e.id = ... AND
-- region_allowed(e.region_id))` pattern Attendance had, and are subject to
-- the exact same cascading breakage from PART 1's employees SELECT
-- tightening -- not originally in this migration's scope, but a real,
-- confirmed regression against a table this migration does affect, so it
-- is fixed here using the same employee_region_allowed(UUID) predicate,
-- with each policy's own legacy/permission gate left completely
-- unchanged.
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

-- SECURITY DEFINER helper: resolves whether a specific employee_id is
-- within a region the CALLER is currently allowed to see, bypassing RLS
-- on `employees` internally -- the same trust pattern every other helper
-- in this schema already uses. Needed because a caller who lawfully
-- passes Attendance's own `current_user_role_level() <= 3` (or `<= 2`/
-- `has_permission` elsewhere) must not ALSO be required to pass
-- `employees`' own, separately-scoped SELECT policy just to resolve a
-- region for a security check -- that coupling is exactly what broke
-- Legacy Supervisor's Attendance access once `employees` SELECT was
-- tightened in PART 1.
--
-- BOOLEAN-ONLY BY DESIGN (release-blocking correction, made before this
-- migration was ever applied anywhere -- see the header's own "DESIGN
-- CORRECTED" note for the full history): this function returns ONLY
-- true/false, never an employee's region_id or any other column. Unlike
-- the EXISTS-subquery pattern it replaces (or the raw-region_id-returning
-- design it itself replaced), it is a standalone function taking an
-- ARBITRARY employee_id argument, and `GRANT EXECUTE ... TO authenticated`
-- makes it directly callable via PostgREST's own RPC endpoint
-- (`/rest/v1/rpc/employee_region_allowed`), not just from inside a
-- policy's USING/WITH CHECK clause -- Postgres/PostgREST cannot enforce
-- "only call this from inside a policy." A caller who invokes it directly
-- with a guessed/enumerated employee_id therefore learns AT MOST a single
-- bit -- "is this id an employee in my own tenant, in a region I can
-- already see" -- never the employee's actual region_id, and never
-- anything about an employee in a different tenant (an internal tenant
-- check, matching every other arbitrary-ID-parameterized SECURITY DEFINER
-- function in this schema -- approve_terminal_due, record_terminal_due_
-- payment, etc. -- gates this before doing anything else) or a different
-- region (region_allowed() is applied INTERNALLY, its own boolean result
-- is all that ever leaves the function). Fails closed (false) for an
-- inactive caller, a nonexistent employee_id, a different-tenant
-- employee, and an out-of-region employee alike -- there is no
-- distinguishable NULL/error case an enumerating caller could use to tell
-- these apart from one another. This changes nothing about Attendance's
-- own policies' behavior (an attendance row's employee is always
-- same-tenant already, per the FK and the policy's own tenant_id check)
-- -- it only closes the direct-RPC-callable information surface, down to
-- zero disclosure rather than merely narrowing it.
CREATE OR REPLACE FUNCTION employee_region_allowed(p_employee_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_region_id UUID;
BEGIN
  IF NOT is_current_user_active() THEN
    RETURN false;
  END IF;

  SELECT region_id INTO v_region_id FROM employees
    WHERE id = p_employee_id
      AND (is_super_admin() OR tenant_id = get_current_tenant_id());

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  RETURN COALESCE(region_allowed(v_region_id), false);
END;
$$;

REVOKE ALL ON FUNCTION employee_region_allowed(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION employee_region_allowed(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION employee_region_allowed(UUID) TO authenticated;

DROP POLICY IF EXISTS "Attendance: view within tenant+region, action or legacy permitted" ON attendance;
CREATE POLICY "Attendance: view within tenant+region, action or legacy permitted" ON attendance
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND employee_region_allowed(attendance.employee_id)
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
      AND employee_region_allowed(attendance.employee_id)
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
      AND employee_region_allowed(attendance.employee_id)
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
      AND employee_region_allowed(attendance.employee_id)
      AND (current_user_role_level() <= 3 OR has_permission('attendance.edit'))
    )
  )
);

-- ============================================================
-- PART 3: payroll -- SELECT only (INSERT/UPDATE/DELETE out of scope)
-- ============================================================
-- The live role matrix confirms payroll SELECT's legacy `<= 2` threshold
-- already matches `employees`' own new `<= 2` threshold exactly, and every
-- current payroll.view permission holder (Accountant, per the matrix) also
-- holds employees.view -- so this policy is NOT currently broken by PART
-- 1's tightening the way Attendance and employee_deductions (PART 4) are.
-- The inline `EXISTS (SELECT 1 FROM employees e WHERE ... region_allowed
-- (e.region_id))` subquery is nonetheless replaced with the same
-- employee_region_allowed(UUID) predicate PART 2 already introduces --
-- this migration is already rewriting this exact CREATE POLICY statement,
-- so removing the same latent caller-RLS coupling here costs nothing
-- extra and closes the same class of fragility (any FUTURE tightening of
-- employees SELECT would otherwise silently re-break this policy too)
-- before it can ever bite, rather than leaving a second copy of a pattern
-- already known to be fragile.
-- ============================================================

DROP POLICY IF EXISTS "Payroll: view within tenant+region, action or legacy permitted" ON payroll;
CREATE POLICY "Payroll: view within tenant+region, action or legacy permitted" ON payroll
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND employee_region_allowed(payroll.employee_id)
      AND (current_user_role_level() <= 2 OR has_permission('payroll.view'))
    )
  )
);

-- ============================================================
-- PART 4: employee_deductions -- SELECT/INSERT/UPDATE (region-check
-- coupling fix only; legacy/permission gates on each policy UNCHANGED)
-- ============================================================
-- SECOND REAL REGRESSION found in the same review that produced PART 2's
-- redesign (empirically confirmed, not assumed): `employee_deductions`
-- (20260817000002) has the SAME unwrapped `EXISTS (SELECT 1 FROM
-- employees e WHERE e.id = employee_deductions.employee_id AND
-- region_allowed(e.region_id))` pattern Attendance had, in all 3 of its
-- own policies:
--   * SELECT's own gate is `current_user_role_level() IS NOT NULL OR
--     has_permission('attendance.view') OR has_permission('payslips.view')`
--     -- unlike employees/attendance/payroll, this table's own legacy
--     threshold is NOT part of this migration's PART 1 scope and is left
--     completely unchanged here -- but it means EVERY legacy account,
--     including role_level 3 and 4, is intended to keep passing this
--     table's OWN gate (per 20260817000002's own header: "SELECT
--     tenant-only (no gate -- Payslips.tsx, role_level 4-reachable, reads
--     this directly)"). Once PART 1 tightens `employees` SELECT to `<= 2`,
--     a role_level 3 or 4 caller newly fails the nested EXISTS subquery
--     even though employee_deductions' own SELECT policy still says yes --
--     the exact same silent-zero-rows failure mode PART 2 already fixed
--     for Attendance, confirmed here empirically the same way.
--   * INSERT/UPDATE's own gate is `current_user_role_level() <= 3 OR
--     has_permission('attendance.create'/'.edit')` -- a role_level 3
--     (Legacy Supervisor) caller, who this table's own policy intends to
--     keep allowing (matching Attendance's own <= 3 write threshold, per
--     20260817000002's own header: "Write gated the same way as
--     attendance itself"), newly fails the nested EXISTS subquery for the
--     same reason.
-- FIX: identical in shape to PART 2 -- swap the inline EXISTS-against-
-- employees subquery for employee_region_allowed(employee_deductions.
-- employee_id). Each policy's own legacy-role/permission gate (the
-- `current_user_role_level()`/`has_permission(...)` clause) is otherwise
-- BYTE-IDENTICAL to its 20260817000002 original -- this PART changes
-- nothing about WHO is authorized, only HOW the region check underneath
-- that authorization is evaluated, exactly like PART 2.
-- ============================================================

DROP POLICY IF EXISTS "Deductions: view within tenant+region, legacy open or new permission" ON employee_deductions;
CREATE POLICY "Deductions: view within tenant+region, legacy open or new permission" ON employee_deductions
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND employee_region_allowed(employee_deductions.employee_id)
      AND (current_user_role_level() IS NOT NULL OR has_permission('attendance.view') OR has_permission('payslips.view'))
    )
  )
);

DROP POLICY IF EXISTS "Deductions: create within tenant+region, legacy Supervisor+ or new permission" ON employee_deductions;
CREATE POLICY "Deductions: create within tenant+region, legacy Supervisor+ or new permission" ON employee_deductions
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND employee_region_allowed(employee_deductions.employee_id)
      AND (current_user_role_level() <= 3 OR has_permission('attendance.create'))
    )
  )
);

DROP POLICY IF EXISTS "Deductions: update within tenant+region, legacy Supervisor+ or new permission" ON employee_deductions;
CREATE POLICY "Deductions: update within tenant+region, legacy Supervisor+ or new permission" ON employee_deductions
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND employee_region_allowed(employee_deductions.employee_id)
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
      AND employee_region_allowed(employee_deductions.employee_id)
      AND (current_user_role_level() <= 3 OR has_permission('attendance.edit'))
    )
  )
);

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- DROP POLICY IF EXISTS then CREATE
-- POLICY, same names, same tables; CREATE OR REPLACE FUNCTION for
-- employee_region_allowed().
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
--   - Legacy Supervisor (3): Attendance and employee_deductions SELECT/
--     INSERT/UPDATE continue to work exactly as before PART 1 -- this is
--     the specific regression PART 2/PART 4's employee_region_allowed()
--     redesign exists to prevent (without it, this caller would have
--     silently lost this access as a side effect of PART 1, despite
--     neither table's own policy intending to restrict them).
--   - Legacy Staff (4): employee_deductions SELECT continues to work
--     exactly as before PART 1 (Payslips.tsx's own deductions read),
--     for the same reason.
--   - No caller gains anything they did not already have -- PART 2/3/4's
--     employee_region_allowed() calls are a drop-in, same-result
--     replacement for the EXISTS-subquery/region_allowed(region_id)
--     checks they replace; only the MECHANISM changed, verified
--     empirically (see the accompanying verification script).
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
--   SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
--     WHERE tablename IN ('attendance','payroll','employee_deductions')
--     AND (qual LIKE '%employee_region_allowed%' OR with_check LIKE '%employee_region_allowed%');
--   -- expected: attendance (3 rows: SELECT/INSERT/UPDATE), payroll (1 row:
--   -- SELECT), employee_deductions (3 rows: SELECT/INSERT/UPDATE) -- 7
--   -- rows total, none of the 7 containing "EXISTS (SELECT 1 FROM
--   -- employees" or "employee_region_id(" any more.
--
--   SELECT p.proname, p.prorettype::regtype AS return_type,
--          p.prosecdef AS security_definer,
--          (SELECT array_agg(cfg) FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%') AS search_path,
--          has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
--   FROM pg_proc p WHERE p.oid = 'employee_region_allowed(uuid)'::regprocedure;
--   -- expected: return_type=boolean, security_definer=true,
--   -- search_path={search_path=public,pg_temp}, public_can_execute=false,
--   -- anon_can_execute=false, authenticated_can_execute=true.
--
--   SELECT COUNT(*) FROM pg_proc WHERE proname = 'employee_region_id';
--   -- expected: 0 -- the region_id-returning helper must not exist under
--   -- this or any name; only the boolean-returning employee_region_allowed
--   -- remains.
--
-- ROLLBACK SQL:
--   DROP FUNCTION IF EXISTS employee_region_allowed(UUID);
--   -- (only once every policy referencing it below has first been
--   -- reverted -- DROP FUNCTION fails while any policy still references
--   -- it, same caveat as the design it replaces)
--   -- Re-apply 20260817000001's original 3 employees policies,
--   -- 20260817000002's original attendance/payroll SELECT policies and
--   -- original attendance INSERT/UPDATE policies (the EXISTS-subquery
--   -- form), and 20260817000002's original employee_deductions SELECT/
--   -- INSERT/UPDATE policies (also the EXISTS-subquery form) -- all
--   -- reproduced verbatim in that migration's own file, substituting
--   -- `IS NOT NULL` back in for `<= 2`/`<= 3` on employees/attendance/
--   -- payroll only (employee_deductions' own gates were never changed by
--   -- this migration and need no substitution).
-- ============================================================
