-- ============================================================
-- MIGRATION: Atomic functional-user profile edit RPC + last-Admin invariant
-- Date: 2026-08-22
-- ============================================================
--
-- WHY THIS EXISTS
-- -----------------------------------------------------------
-- UserManagement.tsx's Edit action only ever worked for LEGACY accounts
-- (role_level IS NOT NULL) -- every functional-role account (hr_manager/
-- accountant/operations_manager/functional admin) has role_level = NULL
-- by design (create-user's own header), so isLegacyUser() was always
-- false for them and no Edit UI ever existed. This migration adds the
-- server-side half of the fix: a narrow, atomic SECURITY DEFINER RPC that
-- edits full_name/department/role/region_id for a functional-role target,
-- called from a NEW update-user Edge Function (companion change, not part
-- of this SQL file) via a client scoped to the CALLER's own JWT.
--
-- TWO EARLIER DESIGN MISTAKES, CAUGHT AND CORRECTED BEFORE THIS MIGRATION
-- WAS WRITTEN (see the review history that produced this file):
--   1. A service-role Supabase client has no real `sub` JWT claim, so
--      auth.uid() is NULL for every query it issues. Empirically verified
--      against this exact prevent_profile_privilege_escalation() body: an
--      UPDATE targeting someone else's row, issued under a NULL-auth.uid()
--      session, is SILENTLY reverted back to OLD for role/region_id/
--      role_level/tenant_id -- no error, a false-positive 200. This is why
--      the RPC below is designed to be invoked with the CALLER's own JWT
--      forwarded (never the service-role key) -- see update-user/index.ts.
--   2. A last-Admin invariant implemented as a SECOND `BEFORE UPDATE`
--      trigger would fire in an order determined only by trigger NAME
--      (Postgres fires same-timing/event triggers alphabetically) -- an
--      undocumented, easily-broken coupling with the existing
--      trigger_prevent_profile_privilege_escalation. The invariant below
--      is instead folded directly into THAT existing function, as the
--      last step before RETURN NEW, so it always evaluates the row's
--      truly final, already-restored state -- no trigger ordering to get
--      right or accidentally break later.
--
-- ============================================================
-- PART 1: prevent_profile_privilege_escalation() -- add the atomic
-- last-Business-Admin invariant to the EXISTING function (not a second
-- trigger). Escalation-restoration logic above is UNCHANGED verbatim.
-- ============================================================
--
-- BUSINESS ADMIN DEFINITION for this invariant (deliberately NOT the same
-- as "is_super_admin=true"): is_active AND deleted_at IS NULL AND
-- (role = 'admin' OR role_level = 1). A profile that is ONLY
-- is_super_admin=true (no role='admin', no role_level=1) does NOT count
-- -- Business Admin and Super Admin are separate concepts throughout this
-- schema (is_business_admin() vs is_super_admin(), never folded together
-- -- see 20260817000000's own comment on is_business_admin()), and
-- counting a cross-tenant Super Admin as covering a tenant's LOCAL admin
-- requirement would be a false sense of safety: if that Super Admin is
-- later removed, the tenant can be left with zero real local admins with
-- nothing having ever caught it.
--
-- COALESCE is required throughout: OLD.role/NEW.role is NULL for every
-- functional non-admin account, and `NULL = 'admin'` evaluates to NULL
-- (not false) in three-valued logic. Without COALESCE, `NULL OR
-- (role_level = 1)` can itself resolve to NULL, and a NULL condition in a
-- plpgsql IF is treated as NOT true -- silently SKIPPING the invariant
-- check entirely. This is the exact same NULL-propagation footgun
-- 20260817000007_functional_roles_null_boolean_fix.sql already had to
-- correct for is_business_admin() -- caught here empirically (a first
-- draft of this exact function, without COALESCE, was proven locally to
-- silently skip the check for a legacy role_level=1 target) before being
-- reintroduced a second time.
--
-- TENANT REASSIGNMENT IS ALSO COVERED, NOT JUST DEMOTION/DISABLE: a first
-- draft of this invariant only fired on `v_was_admin AND NOT
-- v_will_be_admin`, which misses a genuine Super Admin moving a tenant's
-- only admin to a DIFFERENT tenant (NEW.tenant_id changed) while leaving
-- role/role_level/is_active untouched -- v_will_be_admin would stay TRUE
-- (nothing about admin-class status itself changed), so the check would
-- never fire, even though OLD.tenant_id is left with zero local admins.
-- Caught during review before being applied anywhere. Fixed by also
-- firing whenever `NEW.tenant_id IS DISTINCT FROM OLD.tenant_id` while the
-- row was admin-class in OLD -- the lock/recount still target ONLY
-- OLD.tenant_id (the tenant potentially losing its admin); the destination
-- tenant gaining one is never a threat to this invariant and is not
-- locked. An ordinary (non-super) Business Admin can never trigger this
-- path with a genuinely different tenant_id in the first place -- both
-- this function's own restoration logic above and profiles' RLS `WITH
-- CHECK` (which requires an ordinary Business Admin's write to keep
-- NEW.tenant_id equal to their own tenant) block that before this
-- invariant is ever reached.
--
-- ATOMICITY: a per-tenant `pg_advisory_xact_lock` is taken BEFORE the
-- recount, so two concurrent transactions each removing a different
-- admin-class row in the SAME tenant serialize against each other --
-- whichever acquires the lock first commits its change; the second only
-- re-counts (and can only see the first's committed effect) after
-- acquiring the lock itself. Transactions touching DIFFERENT tenants
-- never contend. Empirically proven with two genuine concurrent psql
-- transactions against this exact function body (see this migration's
-- own verification notes at the bottom): exactly one succeeded, one was
-- rejected with the exception below, final count never reached 0, and
-- the lock was confirmed to release correctly on both COMMIT and
-- ROLLBACK.
--
-- COVERAGE: this fires on ANY UPDATE to `profiles` that transitions a row
-- from admin-class to not-admin-class -- a functional Admin's `role`
-- moving away from 'admin', a legacy Admin's `role_level` moving away
-- from 1, OR `is_active` flipping to false (a disable). It protects
-- EVERY current and future write path automatically (this RPC,
-- disable-user, the legacy role editor, any later feature), not just the
-- one this migration was written for.
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_profile_privilege_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_was_admin BOOLEAN;
  v_will_be_admin BOOLEAN;
  v_remaining INTEGER;
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

  v_was_admin := COALESCE(OLD.is_active, false) AND OLD.deleted_at IS NULL
    AND (COALESCE(OLD.role = 'admin', false) OR COALESCE(OLD.role_level = 1, false));
  v_will_be_admin := COALESCE(NEW.is_active, false) AND NEW.deleted_at IS NULL
    AND (COALESCE(NEW.role = 'admin', false) OR COALESCE(NEW.role_level = 1, false));

  -- Protects OLD.tenant_id whenever an active Business Admin is LEAVING it --
  -- either by no longer being admin-class (demoted/disabled) OR by being
  -- reassigned to a DIFFERENT tenant while remaining admin-class (a genuine
  -- Super Admin changing NEW.tenant_id -- the only caller who can get a
  -- changed tenant_id past this function's own restoration logic above and
  -- past profiles' RLS WITH CHECK, which requires an ordinary Business
  -- Admin's write to keep NEW.tenant_id equal to their own tenant). Without
  -- the second condition, a Super Admin moving a tenant's ONLY admin to
  -- another tenant would leave OLD.tenant_id with zero local admins while
  -- v_will_be_admin stayed true (role/active unchanged, only tenant_id
  -- moved) -- the check would never fire. Only OLD.tenant_id is ever
  -- locked/recounted here -- the DESTINATION tenant gaining an admin is
  -- never a threat to this invariant and must not be locked for it.
  IF v_was_admin AND (NOT v_will_be_admin OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(OLD.tenant_id::text, 0));

    SELECT count(*) INTO v_remaining FROM profiles
    WHERE tenant_id = OLD.tenant_id AND id <> OLD.id
      AND is_active AND deleted_at IS NULL
      AND (COALESCE(role = 'admin', false) OR COALESCE(role_level = 1, false));

    IF v_remaining = 0 THEN
      RAISE EXCEPTION 'Cannot remove the last remaining active Admin for this tenant';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Preserve this function's existing ACL EXACTLY -- restated explicitly
-- (idempotent, matching this schema's established self-sufficiency
-- pattern) rather than only trusted implicitly via CREATE OR REPLACE
-- FUNCTION's grant-preservation behavior, so a reader of THIS migration
-- doesn't have to trust that behavior either. Trigger-only: no direct
-- client EXECUTE for any role, including authenticated -- unchanged.
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM anon;
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM authenticated;

-- ============================================================
-- PART 2: update_functional_user_profile() -- the atomic edit RPC
-- ============================================================
--
-- SECURITY MODEL: this function is reachable directly by ANY authenticated
-- client that discovers it -- the update-user Edge Function is NOT its
-- authorization boundary, only a convenience wrapper that also does field-
-- level input rejection and friendly error messages before ever calling
-- this. Every check below is independently authoritative, resolving the
-- caller EXCLUSIVELY via auth.uid() -- never a parameter, exactly like
-- every other identity helper in this schema. MUST be invoked with the
-- caller's own JWT forwarded (auth.uid() is NULL under a service-role
-- connection -- see PART 1's header) -- update-user/index.ts constructs a
-- second, anon-key + caller-Authorization-header client specifically for
-- this call; the service-role client is used only for this RPC's own
-- CALLER's trusted validation reads inside the Edge Function, never for
-- this RPC invocation itself.
--
-- Editable fields: full_name, department, role, region_id ONLY.
-- tenant_id, role_level, is_super_admin, email, password are never
-- parameters of this function at all -- there is no way to pass them in,
-- so there is nothing to "ignore" or accidentally leak through.
-- ============================================================

CREATE OR REPLACE FUNCTION update_functional_user_profile(
  p_target_id UUID,
  p_full_name TEXT,
  p_department TEXT,
  p_role TEXT,
  p_region_id UUID
)
RETURNS profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_caller RECORD;
  v_target RECORD;
  v_caller_is_business_admin BOOLEAN;
  v_caller_is_super_admin BOOLEAN;
  v_final_region_id UUID;
  v_result profiles;
BEGIN
  -- 1. Caller must be authenticated with a real JWT (never NULL, which is
  -- what a service-role connection would resolve to -- see PART 1).
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 2/3. Caller profile must exist, be active, not soft-deleted.
  SELECT * INTO v_caller FROM profiles WHERE id = v_caller_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the caller';
  END IF;
  IF NOT COALESCE(v_caller.is_active, false) OR v_caller.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled';
  END IF;

  -- 4. Caller must be Business Admin (role='admin' OR role_level=1) or a
  -- genuine Super Admin. Derived directly from the row just loaded, not
  -- via is_business_admin()/is_super_admin() -- mirrors create-user's/
  -- disable-user's own established pattern of re-deriving this inline so
  -- this RPC's authorization boundary can never silently drift if those
  -- helper functions are redefined for some unrelated reason later.
  v_caller_is_business_admin := COALESCE(v_caller.role = 'admin', false) OR COALESCE(v_caller.role_level = 1, false);
  v_caller_is_super_admin := COALESCE(v_caller.is_super_admin, false);
  IF NOT v_caller_is_business_admin AND NOT v_caller_is_super_admin THEN
    RAISE EXCEPTION 'Only Admins may edit users';
  END IF;

  -- 5. Load target profile.
  SELECT * INTO v_target FROM profiles WHERE id = p_target_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- 6. Non-Super-Admin caller may only target their own tenant. Existence
  -- masked (same "User not found" message a cross-tenant business admin
  -- would see for a legitimately-missing id) rather than a distinct
  -- "wrong tenant" error, matching create-user's/disable-user's own
  -- convention of not confirming cross-tenant row existence.
  IF NOT v_caller_is_super_admin AND v_target.tenant_id IS DISTINCT FROM v_caller.tenant_id THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- 7. Target must still be a functional account. Legacy accounts
  -- (role_level IS NOT NULL) are edited through the separate legacy
  -- role-level editor, which this RPC deliberately does not touch.
  IF v_target.role_level IS NOT NULL THEN
    RAISE EXCEPTION 'This account uses the legacy access-level editor';
  END IF;

  -- 8. Self-edit is explicitly rejected here, with a clear error --
  -- deliberately NOT left to rely solely on the trigger's own silent
  -- self-row restoration (NEW.id = auth.uid()), which would otherwise
  -- return an apparently-successful, actually-unchanged row and confuse
  -- the caller about what happened.
  IF p_target_id = v_caller_id THEN
    RAISE EXCEPTION 'You cannot change your own role or region through this action';
  END IF;

  -- Basic field validation.
  IF p_full_name IS NULL OR btrim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Full name is required';
  END IF;

  -- 9. Role must be exactly one of the 4 functional roles.
  IF p_role NOT IN ('admin', 'hr_manager', 'accountant', 'operations_manager') THEN
    RAISE EXCEPTION 'Role must be one of: admin, hr_manager, accountant, operations_manager';
  END IF;

  -- 10/11. Region required + tenant-validated for non-admin roles; forced
  -- NULL for admin regardless of what the caller sent (mirrors
  -- create-user's own `region_id: role === 'admin' ? null : regionId`
  -- coercion, not a rejection, for the admin case).
  IF p_role = 'admin' THEN
    v_final_region_id := NULL;
  ELSE
    IF p_region_id IS NULL THEN
      RAISE EXCEPTION 'Region is required for this role';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM regions WHERE id = p_region_id AND tenant_id = v_target.tenant_id) THEN
      RAISE EXCEPTION 'Region does not belong to this user''s tenant';
    END IF;
    v_final_region_id := p_region_id;
  END IF;

  -- 12/14. The constrained write. tenant_id/role_level/is_super_admin/
  -- email/password are never in the SET list -- there is nothing to
  -- accidentally modify. The WHERE clause re-checks id, tenant_id, AND
  -- role_level IS NULL AT WRITE TIME (not just during the earlier reads
  -- above) -- if the target's tenant or account-model changed in the
  -- window between the reads above and this UPDATE, the row simply won't
  -- match and zero rows return, closing that TOCTOU window rather than
  -- writing against a target whose identity shifted underneath this call.
  UPDATE profiles
  SET full_name = p_full_name,
      department = p_department,
      role = p_role,
      region_id = v_final_region_id
  WHERE id = p_target_id
    AND tenant_id = v_target.tenant_id
    AND role_level IS NULL
  RETURNING * INTO v_result;

  -- 15. Zero-row update must fail, never return success.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Update did not apply -- this account may have changed since validation';
  END IF;

  -- 16. Verify the returned row before declaring success -- defense in
  -- depth against any unexpected trigger interference silently producing
  -- a row that doesn't match what was actually requested/permitted.
  IF v_result.role_level IS NOT NULL
     OR v_result.tenant_id IS DISTINCT FROM v_target.tenant_id
     OR v_result.is_super_admin IS DISTINCT FROM v_target.is_super_admin
     OR v_result.role IS DISTINCT FROM p_role
     OR v_result.region_id IS DISTINCT FROM v_final_region_id
     OR v_result.full_name IS DISTINCT FROM p_full_name
     OR v_result.department IS DISTINCT FROM p_department
  THEN
    RAISE EXCEPTION 'Update produced an unexpected profile state -- aborting';
  END IF;

  -- 13/17. Authoritative audit entry, in the SAME transaction as the
  -- profile mutation above -- if this INSERT fails for any reason, the
  -- whole function raises, and the profile UPDATE above rolls back with
  -- it (a plpgsql function body is one implicit transaction; there is no
  -- explicit COMMIT between the two writes for a failure to slip
  -- between). The actor is v_caller_id, resolved via auth.uid() above --
  -- never a client-supplied value; there is no actor/user-id parameter on
  -- this function for a caller to supply one at all.
  INSERT INTO audit_logs (tenant_id, user_id, user_email, user_role, region_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_target.tenant_id,
    v_caller_id,
    v_caller.email,
    CASE WHEN v_caller_is_super_admin THEN 'super_admin' ELSE 'admin' END,
    NULL,
    'UPDATE',
    'profiles',
    p_target_id::text,
    jsonb_build_object('full_name', v_target.full_name, 'department', v_target.department, 'role', v_target.role, 'region_id', v_target.region_id),
    jsonb_build_object('full_name', v_result.full_name, 'department', v_result.department, 'role', v_result.role, 'region_id', v_result.region_id)
  );

  RETURN v_result;
END;
$$;

-- ============================================================
-- ACL HARDENING -- do not assume REVOKE FROM PUBLIC alone is sufficient
-- (per the live-STAGING default-grant behavior already established
-- earlier in this rollout -- Supabase grants EXECUTE directly to
-- anon/authenticated at function creation, independent of PUBLIC).
-- authenticated is granted because this RPC MUST be callable via a
-- caller-JWT-scoped client (which authenticates to PostgREST as
-- `authenticated`, regardless of which API key constructed the client) --
-- this is the approved invocation design, not an oversight. service_role
-- is never granted or referenced here and must never be used to invoke
-- this function as a substitute for the real caller's JWT -- doing so
-- would reproduce PART 1's own documented service-role/auth.uid() defect
-- for this RPC's own internal checks.
-- ============================================================

REVOKE ALL ON FUNCTION update_functional_user_profile(UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_functional_user_profile(UUID, TEXT, TEXT, TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION update_functional_user_profile(UUID, TEXT, TEXT, TEXT, UUID) TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- CREATE OR REPLACE FUNCTION,
-- REVOKE/GRANT (idempotent by nature).
--
-- DEPENDENCIES: requires 20260817000000 (is_super_admin, is_business_admin,
-- get_current_tenant_id and the role_permissions/profiles shape), and
-- 20260817000001 (the prevent_profile_privilege_escalation() body this
-- migration extends). `regions`, `audit_logs` must already exist (both do,
-- since 20260727000000).
--
-- POSTGRES VERSION: hashtextextended() requires PostgreSQL 11+; this
-- project's baseline is 15/16.
--
-- BEHAVIOR CHANGES FOR EXISTING CALLERS:
--   1. Any UPDATE to `profiles` that would leave a tenant with zero active
--      Business Admins (role='admin' OR role_level=1, active, not
--      deleted) is now rejected, regardless of which code path performs
--      it -- this includes disable-user's existing disable flow and the
--      legacy role-level editor, not just the new RPC below.
--   2. A NEW capability exists for authenticated Business Admin/Super
--      Admin callers: update_functional_user_profile(), editing another
--      functional-role user's full_name/department/role/region_id.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT has_function_privilege('anon', 'update_functional_user_profile(uuid,text,text,text,uuid)', 'EXECUTE');
--   -- expected: false
--   SELECT has_function_privilege('authenticated', 'update_functional_user_profile(uuid,text,text,text,uuid)', 'EXECUTE');
--   -- expected: true
--   SELECT has_function_privilege('anon', 'prevent_profile_privilege_escalation()', 'EXECUTE');
--   SELECT has_function_privilege('authenticated', 'prevent_profile_privilege_escalation()', 'EXECUTE');
--   -- expected: false, false (trigger-only, unchanged)
--   SELECT p.proname, p.prosecdef, p.proconfig, r.rolname AS owner
--     FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
--     WHERE p.proname IN ('update_functional_user_profile', 'prevent_profile_privilege_escalation');
--   -- expected: both prosecdef = true (SECURITY DEFINER), proconfig
--   -- contains search_path=public,pg_temp, owner is the migration-applying
--   -- role (never a client-controllable identity).
--   -- Functional check, as an active Business Admin session (real JWT,
--   -- not service-role): SELECT * FROM update_functional_user_profile(
--   --   '<some-other-functional-user-id>', 'New Name', 'Ops', 'hr_manager',
--   --   '<a-region-in-the-same-tenant>');
--   -- expect one row back, audit_logs gains exactly one new row for the
--   -- same call.
--
-- CONCURRENCY VERIFICATION (empirically reproduced against this exact
-- function body during design review, repeated locally against this
-- committed file before merge -- not merely reasoned about): two
-- genuinely concurrent transactions, each demoting a DIFFERENT one of a
-- tenant's exactly-two active Business Admins at nearly the same time --
-- exactly one commits, the other blocks on the advisory lock for the
-- real remaining duration of the first transaction, then is rejected with
-- "Cannot remove the last remaining active Admin for this tenant" and
-- rolls back; final active-admin count for the tenant is 1, never 0; the
-- advisory lock is confirmed released immediately after either a COMMIT
-- or a ROLLBACK (pg_try_advisory_xact_lock on the same key succeeds
-- immediately afterward in both cases).
--
-- ROLLBACK SQL (restores the pre-this-migration state -- NOT recommended,
-- reintroduces the unguarded last-admin race and removes the new RPC):
--   DROP FUNCTION IF EXISTS update_functional_user_profile(UUID, TEXT, TEXT, TEXT, UUID);
--   -- Then re-run 20260817000001's prevent_profile_privilege_escalation()
--   -- body verbatim (the version without the last-admin invariant block).
-- ============================================================
