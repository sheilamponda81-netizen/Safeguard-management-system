-- ============================================================
-- RELEASE AUDIT FIX: pre-processing allocation balance checks never
-- subtracted already-PROCESSED amounts -- stale from Phase 2A, never
-- updated when Phase 3A introduced the 'processed' status.
-- Date: 2026-11-03
-- ============================================================
--
-- ROOT CAUSE
-- -----------------------------------------------------------
-- propose_terminal_due_allocation(), correct_terminal_due_allocation(),
-- and approve_terminal_due_allocation() (all 20261023000001) each
-- compute the entitlement's outstanding balance as:
--   v_outstanding := v_due.total_payable;
-- and sum "other reserved" amounts only over
--   status IN ('submitted', 'approved', 'held')
-- -- both lines predate the 'processed' status, which
-- 20261026000000_terminal_dues_payroll_processing.sql introduced for
-- allocations that have already gone through Process Payroll. Neither
-- line was updated to account for it, so these three functions compute
-- the outstanding balance as if nothing had ever been paid.
--
-- revalidate_terminal_due_allocations_after_revision() (20261024000000)
-- has the same gap: it restores held allocations up to p_effective_total
-- using a running sum that starts at 0 and only tracks OTHER allocations
-- it restores in the same pass -- it never subtracts amounts already
-- committed via 'processed' allocations for the same entitlement either.
--
-- CONCRETE REPRODUCTION (confirmed live against a disposable Postgres
-- database running the real, unmodified migration chain): an entitlement
-- already fully processed (80000/80000 paid via Process Payroll) still
-- allowed propose_terminal_due_allocation(..., 75000) for a new month,
-- and approve_terminal_due_allocation() on it, with NO error from either
-- function.
--
-- WHY THIS IS NOT A MONEY-SAFETY HOLE (reported honestly, not
-- overclaimed as more serious than it is): the actual commit gate,
-- process_terminal_due_allocations_batch() (20261026000000, carried into
-- 20261029000000), ALREADY computes v_already_processed correctly and
-- refuses to let total processed exceed total_payable -- so the
-- over-approved allocation above was correctly refused at Process
-- Payroll time ("would bring this entitlement's total processed to
-- 155000.00 against an approved entitlement of only 80000.00"). No
-- double payment can ever actually post. The defect this migration fixes
-- is purely that HR and Admin can spend effort proposing and approving
-- an allocation that is silently guaranteed to fail later, with no
-- warning until that final step.
--
-- THE FIX
-- -----------------------------------------------------------
-- Every line below is byte-for-byte unchanged from each function's
-- current (20261023000001 / 20261024000000) version EXCEPT: each now
-- also looks up v_already_processed (the SAME query
-- process_terminal_due_allocations_batch() already uses) and subtracts
-- it from the total_payable/effective_total figure used in its own
-- balance check. No schema change, no data change, no change to the
-- already-correct final commit gate.
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
  v_already_processed NUMERIC;
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
    RAISE EXCEPTION 'Only an Admin-approved entitlement can receive a payment allocation (this one is %)', v_due.status;
  END IF;

  v_region_id := NULL;
  IF v_due.employee_id IS NOT NULL THEN
    SELECT region_id INTO v_region_id FROM employees WHERE id = v_due.employee_id;
  END IF;

  -- Serialize ALL allocation activity for this one entitlement, across
  -- every month it might already have a row for.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_due.id::text, 0));

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

  -- FIX: subtract amounts already committed via Process Payroll -- the
  -- outstanding balance available for new/corrected proposals is what
  -- remains after both already-processed AND other reserved amounts.
  SELECT COALESCE(SUM(COALESCE(last_decided_amount, proposed_amount)), 0) INTO v_already_processed
  FROM terminal_due_allocations
  WHERE terminal_due_id = p_terminal_due_id AND status = 'processed';

  v_outstanding := v_due.total_payable - v_already_processed;

  IF v_other_reserved + p_amount > v_outstanding THEN
    RAISE EXCEPTION 'Proposed allocation of % exceeds the available outstanding balance -- % is already reserved by other pending/approved/held allocations and % already processed against an entitlement of %', p_amount, v_other_reserved, v_already_processed, v_due.total_payable;
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

REVOKE ALL ON FUNCTION propose_terminal_due_allocation(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION propose_terminal_due_allocation(UUID, NUMERIC) FROM anon;
GRANT EXECUTE ON FUNCTION propose_terminal_due_allocation(UUID, NUMERIC) TO authenticated;

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
  v_already_processed NUMERIC;
  v_outstanding NUMERIC;
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
    RAISE EXCEPTION 'Only an explicitly granted Terminal Dues create/edit role (or a super admin) may correct a payment allocation';
  END IF;

  IF p_new_amount IS NULL OR p_new_amount <= 0 THEN
    RAISE EXCEPTION 'Corrected allocation amount must be greater than zero';
  END IF;

  SELECT * INTO v_alloc FROM terminal_due_allocations WHERE id = p_id FOR UPDATE;
  IF v_alloc IS NULL OR (v_alloc.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Allocation not found';
  END IF;

  IF NOT is_super_admin() AND v_alloc.region_id IS NOT NULL AND NOT region_allowed(v_alloc.region_id) THEN
    RAISE EXCEPTION 'This record is outside your assigned region';
  END IF;

  IF v_alloc.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved allocation can be corrected (this one is %)', v_alloc.status;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_alloc.terminal_due_id::text, 0));

  SELECT * INTO v_due FROM terminal_dues WHERE id = v_alloc.terminal_due_id;

  SELECT COALESCE(SUM(proposed_amount), 0) INTO v_other_reserved
  FROM terminal_due_allocations
  WHERE terminal_due_id = v_alloc.terminal_due_id
    AND status IN ('submitted', 'approved', 'held')
    AND id <> v_alloc.id;

  -- FIX: subtract amounts already committed via Process Payroll (see
  -- this migration's header).
  SELECT COALESCE(SUM(COALESCE(last_decided_amount, proposed_amount)), 0) INTO v_already_processed
  FROM terminal_due_allocations
  WHERE terminal_due_id = v_alloc.terminal_due_id AND status = 'processed';

  v_outstanding := v_due.total_payable - v_already_processed;

  IF v_other_reserved + p_new_amount > v_outstanding THEN
    RAISE EXCEPTION 'Corrected allocation of % exceeds the available outstanding balance -- % is already reserved by other pending/approved/held allocations and % already processed against an entitlement of %', p_new_amount, v_other_reserved, v_already_processed, v_due.total_payable;
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

REVOKE ALL ON FUNCTION correct_terminal_due_allocation(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION correct_terminal_due_allocation(UUID, NUMERIC) FROM anon;
GRANT EXECUTE ON FUNCTION correct_terminal_due_allocation(UUID, NUMERIC) TO authenticated;

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
  v_already_processed NUMERIC;
  v_outstanding NUMERIC;
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
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may approve a payment allocation';
  END IF;

  SELECT * INTO v_alloc FROM terminal_due_allocations WHERE id = p_id FOR UPDATE;
  IF v_alloc IS NULL OR (v_alloc.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Allocation not found';
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
  PERFORM pg_advisory_xact_lock(hashtextextended(v_alloc.terminal_due_id::text, 0));

  SELECT * INTO v_due FROM terminal_dues WHERE id = v_alloc.terminal_due_id;

  SELECT COALESCE(SUM(proposed_amount), 0) INTO v_other_reserved
  FROM terminal_due_allocations
  WHERE terminal_due_id = v_alloc.terminal_due_id
    AND status IN ('submitted', 'approved', 'held')
    AND id <> v_alloc.id;

  -- FIX: subtract amounts already committed via Process Payroll (see
  -- this migration's header).
  SELECT COALESCE(SUM(COALESCE(last_decided_amount, proposed_amount)), 0) INTO v_already_processed
  FROM terminal_due_allocations
  WHERE terminal_due_id = v_alloc.terminal_due_id AND status = 'processed';

  v_outstanding := v_due.total_payable - v_already_processed;

  IF v_other_reserved + v_alloc.proposed_amount > v_outstanding THEN
    RAISE EXCEPTION 'Cannot approve -- this allocation of % would exceed the available outstanding balance (% already reserved and % already processed against an entitlement of %); ask HR to correct it first', v_alloc.proposed_amount, v_other_reserved, v_already_processed, v_due.total_payable;
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

REVOKE ALL ON FUNCTION approve_terminal_due_allocation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_terminal_due_allocation(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION approve_terminal_due_allocation(UUID) TO authenticated;

-- ------------------------------------------------------------
-- revalidate_terminal_due_allocations_after_revision(): same gap --
-- restored held allocations were budgeted against the full
-- p_effective_total with no subtraction for amounts already committed
-- via 'processed' allocations for the same entitlement. Fixed by seeding
-- the running sum with v_already_processed instead of 0, so a processed
-- amount is accounted for exactly once, on top of whatever this pass
-- itself restores.
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
  v_already_processed NUMERIC;
  v_running_sum NUMERIC;
  v_candidate NUMERIC;
BEGIN
  SELECT COALESCE(SUM(COALESCE(last_decided_amount, proposed_amount)), 0) INTO v_already_processed
  FROM terminal_due_allocations
  WHERE terminal_due_id = p_terminal_due_id AND status = 'processed';

  v_running_sum := v_already_processed;

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
-- Internal helper only -- called from within approve/reject_terminal_due_revision() (same SECURITY DEFINER execution context), never directly by a client.

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
-- RUN ONCE / RUN TWICE: idempotent -- CREATE OR REPLACE FUNCTION and the
-- same REVOKE/GRANT statements every time. No table/column/data changes
-- of any kind. Does not touch process_terminal_due_allocations_batch()
-- (20261026000000/20261029000000), which already computed this
-- correctly -- that function is the real money-safety gate and is
-- untouched here.
--
-- ROLLBACK: re-apply 20261023000001_terminal_dues_allocation_ledger.sql's
-- own CREATE OR REPLACE FUNCTION blocks for propose_terminal_due_allocation/
-- correct_terminal_due_allocation/approve_terminal_due_allocation, and
-- 20261024000000_terminal_dues_entitlement_revisions.sql's own block for
-- revalidate_terminal_due_allocations_after_revision, verbatim. Safe at any
-- time: this migration changes no stored data, only pre-commit validation
-- logic.
-- ============================================================
