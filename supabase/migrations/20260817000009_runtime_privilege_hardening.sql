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
-- PART 1: SECURITY DEFINER function EXECUTE hardening (now closed at
-- source everywhere in the chain; this PART is defense-in-depth
-- reinforcement, not the first or only place these are secured)
-- ============================================================
--
-- HISTORY / CORRECTION: this PART originally contained the FIRST fix for
-- `get_current_tenant_id()`, `is_super_admin()`, and
-- `current_user_role_level()` -- which had never had PostgreSQL's/
-- Supabase's default PUBLIC- and anon-EXECUTE grants revoked in any prior
-- migration. That left a real anonymous-execution window open for every
-- migration between their original definition and this one -- exactly
-- the kind of temporary exposure a staged production rollout must not
-- have. Per a later audit (triggered by discovering the same class of gap
-- on `process_payroll_batch()` while applying 20260803000002 to STAGING),
-- the authoritative fix for these 4 functions was moved to
-- 20260803000000_role_level_rls_hardening.sql -- the earliest migration in
-- the controlled apply chain that already touches all 4 by name (for
-- search_path pinning) -- so a fresh apply is correct from the very first
-- migration that mentions them, not just by the time this file runs.
-- `prevent_profile_privilege_escalation()`'s trigger-only treatment
-- (revoke PUBLIC + anon, no authenticated grant) is likewise established
-- there. `guard_employee_region_reassignment()` and
-- `guard_applicant_region_assignment()` are hardened at their own true
-- creation point, 20260817000001_functional_roles_direct_region_tables.sql,
-- for the same reason. CREATE OR REPLACE FUNCTION preserves an existing
-- function's privileges unchanged (same OID, only the body/other
-- attributes change), so none of the redefinitions between those earlier
-- migrations and this one re-opened the window. The statements below are
-- kept as idempotent, redundant reinforcement rather than removed,
-- matching this schema's established self-sufficiency pattern.
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
-- grants). Revoking PUBLIC and anon removes a direct-RPC-call surface
-- (e.g. a client could otherwise call
-- `SELECT guard_employee_region_reassignment()` directly, pointlessly,
-- but still an unnecessary SECURITY DEFINER entry point) with zero effect
-- on the triggers themselves, which keep firing exactly as before. No
-- GRANT TO authenticated is added for any of the three -- none is
-- required.
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_employee_region_reassignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_applicant_region_assignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM anon;
REVOKE ALL ON FUNCTION guard_employee_region_reassignment() FROM anon;
REVOKE ALL ON FUNCTION guard_applicant_region_assignment() FROM anon;
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM authenticated;
REVOKE ALL ON FUNCTION guard_employee_region_reassignment() FROM authenticated;
REVOKE ALL ON FUNCTION guard_applicant_region_assignment() FROM authenticated;

-- ============================================================
-- PART 1b: previously-unaudited dead functions -- found during the
-- broader "audit every other SECURITY DEFINER function / client-callable
-- RPC in the chain" pass triggered by the process_payroll_batch anon-
-- execute discovery. `analyze_query_performance()`, `set_tenant_context()`,
-- and `get_tenant_context()` (20240619000000) and `set_user_tenant()`
-- (20240619000001) are NOT SECURITY DEFINER, but Supabase exposes every
-- function in the `public` schema as a `/rpc/<name>` endpoint regardless
-- of SECURITY DEFINER status, and grants EXECUTE on each directly to
-- `anon`/`authenticated` at creation -- so all 4 have been client-callable
-- since the very first migration, with no revoke of any kind, ever.
-- Confirmed via a repo-wide grep of every `.rpc(` call site in `src/` --
-- none of the 4 is called by this application anywhere.
--
-- `analyze_query_performance(query_text TEXT)` is the most serious of the
-- 4: it runs `EXECUTE 'EXPLAIN ANALYZE ' || query_text`, i.e. dynamic SQL
-- built by directly concatenating caller-supplied text -- a live,
-- reachable-via-API SQL-injection primitive for ANY authenticated (and,
-- absent this fix, anon) caller, entirely independent of RLS, since the
-- injected text is never parameterized. `set_tenant_context()`/
-- `get_tenant_context()` only read/write a session-local GUC (no table
-- access) and `set_user_tenant()` is a trigger function (AFTER INSERT ON
-- auth.users) with no legitimate direct-call use -- lower severity than
-- analyze_query_performance, but still unused dead surface with no
-- legitimate caller. All 4 are locked down completely (PUBLIC, anon, AND
-- authenticated -- unlike the RLS-helper functions above, nothing
-- legitimate in this app calls any of these 4, so no role needs EXECUTE).
--
-- GUARDED, not a bare REVOKE: all 4 were only ever defined in
-- 20240619000000_tenant_isolation.sql, a pre-"reconstructed-base-schema"
-- historical migration that a real, already-bootstrapped STAGING/
-- production project carries (confirmed present there) but that a fresh
-- environment built from 20260727000000_reconstructed_base_schema.sql
-- onward does NOT re-create (confirmed by local replay of this exact
-- migration chain against a disposable Postgres cluster: a bare
-- `REVOKE ... ON FUNCTION analyze_query_performance(TEXT)` fails outright
-- with "function does not exist" on such an environment). `to_regprocedure`
-- returns NULL instead of raising when a signature doesn't exist, so this
-- block is safe to run on either kind of environment.
DO $$
BEGIN
  IF to_regprocedure('public.analyze_query_performance(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION analyze_query_performance(TEXT) FROM PUBLIC;
    REVOKE ALL ON FUNCTION analyze_query_performance(TEXT) FROM anon;
    REVOKE ALL ON FUNCTION analyze_query_performance(TEXT) FROM authenticated;
  END IF;
  IF to_regprocedure('public.set_tenant_context(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION set_tenant_context(UUID) FROM PUBLIC;
    REVOKE ALL ON FUNCTION set_tenant_context(UUID) FROM anon;
    REVOKE ALL ON FUNCTION set_tenant_context(UUID) FROM authenticated;
  END IF;
  IF to_regprocedure('public.get_tenant_context()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION get_tenant_context() FROM PUBLIC;
    REVOKE ALL ON FUNCTION get_tenant_context() FROM anon;
    REVOKE ALL ON FUNCTION get_tenant_context() FROM authenticated;
  END IF;
  IF to_regprocedure('public.set_user_tenant()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION set_user_tenant() FROM PUBLIC;
    REVOKE ALL ON FUNCTION set_user_tenant() FROM anon;
    REVOKE ALL ON FUNCTION set_user_tenant() FROM authenticated;
  END IF;
END;
$$;

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
--   SELECT has_function_privilege('authenticated', 'prevent_profile_privilege_escalation()', 'EXECUTE');
--   SELECT has_function_privilege('authenticated', 'guard_employee_region_reassignment()', 'EXECUTE');
--   SELECT has_function_privilege('authenticated', 'guard_applicant_region_assignment()', 'EXECUTE');
--   -- expected: false, false, false (trigger-only -- no direct client
--   -- EXECUTE for ANY role, including authenticated; triggers keep firing
--   -- regardless, per the note where these are defined)
--   SELECT has_function_privilege('authenticated', 'analyze_query_performance(text)', 'EXECUTE');
--   SELECT has_function_privilege('anon', 'analyze_query_performance(text)', 'EXECUTE');
--   SELECT has_function_privilege('authenticated', 'set_tenant_context(uuid)', 'EXECUTE');
--   SELECT has_function_privilege('authenticated', 'get_tenant_context()', 'EXECUTE');
--   SELECT has_function_privilege('authenticated', 'set_user_tenant()', 'EXECUTE');
--   -- expected: false for all 5 (PART 1b -- fully dead, unused surface).
--   -- Only meaningful on an environment where 20240619000000 was actually
--   -- applied (e.g. real STAGING/production) -- on a fresh environment
--   -- built from 20260727000000 onward, these 4 functions never exist at
--   -- all, and PART 1b's guarded DO block is a no-op for them.
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
--   GRANT EXECUTE ON FUNCTION analyze_query_performance(TEXT) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION set_tenant_context(UUID) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION get_tenant_context() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION set_user_tenant() TO PUBLIC;
--   -- (not recommended -- this restores the exact broad-grant state this
--   -- migration exists to close; use only to unblock an unexpected break.)
-- ============================================================
