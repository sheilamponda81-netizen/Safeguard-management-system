-- ============================================================
-- MIGRATION: Atomic, concurrency-safe payroll batch processing RPC
-- Date: 2026-08-03
-- ============================================================
--
-- PROBLEM (documented in DATA_INTEGRITY_REVIEW.md / AUDIT_REPORT.md
-- Finding A8): Payroll.tsx's processPayroll() and copyFromPreviousMonth()
-- both perform a client-side DELETE followed by a separate client-side
-- INSERT -- two independent network round-trips, not one transaction.
-- If the INSERT fails after the DELETE already succeeded (dropped
-- connection, a single row failing a constraint, the browser tab
-- closing), that month's payroll for the affected employees is left
-- fully deleted with nothing re-inserted -- silent, real data loss.
-- Additionally: nothing today stops two concurrent processing attempts
-- for the same tenant+month from interleaving, and nothing stops
-- reprocessing a month that already has approved rows, silently
-- reverting them to 'pending' and losing who-approved-it/when.
--
-- DESIGN: this function deliberately does NOT recompute gross/net/PAYE/
-- pension/deductions itself -- that calculation logic (calculatePayroll /
-- calculateLivePayroll) stays exactly where it is, in TypeScript, per
-- rule 9 (never change payroll/tax/pension rules without a documented,
-- confirmed source). This RPC only takes over the MECHANICAL, purely
-- structural part: validating before any destructive change, making the
-- delete+insert one atomic transaction, serializing concurrent attempts,
-- and writing the audit log entry in the same transaction as the data
-- change it describes (rather than as a separate client-side call after
-- the fact, which today could be skipped entirely if the tab closes
-- between the insert succeeding and the audit call firing).
--
-- Both processPayroll() and copyFromPreviousMonth() can call this same
-- function -- the only difference between them is how the JS-side
-- computes p_records before calling it (fresh calculation from current
-- attendance vs. copied-forward from a source month's manually-entered
-- values); the safe-persistence mechanics below are identical either way.
--
-- ================= NOT WIRED UP TO THE FRONTEND YET =================
-- Payroll.tsx is NOT changed by this migration to call this function.
-- That is a deliberate, separate follow-up step: if the frontend were
-- changed to call supabase.rpc('process_payroll_batch', ...) in the same
-- deploy as this migration, and this migration reaches production before
-- (or without) actually being applied to the production database,
-- payroll processing would break outright (RPC not found) -- worse than
-- today's imperfect-but-working delete-then-insert. The correct rollout
-- order is: (1) apply this migration to staging, verify it thoroughly
-- (see the test matrix below), (2) apply to production, verify there
-- too, (3) only then, as its own reviewed change, update Payroll.tsx to
-- call this RPC instead of its current two-step delete+insert.
-- ============================================================

CREATE OR REPLACE FUNCTION process_payroll_batch(
  p_month TEXT,
  p_records JSONB,       -- array of {employee_id, basic_salary, allowances, overtime, bonus, gross_pay, paye, pension, uniform_deduction, net_pay}
  p_user_email TEXT DEFAULT NULL,  -- pass the caller's own auth.users.email from the client (supabase.auth.getUser()), same as the existing logAudit() helper already does -- avoids this function needing cross-schema read access to auth.users itself
  p_audit_context JSONB DEFAULT '{}'::JSONB  -- caller-supplied extra context for the audit log entry (e.g. sourceMonth for copy-forward, totals, employeeCount)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_role_level INTEGER;
  v_is_super_admin BOOLEAN;
  v_employee_ids UUID[];
  v_foreign_employee_count INTEGER;
  v_approved_count INTEGER;
  v_inserted_count INTEGER;
  v_deleted_count INTEGER;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- ============================================================
  -- STEP 1: Resolve the caller's own tenant/role from `profiles`.
  -- Never trust a tenant_id/role passed as a parameter -- this function
  -- runs SECURITY DEFINER, which BYPASSES row-level security entirely,
  -- so it must enforce every authorization check itself rather than
  -- relying on RLS the way a normal client-side query would.
  -- ============================================================
  SELECT tenant_id, role_level, is_super_admin
    INTO v_tenant_id, v_role_level, v_is_super_admin
  FROM profiles
  WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (v_is_super_admin OR v_role_level = 1) THEN
    RAISE EXCEPTION 'Only Admins or super admins may process payroll';
  END IF;

  IF p_records IS NULL OR jsonb_array_length(p_records) = 0 THEN
    RAISE EXCEPTION 'No payroll records supplied';
  END IF;

  v_employee_ids := ARRAY(
    SELECT (r->>'employee_id')::UUID
    FROM jsonb_array_elements(p_records) AS r
  );

  -- ============================================================
  -- STEP 2: Concurrency control. Serializes any other call to this
  -- function for the SAME tenant+month -- a second concurrent caller
  -- blocks here until the first transaction commits or rolls back, then
  -- proceeds against the now-current state (so its own validation in
  -- step 3 sees whatever the first call actually left behind). Scoped to
  -- this transaction (`_xact_`) so the lock releases automatically on
  -- COMMIT or ROLLBACK, with no separate unlock call to forget.
  -- ============================================================
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || p_month));

  -- ============================================================
  -- STEP 3: Validate BEFORE any destructive change.
  -- ============================================================

  -- 3a. Every targeted employee must actually belong to the caller's own
  -- tenant -- defense in depth against a caller passing employee_ids
  -- from a different tenant, which (since this function bypasses RLS)
  -- would otherwise let it write cross-tenant payroll rows.
  SELECT COUNT(*) INTO v_foreign_employee_count
  FROM unnest(v_employee_ids) AS eid
  WHERE NOT EXISTS (
    SELECT 1 FROM employees e WHERE e.id = eid AND e.tenant_id = v_tenant_id
  );

  IF v_foreign_employee_count > 0 THEN
    RAISE EXCEPTION 'Refusing to process: % of the supplied employee(s) do not belong to your tenant', v_foreign_employee_count;
  END IF;

  -- 3b. Refuse to touch a month that already has an approved row for any
  -- of the targeted employees. Reprocessing must never silently revert
  -- an approval to pending -- that has to go through an explicit
  -- reject/un-approve step first (the existing approvePayroll flow),
  -- not be an accidental side effect of reprocessing.
  SELECT COUNT(*) INTO v_approved_count
  FROM payroll
  WHERE month = p_month
    AND tenant_id = v_tenant_id
    AND employee_id = ANY(v_employee_ids)
    AND approval_status = 'approved';

  IF v_approved_count > 0 THEN
    RAISE EXCEPTION 'Cannot reprocess %: % of the targeted employees already have approved payroll for this month. Reject the existing approval first.', p_month, v_approved_count;
  END IF;

  -- ============================================================
  -- STEP 4: Delete + insert, both inside this same function call --
  -- which Postgres already runs as a single transaction. If anything
  -- below raises (a constraint violation, a bad value), EVERYTHING in
  -- this function -- including the delete -- rolls back automatically.
  -- No explicit BEGIN/COMMIT needed or wanted here.
  -- ============================================================

  DELETE FROM payroll
  WHERE month = p_month
    AND tenant_id = v_tenant_id
    AND employee_id = ANY(v_employee_ids);
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  -- Single INSERT...SELECT statement -- atomic by construction: either
  -- every row in p_records is inserted, or (on any single row failing a
  -- constraint, e.g. a bad UUID or a NOT NULL violation) none are, and
  -- the exception propagates to roll back the whole transaction,
  -- including the DELETE above. There is no partial-insert state
  -- possible here, unlike looping insert-per-row in application code.
  INSERT INTO payroll (
    tenant_id, employee_id, month, basic_salary, allowances, overtime, bonus,
    gross_pay, paye, pension, uniform_deduction, net_pay, processed_at,
    approval_status, approved_by, approved_at, approval_notes, updated_at
  )
  SELECT
    v_tenant_id,
    (r->>'employee_id')::UUID,
    p_month,
    (r->>'basic_salary')::NUMERIC,
    COALESCE((r->>'allowances')::NUMERIC, 0),
    COALESCE((r->>'overtime')::NUMERIC, 0),
    COALESCE((r->>'bonus')::NUMERIC, 0),
    (r->>'gross_pay')::NUMERIC,
    COALESCE((r->>'paye')::NUMERIC, 0),
    COALESCE((r->>'pension')::NUMERIC, 0),
    COALESCE((r->>'uniform_deduction')::NUMERIC, 0),
    (r->>'net_pay')::NUMERIC,
    NOW(),
    'pending',
    NULL,
    NULL,
    NULL,
    NOW()
  FROM jsonb_array_elements(p_records) AS r;
  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  -- ============================================================
  -- STEP 5: Audit log, in the SAME transaction as the data change it
  -- describes. If the insert above had failed, execution never reaches
  -- here, so there is no orphaned audit entry describing a write that
  -- didn't actually happen -- unlike today's separate client-side
  -- logAudit() call, which fires (or doesn't) independently of whether
  -- the payroll write actually succeeded.
  -- ============================================================
  INSERT INTO audit_logs (
    tenant_id, user_id, user_email, user_role, region_id,
    action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    v_tenant_id,
    v_caller_id,
    p_user_email,
    CASE WHEN v_is_super_admin THEN 'super_admin' ELSE 'admin' END,
    NULL,
    'CREATE',
    'payroll',
    NULL,
    jsonb_build_object('deletedCount', v_deleted_count),
    p_audit_context || jsonb_build_object(
      'month', p_month,
      'employeeCount', array_length(v_employee_ids, 1),
      'recordsSaved', v_inserted_count,
      'status', 'pending_approval'
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'month', p_month,
    'deletedCount', v_deleted_count,
    'insertedCount', v_inserted_count
  );
END;
$$;

-- Only Admins/super admins should even be able to attempt this (the
-- function enforces that itself in STEP 1, but revoking broad EXECUTE
-- and granting only to `authenticated` is defense in depth -- anonymous
-- callers can't reach it at all).
REVOKE ALL ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) TO authenticated;

-- ============================================================
-- ROLLBACK SQL (run this to fully revert this migration)
-- ============================================================
-- REVOKE EXECUTE ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM authenticated;
-- DROP FUNCTION IF EXISTS process_payroll_batch(TEXT, JSONB, TEXT, JSONB);
--
-- This is safe to roll back at any time: the frontend does not call this
-- function yet (see the note above), so dropping it has no effect on
-- any currently-running code path.

-- ============================================================
-- STAGING TEST PROCEDURE (run all of this against a STAGING project only)
-- ============================================================
-- Prerequisite: a staging Supabase project with this schema applied,
-- plus 20260803000000_role_level_rls_hardening.sql and
-- 20260803000001_payroll_unique_constraint.sql already applied (this
-- function assumes the unique constraint exists to fully close the
-- duplicate-row risk end to end, though it is not strictly required for
-- this function's own atomicity guarantees).
--
-- Test as an Admin-role_level user (call via supabase-js with that
-- user's session, or via `select process_payroll_batch(...)` in the SQL
-- editor after `set role authenticated; set request.jwt.claims = ...` to
-- simulate that user's auth.uid()):
--
-- 1. Happy path: call with 2-3 valid employee_id/records for a month
--    with no existing payroll. Expect: success, N rows inserted, 1
--    audit_logs row, 0 rows deleted.
-- 2. Reprocess same month: call again with different values for the
--    same employees. Expect: success, old rows gone, new rows present,
--    deletedCount = N from step 1.
-- 3. Approved-month protection: manually UPDATE one of the rows from
--    step 2 to approval_status = 'approved', then call again for the
--    same employees. Expect: the whole call raises an exception and
--    NOTHING changes -- re-select the payroll rows afterward and confirm
--    they are byte-for-byte identical to before the failed call,
--    including the approved row.
-- 4. Concurrency: open two separate `psql`/SQL-editor sessions, wrap
--    each call in `BEGIN;` (don't commit yet), call this function from
--    session A, then attempt to call it from session B before A commits
--    or rolls back -- session B should visibly block/wait. COMMIT
--    session A, confirm session B then proceeds and completes normally
--    against A's post-commit state.
-- 5. Partial-failure simulation: call with p_records containing one
--    row with an invalid employee_id (a UUID that doesn't exist in
--    `employees`, or belongs to a different tenant) mixed with otherwise
--    valid rows. Expect: the whole call fails (either the tenant-mismatch
--    check in step 3a, or a foreign-key violation on insert), and
--    re-selecting payroll for that month afterward shows the PRE-call
--    state fully intact -- no partial subset of the batch was inserted,
--    and nothing was deleted.
-- 6. Cross-tenant isolation: call with an employee_id that belongs to a
--    genuinely different tenant (needs a second tenant/company seeded in
--    the same staging project). Expect: exception from step 3a, nothing
--    written.
-- 7. Authorization: call this function authenticated as a Manager/
--    Supervisor/Staff-role_level user. Expect: exception from step 1,
--    nothing written.
-- 8. Audit log correctness: after a successful call, confirm exactly one
--    new audit_logs row exists with action='CREATE', entity_type=
--    'payroll', and new_data containing the month/employeeCount/
--    recordsSaved/status fields plus whatever was passed in
--    p_audit_context.
-- ============================================================
