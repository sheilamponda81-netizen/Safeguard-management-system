-- ============================================================
-- MIGRATION: Fix approve_payroll_run production failure
--   "relation \"profiles\" does not exist" (SQLSTATE 42P01)
-- Date: 2026-08-31
-- Follows: 20260831000000_payroll_approval_rpc.sql (already applied to
--   production manually via the Supabase SQL Editor, and merged to main
--   at a018152646da7eace853f5ed2436759d17ce19aa). This is a narrow
--   follow-up, not a rewrite -- it replaces ONLY approve_payroll_run's
--   body; nothing else from that migration changes.
-- ============================================================
--
-- ROOT CAUSE (verified against the actual committed source, not assumed):
--
-- approve_payroll_run() calls three existing helper functions to resolve
-- the caller's tenant/role/super-admin status:
--   public.get_current_tenant_id()  (20260727000000_reconstructed_base_schema.sql:114)
--   public.is_super_admin()         (20260727000000_reconstructed_base_schema.sql:126)
--   public.current_user_role_level() (20260727000001_security_hardening.sql:79)
--
-- All three are SECURITY DEFINER but, critically, NONE of them declares
-- its own `SET search_path`, and all three read the caller's row with an
-- UNQUALIFIED `FROM profiles` (not `FROM public.profiles`). Example
-- (get_current_tenant_id, identical shape in the other two):
--
--   CREATE OR REPLACE FUNCTION get_current_tenant_id()
--   RETURNS UUID AS $$
--   BEGIN
--     RETURN (SELECT tenant_id FROM profiles WHERE id = auth.uid() LIMIT 1);
--   END;
--   $$ LANGUAGE plpgsql SECURITY DEFINER;
--
-- In PostgreSQL, `search_path` is a GUC scoped for the duration of the
-- enclosing function call when set via that function's own `SET
-- search_path = ...` clause -- and that scoping applies to every nested
-- call made from inside it that does not set its own search_path.
-- approve_payroll_run() itself declares `SET search_path = ''`
-- (deliberately, to make every relation reference inside it resolve only
-- via explicit schema qualification -- the standard hardening against
-- search-path-injection in a SECURITY DEFINER function). Because the
-- three helper functions above have no `SET search_path` of their own,
-- calling them FROM INSIDE approve_payroll_run() runs their unqualified
-- `FROM profiles` with search_path = '' still in effect -- so `profiles`
-- resolves against no schema at all, and PostgreSQL raises exactly
-- `relation "profiles" does not exist` (42P01). This is NOT a PostgREST
-- schema-cache issue -- the RPC is being resolved and invoked correctly;
-- execution fails inside the function body, after entry, on the very
-- first line that calls one of these helpers.
--
-- This was reproduced empirically (not just reasoned about) against a
-- real local Postgres 16 instance: the exact committed bodies of all
-- three helper functions, plus the exact committed body of
-- approve_payroll_run() from 20260831000000_payroll_approval_rpc.sql,
-- were loaded into a disposable database and invoked as the
-- `authenticated` role -- producing the identical error, same message,
-- same relation name, same point of failure (inside
-- get_current_tenant_id(), called from approve_payroll_run()'s first
-- executable line).
--
-- Why this specific function and not the many other call sites of these
-- same three helpers elsewhere in the schema (RLS policies, other
-- triggers): every other caller runs under PostgREST's/the session's
-- normal (non-empty) search_path, so the helpers' own unqualified
-- `FROM profiles` resolves fine there. approve_payroll_run() is the
-- first function in this codebase to combine SECURITY DEFINER with an
-- explicit `SET search_path = ''` AND to call these particular helpers
-- -- the combination is what exposes the gap, not a change to the
-- helpers themselves.
--
-- FIX: do not weaken approve_payroll_run()'s own `SET search_path = ''`,
-- and do not modify the three helper functions (they are correct and
-- safe for every other caller, which is the established, load-bearing
-- pattern for every other SECURITY DEFINER function and RLS policy in
-- this schema -- widening this fix to touch them is explicitly out of
-- scope for a narrow hotfix and would need its own review). Instead,
-- approve_payroll_run() now reads the caller's tenant_id, is_super_admin,
-- role_level, and region_id directly with one schema-qualified query
-- against public.profiles, replacing all three helper calls. This is
-- exactly the same data those helpers would have returned (they read the
-- same columns off the same profiles row for the same auth.uid()) via a
-- path that never depends on search_path at all.
--
-- Everything else is byte-for-byte unchanged from
-- 20260831000000_payroll_approval_rpc.sql: authentication/status/id-list
-- validation, the regular-Admin tenant-consistency check
-- (p.tenant_id = v_tenant_id, added in a prior follow-up commit) and
-- region check, the super-admin branch, p.month = p_month, the
-- payroll.id-array snapshot targeting, the all-or-nothing
-- COUNT(DISTINCT ...) vs ROW_COUNT rollback, and the REVOKE/GRANT block.
-- ============================================================

DROP FUNCTION IF EXISTS public.approve_payroll_run(TEXT, TEXT, TEXT, UUID[]);

CREATE OR REPLACE FUNCTION public.approve_payroll_run(
  p_month TEXT,
  p_status TEXT,
  p_notes TEXT,
  p_payroll_ids UUID[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_is_super BOOLEAN;
  v_role_level INTEGER;
  v_region_id UUID;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
  v_requested_count INTEGER;
  v_updated_count INTEGER;
BEGIN
  -- Fail closed: no authenticated caller at all.
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Only the values the current UI actually sends -- 'pending' is a
  -- real approval_status value in the payroll CHECK constraint, but
  -- approvePayroll()'s own TypeScript signature is
  -- `status: 'approved' | 'rejected'` only; this function matches that,
  -- not the column's full value set.
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid approval status: %', p_status USING ERRCODE = '22023';
  END IF;

  IF p_payroll_ids IS NULL OR array_length(p_payroll_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No payroll record ids supplied' USING ERRCODE = '22023';
  END IF;

  -- Reject a null element explicitly (Postgres arrays can contain NULLs
  -- even for a UUID[] column type) -- `p.id = ANY(array_with_a_null)`
  -- would not error on its own, it would just never match that element,
  -- which the all-or-nothing count check below would also catch, but a
  -- dedicated check here fails faster with a clearer, specific message.
  IF EXISTS (SELECT 1 FROM unnest(p_payroll_ids) AS t(id) WHERE t.id IS NULL) THEN
    RAISE EXCEPTION 'Payroll id list contains a null value' USING ERRCODE = '22023';
  END IF;

  -- Caller's tenant/role/super-admin/region, read directly from
  -- public.profiles -- deliberately NOT via get_current_tenant_id()/
  -- is_super_admin()/current_user_role_level(). Those helpers each do an
  -- unqualified `FROM profiles` with no `SET search_path` of their own,
  -- so calling them from inside this function (which runs under
  -- `SET search_path = ''`) fails with `relation "profiles" does not
  -- exist` -- see this migration's header for the full root-cause
  -- analysis and empirical reproduction. Querying public.profiles
  -- directly here is schema-qualified like every other relation
  -- reference in this function, and returns the exact same data those
  -- helpers would have (same columns, same profiles row, same
  -- auth.uid()) without any search_path dependency at all.
  SELECT p.tenant_id, COALESCE(p.is_super_admin, false), p.role_level, p.region_id, p.is_active, p.deleted_at
  INTO v_tenant_id, v_is_super, v_role_level, v_region_id, v_is_active, v_deleted_at
  FROM public.profiles p
  WHERE p.id = v_caller_id;

  -- Fail closed: caller has no resolvable profile at all (the SELECT
  -- above leaves every target variable NULL when no row matches, the
  -- same as the helper functions it replaces would have returned).
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the authenticated caller' USING ERRCODE = '42501';
  END IF;

  -- SECURITY (2026-09-08 production preflight): this function was
  -- deliberately written to bypass get_current_tenant_id()/
  -- is_super_admin()/current_user_role_level() (see the header note
  -- above -- those helpers broke under this function's SET search_path =
  -- '' at the time). Doing so also lost the is_active/deleted_at gating
  -- those helpers provide -- v_is_super/v_role_level were being read as
  -- raw column values with only a row-existence check, so a DEACTIVATED
  -- super-admin or deactivated legacy Admin (role_level = 1) could still
  -- approve/reject real payroll. Restored here, explicitly, matching what
  -- get_current_tenant_id() etc. would have enforced.
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;

  -- Same rule as canApprovePayroll client-side and the existing payroll
  -- UPDATE RLS policy's WITH CHECK: only role_level = 1 (Admin) or a
  -- super admin may approve/reject payroll.
  IF NOT (v_is_super OR v_role_level = 1) THEN
    RAISE EXCEPTION 'Only managers and admins can approve payroll' USING ERRCODE = '42501';
  END IF;

  -- Fail closed: a regular (non-super-admin) Admin with no region on
  -- their own profile has no well-defined approval scope -- proceeding
  -- would either silently match zero rows (confusing: looks like
  -- "nothing to approve") or, if this check were skipped entirely, risk
  -- a mis-scoped match. Reject explicitly instead. (v_region_id was
  -- already fetched above in the same query as tenant_id/role_level, so
  -- there is no separate second profiles lookup here as there was
  -- before -- a super admin's region_id, if any, is simply unused below.)
  IF NOT v_is_super AND v_region_id IS NULL THEN
    RAISE EXCEPTION 'Your account has no region assigned; payroll approval scope cannot be determined' USING ERRCODE = '42501';
  END IF;

  -- The DISTINCT count of supplied ids, computed independently of
  -- whatever deduplication the client may or may not have already done
  -- -- this function's correctness never depends on client behavior.
  SELECT COUNT(DISTINCT t.id)
  INTO v_requested_count
  FROM unnest(p_payroll_ids) AS t(id);

  -- One atomic UPDATE. p_month is an additional guard on top of the
  -- supplied ids (belt-and-braces: every id already implies its own
  -- month via the row itself, but this also protects against a stale id
  -- from a different month somehow ending up in the array). A super
  -- admin's ids are trusted directly once role/month match; a regular
  -- Admin's ids are additionally re-authorized both directly against the
  -- payroll row's own tenant_id and through the linked employee's
  -- tenant_id/region_id. Rows that fail any of these checks are simply
  -- not matched by this WHERE clause -- they do not raise an error on
  -- their own, which is exactly why the count comparison below is
  -- required for all-or-nothing correctness.
  UPDATE public.payroll p
  SET approval_status = p_status,
      approved_by = v_caller_id,
      approved_at = NOW(),
      approval_notes = p_notes,
      updated_at = NOW()
  WHERE p.id = ANY(p_payroll_ids)
    AND p.month = p_month
    AND (
      v_is_super
      OR (
        p.tenant_id = v_tenant_id
        AND EXISTS (
          SELECT 1
          FROM public.employees e
          WHERE e.id = p.employee_id
            AND e.tenant_id = p.tenant_id
            AND e.tenant_id = v_tenant_id
            AND e.region_id = v_region_id
        )
      )
    );

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  -- All-or-nothing: if even one supplied id didn't get updated (wrong
  -- month, doesn't exist, or failed the tenant/region re-check), abort
  -- the entire approval rather than silently committing the subset that
  -- did match. This RAISE is not caught by any exception handler in this
  -- function, so PostgreSQL rolls back the UPDATE above along with
  -- everything else in this statement.
  IF v_updated_count <> v_requested_count THEN
    RAISE EXCEPTION 'Payroll approval scope changed; refresh and retry' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_updated_count;
END;
$$;

-- Same privilege convention as the original migration -- SECURITY
-- DEFINER functions are PUBLIC-executable by default in Postgres; this
-- one is deliberately locked down further than that baseline.
REVOKE ALL ON FUNCTION public.approve_payroll_run(TEXT, TEXT, TEXT, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_payroll_run(TEXT, TEXT, TEXT, UUID[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.approve_payroll_run(TEXT, TEXT, TEXT, UUID[]) TO authenticated;

-- ============================================================
-- END OF PAYROLL APPROVAL RPC SEARCH-PATH FIX
-- ============================================================
