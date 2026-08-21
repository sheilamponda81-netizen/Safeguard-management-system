-- ============================================================
-- PREFLIGHT (READ-ONLY): Functional Roles / Regional RLS rollout
-- Date prepared: 2026-08-20
-- ============================================================
--
-- DO NOT RUN THIS AGAINST STAGING/PRODUCTION AS PART OF THIS PASS.
-- These queries are prepared for the NEXT session, after this
-- implementation is reviewed and explicitly approved for STAGING. Every
-- statement here is a pure SELECT -- nothing here writes, and nothing
-- here should be run until specifically authorized.
--
-- PURPOSE
-- -----------------------------------------------------------
-- 20260817000001/000002/000003 make region enforcement apply to LEGACY
-- accounts for the first time (not just the new functional roles) on
-- several tables/RPCs. Any legacy account or row with region_id = NULL
-- will, under the new regional RLS, only match another region_id = NULL
-- row (region_allowed()'s NULL-safe IS NOT DISTINCT FROM comparison) --
-- meaning a legacy Manager with no region assigned would suddenly see
-- FAR LESS data than before if the employees/applicants they used to see
-- DO have a real region_id set. These queries exist to find that
-- mismatch BEFORE applying the migrations to STAGING, not after.
--
-- ============================================================
-- 1. Profiles grouped by role / role_level / region_id
-- ============================================================
-- Gives a full census of every account type currently in STAGING --
-- confirms exactly which role/role_level combinations exist (the
-- profiles.role live-data caution from 20260817000000 assumed at least
-- 'admin' and 'manager' values exist; this proves the full real set) and
-- whether each group already has region_id populated.
SELECT
  role,
  role_level,
  (region_id IS NULL) AS region_is_null,
  COUNT(*) AS account_count
FROM profiles
WHERE deleted_at IS NULL
GROUP BY role, role_level, (region_id IS NULL)
ORDER BY role_level NULLS FIRST, role, region_is_null DESC;

-- ============================================================
-- 2. Legacy role_level 2/3/4 profiles with region_id IS NULL
-- ============================================================
-- THE critical query. Every one of these accounts, once
-- 20260817000001/000002/000003 are applied, becomes region-scoped for
-- the first time -- and with region_id NULL, region_allowed() only
-- matches OTHER rows whose region_id is ALSO NULL. If this returns any
-- rows, each one needs a real region_id assigned (or an explicit,
-- reviewed decision to leave it NULL and accept the narrowed access)
-- BEFORE the migrations are applied to STAGING -- not after.
SELECT id, email, full_name, role, role_level, is_active, created_at
FROM profiles
WHERE role_level IN (2, 3, 4)
  AND region_id IS NULL
  AND deleted_at IS NULL
ORDER BY role_level, created_at;

-- Role_level = 1 (Admin) is intentionally EXCLUDED from the query above --
-- is_business_admin() (role_level = 1) is exempt from region_allowed()
-- entirely, so a NULL region_id on a legacy Admin account is expected
-- and causes no access change. Included here separately, for completeness
-- of the census only (not an action item):
SELECT id, email, full_name, role_level, is_active
FROM profiles
WHERE role_level = 1 AND region_id IS NULL AND deleted_at IS NULL
ORDER BY created_at;

-- ============================================================
-- 3. Employees with region_id IS NULL
-- ============================================================
-- Every one of these rows becomes invisible to any region-scoped caller
-- (legacy Manager/Supervisor with a real region, or any new hr_manager/
-- accountant/operations_manager) under the new employees RLS -- visible
-- only to is_super_admin()/is_business_admin() going forward. If this is
-- a large fraction of the employee base, region backfill should happen
-- before rollout; if it's a handful of known edge cases (e.g. genuinely
-- unassigned employees), that's useful to confirm explicitly too.
SELECT id, employee_number, full_name, position, department, status, hire_date
FROM employees
WHERE region_id IS NULL AND is_deleted = false
ORDER BY hire_date;

SELECT COUNT(*) AS total_employees,
       COUNT(*) FILTER (WHERE region_id IS NULL) AS employees_with_null_region,
       ROUND(100.0 * COUNT(*) FILTER (WHERE region_id IS NULL) / NULLIF(COUNT(*), 0), 1) AS pct_null_region
FROM employees
WHERE is_deleted = false;

-- ============================================================
-- 4. Applicants with region_id IS NULL
-- ============================================================
-- Expected to be effectively ALL existing rows -- Recruitment.tsx's
-- region_id wiring on create was verified already correct/working during
-- this pass (new applicants get a real region_id going forward), but
-- every applicant created BEFORE that fix has region_id = NULL and will
-- be Admin-only-visible under the new applicants RLS (20260817000001
-- PART 3) and the new report RPC (20260817000006) until/unless
-- backfilled. This is a known, already-documented transitional
-- consequence -- this query exists to quantify it, not to imply
-- something is broken.
SELECT COUNT(*) AS total_applicants,
       COUNT(*) FILTER (WHERE region_id IS NULL) AS applicants_with_null_region
FROM applicants;

SELECT id, name, position, interview_status, application_date
FROM applicants
WHERE region_id IS NULL
ORDER BY application_date DESC
LIMIT 50; -- sample only -- remove LIMIT for the full list if needed

-- ============================================================
-- 5. Counts by region (profiles, employees, applicants)
-- ============================================================
-- A general regional-distribution sanity check -- confirms the `regions`
-- table's real rows line up with where accounts/employees/applicants
-- actually are, and surfaces any region with zero staff assigned to it
-- (which would mean no non-Admin account can ever manage that region's
-- employees under the new RLS).
SELECT r.id AS region_id, r.name AS region_name,
  (SELECT COUNT(*) FROM profiles p WHERE p.region_id = r.id AND p.deleted_at IS NULL) AS profile_count,
  (SELECT COUNT(*) FROM employees e WHERE e.region_id = r.id AND e.is_deleted = false) AS employee_count,
  (SELECT COUNT(*) FROM applicants a WHERE a.region_id = r.id) AS applicant_count
FROM regions r
ORDER BY r.name;

-- ============================================================
-- 6. Region IDs referencing missing/deleted region rows
-- ============================================================
-- profiles.region_id / employees.region_id / applicants.region_id are all
-- `REFERENCES regions(id) ON DELETE SET NULL` -- so a genuinely dangling
-- reference should be impossible under normal FK enforcement. This query
-- exists purely as a defensive double-check (e.g. in case a region was
-- ever removed via a path that bypassed the FK, or a region was restored
-- with a different id) -- expected result is 0 rows in all three.
SELECT 'profiles' AS table_name, p.id, p.region_id
FROM profiles p
WHERE p.region_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM regions r WHERE r.id = p.region_id)
UNION ALL
SELECT 'employees', e.id, e.region_id
FROM employees e
WHERE e.region_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM regions r WHERE r.id = e.region_id)
UNION ALL
SELECT 'applicants', a.id, a.region_id
FROM applicants a
WHERE a.region_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM regions r WHERE r.id = a.region_id);

-- ============================================================
-- 7. profiles.role live-data census (informs the deferred CHECK constraint decision)
-- ============================================================
-- 20260817000000 deliberately did NOT add a strict 4-value CHECK
-- constraint on profiles.role, based on the already-confirmed presence
-- of 'admin'/'manager' values in STAGING. This query gets the FULL,
-- current, authoritative list -- useful before any future decision to
-- tighten that constraint.
SELECT role, COUNT(*) FROM profiles WHERE deleted_at IS NULL GROUP BY role ORDER BY COUNT(*) DESC;

-- ============================================================
-- 8. Postgres version check (for the employees_general view's
-- `security_invoker` option, which requires Postgres 15+)
-- ============================================================
SHOW server_version;
