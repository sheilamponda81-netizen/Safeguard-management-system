-- ============================================================
-- MIGRATION: Terminal Dues Phase 1.5 -- legacy payment guard
-- Date: 2026-10-21
-- ============================================================
--
-- WHY THIS IS ITS OWN MIGRATION
-- -----------------------------------------------------------
-- record_terminal_due_payment() is defined in 20260905000000, which has
-- already been applied to production. It must be amended in place via
-- CREATE OR REPLACE in a new migration -- the same convention this
-- repo already uses for amending hardened functions post-deployment
-- (e.g. 20260907000000 replacing approve_terminal_due() and
-- return_terminal_due_for_correction()) -- never by editing an
-- already-applied file.
--
-- WHAT THIS ADDS
-- -----------------------------------------------------------
-- The Phase 1.5 lifecycle correction (20261020000000) introduced
-- submit_terminal_due_calculation(): a bridge that promotes a modern
-- terminal_due_calculations draft into a brand-new 'pending' row in the
-- existing, hardened terminal_dues table, so it can reuse the existing
-- approve/pay workflow rather than a second parallel one. Admin approval
-- (approve_terminal_due()) is explicitly fine to reuse unchanged -- that
-- maps directly onto the approved business lifecycle's "Admin approves
-- the entitlement" step.
--
-- Payment is different. record_terminal_due_payment() records a single,
-- full, one-shot payment with no concept of partial monthly allocations.
-- The approved business lifecycle requires a modern entitlement to be
-- paid out through monthly-allocation approvals and Process Payroll --
-- functionality this phase explicitly does not build yet. Left
-- unguarded, an Accountant holding the existing terminal_dues.pay
-- permission could call record_terminal_due_payment() directly on a
-- modern, promoted row and mark it fully 'paid' in one shot, silently
-- bypassing the monthly-allocation approval step entirely before it
-- even exists. This migration closes exactly that gap with one narrow,
-- additive guard clause -- inserted immediately after the existing
-- not-found check, before any other logic -- and changes nothing else
-- about this function. Every legacy terminal_dues row (one with no
-- terminal_due_calculations row pointing at it via
-- submitted_terminal_due_id) is paid exactly as before, byte-for-byte
-- identical behavior.
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

  SELECT * INTO v_due FROM terminal_dues WHERE id = p_terminal_due_id FOR UPDATE;

  IF v_due IS NULL OR (v_due.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due record not found';
  END IF;

  -- NEW (Phase 1.5): a terminal_dues row promoted from a modern
  -- terminal_due_calculations draft must be processed through the
  -- future monthly-allocation workflow, not paid directly here. A
  -- legacy row (created directly via the Records tab, exactly as
  -- before Phase 1) has no matching terminal_due_calculations row and
  -- is completely unaffected by this check.
  IF EXISTS (
    SELECT 1 FROM terminal_due_calculations
    WHERE submitted_terminal_due_id = p_terminal_due_id
  ) THEN
    RAISE EXCEPTION 'This Terminal Due originated from a modern Terminal Dues calculation and must be processed through the monthly-allocation workflow (not yet available), not paid directly.';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_due.employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  -- Explicitly reject 'pending' with its own message (never silently
  -- treated the same as the generic "must be approved" branch below) --
  -- this is the exact pending -> paid skip the whole redesign exists to
  -- close.
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

-- Function signature is unchanged, so prior REVOKE/GRANT state already
-- in place from 20260905000000 continues to apply; restated here only
-- for clarity, not because it needs to change.
REVOKE ALL ON FUNCTION record_terminal_due_payment(UUID, DATE, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_terminal_due_payment(UUID, DATE, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION record_terminal_due_payment(UUID, DATE, TEXT, TEXT, TEXT) TO authenticated;
