-- ============================================================
-- READ-ONLY VERIFICATION SQL
-- Run AFTER applying 20260905000000_terminal_dues_separation_of_duties.sql
-- to STAGING. Every statement here is read-only (SELECT only) -- nothing
-- here writes to the database.
-- ============================================================

-- 1. The 8 new columns exist on terminal_dues.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'terminal_dues'
  AND column_name IN ('approved_by','approved_at','paid_by','paid_at',
                       'payment_date','payment_method','payment_reference','payment_notes')
ORDER BY column_name;
-- EXPECTED: 8 rows. All is_nullable = 'YES'. approved_by/paid_by = uuid,
-- approved_at/paid_at = timestamp with time zone, payment_date = date,
-- payment_method/payment_reference/payment_notes = text.

-- 2. The 3 new RPC signatures exist, with SECURITY DEFINER set.
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  p.prosecdef AS is_security_definer
FROM pg_proc p
WHERE p.proname IN ('approve_terminal_due','record_terminal_due_payment','return_terminal_due_for_correction','has_explicit_permission')
ORDER BY p.proname;
-- EXPECTED: 4 rows, all is_security_definer = true.
--   approve_terminal_due               | p_terminal_due_id uuid
--   has_explicit_permission            | p_permission text
--   record_terminal_due_payment        | p_terminal_due_id uuid, p_payment_date date, p_payment_method text, p_payment_reference text, p_notes text DEFAULT NULL::text
--   return_terminal_due_for_correction | p_terminal_due_id uuid, p_reason text

-- 3. search_path config for all 4 new functions (and the helpers they call).
SELECT p.proname,
       COALESCE((SELECT string_agg(cfg, ', ') FROM unnest(p.proconfig) AS cfg WHERE cfg LIKE 'search_path=%'), '(none set)') AS search_path_config
FROM pg_proc p
WHERE p.proname IN (
  'approve_terminal_due','record_terminal_due_payment','return_terminal_due_for_correction',
  'has_explicit_permission','has_permission','is_current_user_active','current_user_role',
  'get_current_tenant_id','is_super_admin','current_user_role_level','is_business_admin','region_allowed'
)
ORDER BY p.proname;
-- EXPECTED: all 12 rows show "search_path=public, pg_temp" -- none show "(none set)".

-- 4. PUBLIC / anon / authenticated EXECUTE privilege on all 4 new functions.
SELECT
  p.proname,
  has_function_privilege('public', p.oid, 'EXECUTE')        AS public_can_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE')           AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE')  AS authenticated_can_execute
FROM pg_proc p
WHERE p.proname IN ('approve_terminal_due','record_terminal_due_payment','return_terminal_due_for_correction','has_explicit_permission')
ORDER BY p.proname;
-- EXPECTED: public_can_execute = false, anon_can_execute = false,
-- authenticated_can_execute = true, for all 4 rows.

-- 5. Schema-privilege trust-boundary check (search_path hijack surface).
SELECT
  has_schema_privilege('authenticated', 'public', 'CREATE') AS authenticated_can_create_in_public,
  has_schema_privilege('anon', 'public', 'CREATE') AS anon_can_create_in_public;
-- EXPECTED: both false. If either is true, a search_path=public,pg_temp
-- SECURITY DEFINER function is at risk of a shadow-object hijack -- stop
-- and escalate before relying on this migration's search_path safety.

-- 6. role_permissions matrix for terminal_dues -- HR Manager / Admin / Accountant.
SELECT role, permission FROM role_permissions WHERE permission LIKE 'terminal_dues.%' ORDER BY role, permission;
-- EXPECTED exactly these 7 rows, no more, no less:
--   accountant   | terminal_dues.pay
--   accountant   | terminal_dues.view
--   admin        | terminal_dues.approve
--   admin        | terminal_dues.view
--   hr_manager   | terminal_dues.create
--   hr_manager   | terminal_dues.edit
--   hr_manager   | terminal_dues.view

-- 7. terminal_dues.process retired as intended.
SELECT COUNT(*) AS process_rows_remaining
FROM role_permissions WHERE permission = 'terminal_dues.process';
-- EXPECTED: 0.

-- 8. The active UPDATE RLS policy on terminal_dues (should be exactly one,
-- with the new name and the 'pending'-locked USING/WITH CHECK clauses).
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'terminal_dues' AND cmd = 'UPDATE';
-- EXPECTED: exactly 1 row, policyname = 'Terminal dues: edit Pending
-- calculation only, status via RPC'. Both qual and with_check must each
-- contain the substring "status = 'pending'::text" -- if either clause is
-- missing that substring, a direct client UPDATE can still change status
-- and this migration did not apply cleanly.

-- 9. Existing Pending/Approved/Paid row counts are unchanged by this
-- migration (it only ADDS columns/rows -- it must never touch existing
-- terminal_dues data). Run this query BEFORE applying the migration too,
-- and diff the two results -- they must be identical.
SELECT status, COUNT(*) FROM terminal_dues GROUP BY status ORDER BY status;
-- EXPECTED: identical to the same query's result taken immediately before
-- this migration was applied. This migration contains no UPDATE/DELETE
-- against existing terminal_dues rows, so any difference here indicates
-- something OTHER than this migration changed data concurrently --
-- investigate before proceeding.
