-- ============================================================
-- MIGRATION (HOTFIX): Formal Super Administrator model +
-- Terminal Dues separation-of-duties correction
-- Date: 2026-09-15
-- Revised: 2026-09-15 (release-review blocker fix, same day, before this
-- migration was ever applied to any real database -- see PART 1b)
-- ============================================================
--
-- This is a targeted production hotfix. It does NOT touch payroll/
-- attendance batching, guard-ID cleanup, or any other item explicitly
-- deferred to the later performance/scaling PR. It contains four
-- independent, narrowly-scoped changes:
--
--   PART 1 -- set_super_admin_status() RPC: the smallest secure mechanism
--            letting ONLY a genuine Super Administrator promote/demote
--            another profile's is_super_admin flag, with a last-active-
--            Super-Administrator lockout guard and audit logging.
--
--   PART 1b -- RELEASE-REVIEW BLOCKER FIX: a release review of PART 1
--            found that disable-user (a pre-existing Edge Function this
--            hotfix never originally touched) could disable an
--            is_super_admin=true profile with zero awareness of the
--            global "at least one active Super Admin" invariant PART 1
--            established for the is_super_admin flag itself -- and that
--            an ordinary Admin could disable a Super Administrator's
--            account at all, since profiles' own UPDATE RLS lets any
--            business-admin-class caller update a same-tenant row's
--            is_active regardless of that row's is_super_admin flag,
--            independent of whatever disable-user's own JS logic checked.
--            Adds a shared assert_not_last_active_super_admin() helper
--            (also used to refactor, not weaken, PART 1's own guard),
--            extends the EXISTING prevent_profile_privilege_escalation()
--            trigger (unconditional, RLS-independent) to block this
--            transition, and adds a new disable_user_profile() RPC that
--            becomes disable-user/index.ts's actual mutating call,
--            invoked with the caller's own JWT (never the service-role
--            client) so auth.uid() resolves correctly for a genuine
--            Super Admin caller. See PART 1b's own header for full detail.
--
--   PART 2 -- system_settings key-aware RLS: current_payroll_month becomes
--            Super-Admin-only to change, at the database layer, without
--            touching any other settings key's existing Admin access.
--
--   PART 3 -- terminal_dues role_permissions correction: Administrator
--            gains terminal_dues.create, loses terminal_dues.approve, so
--            approval becomes exclusively a Super Administrator action
--            (has_explicit_permission('terminal_dues.approve') no longer
--            matches any 'admin' row; is_super_admin() bypass in
--            approve_terminal_due()/return_terminal_due_for_correction()
--            is untouched).
--
-- ============================================================
-- PART 1: set_super_admin_status() RPC
-- ============================================================
--
-- WHY A NEW RPC INSTEAD OF EXTENDING update_functional_user_profile():
-- is_super_admin is a strictly more powerful, orthogonal axis from
-- role/role_level (see 20260817000001's own header) -- folding it into the
-- existing role/department/region editor would make super-admin promotion
-- a side effect of an otherwise-ordinary edit, exactly the design mistake
-- UserManagement.tsx's own comments already warn against (a prior version
-- of that component's legacy-role editor once silently sent
-- `is_super_admin: roleLevel === 1` as a side effect and was deliberately
-- corrected). Promotion/demotion is therefore its own explicit, narrowly-
-- scoped action with its own authorization boundary.
--
-- WHY THIS DOES NOT NEED A COMPANION EDGE FUNCTION: unlike a service-role
-- client (whose JWT has no `sub` claim, leaving auth.uid() NULL --
-- update-user/index.ts's own header documents this exact failure mode),
-- a direct `supabase.rpc(...)` call from the frontend is issued using the
-- CALLER's own JWT, forwarded natively by PostgREST. auth.uid() reads
-- session-level JWT-claim GUCs, not the function's SECURITY DEFINER
-- context (which only elevates table/row privilege, not GUC resolution)
-- -- so is_super_admin()/auth.uid() inside this function correctly resolve
-- to the REAL caller even though the function itself runs SECURITY
-- DEFINER. This RPC is therefore its own complete authorization boundary,
-- safely callable directly via supabase.rpc('set_super_admin_status', ...)
-- from src/components/UserManagement.tsx.
--
-- WHY is_super_admin IS TREATED AS GLOBAL, NOT PER-TENANT: is_super_admin
-- is documented throughout this schema as the true CROSS-TENANT platform
-- bypass (profiles UPDATE RLS's own is_super_admin() branch has no
-- tenant_id condition at all). The "do not end up with zero active Super
-- Administrators" invariant below is therefore counted across the WHOLE
-- profiles table, not scoped to the caller's or target's tenant_id --
-- a per-tenant count would let the platform's last two Super Admins
-- demote each other from different tenants and still each believe another
-- one existed.
--
-- ATOMICITY: a single, fixed advisory-lock key (not per-tenant, since the
-- invariant itself is global) is taken before the remaining-count check on
-- any DEMOTION, so two concurrent demotions of two different Super Admin
-- rows cannot both observe ">=2 remaining" and both proceed, leaving zero.
-- Mirrors the pg_advisory_xact_lock pattern already established by
-- prevent_profile_privilege_escalation()'s own last-Business-Admin
-- invariant (20260822000000), generalized here to a single global key
-- since this invariant is not tenant-scoped.
--
-- PROMOTION ELIGIBILITY: business rule requires the target already be an
-- "existing Administrator" (role='admin' OR legacy role_level=1 -- the
-- same is_business_admin() definition used throughout this schema) before
-- it can be promoted to Super Administrator. This keeps the documented
-- internal model intact: "Super Administrator = role='admin' AND
-- is_super_admin=true", never a non-admin functional role with
-- is_super_admin=true.
--
-- SELF-EDIT IS REJECTED, exactly like update_functional_user_profile()'s
-- own self-edit rejection -- a Super Admin demoting themselves through
-- this action, possibly as the last active one, is a foot-gun this RPC
-- refuses outright rather than relying solely on the last-Super-Admin
-- count check to catch it after the fact.
--
-- ============================================================
-- SHARED HELPER: assert_not_last_active_super_admin()
-- ============================================================
-- Added by PART 1b (release-review blocker fix) so the SAME global-
-- invariant check (advisory lock + count) is used by every code path that
-- can take a Super Administrator out of the "active" set -- originally
-- only set_super_admin_status() had this logic inline; it is now shared
-- with prevent_profile_privilege_escalation()'s new guard and
-- disable_user_profile() (both added below in PART 1b), so the three
-- can never independently drift. Internal-only -- REVOKE ALL below,
-- callable only from within another SECURITY DEFINER function/trigger
-- (which runs as this function's OWNER, not the original caller, so no
-- direct grant to authenticated/anon is needed or given).
--
-- p_excluding_id is the profile being acted on -- excluded from its own
-- "how many would remain" count, exactly as set_super_admin_status's own
-- inline version already did.
CREATE OR REPLACE FUNCTION assert_not_last_active_super_admin(p_excluding_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining_supers INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global_super_admin_invariant', 0));

  SELECT count(*) INTO v_remaining_supers
  FROM profiles
  WHERE is_super_admin = true
    AND is_active = true
    AND deleted_at IS NULL
    AND id <> p_excluding_id;

  IF v_remaining_supers = 0 THEN
    RAISE EXCEPTION 'Cannot remove the last active Super Administrator';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION assert_not_last_active_super_admin(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_not_last_active_super_admin(UUID) FROM anon;
REVOKE ALL ON FUNCTION assert_not_last_active_super_admin(UUID) FROM authenticated;

CREATE OR REPLACE FUNCTION set_super_admin_status(
  p_target_id UUID,
  p_is_super_admin BOOLEAN
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
  v_result profiles;
BEGIN
  IF p_is_super_admin IS NULL THEN
    RAISE EXCEPTION 'is_super_admin value is required';
  END IF;

  -- 1. Caller must be authenticated with a real JWT.
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 2. Caller profile must exist, be active, not soft-deleted.
  SELECT * INTO v_caller FROM profiles WHERE id = v_caller_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the caller';
  END IF;
  IF NOT COALESCE(v_caller.is_active, false) OR v_caller.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled';
  END IF;

  -- 3. THE authorization boundary: only a genuine Super Administrator may
  -- call this function at all. Re-derived directly from the row just
  -- loaded (not via the is_super_admin() helper) for the same reason
  -- update_functional_user_profile() re-derives its own admin check
  -- inline -- so this boundary can never silently drift if that helper is
  -- redefined later for an unrelated reason.
  IF NOT COALESCE(v_caller.is_super_admin, false) THEN
    RAISE EXCEPTION 'Only a Super Administrator may change super-admin status';
  END IF;

  -- 4. Self-edit rejected outright (see header).
  IF p_target_id = v_caller_id THEN
    RAISE EXCEPTION 'You cannot change your own super-admin status through this action';
  END IF;

  -- 5. Load and lock the target row for the duration of this transaction,
  -- preventing a concurrent second call from racing this same row.
  SELECT * INTO v_target FROM profiles WHERE id = p_target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- 6. Promotion eligibility: target must already be an Administrator.
  IF p_is_super_admin AND NOT (COALESCE(v_target.role = 'admin', false) OR COALESCE(v_target.role_level = 1, false)) THEN
    RAISE EXCEPTION 'Only an existing Administrator can be promoted to Super Administrator';
  END IF;

  -- 7. Last-active-Super-Administrator lockout guard, only relevant on a
  -- genuine demotion (true -> false). Delegates to the shared
  -- assert_not_last_active_super_admin() helper (PART 1b) -- same
  -- advisory lock, same count predicate, same exception text as before
  -- this refactor; behavior is unchanged, only de-duplicated so
  -- disable_user_profile() and the trigger's own new guard (both added by
  -- PART 1b) use the identical check instead of a second hand-copied one.
  IF COALESCE(v_target.is_super_admin, false) AND NOT p_is_super_admin THEN
    PERFORM assert_not_last_active_super_admin(p_target_id);
  END IF;

  -- 8. The constrained write -- only is_super_admin is in the SET list.
  -- prevent_profile_privilege_escalation() still fires on this UPDATE and
  -- independently re-verifies is_super_admin() for the ACTUAL caller
  -- (auth.uid(), unaffected by this function's own SECURITY DEFINER
  -- context) before letting NEW.is_super_admin survive -- this RPC's own
  -- check above and that trigger are two independent layers, not one
  -- masquerading as two.
  UPDATE profiles
  SET is_super_admin = p_is_super_admin
  WHERE id = p_target_id
  RETURNING * INTO v_result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Update did not apply -- this account may have changed since validation';
  END IF;

  -- 9. Verify the returned row actually reflects the requested change --
  -- defense in depth against the trigger silently reverting it (which
  -- would only happen if v_caller somehow were not really super-admin at
  -- the trigger's own re-check, e.g. a stale/forged session -- this turns
  -- that into a loud failure instead of a false-positive success).
  IF v_result.is_super_admin IS DISTINCT FROM p_is_super_admin THEN
    RAISE EXCEPTION 'Update did not take effect -- aborting';
  END IF;

  -- 10. Audit log, same transaction as the mutation above.
  INSERT INTO audit_logs (tenant_id, user_id, user_email, user_role, region_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_target.tenant_id,
    v_caller_id,
    v_caller.email,
    'super_admin',
    NULL,
    'UPDATE',
    'profiles',
    p_target_id::text,
    jsonb_build_object('is_super_admin', v_target.is_super_admin),
    jsonb_build_object('is_super_admin', v_result.is_super_admin)
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION set_super_admin_status(UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_super_admin_status(UUID, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION set_super_admin_status(UUID, BOOLEAN) TO authenticated;

-- ============================================================
-- PART 1b: RELEASE-REVIEW BLOCKER FIX -- disable-user could disable an
-- is_super_admin=true profile without enforcing the global
-- at-least-one-active-Super-Administrator invariant, and an ordinary
-- Admin could disable a Super Administrator's account at all.
-- ============================================================
--
-- ROOT CAUSE (two independent gaps, both closed below):
--
--   1. profiles' own UPDATE RLS policy (20260817000001) lets ANY
--      business-admin-class caller update a SAME-TENANT row's is_active,
--      regardless of that row's is_super_admin flag -- there was no
--      column-aware/flag-aware carve-out for is_active the way PART 2
--      below adds one for system_settings.key. disable-user/index.ts's
--      own JS-side checks (business-admin count, cross-tenant
--      restriction, self-disable) are therefore NOT the real security
--      boundary -- they are bypassable by any raw
--      `supabase.from('profiles').update({is_active:false})` REST call
--      that skips the Edge Function entirely. Confirmed by direct
--      repo-wide audit (see this hotfix's own report) that no other
--      write path currently sets profiles.deleted_at at all, and that
--      disable-user is the ONLY Edge Function writing profiles.is_active
--      to false.
--
--   2. disable-user/index.ts's actual mutating UPDATE was issued via the
--      SERVICE-ROLE client (not a caller-JWT-scoped one) -- exactly the
--      same auth.uid()-is-NULL failure mode update-user/index.ts's own
--      header already documents and works around. Any NEW is_super_admin-
--      aware guard added to the profiles UPDATE trigger would therefore
--      be unable to see the REAL caller's identity through that
--      connection, and would incorrectly reject even a genuine Super
--      Admin's legitimate attempt to disable another Super Admin.
--
-- FIX (two parts, both required together -- see requirement #6 in the
-- release review):
--
--   A. assert_not_last_active_super_admin() (above) is now ALSO called
--      from a new guard inside the EXISTING
--      prevent_profile_privilege_escalation() trigger (20260822000000) --
--      unconditional, fires on ANY UPDATE to profiles regardless of which
--      role/client issues it (service-role, caller-JWT-scoped, or a raw
--      REST call), closing gap 1 for every current and future write path,
--      not just disable-user. Scoped tightly to the exact transition that
--      matters: a row that WAS an active Super Admin losing that active
--      status (is_active -> false, or deleted_at being set) --
--      promotions, re-enables, and every other write are unaffected, and
--      the existing tenant-scoped last-Business-Admin invariant later in
--      the same trigger is untouched.
--
--   B. A new disable_user_profile() RPC becomes disable-user/index.ts's
--      actual mutating call (companion Edge Function change, not part of
--      this SQL file), invoked via a SEPARATE client scoped to the
--      CALLER's own JWT -- same pattern update-user/index.ts already
--      established for update_functional_user_profile() -- so auth.uid()
--      correctly resolves the real caller for both this RPC's own checks
--      and the trigger's guard from (A), closing gap 2. The Edge
--      Function's existing JS-side pre-checks (tenant/business-admin
--      lookups, friendly early error messages) are preserved unchanged
--      for UX; they were already non-authoritative (see their own
--      existing comments) and remain so -- this RPC plus the trigger are
--      the real boundary.
--
-- WHY NOT RE-IMPLEMENT THE TENANT-SCOPED LAST-BUSINESS-ADMIN CHECK HERE:
-- prevent_profile_privilege_escalation()'s existing v_was_admin/
-- v_will_be_admin logic ALREADY unconditionally protects that invariant
-- for every write path, including this new RPC's own UPDATE statement --
-- duplicating it here would be redundant surface, not extra safety (see
-- requirement to "keep the surface minimal").
--
-- WHY THE AUDIT LOG MOVES INTO THIS RPC (not a behavior loss): disable-
-- user/index.ts previously inserted its own audit_logs row as a SEPARATE
-- step, via the service-role client, AFTER the update already succeeded
-- -- if that insert failed, the disable had already happened with no
-- audit trail. Folding it into this SECURITY DEFINER RPC, in the SAME
-- transaction as the UPDATE (exactly like set_super_admin_status's own
-- audit insert), means a failed audit insert now rolls back the whole
-- disable instead of silently losing the trail -- a strengthening, not a
-- change in what gets logged (same fields, same content).
--
-- AUTH ADMIN API / profiles-Auth CONSISTENCY: this function -- like
-- disable-user/index.ts before it -- does NOT call the Supabase Auth
-- Admin API (no ban, no delete) at all. is_active=false is deliberately
-- the ONLY effect, exactly matching disable-user's own pre-existing,
-- documented "soft disable only" design (see that file's own
-- "HARD-DELETE LIMITATION" footer). Since no Auth-side mutation is
-- introduced by this fix, there is no multi-step Auth+DB sequence that
-- needs compensation/rollback here -- profiles and Supabase Auth account
-- state cannot diverge from a step this function never takes.
--
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
  v_was_active_super BOOLEAN;
  v_will_be_active_super BOOLEAN;
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

  -- NEW (PART 1b): last-active-Super-Administrator protection, extended
  -- here to cover DEACTIVATING (is_active -> false) or SOFT-DELETING
  -- (deleted_at being set) a row that IS a Super Administrator -- the
  -- release-review finding this closes. Fires ONLY when a row that WAS an
  -- active Super Admin is losing that active status; promotions,
  -- re-enables, and every unrelated write pass through untouched. This is
  -- the unconditional, RLS-independent boundary -- it runs regardless of
  -- which role/client issues the UPDATE.
  v_was_active_super := COALESCE(OLD.is_active, false) AND OLD.deleted_at IS NULL AND COALESCE(OLD.is_super_admin, false);
  v_will_be_active_super := COALESCE(NEW.is_active, false) AND NEW.deleted_at IS NULL AND COALESCE(NEW.is_super_admin, false);

  IF v_was_active_super AND NOT v_will_be_active_super THEN
    IF NOT is_super_admin() THEN
      RAISE EXCEPTION 'Only a Super Administrator may disable another Super Administrator';
    END IF;
    IF OLD.id = auth.uid() THEN
      RAISE EXCEPTION 'You cannot disable your own Super Administrator account';
    END IF;
    PERFORM assert_not_last_active_super_admin(OLD.id);
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

-- ACL restated explicitly, matching this function's existing established
-- pattern (20260822000000) -- trigger-only, no direct client EXECUTE for
-- any role, including authenticated. Unchanged by this revision.
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM anon;
REVOKE ALL ON FUNCTION prevent_profile_privilege_escalation() FROM authenticated;

-- ============================================================
-- disable_user_profile() -- becomes disable-user/index.ts's actual
-- mutating call (see this PART's header, gap 2). Reproduces that Edge
-- Function's existing business rules (caller must be admin-class, target
-- must exist, cross-tenant blocked unless caller is super admin,
-- already-disabled is an idempotent no-op, self-disable rejected) plus
-- the two NEW checks this blocker fix requires. MUST be invoked with the
-- caller's own JWT forwarded (auth.uid() is NULL under a service-role
-- connection) -- disable-user/index.ts constructs a second, anon-key +
-- caller-Authorization-header client specifically for this call, exactly
-- like update-user/index.ts already does for update_functional_user_profile().
-- ============================================================
CREATE OR REPLACE FUNCTION disable_user_profile(p_target_id UUID)
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
  v_result profiles;
BEGIN
  -- 1. Caller must be authenticated with a real JWT.
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 2. Caller profile must exist, be active, not soft-deleted.
  SELECT * INTO v_caller FROM profiles WHERE id = v_caller_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the caller';
  END IF;
  IF NOT COALESCE(v_caller.is_active, false) OR v_caller.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled';
  END IF;

  v_caller_is_business_admin := COALESCE(v_caller.role = 'admin', false) OR COALESCE(v_caller.role_level = 1, false);
  v_caller_is_super_admin := COALESCE(v_caller.is_super_admin, false);
  IF NOT v_caller_is_business_admin AND NOT v_caller_is_super_admin THEN
    RAISE EXCEPTION 'Only Admins may disable users';
  END IF;

  -- 3. Self-disable rejected outright, for every caller (mirrors
  -- disable-user/index.ts's own existing pre-check, restated here as the
  -- authoritative version).
  IF p_target_id = v_caller_id THEN
    RAISE EXCEPTION 'You cannot disable your own account';
  END IF;

  -- 4. Load and lock the target row for the duration of this transaction.
  SELECT * INTO v_target FROM profiles WHERE id = p_target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- 5. Cross-tenant restriction, mirrors update_functional_user_profile()
  -- and disable-user/index.ts's own existing check: existence masked as
  -- "User not found" rather than a distinct "wrong tenant" error.
  IF NOT v_caller_is_super_admin AND v_target.tenant_id IS DISTINCT FROM v_caller.tenant_id THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- 6. Idempotent no-op for an already-disabled target -- mirrors
  -- disable-user/index.ts's own existing behavior.
  IF NOT v_target.is_active THEN
    RETURN v_target;
  END IF;

  -- 7. NEW: only a genuine Super Administrator may disable another Super
  -- Administrator. An ordinary (business-admin-only) caller is rejected
  -- outright, regardless of the tenant-scoped last-Business-Admin count
  -- below -- this is the exact gap the release review found.
  IF COALESCE(v_target.is_super_admin, false) AND NOT v_caller_is_super_admin THEN
    RAISE EXCEPTION 'Only a Super Administrator may disable a Super Administrator';
  END IF;

  -- 8. NEW: global last-active-Super-Administrator invariant, same shared
  -- helper set_super_admin_status() and the trigger's own guard use.
  -- Redundant with the trigger's own call to the same helper during the
  -- UPDATE below (step 9) -- deliberate defense-in-depth, matching this
  -- schema's established "two independent layers" pattern (see
  -- set_super_admin_status()'s own header) -- the advisory lock is safely
  -- re-entrant within one transaction/session, so calling it twice here
  -- is harmless, not a deadlock risk.
  IF COALESCE(v_target.is_super_admin, false) THEN
    PERFORM assert_not_last_active_super_admin(p_target_id);
  END IF;

  -- 9. The write. prevent_profile_privilege_escalation() still fires on
  -- this UPDATE and independently re-verifies everything in steps 7-8
  -- (via its own new guard) for the ACTUAL caller (auth.uid(), unaffected
  -- by this function's own SECURITY DEFINER context) -- this RPC's own
  -- checks and that trigger are two independent layers, not one
  -- masquerading as two. The EXISTING tenant-scoped last-Business-Admin
  -- invariant (unchanged, in that same trigger) also applies here for
  -- free, with no need to duplicate it in this function.
  UPDATE profiles SET is_active = false WHERE id = p_target_id RETURNING * INTO v_result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Update did not apply -- this account may have changed since validation';
  END IF;

  -- 10. Authoritative audit entry, same transaction as the mutation above
  -- -- see this PART's header on why this moved out of the Edge Function.
  -- Identical field shape to disable-user/index.ts's own prior insert.
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
    jsonb_build_object('is_active', true),
    jsonb_build_object('is_active', false)
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION disable_user_profile(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION disable_user_profile(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION disable_user_profile(UUID) TO authenticated;

-- ============================================================
-- PART 2: system_settings key-aware RLS -- current_payroll_month becomes
-- Super-Admin-only to write, every other key's existing Admin access is
-- untouched.
-- ============================================================
--
-- WHY A KEY-AWARE POLICY PREDICATE, NOT A BLANKET CHANGE: this table also
-- holds default_page_size (src/utils/uiSettings.ts), the 9 payroll-rate
-- keys (src/utils/payrollSettings.ts), and 9 company-info keys
-- (src/utils/companySettings.ts) -- all deliberately left at ordinary
-- has_permission('settings.manage') access (which the is_business_admin()
-- shortcut inside has_permission() already grants to every Admin). Making
-- the whole table Super-Admin-only would silently break ordinary Admins'
-- ability to edit company info/payroll rates/page size, none of which
-- this hotfix's business rule touches. A per-key carve-out inside the
-- existing predicate is therefore the narrowest change that satisfies
-- "current payroll month can only be changed by is_super_admin()" while
-- leaving every other key's behavior byte-for-byte identical to
-- 20260817000004's own policies.
--
-- WHY THIS CLOSES THE DIRECT-REST BYPASS: setSystemCurrentMonth()
-- (src/utils/currentMonth.ts) issues a plain `supabase.from('system_settings')
-- .update(...)`/`.insert(...)` -- there is no RPC in front of it, so RLS
-- is the entire security boundary for this key. The previous frontend-only
-- `canChangeMonth` gate in MonthSettings.tsx was therefore fully
-- bypassable by any authenticated Admin issuing the REST call directly.
--
DROP POLICY IF EXISTS "Admins can insert settings in their tenant" ON system_settings;
CREATE POLICY "Admins can insert settings in their tenant" ON system_settings
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (
    is_super_admin() = true
    OR (key <> 'current_payroll_month' AND has_permission('settings.manage'))
  )
);

DROP POLICY IF EXISTS "Admins can update settings in their tenant" ON system_settings;
CREATE POLICY "Admins can update settings in their tenant" ON system_settings
FOR UPDATE USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (
    is_super_admin() = true
    OR (key <> 'current_payroll_month' AND has_permission('settings.manage'))
  )
) WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (
    is_super_admin() = true
    OR (key <> 'current_payroll_month' AND has_permission('settings.manage'))
  )
);

-- SELECT policy ("Users can view settings in their tenant") and the
-- DELETE policy ("Super admins can delete settings") are UNCHANGED --
-- read access to system_settings stays exactly as 20260817000004 left it,
-- and DELETE was already Super-Admin-only before this migration.

-- ============================================================
-- PART 3: terminal_dues role_permissions correction (separation of
-- duties). Pure data change -- no RPC, trigger, or RLS predicate is
-- touched (approve_terminal_due()/pay_terminal_due()/
-- return_terminal_due_for_correction() already gate on
-- has_explicit_permission(), which has no is_business_admin() shortcut,
-- and the "Terminal dues: create ... explicit permission only" INSERT
-- policy already gates on has_explicit_permission('terminal_dues.create')
-- -- see 20260905000000. Removing/adding rows in role_permissions is
-- therefore sufficient by itself to move Administrator from
-- create+approve to create-only, with approval becoming exclusively a
-- Super Administrator action via is_super_admin()'s existing bypass in
-- every one of those RPCs.
-- ============================================================
--
-- Current matrix before this migration (re-confirmed against
-- 20260817000000 and 20260905000000 immediately before writing this
-- file):
--   hr_manager:        terminal_dues.view, .create, .edit
--   admin:              terminal_dues.view, .approve
--   accountant:         terminal_dues.view, .pay
--   operations_manager: (none)
--
-- Target matrix (this hotfix's business rule):
--   hr_manager:        terminal_dues.view, .create, .edit    (unchanged)
--   admin:              terminal_dues.view, .create           (was .approve)
--   accountant:         terminal_dues.view, .pay              (unchanged)
--   operations_manager: (none, unchanged)
--   Super Administrator: unaffected -- is_super_admin() bypass in every
--     terminal_dues RPC/policy already grants create+approve+full
--     oversight regardless of role_permissions rows.
--
INSERT INTO role_permissions (role, permission) VALUES
  ('admin', 'terminal_dues.create')
ON CONFLICT (role, permission) DO NOTHING;

DELETE FROM role_permissions
WHERE role = 'admin' AND permission = 'terminal_dues.approve';

-- ============================================================
-- VERIFICATION -- run after applying, against a disposable/local instance
-- only (see this hotfix's own report for confirmation this was NOT run
-- against Staging/Production).
-- ============================================================
--
-- PART 1 (as two distinct authenticated sessions -- a genuine Super Admin
-- and an ordinary Admin, both via SET ROLE authenticated + a stub
-- auth.uid()):
--   -- ordinary Admin attempts: expect exception 'Only a Super
--   -- Administrator may change super-admin status'
--   SELECT set_super_admin_status('<other-admin-id>', true);
--
--   -- genuine Super Admin promotes an existing Administrator: expect a
--   -- returned row with is_super_admin = true
--   SELECT set_super_admin_status('<administrator-id>', true);
--
--   -- genuine Super Admin attempts to demote the only remaining active
--   -- Super Admin: expect exception 'Cannot remove the last active
--   -- Super Administrator'
--   SELECT set_super_admin_status('<last-super-admin-id>', false);
--
--   -- genuine Super Admin attempts to change their own status: expect
--   -- exception 'You cannot change your own super-admin status through
--   -- this action'
--   SELECT set_super_admin_status('<self-id>', false);
--
-- PART 1b (release-review blocker fix):
--   -- ordinary Admin attempts to disable a Super Admin via the RPC:
--   -- expect exception 'Only a Super Administrator may disable a Super
--   -- Administrator'
--   SELECT disable_user_profile('<super-admin-id>');
--
--   -- ordinary Admin attempts to disable a Super Admin via a RAW UPDATE
--   -- (simulating a direct REST call that bypasses disable-user/the RPC
--   -- entirely): expect exception 'Only a Super Administrator may
--   -- disable another Super Administrator' (raised by the trigger)
--   UPDATE profiles SET is_active = false WHERE id = '<super-admin-id>';
--
--   -- genuine Super Admin attempts to disable THEMSELVES: expect
--   -- exception 'You cannot disable your own account' (RPC) or 'You
--   -- cannot disable your own Super Administrator account' (raw UPDATE,
--   -- caught by the trigger)
--   SELECT disable_user_profile('<self-id>');
--
--   -- genuine Super Admin disables the ONLY other active Super Admin:
--   -- expect exception 'Cannot remove the last active Super
--   -- Administrator'
--   SELECT disable_user_profile('<last-other-super-admin-id>');
--
--   -- with 2+ active Super Admins, genuine Super Admin disables another:
--   -- expect SUCCESS, target row now is_active = false
--   SELECT disable_user_profile('<other-super-admin-id>');
--
--   -- ordinary Admin disabling an ordinary (non-super) user: expect
--   -- SUCCESS, unaffected by this fix
--   SELECT disable_user_profile('<ordinary-user-id>');
--
--   -- existing tenant-scoped last-Business-Admin protection still
--   -- fires (unchanged trigger logic): expect exception 'Cannot remove
--   -- the last remaining active Admin for this tenant'
--   SELECT disable_user_profile('<tenants-only-remaining-business-admin-id>');
--
-- PART 2:
--   -- ordinary Admin, direct REST-equivalent UPDATE: expect 0 rows
--   -- affected / RLS rejection
--   UPDATE system_settings SET value = '"2026-10"' WHERE key = 'current_payroll_month';
--
--   -- ordinary Admin, unrelated key: expect SUCCESS (unaffected)
--   UPDATE system_settings SET value = '"25"' WHERE key = 'default_page_size';
--
--   -- genuine Super Admin: expect SUCCESS
--   UPDATE system_settings SET value = '"2026-10"' WHERE key = 'current_payroll_month';
--
-- PART 3:
--   SELECT role, permission FROM role_permissions WHERE permission LIKE 'terminal_dues.%' ORDER BY role, permission;
--   -- expect exactly: (admin,terminal_dues.create), (admin,terminal_dues.view),
--   -- (accountant,terminal_dues.pay), (accountant,terminal_dues.view),
--   -- (hr_manager,terminal_dues.create), (hr_manager,terminal_dues.edit),
--   -- (hr_manager,terminal_dues.view)
--
--   -- ordinary Admin calling approve_terminal_due(): expect exception
--   -- 'Only an Admin explicitly granted terminal_dues.approve (or a super
--   -- admin) may approve terminal dues'
--   SELECT approve_terminal_due('<some-terminal-due-id>');
-- ============================================================
