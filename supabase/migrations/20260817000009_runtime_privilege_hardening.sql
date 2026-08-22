-- ============================================================
-- MIGRATION: Runtime privilege hardening -- anon/authenticated grants
-- Date: 2026-08-21
-- ============================================================
--
-- THIS IS NOT DESIGN B2 PHASE C. Phase C (REVOKE SELECT ON employees FROM
-- authenticated/PUBLIC + column-level re-GRANT of the 37 safe columns) is
-- a separate, later, not-yet-approved migration and is not touched here.
-- Nothing in this file changes any table's SELECT privilege, and nothing
-- here changes RLS policies -- this migration only narrows table-level
-- GRANTs (INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES) and function
-- EXECUTE grants, which are a layer BELOW RLS, not a replacement for it.
--
-- WHY THIS EXISTS
-- -----------------------------------------------------------
-- STAGING was directly verified to grant `anon`/`authenticated` broad
-- table-level privileges on `system_settings`, `employees`, `companies`,
-- `regions`, `positions`, and (by the same pattern) every other
-- application table -- including TRUNCATE, TRIGGER, and REFERENCES. None
-- of the prior migrations in this repository touch these grants (a
-- repo-wide grep of every *.sql file for `GRANT`/`REVOKE ... ON <table>`
-- confirms only `role_permissions` (20260817000005) and the two employee
-- read-surface views (20260817000008) have ever had their table-level
-- privileges narrowed). RLS does not protect against TRUNCATE at all --
-- it is a table-level operation, not a row-level one -- so a role holding
-- TRUNCATE can empty an entire table regardless of any policy. TRIGGER
-- and REFERENCES are DDL-adjacent privileges (create a trigger on the
-- table / create a FK referencing it) that the application never issues
-- at runtime; only migrations do, running as the schema owner, which this
-- migration does not affect.
--
-- METHOD: every REVOKE below names an EXPLICIT privilege list -- never
-- `REVOKE ALL` -- so a privilege this migration does not mention is left
-- exactly as it is today. `service_role` is never referenced anywhere in
-- this file: Edge Functions (`create-user`, `disable-user`) and every
-- SECURITY DEFINER RPC run with their OWN elevated privileges (the
-- function owner's, for SECURITY DEFINER; the service key's, for Edge
-- Functions), independent of `authenticated`'s/`anon`'s own table grants
-- -- narrowing those two roles has no effect on either.
--
-- EVIDENCE: every DML privilege kept or revoked for `authenticated` below
-- is backed by a repository-wide search of `src/**/*.{ts,tsx}` for
-- `.from('<table>')` followed by `.insert(`/`.update(`/`.delete(` (this
-- migration's own PART 2 lists the exact finding per table), not a guess.
-- ============================================================

-- ============================================================
-- PART 1: SECURITY DEFINER function EXECUTE hardening
-- ============================================================
--
-- `get_current_tenant_id()`, `is_super_admin()`, and
-- `current_user_role_level()` have never had PostgreSQL's default
-- PUBLIC-EXECUTE grant revoked, in any migration from their original
-- definition (20260727000000 / 20260727000001) through their most recent
-- redefinition (20260817000000) -- confirmed by grepping every
-- migration file in this repo for `GRANT`/`REVOKE` referencing these
-- three function names: zero matches. Every OTHER helper defined
-- alongside them in 20260817000000 (current_user_role,
-- current_user_region_id, is_current_user_active, is_business_admin,
-- region_allowed, has_permission, get_my_permissions) already has an
-- explicit `REVOKE ALL ... FROM PUBLIC` + `GRANT EXECUTE ... TO
-- authenticated` in that same migration -- these three were simply
-- missed. All three are used INSIDE RLS policy USING/WITH CHECK clauses
-- throughout this schema, evaluated as the querying `authenticated` role,
-- so `authenticated` EXECUTE must be (re-)granted in the same statement
-- that revokes PUBLIC, or every policy referencing them would start
-- failing with "permission denied for function" the moment PUBLIC is
-- revoked.
REVOKE ALL ON FUNCTION get_current_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION is_super_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION current_user_role_level() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_current_tenant_id() FROM anon;
REVOKE ALL ON FUNCTION is_super_admin() FROM anon;
REVOKE ALL ON FUNCTION current_user_role_level() FROM anon;
GRANT EXECUTE ON FUNCTION get_current_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION current_user_role_level() TO authenticated;

-- `prevent_profile_privilege_escalation()`, `guard_employee_region_reassignment()`,
-- and `guard_applicant_region_assignment()` are all SECURITY DEFINER
-- trigger functions (BEFORE UPDATE/INSERT triggers on profiles/employees/
-- applicants respectively) -- nothing in this app calls any of them
-- directly via RPC, and PostgreSQL trigger firing does not require the
-- DML-issuing role to hold EXECUTE on the trigger function itself (that
-- check applies to a direct `SELECT function_name()`-style call, not to
-- automatic trigger invocation, which runs under the trigger's own
-- definer/invoker semantics regardless of the caller's function-level
-- grants). None of the three has ever had an explicit GRANT/REVOKE
-- either -- confirmed by the same repo-wide grep -- so they still carry
-- PostgreSQL's default PUBLIC-EXECUTE grant despite never needing it.
-- Revoking it removes a direct-RPC-call surface (e.g. a client could
-- otherwise call `SELECT guard_employee_region_reassignment()` directly,
-- pointlessly, but still an unnecessary SECURITY DEFINER entry point)
-- with zero effect on the triggers themselves, which keep firing exactly
-- as before. No GRANT TO authenticated is added for any of the three --
-- none is required.
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_employee_region_reassignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_applicant_region_assignment() FROM PUBLIC;

-- ============================================================
-- PART 2: table-level privilege hardening
-- ============================================================
--
-- PART 2a -- anon: no legitimate pre-login direct public-table access
-- exists anywhere in this app (Supabase Auth itself handles login via
-- `auth.*`, never `public.*`). Every real application table gets an
-- EXPLICIT privilege list revoked -- not `REVOKE ALL`, so this cannot
-- accidentally touch a privilege on some future table this statement
-- doesn't name. `role_permissions` (20260817000005) and the
-- `employees_general`/`employees_security` views (20260817000008)
-- already have `anon` fully revoked and are intentionally not repeated
-- here.
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON employees, payroll, attendance, applicants, payment_status,
   employee_deductions, terminal_dues, profiles, regions, positions,
   companies, user_roles, system_settings, audit_logs, salary_advances,
   salary_advance_deductions, salary_advance_repayment_plans,
   salary_advance_repayment_plan_changes, tenants, guard_id_counters,
   employee_number_counters
FROM anon;

-- PART 2b -- authenticated, universal: TRUNCATE/TRIGGER/REFERENCES are
-- never issued by this application at runtime (no `.truncate()` in
-- supabase-js; CREATE TRIGGER / ADD CONSTRAINT ... REFERENCES are DDL,
-- issued only by migrations, which run as the schema owner and are
-- unaffected by revoking these three from `authenticated`). Revoked
-- across every application table uniformly, with no exceptions.
REVOKE TRUNCATE, TRIGGER, REFERENCES
ON employees, payroll, attendance, applicants, payment_status,
   employee_deductions, terminal_dues, profiles, regions, positions,
   companies, user_roles, system_settings, audit_logs, salary_advances,
   salary_advance_deductions, salary_advance_repayment_plans,
   salary_advance_repayment_plan_changes, tenants, guard_id_counters,
   employee_number_counters
FROM authenticated;

-- PART 2c -- authenticated, per-table DML narrowing. Each REVOKE below
-- is backed by a repo-wide `src/**/*.{ts,tsx}` search for
-- `.from('<table>')...insert(/update(/delete(`; only a privilege with
-- ZERO confirmed direct-browser call site is revoked. RLS continues to
-- gate every row this migration leaves table-level access to.

-- employees: Employees.tsx/Security.tsx confirmed .insert()/.update()
-- (soft-delete is an UPDATE of is_deleted, not a real DELETE) -- zero
-- `.from('employees')...delete(` call sites found anywhere in src/.
-- INSERT/UPDATE/SELECT untouched (Phase C, employees' SELECT column
-- scope, is explicitly NOT part of this migration).
REVOKE DELETE ON employees FROM authenticated;

-- payroll: process_payroll_batch() (SECURITY DEFINER) performs the only
-- INSERT/DELETE, atomically, as its own owner -- authenticated never
-- needs table-level INSERT/DELETE for that RPC to work. The one
-- confirmed direct write is Payroll.tsx's approve/reject `.update()`.
REVOKE INSERT, DELETE ON payroll FROM authenticated;

-- attendance: grid marking + copy-from-previous-month confirmed
-- .insert()/.update(); zero `.delete()` call sites found.
REVOKE DELETE ON attendance FROM authenticated;

-- employee_deductions: Attendance.tsx's deduction modal confirmed
-- .insert()/.update(); zero `.delete()` call sites found.
REVOKE DELETE ON employee_deductions FROM authenticated;

-- applicants: Recruitment.tsx confirmed .insert()/.update(); zero
-- `.delete()` call sites found anywhere in src/ despite an
-- "Applicants: delete within tenant+region..." RLS policy existing
-- (20260817000001) -- the policy is present for completeness/future use,
-- but nothing in the app currently exercises it.
REVOKE DELETE ON applicants FROM authenticated;

-- payment_status: Payments.tsx confirmed .insert()/.update(); zero
-- `.delete()` call sites found.
REVOKE DELETE ON payment_status FROM authenticated;

-- terminal_dues: TerminalDues.tsx confirmed .insert()/.update(); zero
-- `.delete()` call sites found.
REVOKE DELETE ON terminal_dues FROM authenticated;

-- system_settings: Misc.tsx/settings pages confirmed .insert()/.update();
-- zero `.delete()` call sites found.
REVOKE DELETE ON system_settings FROM authenticated;

-- profiles: ARCHITECTURAL DECISION -- browser self-profile creation is
-- retired; the only approved user-creation path is the server-side
-- create-user Edge Function (supabase/functions/create-user/index.ts),
-- which resolves and inserts tenant_id itself via the service-role
-- connection ("tenant_id: callerProfile.tenant_id, // server-resolved,
-- never client-supplied") -- confirmed by a repo-wide search: zero
-- `.from('profiles')...insert(` call sites anywhere in src/. Direct
-- `.update()` remains (role/is_active edits in UserManagement.tsx, own-
-- profile edits in lib/supabase.ts), protected by
-- prevent_profile_privilege_escalation()'s BEFORE UPDATE trigger. Zero
-- `.delete()` call sites found either, despite a
-- "Super admins can delete profiles" RLS policy existing.
REVOKE INSERT, DELETE ON profiles FROM authenticated;

-- companies: read-only from the frontend -- confirmed by a repo-wide
-- search: every `.from('companies')` call site is a `.select()` (company-
-- name normalization/autocomplete in Employees.tsx); zero
-- insert/update/delete call sites found anywhere. Company names are
-- derived from `employees.company` text, not managed through a
-- dedicated CRUD page.
REVOKE INSERT, UPDATE, DELETE ON companies FROM authenticated;

-- audit_logs: ARCHITECTURAL DECISION -- append-only. Confirmed by a
-- repo-wide search: every `.from('audit_logs')` write call site is an
-- `.insert()` (utils/auditLogger.ts); zero update/delete call sites found
-- anywhere. Revoking UPDATE/DELETE enforces immutability at the grant
-- level, not merely by RLS omission.
REVOKE UPDATE, DELETE ON audit_logs FROM authenticated;

-- salary_advances: CORRECTS an initial assumption that this table's
-- mutations are RPC-only. SalaryAdvances.tsx's own code comment confirms
-- `.from('salary_advances').insert()` "is rejected by RLS unconditionally
-- (no INSERT policy exists), because only the RPC can take the
-- employee-scoped advisory lock the max-2-open-advances count check
-- needs" -- so INSERT is correctly revoked. BUT `updateAdvanceStatus()`
-- performs a real, deliberate direct `.from('salary_advances').update({
-- status, ... })` to reject/cancel a PENDING advance ("still allowed by
-- RLS/the guard trigger because neither transition touches the combined
-- plan" -- approving, which DOES touch the combined plan, goes through
-- approve_salary_advance() only). UPDATE must therefore stay granted, not
-- be revoked. Zero `.delete()` call sites found.
REVOKE INSERT, DELETE ON salary_advances FROM authenticated;

-- salary_advance_deductions / salary_advance_repayment_plans /
-- salary_advance_repayment_plan_changes: zero direct insert/update/delete
-- call sites found anywhere in src/ for any of the three -- all writes to
-- these three tables happen exclusively inside create_salary_advance(),
-- approve_salary_advance(), and adjust_combined_repayment_plan() (all
-- SECURITY DEFINER), which do not need table-level DML granted to
-- `authenticated` to perform their own writes as their function owner.
REVOKE INSERT, UPDATE, DELETE ON salary_advance_deductions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON salary_advance_repayment_plans FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON salary_advance_repayment_plan_changes FROM authenticated;

-- tenants: zero direct insert/update/delete call sites found anywhere in
-- src/ -- no app UI provisions or edits tenants; only a tenant's own row
-- is ever read (via RLS: `id = get_current_tenant_id() OR
-- is_super_admin()`).
REVOKE INSERT, UPDATE, DELETE ON tenants FROM authenticated;

-- guard_id_counters / employee_number_counters: purely internal state for
-- generate_guard_id()/generate_employee_number() (both SECURITY DEFINER,
-- owner-privileged) -- zero direct call sites of ANY kind (not even
-- `.select()`) found anywhere in src/. `authenticated` needs no privilege
-- on either table at all.
REVOKE SELECT, INSERT, UPDATE, DELETE ON guard_id_counters FROM authenticated;
REVOKE SELECT, INSERT, UPDATE, DELETE ON employee_number_counters FROM authenticated;

-- regions / positions / user_roles: full CRUD confirmed in use (Settings
-- pages), Admin-gated by RLS (20260817000005) -- no DML narrowed here
-- beyond the universal TRUNCATE/TRIGGER/REFERENCES revoke in PART 2b.

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- every REVOKE is safe to re-run;
-- revoking a privilege a role does not currently hold is a no-op, not an
-- error.
--
-- DEPENDENCIES: requires every function/table this file references to
-- already exist -- i.e. this migration must run after
-- 20260817000000 through 20260817000008 (patched), which create the
-- functions and tables named above.
--
-- NOT TOUCHED, DELIBERATELY: `employees` base-table SELECT (Phase C,
-- separate/unapproved), `service_role` (Edge Functions/RPCs unaffected by
-- anon/authenticated grants), RLS policies (unchanged -- this migration
-- only removes privileges BELOW what RLS already restricts further),
-- `regions`/`positions`/`user_roles` DML (confirmed still needed
-- unchanged), `role_permissions`/`employees_general`/`employees_security`
-- (already hardened by prior migrations, not repeated here).
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT has_table_privilege('authenticated', 'employees', 'DELETE');
--   SELECT has_table_privilege('authenticated', 'payroll', 'INSERT');
--   SELECT has_table_privilege('authenticated', 'guard_id_counters', 'SELECT');
--   SELECT has_table_privilege('anon', 'system_settings', 'SELECT');
--   -- expected: false, false, false, false
--   SELECT has_table_privilege('authenticated', 'salary_advances', 'UPDATE');
--   SELECT has_table_privilege('authenticated', 'employees', 'SELECT');
--   SELECT has_table_privilege('authenticated', 'regions', 'DELETE');
--   -- expected: true, true, true
--   SELECT has_function_privilege('authenticated', 'is_super_admin()', 'EXECUTE');
--   SELECT has_function_privilege('anon', 'is_super_admin()', 'EXECUTE');
--   -- expected: true, false
--
-- ROLLBACK SQL (safe at any time -- restores the exact grants this
-- migration removed; does not touch any row of data):
--   GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--   ON employees, payroll, attendance, applicants, payment_status,
--      employee_deductions, terminal_dues, profiles, regions, positions,
--      companies, user_roles, system_settings, audit_logs, salary_advances,
--      salary_advance_deductions, salary_advance_repayment_plans,
--      salary_advance_repayment_plan_changes, tenants, guard_id_counters,
--      employee_number_counters
--   TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION get_current_tenant_id() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION is_super_admin() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION current_user_role_level() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION prevent_profile_privilege_escalation() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION guard_employee_region_reassignment() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION guard_applicant_region_assignment() TO PUBLIC;
--   -- (not recommended -- this restores the exact broad-grant state this
--   -- migration exists to close; use only to unblock an unexpected break.)
-- ============================================================
