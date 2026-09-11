-- ============================================================
-- READ-ONLY VERIFICATION: terminal_dues workflow-column protection
-- (release-blocking fix, PR #36 audit -- status/approval/payment/return
-- metadata forgeable via direct client INSERT/UPDATE, bypassing the
-- approve/pay/return RPCs and the authoritative audit trail)
-- ============================================================
-- Every query below is SELECT-only except the BEGIN/ROLLBACK simulation
-- blocks, which roll back unconditionally -- nothing here writes
-- persistent data. Safe to run on staging or production at any time.
--
-- BACKGROUND: 20260905000000's new INSERT/UPDATE policies require
-- has_explicit_permission('terminal_dues.create'/'.edit') and (for
-- UPDATE) status='pending', but neither said anything about `status`
-- itself on INSERT, nor about approved_by/approved_at/paid_by/paid_at/
-- payment_date/payment_method/payment_reference/payment_notes (and, after
-- 20260907000000, returned_by/returned_by_name/returned_at/
-- return_reason) on either INSERT or UPDATE. An HR caller
-- (terminal_dues.create/.edit only) could therefore INSERT a row already
-- status='approved'/'paid', or UPDATE a Pending row to forge approval/
-- payment/return metadata while status stayed 'pending' -- a complete
-- bypass of Admin approval, Accountant payment recording, and the
-- audit_logs trail. Fixed by protect_terminal_dues_workflow_columns(), a
-- BEFORE INSERT OR UPDATE trigger (20260905000000 PART 6, extended in
-- 20260907000000) that rejects any direct `authenticated`-role write
-- touching these columns, while letting a true super admin and the 3
-- SECURITY DEFINER transition RPCs through unchanged.
-- ============================================================

-- 1. Confirm the trigger function and trigger exist with the expected
--    shape.
SELECT p.proname, p.prosecdef AS is_security_definer
FROM pg_proc p WHERE p.proname = 'protect_terminal_dues_workflow_columns';
-- expected: 1 row, is_security_definer = false (deliberately SECURITY
-- INVOKER -- see the function's own header comment for why).

SELECT tgname, tgenabled, tgtype
FROM pg_trigger
WHERE tgrelid = 'terminal_dues'::regclass
  AND tgname = 'trigger_protect_terminal_dues_workflow_columns';
-- expected: 1 row, tgenabled = 'O' (enabled). tgtype bit flags encode
-- BEFORE INSERT OR UPDATE FOR EACH ROW.

-- 2. Confirm the function body covers all 12 protected columns (8 from
--    20260905000000 + 4 from 20260907000000) plus status.
SELECT
  pg_get_functiondef('protect_terminal_dues_workflow_columns()'::regprocedure) LIKE '%NEW.status IS DISTINCT FROM%' AS covers_status,
  pg_get_functiondef('protect_terminal_dues_workflow_columns()'::regprocedure) LIKE '%NEW.approved_by%' AS covers_approved_by,
  pg_get_functiondef('protect_terminal_dues_workflow_columns()'::regprocedure) LIKE '%NEW.paid_by%' AS covers_paid_by,
  pg_get_functiondef('protect_terminal_dues_workflow_columns()'::regprocedure) LIKE '%NEW.payment_reference%' AS covers_payment_reference,
  pg_get_functiondef('protect_terminal_dues_workflow_columns()'::regprocedure) LIKE '%NEW.returned_by%' AS covers_returned_by,
  pg_get_functiondef('protect_terminal_dues_workflow_columns()'::regprocedure) LIKE '%NEW.return_reason%' AS covers_return_reason,
  pg_get_functiondef('protect_terminal_dues_workflow_columns()'::regprocedure) LIKE '%is_super_admin()%' AS has_super_admin_bypass,
  pg_get_functiondef('protect_terminal_dues_workflow_columns()'::regprocedure) LIKE '%current_user <> ''authenticated''%' AS has_rpc_bypass;
-- expected: all 8 = true.

-- 3. INSERT policy now also requires status='pending' (defense-in-depth
--    layer on top of the trigger).
SELECT policyname, with_check
FROM pg_policies
WHERE tablename = 'terminal_dues' AND cmd = 'INSERT';
-- expected: with_check contains "status = 'pending'::text".

-- ============================================================
-- LIVE SIMULATION -- requires a real HR Manager profile id
-- (terminal_dues.create + .edit, no .approve/.pay), a real Admin profile
-- id (terminal_dues.approve), a real Accountant profile id
-- (terminal_dues.pay), a real super-admin profile id, and a real employee
-- id in the HR Manager's own tenant+region. Every block is wrapped in
-- BEGIN/ROLLBACK; nothing persists.
-- ============================================================

-- 4. HR direct INSERT with status='approved' -- MUST RAISE.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<HR_MANAGER_PROFILE_ID>', true);
-- INSERT INTO terminal_dues (tenant_id, employee_id, status, total_payable)
--   VALUES ('<HR_MANAGER_TENANT_ID>', '<EMPLOYEE_ID>', 'approved', 500000);
-- -- expected: RAISES 'A new terminal due must be created as pending...'
-- ROLLBACK;

-- 5. HR direct INSERT with status='paid' + fake payment fields -- MUST RAISE.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<HR_MANAGER_PROFILE_ID>', true);
-- INSERT INTO terminal_dues (tenant_id, employee_id, status, total_payable, paid_by, payment_reference)
--   VALUES ('<HR_MANAGER_TENANT_ID>', '<EMPLOYEE_ID>', 'paid', 500000, '<HR_MANAGER_PROFILE_ID>', 'FORGED');
-- -- expected: RAISES
-- ROLLBACK;

-- 6. HR direct UPDATE forging approved_by/paid_by/payment_* on an
--    existing Pending row -- MUST RAISE, and the row must remain
--    unchanged.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT status, approved_by, paid_by FROM terminal_dues WHERE id = '<EXISTING_PENDING_ROW_ID>'; -- BEFORE
-- SELECT set_config('request.jwt.claim.sub', '<HR_MANAGER_PROFILE_ID>', true);
-- UPDATE terminal_dues SET approved_by = '<HR_MANAGER_PROFILE_ID>', approved_at = NOW()
--   WHERE id = '<EXISTING_PENDING_ROW_ID>';
-- -- expected: RAISES
-- ROLLBACK;

-- 7. Legitimate HR create/edit still work (control group -- must NOT be
--    broken by this fix).
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<HR_MANAGER_PROFILE_ID>', true);
-- INSERT INTO terminal_dues (tenant_id, employee_id, employee_name, employee_number, total_payable)
--   VALUES ('<HR_MANAGER_TENANT_ID>', '<EMPLOYEE_ID_WITH_NO_OPEN_DUE>', 'Test', 'E-TEST', 65000)
--   RETURNING id, status;
-- -- expected: succeeds, status = 'pending'
-- ROLLBACK;

-- 8. The 3 RPCs still work end to end, and an Admin-returned Pending row
--    remains editable by HR afterward with its return metadata intact.
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<ADMIN_PROFILE_ID>', true);
-- SELECT approve_terminal_due('<EXISTING_PENDING_ROW_ID>');
-- SELECT return_terminal_due_for_correction('<EXISTING_PENDING_ROW_ID>', 'Please recalculate');
-- SELECT set_config('request.jwt.claim.sub', '<HR_MANAGER_PROFILE_ID>', true);
-- UPDATE terminal_dues SET deductions = 1000, updated_at = NOW() WHERE id = '<EXISTING_PENDING_ROW_ID>';
-- SELECT status, returned_by, return_reason, deductions FROM terminal_dues WHERE id = '<EXISTING_PENDING_ROW_ID>';
-- -- expected: the RPC calls succeed; the final HR UPDATE succeeds; the
-- -- SELECT shows status='pending', returned_by/return_reason still set
-- -- from the return above, and deductions=1000.
-- ROLLBACK;

-- 9. Super admin direct UPDATE of status/approved_by -- MUST still
--    succeed (documented emergency bypass, unchanged).
-- BEGIN;
-- SET LOCAL ROLE authenticated;
-- SELECT set_config('request.jwt.claim.sub', '<SUPER_ADMIN_PROFILE_ID>', true);
-- UPDATE terminal_dues SET status = 'approved', approved_by = '<SUPER_ADMIN_PROFILE_ID>', approved_at = NOW()
--   WHERE id = '<EXISTING_PENDING_ROW_ID>'
--   RETURNING id, status, approved_by;
-- -- expected: succeeds
-- ROLLBACK;
-- ============================================================
