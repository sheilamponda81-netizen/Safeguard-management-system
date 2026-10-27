-- ============================================================
-- MIGRATION: Phase 3D Final Correction -- stop silently omitting
-- Terminal Dues from a legacy Admin's combined payroll run
-- Date: 2026-10-29
-- ============================================================
--
-- ROOT CAUSE
-- -----------------------------------------------------------
-- process_payroll_with_terminal_dues() (20261027000000, re-declared
-- unchanged in this respect by 20261028000000) decided whether to even
-- ATTEMPT including eligible 'approved' Terminal Dues allocations in a
-- combined run using:
--
--   v_has_td_permission := is_super_admin() OR has_explicit_permission('terminal_dues.approve');
--   ...
--   IF v_has_td_permission THEN ... (eligible/excluded check, then call
--     process_terminal_due_allocations_batch()) ... END IF;
--
-- has_explicit_permission('terminal_dues.approve') is TRUE only for a
-- super admin or a profile with an explicit role_permissions row for
-- that permission -- it is FALSE for a legacy Admin (role_level = 1,
-- role often NULL), exactly the profile this codebase's own established
-- convention (is_business_admin()) exists to recognize as Admin-class
-- without requiring a seeded permissions row. Since Phase 3D
-- (20261028000000) already added its OWN gate requiring is_super_admin()
-- OR is_business_admin() just to REACH this function at all, every
-- caller who gets this far is already Admin-class -- but the narrower
-- v_has_td_permission check then silently skipped Terminal Dues anyway
-- for any Admin-class caller who happened not to also hold the separate
-- terminal_dues.approve permission. Ordinary payroll committed; an
-- eligible, already-approved Terminal Dues allocation did not -- with no
-- error, no audit trail distinguishing "nothing was eligible" from
-- "something was eligible but silently skipped." This is the exact
-- business-rule violation this migration closes.
--
-- WHY THIS IS AN AUTHORIZATION-MODELING BUG, NOT A ONE-LINE PATCH
-- -----------------------------------------------------------
-- terminal_dues.approve was, until now, doing double duty as BOTH:
--   (a) the permission to APPROVE OR REJECT an individual Terminal Dues
--       allocation (approve_terminal_due_allocation() /
--       reject_terminal_due_allocation(), 20261023000000 -- a real
--       approval decision, changing status to 'approved'/'rejected') --
--       and
--   (b) the permission to COMMIT PAYMENT for allocations that have
--       ALREADY been approved by (a), as part of a payroll run
--       (process_terminal_due_allocations_batch(), 20261026000000).
-- These are genuinely different authorities. (a) is a judgment call
-- about whether an entitlement is legitimate; (b) is "may this caller
-- execute payroll, including the already-decided Terminal Dues
-- component." Per this phase's own clarified business rule, Admin-class
-- callers (is_super_admin() OR is_business_admin() -- the SAME bar
-- Phase 3D already requires to commit payroll at all) hold authority (b)
-- unconditionally; only (a) stays scoped to the narrower
-- terminal_dues.approve permission. Fixing only the ORCHESTRATOR's own
-- v_has_td_permission check, without ALSO relaxing
-- process_terminal_due_allocations_batch()'s identical internal gate,
-- would have made this WORSE, not better: the orchestrator would then
-- attempt the inner call for a legacy Admin, the inner function would
-- immediately RAISE on its own gate, and -- because this is one
-- Postgres transaction (Phase 3B) -- that exception would roll back the
-- ordinary payroll the orchestrator had just committed too, turning a
-- silent omission into an outright payroll-processing failure for every
-- legacy Admin in any month with an eligible Terminal Dues allocation.
-- Both functions are therefore corrected together, below.
--
-- WHAT STAYS EXACTLY AS IT WAS (approval separation preserved)
-- -----------------------------------------------------------
-- approve_terminal_due_allocation() / reject_terminal_due_allocation()
-- (20261023000000) are NOT touched by this migration -- still gated on
-- is_super_admin() OR has_explicit_permission('terminal_dues.approve'),
-- exactly as before. An Admin-class caller who commits a combined
-- payroll run under this migration's relaxed check gains ZERO new
-- ability to approve, reject, correct, or propose an individual
-- allocation -- those RPCs are untouched, and an Accountant still cannot
-- reach any of them (role_permissions seeds no terminal_dues.* grant for
-- 'accountant' at all; this was verified during Phase 3C's audit and is
-- unaffected here). Nor does this migration touch submit_payroll_
-- processing_request()'s own existing check (20261028000000, lines
-- 234-241), which already correctly refuses a non-empty
-- p_td_excluded_ids from any caller who is not is_super_admin() OR
-- has_explicit_permission('terminal_dues.approve') -- an Accountant can
-- never stage an exclusion decision, before or after this migration.
--
-- THE ONE NEW THING THIS MIGRATION ADDS: process_payroll_with_
-- terminal_dues() did not itself previously re-check exclusion
-- authority when called DIRECTLY (outside the request-workflow path) --
-- it relied entirely on v_has_td_permission gating the whole block,
-- which (incidentally, not by design) also gated exclusions. Now that
-- inclusion is unconditional for any Admin-class caller, this migration
-- adds an explicit, narrower check -- mirroring submit_payroll_
-- processing_request()'s own identical rule -- so that supplying a
-- non-empty p_td_excluded_ids directly still requires is_super_admin()
-- OR has_explicit_permission('terminal_dues.approve'), exactly as the
-- request-submission path already requires. Exclusion selection remains
-- the narrower, approval-adjacent decision it always was; inclusion of
-- already-decided Terminal Dues allocations does not.
--
-- WHY RELAXING process_terminal_due_allocations_batch()'s OWN GATE IS
-- SAFE
-- -----------------------------------------------------------
-- That function has been REVOKEd from `authenticated` since Phase 3B
-- (20261027000000) -- confirmed by inspection, it has exactly ONE caller
-- in this entire schema: process_payroll_with_terminal_dues()'s own
-- nested call, running under SECURITY DEFINER owner privileges. No
-- direct client path to it exists before or after this migration.
-- Relaxing its internal check to match the orchestrator's own Admin-class
-- bar therefore does not open any new call path -- it only stops it from
-- independently re-imposing the narrower permission the orchestrator has
-- already (correctly) stopped requiring.
--
-- BUSINESS RULES THIS MIGRATION'S TEST SUITE CONFIRMS (see its own
-- scenario file, not committed to this repo -- disposable local Postgres
-- only):
--   - Accountant: submits a request, cannot commit directly, still
--     cannot approve/reject any individual Terminal Dues allocation,
--     still cannot select exclusions.
--   - Functional Admin (role = 'admin', holds terminal_dues.approve):
--     approves a request and processes ordinary payroll + eligible
--     Terminal Dues together -- unchanged from before this migration.
--   - Legacy Admin (role_level = 1, role NULL, NO terminal_dues.approve
--     row): approves a request and processes ordinary payroll + eligible
--     Terminal Dues together -- THIS is the fix; before this migration,
--     Terminal Dues silently did not process for this profile.
--   - Payroll-only months (no eligible Terminal Dues) process exactly as
--     before for every profile -- zero behavior change.
--   - A legacy Admin attempting to supply a non-empty exclusion list is
--     refused (database-enforced, not merely absent from the UI, which
--     never offers this control to a caller without terminal_dues.approve
--     in the first place) -- nothing commits, including ordinary payroll,
--     matching "return a clear error without committing either
--     component."
-- ============================================================

-- ============================================================
-- PART 1: process_terminal_due_allocations_batch() -- ONE line changed
-- (the authorization check), every other line byte-for-byte unchanged
-- from 20261026000000.
-- ============================================================
CREATE OR REPLACE FUNCTION process_terminal_due_allocations_batch(
  p_excluded_ids UUID[] DEFAULT '{}',
  p_exclusion_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_month TEXT;
  v_batch_ref TEXT;
  v_alloc RECORD;
  v_due RECORD;
  v_already_processed NUMERIC;
  v_processed_count INTEGER := 0;
  v_excluded_count INTEGER := 0;
  v_total_amount NUMERIC := 0;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- CHANGED (this migration): was `is_super_admin() OR
  -- has_explicit_permission('terminal_dues.approve')`. This function only
  -- ever PAYS allocations that are ALREADY status = 'approved' -- it
  -- never approves/rejects one (see approve_terminal_due_allocation()/
  -- reject_terminal_due_allocation(), 20261023000000, untouched, still
  -- gated on terminal_dues.approve). Processing payment for an
  -- already-decided allocation, as part of a payroll run, is payroll-
  -- execution authority, not Terminal-Dues-approval authority -- the same
  -- Admin-class bar process_payroll_with_terminal_dues() itself already
  -- requires to reach this function at all (it is the only caller; see
  -- this migration's own header for why relaxing this check here is
  -- safe).
  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only an Admin or super admin may process Terminal Dues payments as part of a payroll run';
  END IF;

  IF p_excluded_ids IS NOT NULL AND array_length(p_excluded_ids, 1) > 0 THEN
    IF p_exclusion_reason IS NULL OR btrim(p_exclusion_reason) = '' THEN
      RAISE EXCEPTION 'A reason is required to exclude an allocation from processing';
    END IF;
  END IF;

  SELECT value INTO v_month FROM system_settings WHERE tenant_id = v_tenant_id AND key = 'current_payroll_month';
  IF v_month IS NULL THEN
    RAISE EXCEPTION 'No active payroll month is configured for this tenant -- set one on the Payroll page first';
  END IF;

  -- Same lock key propose_terminal_due_allocation uses for this
  -- (tenant, month) -- see this function's header for why this must be
  -- acquired before any row lock below.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant_id::text || ':' || v_month, 0));

  v_batch_ref := 'TDPB-' || v_month || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  FOR v_alloc IN
    SELECT * FROM terminal_due_allocations
    WHERE tenant_id = v_tenant_id AND payroll_month = v_month AND status = 'approved'
    ORDER BY submitted_at ASC
    FOR UPDATE
  LOOP
    IF p_excluded_ids IS NOT NULL AND v_alloc.id = ANY(p_excluded_ids) THEN
      UPDATE terminal_due_allocations SET
        status = 'excluded',
        excluded_by = v_caller_id,
        excluded_at = NOW(),
        excluded_reason = p_exclusion_reason,
        revision_history = revision_history || jsonb_build_array(jsonb_build_object(
          'status', status, 'proposed_amount', proposed_amount, 'last_decided_amount', last_decided_amount,
          'rejection_reason', rejection_reason, 'recorded_at', updated_at
        )),
        updated_at = NOW()
      WHERE id = v_alloc.id;
      v_excluded_count := v_excluded_count + 1;
      CONTINUE;
    END IF;

    SELECT * INTO v_due FROM terminal_dues WHERE id = v_alloc.terminal_due_id FOR UPDATE;

    IF v_due IS NULL OR v_due.status <> 'approved' THEN
      RAISE EXCEPTION 'Cannot process: entitlement for allocation % is not an approved entitlement (status %) -- resolve this before retrying, or explicitly exclude this allocation with a reason', v_alloc.id, COALESCE(v_due.status, 'missing');
    END IF;

    IF EXISTS (SELECT 1 FROM terminal_due_revisions WHERE terminal_due_id = v_alloc.terminal_due_id AND status = 'pending') THEN
      RAISE EXCEPTION 'Cannot process: allocation % has a pending entitlement revision awaiting Admin review -- decide that revision first, or explicitly exclude this allocation with a reason', v_alloc.id;
    END IF;

    SELECT COALESCE(SUM(COALESCE(last_decided_amount, proposed_amount)), 0) INTO v_already_processed
    FROM terminal_due_allocations
    WHERE terminal_due_id = v_alloc.terminal_due_id AND status = 'processed';

    IF v_already_processed + v_alloc.proposed_amount > v_due.total_payable THEN
      RAISE EXCEPTION 'Cannot process: allocation % of % would bring this entitlement''s total processed to % against an approved entitlement of only % -- resolve this before retrying, or explicitly exclude this allocation with a reason', v_alloc.id, v_alloc.proposed_amount, (v_already_processed + v_alloc.proposed_amount), v_due.total_payable;
    END IF;

    UPDATE terminal_due_allocations SET
      status = 'processed',
      last_decided_amount = proposed_amount,
      processed_by = v_caller_id,
      processed_at = NOW(),
      processing_reference = v_batch_ref,
      revision_history = revision_history || jsonb_build_array(jsonb_build_object(
        'status', status, 'proposed_amount', proposed_amount, 'last_decided_amount', last_decided_amount,
        'rejection_reason', rejection_reason, 'recorded_at', updated_at
      )),
      updated_at = NOW()
    WHERE id = v_alloc.id;

    v_processed_count := v_processed_count + 1;
    v_total_amount := v_total_amount + v_alloc.proposed_amount;
  END LOOP;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'APPROVE', 'terminal_due_payroll_batch', v_batch_ref,
    jsonb_build_object('month', v_month),
    jsonb_build_object(
      'batch_reference', v_batch_ref, 'processed_count', v_processed_count, 'total_amount', v_total_amount,
      'excluded_count', v_excluded_count, 'excluded_ids', p_excluded_ids, 'excluded_reason', p_exclusion_reason
    )
  );

  RETURN jsonb_build_object(
    'success', true, 'month', v_month, 'batch_reference', v_batch_ref,
    'processed_count', v_processed_count, 'total_amount', v_total_amount, 'excluded_count', v_excluded_count
  );
END;
$$;

-- Re-stated for self-sufficiency -- unchanged from 20261027000000.
REVOKE ALL ON FUNCTION process_terminal_due_allocations_batch(UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_terminal_due_allocations_batch(UUID[], TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION process_terminal_due_allocations_batch(UUID[], TEXT) FROM authenticated;

-- ============================================================
-- PART 2: process_payroll_with_terminal_dues() -- the inclusion gate
-- changed from an individual TD-approval-permission check to the
-- Admin-class check already enforced at this function's own entry;
-- exclusion-selection keeps its own, separate, narrower check. Every
-- other line byte-for-byte unchanged from 20261028000000.
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

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- Unchanged from 20261028000000 -- only an Admin-class caller may
  -- commit payroll processing directly.
  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only an Admin or super admin may commit payroll processing directly -- submit a payroll processing request for Admin approval instead';
  END IF;

  SELECT value INTO v_system_month FROM system_settings WHERE tenant_id = v_tenant_id AND key = 'current_payroll_month';
  IF v_system_month IS NULL THEN
    RAISE EXCEPTION 'No active payroll month is configured for this tenant -- set one on the Payroll page first';
  END IF;
  IF p_month <> v_system_month THEN
    RAISE EXCEPTION 'Refusing to process: % is not the active payroll month (%) -- it may have changed since this page loaded; refresh and try again', p_month, v_system_month;
  END IF;

  -- ============================================================
  -- CHANGED (this migration): inclusion of already-approved Terminal
  -- Dues allocations is now unconditional for any Admin-class caller --
  -- the SAME authority already required just to reach this point. It no
  -- longer additionally requires has_explicit_permission('terminal_dues.
  -- approve') -- that narrower permission remains the correct bar for
  -- APPROVING/REJECTING an individual allocation (untouched RPCs) and,
  -- immediately below, for SELECTING an exclusion -- but not for
  -- processing payment on something someone else already approved. See
  -- this migration's own header for the full root-cause explanation.
  -- ============================================================
  IF p_td_excluded_ids IS NOT NULL AND array_length(p_td_excluded_ids, 1) > 0
     AND NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve'))
  THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may select Terminal Dues exclusions';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || p_month));
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant_id::text || ':' || p_month, 0));

  v_payroll_result := process_payroll_batch(p_month, p_records, p_user_email, p_audit_context);

  SELECT COALESCE(SUM(net_pay), 0) INTO v_ordinary_total
  FROM payroll
  WHERE tenant_id = v_tenant_id AND month = p_month
    AND employee_id = ANY(ARRAY(SELECT (r->>'employee_id')::UUID FROM jsonb_array_elements(p_records) AS r));

  SELECT EXISTS (
    SELECT 1 FROM terminal_due_allocations
    WHERE tenant_id = v_tenant_id AND payroll_month = p_month AND status = 'approved'
  ) INTO v_has_eligible_td;

  IF v_has_eligible_td OR (p_td_excluded_ids IS NOT NULL AND array_length(p_td_excluded_ids, 1) > 0) THEN
    v_td_result := process_terminal_due_allocations_batch(p_td_excluded_ids, p_td_exclusion_reason);
    v_td_total := COALESCE((v_td_result->>'total_amount')::NUMERIC, 0);
  END IF;

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
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- CREATE OR REPLACE FUNCTION and the
-- same REVOKE/GRANT statements every time. No table/column changes.
--
-- DEPENDENCIES: requires 20261026000000 (process_terminal_due_
-- allocations_batch), 20261027000000 (process_payroll_with_terminal_
-- dues, process_payroll_batch unchanged), 20261028000000 (the Admin-class
-- gate this migration's own entry check reuses), and is_business_admin()/
-- has_explicit_permission()/is_super_admin() (20260817000000/
-- 20260817000007/20260915000000).
--
-- PREFLIGHT: none needed -- CREATE OR REPLACE on two existing functions
-- and re-stated REVOKE/GRANT only. No table or existing row is altered;
-- no previously processed financial history changes.
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS:
--   - A caller who ALREADY holds terminal_dues.approve (or is a super
--     admin): ZERO behavior change -- they already passed the old,
--     narrower check, and still pass both checks now.
--   - A caller who is Admin-class (is_super_admin() OR is_business_
--     admin()) but does NOT hold terminal_dues.approve (the legacy-Admin
--     case this migration fixes): previously had eligible Terminal Dues
--     allocations SILENTLY SKIPPED on every combined run; now has them
--     INCLUDED, exactly as ordinary payroll already was. This is the
--     entire, intentional point of this migration.
--   - That same caller attempting to supply a non-empty
--     p_td_excluded_ids: previously a no-op (the whole Terminal Dues
--     block, exclusions included, was skipped silently); now an explicit
--     RAISE EXCEPTION, refusing the entire call (nothing commits) --
--     matches "return a clear error without committing either
--     component." The live UI never produces this input for such a
--     caller in the first place (the exclusion controls are gated client
--     side on the same terminal_dues.approve check, unchanged by this
--     migration), so this is a defense-in-depth path, not a change to any
--     normal user flow.
--   - An Accountant (or any non-Admin-class caller): unaffected -- still
--     refused at this function's own entry, before either of this
--     migration's two checks is even reached.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT prosrc LIKE '%is_business_admin()%' AND prosrc NOT LIKE '%v_has_td_permission%'
--   FROM pg_proc WHERE proname = 'process_payroll_with_terminal_dues';
--   -- expected: true
--   SELECT prosrc LIKE '%is_business_admin()%' FROM pg_proc
--   WHERE proname = 'process_terminal_due_allocations_batch';
--   -- expected: true
--   SELECT has_function_privilege('authenticated', 'process_terminal_due_allocations_batch(uuid[], text)', 'EXECUTE');
--   -- expected: false (still unreachable directly, unchanged)
--
-- ROLLBACK SQL (run this to fully revert this migration):
--   Re-apply 20261028000000's own CREATE OR REPLACE FUNCTION
--   process_payroll_with_terminal_dues block verbatim (restores
--   v_has_td_permission gating), then re-apply 20261026000000's own
--   CREATE OR REPLACE FUNCTION process_terminal_due_allocations_batch
--   block verbatim (restores the has_explicit_permission('terminal_dues.
--   approve') gate) -- SAFE at any time, since neither change this
--   migration makes alters any table or row, only two function bodies.
-- ============================================================
