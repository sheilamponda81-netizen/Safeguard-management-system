-- ============================================================
-- MIGRATION: Corrections after implementation review (round 2)
-- Date: 2026-08-20
-- ============================================================
--
-- This migration fixes several gaps identified in a review of
-- 20260817000000-000004: lookup/config table write security, explicit
-- role_permissions/function privilege hardening, a genuine regression in
-- 20260817000004 (system_settings SELECT was over-restricted to Admin-only,
-- breaking every non-Admin role's legitimate reads of current month/payroll
-- rates/page size/company display info), a pre-existing anon-EXECUTE gap on
-- generate_employee_number(), and a general-employee read projection that
-- excludes Security/guard-specific columns for callers without
-- security_personnel.view.
--
-- ============================================================
-- PART 1: LOOKUP/CONFIG TABLE WRITE LOCKDOWN
-- ============================================================
-- Audited EVERY lookup/config table actually present and used by the
-- application (there is no separate "workstations" or "departments"
-- table -- both are plain TEXT columns on `employees`/`profiles`, not
-- lookup tables in their own right):
--   regions, positions, companies    -- dropdown sources used across
--                                        Employees/Security/Recruitment/etc.
--   user_roles                       -- Settings -> "Roles & Permissions"
--                                        tab (Misc.tsx) -- a decorative,
--                                        already-disconnected table (see
--                                        20260817000000's PART 2 comment)
--                                        but still a config table the
--                                        Settings page writes to, so it
--                                        gets the same Admin-only write
--                                        lockdown as the others.
-- All four previously had NO role gate on INSERT/UPDATE/DELETE at all --
-- any authenticated tenant member (including a brand-new hr_manager/
-- accountant/operations_manager, or a legacy Supervisor/Staff) could
-- create/edit/delete a region, position, company, or decorative role
-- entry via a direct REST call. SELECT is UNCHANGED (stays tenant-wide,
-- active-caller-only, via get_current_tenant_id()/is_super_admin() --
-- already enforces is_current_user_active() for free per PART 0 of
-- 20260817000000) -- every permitted module (Employees, Recruitment,
-- Security, Terminal Dues, etc.) legitimately needs to read these to
-- populate its own dropdowns/labels, regardless of role.
-- ============================================================

DROP POLICY IF EXISTS "Users can insert regions in their tenant" ON regions;
CREATE POLICY "Admins can insert regions in their tenant" ON regions
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Users can update regions in their tenant" ON regions;
CREATE POLICY "Admins can update regions in their tenant" ON regions
FOR UPDATE USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
) WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Users can delete regions in their tenant" ON regions;
CREATE POLICY "Admins can delete regions in their tenant" ON regions
FOR DELETE USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Users can insert positions in their tenant" ON positions;
CREATE POLICY "Admins can insert positions in their tenant" ON positions
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Users can update positions in their tenant" ON positions;
CREATE POLICY "Admins can update positions in their tenant" ON positions
FOR UPDATE USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
) WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Users can delete positions in their tenant" ON positions;
CREATE POLICY "Admins can delete positions in their tenant" ON positions
FOR DELETE USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Users can insert companies in their tenant" ON companies;
CREATE POLICY "Admins can insert companies in their tenant" ON companies
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Users can update companies in their tenant" ON companies;
CREATE POLICY "Admins can update companies in their tenant" ON companies
FOR UPDATE USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
) WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Users can delete companies in their tenant" ON companies;
CREATE POLICY "Admins can delete companies in their tenant" ON companies
FOR DELETE USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Users can insert roles in their tenant" ON user_roles;
CREATE POLICY "Admins can insert roles in their tenant" ON user_roles
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Users can update roles in their tenant" ON user_roles;
CREATE POLICY "Admins can update roles in their tenant" ON user_roles
FOR UPDATE USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
) WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Users can delete roles in their tenant" ON user_roles;
CREATE POLICY "Admins can delete roles in their tenant" ON user_roles
FOR DELETE USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR is_business_admin() = true)
);

-- ============================================================
-- PART 2: EXPLICIT role_permissions GRANT/REVOKE HARDENING
-- ============================================================
-- RLS on role_permissions (20260817000000 PART 4) already denies
-- INSERT/UPDATE/DELETE to every non-superuser role -- with RLS enabled and
-- NO policy defined for a given command, Postgres denies that command
-- outright, regardless of table-level GRANTs. This PART adds EXPLICIT,
-- redundant REVOKE/GRANT statements as defense-in-depth so the privilege
-- model is self-documenting in the grants themselves, not just implied by
-- "no policy exists" -- matching the instruction to not rely on implicit
-- defaults. This also closes the table-level-GRANT layer specifically:
-- like every other table in this schema, `role_permissions` was created
-- with no explicit GRANT statement, meaning it inherited whatever
-- table-level default privileges this Supabase project's `public` schema
-- has for anon/authenticated (the project-wide default, not something any
-- migration in this repo ever sets explicitly) -- this PART makes the
-- table's own grants independent of that project-level default.
-- ============================================================

REVOKE ALL ON role_permissions FROM PUBLIC;
REVOKE ALL ON role_permissions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON role_permissions FROM authenticated;
GRANT SELECT ON role_permissions TO authenticated;

-- ============================================================
-- PART 3: FIX system_settings SELECT REGRESSION (20260817000004)
-- ============================================================
-- 20260817000004 changed system_settings SELECT from tenant-wide-active to
-- Admin-only, reasoning that "settings.view" should be Admin-only like the
-- Settings PAGE. This was WRONG: `system_settings` is a generic key/value
-- table holding operational configuration that many PERMITTED modules
-- legitimately read regardless of role --
--   current_payroll_month           (src/utils/currentMonth.ts)  --
--                                     Payroll/Payslips/Payments/Terminal
--                                     Dues/Attendance/Reports all call
--                                     getSystemCurrentMonth() on load
--   paye_rate/paye_threshold/pension_employee_rate/...deduction defaults
--                                    (src/utils/payrollSettings.ts)  --
--                                     Payroll needs these to compute payroll
--   default_page_size               (src/utils/uiSettings.ts)  --
--                                     every paginated list page
--   company_name/logo/address/...   (src/utils/companySettings.ts)  --
--                                     Sidebar, Payslips PDF template
-- None of these are secrets -- they are the same trust level as
-- regions/positions/companies (operational config any active tenant
-- member needs to read to use their permitted modules), not
-- security-sensitive data. The Admin-only requirement belongs on WRITE
-- (INSERT/UPDATE, already correctly gated to is_business_admin()/
-- is_super_admin() since 20260817000004, UNCHANGED here) and on the
-- Settings PAGE itself (already Admin-only via Sidebar/App.tsx's
-- NAV_PERMISSIONS -- 'settings' has no permission-key entry there, so a
-- functional-role account never reaches the Settings page's full
-- management UI regardless of table-level SELECT access). Restoring
-- broad SELECT does not undo that page-level lockdown. This mirrors the
-- exact same "broad SELECT, Admin-only write" shape already used for
-- regions/positions/companies -- consistent architecture rather than a
-- one-off carve-out. A narrow read-only RPC was considered and rejected:
-- it would need to duplicate ~15 keys across getSystemCurrentMonth/
-- getPayrollRates/getDefaultPageSize/getCompanySettings for no additional
-- security benefit, since none of these values are sensitive.
-- ============================================================

DROP POLICY IF EXISTS "Admins can view settings in their tenant" ON system_settings;
CREATE POLICY "Users can view settings in their tenant" ON system_settings
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- INSERT/UPDATE (Admin-only) and DELETE (super-admin-only) policies from
-- 20260817000004 are UNCHANGED -- not touched by this migration.

-- ============================================================
-- PART 4: FIX generate_employee_number() ANON-EXECUTE GAP
-- ============================================================
-- Found during the SECURITY DEFINER function audit: unlike every other
-- SECURITY DEFINER function in this schema (including its own sibling
-- generate_guard_id()), 20260804000001_employee_number_generation.sql
-- never REVOKEd the PUBLIC default EXECUTE grant Postgres applies to every
-- newly CREATEd function -- so `anon` has had EXECUTE on
-- generate_employee_number(UUID) since that migration was first applied.
-- Impact is limited (the function immediately raises 'no tenant resolved
-- for the calling user' for an anon caller, since get_current_tenant_id()
-- returns NULL with no auth.uid()) but this still needlessly exposes the
-- function surface -- including its internal row-locking/counter-mutation
-- logic -- to unauthenticated callers, violating minimum-necessary-
-- privilege. Fixed to match generate_guard_id()'s existing pattern.
-- ============================================================

REVOKE ALL ON FUNCTION generate_employee_number(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generate_employee_number(UUID) TO authenticated;

-- ============================================================
-- PART 5: EMPLOYEES vs SECURITY PERSONNEL COLUMN BOUNDARY
-- ============================================================
-- Both "Employees" and "Security Personnel" render from the SAME
-- `employees` table (Security.tsx uses the guard-specific columns already
-- marked in the schema: shift, supervisor, uniform_status,
-- uniform_condition, shoes_status, license_status, license_expiry,
-- "guardId"). The approved matrix requires:
--   Accountant:  employees.view (READ ONLY) but security_personnel.* DENIED
--   Operations:  employees.view (READ ONLY) AND security_personnel.view
-- Accountant is the ONLY role with employees.view but NOT
-- security_personnel.view -- every other role has both or neither. RLS
-- cannot express this (it filters ROWS, not columns), and a blanket
-- Postgres column-level GRANT cannot either (GRANT is per POSTGRES role --
-- `authenticated` -- not per application role stored in profiles.role, so
-- revoking a column from `authenticated` would also block HR Manager and
-- Operations Manager, who legitimately need it).
--
-- IMPLEMENTED: `employees_general` -- a view that projects every
-- non-guard column and NULLs the guard-specific ones for a caller who
-- lacks security_personnel.view, used by Employees.tsx's general list
-- read (verified: Employees.tsx never references any guard-specific
-- column today, so this is a fully transparent swap with zero behavior
-- change for HR Manager/Admin/legacy accounts, who see every guard column
-- unchanged). `security_invoker = true` (Postgres 15+, Supabase's current
-- baseline) makes the view evaluate the underlying table's OWN RLS as the
-- CALLING user -- this does not bypass or duplicate the tenant/region gate
-- on `employees`, it only adds a column projection on top of it.
--
-- NOT CLOSED, AND EXPLICITLY FLAGGED PER THE "STOP AND REPORT AS A
-- BUSINESS DECISION" INSTRUCTION RATHER THAN SILENTLY ASSUMED: an
-- Accountant session still holds `employees.view`-gated SELECT on the
-- BASE `employees` table directly (required for their legitimate
-- Payroll/Payments/Payslips/Terminal-Dues reads, which need basic_salary/
-- uniform_deduction/position/etc.). A caller who bypasses the app's own
-- UI (e.g. a direct REST/Postman call, not something Employees.tsx's own
-- UI does) and explicitly selects the guard-specific columns from the
-- BASE table can still retrieve them. Fully closing this would require
-- revoking direct base-table SELECT from every consumer and routing
-- Payroll/Payments/Payslips/Terminal-Dues/Salary-Advances/Attendance/
-- Reports through views or RPCs as well -- a much larger, higher-risk
-- change (rewrites of 7+ pages' data-fetching) not undertaken in this
-- pass. This same class of gap (an authorized session using devtools/
-- Postman to read a column its own UI doesn't render) already exists
-- throughout this schema for many other fields and is not unique to guard
-- columns. Recommend a dedicated follow-up if full REST-level column
-- enforcement is required; the view above closes the real, actually-used
-- application UI exposure.
-- ============================================================

CREATE OR REPLACE VIEW employees_general AS
SELECT
  e.id, e.tenant_id, e.employee_number, e.full_name, e.gender, e.age, e.phone,
  e.position, e.department, e.basic_salary, e.status, e.email, e.hire_date,
  e.dob, e.national_id, e.address, e.qualification, e.contract_type,
  e.region_id, e.company, e.workstation, e.pay_point, e.account_number,
  e.uniform_deduction, e.next_of_kin_name, e.next_of_kin_relationship,
  e.next_of_kin_phone, e.next_of_kin_address, e.is_deleted, e.deleted_at,
  e.deleted_reason, e.deleted_by, e.assignment_type, e.resident_name,
  e.resident_contact, e.company_id, e.created_at,
  -- Guard-specific columns: NULLed unless the caller has
  -- security_personnel.view (or is exempt via is_business_admin()/
  -- is_super_admin(), or is a legacy account -- role_level IS NOT NULL --
  -- matching this whole rollout's "legacy accounts keep working exactly
  -- as before" guarantee, since legacy accounts never had this
  -- restriction).
  CASE WHEN is_super_admin() OR is_business_admin() OR current_user_role_level() IS NOT NULL
         OR has_permission('security_personnel.view')
       THEN e.shift ELSE NULL END AS shift,
  CASE WHEN is_super_admin() OR is_business_admin() OR current_user_role_level() IS NOT NULL
         OR has_permission('security_personnel.view')
       THEN e.supervisor ELSE NULL END AS supervisor,
  CASE WHEN is_super_admin() OR is_business_admin() OR current_user_role_level() IS NOT NULL
         OR has_permission('security_personnel.view')
       THEN e.uniform_status ELSE NULL END AS uniform_status,
  CASE WHEN is_super_admin() OR is_business_admin() OR current_user_role_level() IS NOT NULL
         OR has_permission('security_personnel.view')
       THEN e.uniform_condition ELSE NULL END AS uniform_condition,
  CASE WHEN is_super_admin() OR is_business_admin() OR current_user_role_level() IS NOT NULL
         OR has_permission('security_personnel.view')
       THEN e.shoes_status ELSE NULL END AS shoes_status,
  CASE WHEN is_super_admin() OR is_business_admin() OR current_user_role_level() IS NOT NULL
         OR has_permission('security_personnel.view')
       THEN e.license_status ELSE NULL END AS license_status,
  CASE WHEN is_super_admin() OR is_business_admin() OR current_user_role_level() IS NOT NULL
         OR has_permission('security_personnel.view')
       THEN e.license_expiry ELSE NULL END AS license_expiry,
  CASE WHEN is_super_admin() OR is_business_admin() OR current_user_role_level() IS NOT NULL
         OR has_permission('security_personnel.view')
       THEN e."guardId" ELSE NULL END AS "guardId"
FROM employees e;

ALTER VIEW employees_general SET (security_invoker = true);

REVOKE ALL ON employees_general FROM PUBLIC;
REVOKE ALL ON employees_general FROM anon;
GRANT SELECT ON employees_general TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- DROP POLICY IF EXISTS + CREATE
-- POLICY, REVOKE/GRANT (idempotent by nature), CREATE OR REPLACE VIEW.
--
-- DEPENDENCIES: requires 20260817000000 (is_business_admin(),
-- has_permission(), current_user_role_level() redefinition) and
-- 20260817000004 (the system_settings policies this PART 3 partially
-- reverts) to already be applied.
--
-- POSTGRES VERSION: `security_invoker` view option requires Postgres 15+.
-- Supabase's current baseline is Postgres 15/16, so this should be
-- available; VERIFY at STAGING preflight time (see report) with:
--   SHOW server_version;
-- If STAGING somehow runs Postgres < 15, `employees_general` cannot use
-- security_invoker and this PART needs revisiting before being applied
-- there (a SECURITY DEFINER function returning the same projected columns,
-- re-implementing the tenant/region check explicitly, would be the
-- fallback).
--
-- BEHAVIOR CHANGES FOR EXISTING CALLERS:
--   1. A legacy Manager/Supervisor/Staff (or new hr_manager/accountant/
--      operations_manager) account can no longer INSERT/UPDATE/DELETE
--      regions/positions/companies/user_roles directly -- Admin-only now.
--      SELECT is unchanged.
--   2. system_settings SELECT restored to tenant-wide-active -- undoes
--      20260817000004's over-restriction; INSERT/UPDATE remain Admin-only.
--   3. generate_employee_number(UUID) no longer callable by `anon`
--      (previously could be called, but would always fail with 'no tenant
--      resolved' -- no functional change for any legitimate authenticated
--      caller).
--   4. Employees.tsx's general employee list (once updated to query
--      `employees_general` instead of `employees` directly -- frontend
--      change, see the corresponding page update) no longer returns
--      guard-specific column values to a caller without
--      security_personnel.view. No behavior change for HR Manager/Admin/
--      legacy accounts (all see every column, same as before).
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT tablename, policyname, cmd FROM pg_policies
--     WHERE tablename IN ('regions','positions','companies','user_roles')
--     ORDER BY tablename, cmd;
--   -- expected: INSERT/UPDATE/DELETE policies all named "Admins can ..."
--   SELECT has_table_privilege('authenticated', 'role_permissions', 'INSERT');
--   SELECT has_table_privilege('authenticated', 'role_permissions', 'UPDATE');
--   SELECT has_table_privilege('authenticated', 'role_permissions', 'DELETE');
--   -- expected: all 3 = false
--   SELECT has_table_privilege('anon', 'role_permissions', 'SELECT');
--   -- expected: false
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'system_settings' ORDER BY cmd;
--   -- expected: SELECT = "Users can view settings in their tenant" (tenant-wide again)
--   SELECT has_function_privilege('anon', 'generate_employee_number(uuid)', 'EXECUTE');
--   -- expected: false
--   SELECT definition FROM pg_views WHERE viewname = 'employees_general';
--   -- expected: 1 row, guard columns wrapped in CASE
--   -- Functional check: as an Accountant session, SELECT * FROM
--   -- employees_general -- confirm shift/supervisor/uniform_status/
--   -- uniform_condition/shoes_status/license_status/license_expiry/
--   -- "guardId" are all NULL, every other column populated normally. As
--   -- an HR Manager or Admin session, confirm every column is populated.
--
-- ROLLBACK SQL:
--   -- PART 1: re-run the original "Users can insert/update/delete ... in
--   -- their tenant" policy bodies from 20260727000000 verbatim (tenant
--   -- check only, no role gate) for each of the 4 tables.
--   -- PART 2: GRANT INSERT, UPDATE, DELETE ON role_permissions TO authenticated; (not recommended)
--   -- PART 3: re-run 20260817000004's "Admins can view settings in their
--   -- tenant" policy body verbatim.
--   -- PART 4: GRANT EXECUTE ON FUNCTION generate_employee_number(UUID) TO PUBLIC; (not recommended)
--   -- PART 5: DROP VIEW IF EXISTS employees_general;
-- ============================================================
