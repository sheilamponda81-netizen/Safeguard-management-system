-- ============================================================
-- MIGRATION: Terminal Dues Phase 2B -- approved entitlement revisions
-- Date: 2026-10-24
-- ============================================================
--
-- SCOPE OF THIS PHASE
-- -----------------------------------------------------------
-- Phase 2A flagged "entitlement revision while unprocessed allocations
-- exist" as not implemented, because the only existing post-approval
-- correction path -- Admin's return_terminal_due_for_correction(),
-- which flips an approved terminal_dues row back to 'pending' with no
-- preserved financial snapshot -- combined with HR's
-- reopen_terminal_due_calculation() (only usable while the linked row is
-- 'pending'), is exactly the "reopened and overwritten as an ordinary
-- editable draft" pattern this phase's task explicitly forbids for an
-- already-approved entitlement. This migration adds a SEPARATE,
-- versioned revision-request entity (terminal_due_revisions) instead:
-- the approved terminal_dues row's status NEVER changes while a
-- revision is pending, proposed and current figures are both visible
-- side by side, and every past revision (accepted or not) is kept as a
-- permanent, immutable row -- never overwritten.
--
-- return_terminal_due_for_correction() itself is touched here only to
-- add one guard: it now refuses to run while a revision is pending for
-- that entitlement (PART 4) -- two different "fix an approved
-- entitlement" paths racing on the same row was a real gap, not
-- something to leave unaddressed.
--
-- This phase still does NOT integrate with Process Payroll, mark any
-- allocation "processed", or let an entitlement reach a Settled state --
-- see 20261023000000's header for that boundary, which is unchanged and
-- still fully enforced (nothing here sets terminal_dues.status or
-- terminal_due_allocations.status = 'processed').
-- ============================================================

-- ============================================================
-- PART 1: terminal_due_revisions -- versioned revision requests
-- -----------------------------------------------------------
-- One row per revision ATTEMPT (not per entitlement) -- `version` is a
-- simple per-entitlement sequence (1, 2, 3, ...) so the full lineage of
-- every revision ever proposed (approved, rejected, or still pending)
-- is reconstructable by listing all rows for a terminal_due_id in order.
-- Only one row may be 'pending' per entitlement at a time (partial
-- unique index below) -- "duplicate revision submissions" are refused at
-- the database layer, not just the RPC's own pre-check.
--
-- original_snapshot captures the entitlement's OWN financial columns
-- exactly as they stood immediately before THIS revision was proposed
-- (not necessarily the very first approved version -- if a prior
-- revision was already approved, this is that prior revision's
-- resulting figures). proposed_inputs/proposed_breakdown are the same
-- JSONB shapes terminal_due_calculations already uses (engine input
-- snapshot / TerminalDuesBreakdown) -- the identical calculation engine
-- and MWK rounding are reused, not re-implemented.
-- ============================================================

CREATE TABLE IF NOT EXISTS terminal_due_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  terminal_due_id UUID NOT NULL REFERENCES terminal_dues(id) ON DELETE CASCADE,
  -- Resolved from the entitlement's own subject at proposal time, same
  -- denormalization reason as terminal_due_allocations.region_id.
  region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  original_snapshot JSONB NOT NULL,
  proposed_inputs JSONB NOT NULL,
  proposed_breakdown JSONB NOT NULL,
  proposed_total_payable NUMERIC(14,2) NOT NULL CHECK (proposed_total_payable >= 0),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  rejection_reason TEXT,
  submitted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (terminal_due_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_due_revisions_one_pending
  ON terminal_due_revisions(terminal_due_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_terminal_due_revisions_terminal_due ON terminal_due_revisions(terminal_due_id);

ALTER TABLE terminal_due_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Terminal due revisions: read within tenant+region, terminal-dues role" ON terminal_due_revisions
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND (region_id IS NULL OR region_allowed(region_id))
      AND (
        has_explicit_permission('terminal_dues.view')
        OR has_explicit_permission('terminal_dues.create')
        OR has_explicit_permission('terminal_dues.edit')
        OR has_explicit_permission('terminal_dues.approve')
        OR has_explicit_permission('terminal_dues.pay')
      )
    )
  )
);

-- Same "no direct client write" idiom as terminal_due_allocations and
-- terminal_due_calculations -- every mutation goes through the RPCs below.
CREATE POLICY "Terminal due revisions: no direct client insert" ON terminal_due_revisions
FOR INSERT WITH CHECK (is_super_admin());

CREATE POLICY "Terminal due revisions: no direct client update" ON terminal_due_revisions
FOR UPDATE USING (is_super_admin()) WITH CHECK (is_super_admin());

-- No DELETE policy: default-deny -- immutable audit history, never deleted.

GRANT SELECT ON terminal_due_revisions TO authenticated;
GRANT INSERT, UPDATE ON terminal_due_revisions TO authenticated; -- gated to is_super_admin() by the policies above; the RPCs run as owner and are unaffected either way.

-- ============================================================
-- PART 2: propose_terminal_due_revision()
-- -----------------------------------------------------------
-- HR-initiated. Requires the entitlement to be currently 'approved'
-- (not 'pending' -- that already has reopen_terminal_due_calculation();
-- not 'paid' -- financially settled, out of scope). Takes the SAME
-- advisory lock key as every Phase 2A allocation RPC
-- (hashtextextended(terminal_due_id::text, 0)) -- this is what makes a
-- concurrent "propose a revision" and "approve/correct an allocation"
-- for the same entitlement mutually exclusive, not just the revision
-- table's own operations.
-- ============================================================

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
  -- propose/approve/reject_terminal_due_revision), confirmed necessary
  -- by empirically reproducing a deadlock during this migration's own
  -- testing when two functions raced in opposite lock orders.
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
  -- decided. A row already 'held' (e.g. mid HR-correction) is left
  -- exactly as it is -- it is already outside Admin's approval reach,
  -- and overwriting its hold_reason would lose that unrelated context.
  -- Processed amounts (none exist yet in this phase) are never touched.
  UPDATE terminal_due_allocations SET
    status = 'held',
    hold_reason = 'entitlement_revised',
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

REVOKE ALL ON FUNCTION propose_terminal_due_revision(UUID, JSONB, JSONB, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION propose_terminal_due_revision(UUID, JSONB, JSONB, NUMERIC, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION propose_terminal_due_revision(UUID, JSONB, JSONB, NUMERIC, TEXT) TO authenticated;

-- ============================================================
-- PART 3: shared allocation-revalidation helper
-- -----------------------------------------------------------
-- Used identically by approve_terminal_due_revision() (effective total =
-- the newly approved figure) and reject_terminal_due_revision()
-- (effective total = the entitlement's own unchanged total_payable).
-- Only rows this revision itself put on hold (hold_reason =
-- 'entitlement_revised') are touched -- an hr_correction-held row is
-- left alone; it already gets re-validated by
-- approve_terminal_due_allocation()'s own balance check whenever Admin
-- next acts on it, so nothing here needs to pre-empt that.
--
-- Oldest-submitted-first restoration order: a previously APPROVED
-- allocation is restored to 'approved' at its PRIOR decided amount only
-- if the running total of everything already restored this pass still
-- fits the effective total -- amounts are never silently reduced to
-- make them fit. One that no longer fits goes back to 'submitted': HR
-- must propose a corrected (smaller) amount through the ordinary
-- propose_terminal_due_allocation() path, and Admin must re-decide it,
-- exactly like any other correction. A row that was only ever
-- 'submitted' (never actually approved before this revision) simply
-- returns to 'submitted' -- the normal approval flow re-checks its
-- balance when Admin eventually acts on it, so there is nothing to
-- pre-validate for it here.
-- ============================================================

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
    IF v_alloc.last_decided_amount IS NOT NULL THEN
      v_candidate := v_alloc.last_decided_amount;
      IF v_running_sum + v_candidate <= p_effective_total THEN
        UPDATE terminal_due_allocations SET
          status = 'approved', proposed_amount = v_candidate, hold_reason = NULL, updated_at = NOW()
        WHERE id = v_alloc.id;
        v_running_sum := v_running_sum + v_candidate;
      ELSE
        UPDATE terminal_due_allocations SET
          status = 'submitted', hold_reason = NULL, updated_at = NOW()
        WHERE id = v_alloc.id;
      END IF;
    ELSE
      UPDATE terminal_due_allocations SET
        status = 'submitted', hold_reason = NULL, updated_at = NOW()
      WHERE id = v_alloc.id;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION revalidate_terminal_due_allocations_after_revision(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION revalidate_terminal_due_allocations_after_revision(UUID, NUMERIC) FROM anon;
REVOKE ALL ON FUNCTION revalidate_terminal_due_allocations_after_revision(UUID, NUMERIC) FROM authenticated;
-- Internal helper only -- called from within the two RPCs below (same
-- SECURITY DEFINER execution context), never directly by a client.

-- ============================================================
-- PART 4: approve_terminal_due_revision() / reject_terminal_due_revision()
-- -----------------------------------------------------------
-- Gated on terminal_dues.approve -- the SAME distinct Admin permission
-- entitlement and allocation approval already require, deliberately NOT
-- HR's create/edit -- HR can never approve its own revision.
-- ============================================================

CREATE OR REPLACE FUNCTION approve_terminal_due_revision(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_rev RECORD;
  v_due RECORD;
  v_processed_total NUMERIC;
  v_tdid UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may approve an entitlement revision';
  END IF;

  SELECT terminal_due_id INTO v_tdid FROM terminal_due_revisions WHERE id = p_id;
  IF v_tdid IS NULL THEN
    RAISE EXCEPTION 'Revision request not found';
  END IF;

  -- Advisory lock BEFORE any row lock this function takes (the revision
  -- row itself, the terminal_dues row, and every allocation row the
  -- revalidation helper below locks) -- same canonical order required of
  -- every function touching this entitlement; see
  -- propose_terminal_due_revision()'s comment for why.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tdid::text, 0));

  SELECT * INTO v_rev FROM terminal_due_revisions WHERE id = p_id FOR UPDATE;
  IF v_rev IS NULL OR (v_rev.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Revision request not found';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) AND v_rev.region_id IS NOT NULL AND NOT region_allowed(v_rev.region_id) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_rev.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending revision can be approved (this one is %)', v_rev.status;
  END IF;

  SELECT * INTO v_due FROM terminal_dues WHERE id = v_rev.terminal_due_id FOR UPDATE;

  -- Hard floor against an impossible negative operational balance: this
  -- phase never reaches 'processed' (always zero today), but the check
  -- is written against the real aggregate rather than a hardcoded zero
  -- so it keeps holding once a later phase starts setting that status --
  -- no further migration will be needed here to make it count for real.
  SELECT COALESCE(SUM(COALESCE(last_decided_amount, proposed_amount)), 0) INTO v_processed_total
  FROM terminal_due_allocations
  WHERE terminal_due_id = v_rev.terminal_due_id AND status = 'processed';

  IF v_rev.proposed_total_payable < v_processed_total THEN
    RAISE EXCEPTION 'Cannot approve -- the proposed total payable of % is less than the % already processed for this entitlement', v_rev.proposed_total_payable, v_processed_total;
  END IF;

  -- Apply the revision to the authoritative entitlement row. This is the
  -- only place in this feature that changes an APPROVED terminal_dues
  -- row's financial figures -- gated entirely behind this RPC's own
  -- checks above (SECURITY DEFINER bypasses the ordinary RLS UPDATE
  -- policy, which otherwise only ever permits a direct edit while
  -- status='pending', same as every other Terminal Dues RPC in this
  -- codebase). status/approved_by/approved_at/paid_* are deliberately
  -- left untouched -- the entitlement's APPROVAL stands; only the
  -- financial figures it was approved against change, and the prior
  -- figures remain permanently readable from this revision's own
  -- original_snapshot.
  UPDATE terminal_dues SET
    basic_salary = (v_rev.proposed_inputs->>'finalSalary')::numeric,
    period_months = (v_rev.proposed_breakdown->>'effectiveMonths')::integer,
    gratuity = (v_rev.proposed_breakdown->>'pensionArrears')::numeric,
    annual_leave = (v_rev.proposed_breakdown->>'annualLeaveRefund')::numeric,
    uniform_refund = (v_rev.proposed_breakdown->>'uniformRefund')::numeric,
    other_benefits = (v_rev.proposed_breakdown->>'outstandingSalaryTotal')::numeric,
    subtotal = (v_rev.proposed_breakdown->>'totalEntitlements')::numeric,
    deductions = (v_rev.proposed_breakdown->>'lessNoticeDeduction')::numeric,
    total_payable = v_rev.proposed_total_payable,
    date_joined = (v_rev.proposed_inputs->>'dateJoined')::date,
    date_left = (v_rev.proposed_inputs->>'dateLeft')::date,
    updated_at = NOW()
  WHERE id = v_rev.terminal_due_id;

  UPDATE terminal_due_revisions SET
    status = 'approved', decided_by = v_caller_id, decided_at = NOW(), updated_at = NOW()
  WHERE id = p_id;

  PERFORM revalidate_terminal_due_allocations_after_revision(v_rev.terminal_due_id, v_rev.proposed_total_payable);

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'APPROVE', 'terminal_due_revision', p_id::text,
    jsonb_build_object('status', 'pending', 'previous_total_payable', v_due.total_payable),
    jsonb_build_object('status', 'approved', 'decided_by', v_caller_id, 'new_total_payable', v_rev.proposed_total_payable)
  );

  RETURN jsonb_build_object('success', true, 'id', p_id, 'status', 'approved', 'new_total_payable', v_rev.proposed_total_payable);
END;
$$;

REVOKE ALL ON FUNCTION approve_terminal_due_revision(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_terminal_due_revision(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION approve_terminal_due_revision(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION reject_terminal_due_revision(
  p_id UUID,
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
  v_rev RECORD;
  v_due RECORD;
  v_tdid UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may reject an entitlement revision';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reject an entitlement revision';
  END IF;

  SELECT terminal_due_id INTO v_tdid FROM terminal_due_revisions WHERE id = p_id;
  IF v_tdid IS NULL THEN
    RAISE EXCEPTION 'Revision request not found';
  END IF;

  -- Advisory lock BEFORE any row lock this function takes -- see
  -- propose_terminal_due_revision()'s comment for the canonical order
  -- every function touching this entitlement must follow.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tdid::text, 0));

  SELECT * INTO v_rev FROM terminal_due_revisions WHERE id = p_id FOR UPDATE;
  IF v_rev IS NULL OR (v_rev.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Revision request not found';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) AND v_rev.region_id IS NOT NULL AND NOT region_allowed(v_rev.region_id) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_rev.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending revision can be rejected (this one is %)', v_rev.status;
  END IF;

  -- The entitlement itself is never touched on rejection -- it remains
  -- authoritative exactly as it was before this revision was proposed.
  SELECT * INTO v_due FROM terminal_dues WHERE id = v_rev.terminal_due_id FOR UPDATE;

  UPDATE terminal_due_revisions SET
    status = 'rejected', rejection_reason = p_reason, decided_by = v_caller_id, decided_at = NOW(), updated_at = NOW()
  WHERE id = p_id;

  PERFORM revalidate_terminal_due_allocations_after_revision(v_rev.terminal_due_id, v_due.total_payable);

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'REJECT', 'terminal_due_revision', p_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'rejected', 'decided_by', v_caller_id, 'rejection_reason', p_reason)
  );

  RETURN jsonb_build_object('success', true, 'id', p_id, 'status', 'rejected');
END;
$$;

REVOKE ALL ON FUNCTION reject_terminal_due_revision(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_terminal_due_revision(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION reject_terminal_due_revision(UUID, TEXT) TO authenticated;

-- ============================================================
-- PART 5: freeze allocation changes while a revision is pending
-- -----------------------------------------------------------
-- Defense in depth on top of PART 2's hold-sweep: even though the
-- advisory lock these four functions already share with the revision
-- RPCs rules out true concurrent interleaving, this guard makes the
-- freeze explicit and correct against any row that could otherwise slip
-- through (e.g. a new allocation proposed in a separate, later-committed
-- transaction while the revision is still pending). CREATE OR REPLACE
-- preserves every other line of each function's body byte-for-byte from
-- 20261023000000 -- only this one check is added, immediately after the
-- entitlement lock, before anything else.
-- ============================================================

CREATE OR REPLACE FUNCTION propose_terminal_due_allocation(
  p_terminal_due_id UUID,
  p_amount NUMERIC
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
  v_month TEXT;
  v_region_id UUID;
  v_existing RECORD;
  v_existing_found BOOLEAN;
  v_other_reserved NUMERIC;
  v_outstanding NUMERIC;
  v_monthly_count INTEGER;
  v_new_id UUID;
  v_previous_version JSONB;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.create') OR has_explicit_permission('terminal_dues.edit')) THEN
    RAISE EXCEPTION 'Only an explicitly granted Terminal Dues create/edit role (or a super admin) may propose a payment allocation';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Proposed allocation amount must be greater than zero';
  END IF;

  SELECT value INTO v_month FROM system_settings WHERE tenant_id = v_tenant_id AND key = 'current_payroll_month';
  IF v_month IS NULL THEN
    RAISE EXCEPTION 'No active payroll month is configured for this tenant -- set one on the Payroll page first';
  END IF;

  -- Advisory lock BEFORE any row lock this function takes (the
  -- terminal_dues row below, and the allocation row further down) --
  -- same canonical order required of every function touching this
  -- entitlement (propose/correct/approve/reject_terminal_due_allocation
  -- and propose/approve/reject_terminal_due_revision); see
  -- propose_terminal_due_revision()'s comment for why this is mandatory,
  -- not just a performance tweak.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_terminal_due_id::text, 0));

  SELECT * INTO v_due FROM terminal_dues WHERE id = p_terminal_due_id FOR UPDATE;

  IF v_due IS NULL OR (v_due.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due record not found';
  END IF;

  IF EXISTS (SELECT 1 FROM terminal_due_revisions WHERE terminal_due_id = p_terminal_due_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This entitlement has a pending revision awaiting Admin review -- allocation changes are frozen until it is decided';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) AND v_due.employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_due.employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  IF v_due.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an Admin-approved entitlement can receive a payment allocation (this one is %)', v_due.status;
  END IF;

  v_region_id := NULL;
  IF v_due.employee_id IS NOT NULL THEN
    SELECT region_id INTO v_region_id FROM employees WHERE id = v_due.employee_id;
  END IF;

  SELECT * INTO v_existing FROM terminal_due_allocations WHERE terminal_due_id = p_terminal_due_id AND payroll_month = v_month FOR UPDATE;
  -- Capture FOUND immediately: the next statement is itself a SELECT
  -- INTO, which would overwrite FOUND before the branch below reads it
  -- (the same composite-record/FOUND pitfall fixed in Phase 1.5's
  -- reopen_terminal_due_calculation()).
  v_existing_found := FOUND;

  SELECT COALESCE(SUM(proposed_amount), 0) INTO v_other_reserved
  FROM terminal_due_allocations
  WHERE terminal_due_id = p_terminal_due_id
    AND status IN ('submitted', 'approved', 'held')
    AND (NOT v_existing_found OR id <> v_existing.id);

  -- Nothing has ever been processed yet (that concept does not exist
  -- until a later phase), so the outstanding balance is simply the
  -- entitlement's own approved total_payable.
  v_outstanding := v_due.total_payable;

  IF v_other_reserved + p_amount > v_outstanding THEN
    RAISE EXCEPTION 'Proposed allocation of % exceeds the available outstanding balance -- % is already reserved by other pending/approved/held allocations against an entitlement of %', p_amount, v_other_reserved, v_outstanding;
  END IF;

  IF v_existing_found THEN
    -- This entitlement already has a row for this month -- correcting a
    -- rejected proposal, or adjusting one Admin has not yet decided.
    IF v_existing.status NOT IN ('submitted', 'rejected') THEN
      RAISE EXCEPTION 'Cannot directly re-propose a % allocation -- an approved allocation must go through correct_terminal_due_allocation() instead', v_existing.status;
    END IF;

    v_previous_version := jsonb_build_object(
      'status', v_existing.status,
      'proposed_amount', v_existing.proposed_amount,
      'last_decided_amount', v_existing.last_decided_amount,
      'rejection_reason', v_existing.rejection_reason,
      'recorded_at', v_existing.updated_at
    );

    UPDATE terminal_due_allocations SET
      status = 'submitted',
      proposed_amount = p_amount,
      hold_reason = NULL,
      rejection_reason = NULL,
      revision_history = v_existing.revision_history || jsonb_build_array(v_previous_version),
      submitted_by = v_caller_id,
      submitted_at = NOW(),
      updated_at = NOW()
    WHERE id = v_existing.id;

    v_new_id := v_existing.id;
  ELSE
    -- Brand-new allocation for this entitlement+month -- enforce the
    -- 50-distinct-employees-per-month cap, serialized per (tenant, month).
    PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant_id::text || ':' || v_month, 0));

    SELECT COUNT(DISTINCT terminal_due_id) INTO v_monthly_count
    FROM terminal_due_allocations
    WHERE tenant_id = v_tenant_id AND payroll_month = v_month;

    IF v_monthly_count >= 50 THEN
      RAISE EXCEPTION 'This payroll month already has the maximum 50 employees selected for Terminal Dues allocation';
    END IF;

    INSERT INTO terminal_due_allocations (
      tenant_id, terminal_due_id, payroll_month, region_id, status, proposed_amount, submitted_by, submitted_at
    ) VALUES (
      v_tenant_id, p_terminal_due_id, v_month, v_region_id, 'submitted', p_amount, v_caller_id, NOW()
    ) RETURNING id INTO v_new_id;
  END IF;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'SUBMIT', 'terminal_due_allocation', v_new_id::text,
    jsonb_build_object('terminal_due_id', p_terminal_due_id, 'payroll_month', v_month),
    jsonb_build_object('status', 'submitted', 'proposed_amount', p_amount)
  );

  RETURN jsonb_build_object('success', true, 'id', v_new_id, 'status', 'submitted', 'payroll_month', v_month);
END;
$$;

CREATE OR REPLACE FUNCTION correct_terminal_due_allocation(
  p_id UUID,
  p_new_amount NUMERIC
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
  v_due RECORD;
  v_other_reserved NUMERIC;
  v_outstanding NUMERIC;
  v_previous_version JSONB;
  v_tdid UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.create') OR has_explicit_permission('terminal_dues.edit')) THEN
    RAISE EXCEPTION 'Only an explicitly granted Terminal Dues create/edit role (or a super admin) may correct a payment allocation';
  END IF;

  IF p_new_amount IS NULL OR p_new_amount <= 0 THEN
    RAISE EXCEPTION 'Corrected allocation amount must be greater than zero';
  END IF;

  SELECT terminal_due_id INTO v_tdid FROM terminal_due_allocations WHERE id = p_id;
  IF v_tdid IS NULL THEN
    RAISE EXCEPTION 'Allocation not found';
  END IF;

  -- Acquire the entitlement-wide advisory lock BEFORE taking any row
  -- lock on this allocation -- every function that can touch this
  -- entitlement's allocations (propose/correct/approve/reject_terminal_
  -- due_allocation and propose/approve/reject_terminal_due_revision)
  -- must acquire locks in this SAME order (advisory lock first, specific
  -- row locks after), or two of them racing in opposite orders can
  -- deadlock -- confirmed empirically while testing this migration, where
  -- propose_terminal_due_revision's advisory-lock-then-bulk-row-lock
  -- hold-sweep raced against this function's old row-lock-then-advisory-
  -- lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tdid::text, 0));

  SELECT * INTO v_alloc FROM terminal_due_allocations WHERE id = p_id FOR UPDATE;
  IF v_alloc IS NULL OR (v_alloc.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Allocation not found';
  END IF;

  IF EXISTS (SELECT 1 FROM terminal_due_revisions WHERE terminal_due_id = v_alloc.terminal_due_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This entitlement has a pending revision awaiting Admin review -- allocation changes are frozen until it is decided';
  END IF;

  IF NOT is_super_admin() AND v_alloc.region_id IS NOT NULL AND NOT region_allowed(v_alloc.region_id) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_alloc.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved allocation can be corrected (this one is %)', v_alloc.status;
  END IF;

  SELECT * INTO v_due FROM terminal_dues WHERE id = v_alloc.terminal_due_id;

  SELECT COALESCE(SUM(proposed_amount), 0) INTO v_other_reserved
  FROM terminal_due_allocations
  WHERE terminal_due_id = v_alloc.terminal_due_id
    AND status IN ('submitted', 'approved', 'held')
    AND id <> v_alloc.id;

  v_outstanding := v_due.total_payable;

  IF v_other_reserved + p_new_amount > v_outstanding THEN
    RAISE EXCEPTION 'Corrected allocation of % exceeds the available outstanding balance -- % is already reserved by other pending/approved/held allocations against an entitlement of %', p_new_amount, v_other_reserved, v_outstanding;
  END IF;

  v_previous_version := jsonb_build_object(
    'status', v_alloc.status,
    'proposed_amount', v_alloc.proposed_amount,
    'last_decided_amount', v_alloc.last_decided_amount,
    'rejection_reason', v_alloc.rejection_reason,
    'recorded_at', v_alloc.updated_at
  );

  UPDATE terminal_due_allocations SET
    status = 'held',
    proposed_amount = p_new_amount,
    hold_reason = 'hr_correction',
    revision_history = v_alloc.revision_history || jsonb_build_array(v_previous_version),
    updated_at = NOW()
  WHERE id = p_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'UPDATE', 'terminal_due_allocation', p_id::text,
    jsonb_build_object('status', 'approved', 'proposed_amount', v_alloc.proposed_amount),
    jsonb_build_object('status', 'held', 'proposed_amount', p_new_amount)
  );

  RETURN jsonb_build_object('success', true, 'id', p_id, 'status', 'held');
END;
$$;

CREATE OR REPLACE FUNCTION approve_terminal_due_allocation(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_alloc RECORD;
  v_due RECORD;
  v_other_reserved NUMERIC;
  v_outstanding NUMERIC;
  v_previous_version JSONB;
  v_tdid UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may approve a payment allocation';
  END IF;

  SELECT terminal_due_id INTO v_tdid FROM terminal_due_allocations WHERE id = p_id;
  IF v_tdid IS NULL THEN
    RAISE EXCEPTION 'Allocation not found';
  END IF;

  -- Advisory lock BEFORE any row lock on this allocation -- see
  -- correct_terminal_due_allocation()'s comment above for why this order
  -- is mandatory across every function touching this entitlement.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tdid::text, 0));

  SELECT * INTO v_alloc FROM terminal_due_allocations WHERE id = p_id FOR UPDATE;
  IF v_alloc IS NULL OR (v_alloc.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Allocation not found';
  END IF;

  IF EXISTS (SELECT 1 FROM terminal_due_revisions WHERE terminal_due_id = v_alloc.terminal_due_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This entitlement has a pending revision awaiting Admin review -- allocation changes are frozen until it is decided';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) AND v_alloc.region_id IS NOT NULL AND NOT region_allowed(v_alloc.region_id) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_alloc.status NOT IN ('submitted', 'held') THEN
    RAISE EXCEPTION 'Only a submitted or held allocation can be approved (this one is %)', v_alloc.status;
  END IF;

  -- Re-validate the balance at approval time too (defense in depth: other
  -- allocations against the SAME entitlement may have changed between
  -- this row's submission and now).
  SELECT * INTO v_due FROM terminal_dues WHERE id = v_alloc.terminal_due_id;

  SELECT COALESCE(SUM(proposed_amount), 0) INTO v_other_reserved
  FROM terminal_due_allocations
  WHERE terminal_due_id = v_alloc.terminal_due_id
    AND status IN ('submitted', 'approved', 'held')
    AND id <> v_alloc.id;

  v_outstanding := v_due.total_payable;

  IF v_other_reserved + v_alloc.proposed_amount > v_outstanding THEN
    RAISE EXCEPTION 'Cannot approve -- this allocation of % would exceed the available outstanding balance (% already reserved against an entitlement of %); ask HR to correct it first', v_alloc.proposed_amount, v_other_reserved, v_outstanding;
  END IF;

  v_previous_version := jsonb_build_object(
    'status', v_alloc.status,
    'proposed_amount', v_alloc.proposed_amount,
    'last_decided_amount', v_alloc.last_decided_amount,
    'rejection_reason', v_alloc.rejection_reason,
    'recorded_at', v_alloc.updated_at
  );

  UPDATE terminal_due_allocations SET
    status = 'approved',
    last_decided_amount = v_alloc.proposed_amount,
    hold_reason = NULL,
    rejection_reason = NULL,
    revision_history = v_alloc.revision_history || jsonb_build_array(v_previous_version),
    decided_by = v_caller_id,
    decided_at = NOW(),
    updated_at = NOW()
  WHERE id = p_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'APPROVE', 'terminal_due_allocation', p_id::text,
    jsonb_build_object('status', v_alloc.status),
    jsonb_build_object('status', 'approved', 'decided_by', v_caller_id, 'amount', v_alloc.proposed_amount)
  );

  RETURN jsonb_build_object('success', true, 'id', p_id, 'status', 'approved');
END;
$$;

CREATE OR REPLACE FUNCTION reject_terminal_due_allocation(
  p_id UUID,
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
  v_alloc RECORD;
  v_previous_version JSONB;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may reject a payment allocation';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reject an allocation';
  END IF;

  SELECT * INTO v_alloc FROM terminal_due_allocations WHERE id = p_id FOR UPDATE;
  IF v_alloc IS NULL OR (v_alloc.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Allocation not found';
  END IF;

  IF EXISTS (SELECT 1 FROM terminal_due_revisions WHERE terminal_due_id = v_alloc.terminal_due_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This entitlement has a pending revision awaiting Admin review -- allocation changes are frozen until it is decided';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) AND v_alloc.region_id IS NOT NULL AND NOT region_allowed(v_alloc.region_id) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_alloc.status NOT IN ('submitted', 'held') THEN
    RAISE EXCEPTION 'Only a submitted or held allocation can be rejected (this one is %)', v_alloc.status;
  END IF;

  v_previous_version := jsonb_build_object(
    'status', v_alloc.status,
    'proposed_amount', v_alloc.proposed_amount,
    'last_decided_amount', v_alloc.last_decided_amount,
    'rejection_reason', v_alloc.rejection_reason,
    'recorded_at', v_alloc.updated_at
  );

  -- proposed_amount and last_decided_amount are left exactly as they
  -- were -- a rejection does not erase what was proposed/previously
  -- decided, only marks it rejected and records why. The row itself is
  -- never deleted, so "keep the employee's place in the monthly 50-person
  -- limit" holds automatically: the UNIQUE (terminal_due_id,
  -- payroll_month) row still exists and still counts.
  UPDATE terminal_due_allocations SET
    status = 'rejected',
    hold_reason = NULL,
    rejection_reason = p_reason,
    revision_history = v_alloc.revision_history || jsonb_build_array(v_previous_version),
    decided_by = v_caller_id,
    decided_at = NOW(),
    updated_at = NOW()
  WHERE id = p_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'REJECT', 'terminal_due_allocation', p_id::text,
    jsonb_build_object('status', v_alloc.status),
    jsonb_build_object('status', 'rejected', 'decided_by', v_caller_id, 'rejection_reason', p_reason)
  );

  RETURN jsonb_build_object('success', true, 'id', p_id, 'status', 'rejected');
END;
$$;

-- ============================================================
-- PART 6: return_terminal_due_for_correction() -- one added guard
-- -----------------------------------------------------------
-- Everything below is byte-for-byte unchanged from 20261022000000's
-- version EXCEPT the single new EXISTS check immediately after the
-- status='approved' check: Admin's older "flip back to pending" path
-- must not race against -- or silently discard -- an HR-initiated
-- revision request that is still awaiting a decision.
-- ============================================================

CREATE OR REPLACE FUNCTION return_terminal_due_for_correction(
  p_terminal_due_id UUID,
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
  v_caller_name TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may return a terminal due for correction';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to return a terminal due for correction';
  END IF;

  SELECT * INTO v_due FROM terminal_dues WHERE id = p_terminal_due_id FOR UPDATE;

  IF v_due IS NULL OR (v_due.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due record not found';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) AND v_due.employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_due.employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  IF v_due.status = 'paid' THEN
    RAISE EXCEPTION 'Cannot return a paid terminal due for correction';
  END IF;
  IF v_due.status <> 'approved' THEN
    RAISE EXCEPTION 'Cannot return a % terminal due for correction -- only an approved calculation can be returned', v_due.status;
  END IF;

  IF EXISTS (SELECT 1 FROM terminal_due_revisions WHERE terminal_due_id = p_terminal_due_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This entitlement has a pending revision awaiting Admin review -- decide that revision first (approve or reject it) before using return-for-correction';
  END IF;

  SELECT full_name INTO v_caller_name FROM profiles WHERE id = v_caller_id;

  UPDATE terminal_dues SET
    status = 'pending',
    approved_by = NULL,
    approved_at = NULL,
    returned_by = v_caller_id,
    returned_by_name = v_caller_name,
    returned_at = NOW(),
    return_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_terminal_due_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'UPDATE', 'terminal_due', p_terminal_due_id::text,
    jsonb_build_object('status', 'approved', 'approved_by', v_due.approved_by),
    jsonb_build_object('status', 'pending', 'returned_by', v_caller_id, 'return_reason', p_reason)
  );

  RETURN jsonb_build_object('success', true, 'id', p_terminal_due_id, 'status', 'pending');
END;
$$;
