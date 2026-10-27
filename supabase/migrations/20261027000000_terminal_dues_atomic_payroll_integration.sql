-- ============================================================
-- MIGRATION: Terminal Dues Phase 3B -- atomic combined Process Payroll
-- Date: 2026-10-27
-- ============================================================
--
-- ROOT CAUSE THIS MIGRATION FIXES
-- -----------------------------------------------------------
-- Phase 3A (20261026000000) sequenced TWO separate client-side RPC calls
-- from Payroll.tsx: process_payroll_batch() first, then (if the caller
-- holds terminal_dues.approve) process_terminal_due_allocations_batch().
-- Each RPC is its own atomic Postgres transaction, but the TWO calls are
-- two independent HTTP round trips -- if the first commits and the second
-- then fails (a revision landed in the gap, a network error, an
-- out-of-balance allocation), ordinary payroll is left processed while an
-- included Terminal Dues obligation silently did not commit. Phase 3A's
-- own report flagged this as "the precise limitation" and concluded (based
-- on the fact that two separate `supabase.rpc()` calls cannot share a
-- client-side transaction) that true atomicity was not achievable without
-- rearchitecting.
--
-- THAT CONCLUSION WAS TOO NARROW. It is correct that two separate CLIENT
-- round trips cannot be one transaction. It does NOT follow that the two
-- SERVER-SIDE functions cannot be. Postgres does not start a new
-- transaction for an ordinary (non-dblink, non-autonomous) function call
-- made FROM WITHIN another plpgsql function's body -- a nested call
-- executes inside the SAME transaction as its caller. Neither
-- process_payroll_batch() nor process_terminal_due_allocations_batch() has
-- an internal BEGIN/EXCEPTION block anywhere in its body (confirmed by
-- direct inspection of both functions' full current text before writing
-- this migration), so a RAISE EXCEPTION inside either one propagates all
-- the way out, uncaught, to whatever called it. A single new function
-- that calls BOTH of them, in turn, from inside ONE plpgsql body, and does
-- not itself catch the exception either, therefore gets true all-or-
-- nothing atomicity for free -- if the first call's writes already landed
-- and the second call then raises, Postgres rolls back the ENTIRE
-- transaction, including the first call's writes, exactly as if neither
-- had ever run. No distributed-transaction/saga infrastructure is needed;
-- this was always available using plain Postgres function-call semantics.
--
-- This also directly answers the clarifying note this phase's own task
-- gave in advance: "historical employees do not need to be inserted into
-- the ordinary payroll table; their separate ledger can participate in the
-- same PostgreSQL transaction." Terminal Dues allocations (ordinary- or
-- historical-employee-linked alike) live in `terminal_due_allocations`,
-- never in `payroll` -- two separate tables, two separate proven
-- functions, ONE Postgres transaction, via a plain nested function call.
--
-- ARCHITECTURE SELECTED
-- -----------------------------------------------------------
-- A new orchestration function, process_payroll_with_terminal_dues(),
-- becomes the ONE entry point Payroll.tsx calls for both
-- processPayroll() and copyFromPreviousMonth(). It:
--   1. Resolves the caller's tenant via get_current_tenant_id() (the same
--      fail-closed active/deleted-account check every other function in
--      this schema already uses).
--   2. Resolves the tenant's OWN authoritative current_payroll_month from
--      system_settings and requires the caller-supplied p_month to match
--      it exactly -- closing a race where the authoritative month changed
--      underneath a stale page/direct RPC call (Payroll.tsx's own
--      isCurrentMonth guard already prevents this in normal use; this is
--      the server-side backstop for a direct call that skips the UI).
--   3. Checks whether the caller holds terminal_dues.approve (via
--      has_explicit_permission(), the same deliberately-narrow check
--      process_terminal_due_allocations_batch() itself already uses -- NOT
--      duplicated logic, just the one boolean this function needs to
--      decide whether Terminal Dues is even IN this run).
--   4. Acquires BOTH the ordinary-payroll advisory lock (hashtext, the
--      exact key process_payroll_batch() itself computes) and the
--      Terminal Dues advisory lock (hashtextextended, the exact key
--      process_terminal_due_allocations_batch()/carry_forward_terminal_
--      due_allocations() already use) in a FIXED order -- payroll lock
--      first, then Terminal Dues -- BEFORE calling either inner function.
--      (The inner functions also acquire these same keys internally;
--      advisory xact locks are reentrant within one session/transaction,
--      so that second acquisition is a harmless no-op. Pre-acquiring both
--      here, in one fixed order, is what actually satisfies "acquire
--      locks in a consistent order" as an explicit, auditable step rather
--      than an incidental side effect of call order -- and it means two
--      concurrent calls to THIS function are serialized end-to-end, not
--      just within each inner function separately.)
--   5. Calls process_payroll_batch() UNCHANGED, byte-for-byte, with
--      exactly the parameters Payroll.tsx already builds today. Its own
--      validation/authorization/payload checks/salary-advance integration
--      all run exactly as before -- NOTHING about ordinary payroll
--      processing is reimplemented or duplicated here.
--   6. If the caller holds terminal_dues.approve AND there is at least one
--      'approved' Terminal Dues allocation for this month OR the caller
--      supplied an exclusion list, calls
--      process_terminal_due_allocations_batch() UNCHANGED, byte-for-byte,
--      with the caller's own exclusion list/reason. Its own re-validation
--      (entitlement still approved, no pending revision, amount still
--      within the true outstanding balance) runs exactly as before. If it
--      raises for any non-excluded invalid allocation, that exception
--      propagates straight out of this function too -- rolling back
--      EVERYTHING, including whatever process_payroll_batch() already
--      wrote in step 5. A caller who does NOT hold terminal_dues.approve
--      simply never reaches this step at all -- ordinary payroll for that
--      caller behaves exactly as if this migration did not exist. This is
--      a deliberate, considered choice, not an oversight: Terminal Dues
--      authority is permission-scoped to the ACTING admin, not a global
--      gate on payroll -- an Admin without terminal_dues.approve can and
--      should still be able to run ordinary payroll even while some
--      OTHER Terminal Dues allocation (that they have no authority over
--      and cannot even see resolved) sits pending. "Cannot silently
--      bypass Terminal Dues obligations in the same payroll run" means:
--      once a run's own acting admin HAS the authority to include
--      Terminal Dues, they cannot have it silently skipped by a non-
--      atomic failure -- not that payroll is held hostage to an unrelated
--      admin's backlog.
--   7. Writes ONE additional audit_logs row (entity_type =
--      'combined_payroll_run') cross-referencing both components' own
--      audit entries via a new v_combined_reference -- this is the
--      concrete, queryable object a network-interrupted caller can check
--      ("did this actually commit?") instead of blindly retrying; see
--      PART 3 below.
--   8. Returns separate `payroll` / `terminal_dues` result objects plus
--      `ordinary_payroll_total` / `terminal_dues_total` / `combined_total`
--      -- all three totals computed server-side from the actual committed
--      data, never trusting a client-supplied aggregate.
--
-- PREVENTING BYPASS (this migration's PART 2)
-- -----------------------------------------------------------
-- The only two real call sites for process_payroll_batch() and the only
-- real call site for process_terminal_due_allocations_batch() in this
-- entire frontend were, before this migration, Payroll.tsx's
-- processPayroll()/copyFromPreviousMonth() and processPayroll()
-- respectively (verified by inspection: every other match in src/ is a
-- code comment). Both are rewritten (separate frontend commit, same PR)
-- to call ONLY process_payroll_with_terminal_dues(). To close the bypass
-- at the DATABASE level too -- not merely by deleting the old call sites
-- from the UI, which a future change could reintroduce by accident --
-- this migration REVOKEs EXECUTE on both inner functions from
-- `authenticated`. Since process_payroll_with_terminal_dues() is itself
-- SECURITY DEFINER, its nested calls into either inner function run under
-- the FUNCTION OWNER's privileges (the standard Postgres behavior once
-- execution is inside a SECURITY DEFINER function), so the orchestrator
-- keeps working unaffected. An ordinary authenticated client -- whether
-- through this app's UI, a stray future code path, or a direct REST call
-- with a stolen/valid session JWT -- can no longer invoke either inner
-- function directly at all; PostgREST rejects the call before either
-- function's own body even runs. carry_forward_terminal_due_allocations()
-- is NOT touched -- it is a separate, independent Admin action (closing a
-- month and preparing the next one), not part of "this payroll run"'s own
-- atomicity, and keeps its existing direct-callable grant.
--
-- FAILURE / RETRY / IDEMPOTENCY (inherited, not reimplemented)
-- -----------------------------------------------------------
-- Every idempotency/concurrency guarantee this migration relies on
-- already existed in the two inner functions and is simply inherited:
--   - Double-click / reprocess: process_payroll_batch()'s own approved-
--     month protection and delete-then-insert-in-one-statement behavior is
--     unchanged. process_terminal_due_allocations_batch()'s WHERE clause
--     structurally excludes already-processed/already-excluded rows, so a
--     second call is a clean no-op, not a duplicate.
--   - Concurrency: this function's own pre-acquired locks make two
--     concurrent combined calls for the same tenant+month fully
--     serialized (the second waits for the first's entire transaction to
--     finish, not just one inner function's).
--   - Stale validation: process_terminal_due_allocations_batch() always
--     re-validates every candidate against LIVE row data under FOR UPDATE
--     locks at the moment it runs, inside this same transaction -- never
--     against anything this orchestrator or the client precomputed
--     earlier. A revision or hold that lands between page-load and this
--     call is picked up correctly, exactly as it already was.
-- ============================================================

CREATE OR REPLACE FUNCTION process_payroll_with_terminal_dues(
  p_month TEXT,
  p_records JSONB,
  p_user_email TEXT DEFAULT NULL,
  p_audit_context JSONB DEFAULT '{}'::JSONB,
  p_td_excluded_ids UUID[] DEFAULT '{}',
  p_td_exclusion_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_system_month TEXT;
  v_has_td_permission BOOLEAN;
  v_has_eligible_td BOOLEAN;
  v_payroll_result JSONB;
  v_td_result JSONB := NULL;
  v_combined_reference TEXT;
  v_ordinary_total NUMERIC := 0;
  v_td_total NUMERIC := 0;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- ============================================================
  -- STEP 1: Resolve tenant (fail-closed on inactive/deleted account --
  -- see get_current_tenant_id()'s own definition). This is the one piece
  -- of identity this function needs before it can even compute a lock
  -- key or look up the authoritative month -- it is NOT a duplicate of
  -- process_payroll_batch()'s own full authorization check (role_level/
  -- has_permission('payroll.process')/region), which still runs,
  -- unchanged, inside that function itself in STEP 5 below.
  -- ============================================================
  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- ============================================================
  -- STEP 2: Resolve the authoritative payroll month server-side and
  -- require the caller's p_month to match it -- "resolve the current
  -- authoritative payroll month" and "never silently change the
  -- authoritative payroll month" from this phase's own requirements.
  -- ============================================================
  SELECT value INTO v_system_month FROM system_settings WHERE tenant_id = v_tenant_id AND key = 'current_payroll_month';
  IF v_system_month IS NULL THEN
    RAISE EXCEPTION 'No active payroll month is configured for this tenant -- set one on the Payroll page first';
  END IF;
  IF p_month <> v_system_month THEN
    RAISE EXCEPTION 'Refusing to process: % is not the active payroll month (%) -- it may have changed since this page loaded; refresh and try again', p_month, v_system_month;
  END IF;

  -- ============================================================
  -- STEP 3: Does this caller hold Terminal Dues processing authority?
  -- Deliberately has_explicit_permission(), NOT has_permission() -- an
  -- Admin must not gain this "for free." This decides whether Terminal
  -- Dues is even part of THIS run; it never blocks ordinary payroll for a
  -- caller who legitimately lacks it (see this migration's header).
  -- ============================================================
  v_has_td_permission := is_super_admin() OR has_explicit_permission('terminal_dues.approve');

  -- ============================================================
  -- STEP 4: Acquire BOTH advisory locks, in a fixed order, before either
  -- inner function runs -- see this migration's header for why this
  -- satisfies "consistent lock order" as an explicit step rather than an
  -- accident of call sequence, and why it is safe for the inner
  -- functions to (harmlessly) re-acquire the identical keys themselves.
  -- ============================================================
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || p_month));
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant_id::text || ':' || p_month, 0));

  -- ============================================================
  -- STEP 5: Ordinary payroll -- the existing, proven, unmodified
  -- function. Any exception here propagates straight out (no BEGIN/
  -- EXCEPTION block anywhere in this function), aborting this entire
  -- transaction before Terminal Dues is even attempted.
  -- ============================================================
  v_payroll_result := process_payroll_batch(p_month, p_records, p_user_email, p_audit_context);

  -- Summed from the just-committed `payroll` ROWS THEMSELVES, not from
  -- p_records -- p_records' own net_pay field is deliberately the PRE-
  -- salary-advance-deduction figure (Payroll.tsx adds the deduction back
  -- before calling, since process_payroll_batch() subtracts its own
  -- server-computed copy -- see that function's header), so summing it
  -- directly here would OVERSTATE this total for any employee with an
  -- active advance. Reading the actual stored rows gives the true, final,
  -- post-advance figure -- exactly what Payroll.tsx's own on-screen
  -- `totals.net` already shows.
  SELECT COALESCE(SUM(net_pay), 0) INTO v_ordinary_total
  FROM payroll
  WHERE tenant_id = v_tenant_id AND month = p_month
    AND employee_id = ANY(ARRAY(SELECT (r->>'employee_id')::UUID FROM jsonb_array_elements(p_records) AS r));

  -- ============================================================
  -- STEP 6: Terminal Dues -- the existing, proven, unmodified function,
  -- attempted ONLY when this caller has the authority AND there is
  -- actually something to do (an eligible 'approved' allocation, or an
  -- explicit exclusion list) -- avoids a no-op audit_logs row on every
  -- ordinary month with zero Terminal Dues activity. Any exception here
  -- propagates straight out too, rolling back STEP 5's writes along with
  -- everything else in this transaction -- this is the actual fix for the
  -- non-atomicity Phase 3A flagged.
  -- ============================================================
  IF v_has_td_permission THEN
    SELECT EXISTS (
      SELECT 1 FROM terminal_due_allocations
      WHERE tenant_id = v_tenant_id AND payroll_month = p_month AND status = 'approved'
    ) INTO v_has_eligible_td;

    IF v_has_eligible_td OR (p_td_excluded_ids IS NOT NULL AND array_length(p_td_excluded_ids, 1) > 0) THEN
      v_td_result := process_terminal_due_allocations_batch(p_td_excluded_ids, p_td_exclusion_reason);
      v_td_total := COALESCE((v_td_result->>'total_amount')::NUMERIC, 0);
    END IF;
  END IF;

  -- ============================================================
  -- STEP 7: One linking audit entry -- the concrete, queryable object a
  -- caller whose network connection dropped after this call can check
  -- ("select * from audit_logs where entity_type = 'combined_payroll_run'
  -- and new_data->>'month' = '<month>' order by created_at desc limit 1")
  -- instead of blindly retrying. References both inner functions' own
  -- audit entries (already written, inside this same still-open
  -- transaction) via their own result payloads, never duplicating them.
  -- ============================================================
  v_combined_reference := 'PWTD-' || p_month || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  INSERT INTO audit_logs (tenant_id, user_id, user_email, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, p_user_email, 'CREATE', 'combined_payroll_run', v_combined_reference,
    '{}'::JSONB,
    jsonb_build_object(
      'month', p_month,
      'combined_reference', v_combined_reference,
      'payroll_inserted_count', v_payroll_result->'insertedCount',
      'terminal_dues_included', v_td_result IS NOT NULL,
      'terminal_dues_batch_reference', v_td_result->>'batch_reference',
      'terminal_dues_processed_count', v_td_result->'processed_count',
      'ordinary_payroll_total', v_ordinary_total,
      'terminal_dues_total', v_td_total,
      'combined_total', v_ordinary_total + v_td_total
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'month', p_month,
    'combined_reference', v_combined_reference,
    'payroll', v_payroll_result,
    'terminal_dues', v_td_result,
    'terminal_dues_included', v_td_result IS NOT NULL,
    'ordinary_payroll_total', v_ordinary_total,
    'terminal_dues_total', v_td_total,
    'combined_total', v_ordinary_total + v_td_total
  );
END;
$$;

REVOKE ALL ON FUNCTION process_payroll_with_terminal_dues(TEXT, JSONB, TEXT, JSONB, UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_payroll_with_terminal_dues(TEXT, JSONB, TEXT, JSONB, UUID[], TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION process_payroll_with_terminal_dues(TEXT, JSONB, TEXT, JSONB, UUID[], TEXT) TO authenticated;

-- ============================================================
-- PART 2: close the bypass at the database privilege layer -- see this
-- migration's header for why the orchestrator above is unaffected by
-- this (it runs its nested calls under its own SECURITY DEFINER owner
-- privileges, not the calling client's).
-- ============================================================
REVOKE EXECUTE ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM authenticated;
REVOKE EXECUTE ON FUNCTION process_terminal_due_allocations_batch(UUID[], TEXT) FROM authenticated;
-- Re-stated for self-sufficiency (already true from their own migrations):
REVOKE ALL ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION process_terminal_due_allocations_batch(UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_terminal_due_allocations_batch(UUID[], TEXT) FROM anon;

-- ============================================================
-- PART 3: RECOVERY -- after a network interruption whose outcome is
-- unknown, check (in order):
--   1. SELECT * FROM audit_logs WHERE entity_type = 'combined_payroll_run'
--      AND new_data->>'month' = '<month>' ORDER BY created_at DESC LIMIT 1;
--      -- if present and recent, the run committed; its new_data gives the
--      -- exact combined_reference, counts, and totals.
--   2. SELECT COUNT(*) FROM payroll WHERE month = '<month>' AND tenant_id = '<tenant>';
--      -- a nonzero count for the expected employee set confirms ordinary
--      -- payroll committed.
--   3. SELECT * FROM terminal_due_allocations WHERE payroll_month = '<month>'
--      AND status IN ('processed', 'excluded');
--      -- confirms whether Terminal Dues committed as part of the same run.
-- Re-submitting the SAME request after confirming a prior commit is safe
-- regardless: process_payroll_batch()'s approved-month protection and
-- process_terminal_due_allocations_batch()'s own WHERE clause both make a
-- repeat call a clean reprocess/no-op, never a duplicate.
-- ============================================================

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- CREATE OR REPLACE FUNCTION and the
-- same REVOKE/GRANT statements every time.
--
-- DEPENDENCIES: requires process_payroll_batch() (20260803000002, as
-- finalized by 20260817000003) and process_terminal_due_allocations_batch()
-- (20261026000000) to already exist with exactly those signatures.
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS: NONE for any caller going through
-- the orchestrator whose month has no Terminal Dues allocations at all, or
-- who lacks terminal_dues.approve -- byte-identical to calling
-- process_payroll_batch() directly (same validation, same lock, same
-- payload rules), just nested one level under `.payroll` in the return
-- value. The ONE real behavior change (intentional, the entire point of
-- this migration): a caller who DOES hold terminal_dues.approve, for a
-- month that DOES have an invalid-but-not-excluded approved Terminal Dues
-- allocation, now has their ordinary payroll processing for that SAME call
-- ALSO roll back, instead of succeeding while Terminal Dues silently
-- failed. Direct client calls to process_payroll_batch()/
-- process_terminal_due_allocations_batch() will start failing with a
-- permission-denied error after this migration -- the companion frontend
-- change (same PR) removes the two call sites that would otherwise break.
--
-- PREFLIGHT: none needed -- this migration only CREATEs a new function and
-- adjusts EXECUTE grants; it does not alter any table or existing row.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'process_payroll_with_terminal_dues';
--   -- expected: 1 row, prosecdef = true
--   SELECT has_function_privilege('authenticated', 'process_payroll_with_terminal_dues(text, jsonb, text, jsonb, uuid[], text)', 'EXECUTE');
--   -- expected: true
--   SELECT has_function_privilege('authenticated', 'process_payroll_batch(text, jsonb, text, jsonb)', 'EXECUTE');
--   -- expected: false (direct bypass now closed)
--   SELECT has_function_privilege('authenticated', 'process_terminal_due_allocations_batch(uuid[], text)', 'EXECUTE');
--   -- expected: false (direct bypass now closed)
--   SELECT has_function_privilege('authenticated', 'carry_forward_terminal_due_allocations(text, text)', 'EXECUTE');
--   -- expected: true (unaffected -- not part of this payroll run's own atomicity)
--
-- ROLLBACK SQL (run this to fully revert this migration):
--   DROP FUNCTION IF EXISTS process_payroll_with_terminal_dues(TEXT, JSONB, TEXT, JSONB, UUID[], TEXT);
--   GRANT EXECUTE ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) TO authenticated;
--   GRANT EXECUTE ON FUNCTION process_terminal_due_allocations_batch(UUID[], TEXT) TO authenticated;
--   -- SAFE ONLY IF the companion frontend change (which calls
--   -- process_payroll_with_terminal_dues() exclusively) has ALSO been
--   -- rolled back first -- otherwise the live frontend would be calling a
--   -- function that no longer exists.
-- ============================================================
