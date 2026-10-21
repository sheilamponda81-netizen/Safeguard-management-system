-- ============================================================
-- MIGRATION: Financial snapshot capture + revalidation for the
-- Accountant/Admin payroll processing request workflow
-- Date: 2026-10-30
-- ============================================================
--
-- PROBLEM THIS MIGRATION FIXES
-- -----------------------------------------------------------
-- An Admin approving a payroll processing request currently sees only a
-- status badge and a submission timestamp (Payroll.tsx's own request
-- panel) -- no employee count, no totals, no Terminal Dues figures. Worse,
-- process_approved_payroll_request() (20261028000000) only re-validates
-- that the authoritative payroll MONTH hasn't changed between submission
-- and processing -- it never re-checks whether the financial SCOPE the
-- Admin actually reviewed still matches what is about to commit. Two
-- concrete, realistic drifts were previously undetected:
--   1. Terminal Dues eligibility drift: a NEW allocation gets approved,
--      an existing one gets held/revised/rejected, or an exclusion
--      changes, between submission and processing. Because
--      process_payroll_with_terminal_dues() always re-queries the LIVE
--      'approved' allocation set at commit time (by design -- see
--      20261027000000's own header, "never against anything this
--      orchestrator or the client precomputed earlier"), the amount that
--      actually commits can silently differ from what the Admin was
--      shown and approved.
--   2. Employee scope drift: an employee referenced in the frozen
--      p_records snapshot gets soft-deleted after submission.
--      process_payroll_batch() has never validated this (confirmed by
--      direct inspection of its current body -- no is_deleted check
--      exists anywhere in it), so a deleted employee's payroll could
--      still be committed from a stale snapshot.
--
-- WHAT THIS MIGRATION DOES NOT ATTEMPT, AND WHY
-- -----------------------------------------------------------
-- gross_pay/paye/pension/net_pay are computed in the BROWSER
-- (calculatePayroll/calculateLivePayroll) from attendance, salary, and
-- deduction data, and are deliberately never recomputed server-side --
-- this is a standing architectural rule repeated in this schema's own
-- migration headers across every payroll phase (process_payroll_batch's
-- own header, process_approved_payroll_request's own header above this
-- one). Porting that calculation engine into SQL would be a genuinely
-- large, separate undertaking (duplicating hundreds of lines of
-- attendance/deduction/advance logic), not something safely done inside
-- a financial-integrity hotfix. This migration therefore does NOT
-- recompute gross/net/PAYE/pension from first principles -- it captures
-- them ONCE, authoritatively, directly from the very payload the caller
-- supplies (the same numbers process_payroll_batch() itself will insert
-- unchanged), and freezes them. What it DOES newly, honestly, and fully
-- revalidate from LIVE data -- because both are genuinely, independently
-- queryable server-side without touching the payroll engine -- are
-- exactly the two drifts above: the live Terminal Dues eligible-
-- allocation set/total, and live employee active status.
--
-- ARCHITECTURE
-- -----------------------------------------------------------
-- compute_payroll_request_snapshot(tenant, month, records, td_excluded_ids)
-- is a new internal helper (no direct client grant -- called only from
-- the three RPCs below) returning one JSONB object:
--   employee_ids / employee_count   -- derived from p_records itself
--   ordinary_gross_total            -- SUM(gross_pay) over p_records
--   ordinary_deductions_total       -- SUM(paye+pension+uniform_deduction)
--   ordinary_net_total              -- SUM(net_pay) over p_records (the
--                                       PRE-salary-advance-deduction
--                                       figure, same convention as every
--                                       other total in this schema --
--                                       see process_payroll_with_terminal_
--                                       dues()'s own v_ordinary_total
--                                       comment for why the TRUE post-
--                                       advance figure can only be read
--                                       back from `payroll` AFTER
--                                       process_payroll_batch() commits,
--                                       never computed in advance)
--   eligible_td_allocation_ids/count/eligible_td_total -- a LIVE query
--                                       against terminal_due_allocations
--                                       (status = 'approved' for this
--                                       month, minus td_excluded_ids) --
--                                       genuinely re-queryable, the one
--                                       true "can this have changed"
--                                       signal this migration exists to
--                                       track
--   inactive_employee_ids           -- employees in p_records that are
--                                       currently is_deleted = true --
--                                       always computed live, never
--                                       compared against a stored value
--                                       (a non-empty result is ALWAYS
--                                       invalid, at submission as much as
--                                       at approval/processing)
--   td_excluded_ids / captured_at
--
-- submit_payroll_processing_request() calls this ONCE and stores the
-- result in the new payroll_processing_requests.financial_snapshot
-- column -- an authoritative, server-computed record of exactly what was
-- proposed, never re-derived from a live query at processing time for
-- the ordinary-payroll portion (those numbers cannot drift -- they are
-- read back from the SAME frozen payroll_records every time), but fully
-- re-derivable for the Terminal Dues portion and employee scope.
--
-- approve_payroll_processing_request() and process_approved_payroll_
-- request() each call compute_payroll_request_snapshot() AGAIN, using
-- the SAME stored v_request.payroll_records/td_excluded_ids, and compare
-- the freshly-computed eligible_td_allocation_ids/eligible_td_total
-- against the ORIGINAL financial_snapshot captured at submission --
-- across BOTH checkpoints, transitively guaranteeing "what was approved
-- is what commits": if submission and approval agree, and approval and
-- processing agree, submission and processing agree. inactive_employee_
-- ids is checked fresh at every checkpoint against an empty expectation
-- (never against a stored value, since it is never valid at any
-- checkpoint). A request submitted before this migration (financial_
-- snapshot IS NULL) is treated the same as a mismatch -- refused, asking
-- for a fresh submission, never silently approved/processed against an
-- unknown scope.
--
-- ON MISMATCH: the affected RPC raises, exactly the same error-surfacing
-- convention every other check in this workflow already uses -- NOTHING
-- is written (the whole calling transaction rolls back), and the
-- request's own status is therefore left completely unchanged (still
-- 'pending' if caught at approval, still 'approved' if caught at
-- processing) -- preserving the original request and its approval audit
-- history exactly as they were. An Admin who hits this is directed to
-- reject the request so the Accountant (or Admin) can resubmit with
-- current figures -- reject_payroll_processing_request() below is
-- extended (previously 'pending' only) to also accept an 'approved'
-- request, since an approved-but-now-stale request that was never
-- actually processed has committed nothing and is safe to reject at any
-- time before processing succeeds.
--
-- CONCURRENCY
-- -----------------------------------------------------------
-- process_approved_payroll_request()'s existing (tenant, month) advisory
-- lock (acquired before this migration's new checks run) and its
-- existing FOR UPDATE re-select of the request row are unchanged and
-- still the first things that happen. The new snapshot comparison runs
-- after both, inside the same already-serialized transaction. It is a
-- fast pre-check for the common case, not itself the final concurrency
-- guarantee for Terminal Dues specifically -- process_terminal_due_
-- allocations_batch() (unchanged) still independently re-reads every
-- candidate allocation under its own FOR UPDATE row locks moments later
-- in this SAME transaction, which is what actually makes a concurrent
-- modification to one of those exact rows serialize correctly against
-- this commit (the standard MVCC/row-lock guarantee this schema already
-- relies on throughout -- see 20261026000000's own header). Two
-- genuinely different concerns, both now covered: "does this match what
-- was reviewed" (new, this migration) and "is each candidate allocation
-- still individually valid right now" (existing, untouched).
--
-- WHAT IS UNCHANGED (explicitly, per this phase's own safety
-- requirements): the Admin-class gate on direct processing and on
-- approve/reject; the Accountant's inability to approve or bypass;
-- individual Terminal Dues allocation approve/reject (still gated on
-- terminal_dues.approve alone); the one-Postgres-transaction atomic
-- commit; direct Admin processing via process_payroll_with_terminal_
-- dues() (no request row exists for that path, so there is nothing to
-- snapshot or revalidate -- zero time elapses between an Admin's own
-- review and their own commit in that path, which is why this gap never
-- applied to it).
-- ============================================================

ALTER TABLE payroll_processing_requests
  ADD COLUMN IF NOT EXISTS financial_snapshot JSONB;

-- ============================================================
-- PART 1: compute_payroll_request_snapshot() -- internal helper only,
-- no direct client grant (REVOKEd from PUBLIC/anon/authenticated below).
-- ============================================================
CREATE OR REPLACE FUNCTION compute_payroll_request_snapshot(
  p_tenant_id UUID,
  p_month TEXT,
  p_records JSONB,
  p_td_excluded_ids UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_employee_ids UUID[];
  v_gross_total NUMERIC := 0;
  v_deductions_total NUMERIC := 0;
  v_net_total NUMERIC := 0;
  v_td_ids UUID[];
  v_td_total NUMERIC := 0;
  v_inactive_ids UUID[];
BEGIN
  SELECT array_agg(DISTINCT (r->>'employee_id')::UUID ORDER BY (r->>'employee_id')::UUID)
    INTO v_employee_ids
    FROM jsonb_array_elements(p_records) AS r;

  SELECT
    COALESCE(SUM((r->>'gross_pay')::NUMERIC), 0),
    COALESCE(SUM((r->>'paye')::NUMERIC + (r->>'pension')::NUMERIC + (r->>'uniform_deduction')::NUMERIC), 0),
    COALESCE(SUM((r->>'net_pay')::NUMERIC), 0)
  INTO v_gross_total, v_deductions_total, v_net_total
  FROM jsonb_array_elements(p_records) AS r;

  SELECT COALESCE(array_agg(id ORDER BY id), '{}'), COALESCE(SUM(proposed_amount), 0)
    INTO v_td_ids, v_td_total
    FROM terminal_due_allocations
    WHERE tenant_id = p_tenant_id AND payroll_month = p_month AND status = 'approved'
      AND NOT (id = ANY(COALESCE(p_td_excluded_ids, '{}')));

  SELECT COALESCE(array_agg(id ORDER BY id), '{}')
    INTO v_inactive_ids
    FROM employees
    WHERE id = ANY(COALESCE(v_employee_ids, '{}')) AND is_deleted;

  RETURN jsonb_build_object(
    'employee_ids', to_jsonb(COALESCE(v_employee_ids, '{}')),
    'employee_count', COALESCE(array_length(v_employee_ids, 1), 0),
    'ordinary_gross_total', v_gross_total,
    'ordinary_deductions_total', v_deductions_total,
    'ordinary_net_total', v_net_total,
    'eligible_td_allocation_ids', to_jsonb(v_td_ids),
    'eligible_td_count', COALESCE(array_length(v_td_ids, 1), 0),
    'eligible_td_total', v_td_total,
    'td_excluded_ids', to_jsonb(COALESCE(p_td_excluded_ids, '{}')),
    'inactive_employee_ids', to_jsonb(v_inactive_ids),
    'captured_at', NOW()
  );
END;
$$;

REVOKE ALL ON FUNCTION compute_payroll_request_snapshot(UUID, TEXT, JSONB, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION compute_payroll_request_snapshot(UUID, TEXT, JSONB, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION compute_payroll_request_snapshot(UUID, TEXT, JSONB, UUID[]) FROM authenticated;

-- ============================================================
-- PART 2: submit_payroll_processing_request() -- every line unchanged
-- from 20261028000000 except: rejects a submission that already
-- references a deleted employee, and stores the computed snapshot.
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
  v_snapshot JSONB;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

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

  IF p_td_excluded_ids IS NOT NULL AND array_length(p_td_excluded_ids, 1) > 0
     AND NOT (v_is_super_admin OR has_explicit_permission('terminal_dues.approve'))
  THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may select Terminal Dues exclusions';
  END IF;

  v_snapshot := compute_payroll_request_snapshot(v_tenant_id, p_month, p_records, p_td_excluded_ids);
  IF jsonb_array_length(v_snapshot->'inactive_employee_ids') > 0 THEN
    RAISE EXCEPTION 'Refusing to submit: this request includes % employee(s) who are no longer active -- refresh the page and try again', jsonb_array_length(v_snapshot->'inactive_employee_ids');
  END IF;

  INSERT INTO payroll_processing_requests (
    tenant_id, month, status, initiated_by, payroll_records, audit_context, td_excluded_ids, td_exclusion_reason, financial_snapshot
  ) VALUES (
    v_tenant_id, p_month, 'pending', v_caller_id, p_records, p_audit_context, COALESCE(p_td_excluded_ids, '{}'), p_td_exclusion_reason, v_snapshot
  ) RETURNING id INTO v_request_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'CREATE', 'payroll_processing_request', v_request_id::text,
    '{}'::JSONB,
    jsonb_build_object('month', p_month, 'employeeCount', jsonb_array_length(p_records), 'status', 'pending', 'financial_snapshot', v_snapshot)
  );

  RETURN jsonb_build_object('success', true, 'request_id', v_request_id, 'status', 'pending', 'month', p_month) || v_snapshot;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'A payroll processing request for % is already pending or approved -- wait for it to be decided, or ask an Admin to reject it first', p_month;
END;
$$;

REVOKE ALL ON FUNCTION submit_payroll_processing_request(TEXT, JSONB, JSONB, UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION submit_payroll_processing_request(TEXT, JSONB, JSONB, UUID[], TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION submit_payroll_processing_request(TEXT, JSONB, JSONB, UUID[], TEXT) TO authenticated;

-- ============================================================
-- PART 3: approve_payroll_processing_request() -- adds snapshot
-- revalidation before the status flip; every other line unchanged.
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
  v_fresh JSONB;
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

  IF v_request.financial_snapshot IS NULL THEN
    RAISE EXCEPTION 'Refusing to approve: this request was submitted before financial snapshots were tracked -- reject it and ask for a fresh submission';
  END IF;

  v_fresh := compute_payroll_request_snapshot(v_tenant_id, v_request.month, v_request.payroll_records, v_request.td_excluded_ids);

  IF jsonb_array_length(v_fresh->'inactive_employee_ids') > 0 THEN
    RAISE EXCEPTION 'Refusing to approve: one or more employees in this request are no longer active -- reject this request and ask for a fresh submission';
  END IF;

  IF (v_fresh->'eligible_td_allocation_ids') <> (v_request.financial_snapshot->'eligible_td_allocation_ids')
     OR (v_fresh->>'eligible_td_total')::NUMERIC <> (v_request.financial_snapshot->>'eligible_td_total')::NUMERIC
  THEN
    RAISE EXCEPTION 'Refusing to approve: the approved Terminal Dues allocations for this month have changed since this request was submitted (an allocation was approved, held, revised, or excluded) -- reject this request and ask for a fresh submission';
  END IF;

  UPDATE payroll_processing_requests SET
    status = 'approved', reviewed_by = v_caller_id, reviewed_at = NOW(), updated_at = NOW()
  WHERE id = p_request_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'APPROVE', 'payroll_processing_request', p_request_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'approved', 'month', v_request.month, 'financial_snapshot', v_request.financial_snapshot)
  );

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'approved', 'month', v_request.month) || v_request.financial_snapshot;
END;
$$;

REVOKE ALL ON FUNCTION approve_payroll_processing_request(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_payroll_processing_request(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION approve_payroll_processing_request(UUID) TO authenticated;

-- ============================================================
-- PART 4: reject_payroll_processing_request() -- now also accepts an
-- 'approved' request (previously 'pending' only), so a request this
-- migration's own revalidation stranded in 'approved' (financial drift
-- discovered only at processing time) can actually be unblocked. Nothing
-- has been committed for such a request (process_approved_payroll_
-- request() always raises BEFORE any write when it detects drift), so
-- rejecting it at this point is exactly as safe as rejecting a pending
-- one -- no financial history is altered either way.
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
  IF v_request.status NOT IN ('pending', 'approved') THEN
    RAISE EXCEPTION 'This request is no longer pending or approved (status: %) -- it may have already been decided', v_request.status;
  END IF;

  UPDATE payroll_processing_requests SET
    status = 'rejected', reviewed_by = v_caller_id, reviewed_at = NOW(), rejection_reason = btrim(p_reason), updated_at = NOW()
  WHERE id = p_request_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'REJECT', 'payroll_processing_request', p_request_id::text,
    jsonb_build_object('status', v_request.status),
    jsonb_build_object('status', 'rejected', 'month', v_request.month, 'reason', btrim(p_reason))
  );

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'rejected', 'month', v_request.month);
END;
$$;

REVOKE ALL ON FUNCTION reject_payroll_processing_request(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_payroll_processing_request(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION reject_payroll_processing_request(UUID, TEXT) TO authenticated;

-- ============================================================
-- PART 5: process_approved_payroll_request() -- adds the SAME snapshot
-- revalidation (against the ORIGINAL submission-time financial_snapshot,
-- not whatever approve_payroll_processing_request() last saw -- by
-- transitivity, if approval's own check passed, the stored snapshot was
-- still accurate as of approval time, so comparing against it here
-- correctly catches drift from EITHER before or after approval) before
-- calling process_payroll_with_terminal_dues(); every other line
-- unchanged.
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
  v_fresh JSONB;
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

  SELECT * INTO v_request FROM payroll_processing_requests WHERE id = p_request_id AND tenant_id = v_tenant_id;
  IF v_request IS NULL THEN
    RAISE EXCEPTION 'Payroll processing request not found';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant_id::text || ':' || v_request.month));

  SELECT * INTO v_request FROM payroll_processing_requests WHERE id = p_request_id AND tenant_id = v_tenant_id FOR UPDATE;
  IF v_request.status <> 'approved' THEN
    RAISE EXCEPTION 'This request is not approved (status: %) -- it may have already been processed, or was never approved', v_request.status;
  END IF;

  SELECT value INTO v_system_month FROM system_settings WHERE tenant_id = v_tenant_id AND key = 'current_payroll_month';
  IF v_system_month IS NULL OR v_request.month <> v_system_month THEN
    RAISE EXCEPTION 'Refusing to process: % is no longer the active payroll month (now %) -- this request needs a fresh submission and review', v_request.month, COALESCE(v_system_month, 'none configured');
  END IF;

  IF v_request.financial_snapshot IS NULL THEN
    RAISE EXCEPTION 'Refusing to process: this request was approved before financial snapshots were tracked -- reject it and ask for a fresh submission';
  END IF;

  v_fresh := compute_payroll_request_snapshot(v_tenant_id, v_request.month, v_request.payroll_records, v_request.td_excluded_ids);

  IF jsonb_array_length(v_fresh->'inactive_employee_ids') > 0 THEN
    RAISE EXCEPTION 'Refusing to process: one or more employees in this request are no longer active -- reject this request and ask for a fresh submission';
  END IF;

  IF (v_fresh->'eligible_td_allocation_ids') <> (v_request.financial_snapshot->'eligible_td_allocation_ids')
     OR (v_fresh->>'eligible_td_total')::NUMERIC <> (v_request.financial_snapshot->>'eligible_td_total')::NUMERIC
  THEN
    RAISE EXCEPTION 'Refusing to process: the approved Terminal Dues allocations for this month have changed since this request was submitted (an allocation was approved, held, revised, or excluded) -- reject this request and ask for a fresh submission';
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
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- ADD COLUMN IF NOT EXISTS, CREATE OR
-- REPLACE FUNCTION, and the same REVOKE/GRANT statements every time.
--
-- DEPENDENCIES: requires 20261028000000 (payroll_processing_requests,
-- the four RPCs this migration re-declares) and 20261029000000
-- (process_payroll_with_terminal_dues(), unchanged, still called as-is).
--
-- PREFLIGHT: none needed -- ADD COLUMN on an existing table is a fast,
-- non-blocking metadata-only change (nullable, no default backfill
-- computation); no existing row's payroll_records/audit_context/status
-- is touched.
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS: a BRAND NEW request submitted
-- after this migration now carries a financial_snapshot and is fully
-- protected. Any request already sitting in 'pending' or 'approved'
-- status at the moment this migration is applied (financial_snapshot
-- NULL) will be refused at its next approve/process call with a clear,
-- explicit message asking for a fresh submission -- by design, since
-- this migration has no honest way to retroactively know what such a
-- request's reviewer actually saw. Given this is a draft PR never
-- applied to STAGING/PRODUCTION, no live request is expected to be in
-- this state when this migration lands there.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'payroll_processing_requests' AND column_name = 'financial_snapshot';
--   -- expected: 1 row
--   SELECT has_function_privilege('authenticated', 'compute_payroll_request_snapshot(uuid, text, jsonb, uuid[])', 'EXECUTE');
--   -- expected: false (internal helper only)
--   SELECT proname FROM pg_proc WHERE proname = 'reject_payroll_processing_request';
--   SELECT prosrc LIKE '%NOT IN (''pending'', ''approved'')%' FROM pg_proc WHERE proname = 'reject_payroll_processing_request';
--   -- expected: true (now accepts 'approved' too)
--
-- ROLLBACK SQL (run this to fully revert this migration -- safe at any
-- time, since the new column is additive and nullable, and no existing
-- row's other data is altered):
--   Re-apply 20261028000000's own CREATE OR REPLACE FUNCTION blocks for
--   submit_payroll_processing_request/approve_payroll_processing_request/
--   reject_payroll_processing_request/process_approved_payroll_request
--   verbatim (restores pre-snapshot behavior), then:
--   DROP FUNCTION IF EXISTS compute_payroll_request_snapshot(UUID, TEXT, JSONB, UUID[]);
--   ALTER TABLE payroll_processing_requests DROP COLUMN IF EXISTS financial_snapshot;
-- ============================================================
