-- ============================================================
-- MIGRATION: Company logo storage bucket
-- Date: 2026-07-30
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
-- same trust level as a company's public website. Write access is
-- restricted to authenticated users only; the shared file path in
-- uploadCompanyLogo() ("logo.<ext>") means a re-upload simply replaces
-- the previous file rather than accumulating orphaned ones.
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('company-logo', 'company-logo', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public read access for company logo" ON storage.objects;
CREATE POLICY "Public read access for company logo" ON storage.objects
FOR SELECT USING (bucket_id = 'company-logo');

DROP POLICY IF EXISTS "Authenticated users can upload company logo" ON storage.objects;
CREATE POLICY "Authenticated users can upload company logo" ON storage.objects
FOR INSERT TO authenticated WITH CHECK (bucket_id = 'company-logo');

DROP POLICY IF EXISTS "Authenticated users can update company logo" ON storage.objects;
CREATE POLICY "Authenticated users can update company logo" ON storage.objects
FOR UPDATE TO authenticated USING (bucket_id = 'company-logo') WITH CHECK (bucket_id = 'company-logo');

DROP POLICY IF EXISTS "Authenticated users can delete company logo" ON storage.objects;
CREATE POLICY "Authenticated users can delete company logo" ON storage.objects
FOR DELETE TO authenticated USING (bucket_id = 'company-logo');
