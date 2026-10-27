-- ============================================================
-- MIGRATION: Terminal Dues Phase 2A -- monthly allocation ledger
-- Date: 2026-10-23
-- ============================================================
--
-- SCOPE OF THIS PHASE (read before touching anything downstream)
-- -----------------------------------------------------------
-- This migration adds the HR-proposes / Admin-approves monthly payment
-- ALLOCATION ledger for an already Admin-approved terminal_dues
-- entitlement. It deliberately does NOT:
--   - integrate with Process Payroll,
--   - ever mark an allocation "processed" (that status value exists in
--     the CHECK constraint below purely so Phase 2B does not need
--     another migration just to widen it -- nothing in this migration
--     ever sets it),
--   - decrement any outstanding balance based on approval alone,
--   - move anything into a "Settled" state,
--   - let an allocation bypass the Phase 1.5 legacy-payment guard.
-- Carry-forward and real payroll consumption are Phase 2B/3.
--
-- NOT IMPLEMENTED IN THIS MIGRATION -- FLAGGED, NOT GUESSED
-- -----------------------------------------------------------
-- "Entitlement revision while unprocessed allocations exist" (task
-- Section 8) is NOT built here. Reason: under the current, tested
-- architecture, an Admin-approved terminal_dues entitlement cannot be
-- revised at all -- reopen_terminal_due_calculation() (Phase 1.5/1.6)
-- deliberately blocks reopening once the linked terminal_dues row has
-- moved past 'pending', and return_terminal_due_for_correction() is
-- Admin-initiated (requires terminal_dues.approve), not HR-initiated.
-- Building "HR submits a revision" therefore means either (a) loosening
-- the reopen block that was added and tested specifically as a
-- post-approval safeguard, or (b) a wholly new revision-request entity
-- sitting alongside the existing draft/calculation model. Which of
-- these -- and exactly how it should re-enter the approval pipeline --
-- is a genuine architectural decision this migration does not make
-- unreviewed. See this phase's final report for the concrete proposal.
-- Everything else in the task (Sections 3-7, 9-10) is implemented and
-- tested below.
-- ============================================================

-- ============================================================
-- PART 1: historical employee deletion safety
-- -----------------------------------------------------------
-- The Phase 1.6 migration added historical_employee_id to both
-- terminal_due_calculations and terminal_dues with ON DELETE CASCADE,
-- inherited unreflectively from the already-reviewed pattern used for
-- employee_id elsewhere. For terminal_dues specifically this is wrong:
-- it is the AUTHORITATIVE entitlement/approval/payment record, and nothing
-- about deleting a historical_employees row (a plausible correction of a
-- data-entry mistake, for example) should be able to silently destroy a
-- real financial entitlement or its audit trail. Switched to RESTRICT:
-- deleting a historical_employees row that still has any terminal_dues
-- row referencing it now fails outright, forcing a deliberate decision
-- instead. The SAME fix is applied to terminal_due_calculations for
-- consistency -- a draft/submitted calculation is itself HR's auditable
-- work and should not vanish silently either, even before promotion.
-- Nothing else about either table changes; no data is touched, and every
-- existing row (there are none yet outside local testing, since neither
-- table has been applied to STAGING/PRODUCTION) is unaffected either way.
-- ============================================================

ALTER TABLE terminal_dues
  DROP CONSTRAINT terminal_dues_historical_employee_id_fkey,
  ADD CONSTRAINT terminal_dues_historical_employee_id_fkey
    FOREIGN KEY (historical_employee_id) REFERENCES historical_employees(id) ON DELETE RESTRICT;

ALTER TABLE terminal_due_calculations
  DROP CONSTRAINT terminal_due_calculations_historical_employee_id_fkey,
  ADD CONSTRAINT terminal_due_calculations_historical_employee_id_fkey
    FOREIGN KEY (historical_employee_id) REFERENCES historical_employees(id) ON DELETE RESTRICT;

-- ============================================================
-- PART 2: terminal_due_allocations -- the monthly allocation ledger
-- -----------------------------------------------------------
-- One row per (terminal_due_id, payroll_month): the SAME entitlement can
-- have many allocation rows across DIFFERENT months (built up
-- progressively), but never two rows for the same month -- a correction
-- or resubmission updates the existing row (see the RPCs below), so
-- "revisions to the same employee ... not count as additional people"
-- (task Section 4) holds structurally, not by convention.
--
-- payroll_month is captured server-side from system_settings at proposal
-- time, NEVER client-supplied and NEVER the host machine's current date
-- -- this is "the system's existing authoritative payroll month
-- selection" (src/utils/currentMonth.ts's getSystemCurrentMonth(),
-- system_settings.key = 'current_payroll_month', already used by
-- Payroll.tsx). No independent Terminal Dues month selector exists.
-- ============================================================

CREATE TABLE IF NOT EXISTS terminal_due_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  terminal_due_id UUID NOT NULL REFERENCES terminal_dues(id) ON DELETE CASCADE,
  payroll_month TEXT NOT NULL,
  -- Resolved from the entitlement's own subject at proposal time (the
  -- employee's region, or NULL for a historical subject -- tenant-wide,
  -- same policy as everywhere else in this feature). Denormalized here,
  -- not re-joined through terminal_dues -> employees on every RLS check,
  -- for the same reason terminal_due_calculations.region_id is.
  region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
  -- 'processed' is deliberately unreachable in this phase -- reserved so
  -- Phase 2B's Process Payroll integration does not need another
  -- migration just to widen this CHECK.
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'held', 'processed')),
  proposed_amount NUMERIC(14,2) NOT NULL CHECK (proposed_amount > 0),
  -- The amount from the most recent Admin decision (approve or reject),
  -- independent of proposed_amount so a later HR correction can change
  -- proposed_amount while this still shows what Admin actually decided
  -- on -- "the original approved amount is preserved" (task Section 7).
  last_decided_amount NUMERIC(14,2),
  -- Only meaningful while status = 'held'. 'hr_correction': HR corrected
  -- an already-approved allocation and it awaits Admin re-approval.
  -- 'entitlement_revised': reserved for the entitlement-revision flow
  -- this migration does NOT implement (see header) -- included now so
  -- that future work has a place to put it without another migration;
  -- nothing in this migration ever sets this value.
  hold_reason TEXT CHECK (hold_reason IS NULL OR hold_reason IN ('hr_correction', 'entitlement_revised')),
  rejection_reason TEXT,
  -- Append-only log of every prior {status, proposed_amount,
  -- last_decided_amount, rejection_reason} this row has held, pushed by
  -- every RPC below before applying its own change -- same pattern as
  -- terminal_due_calculations.revision_history, and for the same reason:
  -- "maintain actor identity, timestamps, original values and reasons"
  -- (task Section 7) without a separate history table.
  revision_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (terminal_due_id, payroll_month)
);

CREATE INDEX IF NOT EXISTS idx_terminal_due_allocations_terminal_due ON terminal_due_allocations(terminal_due_id);
CREATE INDEX IF NOT EXISTS idx_terminal_due_allocations_tenant_month ON terminal_due_allocations(tenant_id, payroll_month);

ALTER TABLE terminal_due_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Terminal due allocations: read within tenant+region, terminal-dues role" ON terminal_due_allocations
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

-- Every mutation goes through the four RPCs below -- same "no direct
-- client write" idiom as terminal_due_calculations. A true super admin's
-- own direct write is still permitted, same exception every other
-- Terminal Dues policy in this codebase makes.
CREATE POLICY "Terminal due allocations: no direct client insert" ON terminal_due_allocations
FOR INSERT WITH CHECK (is_super_admin());

CREATE POLICY "Terminal due allocations: no direct client update" ON terminal_due_allocations
FOR UPDATE USING (is_super_admin()) WITH CHECK (is_super_admin());

-- No DELETE policy: default-deny -- durable audit ledger, never deleted.

GRANT SELECT ON terminal_due_allocations TO authenticated;
GRANT INSERT, UPDATE ON terminal_due_allocations TO authenticated; -- gated to is_super_admin() by the policies above; the RPCs run as owner and are unaffected either way.

-- ============================================================
-- PART 3: RPCs
-- -----------------------------------------------------------
-- Same idiom as every other Terminal Dues RPC: SECURITY DEFINER, resolve
-- the caller via auth.uid()/get_current_tenant_id(), lock rows with FOR
-- UPDATE before checking state, RAISE EXCEPTION (rolling back the whole
-- transaction) on any authorization/state/balance failure, one
-- audit_logs row per call.
--
-- CONCURRENCY-SAFE OVER-ALLOCATION AND MONTHLY-CAP ENFORCEMENT
-- -----------------------------------------------------------
-- A plain "SELECT COUNT/SUM ... then INSERT" has a classic check-then-
-- write race under READ COMMITTED: two concurrent proposals can both
-- pass the check before either commits. pg_advisory_xact_lock() is used
-- to serialize the two kinds of cross-row aggregate this feature needs:
--   - one lock keyed on the terminal_due_id, so all allocation activity
--     for ONE entitlement (across however many different months) is
--     serialized -- this is what makes the outstanding-balance check
--     (SUM across this entitlement's own allocations) race-free;
--   - one lock keyed on (tenant_id, payroll_month), so the "how many
--     distinct employees already have an allocation this month" count
--     and the resulting INSERT are atomic together -- this is what makes
--     the 50-person cap race-free, including across multiple concurrent
--     HR sessions and multiple "batches" (there is no batch concept here
--     at all: the cap is evaluated against the whole month's existing
--     rows, not anything scoped to a single submission).
-- Both locks are transaction-scoped (released automatically at COMMIT or
-- ROLLBACK) and held only for the duration of this one RPC call.
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

  -- Phase 2A: nothing has ever been processed yet (that concept does not
  -- exist until Phase 2B), so the outstanding balance is simply the
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

REVOKE ALL ON FUNCTION propose_terminal_due_allocation(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION propose_terminal_due_allocation(UUID, NUMERIC) FROM anon;
GRANT EXECUTE ON FUNCTION propose_terminal_due_allocation(UUID, NUMERIC) TO authenticated;

-- ------------------------------------------------------------
-- correct_terminal_due_allocation(): HR corrects an already-APPROVED
-- allocation. The prior approved amount/decision is preserved (in
-- last_decided_amount, untouched, plus the full snapshot in
-- revision_history) -- the row moves to 'held' and must go back through
-- Admin approval before it is eligible for payroll (task Section 7).
-- ------------------------------------------------------------

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

REVOKE ALL ON FUNCTION correct_terminal_due_allocation(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION correct_terminal_due_allocation(UUID, NUMERIC) FROM anon;
GRANT EXECUTE ON FUNCTION correct_terminal_due_allocation(UUID, NUMERIC) TO authenticated;

-- ------------------------------------------------------------
-- approve_terminal_due_allocation() / reject_terminal_due_allocation()
-- -----------------------------------------------------------
-- Gated on terminal_dues.approve -- the SAME distinct Admin permission
-- entitlement approval already requires, and deliberately NOT
-- terminal_dues.create/.edit (HR's own permission), so HR can never
-- approve its own allocation through this function regardless of how it
-- is called (task Section 6: "HR must not approve their own
-- allocations through an HR-only permission").
-- ------------------------------------------------------------

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

REVOKE ALL ON FUNCTION approve_terminal_due_allocation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_terminal_due_allocation(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION approve_terminal_due_allocation(UUID) TO authenticated;

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
  -- limit" (task Section 7) holds automatically: the UNIQUE
  -- (terminal_due_id, payroll_month) row still exists and still counts.
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

REVOKE ALL ON FUNCTION reject_terminal_due_allocation(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_terminal_due_allocation(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION reject_terminal_due_allocation(UUID, TEXT) TO authenticated;
