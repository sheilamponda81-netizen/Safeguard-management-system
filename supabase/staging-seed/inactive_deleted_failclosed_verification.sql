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
-- Matched against the specific executable phrase (not just any mention of
-- "v_role_level IS NOT NULL" -- the function's own header comment quotes
-- that exact old rule for documentation purposes, so a bare substring
-- match against the whole body would false-positive on the comment).
SELECT
  pg_get_functiondef('get_payroll_attendance_counts(uuid[],text)'::regprocedure) LIKE '%OR v_role_level <= 2 OR has_permission(''payroll.view'')%' AS has_legacy_le2_rule,
  pg_get_functiondef('get_payroll_attendance_counts(uuid[],text)'::regprocedure) LIKE '%OR v_role_level IS NOT NULL OR has_permission%' AS still_has_old_blanket_rule;
-- expected: has_legacy_le2_rule = true, still_has_old_blanket_rule = false

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
