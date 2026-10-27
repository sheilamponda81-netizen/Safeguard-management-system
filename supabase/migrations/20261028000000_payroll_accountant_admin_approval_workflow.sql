-- ============================================================
-- MIGRATION: Phase 3D -- Accountant-initiated payroll with Admin approval
-- Date: 2026-10-28
-- ============================================================
--
-- BUSINESS CLARIFICATION THIS MIGRATION IMPLEMENTS
-- -----------------------------------------------------------
-- Both Accountants and Admins are authorized to click "Process Payroll"
-- (unchanged -- `process_payroll_batch()`'s own authorization, via
-- has_permission('payroll.process'), already grants both; this migration
-- does not touch that check). The NEW rule: when an ACCOUNTANT initiates
-- payroll, the actual financial commit must wait for an Admin's approval
-- -- an Accountant can no longer single-handedly commit payroll. An Admin
-- may still process directly, exactly as before.
--
-- STEP 1 FINDING -- NO existing workflow is reusable for this
-- -----------------------------------------------------------
-- `payroll.approval_status` / `approve_payroll_run()` (20260831000000) is
-- a DIFFERENT, already-working feature: it signs off on payroll rows that
-- ALREADY EXIST (approval_status starts 'pending' the moment
-- process_payroll_batch() inserts them, and approve_payroll_run() flips it
-- afterward) -- a POST-commit review, not a pre-commit gate on whether the
-- financial write happens at all. Reusing it here would mean the
-- Accountant's payroll has already been written to `payroll` (and
-- Terminal Dues already marked processed) by the time anyone "approves"
-- anything -- exactly the bypass this phase must close. It is preserved
-- completely unchanged and untouched by this migration.
--
-- Also checked and confirmed NOT reusable/safe to reuse: the
-- `payroll.approve` permission itself. `role_permissions` already seeds
-- `('accountant', 'payroll.approve')` (20260817000000) for the EXISTING
-- post-commit sign-off feature above -- an Accountant legitimately holds
-- payroll.approve today. Gating the NEW pre-commit request-approval step
-- on has_permission('payroll.approve') would therefore let an Accountant
-- approve THEIR OWN submitted request, reopening exactly the hole this
-- migration exists to close. The new gate below deliberately checks
-- `is_super_admin() OR is_business_admin()` directly instead -- the same
-- "Admin-class" boundary Phase 3C's audit already established as the
-- correct one for Terminal Dues processing authority, and the one this
-- phase's own instruction asks for: "support legitimate legacy Admin
-- profiles (role_level = 1, role often NULL), not only profiles whose
-- literal role string is 'admin'". is_business_admin() already covers
-- both (`current_user_role() = 'admin' OR current_user_role_level() = 1`);
-- is_super_admin() is explicitly OR'd in front, matching the established
-- convention every other RPC in this schema uses (has_permission()/
-- is_business_admin() do NOT themselves check is_super_admin -- see
-- process_payroll_batch()'s own `v_is_super_admin OR ... OR
-- has_permission(...)` shape, which this migration's new gate mirrors).
--
-- ARCHITECTURE
-- -----------------------------------------------------------
-- `payroll_processing_requests` -- one row per Accountant-initiated
-- attempt, an auditable record of: who initiated it, for which month,
-- with exactly which records/totals/Terminal-Dues-exclusions (a bound
-- snapshot, not a re-derivable reference), who reviewed it and when, and
-- -- once actually processed -- the resulting combined_reference linking
-- it to the SAME processing event process_payroll_with_terminal_dues()
-- already produces. Lifecycle: pending -> approved -> processed, or
-- pending -> rejected. A partial UNIQUE index allows at most one LIVE
-- (pending or approved) request per (tenant, month) at a time -- an
-- Accountant cannot flood duplicate concurrent requests, and an Admin
-- cannot accidentally process two different requests for the same month
-- out from under each other.
--
-- THREE NEW RPCs, reusing process_payroll_with_terminal_dues() UNCHANGED
-- -----------------------------------------------------------
-- submit_payroll_processing_request() -- same payroll-processing
-- authority bar process_payroll_batch() itself already requires (so this
-- does not newly restrict who may submit); snapshots the records/totals/
-- exclusions; rejects a non-empty Terminal Dues exclusion list from a
-- caller who does not hold terminal_dues.approve (an Accountant may never
-- stage an exclusion decision -- that is an approval-adjacent action, per
-- this phase's own instruction "do not grant the Accountant Terminal Dues
-- approval permissions"). Writes NOTHING to `payroll` or
-- `terminal_due_allocations` -- purely a durable, auditable record of
-- intent.
--
-- approve_payroll_processing_request() -- Admin-class only (see above).
-- Requires status = 'pending'. Prevents self-approval (initiator = caller
-- is rejected, defense in depth -- cannot actually arise given submission
-- is open to any payroll-processing-authorized caller while approval is
-- Admin-class-only, unless a future role change blurs that line). Pure
-- state transition (status -> 'approved', reviewed_by/reviewed_at) -- no
-- financial write yet, so an approved-but-not-yet-processed request is a
-- real, observable state (needed so "prevent reuse of an old approved
-- request" is something to actually guard against, not a null case).
--
-- reject_payroll_processing_request() -- Admin-class only, requires a
-- non-empty reason, requires status = 'pending'.
--
-- process_approved_payroll_request() -- Admin-class only, requires status
-- = 'approved' (NOT 'pending' -- an Accountant can never reach this state
-- transition even if they somehow guessed a request id, since the prior
-- state transition into 'approved' already required Admin-class
-- authority). Re-verifies the request's month is STILL the tenant's
-- active payroll month (the one thing this migration can honestly
-- revalidate without duplicating the browser's own salary/attendance
-- calculation -- see the note on this function's own body for why a
-- deeper "did the underlying numbers change" check is not attempted).
-- Acquires the SAME (tenant, month) advisory lock
-- process_payroll_with_terminal_dues() itself acquires (reentrant, see
-- that migration's own header) before locking the request row FOR
-- UPDATE, serializing concurrent processing attempts. Calls
-- process_payroll_with_terminal_dues(request.month, request.payroll_
-- records, ..., request.td_excluded_ids, request.td_exclusion_reason)
-- UNCHANGED -- the exact same one-transaction ordinary-payroll-plus-
-- Terminal-Dues mechanism Phase 3B built, now invoked under the
-- APPROVING ADMIN's own identity (auth.uid() is resolved from the
-- session, unaffected by nested SECURITY DEFINER calls -- Terminal Dues
-- inclusion is therefore correctly gated by whether THIS admin holds
-- terminal_dues.approve, never by the original Accountant's lack of it).
-- Any exception from that call propagates out uncaught, rolling back
-- EVERYTHING including the request's own status update -- the request is
-- left 'approved' (not silently 'processed'), so a fixed retry is
-- possible without redoing the approval decision. On success: status ->
-- 'processed', processing_reference = the returned combined_reference.
--
-- DATABASE-ENFORCED BYPASS CLOSURE (not merely UI)
-- -----------------------------------------------------------
-- process_payroll_with_terminal_dues() itself (CREATE OR REPLACE, same
-- signature, every other line of its body byte-for-byte unchanged from
-- 20261027000000) gains exactly ONE new check, first thing after
-- resolving the tenant: is_super_admin() OR is_business_admin(), else
-- RAISE. An Accountant calling it directly -- whether through a stray
-- future UI path or a direct REST call with a valid session -- is now
-- rejected at the SOURCE of the actual financial transaction, not merely
-- by the UI choosing not to show them the button. The approving Admin
-- still reaches it fine (direct call or via process_approved_payroll_
-- request()'s nested call, since auth.uid() is the Admin either way).
-- This is the ONLY change to that function; every lock/call/return-shape
-- detail from Phase 3B is preserved exactly.
-- ============================================================

CREATE TABLE payroll_processing_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'processed')),
  initiated_by UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT CHECK (rejection_reason IS NULL OR btrim(rejection_reason) <> ''),
  -- The bound scope: exactly what was reviewed, never re-derived from a
  -- live query at processing time (process_payroll_with_terminal_dues()
  -- is called with THESE records, not a freshly refetched set).
  payroll_records JSONB NOT NULL,
  audit_context JSONB NOT NULL DEFAULT '{}'::JSONB,
  td_excluded_ids UUID[] NOT NULL DEFAULT '{}',
  td_exclusion_reason TEXT,
  processing_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one LIVE (not yet decided-and-settled) request per tenant+month.
CREATE UNIQUE INDEX idx_payroll_processing_requests_one_live_per_month
  ON payroll_processing_requests(tenant_id, month) WHERE status IN ('pending', 'approved');

CREATE INDEX idx_payroll_processing_requests_tenant_month
  ON payroll_processing_requests(tenant_id, month);

ALTER TABLE payroll_processing_requests ENABLE ROW LEVEL SECURITY;

-- Read access only -- every status transition goes through the SECURITY
-- DEFINER RPCs below, never a direct client UPDATE/INSERT/DELETE (no
-- policy exists for any of those, and table-level privileges for them are
-- explicitly revoked below too, matching this schema's own established
-- "no direct client insert/update" pattern for append-only/decision
-- tables, e.g. terminal_due_revisions).
CREATE POLICY "Payroll processing requests: read within tenant, payroll view authority"
  ON payroll_processing_requests FOR SELECT
  USING (
    is_super_admin()
    OR (tenant_id = get_current_tenant_id() AND (is_business_admin() OR has_permission('payroll.view')))
  );

GRANT SELECT ON payroll_processing_requests TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON payroll_processing_requests FROM authenticated, PUBLIC, anon;

-- ============================================================
-- PART 1: submit_payroll_processing_request()
-- ============================================================
CREATE OR REPLACE FUNCTION submit_payroll_processing_request(
  p_month TEXT,
  p_records JSONB,
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
  v_role_level INTEGER;
  v_is_super_admin BOOLEAN;
  v_system_month TEXT;
  v_request_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- Same bar process_payroll_batch() itself requires -- submitting a
  -- request is not MORE restrictive than processing directly already is;
  -- it is Admin-class-only COMMITTING that is newly restricted (see
  -- process_payroll_with_terminal_dues()'s own new check below).
  SELECT role_level, is_super_admin INTO v_role_level, v_is_super_admin FROM profiles WHERE id = v_caller_id;
  IF NOT (v_is_super_admin OR COALESCE(v_role_level = 1, false) OR has_permission('payroll.process')) THEN
    RAISE EXCEPTION 'Only Admins, super admins, or an account explicitly granted payroll.process may submit a payroll processing request';
  END IF;

  IF p_records IS NULL OR jsonb_array_length(p_records) = 0 THEN
    RAISE EXCEPTION 'No payroll records supplied';
  END IF;

  SELECT value INTO v_system_month FROM system_settings WHERE tenant_id = v_tenant_id AND key = 'current_payroll_month';
  IF v_system_month IS NULL THEN
    RAISE EXCEPTION 'No active payroll month is configured for this tenant -- set one on the Payroll page first';
  END IF;
  IF p_month <> v_system_month THEN
    RAISE EXCEPTION 'Refusing to submit: % is not the active payroll month (%) -- refresh and try again', p_month, v_system_month;
  END IF;

  -- Do not grant the Accountant Terminal Dues approval permissions:
  -- selecting an exclusion is an approval-adjacent decision, never staged
  -- by a caller who does not hold terminal_dues.approve.
  IF p_td_excluded_ids IS NOT NULL AND array_length(p_td_excluded_ids, 1) > 0
     AND NOT (v_is_super_admin OR has_explicit_permission('terminal_dues.approve'))
  THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may select Terminal Dues exclusions';
  END IF;

  -- The partial unique index raises its own clear constraint-violation
  -- error if a live (pending/approved) request already exists for this
  -- tenant+month -- no separate pre-check needed, and no race window
  -- between a check and this INSERT.
  INSERT INTO payroll_processing_requests (
    tenant_id, month, status, initiated_by, payroll_records, audit_context, td_excluded_ids, td_exclusion_reason
  ) VALUES (
    v_tenant_id, p_month, 'pending', v_caller_id, p_records, p_audit_context, COALESCE(p_td_excluded_ids, '{}'), p_td_exclusion_reason
  ) RETURNING id INTO v_request_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'CREATE', 'payroll_processing_request', v_request_id::text,
    '{}'::JSONB,
    jsonb_build_object('month', p_month, 'employeeCount', jsonb_array_length(p_records), 'status', 'pending')
  );

  RETURN jsonb_build_object('success', true, 'request_id', v_request_id, 'status', 'pending', 'month', p_month);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'A payroll processing request for % is already pending or approved -- wait for it to be decided, or ask an Admin to reject it first', p_month;
END;
$$;

REVOKE ALL ON FUNCTION submit_payroll_processing_request(TEXT, JSONB, JSONB, UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION submit_payroll_processing_request(TEXT, JSONB, JSONB, UUID[], TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION submit_payroll_processing_request(TEXT, JSONB, JSONB, UUID[], TEXT) TO authenticated;

-- ============================================================
-- PART 2: approve_payroll_processing_request() -- pure decision, no
-- financial write.
-- ============================================================
CREATE OR REPLACE FUNCTION approve_payroll_processing_request(p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_request RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only an Admin or super admin may approve a payroll processing request';
  END IF;

  SELECT * INTO v_request FROM payroll_processing_requests WHERE id = p_request_id AND tenant_id = v_tenant_id FOR UPDATE;
  IF v_request IS NULL THEN
    RAISE EXCEPTION 'Payroll processing request not found';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'This request is no longer pending (status: %) -- it may have already been decided', v_request.status;
  END IF;
  IF v_request.initiated_by = v_caller_id THEN
    RAISE EXCEPTION 'You cannot approve your own payroll processing request';
  END IF;

  UPDATE payroll_processing_requests SET
    status = 'approved', reviewed_by = v_caller_id, reviewed_at = NOW(), updated_at = NOW()
  WHERE id = p_request_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'APPROVE', 'payroll_processing_request', p_request_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'approved', 'month', v_request.month)
  );

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'approved', 'month', v_request.month);
END;
$$;

REVOKE ALL ON FUNCTION approve_payroll_processing_request(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_payroll_processing_request(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION approve_payroll_processing_request(UUID) TO authenticated;

-- ============================================================
-- PART 3: reject_payroll_processing_request()
-- ============================================================
CREATE OR REPLACE FUNCTION reject_payroll_processing_request(p_request_id UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_request RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only an Admin or super admin may reject a payroll processing request';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reject a payroll processing request';
  END IF;

  SELECT * INTO v_request FROM payroll_processing_requests WHERE id = p_request_id AND tenant_id = v_tenant_id FOR UPDATE;
  IF v_request IS NULL THEN
    RAISE EXCEPTION 'Payroll processing request not found';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'This request is no longer pending (status: %) -- it may have already been decided', v_request.status;
  END IF;

  UPDATE payroll_processing_requests SET
    status = 'rejected', reviewed_by = v_caller_id, reviewed_at = NOW(), rejection_reason = btrim(p_reason), updated_at = NOW()
  WHERE id = p_request_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'REJECT', 'payroll_processing_request', p_request_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'rejected', 'month', v_request.month, 'reason', btrim(p_reason))
  );

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'rejected', 'month', v_request.month);
END;
$$;

REVOKE ALL ON FUNCTION reject_payroll_processing_request(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_payroll_processing_request(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION reject_payroll_processing_request(UUID, TEXT) TO authenticated;

-- ============================================================
-- PART 4: process_approved_payroll_request() -- the actual commit,
-- reusing process_payroll_with_terminal_dues() unchanged.
-- ============================================================
-- WHY NOT A DEEPER "did the numbers change" REVALIDATION: gross/net/PAYE/
-- pension are computed in the BROWSER (calculatePayroll/
-- calculateLivePayroll), never recomputed server-side by design (see
-- process_payroll_batch()'s own header -- this is a standing rule across
-- every phase of this codebase, not something this migration can safely
-- change). There is therefore no independent server-side source of truth
-- to diff the submitted snapshot against. What this function DOES
-- honestly revalidate: the payroll month is still the tenant's live
-- active month (the one fact that genuinely can drift between submission
-- and approval, e.g. if current_payroll_month advances) -- if it no
-- longer matches, this raises and asks for a fresh submission rather than
-- silently committing against a stale month. Every other safety check
-- (tenant/region membership, approved-month protection, payload numeric
-- sanity, Terminal Dues re-validation) is inherited for free from
-- process_payroll_batch()/process_terminal_due_allocations_batch()
-- themselves, called via process_payroll_with_terminal_dues() below,
-- exactly as it already is for an Admin's own direct processing.
-- ============================================================
CREATE OR REPLACE FUNCTION process_approved_payroll_request(p_request_id UUID, p_user_email TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_request RECORD;
  v_system_month TEXT;
  v_result JSONB;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only an Admin or super admin may process an approved payroll processing request';
  END IF;

  -- Same (tenant, month) lock process_payroll_with_terminal_dues() itself
  -- acquires -- reentrant within this same session/transaction (see that
  -- migration's own header) -- acquired here FIRST so a concurrent
  -- process attempt on a DIFFERENT request for the same month (or a
  -- concurrent direct Admin process call) serializes against this one too.
  SELECT * INTO v_request FROM payroll_processing_requests WHERE id = p_request_id AND tenant_id = v_tenant_id;
  IF v_request IS NULL THEN
    RAISE EXCEPTION 'Payroll processing request not found';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || v_request.month));

  -- Re-select FOR UPDATE now that the lock is held, so a concurrent
  -- process attempt on this SAME request (e.g. a double-click) blocks
  -- here and then sees the already-'processed' status below, rather than
  -- racing on the unlocked read above.
  SELECT * INTO v_request FROM payroll_processing_requests WHERE id = p_request_id AND tenant_id = v_tenant_id FOR UPDATE;
  IF v_request.status <> 'approved' THEN
    RAISE EXCEPTION 'This request is not approved (status: %) -- it may have already been processed, or was never approved', v_request.status;
  END IF;

  SELECT value INTO v_system_month FROM system_settings WHERE tenant_id = v_tenant_id AND key = 'current_payroll_month';
  IF v_system_month IS NULL OR v_request.month <> v_system_month THEN
    RAISE EXCEPTION 'Refusing to process: % is no longer the active payroll month (now %) -- this request needs a fresh submission and review', v_request.month, COALESCE(v_system_month, 'none configured');
  END IF;

  v_result := process_payroll_with_terminal_dues(
    v_request.month, v_request.payroll_records, p_user_email, v_request.audit_context,
    v_request.td_excluded_ids, v_request.td_exclusion_reason
  );

  UPDATE payroll_processing_requests SET
    status = 'processed', processing_reference = v_result->>'combined_reference', updated_at = NOW()
  WHERE id = p_request_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'CREATE', 'payroll_processing_request_processed', p_request_id::text,
    jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'processed', 'combined_reference', v_result->>'combined_reference')
  );

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'processed') || v_result;
END;
$$;

REVOKE ALL ON FUNCTION process_approved_payroll_request(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_approved_payroll_request(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION process_approved_payroll_request(UUID, TEXT) TO authenticated;

-- ============================================================
-- PART 5: process_payroll_with_terminal_dues() -- ONE new check added,
-- every other line byte-for-byte unchanged from 20261027000000.
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

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- ============================================================
  -- NEW (Phase 3D): only an Admin-class caller may COMMIT payroll
  -- processing directly -- an Accountant must go through
  -- submit_payroll_processing_request() -> Admin approval ->
  -- process_approved_payroll_request() instead. See this migration's own
  -- header for why is_super_admin() OR is_business_admin() (not
  -- has_permission('payroll.process'), which an Accountant also holds)
  -- is the correct bar here. When this function is reached via the
  -- nested call inside process_approved_payroll_request(), auth.uid() is
  -- the APPROVING ADMIN (nested SECURITY DEFINER calls do not change the
  -- session's own identity), so that path passes this check on the
  -- admin's own authority, never the original Accountant's.
  -- ============================================================
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

  v_has_td_permission := is_super_admin() OR has_explicit_permission('terminal_dues.approve');

  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || p_month));
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant_id::text || ':' || p_month, 0));

  v_payroll_result := process_payroll_batch(p_month, p_records, p_user_email, p_audit_context);

  SELECT COALESCE(SUM(net_pay), 0) INTO v_ordinary_total
  FROM payroll
  WHERE tenant_id = v_tenant_id AND month = p_month
    AND employee_id = ANY(ARRAY(SELECT (r->>'employee_id')::UUID FROM jsonb_array_elements(p_records) AS r));

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
-- RUN ONCE / RUN TWICE: idempotent -- CREATE TABLE has no IF NOT EXISTS
-- (a genuinely new table; re-running this migration on a database that
-- already has it will error, which is the standard, accepted behavior
-- for this schema's own migrations), CREATE OR REPLACE FUNCTION and the
-- REVOKE/GRANT statements are otherwise idempotent.
--
-- DEPENDENCIES: requires 20261027000000_terminal_dues_atomic_payroll_
-- integration.sql (process_payroll_with_terminal_dues(),
-- process_payroll_batch(), process_terminal_due_allocations_batch()) and
-- 20260817000000/20260817000007 (is_business_admin(), has_permission(),
-- has_explicit_permission(), get_current_tenant_id()).
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS: an Admin/super admin calling
-- process_payroll_with_terminal_dues() (directly, or via Payroll.tsx's
-- existing "Process Payroll" button) sees ZERO behavior change -- the one
-- new check they already pass. An Accountant who previously could call
-- process_payroll_with_terminal_dues() directly and have it succeed (true
-- as of Phase 3B/3C, since that function's only authorization came from
-- the DELEGATED process_payroll_batch() check, which already allowed
-- Accountant) will now be REJECTED by this new check -- this is the
-- entire, intentional point of this migration. The companion frontend
-- change (same PR) routes an Accountant-only caller to
-- submit_payroll_processing_request() instead, so this is not a dead end
-- for them in the UI.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('submit_payroll_processing_request', 'approve_payroll_processing_request',
--      'reject_payroll_processing_request', 'process_approved_payroll_request');
--   -- expected: 4 rows
--   SELECT has_function_privilege('authenticated', 'process_payroll_with_terminal_dues(text, jsonb, text, jsonb, uuid[], text)', 'EXECUTE');
--   -- expected: true (the orchestrator itself; its OWN body now additionally gates Admin-class)
--   SELECT polname FROM pg_policies WHERE tablename = 'payroll_processing_requests';
--   -- expected: 1 row (the SELECT policy)
--
-- ROLLBACK SQL (run this to fully revert this migration):
--   DROP FUNCTION IF EXISTS process_approved_payroll_request(UUID, TEXT);
--   DROP FUNCTION IF EXISTS reject_payroll_processing_request(UUID, TEXT);
--   DROP FUNCTION IF EXISTS approve_payroll_processing_request(UUID);
--   DROP FUNCTION IF EXISTS submit_payroll_processing_request(TEXT, JSONB, JSONB, UUID[], TEXT);
--   DROP TABLE IF EXISTS payroll_processing_requests;
--   -- Then re-apply 20261027000000_terminal_dues_atomic_payroll_integration.sql's
--   -- own CREATE OR REPLACE FUNCTION process_payroll_with_terminal_dues
--   -- block verbatim to restore the pre-Phase-3D body (removing the new
--   -- Admin-class gate) -- SAFE ONLY IF the companion frontend change
--   -- (which now calls submit_payroll_processing_request() for a non-
--   -- Admin-class caller) has ALSO been rolled back first.
-- ============================================================
