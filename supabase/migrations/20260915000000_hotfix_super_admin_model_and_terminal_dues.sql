-- ============================================================
-- MIGRATION (HOTFIX): Formal Super Administrator model +
-- Terminal Dues separation-of-duties correction
-- Date: 2026-09-15
-- ============================================================
--
-- This is a targeted production hotfix. It does NOT touch payroll/
-- attendance batching, guard-ID cleanup, or any other item explicitly
-- deferred to the later performance/scaling PR. It contains exactly three
-- independent, narrowly-scoped changes:
--
--   PART 1 -- set_super_admin_status() RPC: the smallest secure mechanism
--            letting ONLY a genuine Super Administrator promote/demote
--            another profile's is_super_admin flag, with a last-active-
--            Super-Administrator lockout guard and audit logging.
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
  v_remaining_supers INTEGER;
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
  -- genuine demotion (true -> false). A single fixed (non-per-tenant)
  -- advisory lock serializes concurrent demotions against this same
  -- global invariant -- see header.
  IF COALESCE(v_target.is_super_admin, false) AND NOT p_is_super_admin THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('global_super_admin_invariant', 0));

    SELECT count(*) INTO v_remaining_supers
    FROM profiles
    WHERE is_super_admin = true
      AND is_active = true
      AND deleted_at IS NULL
      AND id <> p_target_id;

    IF v_remaining_supers = 0 THEN
      RAISE EXCEPTION 'Cannot remove the last active Super Administrator';
    END IF;
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
