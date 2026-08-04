-- ============================================================
-- STAGING CLEANUP -- removes everything seed_staging_data.sql created
-- ============================================================
-- Deletes by the ZZSTAGING_/ZZS- prefix/pattern only, in FK-safe order
-- (children before parents). Safe to re-run (every DELETE is a no-op if
-- nothing matches). Read supabase/staging-seed/README.md first.
--
-- The tenants/regions/profiles/auth-user sections at the bottom are
-- commented out by default -- uncomment only for a full teardown between
-- test campaigns, not for a routine data reset (most staging test runs
-- should keep the same 8 accounts/2 tenants/4 regions and only reset the
-- transactional data above them).
-- ============================================================

BEGIN;

DELETE FROM terminal_dues WHERE employee_number LIKE 'ZZS-%';
DELETE FROM employee_deductions WHERE employee_id IN (
  SELECT id FROM employees WHERE employee_number LIKE 'ZZS-%'
);
DELETE FROM payment_status WHERE employee_id IN (
  SELECT id FROM employees WHERE employee_number LIKE 'ZZS-%'
);
DELETE FROM payroll WHERE employee_id IN (
  SELECT id FROM employees WHERE employee_number LIKE 'ZZS-%'
);
DELETE FROM attendance WHERE employee_id IN (
  SELECT id FROM employees WHERE employee_number LIKE 'ZZS-%'
);
DELETE FROM applicants WHERE name LIKE 'ZZSTAGING%';
DELETE FROM employees WHERE employee_number LIKE 'ZZS-%';
DELETE FROM positions WHERE name LIKE 'ZZSTAGING_%';

COMMIT;

-- ------------------------------------------------------------
-- FULL TEARDOWN (uncomment to also remove accounts/tenants/regions)
-- ------------------------------------------------------------
-- BEGIN;
-- DELETE FROM profiles WHERE email LIKE 'zzstaging-%';
-- DELETE FROM regions WHERE name LIKE 'ZZSTAGING_%';
-- DELETE FROM tenants WHERE name LIKE 'ZZSTAGING_%';
-- COMMIT;
--
-- The 8 auth.users rows created for this seed's profiles must be deleted
-- separately, through the same dashboard/Auth Admin API used to create
-- them -- plain SQL against auth.users is not supported by Supabase.
