-- ============================================================
-- MIGRATION: Terminal Dues separation-of-duties (approve/pay split)
-- Date: 2026-09-05
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- -----------------------------------------------------------
-- Real staging HR acceptance testing on Terminal Dues surfaced that a
-- single `terminal_dues.edit OR terminal_dues.process` permission pair
-- let the SAME caller both edit a calculation's financial fields AND
-- change its status -- including a direct pending -> paid skip with no
-- approval step in between, and no record of WHO approved/paid or WHEN.
-- Approved business direction (verbatim): HR calculates/edits only, never
-- approves or pays; a Functional Admin approves (and may return an
-- approved calculation for correction); an Accountant records actual
-- payment only against an already-approved calculation, with mandatory
-- payment evidence (method + reference). The lifecycle is strictly
-- pending -> approved -> paid; pending -> paid is now impossible, enforced
-- SERVER-SIDE (RLS + SECURITY DEFINER RPCs), not merely by hiding buttons.
--
-- EXPLICIT CORRECTION THIS MIGRATION IMPLEMENTS (do not regress)
-- -----------------------------------------------------------
-- Every other SECURITY DEFINER RPC added during the functional-roles
-- rollout (see 20260817000003) deliberately preserves legacy access via an
-- `current_user_role_level() <= N OR has_permission(...)` branch, so an
-- existing legacy Manager/Admin account keeps working unchanged. That
-- shape is DELIBERATELY NOT used here. Business direction was explicit:
-- approve/pay/return authority must come ONLY from an EXPLICIT
-- role_permissions grant (or true platform super-admin) -- never from
-- current_user_role_level() <= 2 (which would let an ordinary legacy
-- Manager or Admin bypass the split), and NOT even from the standard
-- is_business_admin() "full tenant-wide authority" shortcut has_permission()
-- already grants everywhere else in this app (that shortcut is exactly why
-- a plain has_permission('terminal_dues.pay') check would let the
-- FUNCTIONAL Admin role mark things Paid "for free", contradicting the
-- explicit "Admin CANNOT mark Paid by default" requirement).
--
-- has_permission() itself is NOT modified -- doing so would change every
-- OTHER permission check across the whole app (payroll, salary advances,
-- recruitment, ...), a blast radius far beyond this request. Instead, PART
-- 2 below adds a new, narrower helper -- has_explicit_permission() -- used
-- ONLY by the 3 new RPCs in PART 4. It requires a real role_permissions
-- row for the caller's own `role`, with no is_business_admin() shortcut at
-- all. This is a genuine, deliberate divergence from this rollout's usual
-- pattern, scoped narrowly to satisfy an explicit business requirement --
-- see has_explicit_permission()'s own comment.
--
-- CONSEQUENCE FOR THE FUNCTIONAL ADMIN ROLE: because has_explicit_permission()
-- has no is_business_admin() shortcut, PART 3 explicitly seeds
-- ('admin', 'terminal_dues.approve') and ('admin', 'terminal_dues.view') --
-- unlike every other permission in this app, the functional Admin role does
-- NOT get Terminal Dues approve access "for free" as a business admin; it
-- gets it because this migration explicitly grants it, exactly matching
-- "Admin: view/approve" business direction. `terminal_dues.pay` is
-- deliberately NOT seeded for 'admin' -- an Admin cannot mark a terminal
-- due Paid unless a future migration explicitly grants it.
--
-- CONSEQUENCE FOR LEGACY ACCOUNTS (role_level 1-4, profiles.role often NULL
-- or an old free-text value): a legacy account gets terminal_dues.approve/
-- pay ONLY if its profiles.role literal happens to already equal 'admin'/
-- 'accountant' (matching one of the two new explicit seed rows) -- current
-- role_level is NEVER consulted for these two actions. A legacy Manager/
-- Supervisor (role_level 2/3, profiles.role typically 'manager'/
-- 'supervisor' or NULL) gets neither, by construction -- there is no seed
-- row for those role strings and no role_level-based fallback exists.
-- Existing view/create RLS (SELECT/INSERT) on terminal_dues is UNCHANGED
-- (still uses current_user_role_level() <= 2 OR has_permission(...),
-- preserving legacy compatibility exactly as before). The UPDATE (edit)
-- policy is NOT left unchanged -- see PART 4 below: it now requires
-- has_explicit_permission('terminal_dues.edit') with NO role_level
-- fallback and NO has_permission() business-admin shortcut, since editing
-- a Pending calculation's financial fields is itself part of the
-- separation-of-duties boundary this migration exists to close (a
-- legacy role_level <= 2 bypass here would let a legacy Manager OR a
-- legacy/functional Admin directly PATCH HR's financial figures, which is
-- exactly as much a violation as letting them approve/pay directly).
--
-- WHAT THIS MIGRATION DOES NOT DO
-- -----------------------------------------------------------
-- Does not touch salary_advances, payroll, or any other table's RLS/RPCs.
-- Does not change terminal_dues SELECT/INSERT policies (view/create) at
-- all. Does not add a dedicated "return" metadata column -- the return
-- reason is recorded in audit_logs.new_data only (kept minimal, per
-- instruction). Does not fabricate approved_by/paid_by for any existing
-- row -- every new column is nullable, defaulting to NULL for all
-- pre-existing rows.
-- ============================================================

-- ============================================================
-- PART 0: New nullable audit/payment columns on terminal_dues
-- ============================================================
-- All nullable, no default beyond NULL -- every existing Pending/Approved/
-- Paid row remains valid exactly as-is; a pre-existing Paid row with no
-- approved_by/paid_by is legitimate history (payment recorded before this
-- audit trail existed), never backfilled or fabricated. payment_date (the
-- actual date money changed hands, business-supplied) is deliberately
-- distinct from paid_at (when Safeguard's system recorded the payment,
-- server-generated NOW()) -- these can legitimately differ and must not be
-- conflated.
-- ============================================================

ALTER TABLE terminal_dues
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_date DATE,
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS payment_reference TEXT,
  ADD COLUMN IF NOT EXISTS payment_notes TEXT;

-- ============================================================
-- PART 1: retire terminal_dues.process (stop granting it going forward)
-- ============================================================
-- The permission STRING itself is left alone (no CHECK constraint or enum
-- restricts role_permissions.permission values, so there is nothing to
-- "delete" at the schema level beyond the seed row) -- but the one seed
-- row that granted it (hr_manager) is removed, and PART 4 below stops any
-- RLS policy from accepting it. See src/utils/permissions.ts and
-- src/pages/TerminalDues.tsx (same pass) for the frontend removal --
-- nothing in the running application will check for or grant this
-- permission after this migration.
-- ============================================================

DELETE FROM role_permissions WHERE role = 'hr_manager' AND permission = 'terminal_dues.process';

-- ============================================================
-- PART 2: has_explicit_permission() -- deliberately NO is_business_admin() bypass
-- ============================================================
-- See this migration's header for why this exists as a narrow, separate
-- function rather than a change to has_permission(). Same SECURITY
-- DEFINER/search_path/auth.uid()-resolves-caller shape as every other
-- helper in this rollout.
-- ============================================================

CREATE OR REPLACE FUNCTION has_explicit_permission(p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
BEGIN
  IF NOT is_current_user_active() THEN
    RETURN false;
  END IF;
  v_role := current_user_role();
  IF v_role IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM role_permissions WHERE role = v_role AND permission = p_permission);
END;
$$;

REVOKE ALL ON FUNCTION has_explicit_permission(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION has_explicit_permission(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION has_explicit_permission(TEXT) TO authenticated;

-- ============================================================
-- PART 3: seed the new permission keys
-- ============================================================
-- terminal_dues.approve / terminal_dues.pay are consulted ONLY via
-- has_explicit_permission() (PART 2/4) -- never via has_permission(), so
-- seeding (or not seeding) an 'admin' row here has real effect, unlike
-- every other permission in role_permissions (where an 'admin' row would
-- be redundant -- see that table's own header comment). hr_manager is
-- deliberately given NEITHER key (HR must never approve or pay).
-- operations_manager is deliberately given neither (item 3: "do NOT grant
-- financial approval/payment unless explicitly intended").
-- ============================================================

INSERT INTO role_permissions (role, permission) VALUES
  ('admin', 'terminal_dues.view'),
  ('admin', 'terminal_dues.approve'),
  ('accountant', 'terminal_dues.pay')
ON CONFLICT (role, permission) DO NOTHING;

-- ============================================================
-- PART 4: RLS -- retire .process from direct UPDATE, lock to Pending-only,
-- and make it impossible for a direct client UPDATE to change `status` at
-- all (every status transition must go through the PART 5 RPCs).
-- ============================================================
-- USING requires the CURRENT row to already be 'pending' -- a direct
-- client UPDATE can never touch an Approved or Paid row's financial
-- fields at all (item 9: "Approved: financial calculation fields locked.
-- Paid: fully locked", enforced at the database layer, not just by hiding
-- the Edit button). WITH CHECK requires the RESULTING row to still be
-- 'pending' -- so even a caller who could otherwise update a pending row
-- cannot smuggle a status change through this policy; status may only
-- ever change via approve_terminal_due()/record_terminal_due_payment()/
-- return_terminal_due_for_correction() (PART 5), all SECURITY DEFINER and
-- therefore not subject to this policy at all. is_super_admin() keeps its
-- existing full bypass (unchanged, per "TRUE PLATFORM SUPER ADMIN may
-- retain emergency/bypass capability according to the existing platform
-- architecture") -- a true super admin can still directly UPDATE any row
-- including its status, exactly as before this migration.
--
-- CORRECTED (same pass, before this migration was ever applied anywhere):
-- the edit-permission branch uses has_explicit_permission('terminal_dues.edit')
-- ONLY -- NOT current_user_role_level() <= 2 OR has_permission('terminal_dues.edit'),
-- which was the ORIGINAL shape of this policy and is a real separation-of-
-- duties hole, empirically reproduced: has_permission()'s is_business_admin()
-- shortcut means a FUNCTIONAL Admin (role='admin') and a LEGACY Admin
-- (role_level=1) both satisfy has_permission('terminal_dues.edit') "for
-- free", and current_user_role_level() <= 2 ADDITIONALLY lets a LEGACY
-- Manager (role_level=2) through -- all three could previously issue a raw
-- `UPDATE terminal_dues SET deductions = ...` against a Pending row despite
-- having no business role in calculating it, exactly the kind of PATCH the
-- frontend hides but RLS did not actually block. Business direction is
-- explicit: Admin/Accountant must NOT edit Pending financial fields under
-- ANY path (only approve/return, only pay/nothing, respectively), and
-- legacy role_level is NEVER an acceptable substitute for an explicit
-- terminal_dues.edit grant on this specific boundary -- unlike the
-- INSERT/SELECT policies below (deliberately left alone; view/create was
-- not the reported gap and is out of this fix's scope). Consequence:
-- hr_manager keeps edit access via its existing explicit
-- ('hr_manager','terminal_dues.edit') seed row (20260817000000); NO other
-- role (including 'admin', whether functional or legacy role_level=1, and
-- legacy role_level=2 'manager'/'supervisor' strings) gets Pending-edit
-- access unless a future migration explicitly seeds it a terminal_dues.edit
-- row -- a deliberate, real behavior tightening for any such legacy
-- account, per explicit instruction not to preserve role_level as a
-- financial-edit bypass.
-- ============================================================

DROP POLICY IF EXISTS "Terminal dues: update within tenant+region, action or legacy permitted" ON terminal_dues;
DROP POLICY IF EXISTS "Terminal dues: edit Pending calculation only, status via RPC" ON terminal_dues;
CREATE POLICY "Terminal dues: edit Pending calculation only, status via RPC" ON terminal_dues
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND status = 'pending'
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = terminal_dues.employee_id AND region_allowed(e.region_id))
      AND has_explicit_permission('terminal_dues.edit')
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND status = 'pending'
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = terminal_dues.employee_id AND region_allowed(e.region_id))
      AND has_explicit_permission('terminal_dues.edit')
    )
  )
);
-- SELECT/INSERT policies and "Super admins can delete terminal dues"
-- unchanged -- this migration only touches the UPDATE policy. has_explicit_
-- permission() is defined in PART 2 ABOVE this policy in file order, but
-- since it is CREATE OR REPLACE'd before this CREATE POLICY statement runs
-- (both execute in the same migration transaction, in file order), there is
-- no forward-reference problem.

-- ============================================================
-- PART 5: approve_terminal_due(), record_terminal_due_payment(),
-- return_terminal_due_for_correction()
-- ============================================================
-- All three: SECURITY DEFINER, resolve the caller via auth.uid()/
-- get_current_tenant_id() (rejects inactive/deleted callers automatically,
-- per Part 0 of 20260817000000), lock the target row with FOR UPDATE
-- before checking its status (so two concurrent calls cannot both succeed
-- against the same row), and RAISE EXCEPTION -- rolling back the whole
-- transaction, no partial state change -- on any authorization or state
-- failure. Region check uses region_allowed() against the row's OWN
-- employee (resolved server-side from terminal_dues.employee_id, never a
-- client-supplied region), same pattern as approve_salary_advance().
-- ============================================================

CREATE OR REPLACE FUNCTION approve_terminal_due(p_terminal_due_id UUID)
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

  IF NOT (is_super_admin() OR has_explicit_permission('terminal_dues.approve')) THEN
    RAISE EXCEPTION 'Only an Admin explicitly granted terminal_dues.approve (or a super admin) may approve terminal dues';
  END IF;

  SELECT * INTO v_due FROM terminal_dues WHERE id = p_terminal_due_id FOR UPDATE;

  IF v_due IS NULL OR (v_due.tenant_id <> v_tenant_id AND NOT is_super_admin()) THEN
    RAISE EXCEPTION 'Terminal due record not found';
  END IF;

  IF NOT (is_super_admin() OR is_business_admin()) THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_due.employee_id AND region_allowed(region_id)) THEN
      RAISE EXCEPTION 'This employee is outside your assigned region';
    END IF;
  END IF;

  IF v_due.status <> 'pending' THEN
    RAISE EXCEPTION 'Cannot approve a % terminal due -- only a pending calculation can be approved', v_due.status;
  END IF;

  UPDATE terminal_dues SET
    status = 'approved',
    approved_by = v_caller_id,
    approved_at = NOW(),
    updated_at = NOW()
  WHERE id = p_terminal_due_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_tenant_id, v_caller_id, 'APPROVE', 'terminal_due', p_terminal_due_id::text,
    jsonb_build_object('status', v_due.status),
    jsonb_build_object('status', 'approved', 'approved_by', v_caller_id)
  );

  RETURN jsonb_build_object('success', true, 'id', p_terminal_due_id, 'status', 'approved');
END;
$$;

REVOKE ALL ON FUNCTION approve_terminal_due(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_terminal_due(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION approve_terminal_due(UUID) TO authenticated;

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

REVOKE ALL ON FUNCTION record_terminal_due_payment(UUID, DATE, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_terminal_due_payment(UUID, DATE, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION record_terminal_due_payment(UUID, DATE, TEXT, TEXT, TEXT) TO authenticated;

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

  IF NOT (is_super_admin() OR is_business_admin()) THEN
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

  -- Clear approval metadata -- the calculation is no longer approved, so
  -- these fields must not go on claiming that it is. The return reason
  -- itself is deliberately NOT stored on the row (kept minimal, per
  -- instruction) -- it is preserved in the audit trail below instead.
  UPDATE terminal_dues SET
    status = 'pending',
    approved_by = NULL,
    approved_at = NULL,
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

REVOKE ALL ON FUNCTION return_terminal_due_for_correction(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION return_terminal_due_for_correction(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION return_terminal_due_for_correction(UUID, TEXT) TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- ADD COLUMN IF NOT EXISTS, CREATE OR
-- REPLACE FUNCTION, DROP POLICY IF EXISTS before CREATE POLICY, DELETE +
-- ON CONFLICT DO NOTHING for the seed changes.
--
-- PREFLIGHT: none required beyond the standard "no other session holds a
-- long-running transaction against terminal_dues" check -- ADD COLUMN on a
-- small table is fast; no data backfill/rewrite.
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS:
--   * Any account (legacy or functional) that could previously call the
--     client-side `updateStatus()` UPDATE directly can no longer change
--     `status` through a raw UPDATE at all (PART 4) -- including the
--     previously-possible pending -> paid skip. This is the entire point
--     of the migration and applies to every non-super-admin caller,
--     regardless of what permission they held before.
--   * hr_manager loses terminal_dues.process (PART 1/3) -- HR can still
--     view/create/edit a PENDING calculation, exactly as before (via its
--     explicit terminal_dues.edit seed row), but can no longer change its
--     status by any path.
--   * A caller who is is_business_admin() (role='admin' or legacy
--     role_level=1) does NOT automatically gain terminal_dues.approve/pay
--     -- unlike every other permission in this app. Only a profile whose
--     literal `role` is 'admin' (approve) or 'accountant' (pay) gets these,
--     per the new explicit seed rows -- see this migration's header.
--   * REAL TIGHTENING (found and fixed before this migration was ever
--     applied anywhere): the UPDATE policy's edit-permission branch no
--     longer accepts current_user_role_level() <= 2 OR has_permission(...)
--     -- it requires has_explicit_permission('terminal_dues.edit') only.
--     A legacy Manager (role_level=2), a legacy Admin (role_level=1), and
--     a FUNCTIONAL Admin (role='admin') can each no longer directly PATCH
--     a Pending calculation's financial fields -- only hr_manager (its
--     existing explicit seed row) retains this. This was empirically
--     reproduced as a real gap (all three could edit before this fix) and
--     is a deliberate tightening, not a regression -- editing HR's
--     financial figures is exactly as much a separation-of-duties concern
--     as directly approving/paying.
--   * True super admin (is_super_admin()) behavior is unchanged everywhere
--     in this migration.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'terminal_dues'
--       AND column_name IN ('approved_by','approved_at','paid_by','paid_at',
--                            'payment_date','payment_method','payment_reference','payment_notes');
--   -- expected: 8 rows
--   SELECT proname, prosecdef FROM pg_proc WHERE proname IN
--     ('has_explicit_permission','approve_terminal_due',
--      'record_terminal_due_payment','return_terminal_due_for_correction');
--   -- expected: 4 rows, all prosecdef = true
--   SELECT role, permission FROM role_permissions WHERE permission LIKE 'terminal_dues.%' ORDER BY role, permission;
--   -- expected: accountant/terminal_dues.pay, accountant/terminal_dues.view,
--   -- admin/terminal_dues.approve, admin/terminal_dues.view,
--   -- hr_manager/terminal_dues.create, hr_manager/terminal_dues.edit,
--   -- hr_manager/terminal_dues.view (NO hr_manager/terminal_dues.process row)
--   SELECT qual, with_check FROM pg_policies WHERE tablename = 'terminal_dues' AND cmd = 'UPDATE';
--   -- expected: both qual and with_check contain "has_explicit_permission"
--   -- and neither contains "current_user_role_level" or "has_permission(" --
--   -- if either does, the separation-of-duties fix above did not apply.
--
-- ROLLBACK SQL:
--   DROP FUNCTION IF EXISTS return_terminal_due_for_correction(UUID, TEXT);
--   DROP FUNCTION IF EXISTS record_terminal_due_payment(UUID, DATE, TEXT, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS approve_terminal_due(UUID);
--   DROP FUNCTION IF EXISTS has_explicit_permission(TEXT);
--   DELETE FROM role_permissions WHERE (role, permission) IN
--     (('admin','terminal_dues.view'), ('admin','terminal_dues.approve'), ('accountant','terminal_dues.pay'));
--   INSERT INTO role_permissions (role, permission) VALUES ('hr_manager', 'terminal_dues.process') ON CONFLICT DO NOTHING;
--   -- Then re-apply 20260817000002's ORIGINAL "Terminal dues: update within
--   -- tenant+region, action or legacy permitted" UPDATE policy verbatim
--   -- (DROP POLICY IF EXISTS "Terminal dues: edit Pending calculation only,
--   -- status via RPC" ON terminal_dues; then the original CREATE POLICY).
--   -- New terminal_dues columns are left in place (dropping them would
--   -- destroy any approval/payment audit data already recorded) --
--   -- ALTER TABLE terminal_dues DROP COLUMN IF EXISTS <col> for each of the
--   -- 8 new columns only if a full rollback of the schema is truly needed.
-- ============================================================
