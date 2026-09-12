-- ============================================================================
-- Phase C: employees base-table column-level SELECT lockdown
-- ============================================================================
--
-- Context: 20260817000008 ("Phase A" of the employee-read-surfaces rollout)
-- introduced two views -- `employees_general` (37 non-guard columns) and
-- `employees_security` (21 columns: identity/operational fields plus the 8
-- guard/security-only fields) -- as the intended replacement read surfaces
-- for the `employees` base table, but deliberately made ZERO base-table
-- grant changes ("Phase A is purely additive"). That migration's own
-- comments describe a future "Phase C" step that revokes direct base-table
-- SELECT once frontend cutover to the two views is verified. No such step
-- has existed anywhere in the migration history until this file.
--
-- This migration is that Phase C. Its ONLY purpose is the column-level
-- SELECT privilege contraction on `public.employees` promised by
-- 20260817000008. It does not touch:
--   * Row-level security policies (RLS) on `employees` or any other table
--     -- 20260908000000's RLS tightening is unaffected and orthogonal;
--       row-level policy governs WHICH ROWS are visible, this migration
--       governs WHICH COLUMNS of those rows may be read, and both must
--       hold for a raw base-table SELECT to expose a cell of data.
--   * INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES privileges.
--   * EXECUTE privileges on any function.
--   * Any privileges on `employees_general` or `employees_security`
--     themselves (both continue to work exactly as Phase A defined them --
--     `employees_security` is security_invoker=false/definer-context, so it
--     is unaffected by `authenticated`'s revoked base-table SELECT).
--   * Any business data.
--
-- ============================================================================
-- *** PRODUCTION DEPLOYMENT ORDERING -- DO NOT APPLY OUT OF ORDER ***
-- ============================================================================
-- This migration MUST NOT be applied to production until ALL of the
-- following have already happened, in this order:
--   1. 20260817000008 (Phase A: create employees_general/employees_security)
--      has been applied to production.
--   2. The PR #36 frontend containing the Dashboard.tsx fix that reads
--      `license_status` from `employees_security` (instead of expecting it
--      on `employees_general`) has been deployed to production and is
--      confirmed Ready/serving traffic.
--   3. Production role-based smoke tests pass against the deployed frontend
--      for every affected role (Admin/super-admin, HR Manager, Operations
--      Manager, Accountant, and any legacy/pre-functional-roles account),
--      confirming:
--        - `employees_general`-backed Dashboard/employee-list features still
--          load correctly for all roles,
--        - the "Renew Licenses" Dashboard count still reflects reality for
--          HR/Ops/Admin/legacy callers and reads 0 for Accountant,
--        - no other deployed frontend code path still expects a guard
--          column (shift, supervisor, uniform_status, uniform_condition,
--          shoes_status, license_status, license_expiry, "guardId") or a
--          raw `select('*')` result directly off `public.employees`.
-- Applying this migration before all three are true in production will
-- silently break any production code path still reading guard columns (or
-- any column at all) directly off the `employees` base table.
--
-- This ordering requirement applies to production only. It is safe to run
-- this migration against a disposable local/staging Postgres instance at
-- any time for validation purposes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Step 1: revoke table-wide SELECT on the base table from every role that
-- currently holds it. Idempotent -- REVOKE on a privilege that is not held
-- is a silent no-op in Postgres, so this is safe to re-run.
-- ----------------------------------------------------------------------------
REVOKE SELECT ON TABLE public.employees FROM authenticated;
REVOKE SELECT ON TABLE public.employees FROM PUBLIC;
REVOKE SELECT ON TABLE public.employees FROM anon;

-- ----------------------------------------------------------------------------
-- Step 2: grant `authenticated` column-level SELECT on exactly the 37 safe
-- (non-guard) columns -- the same column set 20260817000008 selected into
-- `employees_general`. Column-level GRANT in Postgres is itself idempotent/
-- additive (re-granting an already-granted column privilege is a no-op), so
-- this whole statement is safe to re-run.
--
-- Deliberately NOT included (the 8 guard/security-only columns, matching
-- what 20260817000008 excluded from `employees_general` and reserved for
-- `employees_security` alone): shift, supervisor, uniform_status,
-- uniform_condition, shoes_status, license_status, license_expiry, "guardId".
-- ----------------------------------------------------------------------------
GRANT SELECT (
  id,
  tenant_id,
  employee_number,
  full_name,
  gender,
  age,
  phone,
  position,
  department,
  basic_salary,
  status,
  email,
  hire_date,
  dob,
  national_id,
  address,
  qualification,
  contract_type,
  region_id,
  company,
  workstation,
  pay_point,
  account_number,
  uniform_deduction,
  next_of_kin_name,
  next_of_kin_relationship,
  next_of_kin_phone,
  next_of_kin_address,
  is_deleted,
  deleted_at,
  deleted_reason,
  deleted_by,
  assignment_type,
  resident_name,
  resident_contact,
  company_id,
  created_at
) ON TABLE public.employees TO authenticated;

-- ----------------------------------------------------------------------------
-- Note on RLS interaction: row-level policies on `employees` (see
-- 20260908000000 and earlier) remain fully in effect and are unchanged by
-- this migration. A caller must still pass the table's row-level policy
-- AND now must also request only columns granted above, for a raw
-- `SELECT ... FROM employees` to succeed. Requesting any of the 8 guard
-- columns directly (e.g. `SELECT license_status FROM employees`) will now
-- fail at the privilege-check stage regardless of row-level policy outcome
-- or role, for every `authenticated` caller -- guard-column reads remain
-- available exclusively via `employees_security`, whose own WHERE-clause
-- authorization (unchanged by this migration) continues to gate access.
-- ----------------------------------------------------------------------------
