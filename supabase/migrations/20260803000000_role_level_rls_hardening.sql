-- ============================================================
-- MIGRATION: Extend role_level enforcement to remaining tables
-- Date: 2026-08-03 (revised same day -- see "REVISION" note below)
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
-- REVISION (same day, after a dedicated src/-wide RLS access-matrix
-- review): the version of this migration first written only added
-- INSERT/UPDATE (and, for `applicants`, DELETE) policies for the tables
-- above, leaving 3 confirmed, live gaps that a review of every SELECT/
-- DELETE caller in src/ found:
--   - `payment_status`/`terminal_dues` SELECT was left tenant-wide (no
--     role_level check) even though the ONLY src/ callers of either table
--     (Payments.tsx, TerminalDues.tsx) are themselves gated to role_level
--     <= 2 by rolePages -- role_level 3/4 had no legitimate reason to read
--     either table, but could via a direct API call.
--   - `payment_status`/`terminal_dues`/`employee_deductions` DELETE was
--     left tenant-wide (no role_level check) even though grep confirms
--     ZERO `.delete()` calls against any of the three anywhere in src/ --
--     a live, unused-by-the-app-but-reachable-via-API gap.
--   - `applicants` SELECT was left tenant-wide because src/pages/
--     Dashboard.tsx's recruitment-count stat tile (reachable by every
--     role_level, since Dashboard itself is) issues 3 direct
--     `select('id', {count:'exact'}).eq('interview_status', ...)` calls
--     against this table. Business decision: role_level 3/4 should keep
--     seeing the COUNTS, but must not be able to read full applicant rows
--     (name/email/phone/notes/interview detail/decision).
--     **This specific gap is NOT closed in this migration** -- fixing it
--     requires a counts-only RPC to exist FIRST (so Dashboard.tsx has
--     something to call before the direct-SELECT path is closed off),
--     which is a deploy-ordering concern this single migration file
--     can't express on its own. See
--     20260804000002_applicant_dashboard_counts_rpc.sql (creates the RPC)
--     and 20260804000003_restrict_applicants_select.sql (the actual
--     SELECT restriction, deliberately a separate, later migration) for
--     the full 2-phase expand/contract sequence.
-- This revision closes the other 2 gaps below (payment_status/
-- terminal_dues SELECT, and DELETE on payment_status/terminal_dues/
-- employee_deductions) in this same migration, since neither has any
-- RPC/deploy-ordering dependency -- only applicants SELECT does.
--
-- `employee_deductions` SELECT is deliberately left untouched (still
-- tenant-wide, no role_level check) -- src/pages/Payslips.tsx (role_level
-- 4 reachable) reads this table directly to compute net pay, so any
-- role_level restriction on SELECT would break that legitimate path.
--
-- NOT touched here, deliberately, to keep this migration reviewable (see
-- follow-up items in SECURITY_REVIEW.md):
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
-- payment_status: require role_level <= 2 (Admin or Manager) for
-- SELECT/INSERT/UPDATE; DELETE restricted further to super-admin only,
-- since grep confirms no `.delete()` call against this table exists
-- anywhere in src/ -- least privilege for a capability the app never
-- actually uses.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view payment status in their tenant" ON payment_status;
CREATE POLICY "Managers can view payment status in their tenant" ON payment_status
FOR SELECT USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

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

DROP POLICY IF EXISTS "Users can delete payment status in their tenant" ON payment_status;
CREATE POLICY "Super admins can delete payment status" ON payment_status
FOR DELETE USING (is_super_admin() = true);

-- ------------------------------------------------------------
-- terminal_dues: require role_level <= 2 (Admin or Manager) for
-- SELECT/INSERT/UPDATE; DELETE restricted further to super-admin only
-- (same "no `.delete()` caller anywhere in src/" reasoning as
-- payment_status above).
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view terminal dues in their tenant" ON terminal_dues;
CREATE POLICY "Managers can view terminal dues in their tenant" ON terminal_dues
FOR SELECT USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

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

DROP POLICY IF EXISTS "Users can delete terminal dues in their tenant" ON terminal_dues;
CREATE POLICY "Super admins can delete terminal dues" ON terminal_dues
FOR DELETE USING (is_super_admin() = true);

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

-- DELETE restricted to super-admin only. Not previously part of this
-- migration -- only defined in 20260727000000_reconstructed_base_schema.sql,
-- whose own header explicitly warns it should not be run against an
-- already-populated database as-is. Reproduced here, identically, so this
-- migration's own final state for system_settings is self-sufficient and
-- does not depend on that file's policy section having also been applied.
DROP POLICY IF EXISTS "Super admins can delete settings" ON system_settings;
CREATE POLICY "Super admins can delete settings" ON system_settings
FOR DELETE USING (is_super_admin() = true);

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

-- DELETE restricted to super-admin only. Previously tenant-wide with no
-- role_level check at all (the original policy from
-- 20240619000000_tenant_isolation.sql) -- grep confirms zero `.delete()`
-- calls against this table anywhere in src/, and this data feeds payroll
-- calculations directly, so least privilege applies even though nothing
-- in the app currently exercises this path.
DROP POLICY IF EXISTS "Users can delete deductions in their tenant" ON employee_deductions;
CREATE POLICY "Super admins can delete deductions" ON employee_deductions
FOR DELETE USING (is_super_admin() = true);

-- SELECT is deliberately left untouched here (still the tenant-wide,
-- no-role_level-check policy from whichever base migration created it) --
-- src/pages/Payslips.tsx (role_level 4 / Staff reachable) reads this
-- table directly to compute net pay, so restricting SELECT below
-- role_level 4 would break that legitimate, already-shipped path.

-- ------------------------------------------------------------
-- applicants (recruitment): require role_level <= 2 (Admin or Manager)
-- for INSERT/UPDATE/DELETE.
--
-- SELECT is DELIBERATELY NOT restricted here, even though the same
-- business decision (Supervisor/Staff must not read full applicant rows)
-- applies to SELECT too -- see 20260804000003_restrict_applicants_select.sql
-- for why that specific policy change is deliberately its own, later
-- migration rather than bundled into this one: it depends on
-- get_applicant_dashboard_counts() (20260804000002_applicant_dashboard_counts_rpc.sql)
-- already existing, and NEITHER of those files existed anywhere in this
-- migration set until this pass -- putting the SELECT restriction here
-- would risk a real deployment-ordering hazard (a database state where
-- Staff/Supervisor can neither read applicants directly NOR call a
-- counts RPC that doesn't exist yet, silently breaking the Dashboard's
-- recruitment-count tile for those roles). See that file's own header
-- for the full expand/contract rollout sequence this is part of.
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
-- MIGRATION SAFETY NOTES (added after this audit's migration-safety review)
-- ============================================================
--
-- RUN ONCE, SUCCESSFULLY: yes -- every policy change is
-- `DROP POLICY IF EXISTS` followed by `CREATE POLICY`, and every
-- function change is `ALTER FUNCTION ... SET search_path`, both
-- naturally idempotent operations.
--
-- RUN TWICE, ACCIDENTALLY: fully safe, no error, no behavior change --
-- this entire migration is idempotent by construction (every DROP is
-- guarded with IF EXISTS, every ALTER FUNCTION just re-sets the same
-- value). Re-running it produces byte-for-byte the same end state.
--
-- LOCKS TAKEN / PRODUCTION TRAFFIC IMPACT: `CREATE POLICY`/`DROP POLICY`
-- take a brief `ACCESS EXCLUSIVE` lock on the affected table (standard
-- Postgres behavior for any RLS policy change), but only for the
-- duration of the catalog update itself -- not a table scan like the
-- UNIQUE constraint migration above, since no existing data is
-- validated. Expected to be near-instantaneous even on a large table.
-- `ALTER FUNCTION ... SET search_path` takes a lock on the function
-- definition itself, similarly brief. Safe to apply during normal
-- traffic, though a low-traffic window is still the more conservative
-- choice for any RLS change, since a mistake here changes who can read/
-- write data immediately.
--
-- PREFLIGHT: none needed -- this migration adds/replaces policies and
-- pins function search_paths; it does not add any constraint that could
-- fail against existing data.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT tablename, policyname, cmd FROM pg_policies
--     WHERE tablename IN ('payment_status','terminal_dues','system_settings','employee_deductions','applicants','payroll','employees')
--     ORDER BY tablename, cmd;
--   -- Confirm the expected policy names from this file are present, AND
--   -- (added this revision) confirm the cmd/policyname pairing matches:
--   --   payment_status : SELECT/INSERT/UPDATE = "Managers can ...", DELETE = "Super admins can delete payment status"
--   --   terminal_dues  : SELECT/INSERT/UPDATE = "Managers can ...", DELETE = "Super admins can delete terminal dues"
--   --   system_settings: INSERT/UPDATE = "Admins can ...", DELETE = "Super admins can delete settings" (no SELECT policy from this file -- stays whatever the base schema defined, tenant-wide)
--   --   employee_deductions: INSERT/UPDATE = "Attendance roles can ...", DELETE = "Super admins can delete deductions" (no SELECT policy from this file -- stays tenant-wide)
--   --   applicants     : INSERT/UPDATE/DELETE = "Managers can ..." (SELECT policy is NOT changed by this file -- see 20260804000003_restrict_applicants_select.sql)
--   --   payroll/employees: DELETE = "Super admins can delete ..."
--   SELECT proname, proconfig FROM pg_proc
--     WHERE proname IN ('get_current_tenant_id','is_super_admin','current_user_role_level','prevent_profile_privilege_escalation');
--   -- Expected: proconfig contains 'search_path=public, pg_temp' for all 4.
--
-- ADDITIONAL VERIFICATION -- role_level SELECT enforcement (added this
-- revision, best run as each real role rather than by inspecting SQL
-- alone -- see e2e/authenticated/rls-policy-matrix.spec.ts's
-- "payment_status view restriction" / "terminal_dues view restriction"
-- describe blocks for the executable version of this check; `applicants`
-- SELECT is verified separately in 20260804000003_restrict_applicants_select.sql,
-- once that migration has actually been applied):
--   -- As a Supervisor or Staff session:
--   SELECT * FROM payment_status LIMIT 1;   -- expect 0 rows (not an error -- RLS denial is silent on SELECT)
--   SELECT * FROM terminal_dues LIMIT 1;    -- expect 0 rows
--   SELECT * FROM applicants LIMIT 1;       -- expect a real row from this file alone (SELECT is untouched here) --
--                                           -- becomes 0 rows only after 20260804000003 is separately applied.
--   -- As an Admin or Manager session, both direct SELECTs above should
--   -- return real rows (subject to normal tenant scoping).
--
-- ROLLBACK SQL: revert each policy to its PRE-migration definition (the
-- exact prior policy text must come from whatever migration originally
-- created it -- 20240619000000_tenant_isolation.sql /
-- 20260727000001_security_hardening.sql -- since this migration's own
-- DROP POLICY statements do not preserve the old policy's SQL text
-- anywhere; re-create each dropped policy using its original CREATE
-- POLICY statement from that source file). This is the one rollback in
-- this migration set that is NOT a trivial one-liner, specifically
-- because "restore the previous, looser policy" requires knowing what
-- that policy actually was, not just dropping the new one. No data loss
-- either way -- rolling back only changes who can read/write, not any
-- stored data.
--
-- END OF ROLE-LEVEL RLS HARDENING MIGRATION
-- ============================================================
