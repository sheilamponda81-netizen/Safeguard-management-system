-- ============================================================
-- MIGRATION: Terminal Dues Phase 2B safety fix -- allocation
-- restoration must not infer "was approved" from last_decided_amount
-- Date: 2026-10-25
-- ============================================================
--
-- THE BUG (confirmed by reproducing it against a disposable local
-- Postgres before writing this fix, not assumed)
-- -----------------------------------------------------------
-- revalidate_terminal_due_allocations_after_revision() (20261024000000)
-- decided whether a held allocation had previously been APPROVED by
-- checking `last_decided_amount IS NOT NULL`. That column is set once,
-- the first time an allocation is ever approved, and is never cleared
-- afterwards -- so it is a record of "was this row EVER approved at some
-- point in its history," not "was this row's CURRENT held state reached
-- FROM 'approved'."
--
-- Those two things diverge the moment a row goes through a full
-- approve -> HR-correct -> Admin-reject-the-correction -> HR-resubmit
-- cycle (all four steps are ordinary, legitimate RPC calls): after the
-- correction is rejected and HR resubmits a fresh amount,
-- propose_terminal_due_allocation() correctly moves the row to
-- 'submitted' (awaiting a brand-new Admin decision) but has no reason to
-- touch the now-stale last_decided_amount left over from the earlier,
-- already-superseded approval. If an entitlement revision is then
-- proposed while that row sits in this perfectly ordinary 'submitted'
-- state, the hold-sweep correctly holds it -- but when the revision is
-- later approved or rejected, the revalidation helper saw a non-NULL
-- last_decided_amount and wrongly concluded the row had been approved,
-- silently restoring it to 'approved' using the STALE prior amount --
-- not the fresh, still-Admin-undecided resubmission -- with no Admin
-- action on that resubmission at all. Reproduced exactly end-to-end
-- against a disposable local Postgres: approve(100000) -> correct(150000)
-- -> reject the correction -> resubmit(120000) -> propose a revision ->
-- approve the revision => the allocation ended up 'approved' at 100000,
-- silently discarding the pending 120000 decision.
--
-- THE FIX
-- -----------------------------------------------------------
-- Stop inferring the pre-hold state after the fact. Record it directly,
-- at the moment of holding, in a new column (`pre_hold_status`) that
-- captures nothing but "was this row literally 'submitted' or literally
-- 'approved' the instant this revision put it on hold" -- a fact, not an
-- inference. The hold-sweep in propose_terminal_due_revision() now
-- writes it; the restoration loop in
-- revalidate_terminal_due_allocations_after_revision() now branches on
-- it instead of last_decided_amount's nullness. last_decided_amount
-- itself is untouched and still exactly what it always was: the amount
-- from the most recent Admin decision, independent of whatever HR is
-- currently proposing.
--
-- This also directly satisfies the business rules re-confirmed for this
-- safety pass: a previously-approved allocation returns to approved only
-- if it is still financially valid (unchanged); a previously-submitted
-- or previously-rejected-then-resubmitted allocation can NEVER become
-- 'approved' purely from a revision decision -- it always returns to
-- 'submitted' and still requires an actual Admin approval action; an
-- allocation held for an unrelated reason (hr_correction) is still never
-- touched by this helper at all (unchanged from 20261024000000); and
-- 'processed' allocations are still never matched by either function's
-- WHERE clauses (unchanged).
-- ============================================================

ALTER TABLE terminal_due_allocations
  ADD COLUMN pre_hold_status TEXT CHECK (pre_hold_status IS NULL OR pre_hold_status IN ('submitted', 'approved'));

-- ------------------------------------------------------------
-- propose_terminal_due_revision(): identical to 20261024000000 except
-- the hold-sweep UPDATE now also records pre_hold_status = the row's
-- OWN current status (read per-row, before this same UPDATE overwrites
-- it to 'held' -- ordinary Postgres UPDATE semantics: the SET list's
-- right-hand expressions see the pre-UPDATE row, same as
-- revision_history's own bare-column append already relies on).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION propose_terminal_due_revision(
  p_terminal_due_id UUID,
  p_inputs JSONB,
  p_breakdown JSONB,
  p_total_payable NUMERIC,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_due RECORD;
  v_region_id UUID;
  v_new_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.create') OR has_explicit_permission('terminal_dues.edit')) THEN
    RAISE EXCEPTION 'Only an explicitly granted Terminal Dues create/edit role (or a super admin) may propose an entitlement revision';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to propose an entitlement revision';
  END IF;

  IF p_total_payable IS NULL OR p_total_payable < 0 THEN
    RAISE EXCEPTION 'Proposed total payable must be zero or greater';
  END IF;

  -- Advisory lock BEFORE any row lock this function will take (the
  -- terminal_dues row below, and the bulk hold-sweep UPDATE on
  -- terminal_due_allocations further down) -- the same canonical order
  -- every function touching this entitlement's rows must use
  -- (propose/correct/approve/reject_terminal_due_allocation and
  -- propose/approve/reject_terminal_due_revision); confirmed necessary
  -- by empirically reproducing a deadlock during Phase 2B's own testing
  -- when two functions raced in opposite lock orders.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_terminal_due_id::text, 0));

  SELECT * INTO v_due FROM terminal_dues WHERE id = p_terminal_due_id FOR UPDATE;

  IF v_due IS NULL OR (v_due.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due record not found';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) AND v_due.employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_due.employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  IF v_due.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an Admin-approved entitlement can have a revision proposed (this one is %)', v_due.status;
  END IF;

  v_region_id := NULL;
  IF v_due.employee_id IS NOT NULL THEN
    SELECT region_id INTO v_region_id FROM employees WHERE id = v_due.employee_id;
  END IF;

  BEGIN
    INSERT INTO terminal_due_revisions (
      tenant_id, terminal_due_id, region_id, version, status,
      original_snapshot, proposed_inputs, proposed_breakdown, proposed_total_payable,
      reason, submitted_by, submitted_at
    ) VALUES (
      v_tenant_id, p_terminal_due_id, v_region_id,
      (SELECT COALESCE(MAX(version), 0) + 1 FROM terminal_due_revisions WHERE terminal_due_id = p_terminal_due_id),
      'pending',
      jsonb_build_object(
        'period_months', v_due.period_months, 'basic_salary', v_due.basic_salary,
        'gratuity', v_due.gratuity, 'annual_leave', v_due.annual_leave,
        'uniform_refund', v_due.uniform_refund, 'other_benefits', v_due.other_benefits,
        'subtotal', v_due.subtotal, 'deductions', v_due.deductions,
        'total_payable', v_due.total_payable, 'date_joined', v_due.date_joined, 'date_left', v_due.date_left
      ),
      p_inputs, p_breakdown, p_total_payable, p_reason, v_caller_id, NOW()
    ) RETURNING id INTO v_new_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This entitlement already has a pending revision awaiting Admin review';
  END;

  -- Hold every unprocessed allocation: a 'submitted' or 'approved' row is
  -- frozen (ineligible for Admin approval) until this revision is
  -- decided. pre_hold_status records EXACTLY which of the two it was --
  -- this is the fact revalidate_terminal_due_allocations_after_revision()
  -- now uses to decide how to restore it, instead of inferring it from
  -- last_decided_amount (see this migration's header for why that
  -- inference was wrong). A row already 'held' (e.g. mid HR-correction)
  -- is left exactly as it is -- it is already outside Admin's approval
  -- reach, and overwriting its hold_reason/pre_hold_status would lose
  -- that unrelated context. Processed amounts (none exist yet in this
  -- phase) are never touched.
  UPDATE terminal_due_allocations SET
    status = 'held',
    hold_reason = 'entitlement_revised',
    pre_hold_status = status,
    revision_history = revision_history || jsonb_build_array(jsonb_build_object(
      'status', status, 'proposed_amount', proposed_amount, 'last_decided_amount', last_decided_amount,
      'rejection_reason', rejection_reason, 'recorded_at', updated_at
    )),
    updated_at = NOW()
  WHERE terminal_due_id = p_terminal_due_id AND status IN ('submitted', 'approved');

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'SUBMIT', 'terminal_due_revision', v_new_id::text,
    jsonb_build_object('terminal_due_id', p_terminal_due_id, 'current_total_payable', v_due.total_payable),
    jsonb_build_object('proposed_total_payable', p_total_payable, 'reason', p_reason)
  );

  RETURN jsonb_build_object('success', true, 'id', v_new_id, 'status', 'pending');
END;
$$;

-- ------------------------------------------------------------
-- revalidate_terminal_due_allocations_after_revision(): branches on the
-- recorded pre_hold_status fact instead of inferring it from
-- last_decided_amount's nullness.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION revalidate_terminal_due_allocations_after_revision(
  p_terminal_due_id UUID,
  p_effective_total NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_alloc RECORD;
  v_running_sum NUMERIC := 0;
  v_candidate NUMERIC;
BEGIN
  FOR v_alloc IN
    SELECT * FROM terminal_due_allocations
    WHERE terminal_due_id = p_terminal_due_id AND hold_reason = 'entitlement_revised'
    ORDER BY submitted_at ASC
    FOR UPDATE
  LOOP
    IF v_alloc.pre_hold_status = 'approved' THEN
      -- This row was genuinely 'approved' the instant it was held --
      -- last_decided_amount is guaranteed fresh here (it is set in the
      -- same statement that ever transitions a row TO 'approved', so
      -- nothing could have gone stale between that transition and this
      -- hold). Restore to 'approved' at that exact amount only if it
      -- still fits; otherwise it genuinely needs HR correction.
      v_candidate := v_alloc.last_decided_amount;
      IF v_running_sum + v_candidate <= p_effective_total THEN
        UPDATE terminal_due_allocations SET
          status = 'approved', proposed_amount = v_candidate, hold_reason = NULL, pre_hold_status = NULL, updated_at = NOW()
        WHERE id = v_alloc.id;
        v_running_sum := v_running_sum + v_candidate;
      ELSE
        UPDATE terminal_due_allocations SET
          status = 'submitted', hold_reason = NULL, pre_hold_status = NULL, updated_at = NOW()
        WHERE id = v_alloc.id;
      END IF;
    ELSE
      -- pre_hold_status = 'submitted' (or, defensively, anything else):
      -- this row was awaiting a FRESH Admin decision the instant it was
      -- held -- whatever last_decided_amount holds is leftover from a
      -- prior, already-superseded cycle and is never used here. It
      -- always returns to 'submitted', never 'approved', regardless of
      -- whether its proposed_amount would fit -- the ordinary approval
      -- flow (approve_terminal_due_allocation) re-checks that balance
      -- itself the moment Admin actually decides it, which is the only
      -- place that decision may be made.
      UPDATE terminal_due_allocations SET
        status = 'submitted', hold_reason = NULL, pre_hold_status = NULL, updated_at = NOW()
      WHERE id = v_alloc.id;
    END IF;
  END LOOP;
END;
$$;
