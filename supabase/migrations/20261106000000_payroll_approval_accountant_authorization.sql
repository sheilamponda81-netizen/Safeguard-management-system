-- ============================================================
-- MIGRATION: Allow an authorized Accountant to approve/reject payroll,
-- alongside Admin/super-admin, via the existing payroll.approve
-- permission. Add an audit log entry to the decision. Add a fail-closed
-- state-transition guard so a repeated/duplicate call against an
-- already-decided row can no longer silently overwrite the original
-- decision (found during this hotfix's own final safety review --
-- see the guard's own comment above the UPDATE statement below).
-- Date: 2026-11-06
-- ============================================================
--
-- BUSINESS CLARIFICATION THIS MIGRATION IMPLEMENTS
-- -----------------------------------------------------------
-- New authorized business policy: Admin and Accountant must both be
-- eligible to approve a PENDING PAYROLL RUN (payroll.approval_status:
-- pending -> approved/rejected, via approve_payroll_run() -- a POST-
-- commit sign-off on payroll rows that already exist). Either an
-- appropriately authorized Admin or an appropriately authorized
-- Accountant may approve; this does not require both signatures.
--
-- IMPORTANT -- SCOPE: this migration touches ONLY approve_payroll_run().
-- It does NOT touch the SEPARATE, newer payroll_processing_requests
-- workflow (submit_payroll_processing_request() / approve_payroll_
-- processing_request() / reject_payroll_processing_request() /
-- process_approved_payroll_request(), added 2026-10-28). That workflow
-- gates the PRE-commit decision of whether an Accountant-INITIATED
-- payroll run may actually be WRITTEN to `payroll` at all, and is
-- deliberately Admin-class-only (is_super_admin() OR is_business_admin())
-- specifically to prevent an Accountant approving their own submitted
-- request -- see that migration's own header for the full reasoning.
-- Widening THAT gate to also accept has_permission('payroll.approve')
-- would let an Accountant approve their own request (the exact bypass it
-- exists to close), since an Accountant already legitimately holds
-- payroll.approve for the DIFFERENT, older purpose this migration
-- addresses. The two "approve" actions are distinct business decisions
-- that happen to share an English word; this migration deliberately
-- leaves the newer, pre-commit gate untouched.
--
-- ROOT CAUSE (the prior audit's finding, re-confirmed against the final
-- committed function body in 20260831010000_payroll_approval_rpc_
-- search_path_fix.sql before writing this migration):
-- `role_permissions` already seeds ('accountant', 'payroll.approve')
-- (20260817000000) -- an Accountant legitimately holds this permission
-- today. The UI (canApprovePayroll / PERMISSIONS.PAYROLL_APPROVE) already
-- shows the Approve/Reject controls to an Accountant on that basis. But
-- approve_payroll_run()'s own authorization check only ever accepted
-- `COALESCE(v_is_super, false) OR COALESCE(v_role_level = 1, false)` --
-- no has_permission(...) branch at all, unlike nearly every other RPC in
-- this schema added after the functional-roles system existed. An
-- Accountant clicking Approve has therefore always failed server-side
-- with 'Only managers and admins can approve payroll', even though the
-- permission matrix and the UI both say they should succeed. This is a
-- narrow, additive fix for exactly that gap -- not a rewrite.
--
-- WHY has_permission('payroll.approve') IS SAFE TO ADD HERE (unlike for
-- the pre-commit request-approval RPC discussed above): this function is
-- a POST-commit sign-off on rows that were already written by SOMEONE
-- ELSE'S call to process_payroll_batch()/process_payroll_with_terminal_
-- dues() at an earlier point in time -- the caller approving here is, by
-- construction of this RPC's own inputs (a month + a list of already-
-- persisted payroll row ids), never "approving their own submission" in
-- the sense the Phase 3D migration was built to prevent, because there is
-- no "submission" object here that has an owner to compare against in
-- the first place (see the SEPARATION-OF-DUTIES note below for what this
-- does and does not mean in practice).
--
-- has_permission('payroll.approve') is also confirmed NULL-safe to call
-- from inside this function: has_permission() itself declares `SET
-- search_path = public, pg_temp` (20260817000000_functional_role_
-- permissions_foundation.sql), as do every function IT calls internally
-- (is_current_user_active(), is_business_admin(), current_user_role()) --
-- so once execution is inside has_permission()'s own body, none of the
-- 20260831010000 migration's root-caused search-path bug can recur there.
-- has_permission() also never returns SQL NULL (it returns a real boolean
-- in every branch, including an explicit `RETURN false` when the caller's
-- role is NULL), so no COALESCE wrapper is needed around it, unlike the
-- two raw column comparisons already in this check.
--
-- IMPORTANT, CAUGHT BY EMPIRICAL REHEARSAL (not by the reasoning above):
-- a callee's own `SET search_path` only governs name resolution ONCE
-- execution is already inside that callee's body -- it has no effect on
-- how the CALL SITE itself resolves the bare identifier `has_permission`.
-- This function still runs under `SET search_path = ''`, so an unqualified
-- `has_permission('payroll.approve')` call here fails at the call site
-- with `function has_permission(unknown) does not exist`, before
-- has_permission()'s own search_path ever comes into play -- confirmed by
-- running this exact migration against a disposable rehearsal database.
-- The call below is therefore schema-qualified as `public.has_permission(...)`,
-- consistent with every other cross-schema reference in this function
-- (`public.profiles`, `public.employees`, `public.payroll`, `public.audit_logs`).
--
-- has_permission('payroll.approve') is ONLY seeded for 'accountant' today
-- (confirmed: a single row in role_permissions) -- hr_manager, operations_
-- manager, and every other functional role remain correctly REJECTED by
-- this change, exactly as required.
--
-- EVERYTHING ELSE IN THIS FUNCTION IS UNCHANGED: authentication, status/
-- id-list validation, the disabled-account check, the region-scope check
-- (a non-super caller approving via the new has_permission(...) branch is
-- scoped to their own tenant+region by the SAME existing UPDATE WHERE
-- clause an Admin already goes through -- no special-casing needed), the
-- all-or-nothing COUNT(DISTINCT ...) vs ROW_COUNT rollback, and the
-- REVOKE/GRANT block.
--
-- NEW: an audit_logs entry is now written on every successful approval/
-- rejection decision (identity = v_caller_id, timestamp = NOW(), decision
-- = p_status, plus the month and the exact payroll ids affected) -- this
-- function previously wrote no audit_logs entry at all (the payroll row's
-- own approved_by/approved_at/approval_notes columns were the only
-- record). Matches the established pattern every other consequential RPC
-- in this schema already follows.
--
-- SEPARATION OF DUTIES -- REPORTED, NOT CHANGED (see deliverable #10 of
-- this hotfix's own task): this function has NEVER checked, and still
-- does not check, whether the caller approving a payroll run is the same
-- person who originally PROCESSED it. There is no server-side barrier
-- today preventing an Admin (or, after this migration, an authorized
-- Accountant) from both running "Process Payroll" and then personally
-- approving the result. This is a deliberate non-change: the `payroll`
-- table has no column recording who processed a given row in the first
-- place (only `processed_at`, a timestamp, with "who" only ever recorded
-- in `audit_logs`'s own 'combined_payroll_run' entry, not joinable back
-- to a payroll.id without extra schema work) -- adding a same-person
-- rejection gate would require a genuine schema change (e.g. a new
-- `processed_by` column) and a product decision about whether that
-- separation should be mandatory, optional, or role-dependent, none of
-- which this narrow hotfix invents. Report this plainly; do not silently
-- add or silently omit a policy here.
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
  -- exist` -- see 20260831010000's header for the full root-cause
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

  -- SECURITY (2026-09-08 production preflight, unchanged by this
  -- migration): restores the is_active/deleted_at gating the bypassed
  -- helper functions would have enforced -- a deactivated super-admin or
  -- deactivated legacy Admin (role_level = 1) may not approve/reject
  -- payroll. has_permission() (used below) independently enforces this
  -- same gate for the new Accountant branch via its own
  -- is_current_user_active() check, so this explicit check continues to
  -- cover the role_level/super-admin branches consistently.
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;

  -- AUTHORIZATION (2026-11-06, this migration): Admin (role_level = 1),
  -- super admin, OR an account explicitly granted payroll.approve (today
  -- that is exactly 'accountant' in role_permissions -- hr_manager,
  -- operations_manager, and every other functional role remain rejected,
  -- since they do not hold this permission). Both role_level and
  -- is_super remain wrapped in COALESCE(..., false) per the 2026-09-08
  -- NULL-propagation fix (role_level is NULL by design for every
  -- functional-role account, including a functional 'admin'); has_
  -- permission() itself never returns NULL, so it needs no COALESCE.
  IF NOT (
    COALESCE(v_is_super, false)
    OR COALESCE(v_role_level = 1, false)
    OR public.has_permission('payroll.approve')
  ) THEN
    RAISE EXCEPTION 'Only managers, admins, or an account explicitly granted payroll.approve can approve payroll' USING ERRCODE = '42501';
  END IF;

  -- Fail closed: a regular (non-super-admin) approver with no region on
  -- their own profile has no well-defined approval scope -- proceeding
  -- would either silently match zero rows (confusing: looks like
  -- "nothing to approve") or, if this check were skipped entirely, risk
  -- a mis-scoped match. Reject explicitly instead. Applies uniformly to
  -- a regular Admin and to an Accountant approving via the new branch
  -- above -- same scoping rule, no special-casing by role. (v_region_id
  -- was already fetched above in the same query as tenant_id/role_level,
  -- so there is no separate second profiles lookup here -- a super
  -- admin's region_id, if any, is simply unused below.)
  IF NOT v_is_super AND v_region_id IS NULL THEN
    RAISE EXCEPTION 'Your account has no region assigned; payroll approval scope cannot be determined' USING ERRCODE = '42501';
  END IF;

  -- The DISTINCT count of supplied ids, computed independently of
  -- whatever deduplication the client may or may not have already done
  -- -- this function's correctness never depends on client behavior.
  SELECT COUNT(DISTINCT t.id)
  INTO v_requested_count
  FROM unnest(p_payroll_ids) AS t(id);

  -- FAIL-CLOSED STATE-TRANSITION GUARD (2026-11-06, this migration --
  -- added after the hotfix's own rehearsal showed a duplicate/repeated
  -- call to this RPC against an already-decided row silently SUCCEEDED,
  -- overwriting approved_by/approved_at/approval_notes with the new
  -- caller's values and inserting a second audit_logs row, with no record
  -- in `payroll` itself of the original decision having been overwritten).
  -- This function's pre-existing WHERE clause never checked the row's
  -- CURRENT approval_status at all -- every call was an unconditional
  -- overwrite, not a guarded transition.
  --
  -- Permits exactly the transitions the rest of this schema actually
  -- relies on, and nothing else:
  --   pending  -> approved   (the normal, first decision)
  --   pending  -> rejected   (the normal, first decision)
  --   approved -> rejected   (the DOCUMENTED "un-approve" escape hatch --
  --                           see process_payroll_batch()'s own comment,
  --                           20260803000002: "Reprocessing must never
  --                           silently revert an approval to pending --
  --                           that has to go through an explicit
  --                           reject/un-approve step first (the existing
  --                           approvePayroll flow)". That function
  --                           independently REFUSES to reprocess any
  --                           month with an existing 'approved' row,
  --                           specifically because it expects THIS
  --                           function's reject path to be how an
  --                           approval gets undone first. Blocking this
  --                           transition here would break that already-
  --                           shipped, relied-upon escape hatch.)
  -- Blocks:
  --   approved -> approved  (re-approving an unchanged decision -- a
  --                          no-op that should not stamp a new approver/
  --                          timestamp over the original one)
  --   rejected -> rejected  (same, for rejection)
  --   rejected -> approved  (directly "approving" a rejected, stale row
  --                          with no intervening reprocess -- the row's
  --                          own figures were never recalculated after
  --                          whatever caused the rejection; the correct
  --                          path is reprocess first via
  --                          process_payroll_batch(), which resets
  --                          approval_status to 'pending' and makes the
  --                          FRESH row eligible for a normal pending ->
  --                          approved decision)
  -- A row this guard excludes simply fails to match the WHERE clause
  -- below, exactly like a wrong-tenant or wrong-region row already did --
  -- the existing all-or-nothing COUNT(DISTINCT...) vs ROW_COUNT check a
  -- few lines down therefore already aborts the ENTIRE call (not just the
  -- excluded row) and raises the existing 'Payroll approval scope
  -- changed; refresh and retry' exception, with NOTHING written -- the
  -- original decision's approved_by/approved_at/approval_notes and its
  -- own audit_logs entry are left completely untouched, and no new
  -- audit_logs row is inserted for a call that changes nothing.

  -- One atomic UPDATE. p_month is an additional guard on top of the
  -- supplied ids (belt-and-braces: every id already implies its own
  -- month via the row itself, but this also protects against a stale id
  -- from a different month somehow ending up in the array). A super
  -- admin's ids are trusted directly once role/month match; a regular
  -- Admin's or authorized Accountant's ids are additionally re-authorized
  -- both directly against the payroll row's own tenant_id and through the
  -- linked employee's tenant_id/region_id. Rows that fail any of these
  -- checks are simply not matched by this WHERE clause -- they do not
  -- raise an error on their own, which is exactly why the count
  -- comparison below is required for all-or-nothing correctness.
  UPDATE public.payroll p
  SET approval_status = p_status,
      approved_by = v_caller_id,
      approved_at = NOW(),
      approval_notes = p_notes,
      updated_at = NOW()
  WHERE p.id = ANY(p_payroll_ids)
    AND p.month = p_month
    AND (
      p.approval_status = 'pending'
      OR (p.approval_status = 'approved' AND p_status = 'rejected')
    )
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
  -- everything else in this statement (and, since it is in the same
  -- implicit transaction, the audit_logs insert below never happens for
  -- a failed/partial attempt either).
  IF v_updated_count <> v_requested_count THEN
    RAISE EXCEPTION 'Payroll approval scope changed; refresh and retry' USING ERRCODE = 'P0001';
  END IF;

  -- NEW (this migration): durable audit trail of the decision itself --
  -- identity (v_caller_id), timestamp (NOW(), implicit in audit_logs'
  -- own created_at default), and decision (p_status), plus enough
  -- context (month, exact ids, notes, row count) to reconstruct what was
  -- approved/rejected without re-deriving it from the payroll table's
  -- own mutable approval_status column.
  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id,
    v_caller_id,
    CASE WHEN p_status = 'approved' THEN 'APPROVE' ELSE 'REJECT' END,
    'payroll_run',
    p_month,
    '{}'::JSONB,
    jsonb_build_object(
      'month', p_month,
      'status', p_status,
      'notes', p_notes,
      'payroll_ids', p_payroll_ids,
      'updated_count', v_updated_count
    )
  );

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
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- DROP FUNCTION IF EXISTS + CREATE OR
-- REPLACE FUNCTION + the REVOKE/GRANT statements are all safe to re-run.
--
-- DEPENDENCIES: requires 20260831010000_payroll_approval_rpc_search_path_
-- fix.sql (the function this one replaces) and
-- 20260817000000_functional_role_permissions_foundation.sql
-- (has_permission(), is_business_admin(), is_current_user_active(),
-- current_user_role(), the 'accountant'/'payroll.approve' seed row).
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS: a super admin or a legacy
-- role_level = 1 Admin sees ZERO behavior change -- the two branches they
-- already passed are untouched. An Accountant (functional role, role_
-- level NULL, holding payroll.approve) who previously received 'Only
-- managers and admins can approve payroll' from this RPC will now
-- succeed, scoped to their own tenant+region exactly as a regular Admin
-- already is. hr_manager, operations_manager, and every other functional
-- role remain rejected (they do not hold payroll.approve). The separate,
-- newer payroll_processing_requests pre-commit workflow
-- (20261028000000) is completely unaffected by this migration -- an
-- Accountant still cannot approve their own initiated processing request
-- through that workflow; this migration does not touch it.
--
-- BEHAVIOR CHANGE (state-transition guard): previously, calling this RPC
-- twice against the same row (by anyone, any status) silently succeeded
-- both times, overwriting approved_by/approved_at/approval_notes and
-- inserting a second audit_logs row -- no error, no indication the
-- original decision had been overwritten. Now: pending->approved,
-- pending->rejected, and approved->rejected (the documented un-approve
-- escape hatch process_payroll_batch() relies on) still succeed exactly
-- as before; approved->approved, rejected->rejected, and rejected->
-- approved now fail the SAME WAY an already-wrong-tenant row always did
-- (excluded from the WHERE clause, caught by the existing all-or-nothing
-- count check, 'Payroll approval scope changed; refresh and retry',
-- nothing written). Any caller who legitimately needs to approve a
-- rejected month's payroll must reprocess it first (process_payroll_
-- batch(), which resets approval_status to 'pending') -- this migration
-- does not change that requirement, only makes it impossible to bypass
-- via a direct, stale rejected->approved call.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT prosrc LIKE '%public.has_permission(''payroll.approve'')%' AS has_new_branch
--   FROM pg_proc WHERE proname = 'approve_payroll_run';
--   -- expected: true
--   SELECT prosrc LIKE '%p.approval_status = ''pending''%' AS has_transition_guard
--   FROM pg_proc WHERE proname = 'approve_payroll_run';
--   -- expected: true
--   SELECT has_function_privilege('authenticated', 'approve_payroll_run(text, text, text, uuid[])', 'EXECUTE');
--   -- expected: true
--
-- ROLLBACK SQL (run this to fully revert this migration -- restores the
-- EXACT prior body from 20260831010000_payroll_approval_rpc_search_path_
-- fix.sql verbatim, including dropping the new has_permission(...)
-- branch, the new audit_logs insert, and the new state-transition guard):
--   DROP FUNCTION IF EXISTS public.approve_payroll_run(TEXT, TEXT, TEXT, UUID[]);
--   -- Then re-apply 20260831010000_payroll_approval_rpc_search_path_fix.sql's
--   -- own CREATE OR REPLACE FUNCTION approve_payroll_run block verbatim.
-- ============================================================
