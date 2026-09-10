-- ============================================================
-- READ-ONLY VERIFICATION: approve_payroll_run() NULL-propagation
-- authorization-bypass fix (security reconciliation, PR #36 audit)
-- ============================================================
-- Every query below is SELECT-only except the BEGIN/ROLLBACK simulation
-- blocks, which roll back unconditionally -- nothing here writes
-- persistent data. Safe to run on staging or production at any time.
--
-- BACKGROUND: approve_payroll_run() (live body in
-- 20260831010000_payroll_approval_rpc_search_path_fix.sql) gated
-- approval/rejection with `IF NOT (v_is_super OR v_role_level = 1) THEN`.
-- v_role_level is NULL for every functional-role account (hr_manager/
-- accountant/operations_manager/functional admin, by design). A bare
-- `v_role_level = 1` comparison against NULL evaluates to SQL NULL, and
-- `false OR NULL` is NULL, so `NOT NULL` is NULL -- PL/pgSQL treats a NULL
-- IF condition the same as false, silently skipping the RAISE EXCEPTION.
-- Unlike get_payroll_attendance_counts() (fixed separately, same class of
-- bug), this gate has no third has_permission(...) branch: it is the
-- ONLY check standing between an unauthorized caller and the UPDATE
-- below, whose own WHERE clause checks tenant/region for a non-super
-- caller but never re-checks role/permission. Empirically reproduced
-- against the exact production function body: a functional Accountant
-- (role_level NULL, own tenant+region, not super-admin) successfully
-- called this RPC and it actually approved a real payroll row. Fixed by
-- wrapping both operands in COALESCE(..., false).
-- ============================================================

-- 1. Confirm the live function body contains the NULL-safe form and does
--    NOT contain the old unsafe bare form. Matched against the specific
--    executable phrase -- the function's own header comment quotes the
--    old rule for documentation purposes, so a bare substring match
--    against the whole body would false-positive on the comment.
SELECT
  pg_get_functiondef('approve_payroll_run(text,text,text,uuid[])'::regprocedure) LIKE '%COALESCE(v_is_super, false)%' AS has_null_safe_super_check,
  pg_get_functiondef('approve_payroll_run(text,text,text,uuid[])'::regprocedure) LIKE '%COALESCE(v_role_level = 1, false)%' AS has_null_safe_role_level_check,
  pg_get_functiondef('approve_payroll_run(text,text,text,uuid[])'::regprocedure) LIKE '%IF NOT (v_is_super OR v_role_level = 1) THEN%' AS still_has_unsafe_bare_rule;
-- expected: has_null_safe_super_check = true, has_null_safe_role_level_check
-- = true, still_has_unsafe_bare_rule = false

-- 2. ACL / SECURITY DEFINER / search_path -- confirm the intended
--    production shape is unchanged by this fix.
SELECT
  p.prosecdef AS is_security_definer,
  COALESCE((SELECT string_agg(cfg, ', ') FROM unnest(p.proconfig) AS cfg WHERE cfg LIKE 'search_path=%'), '(none set)') AS search_path_config,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute
FROM pg_proc p
WHERE p.oid = 'approve_payroll_run(text,text,text,uuid[])'::regprocedure;
-- expected: is_security_definer = true, search_path_config = "search_path="
-- (empty string, unchanged from before this fix -- this fix does not
-- touch search_path), authenticated_can_execute = true, anon/public = false

-- ============================================================
-- LIVE SIMULATION -- items 1-14 of the PR #36 audit's required coverage.
-- Requires real profile/payroll/employee ids matching the roles below.
-- Every block is wrapped in BEGIN/ROLLBACK; nothing persists. Substitute
-- the placeholder ids with real staging rows before running. Each block
-- is independent and can be run/skipped individually.
-- ============================================================

-- --- 1/2/3/4. Functional-role callers (Accountant / HR Manager /
--     Operations Manager / functional Admin -- all role_level = NULL,
--     not super-admin) must all RAISE 42501, and the target payroll row's
--     approval_status/approved_by must remain exactly as it was before
--     the call (proving the UPDATE never ran, not merely that an error
--     was raised after a partial write -- this function's all-or-nothing
--     design should make that impossible, but this asserts it directly).
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT approval_status, approved_by, updated_at FROM payroll WHERE id = '<TARGET_PAYROLL_ID>'; -- record BEFORE state
-- SELECT set_config('request.jwt.claim.sub', '<FUNCTIONAL_ACCOUNTANT_OR_HR_OR_OPS_OR_ADMIN_PROFILE_ID>', true);
-- SELECT approve_payroll_run('<MONTH>', 'approved', 'test', ARRAY['<TARGET_PAYROLL_ID>']::uuid[]);
-- -- expected: RAISES 42501 'Only managers and admins can approve payroll'
-- SELECT approval_status, approved_by, updated_at FROM payroll WHERE id = '<TARGET_PAYROLL_ID>'; -- must be IDENTICAL to BEFORE state
-- ROLLBACK;
-- Repeat this block once per role: a functional Accountant profile, a
-- functional HR Manager profile, a functional Operations Manager profile,
-- and a functional Admin profile (role = 'admin', role_level = NULL,
-- is_super_admin = false) -- all four must RAISE. The functional-Admin
-- case in particular confirms this RPC's intended authorization model is
-- specifically "legacy role_level = 1 or super-admin", NOT "any Admin,
-- legacy or functional" -- this fix must not widen that.

-- --- 5. Legacy role_level = 1, valid tenant/region scope -- MUST SUCCEED.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<LEGACY_ROLE_LEVEL_1_PROFILE_ID_WITH_REGION>', true);
-- SELECT approve_payroll_run('<MONTH>', 'approved', 'test', ARRAY['<PAYROLL_ID_IN_CALLERS_TENANT_AND_REGION>']::uuid[]);
-- -- expected: returns 1 (row count updated), no exception
-- SELECT approval_status, approved_by FROM payroll WHERE id = '<SAME_PAYROLL_ID>';
-- -- expected: approval_status = 'approved', approved_by = the caller's id
-- ROLLBACK;

-- --- 6. Legacy role_level = 2 -- MUST RAISE (only role_level = 1 or
--     super-admin is authorized; this threshold is deliberately NOT <= 2
--     for this RPC, unlike get_payroll_attendance_counts()'s payroll.view
--     threshold -- approval is stricter than viewing).
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<LEGACY_ROLE_LEVEL_2_PROFILE_ID>', true);
-- SELECT approve_payroll_run('<MONTH>', 'approved', 'test', ARRAY['<ANY_PAYROLL_ID>']::uuid[]);
-- -- expected: RAISES 42501
-- ROLLBACK;

-- --- 7. Super-admin -- MUST SUCCEED for an otherwise-valid target row,
--     including a row outside the super-admin's own tenant (matches the
--     unconditional `v_is_super` bypass in the UPDATE's WHERE clause).
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<SUPER_ADMIN_PROFILE_ID>', true);
-- SELECT approve_payroll_run('<MONTH>', 'approved', 'test', ARRAY['<ANY_VALID_PAYROLL_ID_ANY_TENANT>']::uuid[]);
-- -- expected: returns 1, no exception
-- ROLLBACK;

-- --- 8. Inactive caller (otherwise role_level = 1 or super-admin) --
--     MUST RAISE 'Your account is disabled' (this check runs BEFORE the
--     role_level gate and is unaffected by this fix).
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<INACTIVE_ADMIN_PROFILE_ID>', true);
-- SELECT approve_payroll_run('<MONTH>', 'approved', 'test', ARRAY['<ANY_PAYROLL_ID>']::uuid[]);
-- -- expected: RAISES 'Your account is disabled'
-- ROLLBACK;

-- --- 9. Soft-deleted caller -- MUST RAISE 'Your account is disabled'.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<SOFT_DELETED_ADMIN_PROFILE_ID>', true);
-- SELECT approve_payroll_run('<MONTH>', 'approved', 'test', ARRAY['<ANY_PAYROLL_ID>']::uuid[]);
-- -- expected: RAISES 'Your account is disabled'
-- ROLLBACK;

-- --- 10. Out-of-region target, non-super caller (role_level = 1, valid
--     tenant, but the target payroll row's employee is in a DIFFERENT
--     region) -- whole operation must fail and update ZERO rows (the
--     all-or-nothing COUNT(DISTINCT) vs ROW_COUNT check, unaffected by
--     this fix, still applies once the role_level gate is correctly
--     passed).
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT approval_status FROM payroll WHERE id = '<OUT_OF_REGION_PAYROLL_ID>'; -- BEFORE
-- SELECT set_config('request.jwt.claim.sub', '<LEGACY_ROLE_LEVEL_1_PROFILE_ID_WITH_REGION>', true);
-- SELECT approve_payroll_run('<MONTH>', 'approved', 'test', ARRAY['<OUT_OF_REGION_PAYROLL_ID>']::uuid[]);
-- -- expected: RAISES 'Payroll approval scope changed; refresh and retry'
-- SELECT approval_status FROM payroll WHERE id = '<OUT_OF_REGION_PAYROLL_ID>'; -- must equal BEFORE
-- ROLLBACK;

-- --- 11. Mixed authorized + unauthorized payroll ids in one call --
--     whole call must fail atomically, zero rows updated.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT approval_status FROM payroll WHERE id IN ('<AUTHORIZED_PAYROLL_ID>', '<UNAUTHORIZED_PAYROLL_ID>'); -- BEFORE
-- SELECT set_config('request.jwt.claim.sub', '<LEGACY_ROLE_LEVEL_1_PROFILE_ID_WITH_REGION>', true);
-- SELECT approve_payroll_run('<MONTH>', 'approved', 'test', ARRAY['<AUTHORIZED_PAYROLL_ID>', '<UNAUTHORIZED_PAYROLL_ID>']::uuid[]);
-- -- expected: RAISES 'Payroll approval scope changed; refresh and retry'
-- SELECT approval_status FROM payroll WHERE id IN ('<AUTHORIZED_PAYROLL_ID>', '<UNAUTHORIZED_PAYROLL_ID>'); -- must equal BEFORE for BOTH rows
-- ROLLBACK;

-- --- 12. NULL / empty / null-element payroll id arrays -- unchanged
--     rejection behavior (these checks run BEFORE the role_level gate and
--     are unaffected by this fix).
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<LEGACY_ROLE_LEVEL_1_PROFILE_ID>', true);
-- SELECT approve_payroll_run('<MONTH>', 'approved', 'test', NULL);              -- expected: RAISES 'No payroll record ids supplied'
-- SELECT approve_payroll_run('<MONTH>', 'approved', 'test', ARRAY[]::uuid[]);   -- expected: RAISES 'No payroll record ids supplied'
-- SELECT approve_payroll_run('<MONTH>', 'approved', 'test', ARRAY['<ANY_PAYROLL_ID>', NULL]::uuid[]); -- expected: RAISES 'Payroll id list contains a null value'
-- ROLLBACK;

-- --- 13. Invalid approval status -- unchanged rejection behavior (runs
--     before the role_level gate).
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<LEGACY_ROLE_LEVEL_1_PROFILE_ID>', true);
-- SELECT approve_payroll_run('<MONTH>', 'pending', 'test', ARRAY['<ANY_PAYROLL_ID>']::uuid[]);
-- -- expected: RAISES 'Invalid approval status: pending'
-- ROLLBACK;
-- ============================================================
