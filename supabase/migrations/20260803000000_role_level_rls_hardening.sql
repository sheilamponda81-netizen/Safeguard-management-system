-- ============================================================
-- MIGRATION: Extend role_level enforcement to remaining tables
-- Date: 2026-08-03
-- ============================================================
--
-- 20260727000001_security_hardening.sql already established that every RLS
-- policy in this schema gates only on tenant_id / is_super_admin(), while
-- the app's actual permission model (profiles.role_level: 1=Admin,
-- 2=Manager, 3=Supervisor, 4=Staff, see src/App.tsx's rolePages) is
-- enforced only client-side. That migration closed the gap for `profiles`
-- self-escalation and `payroll` insert/update. This migration closes the
-- same gap on the remaining tables where rolePages restricts a page to
-- specific roles but the underlying table's RLS does not:
--
--   Page          rolePages allows roles   Table(s) written from that page
--   ------------  -----------------------  --------------------------------
--   payments      1 (Admin), 2 (Manager)   payment_status
--   terminal-dues 1, 2                     terminal_dues
--   settings      1 only                   system_settings
--   attendance    1, 2, 3 (+ Supervisor)    employee_deductions (deduction
--                                           editing inside Attendance.tsx's
--                                           EmployeeModal)
--   recruitment   1, 2                     applicants
--
-- Without this, any authenticated Staff (role_level 4) account -- who
-- cannot even navigate to these pages in the UI -- can still call
-- supabase-js directly from a browser console and mark payments paid,
-- approve terminal dues, edit payroll deduction rates in system_settings,
-- alter attendance deduction figures, or write recruitment records.
--
-- NOT touched here, deliberately, to keep this migration small and
-- reviewable (see follow-up items in SECURITY_REVIEW.md):
--   - `employees` INSERT/UPDATE: this table is written from BOTH the
--     Employees page (rolePages: 1, 2 only) AND the Security page
--     (rolePages: 1, 2, 3 -- Supervisors manage guard/shift/uniform
--     columns there). A blanket role_level check would lock Supervisors
--     out of Security.tsx's legitimate guard-management writes. Doing
--     this correctly needs column-level checks (which specific columns
--     a Supervisor may touch vs Admin/Manager-only columns like
--     basic_salary/account_number/region_id), which is a larger, separate
--     change that needs a confirmed column list before writing.
--   - Region-based row filtering (employees.region_id / a user's
--     profiles.region_id): profiles.region_id is nullable, and the app's
--     own client-side checks (e.g. Attendance.tsx, Payments.tsx,
--     Recruitment.tsx) treat a NULL region_id as "can see all regions" --
--     that's a business rule, not something to guess at in a migration.
--     Documented as a confirmed, unresolved P0 gap in SECURITY_REVIEW.md.
--   - `regions`/`companies`/`positions` DELETE: lower-sensitivity lookup
--     tables, left for a follow-up pass.
-- ============================================================

-- ------------------------------------------------------------
-- payment_status: require role_level <= 2 (Admin or Manager)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert payment status in their tenant" ON payment_status;
CREATE POLICY "Managers can insert payment status in their tenant" ON payment_status
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

DROP POLICY IF EXISTS "Users can update payment status in their tenant" ON payment_status;
CREATE POLICY "Managers can update payment status in their tenant" ON payment_status
FOR UPDATE USING (
  tenant_id = get_current_tenant_id() OR is_super_admin() = true
)
WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

-- ------------------------------------------------------------
-- terminal_dues: require role_level <= 2 (Admin or Manager)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert terminal dues in their tenant" ON terminal_dues;
CREATE POLICY "Managers can insert terminal dues in their tenant" ON terminal_dues
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

DROP POLICY IF EXISTS "Users can update terminal dues in their tenant" ON terminal_dues;
CREATE POLICY "Managers can update terminal dues in their tenant" ON terminal_dues
FOR UPDATE USING (
  tenant_id = get_current_tenant_id() OR is_super_admin() = true
)
WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

-- ------------------------------------------------------------
-- system_settings: require role_level = 1 (Admin only) to write.
-- Read stays tenant-wide (many pages read shared settings like payroll
-- rates); the "settings" nav page itself is Admin-only per rolePages.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert settings in their tenant" ON system_settings;
CREATE POLICY "Admins can insert settings in their tenant" ON system_settings
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() = 1 OR is_super_admin() = true)
);

DROP POLICY IF EXISTS "Users can update settings in their tenant" ON system_settings;
CREATE POLICY "Admins can update settings in their tenant" ON system_settings
FOR UPDATE USING (
  tenant_id = get_current_tenant_id() OR is_super_admin() = true
)
WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() = 1 OR is_super_admin() = true)
);

-- ------------------------------------------------------------
-- employee_deductions: require role_level <= 3 (Admin, Manager, or
-- Supervisor -- matches the Attendance page's own rolePages access,
-- since this is where deductions are edited).
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert deductions in their tenant" ON employee_deductions;
CREATE POLICY "Attendance roles can insert deductions in their tenant" ON employee_deductions
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 3 OR is_super_admin() = true)
);

DROP POLICY IF EXISTS "Users can update deductions in their tenant" ON employee_deductions;
CREATE POLICY "Attendance roles can update deductions in their tenant" ON employee_deductions
FOR UPDATE USING (
  tenant_id = get_current_tenant_id() OR is_super_admin() = true
)
WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 3 OR is_super_admin() = true)
);

-- ------------------------------------------------------------
-- applicants (recruitment): require role_level <= 2 (Admin or Manager)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert applicants in their tenant" ON applicants;
CREATE POLICY "Managers can insert applicants in their tenant" ON applicants
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

DROP POLICY IF EXISTS "Users can update applicants in their tenant" ON applicants;
CREATE POLICY "Managers can update applicants in their tenant" ON applicants
FOR UPDATE USING (
  tenant_id = get_current_tenant_id() OR is_super_admin() = true
)
WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

DROP POLICY IF EXISTS "Users can delete applicants in their tenant" ON applicants;
CREATE POLICY "Managers can delete applicants in their tenant" ON applicants
FOR DELETE USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

-- ------------------------------------------------------------
-- payroll DELETE: the app has no delete UI for this table at all (noted
-- in 20260727000001_security_hardening.sql), so tightening this to
-- super-admin-only changes nothing for current usage while closing an
-- otherwise-unrestricted direct-API path to destroy payroll history.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can delete payroll in their tenant" ON payroll;
CREATE POLICY "Super admins can delete payroll" ON payroll
FOR DELETE USING (is_super_admin() = true);

-- ------------------------------------------------------------
-- employees DELETE: the app only ever soft-deletes (verified: no
-- `.delete()` call on this table anywhere in src/pages/Employees.tsx --
-- deletion is `.update({ is_deleted: true, ... })`). A hard DELETE here
-- cascades into payroll/attendance (both ON DELETE CASCADE on
-- employee_id), destroying that employee's entire financial and
-- attendance history irrecoverably. Restricting to super-admin-only
-- closes an unused-but-live direct-API path without affecting any
-- current workflow.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can delete employees in their tenant" ON employees;
CREATE POLICY "Super admins can delete employees" ON employees
FOR DELETE USING (is_super_admin() = true);

-- ============================================================
-- Pin search_path on every SECURITY DEFINER function in this schema.
-- Without this, these functions are resolved against whatever
-- search_path the calling session has, which is the standard Postgres
-- "schema injection" risk for SECURITY DEFINER functions (flagged by
-- Supabase's own security linter as "function_search_path_mutable").
-- Behavior is unchanged -- these functions already only ever reference
-- public.profiles unqualified; this just makes that explicit and safe
-- against a session with an unusual search_path.
-- ============================================================
ALTER FUNCTION get_current_tenant_id() SET search_path = public, pg_temp;
ALTER FUNCTION is_super_admin() SET search_path = public, pg_temp;
ALTER FUNCTION current_user_role_level() SET search_path = public, pg_temp;
ALTER FUNCTION prevent_profile_privilege_escalation() SET search_path = public, pg_temp;

-- ============================================================
-- END OF ROLE-LEVEL RLS HARDENING MIGRATION
-- ============================================================
