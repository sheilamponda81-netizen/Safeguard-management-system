-- ============================================================
-- MIGRATION: Close the legacy Terminal Dues direct-payment /
-- allocation-ledger double-payment gap.
-- Date: 2026-11-28
-- ============================================================
--
-- CONFIRMED ROOT CAUSE (reproduced empirically on a disposable Postgres
-- running the real, unmodified migration chain from main -- unrelated
-- to, and independent of, PR #73/employee_exits):
--
-- record_terminal_due_payment()'s only existing guard
-- (20261021000001_terminal_dues_legacy_payment_guard.sql) checks ONLY
-- whether a terminal_due_calculations row points back to this
-- terminal_dues row (the "modern calculator" backlink). It never looks
-- at terminal_due_allocations at all. Meanwhile terminal_dues.status
-- stays 'approved' for the entire lifetime of the allocation ledger --
-- process_terminal_due_allocations_batch() never updates it, by design
-- (see 20261026000000_terminal_dues_payroll_processing.sql's own
-- header: "'processed' means 'included in a Process Payroll run,'
-- nothing more"). The REVERSE direction is already safe and required no
-- change: propose_terminal_due_allocation() requires v_due.status =
-- 'approved' (so it already refuses to touch a 'paid' entitlement), and
-- process_terminal_due_allocations_batch() independently re-checks
-- v_due.status = 'approved' again at its own commit time (so even a
-- stray already-approved allocation sitting on a meanwhile-paid
-- entitlement is caught and refused there, not silently processed).
-- The ONE open direction is: allocate (submit, approve, or even fully
-- process through a real payroll run) first, THEN call
-- record_terminal_due_payment() directly on the SAME still-'approved'
-- terminal_dues row -- nothing stops that second, separate payment from
-- succeeding, crediting the same entitlement twice through two
-- different mechanisms.
--
-- CONCRETE REPRODUCTION (confirmed live, fixtures discarded, not
-- committed):
--   approve_terminal_due()                              -> approved
--   propose/approve_terminal_due_allocation(820000)      -> allocation: approved
--   process_terminal_due_allocations_batch()             -> allocation: processed (820000 run through payroll)
--     -- terminal_dues.status is STILL 'approved'
--   record_terminal_due_payment(..., 'REF-DOUBLE')       -> SUCCEEDED -> status: paid
-- The full entitlement was credited twice: once through the
-- payroll-allocation ledger, once through the direct-payment RPC.
--
-- THE FIX (smallest safe correction -- a true CREATE OR REPLACE, with
-- the IDENTICAL signature to the live 20261022000001 definition; every
-- existing line, check, permission, status transition, payment-field
-- set, and audit entry is preserved byte-for-byte; the ONLY additions
-- are the two marked NEW below):
--
--   1. An advisory transaction lock keyed on p_terminal_due_id, taken
--      BEFORE the existing `SELECT * INTO v_due ... FOR UPDATE`, using
--      the EXACT SAME lock key (hashtextextended(p_terminal_due_id::
--      text, 0)) that propose_terminal_due_allocation() and
--      approve_terminal_due_allocation() already take for this same
--      entitlement -- the established "advisory lock before any row
--      lock" convention (see 20261103000000's header). This means a
--      concurrent allocation request and a concurrent direct-payment
--      request for the same terminal_due_id can never race: whichever
--      call acquires the lock first runs its entire check-then-write to
--      completion before the other is even allowed to read the row.
--
--   2. A new guard, placed immediately after the existing modern-
--      calculator guard: if ANY terminal_due_allocations row for this
--      terminal_due_id is in an "active or already-settled" state --
--      'submitted', 'approved', 'held', or 'processed' -- direct payment
--      is refused with a specific, actionable error. 'rejected' and
--      'excluded' allocations are deliberately NOT counted: by their
--      own documented semantics (20261023000001/20261026000000), neither
--      one ever moved any money, so a legacy entitlement whose only
--      allocation history is rejected/excluded rows remains exactly as
--      directly payable as one with no allocation history at all --
--      "use actual semantics, do not blindly treat as payments" and
--      "existing authorized direct-payment workflows remain functional
--      for genuinely unallocated legacy settlements."
--
-- WHAT THIS DOES NOT CHANGE: no schema change, no new table, no second
-- settlement ledger, and no change whatsoever to
-- propose/correct/approve/reject_terminal_due_allocation,
-- process_terminal_due_allocations_batch, process_payroll_with_
-- terminal_dues, approve_terminal_due, return_terminal_due_for_
-- correction, any permission, any payment-reference/audit-log shape, or
-- any amount calculation anywhere. Modern (calculator-originated)
-- terminal_dues rows are entirely unaffected by the new check -- the
-- pre-existing Phase 1.5 guard already blocks record_terminal_due_
-- payment for them unconditionally, before this new check is ever
-- reached. This migration does not depend on, and is not depended on
-- by, PR #73's employee_exits work -- it is fully independent of that
-- branch and safe to apply (or not) in either order.
-- ============================================================

CREATE OR REPLACE FUNCTION record_terminal_due_payment(
  p_terminal_due_id UUID,
  p_payment_date DATE,
  p_payment_method TEXT,
  p_payment_reference TEXT,
  p_notes TEXT DEFAULT NULL
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
  v_active_allocation_count INTEGER;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.pay')) THEN
    RAISE EXCEPTION 'Only an Accountant explicitly granted terminal_dues.pay (or a super admin) may record terminal dues payments';
  END IF;

  IF p_payment_date IS NULL THEN
    RAISE EXCEPTION 'Payment date is required';
  END IF;
  IF p_payment_method IS NULL OR btrim(p_payment_method) = '' THEN
    RAISE EXCEPTION 'Payment method is required';
  END IF;
  IF p_payment_reference IS NULL OR btrim(p_payment_reference) = '' THEN
    RAISE EXCEPTION 'Payment reference is required';
  END IF;

  -- NEW: the same entitlement-level advisory lock propose_terminal_due_
  -- allocation()/approve_terminal_due_allocation() already take for this
  -- terminal_due_id, acquired BEFORE the row lock below -- serializes
  -- this call against any concurrent allocation request for the same
  -- entitlement (requirement 7: concurrent payment/allocation requests
  -- must not bypass protection).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_terminal_due_id::text, 0));

  SELECT * INTO v_due FROM terminal_dues WHERE id = p_terminal_due_id FOR UPDATE;

  IF v_due IS NULL OR (v_due.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due record not found';
  END IF;

  -- Phase 1.5 guard (unchanged): a terminal_dues row promoted from a
  -- modern terminal_due_calculations draft -- existing-employee OR
  -- historical -- must not be paid through this legacy single-shot RPC.
  IF EXISTS (
    SELECT 1 FROM terminal_due_calculations
    WHERE submitted_terminal_due_id = p_terminal_due_id
  ) THEN
    RAISE EXCEPTION 'This Terminal Due originated from a modern Terminal Dues calculation and must be processed through the monthly-allocation workflow (not yet available), not paid directly.';
  END IF;

  -- NEW: a settlement with any active or already-settled allocation
  -- (submitted/approved/held/processed) cannot be paid directly through
  -- this legacy RPC -- it must be resolved through the allocation ledger
  -- itself. 'rejected'/'excluded' allocations never moved any money and
  -- are deliberately excluded from this count.
  SELECT COUNT(*) INTO v_active_allocation_count
  FROM terminal_due_allocations
  WHERE terminal_due_id = p_terminal_due_id AND status IN ('submitted', 'approved', 'held', 'processed');

  IF v_active_allocation_count > 0 THEN
    RAISE EXCEPTION 'This Terminal Due has % active or processed payment allocation(s) and cannot be paid directly -- resolve or reconcile the allocation ledger first (reject or exclude any allocation you do not intend to honor), then retry', v_active_allocation_count;
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) AND v_due.employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_due.employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  IF v_due.status = 'pending' THEN
    RAISE EXCEPTION 'Cannot record payment for a pending terminal due -- it must be approved first';
  END IF;
  IF v_due.status <> 'approved' THEN
    RAISE EXCEPTION 'Cannot record payment for a % terminal due -- only an approved calculation can be paid', v_due.status;
  END IF;

  UPDATE terminal_dues SET
    status = 'paid',
    payment_date = p_payment_date,
    payment_method = p_payment_method,
    payment_reference = p_payment_reference,
    payment_notes = p_notes,
    paid_by = v_caller_id,
    paid_at = NOW(),
    updated_at = NOW()
  WHERE id = p_terminal_due_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'UPDATE', 'terminal_due', p_terminal_due_id::text,
    jsonb_build_object('status', v_due.status),
    jsonb_build_object(
      'status', 'paid', 'paid_by', v_caller_id,
      'payment_date', p_payment_date, 'payment_method', p_payment_method,
      'payment_reference', p_payment_reference
    )
  );

  RETURN jsonb_build_object('success', true, 'id', p_terminal_due_id, 'status', 'paid');
END;
$$;

REVOKE ALL ON FUNCTION record_terminal_due_payment(UUID, DATE, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_terminal_due_payment(UUID, DATE, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION record_terminal_due_payment(UUID, DATE, TEXT, TEXT, TEXT) TO authenticated;
