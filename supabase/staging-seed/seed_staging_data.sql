-- ============================================================
-- STAGING SEED DATA -- synthetic, fabricated, NOT run in this pass
-- ============================================================
-- Read supabase/staging-seed/README.md FIRST. This file cannot be run
-- verbatim: the profile INSERTs reference placeholder auth.users UUIDs
-- that must be replaced with real ones returned by creating auth users
-- through the Supabase dashboard or Auth Admin API (profiles.id is a
-- foreign key to auth.users(id), which plain SQL cannot create).
--
-- Every synthetic value is prefixed ZZSTAGING_ (or ZZS- for short fields
-- like guard IDs) so it can be found and removed as one group -- see
-- cleanup_staging_data.sql. Do not remove the prefix from any value below;
-- it is the only thing that makes cleanup safe and mistake-proof.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- TENANTS (2, for multi-tenant isolation testing)
-- ------------------------------------------------------------
INSERT INTO tenants (id, name, code, email, country)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'ZZSTAGING_TenantA', 'ZZSTAGING_A', 'zzstaging-a@example.invalid', 'Malawi'),
  ('22222222-2222-2222-2222-222222222222', 'ZZSTAGING_TenantB', 'ZZSTAGING_B', 'zzstaging-b@example.invalid', 'Malawi')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- REGIONS (2 per tenant, 4 total)
-- ------------------------------------------------------------
INSERT INTO regions (id, tenant_id, name, code)
VALUES
  ('a1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'ZZSTAGING_Central', 'ZZS-A-CEN'),
  ('a1000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'ZZSTAGING_South', 'ZZS-A-SOU'),
  ('a2000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'ZZSTAGING_North', 'ZZS-B-NOR'),
  ('a2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'ZZSTAGING_East', 'ZZS-B-EAS')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- POSITIONS (tenant A only, shown as the pattern -- repeat for tenant B
-- if testing needs it)
-- ------------------------------------------------------------
INSERT INTO positions (id, tenant_id, name, category, default_salary, requires_uniform, is_active)
VALUES
  ('b1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'ZZSTAGING_Security Guard', 'security', 150000, true, true),
  ('b1000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'ZZSTAGING_Office Admin', 'admin', 200000, false, true)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- PROFILES (4 roles x 2 tenants = 8) -- REPLACE THE PLACEHOLDER UUIDs
-- ------------------------------------------------------------
-- Step 1 (outside this file, via dashboard or Auth Admin API): create 8
-- auth users with these exact emails and a strong generated password you
-- record somewhere safe (a password manager / secrets store -- never in
-- this repo):
--   zzstaging-admin-a@example.invalid       (tenant A, role_level 1)
--   zzstaging-manager-a@example.invalid     (tenant A, role_level 2)
--   zzstaging-supervisor-a@example.invalid  (tenant A, role_level 3)
--   zzstaging-staff-a@example.invalid       (tenant A, role_level 4)
--   zzstaging-admin-b@example.invalid       (tenant B, role_level 1)
--   zzstaging-manager-b@example.invalid     (tenant B, role_level 2)
--   zzstaging-supervisor-b@example.invalid  (tenant B, role_level 3)
--   zzstaging-staff-b@example.invalid       (tenant B, role_level 4)
--
-- Step 2: replace every 00000000-0000-0000-0000-0000000000NN placeholder
-- below with the real auth.users.id each account was actually created with.
INSERT INTO profiles (id, tenant_id, email, full_name, role, role_level, is_super_admin, is_active, region_id)
VALUES
  ('00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'zzstaging-admin-a@example.invalid', 'ZZSTAGING Admin A', 'admin', 1, false, true, 'a1000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'zzstaging-manager-a@example.invalid', 'ZZSTAGING Manager A', 'manager', 2, false, true, 'a1000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'zzstaging-supervisor-a@example.invalid', 'ZZSTAGING Supervisor A', 'supervisor', 3, false, true, 'a1000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'zzstaging-staff-a@example.invalid', 'ZZSTAGING Staff A', 'staff', 4, false, true, 'a1000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222222', 'zzstaging-admin-b@example.invalid', 'ZZSTAGING Admin B', 'admin', 1, false, true, 'a2000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222222', 'zzstaging-manager-b@example.invalid', 'ZZSTAGING Manager B', 'manager', 2, false, true, 'a2000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222222', 'zzstaging-supervisor-b@example.invalid', 'ZZSTAGING Supervisor B', 'supervisor', 3, false, true, 'a2000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222222', 'zzstaging-staff-b@example.invalid', 'ZZSTAGING Staff B', 'staff', 4, false, true, 'a2000000-0000-0000-0000-000000000002')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- EMPLOYEES (tenant A: 2 guards in different regions + 1 office employee)
-- ------------------------------------------------------------
INSERT INTO employees (id, tenant_id, employee_number, full_name, position, basic_salary, region_id, "guardId", uniform_deduction, status)
VALUES
  ('c1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'ZZS-A-001', 'ZZSTAGING Guard One', 'ZZSTAGING_Security Guard', 150000, 'a1000000-0000-0000-0000-000000000001', 'ZZS-G0001', 10000, 'Active'),
  ('c1000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'ZZS-A-002', 'ZZSTAGING Guard Two', 'ZZSTAGING_Security Guard', 150000, 'a1000000-0000-0000-0000-000000000002', 'ZZS-G0002', 0, 'Active'),
  ('c1000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'ZZS-A-003', 'ZZSTAGING Office One', 'ZZSTAGING_Office Admin', 200000, 'a1000000-0000-0000-0000-000000000001', NULL, 0, 'Active')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- ATTENDANCE (current month, a mix of Present/Absent/Late for the 2 guards)
-- ------------------------------------------------------------
INSERT INTO attendance (tenant_id, employee_id, date, status)
SELECT '11111111-1111-1111-1111-111111111111', 'c1000000-0000-0000-0000-000000000001', d::date, 'P'
FROM generate_series(date_trunc('month', CURRENT_DATE), CURRENT_DATE, interval '1 day') d
ON CONFLICT (employee_id, date) DO NOTHING;

-- ------------------------------------------------------------
-- APPLICANTS (2, one per tenant, for recruitment-flow testing)
-- ------------------------------------------------------------
INSERT INTO applicants (id, tenant_id, name, position, phone, email, interview_status, decision, region_id)
VALUES
  ('d1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'ZZSTAGING Applicant One', 'ZZSTAGING_Security Guard', '+265000000001', 'zzstaging-applicant-a@example.invalid', 'Pending', 'Pending', 'a1000000-0000-0000-0000-000000000001'),
  ('d2000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'ZZSTAGING Applicant Two', 'ZZSTAGING_Security Guard', '+265000000002', 'zzstaging-applicant-b@example.invalid', 'Pending', 'Pending', 'a2000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- After running: verify row counts per this migration's own convention
-- (see each of the 5 hardening migrations' own PREFLIGHT/VERIFICATION SQL
-- for the exact style) --  e.g.:
--   SELECT count(*) FROM employees WHERE employee_number LIKE 'ZZS-%';
--   SELECT count(*) FROM profiles WHERE email LIKE 'zzstaging-%';
