-- ============================================================
-- MIGRATION: Integrate salary advance deductions into process_payroll_batch()
-- Date: 2026-08-13 (revised twice same-day: up-to-2-open-advances pooled
-- allocation, then a single COMBINED repayment plan per employee)
-- ============================================================
--
-- WHY THIS IS ITS OWN MIGRATION, NOT MERGED INTO
-- 20260803000002_payroll_atomic_process_rpc.sql
-- -----------------------------------------------------------
-- That migration is already written, reviewed, and reused verbatim
-- elsewhere (its own STAGING TEST PROCEDURE, e2e coverage, etc.) --
-- editing it in place would mean re-reviewing a file that already has an
-- established, tested identity. `CREATE OR REPLACE FUNCTION` with the
-- SAME signature (TEXT, JSONB, TEXT, JSONB) is the standard, safe way to
-- evolve a Postgres function across migrations -- this file's version
-- becomes the live one the moment it's applied, with no gap where the
-- function doesn't exist.
--
-- WHAT CHANGES, FUNCTIONALLY, VS. THE PRIOR VERSION
-- -----------------------------------------------------------
-- Every existing validation/authorization/concurrency/audit-log behavior
-- from 20260803000002 is preserved BYTE-FOR-BYTE (same auth check, same
-- payload validation, same advisory lock, same tenant-membership check,
-- same approved-month protection, same audit log write). The addition:
-- after validating and immediately before writing each payroll row, this
-- version resolves ALL of the target employee's advances relevant to this
-- month (up to 2, per the max-2-open-advances business rule) and
-- allocates the employee's ONE COMBINED monthly deduction across them,
-- OLDEST ADVANCE FIRST:
--
--   1. "Relevant" means EITHER `status = 'active' AND deduction_start_month
--      <= p_month` (normal eligibility) OR a salary_advance_deductions row
--      for (this advance, p_month) already exists -- the second clause is
--      the fix for a real bug found in review: without it, an advance
--      whose FINAL deduction flips it to 'paid' during this run would be
--      invisible to a later reprocess of the SAME month (which only
--      looks for `status = 'active'`), silently reporting that month's
--      deduction as 0 on reprocess instead of preserving the original
--      amount. Past deductions are immutable financial history regardless
--      of the advance's CURRENT status.
--   2. Ordered `application_date ASC, created_at ASC, id ASC` (oldest
--      advance first, deterministic tie-break) -- the business rule's
--      required allocation order.
--   3. **The combined monthly budget is read from this employee's ONE
--      `salary_advance_repayment_plans` row (`combined_monthly_deduction`)
--      -- corrected from an earlier draft of this migration, which wrongly
--      summed each advance's own independently-configured rate.** A
--      business rule correction made this explicit: with two ACTIVE
--      advances there is ONE combined figure for the employee's total
--      outstanding debt, set by management via approve_salary_advance()
--      (which establishes this plan for the first approved advance and
--      REQUIRES new combined terms to approve a second one onto an
--      existing plan) or, later, adjust_combined_repayment_plan() --
--      never derived by adding the two advances' original rates together,
--      and never influenced by a merely-pending, not-yet-approved
--      application (see 20260813000000's LIFECYCLE SUMMARY). The oldest
--      ACTIVE advance is allocated
--      `LEAST(its own remaining balance, the remaining pool)` first --
--      note this is NO LONGER also capped by that advance's own
--      `configured_monthly_deduction` (that column is now purely
--      historical, see 20260813000000's header) -- whatever pool budget
--      it doesn't use (because it finished paying off that month) carries
--      forward to the next advance in the same month. Worked example from
--      the business rule: pool = 20,000, Advance #1 remaining = 10,000,
--      Advance #2 remaining = 30,000 -> Advance #1 gets 10,000 (finishes),
--      Advance #2 gets the remaining 10,000 of the pool -- total exactly
--      20,000, never more.
--   4. IDEMPOTENCY per advance: if a salary_advance_deductions row for
--      (that advance, p_month) already exists, its stored amount is
--      reused verbatim instead of recomputed -- recomputing against a
--      balance that already reflects this month's own prior deduction
--      would silently compute a smaller, wrong second installment. The
--      UNIQUE(salary_advance_id, payroll_month) constraint from
--      20260813000000 is what makes "does a row already exist" a safe,
--      race-free check within this function's own advisory-locked,
--      single-transaction execution.
--   5. The SUM of both advances' allocations for this employee this month
--      is subtracted from the CLIENT-SUPPLIED net_pay exactly once (never
--      trusts a client-supplied salary_advance_deduction value -- this
--      function recomputes it itself, the same trust boundary every other
--      monetary figure in this function already respects) and stored
--      explicitly in payroll.salary_advance_deduction (the TOTAL across
--      both advances, per the business rule -- individual per-advance
--      splits live in the ledger, not on the payroll row).
--   6. Each advance is marked 'paid' independently, automatically, the
--      moment ITS OWN derived remaining balance reaches zero -- no
--      separate step, no manual status flip required. A second guard
--      trigger in 20260813000000 additionally rejects any attempt to mark
--      an advance 'paid' by direct UPDATE while its balance is nonzero --
--      this RPC's own legitimate transition passes through automatically
--      since it only ever sets 'paid' when the balance IS already zero.
--   7. GLOBAL NET-PAY INVARIANT (confirmed business decision, this pass --
--      supersedes an earlier, narrower "advance-only" version): final
--      net_pay must never be negative for ANY employee, for ANY reason --
--      attendance deductions, employee deductions, salary advances,
--      terminal/other deductions, or any combination. Enforced in TWO
--      places, together forming ONE global rule: (a) STEP 1.5's payload
--      validation now REJECTS a negative client-supplied `net_pay`
--      outright (the earlier carve-out that allowed it -- see
--      20260803000002's own STEP 1.5b -- has been explicitly removed by
--      this confirmed business decision), so `v_base_net_pay` is always
--      >= 0 by the time this loop runs; (b) this section additionally
--      guarantees the SAME invariant survives this function's own salary
--      advance deduction on top of that. If either would produce a
--      negative result, the ENTIRE call RAISES and rolls back -- nothing
--      for ANY employee in this batch is written. Does NOT invent a new
--      "advance <= salary" cap (no silent capping/reduction of any
--      deduction) -- fails loudly and atomically instead.
--   8. PLAN CLEANUP (safety review finding): the moment an employee has NO
--      remaining 'active' advance (their last one just paid off), their
--      `salary_advance_repayment_plans` row is deleted -- a paid-off
--      employee must never keep showing a live combined monthly deduction
--      / expected payoff for debt that no longer exists. Audit history in
--      `salary_advance_repayment_plan_changes` is untouched (no FK to the
--      plan table) and remains permanently. The next advance
--      `approve_salary_advance()`s for this employee finds no existing
--      plan and cleanly establishes a fresh one from scratch.
--
-- The employee-loop below is per-row (not a single set-based
-- INSERT...SELECT) specifically so each row's advance allocation can be
-- resolved individually -- correctness over the marginal performance
-- difference at this table's realistic size (at most 2 advances/employee),
-- matching the same "loop over jsonb_array_elements" style already used
-- for the payload-validation checks in the version this replaces.
-- ============================================================

ALTER TABLE payroll ADD COLUMN IF NOT EXISTS salary_advance_deduction NUMERIC(14,2) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION process_payroll_batch(
  p_month TEXT,
  p_records JSONB,
  p_user_email TEXT DEFAULT NULL,
  p_audit_context JSONB DEFAULT '{}'::JSONB
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
  v_old_rows JSONB;
  -- Salary-advance loop variables
  v_record JSONB;
  v_employee_id UUID;
  v_base_net_pay NUMERIC;
  v_advance_deduction NUMERIC;       -- TOTAL across this employee's (up to 2) advances this month
  v_pool_remaining NUMERIC;          -- this employee's combined monthly budget, decremented as allocated
  v_pool_advance RECORD;             -- cursor var for the oldest-first advance loop
  v_alloc NUMERIC;                   -- this specific advance's allocation this month
  v_remaining_balance NUMERIC;       -- this specific advance's remaining balance before this month
  v_existing_ledger_amount NUMERIC;
  v_advance_deductions_applied INTEGER := 0;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- ============================================================
  -- STEP 1: Resolve the caller's own tenant/role (unchanged).
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

  -- ============================================================
  -- STEP 1.5: Payload validation. `net_pay`'s own check was REVISED in
  -- this pass (confirmed business decision, supersedes the earlier
  -- carve-out documented in 20260803000002's STEP 1.5b): a negative
  -- client-supplied net_pay is no longer accepted, full stop -- see the
  -- GLOBAL NET-PAY INVARIANT note below this function for the complete
  -- rationale. Every other check here is unchanged.
  -- ============================================================
  IF (SELECT COUNT(*) FROM jsonb_array_elements(p_records) AS r) <>
     (SELECT COUNT(DISTINCT r->>'employee_id') FROM jsonb_array_elements(p_records) AS r)
  THEN
    RAISE EXCEPTION 'Refusing to process: the same employee_id appears more than once in this batch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_records) AS r
    WHERE r->>'employee_id' IS NULL
       OR NOT (r->>'employee_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
       OR r->>'basic_salary' IS NULL OR NOT (r->>'basic_salary' ~ '^[0-9]+(\.[0-9]+)?$')
       OR r->>'gross_pay' IS NULL OR NOT (r->>'gross_pay' ~ '^[0-9]+(\.[0-9]+)?$')
       OR (r ? 'allowances' AND r->>'allowances' IS NOT NULL AND NOT (r->>'allowances' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR (r ? 'overtime' AND r->>'overtime' IS NOT NULL AND NOT (r->>'overtime' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR (r ? 'bonus' AND r->>'bonus' IS NOT NULL AND NOT (r->>'bonus' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR (r ? 'paye' AND r->>'paye' IS NOT NULL AND NOT (r->>'paye' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR (r ? 'pension' AND r->>'pension' IS NOT NULL AND NOT (r->>'pension' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR (r ? 'uniform_deduction' AND r->>'uniform_deduction' IS NOT NULL AND NOT (r->>'uniform_deduction' ~ '^[0-9]+(\.[0-9]+)?$'))
       OR r->>'net_pay' IS NULL OR NOT (r->>'net_pay' ~ '^[0-9]+(\.[0-9]+)?$')
  ) THEN
    RAISE EXCEPTION 'Refusing to process payroll: one or more records has a missing, non-numeric, or negative monetary value -- every amount, including net_pay, must be zero or positive. Final payroll net pay must never be negative; review the deductions for the affected employee(s) and try again.';
  END IF;

  v_employee_ids := ARRAY(
    SELECT (r->>'employee_id')::UUID
    FROM jsonb_array_elements(p_records) AS r
  );

  -- ============================================================
  -- STEP 2: Concurrency control (unchanged) -- this same per-tenant+month
  -- advisory lock also serializes salary-advance deduction writes below,
  -- since they happen inside this same locked section. Two concurrent
  -- process_payroll_batch() calls for the same tenant+month can never
  -- both compute a deduction against the same "remaining balance before
  -- this month" snapshot.
  -- ============================================================
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || p_month));

  -- ============================================================
  -- STEP 3: Validate BEFORE any destructive change (unchanged).
  -- ============================================================
  SELECT COUNT(*) INTO v_foreign_employee_count
  FROM unnest(v_employee_ids) AS eid
  WHERE NOT EXISTS (
    SELECT 1 FROM employees e WHERE e.id = eid AND e.tenant_id = v_tenant_id
  );

  IF v_foreign_employee_count > 0 THEN
    RAISE EXCEPTION 'Refusing to process: % of the supplied employee(s) do not belong to your tenant', v_foreign_employee_count;
  END IF;

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
  -- STEP 4: Delete + insert (unchanged delete; insert is now a per-row
  -- loop instead of a single INSERT...SELECT, specifically to resolve
  -- each employee's own salary advance individually -- see header).
  -- ============================================================
  SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::JSONB) INTO v_old_rows
  FROM payroll p
  WHERE p.month = p_month
    AND p.tenant_id = v_tenant_id
    AND p.employee_id = ANY(v_employee_ids);

  DELETE FROM payroll
  WHERE month = p_month
    AND tenant_id = v_tenant_id
    AND employee_id = ANY(v_employee_ids);
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  FOR v_record IN SELECT * FROM jsonb_array_elements(p_records)
  LOOP
    v_employee_id := (v_record->>'employee_id')::UUID;
    v_base_net_pay := ROUND((v_record->>'net_pay')::NUMERIC, 2);
    v_advance_deduction := 0;

    -- This employee's ONE combined monthly deduction budget -- read from
    -- their single current salary_advance_repayment_plans row, NOT a sum
    -- of each advance's own originally-applied-for rate (see this file's
    -- header, item 3, for the business-rule correction this reflects).
    -- Zero if no plan row exists -- this is the NORMAL case for an
    -- employee whose advance is still 'pending' (approve_salary_advance()
    -- is what first creates this row, at approval time, never at
    -- application time), not just a defensive fallback; a missing plan
    -- simply means zero deduction rather than an error.
    SELECT combined_monthly_deduction INTO v_pool_remaining
    FROM salary_advance_repayment_plans
    WHERE employee_id = v_employee_id;
    v_pool_remaining := COALESCE(v_pool_remaining, 0);

    FOR v_pool_advance IN
      SELECT sa.id, sa.advance_amount, sa.status
      FROM salary_advances sa
      WHERE sa.employee_id = v_employee_id
        AND sa.tenant_id = v_tenant_id
        AND (
          (sa.status = 'active' AND sa.deduction_start_month <= p_month)
          OR EXISTS (
            SELECT 1 FROM salary_advance_deductions sad
            WHERE sad.salary_advance_id = sa.id AND sad.payroll_month = p_month
          )
        )
      ORDER BY sa.application_date ASC, sa.created_at ASC, sa.id ASC
    LOOP
      -- Idempotency + the critical reprocessing fix (header item 1/4):
      -- reuse an already-recorded deduction for this exact (advance,
      -- month) pair verbatim, regardless of the advance's CURRENT status
      -- (which may since have flipped to 'paid') -- never recompute
      -- against an already-decremented balance.
      SELECT deduction_amount INTO v_existing_ledger_amount
      FROM salary_advance_deductions
      WHERE salary_advance_id = v_pool_advance.id AND payroll_month = p_month;

      IF v_existing_ledger_amount IS NOT NULL THEN
        v_alloc := v_existing_ledger_amount;
      ELSE
        SELECT v_pool_advance.advance_amount - COALESCE(SUM(sad.deduction_amount), 0)
          INTO v_remaining_balance
        FROM salary_advance_deductions sad
        WHERE sad.salary_advance_id = v_pool_advance.id;

        v_remaining_balance := GREATEST(v_remaining_balance, 0);
        -- Oldest-first allocation against the ONE combined plan figure:
        -- capped only by this advance's own remaining balance and
        -- whatever budget is left in the pool this month -- NOT by any
        -- per-advance rate (see header item 3).
        v_alloc := ROUND(LEAST(v_remaining_balance, v_pool_remaining), 2);

        IF v_alloc > 0 THEN
          INSERT INTO salary_advance_deductions (tenant_id, salary_advance_id, employee_id, payroll_month, deduction_amount)
          VALUES (v_tenant_id, v_pool_advance.id, v_employee_id, p_month, v_alloc);

          v_advance_deductions_applied := v_advance_deductions_applied + 1;
        END IF;

        -- Zero remaining balance -> automatically paid, independently per
        -- advance. Guarded by status = 'active' so an already-'paid'
        -- advance encountered via the reprocessing-inclusion clause above
        -- is never redundantly updated.
        IF v_pool_advance.status = 'active' AND (v_remaining_balance - v_alloc) <= 0 THEN
          UPDATE salary_advances SET status = 'paid', updated_at = NOW() WHERE id = v_pool_advance.id;
        END IF;
      END IF;

      v_advance_deduction := v_advance_deduction + v_alloc;
      v_pool_remaining := v_pool_remaining - v_alloc;
    END LOOP;

    -- GLOBAL NET-PAY INVARIANT (confirmed business decision, this pass):
    -- final net_pay >= 0, for EVERY employee, regardless of what caused
    -- the deductions -- attendance, employee deductions, salary advances,
    -- terminal/other deductions, or any combination. This is no longer an
    -- "advance-only" carve-out: STEP 1.5's payload validation above
    -- already rejects a negative CLIENT-SUPPLIED net_pay outright (the
    -- earlier exception for that case has been REMOVED -- see this
    -- migration's own note at STEP 1.5), so `v_base_net_pay` reaching this
    -- point is always >= 0. This check is what additionally guarantees the
    -- SAME invariant survives this function's own salary-advance
    -- deduction, whatever `v_advance_deduction` (>= 0) turns out to be --
    -- one single global rule, not two coexisting ones. Does NOT invent a
    -- new "advance <= salary" cap that silently caps or reduces the
    -- deduction -- it fails the whole batch loudly and atomically instead.
    -- Since this function has no exception handler, RAISE EXCEPTION here
    -- rolls back the ENTIRE transaction -- every payroll row,
    -- salary_advance_deductions ledger row, advance status flip (including
    -- 'paid' transitions), and repayment-plan retirement written so far in
    -- this call, for every employee in the batch, not just this one.
    -- Nothing is posted on a rejected batch.
    IF (v_base_net_pay - v_advance_deduction) < 0 THEN
      RAISE EXCEPTION 'Refusing to process payroll for employee %: this would produce a negative net pay of % (net pay % minus a salary advance deduction of %). Final payroll net pay must never be negative -- resolve this before processing (e.g. reduce the combined repayment plan, move this employee''s deduction to a later month, or review their other deductions) -- nothing has been applied and the transaction has been rolled back.',
        v_employee_id, (v_base_net_pay - v_advance_deduction), v_base_net_pay, v_advance_deduction;
    END IF;

    -- PLAN CLEANUP: once this employee has NO remaining 'active' advance
    -- (the one just processed above was their last, and it just reached
    -- 'paid'), their combined repayment plan no longer represents any
    -- active debt -- retire it so the UI/summary never shows a stale
    -- "Current Combined Monthly Deduction" / "Expected Payoff" for debt
    -- that no longer exists. A no-op DELETE (0 rows) for every employee
    -- who either has no plan row at all, or still has an active advance.
    -- `salary_advance_repayment_plan_changes` is NEVER touched here -- it
    -- has no foreign key to this table and is intentionally permanent
    -- audit history, preserved regardless of whether the live plan is
    -- later retired. The next salary advance approved for this employee
    -- (approve_salary_advance()) finds no existing plan row and correctly
    -- takes the "FIRST active advance" branch, establishing a clean new
    -- plan from scratch rather than colliding with stale figures.
    DELETE FROM salary_advance_repayment_plans
    WHERE employee_id = v_employee_id
      AND NOT EXISTS (
        SELECT 1 FROM salary_advances WHERE employee_id = v_employee_id AND status = 'active'
      );

    INSERT INTO payroll (
      tenant_id, employee_id, month, basic_salary, allowances, overtime, bonus,
      gross_pay, paye, pension, uniform_deduction, salary_advance_deduction, net_pay,
      processed_at, approval_status, approved_by, approved_at, approval_notes, updated_at
    ) VALUES (
      v_tenant_id,
      v_employee_id,
      p_month,
      ROUND((v_record->>'basic_salary')::NUMERIC, 2),
      ROUND(COALESCE((v_record->>'allowances')::NUMERIC, 0), 2),
      ROUND(COALESCE((v_record->>'overtime')::NUMERIC, 0), 2),
      ROUND(COALESCE((v_record->>'bonus')::NUMERIC, 0), 2),
      ROUND((v_record->>'gross_pay')::NUMERIC, 2),
      ROUND(COALESCE((v_record->>'paye')::NUMERIC, 0), 2),
      ROUND(COALESCE((v_record->>'pension')::NUMERIC, 0), 2),
      ROUND(COALESCE((v_record->>'uniform_deduction')::NUMERIC, 0), 2),
      v_advance_deduction,
      v_base_net_pay - v_advance_deduction,
      NOW(),
      'pending',
      NULL,
      NULL,
      NULL,
      NOW()
    );
  END LOOP;

  -- GET DIAGNOSTICS after a loop would only report the LAST iteration's
  -- single-row INSERT count (always 1), not the batch total -- the loop
  -- above unconditionally inserts exactly one payroll row per record in
  -- p_records, so the real total is simply the record count itself.
  v_inserted_count := jsonb_array_length(p_records);

  -- ============================================================
  -- STEP 5: Audit log (same transaction, now also reports how many
  -- salary-advance deductions this call applied).
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
    jsonb_build_object('deletedCount', v_deleted_count, 'deletedRows', v_old_rows),
    p_audit_context || jsonb_build_object(
      'month', p_month,
      'employeeCount', array_length(v_employee_ids, 1),
      'recordsSaved', v_inserted_count,
      'salaryAdvanceDeductionsApplied', v_advance_deductions_applied,
      'status', 'pending_approval'
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'month', p_month,
    'deletedCount', v_deleted_count,
    'insertedCount', v_inserted_count,
    'advanceDeductionsApplied', v_advance_deductions_applied
  );
END;
$$;

-- Re-stated here (redundant with 20260803000002, which already revokes
-- both PUBLIC and `anon` at this function's true creation, and whose ACL
-- survives this CREATE OR REPLACE unchanged) for this file's own
-- self-sufficiency, matching the pattern used elsewhere in this schema.
REVOKE ALL ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- `ADD COLUMN IF NOT EXISTS`,
-- `CREATE OR REPLACE FUNCTION`, and the same REVOKE/GRANT pair.
--
-- DEPENDENCIES: requires 20260813000000_salary_advances_schema.sql (the
-- `salary_advances`/`salary_advance_deductions`/`salary_advance_repayment_plans`
-- tables) to already exist -- the function references all three by name.
-- Must be applied AFTER that migration, and after
-- 20260803000002_payroll_atomic_process_rpc.sql (whose function this replaces).
--
-- PREFLIGHT: none needed for the ADD COLUMN (has a DEFAULT, so it
-- back-fills instantly without a table rewrite lock on modern Postgres/
-- Supabase versions -- no existing payroll row's other columns are
-- touched). The CREATE OR REPLACE FUNCTION touches no data at all.
--
-- LOCKING / PRODUCTION TRAFFIC IMPACT: `ADD COLUMN ... DEFAULT 0` takes a
-- brief metadata-only lock (no full table rewrite required for a
-- constant default on a modern Postgres version). Redefining the
-- function is a catalog-only change. Neither should be noticeable in
-- production traffic, though a low-traffic window remains the more
-- conservative choice given this changes payroll-processing behavior.
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS: an employee with no 'active'-status
-- salary advance and a non-negative net_pay sees ZERO behavior change --
-- `v_advance_deduction` stays 0, `net_pay` is unchanged from before this
-- migration, and `salary_advance_deduction` is simply 0 on their row. This
-- migration is safe to apply even before any salary advance has ever been
-- created. ONE real behavior change, confirmed as an intentional business
-- decision in this pass: a record whose CLIENT-SUPPLIED net_pay is already
-- negative -- previously accepted regardless of salary advances (see
-- 20260803000002's own STEP 1.5b) -- is now REJECTED outright at payload
-- validation, whether or not the employee has any salary advance at all.
-- Any existing caller that relied on submitting an already-negative
-- net_pay must be updated before this migration is applied to STAGING/
-- production, or that specific call will start failing loudly (by design
-- -- see the GLOBAL NET-PAY INVARIANT note above).
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT column_name, column_default, is_nullable FROM information_schema.columns
--     WHERE table_name = 'payroll' AND column_name = 'salary_advance_deduction';
--   -- expected: 1 row, column_default = '0', is_nullable = 'NO'
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'process_payroll_batch';
--   -- expected: 1 row, prosecdef = true (unchanged from before)
--   -- Functional check (requires a STAGING project with a test employee
--   -- and an 'active' salary advance already created via the UI):
--   --   1. Process payroll for that employee for the advance's
--   --      deduction_start_month. Confirm the resulting payroll row's
--   --      salary_advance_deduction matches the employee's
--   --      salary_advance_repayment_plans.combined_monthly_deduction
--   --      (capped by the advance's remaining balance), and a matching
--   --      salary_advance_deductions row exists.
--   --   2. Reprocess the SAME month. Confirm salary_advance_deduction is
--   --      IDENTICAL (not doubled), and still only ONE
--   --      salary_advance_deductions row exists for that (advance, month).
--   --   3. Process the month the balance reaches zero in. Confirm the
--   --      advance's status flips to 'paid', and a further reprocess of
--   --      a LATER month deducts nothing for that (now-paid) advance.
--   --   4. CRITICAL regression check: process the FINAL month of an
--   --      advance (the one that flips it to 'paid'), confirm the payroll
--   --      row shows the correct final (possibly partial) deduction, THEN
--   --      reprocess that exact SAME month again. Confirm
--   --      salary_advance_deduction on the reprocessed row is IDENTICAL
--   --      to the first run -- NOT zero. (This is the specific bug found
--   --      in review: a naive `WHERE status = 'active'` lookup would miss
--   --      an advance that already flipped to 'paid' during the first
--   --      run, silently reporting 0 on reprocess. The EXISTS-ledger-row
--   --      clause in the query above is what prevents this.)
--   --   5. Two-advance COMBINED PLAN check: create and approve advance #1
--   --      (approve_salary_advance()) -- confirm a
--   --      salary_advance_repayment_plans row now exists with advance #1's
--   --      own terms. Create advance #2 (still 'pending') -- confirm the
--   --      plan is UNCHANGED. Approve advance #2 WITH explicit new combined
--   --      terms (e.g. 20,000/month) -- confirm the plan updates to the new
--   --      combined outstanding. Process a month where both advances are
--   --      eligible -- confirm the payroll row's salary_advance_deduction
--   --      equals EXACTLY that combined figure (or less, if both balances
--   --      together are smaller), confirm the ledger has ONE row per
--   --      advance for that month, and confirm the OLDER advance is
--   --      funded first with any leftover spilling to the younger one the
--   --      SAME month (per the business rule's own worked example: pool
--   --      20,000, Advance #1 remaining 10,000 -> gets 10,000; Advance #2
--   --      gets the remaining 10,000; total exactly 20,000).
--   --   6. GLOBAL NET-PAY INVARIANT check (confirmed business decision):
--   --      (a) submit a record with an already-negative client-supplied
--   --      net_pay and NO salary advance -- expect the RPC call to raise
--   --      an exception at payload validation, before any table write.
--   --      (b) approve an advance whose combined monthly deduction (e.g.
--   --      20,000) exceeds the employee's net pay before the advance
--   --      (e.g. 15,000); process payroll for that employee -- expect the
--   --      RPC call to raise an exception, not silently write a negative
--   --      net_pay row. Confirm NOTHING was written for either case: no
--   --      payroll row, no salary_advance_deductions row, and the
--   --      advance's status unchanged. (c) confirm a combination -- modest
--   --      other deductions plus a salary advance that together go
--   --      negative -- is also rejected. (d) confirm net_pay of EXACTLY 0
--   --      is accepted (not rejected), and a normal positive net_pay is
--   --      unaffected. (e) submit a multi-employee batch where only ONE
--   --      employee's payroll would go negative -- confirm the ENTIRE
--   --      batch rolls back, including the employees who would otherwise
--   --      have succeeded.
--   --   7. PLAN CLEANUP check (safety review finding): with a single active
--   --      advance whose final month's deduction pays it off completely,
--   --      process that month -- confirm the advance flips to 'paid' AND
--   --      the employee's salary_advance_repayment_plans row is gone
--   --      (SELECT returns 0 rows). Confirm
--   --      salary_advance_repayment_plan_changes history for that employee
--   --      is still present (untouched). Process a LATER month -- confirm
--   --      salary_advance_deduction is 0 (no plan, nothing to deduct).
--   --      Then create and approve a brand-new advance for the same
--   --      employee -- confirm a fresh plan is established cleanly from
--   --      that advance's own terms, with no interference from the retired
--   --      one.
--
-- ROLLBACK SQL (run this to revert to the pre-salary-advance version of
-- the function -- SAFE ONLY IF NO FRONTEND BUILD THAT EXPECTS
-- payroll.salary_advance_deduction / references salary advances is still
-- live, per this whole migration set's standing "roll back the frontend
-- before dropping what it depends on" rule):
--   -- Re-run 20260803000002_payroll_atomic_process_rpc.sql's own
--   -- CREATE OR REPLACE FUNCTION block verbatim to restore the prior
--   -- version (it uses the same function signature, so this fully
--   -- reverts the behavior change without needing a DROP FUNCTION first).
--   -- payroll.salary_advance_deduction itself is safe to leave in place
--   -- (defaults to 0, unused by the reverted function) or drop separately:
--   ALTER TABLE payroll DROP COLUMN IF EXISTS salary_advance_deduction;
-- ============================================================
