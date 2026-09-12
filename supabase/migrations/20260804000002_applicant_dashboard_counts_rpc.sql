-- ============================================================
-- MIGRATION: Counts-only applicant dashboard RPC
-- Date: 2026-08-04
-- ============================================================
--
-- *** THIS IS PHASE 1 (EXPAND) OF A 2-PHASE ROLLOUT. ***
-- Phase 2 (CONTRACT) is 20260804000003_restrict_applicants_select.sql,
-- a separate, later migration that actually restricts `applicants`
-- SELECT access -- read that file's header for the full sequence and
-- why the two are deliberately not combined into one migration.
--
-- WHY THIS EXISTS
-- -----------------------------------------------------------
-- Business decision (this pass): Staff (role_level 4) and Supervisor
-- (role_level 3) should continue seeing recruitment counts on the
-- Dashboard, but must NOT be able to read full applicant rows (name,
-- email, phone, notes, interview details, decisions) -- that will be
-- restricted to Admin/Manager/Super Admin only, but NOT by this
-- migration -- see 20260804000003_restrict_applicants_select.sql, which
-- must not be applied until AFTER this migration's RPC is confirmed
-- live and the frontend that calls it is confirmed deployed (Phase 2's
-- own header spells out the exact precondition checklist).
--
-- This migration is purely additive (Phase 1 / expand): it creates the
-- RPC and changes nothing about `applicants`' existing (tenant-wide)
-- SELECT policy. Applying ONLY this migration is always safe, at any
-- time, regardless of which frontend version (old, direct-SELECT-based,
-- or new, RPC-based) happens to be deployed -- both keep working, since
-- the direct-SELECT path is not yet touched.
--
-- src/pages/Dashboard.tsx previously ran 3 direct SELECTs against
-- `applicants` (COUNT via `select('id', {count:'exact'})`) to populate
-- exactly 3 numbers, derived directly from that file's own code (not
-- guessed):
--   pendingRecruitment     = COUNT(*) WHERE interview_status = 'Pending'
--   shortlistedRecruitment = COUNT(*) WHERE interview_status = 'Shortlisted'
--   interviewedRecruitment = COUNT(*) WHERE interview_status = 'Interviewed'
-- (rendered as a single StatCard: "Pending Recruitment" = pendingRecruitment,
-- subtitle "{shortlisted} shortlisted, {interviewed} interviewed" --
-- Dashboard.tsx:691.) Those 3 queries relied on `applicants`' SELECT RLS
-- policy being tenant-wide for every role; once that policy is narrowed
-- to role_level <= 2 (this migration's sibling change), a Supervisor/
-- Staff caller's direct COUNT queries would silently return 0 instead of
-- the real count -- this RPC replaces those 3 direct queries with a
-- single call that returns ONLY the 3 aggregate integers below, nothing
-- else, regardless of the caller's role_level.
--
-- WHAT THIS RPC DELIBERATELY DOES NOT RETURN
-- -----------------------------------------------------------
-- No applicant id, name, email, phone, notes, interview_status detail
-- per row, decision, position, or any other column -- only 3 COUNT(*)
-- integers, computed server-side. There is no way for a caller of this
-- function, regardless of role, to recover individual row data from its
-- return value.
-- ============================================================

CREATE OR REPLACE FUNCTION get_applicant_dashboard_counts()
RETURNS TABLE (
  pending_count INTEGER,
  shortlisted_count INTEGER,
  interviewed_count INTEGER
)
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  -- Identity/tenant are derived entirely from the authenticated caller's
  -- own session (auth.uid() -> profiles.tenant_id via get_current_tenant_id(),
  -- the same helper every other SECURITY DEFINER function in this schema
  -- uses) -- never from a client-supplied parameter. This function takes
  -- no arguments at all, so there is nothing for a caller to pass a
  -- different tenant_id through.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for the current user';
  END IF;

  -- Same tenant-or-super-admin predicate as every existing RLS policy on
  -- `applicants` (see 20260727000000_reconstructed_base_schema.sql /
  -- 20260803000000_role_level_rls_hardening.sql), reproduced explicitly
  -- here because SECURITY DEFINER functions bypass RLS entirely -- this
  -- WHERE clause is this function's own, self-contained authorization
  -- boundary, not a convenience filter on top of RLS. A super admin gets
  -- the same cross-tenant count behavior they'd get from the underlying
  -- table's own SELECT policy today; every other caller is scoped
  -- strictly to their own tenant, regardless of role_level -- role_level
  -- is intentionally NOT checked here, since every authenticated role (1-4)
  -- is meant to see these counts on the Dashboard.
  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE interview_status = 'Pending')::INTEGER,
    COUNT(*) FILTER (WHERE interview_status = 'Shortlisted')::INTEGER,
    COUNT(*) FILTER (WHERE interview_status = 'Interviewed')::INTEGER
  FROM applicants
  WHERE (tenant_id = v_tenant_id OR is_super_admin() = true);
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

-- `authenticated` only -- explicit REVOKE first (defense in depth, matches
-- the pattern already used by generate_guard_id()/generate_employee_number()/
-- process_payroll_batch() in this schema) so an anonymous/unauthenticated
-- caller cannot reach this function at all, before it even gets a chance
-- to evaluate auth.uid().
--
-- SECURITY CORRECTION (found during real STAGING validation): `REVOKE ALL
-- ... FROM PUBLIC` alone was NOT sufficient -- the `anon` role had its own
-- EXPLICIT EXECUTE grant on this function, independent of PUBLIC. Revoking
-- from PUBLIC only removes the privilege every role inherits implicitly
-- through PUBLIC; it does NOT remove a grant made directly to a specific
-- role such as `anon`. STAGING was corrected manually with the explicit
-- `REVOKE EXECUTE ... FROM anon` below, now folded back into this
-- migration so a fresh apply is correct from the start, without relying on
-- a manual follow-up step.
REVOKE ALL ON FUNCTION get_applicant_dashboard_counts() FROM PUBLIC;
REVOKE EXECUTE
ON FUNCTION public.get_applicant_dashboard_counts()
FROM anon;
GRANT EXECUTE ON FUNCTION get_applicant_dashboard_counts() TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE, SUCCESSFULLY: yes -- `CREATE OR REPLACE FUNCTION` + `REVOKE`/
-- `GRANT` are all idempotent.
--
-- RUN TWICE, ACCIDENTALLY: fully safe -- redefines the same function
-- identically, re-applies the same grants.
--
-- LOCKS TAKEN / PRODUCTION TRAFFIC IMPACT: none beyond the brief catalog
-- lock for the function definition itself -- no table is altered, no
-- existing data is touched or scanned at migration-apply time.
--
-- PREFLIGHT: none needed -- this migration only adds a new function; it
-- does not modify `applicants` or any other table/constraint.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'get_applicant_dashboard_counts';
--   -- Expected: 1 row, prosecdef = true.
--   SELECT has_function_privilege('authenticated', 'get_applicant_dashboard_counts()', 'EXECUTE');
--   -- Expected permissions: authenticated = true.
--   SELECT has_function_privilege('anon', 'get_applicant_dashboard_counts()', 'EXECUTE');
--   -- Expected permissions: anon = false. Re-verify this specifically after
--   -- applying -- this is the exact check that caught the missing explicit
--   -- `anon` revoke in STAGING; `REVOKE ALL ... FROM PUBLIC` passing this
--   -- check is NOT sufficient on its own if `anon` was ever granted EXECUTE
--   -- directly (e.g. by a prior migration, a manual grant, or a default
--   -- privilege) -- only the explicit `REVOKE EXECUTE ... FROM anon` above
--   -- guarantees it.
--
-- ROLLBACK SQL (safe at any time -- reverting means Dashboard.tsx's RPC
-- call starts failing; see Dashboard.tsx's own fallback-to-zero handling
-- for what a caller sees if this function is ever unavailable):
--   REVOKE EXECUTE ON FUNCTION get_applicant_dashboard_counts() FROM authenticated;
--   DROP FUNCTION IF EXISTS get_applicant_dashboard_counts();
-- Roll back the Dashboard.tsx commit that calls this RPC BEFORE dropping
-- the function, for the same reason noted in every other RPC migration in
-- this schema -- dropping a function a deployed frontend still actively
-- calls turns a planned rollback into a broken Dashboard for every role.
--
-- STAGING TEST PROCEDURE (run against a staging Supabase project only)
-- -----------------------------------------------------------
-- 1. As an Admin/Manager: SELECT * FROM get_applicant_dashboard_counts();
--    Expect 3 integers matching a manual
--    SELECT COUNT(*) FROM applicants WHERE interview_status = '<status>'
--    AND tenant_id = '<this tenant>' for each status.
-- 2. As a Supervisor/Staff: same call, same expected result -- role_level
--    is not checked by this function, only tenant membership.
-- 3. As a Supervisor/Staff, at THIS phase, a DIRECT row-level query
--    (`select('*').from('applicants')`) should still SUCCEED (returns
--    real rows) -- this migration alone does not restrict SELECT. It
--    only becomes denied/empty once 20260804000003_restrict_applicants_select.sql
--    (Phase 2) is separately applied, after that file's own precondition
--    checklist is satisfied. Testing that denial here, before Phase 2 is
--    applied, would be testing the wrong migration's effect.
-- 4. Unauthenticated (anon client, no session): call the RPC directly,
--    expect a permission-denied error (the REVOKE ALL FROM PUBLIC / no
--    GRANT to anon above) rather than reaching the auth.uid() check at
--    all.
-- 5. Confirm the returned row never contains any column other than the
--    3 integers, regardless of role -- there is no parameter or code
--    path in this function that could ever widen its return shape.
-- ============================================================
