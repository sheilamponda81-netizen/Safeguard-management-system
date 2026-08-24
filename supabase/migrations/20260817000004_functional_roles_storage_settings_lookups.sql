-- ============================================================
-- MIGRATION: Storage, system_settings, and lookup-table policies for the
-- functional-roles rollout (Phase B, part 4)
-- Date: 2026-08-17
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

-- Drops BOTH the correct repo-lineage name ("Admins and managers...") AND
-- a singular-"Admin" variant ("Admin and managers...") that repository
-- history never created but that direct live STAGING pg_policies
-- evidence confirmed actually exists there after this migration was
-- first applied -- real deployed-state drift from the committed
-- migration lineage, not something this file's own history explains.
-- Since Production may carry the same drift, this migration is made
-- defensive against both known naming variants rather than assuming the
-- repo's own history is the complete picture of what's actually live.
-- Each DROP is IF EXISTS, so this is safe/idempotent regardless of which
-- variant (if either) is actually present in a given environment.
DROP POLICY IF EXISTS "Admins and managers can upload company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admin and managers can upload company logo" ON storage.objects;
CREATE POLICY "Admins can upload company logo" ON storage.objects
FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'company-logo'
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Admins and managers can update company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admin and managers can update company logo" ON storage.objects;
CREATE POLICY "Admins can update company logo" ON storage.objects
FOR UPDATE TO authenticated USING (
  bucket_id = 'company-logo'
  AND (is_super_admin() = true OR is_business_admin() = true)
) WITH CHECK (
  bucket_id = 'company-logo'
  AND (is_super_admin() = true OR is_business_admin() = true)
);

DROP POLICY IF EXISTS "Admins and managers can delete company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admin and managers can delete company logo" ON storage.objects;
CREATE POLICY "Admins can delete company logo" ON storage.objects
FOR DELETE TO authenticated USING (
  bucket_id = 'company-logo'
  AND (is_super_admin() = true OR is_business_admin() = true)
);

-- "Public read access for company logo" (SELECT policy) is UNCHANGED --
-- not touched by this migration, per the original migration's own
-- reasoning (pre-login Sidebar/Login.tsx display, not sensitive data).

-- ============================================================
-- PART 2 -- system_settings (item 39): view AND manage both tightened to
-- Admin only. Previously: SELECT was tenant-wide for every role_level;
-- INSERT/UPDATE required role_level = 1. No new role has any
-- 'settings.*' permission in the seeded matrix (deliberately -- Settings
-- stays Admin-only under the new model too, matching the legacy "settings"
-- nav page already being role_level-1-only per src/App.tsx's rolePages),
-- so has_permission('settings.view')/('settings.manage') resolves to
-- exactly "is_business_admin(), nothing else" today -- using
-- has_permission() rather than a bare is_business_admin() check simply
-- future-proofs this policy the same way every other permission-gated
-- policy in this rollout is written, at no cost since no role_permissions
-- row exists to widen it beyond Admin.
--
-- REAL BEHAVIOR CHANGE: SELECT on system_settings is no longer tenant-wide
-- -- a legacy Manager/Supervisor/Staff account (or a new hr_manager/
-- accountant/operations_manager account) can no longer read
-- system_settings rows (e.g. current_payroll_month, payroll rate
-- settings) directly. CONFIRM before applying to STAGING/production that
-- no non-Admin page relies on a direct system_settings SELECT for a
-- value it still needs -- src/utils/currentMonth.ts's reads happen via
-- this same table and this same tightened policy, so a non-Admin session
-- calling getSystemCurrentMonth() will now get nothing back. This is
-- flagged explicitly in the final report as a point requiring frontend
-- verification (Phase C) before this is safe to rely on.
-- ============================================================

DROP POLICY IF EXISTS "Users can view settings in their tenant" ON system_settings;
CREATE POLICY "Admins can view settings in their tenant" ON system_settings
FOR SELECT USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (is_super_admin() = true OR has_permission('settings.view'))
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
-- EXISTS` (old name) + `CREATE POLICY` (new name).
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
-- BEHAVIOR CHANGES FOR EXISTING CALLERS (both confirmed intentional,
-- flagged for STAGING verification before relying on them):
--   1. A legacy Manager (role_level = 2) can no longer upload/replace/
--      delete the company logo.
--   2. A legacy Manager/Supervisor/Staff (and new hr_manager/accountant/
--      operations_manager) account can no longer SELECT from
--      system_settings at all -- verify no non-Admin page/utility still
--      depends on a direct read from this table before this reaches
--      STAGING.
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
--   -- expected: SELECT/INSERT/UPDATE = "Admins can ...", DELETE = "Super admins can delete settings"
--   -- Functional check: as a legacy Manager or a new hr_manager/accountant/
--   -- operations_manager session, attempt SELECT/INSERT/UPDATE on
--   -- system_settings directly -- expect denial (0 rows / permission error).
--   -- As an Admin (legacy role_level = 1, or new role = 'admin') or super
--   -- admin session -- expect success, matching pre-migration behavior.
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
--   DROP POLICY IF EXISTS "Admins can view settings in their tenant" ON system_settings;
--   CREATE POLICY "Users can view settings in their tenant" ON system_settings
--   FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);
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
