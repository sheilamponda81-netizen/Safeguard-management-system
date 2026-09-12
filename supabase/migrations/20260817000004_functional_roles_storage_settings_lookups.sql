-- ============================================================
-- MIGRATION: Storage, system_settings, and lookup-table policies for the
-- functional-roles rollout (Phase B, part 4)
-- Date: 2026-08-17
-- SECURITY-RECONCILED (2026-09-08, production preflight): each of the 3
-- company-logo storage.objects policies below now ALSO explicitly
-- requires is_current_user_active() = true, not only
-- is_super_admin()/is_business_admin(). This bucket's policies have no
-- tenant_id/get_current_tenant_id() check at all (a single shared bucket,
-- not tenant-scoped), so is_business_admin() was the ONLY gate -- and
-- while 20260817000000's is_business_admin() has itself been hardened to
-- fail closed for an inactive caller, this file adds the same explicit,
-- redundant active-user check already used elsewhere in this migration
-- set (e.g. 20260817000001's region-reassignment guards) as defense in
-- depth, so this file's own policies are self-evidently correct without
-- depending on a caller correctly reasoning through is_business_admin()'s
-- internal implementation. Logo upload/update/delete functionality and
-- the Admin-only access decision are otherwise byte-for-byte unchanged.
-- ============================================================
--
-- PART 1 -- company-logo storage bucket (item 38): write access tightened
-- from "Admin or Manager" (role_level <= 2) to ADMIN ONLY. The new
-- hr_manager/accountant/operations_manager functional roles are
-- deliberately NOT granted logo-upload rights just because the legacy
-- Manager role_level happened to have them -- there is no
-- 'company_logo.manage'-style permission in the seeded role_permissions
-- matrix for any of the three new roles, and none should be added here.
-- is_business_admin() (role = 'admin' OR role_level = 1) is used instead of
-- a bare `current_user_role_level() = 1` check specifically so a NEW
-- functional Admin account (role = 'admin', role_level = NULL by design --
-- see 20260817000000's header) is also covered; a bare role_level check
-- would NOT match a new Admin account, since role_level is intentionally
-- NULL for every new functional-role account.
--
-- REAL BEHAVIOR CHANGE: an existing legacy Manager (role_level = 2, role
-- text NOT 'admin') can no longer upload/replace/delete the company logo
-- after this migration -- confirmed intentional per item 38.
-- ============================================================

-- Drops the correct repo-lineage name ("Admins and managers..."), a
-- singular-"Admin" variant ("Admin and managers...") that repository
-- history never created but that direct live STAGING pg_policies
-- evidence confirmed actually exists there after this migration was
-- first applied -- real deployed-state drift from the committed
-- migration lineage, not something this file's own history explains --
-- AND this migration's own new/current name ("Admins can ... company
-- logo"), immediately before that same name's CREATE POLICY below.
-- Since Production may carry the drift variant, this migration is made
-- defensive against both known pre-existing naming variants rather than
-- assuming the repo's own history is the complete picture of what's
-- actually live; the new-name DROP is what actually makes a SECOND
-- application of this migration safe (RUN TWICE below), since without
-- it a re-run's CREATE POLICY would fail with "policy already exists"
-- the moment the first application's own new-named policy is already in
-- place. Each DROP is IF EXISTS, so this is safe/idempotent regardless
-- of which variant (if any) is actually present in a given environment.
DROP POLICY IF EXISTS "Admins and managers can upload company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admin and managers can upload company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admins can upload company logo" ON storage.objects;
CREATE POLICY "Admins can upload company logo" ON storage.objects
FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'company-logo'
  AND is_current_user_active() = true
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Admins and managers can update company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admin and managers can update company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admins can update company logo" ON storage.objects;
CREATE POLICY "Admins can update company logo" ON storage.objects
FOR UPDATE TO authenticated USING (
  bucket_id = 'company-logo'
  AND is_current_user_active() = true
  AND (is_super_admin() = true OR is_business_admin() = true)
) WITH CHECK (
  bucket_id = 'company-logo'
  AND is_current_user_active() = true
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Admins and managers can delete company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admin and managers can delete company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete company logo" ON storage.objects;
CREATE POLICY "Admins can delete company logo" ON storage.objects
FOR DELETE TO authenticated USING (
  bucket_id = 'company-logo'
  AND is_current_user_active() = true
  AND (is_super_admin() = true OR is_business_admin() = true)
);

-- "Public read access for company logo" (SELECT policy) is UNCHANGED --
-- not touched by this migration, per the original migration's own
-- reasoning (pre-login Sidebar/Login.tsx display, not sensitive data).

-- ============================================================
-- PART 2 -- system_settings (item 39): only INSERT/UPDATE (write access)
-- are tightened to Admin only. SELECT is DELIBERATELY LEFT AS-IS --
-- tenant-wide for any active tenant member, exactly matching existing
-- production behavior -- see the RELEASE-BLOCKING CORRECTION note
-- immediately below for why.
--
-- INSERT/UPDATE: previously required role_level = 1. No new role has any
-- 'settings.manage' permission in the seeded matrix (deliberately --
-- writing Settings stays Admin-only under the new model too, matching
-- the legacy "settings" nav page already being role_level-1-only per
-- src/App.tsx's rolePages), so has_permission('settings.manage')
-- resolves to exactly "is_business_admin(), nothing else" today -- using
-- has_permission() rather than a bare is_business_admin() check simply
-- future-proofs this policy the same way every other permission-gated
-- policy in this rollout is written, at no cost since no role_permissions
-- row exists to widen it beyond Admin.
--
-- RELEASE-BLOCKING CORRECTION (2026-09-10, production preflight): an
-- earlier version of this file also tightened system_settings SELECT to
-- Admin-only (via has_permission('settings.view')). A read-only source
-- audit against the live frontend proved that regresses production: this
-- table is the shared key/value store behind getSystemCurrentMonth()
-- (src/utils/currentMonth.ts), getPayrollRates() (src/utils/
-- payrollSettings.ts), and getCompanySettings() (src/utils/
-- companySettings.ts), and those are called directly -- unconditionally,
-- on page init, with no permission gate of their own -- from live code
-- reachable by hr_manager (Dashboard, Salary Advances), accountant
-- (Payroll, Payslips, Payments, Dashboard, Reports, Salary Advances), and
-- operations_manager (Dashboard, Attendance, Reports), plus
-- src/components/Sidebar.tsx (every authenticated session, any role,
-- reads getCompanySettings() for the logo on every page).
--
-- Because a denied SELECT returns zero rows with NO error (RLS filters
-- silently, it does not raise), none of these call sites fail loudly --
-- each one's existing try/catch treats "no data" as "no setting exists
-- yet" and silently substitutes a hardcoded fallback (a fixed default
-- month, fixed default PAYE/deduction rates, fixed placeholder company
-- info) instead of the real, Admin-configured value. For payroll rates
-- specifically this is a live financial-correctness regression, not
-- merely cosmetic: src/pages/Payroll.tsx and src/pages/Payslips.tsx feed
-- getPayrollRates()'s result directly into the deduction/PAYE figures an
-- Accountant computes and submits, so an Admin-only SELECT would silently
-- replace the tenant's real configured rates with generic defaults for
-- exactly the functional role this rollout exists to support.
--
-- The fix is SELECT-only: restore the original tenant-wide policy verbatim
-- (same name, same predicate the table has always used), so every
-- existing direct SELECT caller keeps working exactly as it does in
-- production today. This does not reopen any INSERT/UPDATE/DELETE gap --
-- writes stay Admin-only (below) exactly as this migration intended, and
-- the values readable here (payroll rates, current month, company info)
-- are the same non-secret operational settings already tenant-wide
-- readable in production; no new key was ever added, and no permission is
-- added or removed from any role by this correction.
-- ============================================================

DROP POLICY IF EXISTS "Admins can view settings in their tenant" ON system_settings;
DROP POLICY IF EXISTS "Users can view settings in their tenant" ON system_settings;
CREATE POLICY "Users can view settings in their tenant" ON system_settings
FOR SELECT USING (
  tenant_id = get_current_tenant_id() OR is_super_admin() = true
);

DROP POLICY IF EXISTS "Admins can insert settings in their tenant" ON system_settings;
CREATE POLICY "Admins can insert settings in their tenant" ON system_settings
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR has_permission('settings.manage'))
);

DROP POLICY IF EXISTS "Admins can update settings in their tenant" ON system_settings;
CREATE POLICY "Admins can update settings in their tenant" ON system_settings
FOR UPDATE USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR has_permission('settings.manage'))
) WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR has_permission('settings.manage'))
);

-- "Super admins can delete settings" (DELETE policy) is UNCHANGED --
-- already stricter than "Admin only" (super-admin only), not touched.

-- ============================================================
-- PART 3 -- lookup tables (regions / positions / companies) (item 19):
-- NO POLICY CHANGE. Documented here rather than silently skipped.
--
-- Every existing SELECT/INSERT/UPDATE/DELETE policy on these three tables
-- (20260727000000_reconstructed_base_schema.sql) already reads
-- `tenant_id = get_current_tenant_id() OR is_super_admin() = true` with NO
-- role_level gate -- any authenticated tenant member can read AND write
-- them today, which item 19 confirms is correct for READ ("readable by any
-- active tenant member") and does not ask to be narrowed for WRITE either
-- (no 'regions.manage'/'positions.manage'/'companies.manage' permission
-- exists in the seeded matrix, and none of the four functional roles were
-- given one).
--
-- The "add is_current_user_active() for consistency" step identified
-- during design turned out to be ALREADY SATISFIED, for free, by Part 0 of
-- 20260817000000_functional_role_permissions_foundation.sql: these
-- policies' only gate is `tenant_id = get_current_tenant_id() OR
-- is_super_admin() = true`, and BOTH get_current_tenant_id() and
-- is_super_admin() were redefined in that migration to return NULL/false
-- for any inactive or soft-deleted profile. An inactive user's
-- get_current_tenant_id() is NULL (never equal to any real tenant_id) and
-- is_super_admin() is false, so the whole USING/WITH CHECK expression is
-- already false for them -- adding an explicit is_current_user_active()
-- check here would be redundant, not a fix. This is exactly the
-- "centralize in the 3 shared helpers instead of touching every policy"
-- payoff described in that migration's own header. No SQL statement in
-- this PART -- documented as a deliberate no-op finding, not an omission.
-- ============================================================

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- every change is `DROP POLICY IF
-- EXISTS` (old name(s), INCLUDING this migration's own current name) +
-- `CREATE POLICY` (current name). The 3 storage.objects write policies
-- each drop 3 names (the repo-lineage name, the known drift variant, and
-- their own current "Admins can ... company logo" name) before creating;
-- the system_settings policies each drop their own current name before
-- creating. A second application is safe: every `DROP POLICY IF EXISTS`
-- is a no-op the second time (the row is already gone), and every
-- `CREATE POLICY` then runs against a guaranteed-absent name.
--
-- DEPENDENCIES: requires 20260817000000_functional_role_permissions_foundation.sql
-- (is_business_admin(), has_permission()) to already be applied. Must be
-- applied AFTER 20260730000000_company_logo_storage.sql and
-- 20260803000000_role_level_rls_hardening.sql (whose policies these
-- replace).
--
-- LOCKING / PRODUCTION TRAFFIC IMPACT: policy-only changes -- no table
-- alter, no data touched.
--
-- BEHAVIOR CHANGES FOR EXISTING CALLERS (confirmed intentional, flagged
-- for STAGING verification before relying on them):
--   1. A legacy Manager (role_level = 2) can no longer upload/replace/
--      delete the company logo.
--   2. A legacy Manager/Supervisor/Staff (and new hr_manager/accountant/
--      operations_manager) account can no longer INSERT/UPDATE
--      system_settings rows directly -- write access is now Admin-only.
--      SELECT is UNCHANGED from existing production behavior -- every
--      active tenant member (any role, legacy or functional) can still
--      read system_settings directly, exactly as before this migration.
--      This is deliberate, not an oversight: see the RELEASE-BLOCKING
--      CORRECTION note above PART 2 for why a non-Admin-readable
--      system_settings is required by live code (getSystemCurrentMonth(),
--      getPayrollRates(), getCompanySettings()) reachable by hr_manager,
--      accountant, operations_manager, and every authenticated session
--      via Sidebar.tsx's logo fetch.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'storage'
--     AND tablename = 'objects' AND policyname LIKE '%company logo%' ORDER BY cmd;
--   -- expected: EXACTLY 4 rows total -- SELECT = "Public read access for
--   -- company logo" (unchanged), INSERT/UPDATE/DELETE = "Admins can ...
--   -- company logo" -- confirms neither legacy name ("Admins and
--   -- managers..." from repo lineage, or the "Admin and managers..."
--   -- singular-typo variant confirmed present on live STAGING via direct
--   -- pg_policies evidence) survived alongside the new Admin-only ones.
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'system_settings' ORDER BY cmd;
--   -- expected: EXACTLY 4 rows -- SELECT = "Users can view settings in
--   -- their tenant" (unchanged tenant-wide policy), INSERT/UPDATE =
--   -- "Admins can ... settings in their tenant", DELETE = "Super admins
--   -- can delete settings". Confirms only one SELECT policy exists (no
--   -- leftover "Admins can view settings in their tenant" row from an
--   -- earlier, superseded version of this migration).
--   -- Functional check: as a legacy Manager/Supervisor/Staff or a new
--   -- hr_manager/accountant/operations_manager session --
--   --   SELECT * FROM system_settings;                    -- expect real
--   --     rows back (tenant-wide read, unchanged from pre-migration).
--   --   INSERT/UPDATE on system_settings directly           -- expect
--   --     denial (0 rows affected / permission error).
--   -- As an Admin (legacy role_level = 1, or new role = 'admin') or super
--   -- admin session -- expect SELECT and INSERT/UPDATE to both succeed,
--   -- matching pre-migration behavior.
--
-- ROLLBACK SQL (safe at any time -- restores the pre-functional-roles
-- policies verbatim):
--   DROP POLICY IF EXISTS "Admins can upload company logo" ON storage.objects;
--   CREATE POLICY "Admins and managers can upload company logo" ON storage.objects
--   FOR INSERT TO authenticated WITH CHECK (
--     bucket_id = 'company-logo' AND (is_super_admin() = true OR current_user_role_level() <= 2)
--   );
--   DROP POLICY IF EXISTS "Admins can update company logo" ON storage.objects;
--   CREATE POLICY "Admins and managers can update company logo" ON storage.objects
--   FOR UPDATE TO authenticated USING (
--     bucket_id = 'company-logo' AND (is_super_admin() = true OR current_user_role_level() <= 2)
--   ) WITH CHECK (
--     bucket_id = 'company-logo' AND (is_super_admin() = true OR current_user_role_level() <= 2)
--   );
--   DROP POLICY IF EXISTS "Admins can delete company logo" ON storage.objects;
--   CREATE POLICY "Admins and managers can delete company logo" ON storage.objects
--   FOR DELETE TO authenticated USING (
--     bucket_id = 'company-logo' AND (is_super_admin() = true OR current_user_role_level() <= 2)
--   );
--   -- SELECT: no action needed -- this migration's corrected version
--   -- already recreates "Users can view settings in their tenant" with
--   -- the exact same name and predicate system_settings had before this
--   -- migration was ever applied, so there is nothing to roll back here.
--   DROP POLICY IF EXISTS "Admins can insert settings in their tenant" ON system_settings;
--   CREATE POLICY "Admins can insert settings in their tenant" ON system_settings
--   FOR INSERT WITH CHECK (
--     (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
--     AND (current_user_role_level() = 1 OR is_super_admin() = true)
--   );
--   DROP POLICY IF EXISTS "Admins can update settings in their tenant" ON system_settings;
--   CREATE POLICY "Admins can update settings in their tenant" ON system_settings
--   FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
--   WITH CHECK (
--     (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
--     AND (current_user_role_level() = 1 OR is_super_admin() = true)
--   );
-- ============================================================
