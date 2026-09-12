-- ============================================================
-- MIGRATION: Functional role / permission system -- FOUNDATION (Phase A)
-- Date: 2026-08-17
-- SECURITY-RECONCILED (2026-09-08, production preflight): current_user_role()
-- and current_user_region_id() now reject inactive/deleted callers the
-- same way PART 0's three functions already do. is_business_admin() and
-- region_allowed() now ALSO explicitly fail closed on their own -- this
-- closes a residual gap where region_allowed(NULL) could otherwise return
-- TRUE for an inactive caller against a NULL-region row, since
-- `NULL IS NOT DISTINCT FROM NULL` evaluates TRUE regardless of what
-- current_user_region_id() returns. None of these vulnerable forms were
-- ever applied to any real environment; this is the only version that has
-- ever shipped in this migration.
-- ============================================================
--
-- *** THIS IS PHASE A OF A MULTI-PHASE ROLLOUT. ***
-- Phase A is pure addition: new functions, a new table, one narrowly-scoped
-- constraint. NOTHING in this file changes the behavior of any EXISTING
-- RLS policy, RPC, or account. It is safe to apply on its own, at any
-- time, with zero effect on any currently-working account -- nothing yet
-- calls the functions this file defines.
--
-- WHY THIS EXISTS
-- -----------------------------------------------------------
-- The application is moving from a 4-level numeric hierarchy
-- (role_level 1=Admin/2=Manager/3=Supervisor/4=Staff, `role_level <= N`
-- checks scattered across ~15 RLS policies and 4 RPCs) to 4 FUNCTIONAL,
-- non-hierarchical roles: admin, hr_manager, accountant, operations_manager.
-- These roles are not "level 2 vs level 3" -- an hr_manager and an
-- accountant have completely different, non-overlapping permission sets,
-- which a numeric threshold cannot express at all. This migration builds
-- the permission-storage architecture and the centralized helper
-- functions every later RLS/RPC-authorization migration will call.
--
-- role_level is NOT removed, NOT redefined, and NOT reused for new
-- accounts. It is going to be relied on for a very specific, narrow
-- purpose during a controlled transition: recognizing already-existing
-- legacy accounts so they keep working exactly as they do today (see
-- is_business_admin() below, and the later per-table migrations' own
-- "legacy compatibility branch"). New accounts (created going forward
-- through the trusted server-side provisioning flow, not yet built as of
-- this migration) get role_level = NULL, is_super_admin = false,
-- deliberately -- see that Edge Function's own documentation for why NULL
-- specifically (short version: `NULL <= 2` is NULL, never TRUE, in SQL --
-- and every legacy frontend read site already does `role_level || 4`,
-- where NULL is falsy in JS -- so a brand-new functional-role account is
-- structurally incapable of picking up ANY legacy role_level-gated access,
-- accidentally or otherwise, with zero code changes needed to guarantee
-- that property).
--
-- PERMISSION-STORAGE ARCHITECTURE DECISION (Option A, refined)
-- -----------------------------------------------------------
-- profiles.role (already exists, see 20260727000000's CREATE TABLE) +
-- a small, MIGRATION-DEFINED, non-tenant-editable `role_permissions`
-- lookup table + one centralized has_permission() function. Deliberately
-- NOT the fully dynamic app_roles/permissions/role_permissions-as-generic-
-- RBAC shape: the 4 roles are a fixed business decision, not something a
-- tenant customizes through a UI (the existing `user_roles` table already
-- attempted exactly that, is completely disconnected from real
-- enforcement, and must NOT become the security authority here -- this
-- migration does not touch or read `user_roles` at all). A static,
-- reviewable table keeps the whole permission matrix visible in one
-- `SELECT * FROM role_permissions ORDER BY role, permission`, is a single
-- indexed lookup at RLS-evaluation time (fast), and is exactly the same
-- "one function, reads the caller's own row" shape this schema already
-- trusts for current_user_role_level()/is_super_admin().
--
-- profiles.role LIVE DATA CAUTION (explicit instruction, this pass)
-- -----------------------------------------------------------
-- STAGING is already known to contain profiles.role values OTHER than the
-- 4 new functional-role slugs (at least 'admin' and 'manager' observed).
-- This migration does NOT add a CHECK constraint restricting `role` to
-- the 4 new values -- doing so before a live-data inventory and a
-- reviewed per-account backfill plan could invalidate real existing rows.
-- The only new constraint added here (see PART 3 below) is deliberately
-- SCOPED to just the 4 new values via a `role NOT IN (...) OR` escape
-- hatch, so legacy rows with any other role value (or NULL) are
-- completely unaffected and pass the constraint trivially.
-- ============================================================

-- ============================================================
-- PART 0: REDEFINE 3 EXISTING HELPERS TO REJECT INACTIVE/DELETED CALLERS
-- ============================================================
-- This is the single highest-leverage change in this migration. Rather
-- than adding an `is_current_user_active()` check to every one of the
-- dozens of EXISTING RLS policies/RPCs across the whole schema that
-- already call get_current_tenant_id()/is_super_admin()/
-- current_user_role_level(), this redefines those 3 functions ONCE, in
-- place, so a disabled/deleted profile is rejected EVERYWHERE those
-- functions are already used -- for the legacy role_level system just as
-- much as the new one -- with zero changes needed to any individual
-- policy. This directly satisfies "every permission/RLS/RPC authorization
-- path for application users must ultimately reject inactive/deleted
-- profiles" and "a disabled super-admin user session should not remain
-- usable merely because the profile still says is_super_admin = true."
--
-- Each function now returns the "nobody is authorized" value (NULL for
-- the two nullable-typed ones, NULL propagating through `= `/`<=`
-- comparisons as never-true; false for the boolean one) whenever the
-- caller's profile is missing, is_active = false, or deleted_at is set --
-- instead of returning their real tenant_id/role_level/super-admin flag.
-- Original bodies (for rollback) are preserved verbatim in this
-- migration's own ROLLBACK SQL note at the bottom of the file.
-- ============================================================

CREATE OR REPLACE FUNCTION get_current_tenant_id()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
BEGIN
  SELECT tenant_id, is_active, deleted_at INTO v_tenant_id, v_is_active, v_deleted_at
  FROM profiles WHERE id = auth.uid() LIMIT 1;
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN v_tenant_id;
END;
$$;

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_super_admin BOOLEAN;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
BEGIN
  SELECT is_super_admin, is_active, deleted_at INTO v_is_super_admin, v_is_active, v_deleted_at
  FROM profiles WHERE id = auth.uid() LIMIT 1;
  RETURN COALESCE(v_is_super_admin, false) AND COALESCE(v_is_active, false) AND v_deleted_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION current_user_role_level()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role_level INTEGER;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
BEGIN
  SELECT role_level, is_active, deleted_at INTO v_role_level, v_is_active, v_deleted_at
  FROM profiles WHERE id = auth.uid() LIMIT 1;
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN v_role_level;
END;
$$;

-- ============================================================
-- PART 1: CENTRALIZED SECURITY HELPERS
-- ============================================================
-- Every helper follows the same shape already established by
-- get_current_tenant_id()/is_super_admin()/current_user_role_level()
-- (20240619000000_tenant_isolation.sql / 20260727000001_security_hardening.sql):
-- SECURITY DEFINER, resolves the CALLER via auth.uid() internally, pinned
-- search_path, never accepts a caller-supplied identity/role/tenant as a
-- parameter. Nothing here is safe to call with a parameter that lets the
-- CALLER assert who they are -- these functions look themselves up.
--
-- SECURITY RECONCILIATION (2026-09-08, production preflight):
-- current_user_role() and current_user_region_id() now reject
-- inactive/deleted callers the same way PART 0's three functions do.
-- is_business_admin() and region_allowed(), further below, now ALSO
-- explicitly fail closed on their own (rather than relying only on their
-- component calls) -- this closes a residual gap where
-- region_allowed(NULL) could otherwise return TRUE for an inactive caller
-- against a NULL-region row, since `NULL IS NOT DISTINCT FROM NULL`
-- evaluates TRUE regardless of what current_user_region_id() returns.
-- Zero behavior change for any active, non-deleted caller anywhere in
-- this file.
-- ============================================================

CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
BEGIN
  SELECT role, is_active, deleted_at INTO v_role, v_is_active, v_deleted_at
  FROM profiles WHERE id = auth.uid() LIMIT 1;
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN v_role;
END;
$$;

CREATE OR REPLACE FUNCTION current_user_region_id()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_region_id UUID;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
BEGIN
  SELECT region_id, is_active, deleted_at INTO v_region_id, v_is_active, v_deleted_at
  FROM profiles WHERE id = auth.uid() LIMIT 1;
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN v_region_id;
END;
$$;

-- Deliberately does NOT gate on is_active itself -- this is a raw reader,
-- used both by is_current_user_active() below and by call sites that
-- need to know active state precisely (e.g. login-flow messaging).
CREATE OR REPLACE FUNCTION is_current_user_active()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
BEGIN
  SELECT is_active, deleted_at INTO v_active, v_deleted_at
  FROM profiles WHERE id = auth.uid() LIMIT 1;
  IF v_active IS NULL THEN
    -- No profile row at all (e.g. an auth.users row with no matching
    -- profile -- the exact orphaned-account failure mode this whole
    -- redesign exists to prevent at creation time) -- never treat a
    -- caller with no profile as active.
    RETURN false;
  END IF;
  RETURN v_active = true AND v_deleted_at IS NULL;
END;
$$;

-- Recognizes "this caller has full, tenant-wide authority" for EITHER a
-- new-model account (role = 'admin') OR a legacy account that is Admin
-- under the OLD model (role_level = 1) -- explicitly required so a
-- legacy Admin whose `role` text hasn't been migrated yet (see the live-
-- data caution above -- it might say 'admin' already, might say nothing
-- useful, might say something else entirely) keeps working. Deliberately
-- separate from is_super_admin() -- see that function's own long-standing
-- role in this schema (cross-TENANT bypass, platform/emergency concept) --
-- is_business_admin() is a same-tenant, business-facing concept and must
-- never be treated as equivalent to, or folded into, cross-tenant
-- super-admin authority. Explicitly fails closed on its own (rather than
-- relying solely on current_user_role()/current_user_role_level()'s own
-- NULL-propagation) for deterministic BOOLEAN semantics -- an inactive or
-- profile-less caller always gets a real `false`, never SQL NULL.
CREATE OR REPLACE FUNCTION is_business_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_current_user_active() THEN
    RETURN false;
  END IF;
  RETURN current_user_role() = 'admin' OR current_user_role_level() = 1;
END;
$$;

-- Region-boundary check shared by every direct- and indirect-region RLS
-- policy. `p_row_region_id` is the REGION OWNING THE ROW being checked
-- (the row's own region_id for direct-region tables; employees.region_id
-- via the FK join for indirect ones -- see the per-table migrations).
-- Business Admin and platform super-admin both see every region inside
-- their own tenant scope (the tenant boundary itself is enforced
-- separately, by the caller -- this function is region-only). Uses
-- IS NOT DISTINCT FROM (not =) so two NULL regions correctly compare
-- equal instead of evaluating to NULL/false, matching Postgres's usual
-- NULL-unsafe `=` footgun. Explicitly fails closed on its own FIRST,
-- before that NULL-safe comparison ever runs -- without this, an inactive
-- caller (current_user_region_id() = NULL) checked against a NULL-region
-- row would otherwise pass via `NULL IS NOT DISTINCT FROM NULL = TRUE`,
-- regardless of is_super_admin()/is_business_admin(). This makes
-- region_allowed() safe to call from ANY context, not only ones already
-- wrapped in their own outer is_current_user_active() check.
CREATE OR REPLACE FUNCTION region_allowed(p_row_region_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_current_user_active() THEN
    RETURN false;
  END IF;
  RETURN is_super_admin() OR is_business_admin() OR p_row_region_id IS NOT DISTINCT FROM current_user_region_id();
END;
$$;

-- ============================================================
-- PART 2: role_permissions -- the static, migration-defined matrix
-- ============================================================
-- Deliberately NOT tenant-scoped and NOT writable through the app's own
-- RLS policies (see PART 4) -- this is fixed, reviewable, code-defined
-- data, the same trust level as a CHECK constraint, not a per-tenant
-- customization surface. The decorative `user_roles` table (Misc.tsx's
-- "Roles & Permissions" tab) is a COMPLETELY SEPARATE, already-disconnected
-- concept and is not read by, or related to, anything in this migration.
-- ============================================================

CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

-- 'admin' is deliberately NOT enumerated row-by-row here -- see
-- has_permission()/get_my_permissions() below, which special-case
-- is_business_admin() as "every permission that exists" rather than
-- requiring this table to be kept in lockstep with every future
-- permission key. This also means a newly-added page/permission
-- automatically becomes available to Admin without a migration, while
-- still needing an explicit row for any non-admin role to see it --
-- exactly the deny-by-default posture required.

INSERT INTO role_permissions (role, permission) VALUES
  -- ---- Human Resource Manager: full on Employees/Recruitment/Salary
  -- Advances/Terminal Dues/Security Personnel, region-scoped by RLS
  -- (this table only expresses ACTION permission, never region -- region
  -- is enforced separately by region_allowed() in every RLS policy).
  ('hr_manager', 'dashboard.view'),
  ('hr_manager', 'employees.view'),
  ('hr_manager', 'employees.create'),
  ('hr_manager', 'employees.edit'),
  ('hr_manager', 'employees.delete'),
  ('hr_manager', 'recruitment.view'),
  ('hr_manager', 'recruitment.create'),
  ('hr_manager', 'recruitment.edit'),
  ('hr_manager', 'recruitment.delete'),
  ('hr_manager', 'salary_advances.view'),
  ('hr_manager', 'salary_advances.create'),
  ('hr_manager', 'salary_advances.approve'),
  ('hr_manager', 'salary_advances.adjust'),
  ('hr_manager', 'terminal_dues.view'),
  ('hr_manager', 'terminal_dues.create'),
  ('hr_manager', 'terminal_dues.edit'),
  ('hr_manager', 'terminal_dues.process'),
  ('hr_manager', 'security_personnel.view'),
  ('hr_manager', 'security_personnel.create'),
  ('hr_manager', 'security_personnel.edit'),
  ('hr_manager', 'security_personnel.delete'),
  ('hr_manager', 'user_manual.view'),
  ('hr_manager', 'future_features.view'),

  -- ---- Accountant: full on Payroll/Payments/Payslips/Salary Advances/
  -- Reports (both categories -- item 3: "all report categories, view/
  -- export as appropriate"), read-only Employees/Terminal Dues (view
  -- only -- deliberately no create/edit/delete/process rows for either).
  ('accountant', 'dashboard.view'),
  ('accountant', 'payroll.view'),
  ('accountant', 'payroll.process'),
  ('accountant', 'payroll.approve'),
  ('accountant', 'payments.view'),
  ('accountant', 'payments.manage'),
  ('accountant', 'payslips.view'),
  ('accountant', 'salary_advances.view'),
  ('accountant', 'salary_advances.create'),
  ('accountant', 'salary_advances.approve'),
  ('accountant', 'salary_advances.adjust'),
  ('accountant', 'reports.financial.view'),
  ('accountant', 'reports.financial.export'),
  ('accountant', 'reports.operational.view'),
  ('accountant', 'reports.operational.export'),
  ('accountant', 'employees.view'),
  ('accountant', 'terminal_dues.view'),
  ('accountant', 'user_manual.view'),
  ('accountant', 'future_features.view'),

  -- ---- Operations Manager: read-only Employees/Reports(operational
  -- only, view only, NO export per item 28)/Security Personnel/Attendance.
  ('operations_manager', 'dashboard.view'),
  ('operations_manager', 'employees.view'),
  ('operations_manager', 'reports.operational.view'),
  ('operations_manager', 'security_personnel.view'),
  ('operations_manager', 'attendance.view'),
  ('operations_manager', 'user_manual.view'),
  ('operations_manager', 'future_features.view')
ON CONFLICT (role, permission) DO NOTHING;

-- ============================================================
-- PART 3: has_permission() / get_my_permissions()
-- ============================================================

-- CRITICAL (explicit instruction, this pass): this function NEVER
-- accepts a role/tenant/permission-set from the caller as trusted input
-- -- it resolves the CALLER's own role via current_user_role(), which
-- itself resolves via auth.uid(), never via a parameter or a row the
-- caller happens to be querying. There is deliberately no
-- `has_permission(p_role TEXT, p_permission TEXT)` overload -- that shape
-- would invite a call site to pass an untrusted role string.
CREATE OR REPLACE FUNCTION has_permission(p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
BEGIN
  IF NOT is_current_user_active() THEN
    RETURN false;
  END IF;
  IF is_business_admin() THEN
    RETURN true; -- full tenant-wide action authority, per the approved matrix
  END IF;
  v_role := current_user_role();
  IF v_role IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM role_permissions WHERE role = v_role AND permission = p_permission);
END;
$$;

-- Frontend-facing: one round trip to learn the caller's own full
-- permission set (used to drive sidebar/page/button visibility -- UX
-- only, never itself the authorization boundary; see PART 4 for why this
-- table has no direct SELECT policy of its own).
CREATE OR REPLACE FUNCTION get_my_permissions()
RETURNS TABLE (permission TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_current_user_active() THEN
    RETURN; -- empty set for an inactive/deleted/unauthenticated caller
  END IF;
  IF is_business_admin() THEN
    RETURN QUERY SELECT DISTINCT rp.permission FROM role_permissions rp;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT rp.permission FROM role_permissions rp WHERE rp.role = current_user_role();
END;
$$;

-- `REVOKE ALL ... FROM PUBLIC` alone does not remove `anon`'s own direct
-- EXECUTE grant on a newly created function -- Supabase grants EXECUTE to
-- `anon`/`authenticated` directly via a database-level default-privilege
-- rule, separate from PUBLIC (confirmed against STAGING's pg_proc.proacl
-- while applying 20260803000002_payroll_atomic_process_rpc.sql). Every
-- one of these 7 functions is an RLS-policy helper resolving the CALLER's
-- own identity via auth.uid()/current_setting -- none has any legitimate
-- reason to be reachable by an unauthenticated caller.
REVOKE ALL ON FUNCTION current_user_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION current_user_region_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION is_current_user_active() FROM PUBLIC;
REVOKE ALL ON FUNCTION is_business_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION region_allowed(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION has_permission(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_my_permissions() FROM PUBLIC;
REVOKE ALL ON FUNCTION current_user_role() FROM anon;
REVOKE ALL ON FUNCTION current_user_region_id() FROM anon;
REVOKE ALL ON FUNCTION is_current_user_active() FROM anon;
REVOKE ALL ON FUNCTION is_business_admin() FROM anon;
REVOKE ALL ON FUNCTION region_allowed(UUID) FROM anon;
REVOKE ALL ON FUNCTION has_permission(TEXT) FROM anon;
REVOKE ALL ON FUNCTION get_my_permissions() FROM anon;
GRANT EXECUTE ON FUNCTION current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION current_user_region_id() TO authenticated;
GRANT EXECUTE ON FUNCTION is_current_user_active() TO authenticated;
GRANT EXECUTE ON FUNCTION is_business_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION region_allowed(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION has_permission(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_permissions() TO authenticated;

-- ============================================================
-- PART 4: RLS on role_permissions itself
-- ============================================================
-- Any authenticated, active user may READ the matrix (needed so the
-- frontend can reason about it if ever useful, and so this isn't security-
-- through-obscurity) -- but NO ONE writes to it through the API, ever,
-- from any role, including Admin/super-admin. It is migration-defined
-- data only, exactly per instruction ("NOT tenant-editable through the
-- current decorative Roles & Permissions UI"). Deliberately no
-- tenant_id column at all -- this table is global to the whole
-- application's fixed 4-role model, not per-tenant data.
-- ============================================================

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Active users can view the role permission matrix" ON role_permissions;
CREATE POLICY "Active users can view the role permission matrix" ON role_permissions
FOR SELECT USING (is_current_user_active());
-- Deliberately NO INSERT/UPDATE/DELETE policy at all -- this table is
-- written exclusively by migrations, the same "only this migration may
-- write here" pattern already used for guard_id_counters/
-- employee_number_counters elsewhere in this schema.

-- ============================================================
-- PART 5: region-required constraint, SCOPED to the 4 new role values only
-- ============================================================
-- Real, DB-level enforcement (not just app-level) of "Admin's region is
-- optional, every other functional role's region is required" -- but
-- ONLY for rows that have actually opted into the new 4-value role
-- system. Any row whose `role` is NOT one of the 4 new slugs (every
-- existing legacy row today, whatever garbage or sensible value its
-- `role` column currently holds) is completely exempt via the
-- `role NOT IN (...)` short-circuit -- this constraint can NEVER reject
-- an existing legacy row, by construction, addressing the live-data
-- caution from PART 0 without needing the inventory first (this
-- constraint doesn't care what the legacy values ARE, only whether they
-- happen to already equal one of the 4 new slugs -- and if a legacy row's
-- current value already happens to be 'admin' AND has no region, it also
-- passes, since 'admin' rows never require a region either way).
-- ============================================================

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_functional_role_region_required;
ALTER TABLE profiles ADD CONSTRAINT profiles_functional_role_region_required
CHECK (
  role IS NULL
  OR role NOT IN ('hr_manager', 'accountant', 'operations_manager')
  OR region_id IS NOT NULL
);

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- CREATE TABLE/FUNCTION IF NOT
-- EXISTS or OR REPLACE throughout, ON CONFLICT DO NOTHING on the seed
-- INSERT, DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT.
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS: any account with profiles.is_active
-- = false or a non-NULL deleted_at IMMEDIATELY loses all access everywhere
-- get_current_tenant_id()/is_super_admin()/current_user_role_level()/
-- current_user_role()/current_user_region_id()/is_business_admin()/
-- region_allowed() are used (i.e. everywhere, across the whole schema and
-- every later migration that calls them), the moment this migration is
-- applied -- not waiting on any later migration. Any account with
-- is_active = true and deleted_at IS NULL (every real account today, as
-- far as this migration's own audit could determine) sees ZERO behavior
-- change -- these functions return exactly what they always returned for
-- an active caller. No RLS policy or RPC calls has_permission()/
-- is_business_admin()/region_allowed()/get_my_permissions() yet -- that
-- happens in the following migrations, one business area at a time. The
-- new profiles_functional_role_region_required constraint can only ever
-- reject a row whose `role` is already exactly 'hr_manager'/'accountant'/
-- 'operations_manager' AND has a NULL region_id -- no such row can exist
-- yet (nothing before this migration ever wrote those values), so this
-- ALTER TABLE cannot fail against current data.
--
-- PREFLIGHT: none needed -- pure addition.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT proname, prosecdef FROM pg_proc WHERE proname IN
--     ('current_user_role','current_user_region_id','is_current_user_active',
--      'is_business_admin','region_allowed','has_permission','get_my_permissions');
--   -- expected: 7 rows, all prosecdef = true
--   SELECT role, COUNT(*) FROM role_permissions GROUP BY role ORDER BY role;
--   -- expected: 3 rows (hr_manager, accountant, operations_manager) -- no 'admin' row
--   SELECT conname FROM pg_constraint WHERE conname = 'profiles_functional_role_region_required';
--   -- expected: 1 row
--   -- Fail-closed check, as a caller with NO profile row (simulate via
--   -- SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '<uuid-with-no-profile>', true);):
--   --   SELECT is_current_user_active(), is_business_admin(), current_user_role(),
--   --          current_user_region_id(), region_allowed(NULL);
--   --   expected: false, false, NULL, NULL, false
--
-- ROLLBACK SQL:
--   ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_functional_role_region_required;
--   DROP POLICY IF EXISTS "Active users can view the role permission matrix" ON role_permissions;
--   DROP TABLE IF EXISTS role_permissions;
--   DROP FUNCTION IF EXISTS get_my_permissions();
--   DROP FUNCTION IF EXISTS has_permission(TEXT);
--   DROP FUNCTION IF EXISTS region_allowed(UUID);
--   DROP FUNCTION IF EXISTS is_business_admin();
--   DROP FUNCTION IF EXISTS is_current_user_active();
--   DROP FUNCTION IF EXISTS current_user_region_id();
--   DROP FUNCTION IF EXISTS current_user_role();
--   -- PART 0's three redefinitions need restoring to their PRE-this-migration
--   -- bodies specifically (not dropping -- later migrations in this same
--   -- rollout depend on their names existing) -- their original bodies,
--   -- verbatim from 20240619000000_tenant_isolation.sql /
--   -- 20260727000001_security_hardening.sql, before this migration's
--   -- active/deleted_at check was added:
--   CREATE OR REPLACE FUNCTION get_current_tenant_id() RETURNS UUID AS $$
--   BEGIN RETURN (SELECT tenant_id FROM profiles WHERE id = auth.uid() LIMIT 1); END;
--   $$ LANGUAGE plpgsql SECURITY DEFINER;
--   CREATE OR REPLACE FUNCTION is_super_admin() RETURNS BOOLEAN AS $$
--   BEGIN RETURN (SELECT is_super_admin FROM profiles WHERE id = auth.uid() LIMIT 1); END;
--   $$ LANGUAGE plpgsql SECURITY DEFINER;
--   CREATE OR REPLACE FUNCTION current_user_role_level() RETURNS INTEGER AS $$
--   BEGIN RETURN (SELECT role_level FROM profiles WHERE id = auth.uid() LIMIT 1); END;
--   $$ LANGUAGE plpgsql SECURITY DEFINER;
--   -- (each immediately followed by its own `ALTER FUNCTION ... SET
--   -- search_path = public, pg_temp;`, matching 20260803000000's own
--   -- pinning of all three, to fully restore the pre-this-migration state.)
-- ============================================================
