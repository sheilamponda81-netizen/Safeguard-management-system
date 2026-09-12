-- ============================================================
-- MIGRATION: Company logo storage bucket
-- Date: 2026-07-30 (revised -- see "REVISION" note below)
-- ============================================================
--
-- Settings -> Company can now upload a real company logo (src/utils/
-- companySettings.ts's uploadCompanyLogo), replacing the placeholder Shield
-- icon shown in the sidebar and on payslips. The uploaded file needs
-- somewhere to live -- this creates a public-read storage bucket for it.
--
-- Public read (not tenant-scoped) is a deliberate simplification: the logo
-- is shown in the app's Sidebar and on Payslips (both authenticated
-- contexts already gated by normal login), and is not sensitive data --
-- same trust level as a company's public website.
--
-- REVISION (business decision, this pass): write access (INSERT/UPDATE/
-- DELETE) was originally "any authenticated user" -- that's wider than
-- the app's own UI ever allows (Settings -> Company, where the upload
-- control lives, is role_level 1 only per src/App.tsx's rolePages), and
-- meant a Supervisor/Staff account could replace or delete the shared
-- company logo file via a direct API call despite having no such control
-- anywhere in the UI. Write access is now restricted to
-- Admin (role_level 1) / Manager (role_level 2) / Super Admin, using the
-- same two helper functions every other role-aware policy in this schema
-- uses (public.is_super_admin(), public.current_user_role_level(), both
-- already defined by 20260727000001_security_hardening.sql, which runs
-- before this migration). Supervisor (role_level 3) and Staff (role_level
-- 4) can no longer INSERT/UPDATE/DELETE this bucket's objects. Read stays
-- public, unchanged -- the logo itself is still not sensitive data, and
-- narrowing read would break the pre-login Sidebar/Login.tsx logo display
-- this bucket exists for in the first place.
--
-- The shared file path in uploadCompanyLogo() ("logo.<ext>") means a
-- re-upload simply replaces the previous file rather than accumulating
-- orphaned ones -- unchanged by this revision.
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('company-logo', 'company-logo', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public read access for company logo" ON storage.objects;
CREATE POLICY "Public read access for company logo" ON storage.objects
FOR SELECT USING (bucket_id = 'company-logo');

DROP POLICY IF EXISTS "Authenticated users can upload company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admins and managers can upload company logo" ON storage.objects;
CREATE POLICY "Admins and managers can upload company logo" ON storage.objects
FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'company-logo'
  AND (public.is_super_admin() = true OR public.current_user_role_level() <= 2)
);

DROP POLICY IF EXISTS "Authenticated users can update company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admins and managers can update company logo" ON storage.objects;
CREATE POLICY "Admins and managers can update company logo" ON storage.objects
FOR UPDATE TO authenticated USING (
  bucket_id = 'company-logo'
  AND (public.is_super_admin() = true OR public.current_user_role_level() <= 2)
) WITH CHECK (
  bucket_id = 'company-logo'
  AND (public.is_super_admin() = true OR public.current_user_role_level() <= 2)
);

DROP POLICY IF EXISTS "Authenticated users can delete company logo" ON storage.objects;
DROP POLICY IF EXISTS "Admins and managers can delete company logo" ON storage.objects;
CREATE POLICY "Admins and managers can delete company logo" ON storage.objects
FOR DELETE TO authenticated USING (
  bucket_id = 'company-logo'
  AND (public.is_super_admin() = true OR public.current_user_role_level() <= 2)
);

-- ============================================================
-- MIGRATION SAFETY NOTES (added this revision)
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent either way -- every policy change is
-- `DROP POLICY IF EXISTS` (both the original and the current name, so
-- this is safe to re-run whether the ORIGINAL wide-open policies or this
-- revision's own restricted policies are currently in place) followed by
-- `CREATE POLICY`.
--
-- DEPENDENCIES: requires public.is_super_admin() and
-- public.current_user_role_level() to already exist --
-- 20260727000001_security_hardening.sql (which defines
-- current_user_role_level()) is dated/ordered before this migration, so
-- this is already satisfied by this repo's own migration order; if ever
-- applied out of order, this migration would fail with a clear
-- "function does not exist" error rather than silently misbehaving.
--
-- PREFLIGHT: none needed -- policy changes only, no data touched.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT policyname, cmd FROM pg_policies
--     WHERE schemaname = 'storage' AND tablename = 'objects'
--     AND policyname LIKE '%company logo%' ORDER BY cmd;
--   -- Expected: SELECT = "Public read access for company logo",
--   -- INSERT/UPDATE/DELETE = "Admins and managers can ... company logo".
--   -- As a Supervisor or Staff session: attempt to upload/replace/delete
--   -- the 'company-logo' bucket's object directly -- expect denial.
--   -- As an Admin or Manager session: same attempt -- expect success.
--
-- ROLLBACK SQL (safe at any time -- widens write access back to any
-- authenticated user, does not affect the stored logo file itself):
--   DROP POLICY IF EXISTS "Admins and managers can upload company logo" ON storage.objects;
--   CREATE POLICY "Authenticated users can upload company logo" ON storage.objects
--   FOR INSERT TO authenticated WITH CHECK (bucket_id = 'company-logo');
--   DROP POLICY IF EXISTS "Admins and managers can update company logo" ON storage.objects;
--   CREATE POLICY "Authenticated users can update company logo" ON storage.objects
--   FOR UPDATE TO authenticated USING (bucket_id = 'company-logo') WITH CHECK (bucket_id = 'company-logo');
--   DROP POLICY IF EXISTS "Admins and managers can delete company logo" ON storage.objects;
--   CREATE POLICY "Authenticated users can delete company logo" ON storage.objects
--   FOR DELETE TO authenticated USING (bucket_id = 'company-logo');
-- ============================================================
