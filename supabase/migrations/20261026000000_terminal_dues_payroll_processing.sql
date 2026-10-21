-- ============================================================
-- MIGRATION: Terminal Dues Phase 3A -- Process Payroll integration
-- Date: 2026-10-26
-- ============================================================
--
-- ARCHITECTURE FINDING THAT SHAPES EVERYTHING BELOW
-- -----------------------------------------------------------
-- Ordinary payroll's "Process Payroll" button already calls ONE atomic,
-- advisory-locked, idempotency-protected RPC: process_payroll_batch()
-- (20260803000002, extended in place by 20260813000001 for salary
-- advances -- that extension was justified specifically because an
-- advance deduction changes the SAME payroll row's net_pay, a tight
-- coupling). Terminal Dues allocations have NO such coupling: they are
-- an entirely separate payment stream (a termination entitlement, not a
-- salary deduction), living in a schema with no FK to `payroll` at all,
-- and -- critically -- `payroll.employee_id` is `NOT NULL REFERENCES
-- employees(id)`, so a historical-employee Terminal Dues subject
-- structurally CANNOT have a `payroll` row without fabricating a fake
-- employee record, which this phase's own instructions forbid outright.
--
-- Supabase RPC calls are independent HTTP round trips with no
-- client-side cross-call transaction, and there is no distributed-
-- transaction/saga infrastructure in this stack. Given that, and given
-- the FK/coupling mismatch above, this phase deliberately does NOT merge
-- Terminal Dues processing into process_payroll_batch() (that would mean
-- weakening a hardened, already-reviewed, already-tested financial
-- function's invariants, or faking payroll rows for historical
-- employees -- both rejected). Ordinary payroll and Terminal Dues
-- processing therefore CANNOT be committed as one Postgres transaction
-- through the existing architecture. This is the precise limitation
-- flagged for review, per this phase's own instructions, rather than
-- guessed past.
--
-- The smallest safe adjustment: Terminal Dues gets its OWN independent,
-- equally atomic RPC (process_terminal_due_allocations_batch(), below),
-- never touching `payroll`/`process_payroll_batch()` at all. The two are
-- sequenced from the UI (ordinary payroll first, unchanged; Terminal
-- Dues second), with a mandatory pre-validation pass that blocks BOTH
-- financial writes while any eligible allocation is invalid -- this
-- closes the realistic risk ("one bad allocation silently breaks
-- processing") even though true cross-RPC atomicity isn't achievable
-- without rearchitecting the whole payroll stack, which is out of this
-- phase's scope and was never asked for.
--
-- SCOPE BOUNDARY (preserved from every prior Terminal Dues phase)
-- -----------------------------------------------------------
-- This migration does NOT: generate a real payroll record for a
-- Terminal Dues subject, touch `payroll`/`payment_status` at all, claim
-- a bank transfer occurred, or let HR mark anything Settled directly.
-- "Processed" means "included in a Process Payroll run," nothing more --
-- a genuinely separate, later-reviewed concept (bank-payment
-- confirmation) is explicitly not built here; see this phase's final
-- report.
-- ============================================================

-- ============================================================
-- PART 1: schema -- processing/exclusion/carry-forward metadata
-- -----------------------------------------------------------
-- 'processed' already existed in the status CHECK (reserved since Phase
-- 2A specifically so this phase would not need to widen it) -- it was
-- simply never reachable until now. 'excluded' is new: a status
-- distinct from 'held' because held means "will resume automatically
-- once something else resolves" (an HR correction, a revision decision)
-- while excluded means "Admin deliberately set this aside with a
-- reason" and, per this phase's own carry-forward rule, requires a
-- BRAND NEW Admin decision in whatever month it's next carried into --
-- never silently resumed on its own.
-- ============================================================

ALTER TABLE terminal_due_allocations
  DROP CONSTRAINT IF EXISTS terminal_due_allocations_status_check;
ALTER TABLE terminal_due_allocations
  ADD CONSTRAINT terminal_due_allocations_status_check
    CHECK (status IN ('submitted', 'approved', 'rejected', 'held', 'processed', 'excluded'));

ALTER TABLE terminal_due_allocations
  ADD COLUMN IF NOT EXISTS processed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
  -- Traceable reference an Accounts export can reconcile against --
  -- generated once per Process-Payroll run and stamped on every
  -- allocation that run actually processed, so "which run produced this
  -- line" is always answerable from the ledger alone.
  ADD COLUMN IF NOT EXISTS processing_reference TEXT,
  ADD COLUMN IF NOT EXISTS excluded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS excluded_reason TEXT CHECK (excluded_reason IS NULL OR btrim(excluded_reason) <> ''),
  -- Traceability for carry-forward: the row this one was carried forward
  -- FROM, if any. NULL for an allocation proposed normally. The source
  -- row itself is never modified by carry-forward -- this column lives
  -- only on the NEW row it produced.
  ADD COLUMN IF NOT EXISTS carried_forward_from_id UUID REFERENCES terminal_due_allocations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_terminal_due_allocations_processing_reference ON terminal_due_allocations(processing_reference) WHERE processing_reference IS NOT NULL;

-- ============================================================
-- PART 2: process_terminal_due_allocations_batch()
-- -----------------------------------------------------------
-- Admin-initiated (same terminal_dues.approve bar every other Admin-side
-- Terminal Dues action already requires -- deliberately NOT role_level,
-- consistent with the separation-of-duties hardening from Phase 1.5,
-- not Payroll's older role_level=1 check). Reads the active payroll
-- month from system_settings itself (same pattern
-- propose_terminal_due_allocation already uses) -- never trusts a
-- client-supplied month.
--
-- ELIGIBILITY (what gets processed): every 'approved' allocation for the
-- active month, locked FOR UPDATE, is a candidate. Submitted, rejected,
-- held, already-processed, and already-excluded rows are never
-- candidates at all -- they are simply not matched by this WHERE clause,
-- so "never processed automatically" holds structurally, not by a
-- separate filter that could be forgotten.
--
-- VALIDATE-BEFORE-WRITE: every candidate not explicitly excluded in this
-- call is re-validated (entitlement still approved, no pending revision,
-- amount still within the entitlement's true outstanding balance) BEFORE
-- any row is written. If even one fails, the whole call raises and rolls
-- back -- nothing is processed, matching "if one allocation fails
-- validation, block processing... do not automatically skip it." Admin
-- must either fix the underlying problem (reject/correct the allocation
-- through the existing flows) or explicitly list its id in p_excluded_ids
-- (with a mandatory shared reason) and call again.
--
-- IDEMPOTENCY: calling this again after a successful run simply finds
-- zero remaining 'approved' candidates (everything is now 'processed' or
-- 'excluded') and returns a clean no-op result -- no error, no
-- duplicate-processing risk, by construction of the WHERE clause rather
-- than a separate "already ran" flag.
--
-- CONCURRENCY: the SAME (tenant, month) advisory lock key
-- propose_terminal_due_allocation already uses for the 50-person cap --
-- this serializes processing against any concurrent new proposal/
-- correction/approval for the same month, and against a second
-- concurrent processing attempt, with no possibility of two calls
-- double-counting the same allocation. Acquired BEFORE any row lock
-- (the canonical order established and deadlock-tested in Phase 2B).
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

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may process Terminal Dues payments';
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

REVOKE ALL ON FUNCTION process_terminal_due_allocations_batch(UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_terminal_due_allocations_batch(UUID[], TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION process_terminal_due_allocations_batch(UUID[], TEXT) TO authenticated;

-- ============================================================
-- PART 3: carry_forward_terminal_due_allocations()
-- -----------------------------------------------------------
-- Admin-initiated, explicit (never an automatic side effect of changing
-- current_payroll_month elsewhere in the app -- that would be exactly
-- the kind of invisible, surprising side effect this codebase's own
-- review history keeps flagging as a real-bug pattern). Carries every
-- NOT-yet-processed allocation -- submitted, rejected, held for an HR
-- correction, or explicitly excluded -- from p_from_month into p_to_month
-- as a BRAND NEW 'submitted' row -- never inheriting approval, exactly
-- per "preserve previous monetary decisions without silently granting
-- approval." 'approved' is deliberately NOT carried: it should already
-- have been processed or explicitly excluded by the time a month closes.
--
-- Deliberately EXCLUDED: a row held because of a PENDING ENTITLEMENT
-- REVISION (hold_reason = 'entitlement_revised'). That hold isn't about
-- this allocation's own amount -- it's the ENTITLEMENT's financial basis
-- being reconsidered, and the revision is not month-specific. Carrying
-- it forward would create a second, parallel row for the same
-- entitlement while the first is still mid-decision on an unrelated
-- axis. Left alone, Phase 2B's own revalidation restores the ORIGINAL
-- row (in its original month) the moment the revision is decided; it can
-- be carried forward on its own, in a LATER call, once that happens.
--
-- The SOURCE row is never modified -- its status, decision history, and
-- dates remain exactly as they were, permanently. carried_forward_from_id
-- on the new row is the traceable link back to it.
--
-- IDEMPOTENT: a terminal_due_id that already has a p_to_month row
-- (whether from an earlier carry-forward call or an ordinary new
-- proposal) is simply skipped, never duplicated -- the existing UNIQUE
-- (terminal_due_id, payroll_month) index is the hard backstop; this
-- function's own NOT EXISTS check avoids ever hitting it in the normal
-- case and produces a clean skipped-count instead of a constraint error.
--
-- CAPACITY: counts how many DISTINCT entitlements p_to_month would end
-- up with (existing + about to be carried in) and refuses the WHOLE call
-- if that exceeds 50 -- never silently drops a subset to fit. Admin must
-- resolve (process/exclude more of the existing p_to_month allocations
-- first, or choose a different target month) and retry.
-- ============================================================

CREATE OR REPLACE FUNCTION carry_forward_terminal_due_allocations(
  p_from_month TEXT,
  p_to_month TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_alloc RECORD;
  v_existing_in_to_month INTEGER;
  v_candidate_count INTEGER;
  v_carried_count INTEGER := 0;
  v_skipped_count INTEGER := 0;
  v_new_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may carry forward Terminal Dues allocations';
  END IF;

  IF p_from_month IS NULL OR p_to_month IS NULL OR p_from_month = p_to_month THEN
    RAISE EXCEPTION 'A distinct source and destination month are required';
  END IF;

  -- Same lock key the allocation RPCs use for the DESTINATION month --
  -- this serializes carry-forward against any concurrent new proposal
  -- for p_to_month, so the capacity check below is race-free.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant_id::text || ':' || p_to_month, 0));

  SELECT COUNT(DISTINCT terminal_due_id) INTO v_existing_in_to_month
  FROM terminal_due_allocations
  WHERE tenant_id = v_tenant_id AND payroll_month = p_to_month;

  SELECT COUNT(*) INTO v_candidate_count
  FROM terminal_due_allocations src
  WHERE src.tenant_id = v_tenant_id AND src.payroll_month = p_from_month
    AND (src.status IN ('submitted', 'rejected', 'excluded') OR (src.status = 'held' AND src.hold_reason = 'hr_correction'))
    AND NOT EXISTS (
      SELECT 1 FROM terminal_due_allocations dst
      WHERE dst.terminal_due_id = src.terminal_due_id AND dst.payroll_month = p_to_month
    );

  IF v_existing_in_to_month + v_candidate_count > 50 THEN
    RAISE EXCEPTION 'Cannot carry forward: % would bring % already past the maximum of 50 distinct employees for that month. Resolve (process/exclude) some of the existing allocations for % first, or choose a different destination month.', v_candidate_count, p_to_month, p_to_month;
  END IF;

  FOR v_alloc IN
    SELECT * FROM terminal_due_allocations
    WHERE tenant_id = v_tenant_id AND payroll_month = p_from_month
      AND (status IN ('submitted', 'rejected', 'excluded') OR (status = 'held' AND hold_reason = 'hr_correction'))
    ORDER BY submitted_at ASC
    FOR UPDATE
  LOOP
    IF EXISTS (SELECT 1 FROM terminal_due_allocations WHERE terminal_due_id = v_alloc.terminal_due_id AND payroll_month = p_to_month) THEN
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    INSERT INTO terminal_due_allocations (
      tenant_id, terminal_due_id, payroll_month, region_id, status, proposed_amount,
      carried_forward_from_id, submitted_by, submitted_at
    ) VALUES (
      v_tenant_id, v_alloc.terminal_due_id, p_to_month, v_alloc.region_id, 'submitted', v_alloc.proposed_amount,
      v_alloc.id, v_caller_id, NOW()
    ) RETURNING id INTO v_new_id;

    v_carried_count := v_carried_count + 1;
  END LOOP;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'CREATE', 'terminal_due_carry_forward', NULL,
    jsonb_build_object('from_month', p_from_month, 'to_month', p_to_month),
    jsonb_build_object('carried_count', v_carried_count, 'skipped_count', v_skipped_count)
  );

  RETURN jsonb_build_object(
    'success', true, 'from_month', p_from_month, 'to_month', p_to_month,
    'carried_count', v_carried_count, 'skipped_count', v_skipped_count
  );
END;
$$;

REVOKE ALL ON FUNCTION carry_forward_terminal_due_allocations(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION carry_forward_terminal_due_allocations(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION carry_forward_terminal_due_allocations(TEXT, TEXT) TO authenticated;
