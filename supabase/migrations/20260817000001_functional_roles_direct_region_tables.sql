-- ============================================================
-- MIGRATION: Functional role / permission system -- Phase B, part 1
-- Direct-region tables: profiles (special), employees, applicants, audit_logs
-- Date: 2026-08-17
-- ============================================================
--
-- Requires 20260817000000 (has_permission()/region_allowed()/
-- is_business_admin()/is_current_user_active()/current_user_role()/
-- current_user_region_id(), all defined there).
--
-- SAFE-TRANSITION SHAPE, applied identically to every policy in this file
-- (per explicit instruction: region boundary must apply to BOTH legacy
-- and new-model accounts, and must never be structured as
-- `legacy_allowed OR (new_permission AND region_allowed)`, which would
-- let legacy accounts bypass the region boundary entirely):
--
--   is_current_user_active()
--   AND (
--     is_super_admin()
--     OR (
--       tenant_id = get_current_tenant_id()
--       AND region_allowed(<row's region>)
--       AND (
--         <legitimate legacy role_level action permission, UNCHANGED from
--          what is live today for that table/action -- never widened>
--         OR has_permission('<new permission key>')
--       )
--     )
--   )
--
-- has_permission() already returns true unconditionally for
-- is_business_admin() (see 20260817000000), so Business Admin gets
-- "same tenant + all regions + all actions" without needing its own
-- separate OR-branch in any policy below -- region_allowed() also already
-- returns true for is_business_admin(). Business Admin is a same-TENANT
-- concept; is_super_admin() remains the only cross-tenant bypass, kept
-- entirely separate per explicit instruction.
--
-- Every WRITABLE policy below defines BOTH USING (existing-row access)
-- and WITH CHECK (resulting-row state) -- required specifically so a
-- caller cannot use an UPDATE's own new values to move a row outside
-- their authorized region (e.g. a Southern HR Manager submitting
-- region_id = Northern on an otherwise-authorized edit).
-- ============================================================

-- ============================================================
-- PART 1: profiles -- SPECIAL POLICY, NOT the generic direct-region shape
-- ============================================================
-- profiles holds APPLICATION LOGIN ACCOUNTS, not regional business data.
-- A Human Resource Manager does not get to enumerate every login account
-- in their region merely because they share a region with those accounts
-- -- there is no legitimate reason for a non-admin functional user to
-- read anyone's profile but their own. Target shape, exactly as specified:
--   normal active user   -> SELECT own profile only
--   business Admin       -> SELECT/INSERT/UPDATE any profile in own tenant
--                            (the "authorized Admin user-management
--                            workflow" -- both the future Edge Function,
--                            which uses a service-role client and bypasses
--                            RLS entirely, AND any direct Admin-driven
--                            management action, e.g. UserManagement.tsx's
--                            disable-user path before the Edge Function
--                            replaces it)
--   super admin          -> platform behavior preserved, unchanged
--
-- SELF-SELECT WHILE DISABLED IS A DELIBERATE, NARROW EXCEPTION: a
-- disabled user must still be able to read their OWN profile (role,
-- region, tenant, name, is_active) so the login flow can show a clear
-- "your account has been disabled, contact your administrator" message
-- instead of an opaque failure. This grants nothing beyond what a
-- disabled user already knows about themselves, and only applies to
-- SELECT, never to any write.
-- ============================================================

DROP POLICY IF EXISTS "Users can view profiles in their tenant" ON profiles;
CREATE POLICY "Users can view own profile or, as Admin, their tenant's" ON profiles
FOR SELECT USING (
  is_super_admin()
  OR id = auth.uid()
  OR (is_current_user_active() AND is_business_admin() AND tenant_id = get_current_tenant_id())
);

-- SECURITY FIX (found during this pass, not merely a redesign): the
-- previous policy's `WITH CHECK (id = auth.uid() OR is_super_admin())`
-- placed NO restriction at all on the VALUES being inserted -- any
-- authenticated Supabase user (any auth.users row, regardless of whether
-- it already had a profile) could INSERT a profiles row for themselves
-- with an ARBITRARY tenant_id, role_level = 1, is_super_admin = true,
-- directly via a REST call, since RLS never inspected those columns'
-- values, only WHO was inserting. That is a full privilege-escalation +
-- cross-tenant-injection hole. This policy closes it completely: no
-- authenticated session, of any role including a brand-new one with no
-- profile at all, may self-insert a profiles row anymore -- profile
-- creation is now exclusively either (a) the trusted server-side
-- create-user Edge Function (service-role client, bypasses RLS, does its
-- own authorization + validation BEFORE inserting -- see that function),
-- or (b) a business Admin/super-admin creating a row for someone else
-- within their own tenant.
DROP POLICY IF EXISTS "Users can insert their own profile" ON profiles;
CREATE POLICY "Only an authorized Admin may insert a profile" ON profiles
FOR INSERT WITH CHECK (
  is_super_admin()
  OR (is_current_user_active() AND is_business_admin() AND tenant_id = get_current_tenant_id())
);

DROP POLICY IF EXISTS "Users can update their own profile" ON profiles;
CREATE POLICY "Users can update own profile or, as Admin, their tenant's" ON profiles
FOR UPDATE USING (
  is_super_admin()
  OR (is_current_user_active() AND id = auth.uid())
  OR (is_current_user_active() AND is_business_admin() AND tenant_id = get_current_tenant_id())
)
WITH CHECK (
  is_super_admin()
  OR (is_current_user_active() AND id = auth.uid())
  OR (is_current_user_active() AND is_business_admin() AND tenant_id = get_current_tenant_id())
);
-- DELETE policy ("Super admins can delete profiles") is unchanged --
-- still super-admin-only; is_super_admin() itself now additionally
-- requires the CALLER to be active (see 20260817000000 PART 0).

-- Self-privilege-escalation prevention, EXTENDED beyond the original
-- (is_super_admin/role_level/tenant_id only) to also lock `role` and
-- `region_id` -- the two new fields this migration introduces as
-- security-relevant. Split into two concerns:
--   1. is_super_admin can ONLY ever be changed by an EXISTING super-admin
--      -- never by a mere business Admin, never by the user themselves,
--      no matter whose row is being updated. This is what guarantees "a
--      normal Admin must never be able to create/promote another
--      is_super_admin account through browser-supplied input."
--   2. tenant_id/role/role_level/region_id can never be changed by a
--      user editing their OWN row (self-escalation, blocked
--      unconditionally, even for an Admin editing themselves) -- but CAN
--      be changed by an authorized Admin/super-admin editing SOMEONE
--      ELSE's row (the legitimate user-management workflow).
CREATE OR REPLACE FUNCTION prevent_profile_privilege_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_super_admin() THEN
    NEW.is_super_admin := OLD.is_super_admin;
  END IF;

  IF NEW.id = auth.uid() THEN
    NEW.role_level := OLD.role_level;
    NEW.role := OLD.role;
    NEW.region_id := OLD.region_id;
    NEW.tenant_id := OLD.tenant_id;
  ELSIF NOT (is_super_admin() OR is_business_admin()) THEN
    NEW.role_level := OLD.role_level;
    NEW.role := OLD.role;
    NEW.region_id := OLD.region_id;
    NEW.tenant_id := OLD.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;
-- Trigger attachment itself (trigger_prevent_profile_privilege_escalation
-- BEFORE UPDATE ON profiles) is unchanged from 20260727000001 -- only the
-- function body above changed via CREATE OR REPLACE, same trigger.
--
-- EXECUTE ACL is already hardened at this function's original definition
-- (20260803000000_role_level_rls_hardening.sql: REVOKE ALL FROM PUBLIC,
-- anon, AND authenticated -- trigger-only, no legitimate direct client
-- caller at all) and CREATE OR REPLACE FUNCTION preserves an existing
-- function's privileges unchanged, so no new grant statement is needed
-- here. Restated as idempotent reinforcement anyway, for this file's own
-- self-sufficiency:
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM anon;
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM authenticated;

-- ============================================================
-- PART 2: employees
-- ============================================================
-- Legacy compatibility, preserved EXACTLY as it exists today (confirmed
-- via direct migration audit): SELECT/INSERT/UPDATE have never had a
-- role_level gate at all -- any authenticated tenant member (role_level
-- 1-4) can currently view/create/edit employees; DELETE has been
-- super-admin-only since 20260803000000 (not role_level-gated at all).
-- This migration does not widen or narrow ANY of that -- it only adds
-- the region boundary, which today does not exist at all for this table.
-- ============================================================

DROP POLICY IF EXISTS "Users can view employees in their tenant" ON employees;
CREATE POLICY "Employees: view within tenant+region, action or legacy permitted" ON employees
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() IS NOT NULL OR has_permission('employees.view'))
    )
  )
);

DROP POLICY IF EXISTS "Users can insert employees in their tenant" ON employees;
CREATE POLICY "Employees: create within tenant+region, action or legacy permitted" ON employees
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() IS NOT NULL OR has_permission('employees.create'))
    )
  )
);

DROP POLICY IF EXISTS "Users can update employees in their tenant" ON employees;
CREATE POLICY "Employees: update within tenant+region, action or legacy permitted" ON employees
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() IS NOT NULL OR has_permission('employees.edit'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() IS NOT NULL OR has_permission('employees.edit'))
    )
  )
);
-- "Super admins can delete employees" (20260803000000) is unchanged --
-- is_super_admin() itself already requires active, per Phase A.

-- REGION-REASSIGNMENT LOCK (explicit instruction, item 18's worked
-- example): HR Manager has full normal Employee management inside their
-- assigned region, but may NOT move an employee to a DIFFERENT region --
-- only an Admin (business or super) may do that. WITH CHECK alone cannot
-- express this (it only sees NEW, never OLD), so this is a trigger, the
-- same shape as guard_salary_advance_plan_terms() elsewhere in this
-- schema. Applies to BOTH legacy and new-model callers identically --
-- there is no legacy exemption from this rule, since no existing
-- workflow needs a non-admin to reassign an employee's region.
CREATE OR REPLACE FUNCTION guard_employee_region_reassignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.region_id IS DISTINCT FROM OLD.region_id THEN
    IF NOT (is_super_admin() OR is_business_admin()) THEN
      RAISE EXCEPTION 'Only an Admin may reassign an employee to a different region';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_employee_region_reassignment ON employees;
CREATE TRIGGER trg_guard_employee_region_reassignment
BEFORE UPDATE ON employees
FOR EACH ROW EXECUTE FUNCTION guard_employee_region_reassignment();

-- Trigger-only: no legitimate direct client EXECUTE. `REVOKE ALL FROM
-- PUBLIC` alone would still leave direct `anon` AND `authenticated`
-- EXECUTE grants in place on Supabase (its default-privilege rule grants
-- both directly at creation, independent of PUBLIC -- see the note on
-- prevent_profile_privilege_escalation() above), so all three are revoked
-- explicitly, immediately at this function's creation. A trigger fires
-- regardless of the DML-issuing role's own EXECUTE privilege on the
-- trigger function (verified empirically -- that check applies only to a
-- direct `SELECT function_name()`-style call), so employees UPDATE still
-- enforces this guard for authenticated callers with zero grant here.
REVOKE ALL ON FUNCTION guard_employee_region_reassignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_employee_region_reassignment() FROM anon;
REVOKE ALL ON FUNCTION guard_employee_region_reassignment() FROM authenticated;

-- ============================================================
-- PART 3: applicants (Recruitment)
-- ============================================================
-- region_id already exists on this table (20260727000000) but the
-- frontend never set it (Recruitment.tsx has it explicitly commented
-- out) -- wired up properly in this rollout's frontend changes. Legacy
-- compatibility preserved exactly as live today: SELECT/INSERT/UPDATE/
-- DELETE all currently role_level <= 2 (20260803000000 for write,
-- 20260804000003 for SELECT specifically).
--
-- TRANSITIONAL NOTE: every existing applicant row today has region_id =
-- NULL (never populated). Once this policy is live, a non-admin
-- (region-scoped) HR Manager will NOT see pre-existing NULL-region
-- applicants -- region_allowed(NULL) is only true for is_business_admin()/
-- is_super_admin(), never for a real (non-NULL) region_id caller, since
-- IS NOT DISTINCT FROM only matches NULL against NULL, and a real HR
-- Manager's own current_user_region_id() is never NULL (enforced by the
-- Phase A region-required constraint). This is a known, deliberate
-- transitional consequence, not a bug: pre-existing un-regioned
-- applicants become Admin-only-visible until an Admin backfills their
-- region or they naturally age out. New applicants created going forward
-- get a real region (see PART 3's INSERT trigger below), so this is a
-- one-time, shrinking transitional set, not a permanent gap.
-- ============================================================

DROP POLICY IF EXISTS "Managers can view applicants in their tenant" ON applicants;
CREATE POLICY "Applicants: view within tenant+region, action or legacy permitted" ON applicants
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() <= 2 OR has_permission('recruitment.view'))
    )
  )
);

DROP POLICY IF EXISTS "Managers can insert applicants in their tenant" ON applicants;
CREATE POLICY "Applicants: create within tenant+region, action or legacy permitted" ON applicants
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() <= 2 OR has_permission('recruitment.create'))
    )
  )
);

DROP POLICY IF EXISTS "Managers can update applicants in their tenant" ON applicants;
CREATE POLICY "Applicants: update within tenant+region, action or legacy permitted" ON applicants
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() <= 2 OR has_permission('recruitment.edit'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() <= 2 OR has_permission('recruitment.edit'))
    )
  )
);

DROP POLICY IF EXISTS "Managers can delete applicants in their tenant" ON applicants;
CREATE POLICY "Applicants: delete within tenant+region, action or legacy permitted" ON applicants
FOR DELETE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND region_allowed(region_id)
      AND (current_user_role_level() <= 2 OR has_permission('recruitment.delete'))
    )
  )
);

-- Mirrors guard_employee_region_reassignment(): a non-admin HR Manager
-- may only create/keep applicants inside their OWN region -- may not
-- forge a different region on create, nor move an existing applicant to
-- a different region on update. Admin (business or super) may
-- create/operate across regions freely.
CREATE OR REPLACE FUNCTION guard_applicant_region_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF is_super_admin() OR is_business_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.region_id IS DISTINCT FROM current_user_region_id() THEN
      RAISE EXCEPTION 'You may only create applicants in your own assigned region';
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.region_id IS DISTINCT FROM OLD.region_id THEN
    RAISE EXCEPTION 'Only an Admin may reassign an applicant to a different region';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_applicant_region_assignment ON applicants;
CREATE TRIGGER trg_guard_applicant_region_assignment
BEFORE INSERT OR UPDATE ON applicants
FOR EACH ROW EXECUTE FUNCTION guard_applicant_region_assignment();

-- Trigger-only, same reasoning as guard_employee_region_reassignment()
-- above: no legitimate direct client EXECUTE, and PUBLIC alone is not
-- sufficient to remove anon's/authenticated's own direct grants.
REVOKE ALL ON FUNCTION guard_applicant_region_assignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_applicant_region_assignment() FROM anon;
REVOKE ALL ON FUNCTION guard_applicant_region_assignment() FROM authenticated;

-- ============================================================
-- PART 4: audit_logs -- Admin-only view, NOT generic regional data
-- ============================================================
-- Business permission is explicit: audit.view = Admin (business or
-- super) only. HR Manager/Accountant/Operations Manager are ALL denied,
-- regardless of region -- audit history is not scoped by region at all,
-- it is scoped by "are you an Admin." The application may still INSERT
-- its own audit events through the existing logAudit() mechanism
-- (unchanged, tenant-scoped, open to any active authenticated user --
-- writing an audit record about your own action is not a privileged
-- read of history).
-- ============================================================

DROP POLICY IF EXISTS "Users can view audit logs in their tenant" ON audit_logs;
CREATE POLICY "Audit logs: view is Admin-only" ON audit_logs
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (tenant_id = get_current_tenant_id() AND is_business_admin())
  )
);

DROP POLICY IF EXISTS "Users can insert audit logs" ON audit_logs;
CREATE POLICY "Audit logs: any active tenant member may insert their own audit event" ON audit_logs
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (is_super_admin() OR tenant_id = get_current_tenant_id())
);

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- DROP POLICY IF EXISTS + CREATE
-- POLICY, DROP TRIGGER IF EXISTS + CREATE TRIGGER, CREATE OR REPLACE
-- FUNCTION throughout.
--
-- DEPENDENCIES: requires 20260817000000 (has_permission(), region_allowed(),
-- is_business_admin(), is_current_user_active(), current_user_region_id()).
--
-- BEHAVIOR CHANGE FOR EXISTING (LEGACY) CALLERS:
--   - employees/applicants: region enforcement is NEW -- a legacy
--     Manager/Supervisor/Staff whose profile has a region_id set will now
--     only see/write employees and applicants IN that region (previously
--     tenant-wide, an explicitly-flagged pre-existing gap this migration
--     closes). A legacy account with region_id = NULL is unaffected
--     (region_allowed(NULL-owning-row) still only matches for them if
--     THEIR OWN region is also NULL, i.e. unchanged tenant-wide access --
--     matching "NULL means system-wide," consistent with how is_super_admin
--     already worked before this rollout).
--   - profiles: a non-Admin, non-self profile read (enumerating other
--     users) is now denied for every role -- previously allowed
--     tenant-wide. No existing frontend page other than UserManagement.tsx
--     (Admin-only route) does this, so no legitimate workflow regresses.
--   - audit_logs: SELECT is now Admin-only -- previously tenant-wide.
--     AuditLogs.tsx already gated on is_super_admin() client-side, so no
--     legitimate legacy workflow regresses; this closes the gap where a
--     non-super-admin, non-UI (direct REST) caller could previously read
--     the whole tenant's audit history.
--
-- VERIFICATION SQL:
--   SELECT tgname FROM pg_trigger WHERE tgname IN
--     ('trg_guard_employee_region_reassignment','trg_guard_applicant_region_assignment');
--   -- expected: 2 rows
--   SELECT policyname, cmd FROM pg_policies WHERE tablename IN
--     ('profiles','employees','applicants','audit_logs') ORDER BY tablename, cmd;
--
-- ROLLBACK: re-run each superseded migration's own CREATE POLICY blocks
-- verbatim (20260727000000 for profiles/employees/applicants/audit_logs
-- base policies, 20260803000000/20260804000003 for the applicants
-- role_level overlays), and:
--   DROP TRIGGER IF EXISTS trg_guard_employee_region_reassignment ON employees;
--   DROP FUNCTION IF EXISTS guard_employee_region_reassignment();
--   DROP TRIGGER IF EXISTS trg_guard_applicant_region_assignment ON applicants;
--   DROP FUNCTION IF EXISTS guard_applicant_region_assignment();
-- ============================================================
