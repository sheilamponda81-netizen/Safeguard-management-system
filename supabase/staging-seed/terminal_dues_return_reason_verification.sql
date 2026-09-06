-- ============================================================
-- READ-ONLY VERIFICATION: Terminal Dues return-reason visibility
-- (20260907000000_terminal_dues_return_reason_visibility.sql)
-- ============================================================
-- Every query below is read-only (SELECT only). Safe to run on staging
-- at any time, before or after applying the migration.
-- ============================================================

-- 1. The 4 new columns exist on terminal_dues, all nullable.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'terminal_dues'
  AND column_name IN ('returned_by', 'returned_by_name', 'returned_at', 'return_reason')
ORDER BY column_name;
-- expected: 4 rows
--   return_reason     | text                     | YES
--   returned_at       | timestamp with time zone | YES
--   returned_by       | uuid                     | YES
--   returned_by_name  | text                     | YES

-- 2. return_terminal_due_for_correction() now sets all 4 new columns
--    (not just writing to audit_logs).
SELECT pg_get_functiondef('return_terminal_due_for_correction(uuid,text)'::regprocedure) LIKE '%returned_by_name = v_caller_name%' AS sets_returned_by_name,
       pg_get_functiondef('return_terminal_due_for_correction(uuid,text)'::regprocedure) LIKE '%return_reason = p_reason%' AS sets_return_reason;
-- expected: both true

-- 3. approve_terminal_due() clears all 4 columns on re-approval.
SELECT pg_get_functiondef('approve_terminal_due(uuid)'::regprocedure) LIKE '%returned_by_name = NULL%' AS clears_returned_by_name,
       pg_get_functiondef('approve_terminal_due(uuid)'::regprocedure) LIKE '%return_reason = NULL%' AS clears_return_reason;
-- expected: both true

-- 4. Sanity check: no existing row has these fields set except a
--    currently-Pending row that was genuinely returned (should be 0 rows
--    immediately after applying, since the columns are brand new and
--    default NULL on every existing row).
SELECT id, employee_name, status, returned_by_name, return_reason
FROM terminal_dues
WHERE return_reason IS NOT NULL;
-- expected immediately after applying: 0 rows

-- 5. Sanity check: no currently-Approved or currently-Paid row has a
--    stale return_reason (would indicate the approve_terminal_due()
--    clear did not run, or a row was hand-edited outside the RPCs).
SELECT id, employee_name, status, return_reason
FROM terminal_dues
WHERE status IN ('approved', 'paid') AND return_reason IS NOT NULL;
-- expected: 0 rows, always
-- ============================================================
