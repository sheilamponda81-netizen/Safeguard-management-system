-- ============================================================
-- READ-ONLY VERIFICATION: inactive/deleted-caller fail-closed audit
-- (security reconciliation, 2026-09-08, discovered during PR #36
-- production preflight)
-- ============================================================
-- Every query below is SELECT-only except the two BEGIN/ROLLBACK blocks,
-- which simulate a caller identity via request.jwt.claim.sub and roll
-- back unconditionally -- nothing is written. Safe to run on staging or
-- production at any time.
--
-- BACKGROUND: current_user_role()/current_user_region_id()
-- (20260817000000) and process_payroll_batch/create_salary_advance/
-- approve_salary_advance/adjust_combined_repayment_plan
-- (20260817000003, plus their superseded drafts in 20260803000002/
-- 20260813000000/20260813000001), get_payroll_attendance_counts
-- (20260901000000/20260901010000), and approve_payroll_run
-- (20260831010000) all originally authorized callers using either a
-- helper function or a raw `profiles` read that did not check
-- is_active/deleted_at -- an inactive/deleted account could still pass
-- authorization on these paths. All are now fixed to fail closed. The 3
-- company-logo storage.objects policies (20260817000004) were also
-- hardened to require is_current_user_active() explicitly, as defense in
-- depth alongside is_business_admin()'s own fix.
-- ============================================================

-- 1. Confirm the 4 core helpers exist with the expected fail-closed body
--    (contains an explicit is_active/deleted_at or is_current_user_active
--    check).
SELECT
  pg_get_functiondef('current_user_role()'::regprocedure) LIKE '%IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL%' AS current_user_role_gated,
  pg_get_functiondef('current_user_region_id()'::regprocedure) LIKE '%IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL%' AS current_user_region_id_gated,
  pg_get_functiondef('is_business_admin()'::regprocedure) LIKE '%IF NOT is_current_user_active() THEN%' AS is_business_admin_gated,
  pg_get_functiondef('region_allowed(uuid)'::regprocedure) LIKE '%IF NOT is_current_user_active() THEN%' AS region_allowed_gated;
-- expected: all 4 = true

-- 2. Confirm every fixed RPC's live body contains the guard.
SELECT
  pg_get_functiondef('process_payroll_batch(text,jsonb,text,jsonb)'::regprocedure) LIKE '%Your account is disabled%' AS process_payroll_batch_gated,
  pg_get_functiondef('create_salary_advance(uuid,date,numeric,text,numeric,integer,numeric,text,text,text)'::regprocedure) LIKE '%Your account is disabled%' AS create_salary_advance_gated,
  pg_get_functiondef('approve_salary_advance(uuid,text,numeric,integer,text,text)'::regprocedure) LIKE '%Your account is disabled%' AS approve_salary_advance_gated,
  pg_get_functiondef('adjust_combined_repayment_plan(uuid,text,text,numeric,integer,text)'::regprocedure) LIKE '%Your account is disabled%' AS adjust_combined_repayment_plan_gated,
  pg_get_functiondef('get_payroll_attendance_counts(uuid[],text)'::regprocedure) LIKE '%Your account is disabled%' AS get_payroll_attendance_counts_gated,
  pg_get_functiondef('approve_payroll_run(text,text,text,uuid[])'::regprocedure) LIKE '%Your account is disabled%' AS approve_payroll_run_gated;
-- expected: all 6 = true

-- 3. Confirm the 3 company-logo storage policies require an active caller.
SELECT policyname, cmd, qual, with_check FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
  AND policyname LIKE 'Admins%company logo%'
ORDER BY cmd;
-- expected: all 3 rows show `is_current_user_active() = true` in qual/with_check

-- 4. Legacy-scope correction (2026-09-08, separate from the fail-closed
--    fix above): get_payroll_attendance_counts() originally used
--    `v_role_level IS NOT NULL` -- admits EVERY legacy role_level,
--    including Supervisor(3)/Staff(4), who never had Payroll nav access.
--    Corrected to `v_role_level <= 2`, matching the same threshold
--    20260908000000 already uses for the `payroll` table's own SELECT
--    policy. Functional Accountant access (has_permission('payroll.view'))
--    is unaffected.
--
--    NULL-PROPAGATION FIX (release-blocking, found during PR #36 audit):
--    the `v_role_level <= 2` correction above was itself NOT NULL-safe --
--    for a functional-role caller (role_level IS NULL), the bare
--    comparison evaluates to SQL NULL rather than false, which poisons the
--    enclosing `IF NOT (...)` to NULL. PL/pgSQL treats a NULL IF condition
--    the same as false, so the RAISE EXCEPTION was silently SKIPPED for
--    any functional-role caller lacking payroll.view -- empirically
--    reproduced against this exact function body (see PR #36 audit
--    history) before being fixed here. Every operand is now wrapped in
--    COALESCE(..., false). This check below now asserts the NULL-safe
--    form is present and that BOTH unsafe forms (the original blanket
--    `IS NOT NULL` rule, and the un-COALESCEd `<= 2` rule this migration
--    used before the NULL-propagation fix) are absent.
-- Matched against the specific executable phrase (not just any mention of
-- "v_role_level IS NOT NULL"/"v_role_level <= 2" -- the function's own
-- header comments quote both of those old rules for documentation
-- purposes, so a bare substring match against the whole body would
-- false-positive on the comments).
SELECT
  pg_get_functiondef('get_payroll_attendance_counts(uuid[],text)'::regprocedure) LIKE '%COALESCE(v_role_level <= 2, false)%' AS has_null_safe_le2_rule,
  pg_get_functiondef('get_payroll_attendance_counts(uuid[],text)'::regprocedure) LIKE '%COALESCE(has_permission(''payroll.view''), false)%' AS has_null_safe_permission_rule,
  pg_get_functiondef('get_payroll_attendance_counts(uuid[],text)'::regprocedure) LIKE '%OR v_role_level IS NOT NULL OR has_permission%' AS still_has_old_blanket_rule,
  pg_get_functiondef('get_payroll_attendance_counts(uuid[],text)'::regprocedure) LIKE '%IF NOT (v_is_super_admin OR v_role_level <= 2 OR has_permission(''payroll.view''))%' AS still_has_unsafe_bare_le2_rule;
-- expected: has_null_safe_le2_rule = true, has_null_safe_permission_rule =
-- true, still_has_old_blanket_rule = false, still_has_unsafe_bare_le2_rule
-- = false

-- 4b. LIVE SIMULATION of the exact NULL-propagation bypass this fix
--     closes -- requires a real, active, not-soft-deleted functional-role
--     profile id (role_level IS NULL) that does NOT hold payroll.view
--     (e.g. an Operations Manager without that permission). Wrapped in
--     BEGIN/ROLLBACK; the call is expected to RAISE, so this block itself
--     will show the exception when run interactively -- run it with
--     `\set ON_ERROR_STOP off` (or catch the error at the client) to see
--     the ROLLBACK still complete cleanly afterward.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<ACTIVE_FUNCTIONAL_ROLE_PROFILE_ID_WITHOUT_PAYROLL_VIEW>', true);
-- SELECT * FROM get_payroll_attendance_counts(
--   ARRAY['<ANY_EMPLOYEE_ID_IN_CALLERS_TENANT>']::uuid[], '2026-09'
-- );
-- -- expected: RAISES 'You do not have permission to view payroll
-- -- attendance totals' -- a successful, non-erroring result here means
-- -- the NULL-propagation bypass has regressed.
-- ROLLBACK;

-- ============================================================
-- LIVE SIMULATION -- requires a real inactive (or a deliberately
-- disposable, never-authenticated) profile id. Wrap in BEGIN/ROLLBACK so
-- nothing persists. Substitute a real inactive account's profiles.id
-- below, or use a random UUID with no matching profile row to test the
-- profile-less path specifically.
-- ============================================================
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '<INACTIVE_OR_NONEXISTENT_PROFILE_ID>', true);

SELECT
  is_current_user_active() AS should_be_false,
  is_business_admin() AS should_be_false2,
  current_user_role() AS should_be_null,
  current_user_region_id() AS should_be_null2,
  region_allowed(NULL) AS should_be_false3,
  has_permission('employees.view') AS should_be_false4;
ROLLBACK;
-- expected: false, false, NULL, NULL, false, false
-- ============================================================
