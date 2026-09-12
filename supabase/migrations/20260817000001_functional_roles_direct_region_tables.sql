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
--
-- SECURITY FIX 2 (2026-09-09, production preflight -- found by re-review of
-- this exact policy): the business-Admin branch above restricted WHO could
-- insert (an active business Admin, same tenant) but placed no restriction
-- on the NEW row's OWN `is_super_admin` value -- WITH CHECK only inspects
-- the row being inserted, never who is inserting it beyond the function
-- calls it names, so nothing here stopped a genuine (non-super) business
-- Admin from inserting a brand-new profiles row, in their own tenant, with
-- is_super_admin = true -- a direct platform-privilege-escalation path,
-- contradicting this file's own stated invariant ("a normal Admin must
-- never be able to create/promote another is_super_admin account through
-- browser-supplied input" -- see PART 1's target-shape comment above).
-- `prevent_profile_privilege_escalation()` does NOT cover this: it is a
-- BEFORE UPDATE trigger only, never fires on INSERT.
--
-- Reproduced empirically against a disposable local Postgres instance
-- (with the table-level GRANTs Supabase applies by default, matching the
-- window this migration's own policy actually governs -- before
-- 20260817000009's later, unrelated REVOKE INSERT ON profiles FROM
-- authenticated happens to also close this path from a different layer):
-- an active, non-super business Admin (is_super_admin() = false,
-- is_business_admin() = true) successfully inserted a new same-tenant
-- profiles row with is_super_admin = true under the pre-fix policy.
-- Relying on 20260817000009's later grant revocation as the real boundary
-- here would leave a live escalation window during any staged,
-- one-migration-at-a-time rollout between the two migrations, and is an
-- incidental side effect of an unrelated architectural decision (browser
-- self-profile-creation was never a legitimate flow), not a substitute for
-- this policy being correct on its own terms.
--
-- FIX: the business-Admin branch now additionally requires the NEW row's
-- own `is_super_admin` to be false. `profiles.is_super_admin` (the column)
-- is explicitly table-qualified to disambiguate it from the same-named
-- `is_super_admin()` function called earlier in this same expression --
-- Postgres itself does not require the qualification (a function call
-- always needs parentheses; a bare identifier is always a column
-- reference), but the schema-wide reuse of this exact name for both a
-- column and a function makes explicit qualification the only reading
-- that is unambiguous to a human reviewer, which matters as much here as
-- syntactic correctness does. COALESCE(...,false) treats a NULL
-- is_super_admin (not expected -- the column defaults to false -- but not
-- guaranteed by a NOT NULL constraint either) the same as false, i.e.
-- fails closed rather than accidentally permitting it through a NULL
-- comparison. The genuine platform-super-admin branch is deliberately left
-- unrestricted -- a real super admin creating another super-admin account
-- is expected, existing behavior, not the gap being closed here.
DROP POLICY IF EXISTS "Users can insert their own profile" ON profiles;
DROP POLICY IF EXISTS "Only an authorized Admin may insert a profile" ON profiles;
CREATE POLICY "Only an authorized Admin may insert a profile" ON profiles
FOR INSERT WITH CHECK (
  is_super_admin()
  OR (
    is_current_user_active()
    AND is_business_admin()
    AND tenant_id = get_current_tenant_id()
    AND COALESCE(profiles.is_super_admin, false) = false
  )
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

-- Drops BOTH possible prior names for this policy, not just the most
-- recent one: 20260804000003_restrict_applicants_select.sql (which
-- renamed the original "Users can view applicants in their tenant" to
-- "Managers can view applicants in their tenant") is a deliberately
-- DECOUPLED, later-applied "Phase 2" migration with its own separate
-- deploy-ordering precondition (see that file's own header) -- unlike
-- every other applicants policy rename in this schema, which happens
-- atomically within a single migration (20260803000000, for INSERT/
-- UPDATE/DELETE). If 20260804000003 has not yet been applied to a given
-- environment by the time this migration runs, dropping only "Managers
-- can view applicants in their tenant" would leave the ORIGINAL
-- tenant-wide "Users can view applicants in their tenant" policy live
-- alongside the new regional one below -- both PERMISSIVE, so Postgres
-- ORs them together and the old tenant-wide policy silently bypasses the
-- new region restriction entirely. Confirmed as a real gap found while
-- applying this migration to STAGING. Dropping both names is safe and
-- idempotent regardless of which one (if either) currently exists.
DROP POLICY IF EXISTS "Users can view applicants in their tenant" ON applicants;
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

-- SECURITY FIX 3 (2026-09-09, production preflight -- found by explicit
-- request to re-review this exact policy after SECURITY FIX 2 above): the
-- original WITH CHECK gated WHO could insert (active, own tenant) but
-- never bound the row's own actor-attribution columns to the caller's real
-- identity. `user_id` (`REFERENCES profiles(id)`), `user_email`, and
-- `user_role` are all plain client-supplied text/uuid with nothing
-- stopping an active authenticated caller from inserting a row that FALSELY
-- attributes an action to a different user_id, a fabricated user_email, or
-- an inflated user_role (e.g. a real business Admin inserting a row that
-- claims 'super_admin') -- audit-trail forgery, not a privileged-read
-- concern, but still a real integrity gap: AuditLogs.tsx/components/
-- AuditLogs.tsx render these columns as who-did-it, trusted at face value.
--
-- INSPECTED EVERY WRITER before fixing (per explicit instruction):
--   - src/utils/auditLogger.ts's logAudit() -- the ONLY live, imported
--     direct-insert call site (13 pages import it) -- always sets
--     user_id: user.id and user_email: user.email from
--     supabase.auth.getUser() (the caller's OWN session, never a
--     parameter), and user_role computed from the CALLER's OWN profile
--     (is_super_admin -> 'super_admin', role_level 1/2/3 ->
--     'admin'/'manager'/'supervisor', else 'user') -- never a different
--     user's identity.
--   - src/utils/currentMonth.ts has its OWN separate direct insert (not
--     routed through auditLogger.ts): sets user_id/user_email the same
--     way (the caller's own auth.getUser()), but does NOT set user_role at
--     all (omitted -> NULL) -- a second real, live, legitimate call site
--     this fix must not break.
--   - src/utils/audit.ts's logAudit() calls an RPC, `log_audit_event`,
--     that does not exist anywhere in this migration set (grepped every
--     migration -- zero hits) and is not imported by any page (grepped
--     every import of 'utils/audit' -- zero hits) -- dead code, not a real
--     call site, does not need to be accommodated.
--   - src/utils/logging.ts's sendToDatabase() has
--     LOG_CONFIG.enableDatabase hardcoded `false` ("Temporarily disabled
--     to prevent errors") -- its insert is unreachable, and even if
--     re-enabled it omits the NOT NULL `action` column and would fail on
--     that constraint regardless of RLS -- dead/broken code, not a real
--     call site.
--   - Every SECURITY DEFINER RPC that writes audit_logs directly
--     (process_payroll_batch, salary-advance RPCs, terminal-dues RPCs,
--     the user-edit RPC) bypasses RLS entirely for its own writes --
--     confirmed audit_logs has relforcerowsecurity = false (the default;
--     no migration in this repo ever sets FORCE ROW LEVEL SECURITY on any
--     table), so this policy change has zero effect on them. Same for the
--     create-user/disable-user Edge Functions' service-role inserts.
--
-- FIX: user_id is now REQUIRED to equal auth.uid() exactly -- no
-- legitimate direct-authenticated-insert workflow was found that needs a
-- NULL or different actor, so this is a strict equality, not a
-- permissive NULL-allowed check. user_email, if supplied, must equal
-- auth.email() (Supabase's own built-in JWT-email helper, the same
-- platform-provided function family as auth.uid()/auth.role() -- not
-- defined by this repo, same as those two aren't) -- NULL remains allowed
-- only because nothing in the schema (no NOT NULL constraint) requires it
-- and no forgery is possible by OMITTING a claim, only by supplying a
-- false one. user_role, if supplied, must equal a value recomputed here
-- from the CALLER'S OWN real profile row using the exact same
-- is_super_admin/role_level -> label mapping auditLogger.ts itself uses
-- (including its own existing quirk: a functional-role account, e.g.
-- role='admin' with role_level NULL, maps to 'user' here exactly as it
-- does client-side today, since role_level is the only column that
-- mapping ever inspects -- this fix enforces what the app actually
-- produces, not a redesigned labeling scheme) -- NULL remains allowed
-- because currentMonth.ts's real, live insert legitimately omits it.
-- tenant_id forgery was already blocked by the pre-existing
-- `tenant_id = get_current_tenant_id()` check -- unchanged, restated here
-- only for completeness of this comment, not modified.
DROP POLICY IF EXISTS "Users can insert audit logs" ON audit_logs;
DROP POLICY IF EXISTS "Audit logs: any active tenant member may insert their own audit event" ON audit_logs;
CREATE POLICY "Audit logs: any active tenant member may insert their own audit event" ON audit_logs
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (is_super_admin() OR tenant_id = get_current_tenant_id())
  AND user_id = auth.uid()
  AND (user_email IS NULL OR user_email = auth.email())
  AND (
    user_role IS NULL
    OR user_role = (
      SELECT CASE
        WHEN p.is_super_admin THEN 'super_admin'
        WHEN p.role_level = 1 THEN 'admin'
        WHEN p.role_level = 2 THEN 'manager'
        WHEN p.role_level = 3 THEN 'supervisor'
        ELSE 'user'
      END
      FROM profiles p WHERE p.id = auth.uid()
    )
  )
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
--   SELECT tablename, cmd, COUNT(*), array_agg(policyname) FROM pg_policies
--     WHERE tablename IN ('profiles','employees','applicants','audit_logs')
--     GROUP BY tablename, cmd HAVING COUNT(*) > 1 ORDER BY tablename, cmd;
--   -- expected: 0 rows -- catches exactly the class of bug this revision
--   -- fixes (two PERMISSIVE policies for the same table+command, which
--   -- Postgres ORs together rather than replaces). In particular:
--   SELECT policyname FROM pg_policies WHERE tablename = 'applicants' AND cmd = 'SELECT';
--   -- expected: exactly 1 row, policyname =
--   -- "Applicants: view within tenant+region, action or legacy permitted"
--   -- -- NOT also "Users can view applicants in their tenant" or
--   -- "Managers can view applicants in their tenant".
--
-- REGRESSION TEST -- profiles INSERT, is_super_admin escalation (2026-09-09):
-- confirms SECURITY FIX 2 above without persisting anything. Requires an
-- active, non-super business Admin id (<BUSINESS_ADMIN_ID>, is_active=true,
-- role='admin' or role_level=1, is_super_admin=false), a genuinely active
-- platform super-admin id (<SUPER_ADMIN_ID>, is_active=true,
-- is_super_admin=true), a second tenant id (<OTHER_TENANT_ID>) different
-- from the business Admin's own tenant, and a disposable never-used auth
-- id for the profile-less case (<PROFILELESS_ID>). Every INSERT below
-- targets a fresh, not-yet-existing profiles.id and is wrapped in its own
-- BEGIN/ROLLBACK -- nothing persists regardless of pass/fail.
--
--   -- 1. Business Admin inserts an ORDINARY same-tenant profile (no
--   --    is_super_admin supplied -- defaults false) -- expect SUCCESS:
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<BUSINESS_ADMIN_ID>', true);
--   INSERT INTO profiles (id, tenant_id, email, full_name, role_level, is_active)
--     VALUES (gen_random_uuid(), (SELECT tenant_id FROM profiles WHERE id = '<BUSINESS_ADMIN_ID>'),
--             'regtest-ordinary@test.local', 'Regression Ordinary', 4, true);
--   ROLLBACK;
--   -- expected: INSERT 0 1, no error.
--
--   -- 2. Business Admin inserts is_super_admin=true (own tenant) -- expect
--   --    the exact failure SECURITY FIX 2 exists to produce:
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<BUSINESS_ADMIN_ID>', true);
--   INSERT INTO profiles (id, tenant_id, email, full_name, is_super_admin, is_active)
--     VALUES (gen_random_uuid(), (SELECT tenant_id FROM profiles WHERE id = '<BUSINESS_ADMIN_ID>'),
--             'regtest-escalate@test.local', 'Regression Escalation', true, true);
--   ROLLBACK;
--   -- expected: ERROR -- new row violates row-level security policy for table "profiles".
--
--   -- 3. Business Admin inserts into a DIFFERENT tenant -- expect FAILURE
--   --    (unrelated to this fix -- the pre-existing tenant check must still hold):
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<BUSINESS_ADMIN_ID>', true);
--   INSERT INTO profiles (id, tenant_id, email, full_name, is_super_admin, is_active)
--     VALUES (gen_random_uuid(), '<OTHER_TENANT_ID>', 'regtest-crosstenant@test.local', 'Regression Cross-Tenant', false, true);
--   ROLLBACK;
--   -- expected: ERROR -- new row violates row-level security policy for table "profiles".
--
--   -- 4. Genuine platform super-admin inserts is_super_admin=true -- expect
--   --    SUCCESS (the super-admin branch is deliberately unrestricted):
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<SUPER_ADMIN_ID>', true);
--   INSERT INTO profiles (id, tenant_id, email, full_name, is_super_admin, is_active)
--     VALUES (gen_random_uuid(), (SELECT tenant_id FROM profiles WHERE id = '<BUSINESS_ADMIN_ID>'),
--             'regtest-newsuper@test.local', 'Regression New Super Admin', true, true);
--   ROLLBACK;
--   -- expected: INSERT 0 1, no error.
--
--   -- 5. Profile-less authenticated caller (no matching profiles row at
--   --    all) attempts to self-insert an elevated profile -- expect FAILURE:
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<PROFILELESS_ID>', true);
--   INSERT INTO profiles (id, tenant_id, email, full_name, is_super_admin, is_active)
--     VALUES ('<PROFILELESS_ID>', (SELECT tenant_id FROM profiles WHERE id = '<BUSINESS_ADMIN_ID>'),
--             'regtest-nobody@test.local', 'Regression Nobody', true, true);
--   ROLLBACK;
--   -- expected: ERROR -- new row violates row-level security policy for table "profiles".
--
-- Empirically run (disposable local Postgres, matching Supabase's default
-- authenticated table grants): all 5 produced exactly the expected
-- outcome above.
--
-- REGRESSION TEST -- audit_logs INSERT, actor-attribution forgery
-- (2026-09-09): confirms SECURITY FIX 3 above without persisting anything.
-- Requires an active legacy role_level=1 caller (<LEGACY_ADMIN_ID>, real
-- email <LEGACY_ADMIN_EMAIL>), an active functional-role caller with
-- role_level NULL (<FUNCTIONAL_ADMIN_ID>, real email
-- <FUNCTIONAL_ADMIN_EMAIL>), a genuinely active super-admin
-- (<SUPER_ADMIN_ID>, real email <SUPER_ADMIN_EMAIL>), an inactive caller
-- (<INACTIVE_ID>), a deleted caller (<DELETED_ID>), a second tenant id
-- (<OTHER_TENANT_ID>), and a disposable never-used auth id
-- (<PROFILELESS_ID>). Every test wraps its own BEGIN/ROLLBACK.
--
--   -- 1. Legitimate auditLogger.ts shape (user_id+email+role, role_level=1
--   --    -> 'admin') -- expect SUCCESS:
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<LEGACY_ADMIN_ID>', true);
--   INSERT INTO audit_logs (user_id, user_email, user_role, action, entity_type, entity_id)
--     VALUES (auth.uid(), '<LEGACY_ADMIN_EMAIL>', 'admin', 'CREATE', 'employees', 'regtest1');
--   ROLLBACK;
--   -- expected: INSERT 0 1, no error.
--
--   -- 2. Legitimate currentMonth.ts shape (user_id+email, NO user_role,
--   --    functional-role caller) -- expect SUCCESS:
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<FUNCTIONAL_ADMIN_ID>', true);
--   INSERT INTO audit_logs (user_id, user_email, action, entity_type, entity_id)
--     VALUES (auth.uid(), '<FUNCTIONAL_ADMIN_EMAIL>', 'UPDATE', 'system_settings', 'current_payroll_month');
--   ROLLBACK;
--   -- expected: INSERT 0 1, no error.
--
--   -- 3. Forged user_id -- expect FAILURE:
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<LEGACY_ADMIN_ID>', true);
--   INSERT INTO audit_logs (user_id, user_email, user_role, action, entity_type, entity_id)
--     VALUES ('<some other real profile id>', '<LEGACY_ADMIN_EMAIL>', 'admin', 'CREATE', 'employees', 'regtest3');
--   ROLLBACK;
--   -- expected: ERROR -- new row violates row-level security policy for table "audit_logs".
--
--   -- 4. Forged user_email -- expect FAILURE:
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<LEGACY_ADMIN_ID>', true);
--   INSERT INTO audit_logs (user_id, user_email, user_role, action, entity_type, entity_id)
--     VALUES (auth.uid(), 'someone-else@evil.example', 'admin', 'CREATE', 'employees', 'regtest4');
--   ROLLBACK;
--   -- expected: ERROR -- new row violates row-level security policy for table "audit_logs".
--
--   -- 5. Forged user_role (claims super_admin while actually a business
--   --    Admin) -- expect FAILURE:
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<LEGACY_ADMIN_ID>', true);
--   INSERT INTO audit_logs (user_id, user_email, user_role, action, entity_type, entity_id)
--     VALUES (auth.uid(), '<LEGACY_ADMIN_EMAIL>', 'super_admin', 'CREATE', 'employees', 'regtest5');
--   ROLLBACK;
--   -- expected: ERROR -- new row violates row-level security policy for table "audit_logs".
--
--   -- 6. Cross-tenant insert -- expect FAILURE (pre-existing tenant check,
--   --    unrelated to this fix, must still hold):
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<LEGACY_ADMIN_ID>', true);
--   INSERT INTO audit_logs (tenant_id, user_id, user_email, user_role, action, entity_type, entity_id)
--     VALUES ('<OTHER_TENANT_ID>', auth.uid(), '<LEGACY_ADMIN_EMAIL>', 'admin', 'CREATE', 'employees', 'regtest6');
--   ROLLBACK;
--   -- expected: ERROR -- new row violates row-level security policy for table "audit_logs".
--
--   -- 7. Inactive caller -- expect FAILURE:
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<INACTIVE_ID>', true);
--   INSERT INTO audit_logs (user_id, user_email, action, entity_type, entity_id)
--     VALUES (auth.uid(), 'inactive@test.local', 'CREATE', 'employees', 'regtest7');
--   ROLLBACK;
--   -- expected: ERROR -- new row violates row-level security policy for table "audit_logs".
--
--   -- 8. Deleted caller -- expect FAILURE:
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<DELETED_ID>', true);
--   INSERT INTO audit_logs (user_id, user_email, action, entity_type, entity_id)
--     VALUES (auth.uid(), 'deleted@test.local', 'CREATE', 'employees', 'regtest8');
--   ROLLBACK;
--   -- expected: ERROR -- new row violates row-level security policy for table "audit_logs".
--
--   -- 9. Profile-less caller -- expect FAILURE:
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<PROFILELESS_ID>', true);
--   INSERT INTO audit_logs (user_id, user_email, action, entity_type, entity_id)
--     VALUES (auth.uid(), 'nobody@test.local', 'CREATE', 'employees', 'regtest9');
--   ROLLBACK;
--   -- expected: ERROR -- new row violates row-level security policy for table "audit_logs".
--
--   -- 10. Genuine active super-admin, correct own shape -- expect SUCCESS
--   --     (deliberately unrestricted, per this table's existing
--   --     is_super_admin() bypass, unchanged by this fix):
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<SUPER_ADMIN_ID>', true);
--   INSERT INTO audit_logs (user_id, user_email, user_role, action, entity_type, entity_id)
--     VALUES (auth.uid(), '<SUPER_ADMIN_EMAIL>', 'super_admin', 'CREATE', 'employees', 'regtest10');
--   ROLLBACK;
--   -- expected: INSERT 0 1, no error.
--
-- Empirically run (disposable local Postgres, matching Supabase's default
-- authenticated table grants, plus auth.email() -- a real Supabase
-- platform-provided JWT-email helper this repo does not itself define,
-- same as auth.uid()/auth.role() -- stubbed locally only for this test):
-- all 10 produced exactly the expected outcome above. Also confirmed
-- audit_logs.relforcerowsecurity = false (the platform/repo-wide default),
-- which structurally guarantees every SECURITY DEFINER RPC's own
-- audit_logs write, and every service-role Edge Function write, remains
-- entirely unaffected by this policy regardless of the values it sets.
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
