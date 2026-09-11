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
-- Existing view RLS (SELECT) on terminal_dues is UNCHANGED (still uses
-- current_user_role_level() <= 2 OR has_permission('terminal_dues.view'),
-- preserving legacy compatibility exactly as before -- Admin and
-- Accountant both still need read access for the approve/pay workflow,
-- so SELECT was never the reported gap and stays out of scope). The
-- UPDATE (edit) and INSERT (create) policies are NOT left unchanged --
-- see PART 4/PART 4b below: both now require
-- has_explicit_permission('terminal_dues.edit'/'terminal_dues.create')
-- with NO role_level fallback and NO has_permission() business-admin
-- shortcut, since both editing a Pending calculation's financial fields
-- AND originating one in the first place are part of the separation-of-
-- duties boundary this migration exists to close (a legacy role_level <=
-- 2 bypass on either would let a legacy Manager OR a legacy/functional
-- Admin directly PATCH or INSERT HR's financial figures, exactly as much
-- a violation as letting them approve/pay directly).
--
-- WHAT THIS MIGRATION DOES NOT DO
-- -----------------------------------------------------------
-- Does not touch salary_advances, payroll, or any other table's RLS/RPCs.
-- Does not change terminal_dues's SELECT (view) policy at all. Does not
-- add a dedicated "return" metadata column -- the return reason is
-- recorded in audit_logs.new_data only (kept minimal, per instruction).
-- Does not fabricate approved_by/paid_by for any existing row -- every
-- new column is nullable, defaulting to NULL for all pre-existing rows.
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

-- ============================================================
-- PART 4b: RLS -- the SAME hole, found in INSERT (create) after the UPDATE
-- fix above, before this migration was ever applied anywhere. SELECT is
-- deliberately left alone (Admin and Accountant both still need read
-- access for the approve/pay workflow -- narrowing SELECT was never the
-- reported gap and stays out of scope).
-- ============================================================
-- Empirically reproduced the same way as the UPDATE gap: the ORIGINAL
-- INSERT policy's WITH CHECK used
-- `current_user_role_level() <= 2 OR has_permission('terminal_dues.create')`
-- -- a FUNCTIONAL Admin (role='admin') passes via has_permission()'s
-- is_business_admin() shortcut, and a legacy Admin (role_level=1) or
-- legacy Manager (role_level=2) both pass via role_level <= 2 -- all three
-- could directly INSERT a brand-new terminal_dues row despite having no
-- business role in originating one. Business direction: Admin approves
-- HR-created dues, it does not originate them; Accountant and Operations
-- Manager have no create role at all unless a future migration explicitly
-- grants terminal_dues.create. Fix is identical in shape to PART 4: the
-- permission branch becomes has_explicit_permission('terminal_dues.create')
-- only -- hr_manager keeps create access via its existing explicit
-- ('hr_manager','terminal_dues.create') seed row (20260817000000); no
-- other role gains it without a future explicit grant. is_super_admin()
-- keeps its full, unchanged, documented bypass.
-- ============================================================

DROP POLICY IF EXISTS "Terminal dues: create within tenant+region, action or legacy permitted" ON terminal_dues;
DROP POLICY IF EXISTS "Terminal dues: create within tenant+region, explicit permission only" ON terminal_dues;
CREATE POLICY "Terminal dues: create within tenant+region, explicit permission only" ON terminal_dues
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND status = 'pending'
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = terminal_dues.employee_id AND region_allowed(e.region_id))
      AND has_explicit_permission('terminal_dues.create')
    )
  )
);
-- SELECT policy and "Super admins can delete terminal dues" unchanged --
-- this migration touches the UPDATE and INSERT policies only. The
-- `AND status = 'pending'` clause added above (release-blocking fix, see
-- PART 6 below for the full explanation and the primary mechanism that
-- actually closes this gap) is cheap, redundant-for-a-well-behaved-client
-- defense-in-depth, matching the UPDATE policy's own pre-existing
-- status='pending' requirement -- it is NOT by itself sufficient (see
-- PART 6), since it says nothing about approved_by/paid_by/payment_*/
-- returned_* being forgeable while status stays 'pending' or 'INSERT'ed
-- as NULL-violating values; PART 6's trigger is the real, complete fix.
-- has_explicit_permission() is defined in PART 2 ABOVE both of these
-- policies in file order, but since it is CREATE OR REPLACE'd before
-- either CREATE POLICY statement runs (all execute in the same migration
-- transaction, in file order), there is no forward-reference problem.

-- ============================================================
-- PART 6: protect_terminal_dues_workflow_columns() -- RELEASE-BLOCKING FIX
-- (found during PR #36 audit, before this migration was ever applied to
-- any environment)
-- ============================================================
--
-- THE GAP: PART 4's UPDATE policy requires the row to already be, and
-- remain, 'pending' -- but says nothing about the OTHER 8 columns this
-- migration adds. PART 4b's INSERT policy (even with the status='pending'
-- clause just added above) says nothing about them either. Empirically
-- reproduced, against this exact migration chain, in a disposable local
-- Postgres instance before this fix was written:
--   * An HR caller (terminal_dues.create only) could INSERT a brand-new
--     row with status='approved' or status='paid' directly, skipping
--     Admin approval, Accountant payment recording, and the authoritative
--     audit_logs trail entirely.
--   * An HR caller (terminal_dues.edit only) could UPDATE a still-'pending'
--     row to set approved_by/approved_at/paid_by/paid_at/payment_date/
--     payment_method/payment_reference/payment_notes directly -- forging
--     approval/payment evidence on a record nobody has actually approved
--     or paid, while status='pending' satisfies PART 4's own USING/WITH
--     CHECK trivially (neither clause says anything about these 8 other
--     columns).
-- Both are a direct, complete bypass of the separation-of-duties boundary
-- this whole migration exists to build, contradicting its own explicit
-- premise ("The lifecycle is strictly pending -> approved -> paid...
-- enforced SERVER-SIDE").
--
-- WHY NOT COLUMN-LEVEL INSERT/UPDATE PRIVILEGES (REVOKE/GRANT): the
-- obvious-looking alternative -- REVOKE INSERT/UPDATE on these columns
-- from `authenticated`, GRANT only on the safe ones -- was seriously
-- considered and empirically prototyped first, but rejected: column-level
-- privilege is granted per ROLE, and every application session
-- (ordinary HR/Admin/Accountant AND a true super admin) connects to
-- PostgREST as the SAME `authenticated` role -- "is this caller a super
-- admin" is a `profiles.is_super_admin` DATA flag, not a distinct
-- Postgres role. A blanket column-level REVOKE would therefore ALSO block
-- the true super admin's own direct UPDATE of status/approved_by/etc. --
-- explicitly contradicting this migration's own documented, unchanged
-- "TRUE PLATFORM SUPER ADMIN may retain emergency/bypass capability"
-- architecture (PART 4's own comment: "a true super admin can still
-- directly UPDATE any row including its status, exactly as before this
-- migration"). Column-level privilege cannot express that conditional
-- bypass; only a caller-identity-aware mechanism (RLS or a trigger) can.
--
-- WHY NOT PURE RLS (WITH CHECK alone): WITH CHECK can express "this
-- column must equal a fixed value" (e.g. `approved_by IS NULL`), which
-- DOES work for the 8 columns this migration adds (they are NEVER
-- legitimately non-NULL while status='pending' -- the RPCs in PART 5 only
-- ever populate them together with a non-'pending' status, or clear them
-- back to NULL on return). But it CANNOT express "this column must be
-- UNCHANGED from its value before this UPDATE" -- RLS has no OLD-row
-- reference inside a single WITH CHECK expression. This distinction
-- matters once Step 26 (20260907000000) adds returned_by/
-- returned_by_name/returned_at/return_reason: those CAN legitimately be
-- non-NULL on a real, currently-Pending row (one returned for
-- correction), and HR must remain able to edit such a row's financial
-- fields without being forced to also clear (or being blocked by) that
-- return metadata -- an `IS NULL` requirement on those 4 columns would
-- incorrectly reject that legitimate edit.
--
-- THE FIX: a BEFORE INSERT OR UPDATE trigger -- the same class of
-- mechanism this schema already uses for the analogous problem on
-- `profiles` (prevent_profile_privilege_escalation(), 20260727000001/
-- 20260817000001/20260822000000) -- which has real OLD/NEW row access and
-- can branch on caller identity. It:
--   1. Lets a true super admin (is_super_admin()) through completely
--      unchanged, on every column, preserving the documented bypass
--      exactly.
--   2. Lets a write through completely unchanged whenever it did NOT come
--      directly from the `authenticated` role -- i.e. whenever it is
--      running from INSIDE one of the 3 SECURITY DEFINER RPCs in PART 5
--      (approve_terminal_due/record_terminal_due_payment/
--      return_terminal_due_for_correction). SECURITY DEFINER re-points
--      `current_user` to the FUNCTION'S OWNER for the duration of that
--      function's body (a distinct, separate mechanism from the RLS/
--      privilege-check role and from auth.uid()/the caller's real
--      identity) -- so an UPDATE issued by those RPCs' own bodies always
--      executes with current_user equal to their owner, NEVER
--      `authenticated`, regardless of which real caller invoked the RPC.
--      Empirically proven (not assumed) against this exact mechanism in a
--      disposable local Postgres instance before this migration was
--      written: a direct client UPDATE showed current_user =
--      'authenticated' inside this exact trigger shape; an UPDATE issued
--      from inside a SECURITY DEFINER function owned by a different role
--      showed current_user equal to that owner, confirming the trigger
--      can reliably tell the two apart.
--   3. For every other case (an ordinary, non-super-admin, DIRECT client
--      INSERT or UPDATE) -- the only case this fix needs to actually
--      restrict -- REJECTS (RAISE EXCEPTION, not a silent value
--      substitution, so a caller gets an explicit error rather than a
--      confusingly different result than requested) any attempt to set
--      status away from 'pending' or to set/change any of the 8 workflow/
--      audit/payment columns this migration adds. `returned_by`/
--      `returned_by_name`/`returned_at`/`return_reason` do not exist on
--      this table until Step 26 (20260907000000) adds them -- see that
--      migration's PART for how it extends this SAME function (via
--      CREATE OR REPLACE) to cover those 4 columns identically once they
--      exist, closing the same class of gap for them without touching
--      this file again.
--
-- This function is deliberately declared WITHOUT SECURITY DEFINER
-- (ordinary SECURITY INVOKER, the default) -- if it were SECURITY
-- DEFINER, current_user would switch to ITS OWN owner the instant it
-- began executing, destroying the exact signal it needs to read. Trigger
-- functions do not need elevated privileges to read/write NEW/OLD (the
-- trigger mechanism itself provides that row data regardless of invoker
-- status) or to call is_super_admin() (itself independently SECURITY
-- DEFINER).
-- ============================================================

CREATE OR REPLACE FUNCTION protect_terminal_dues_workflow_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- 1/2. True super admin, or a write already running inside one of the
  -- 3 SECURITY DEFINER transition RPCs (current_user is their OWNER, not
  -- `authenticated`, by the time their own UPDATE reaches this trigger) --
  -- let it through completely unchanged, on every column.
  IF is_super_admin() OR current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  -- 3. An ordinary direct client INSERT or UPDATE -- reject any attempt
  -- to set status away from 'pending' (INSERT) or to set/change status or
  -- any workflow/audit/payment column at all (INSERT or UPDATE). This is
  -- deliberately independent of has_explicit_permission(...) -- even a
  -- caller who legitimately holds terminal_dues.approve/.pay must use the
  -- PART 5 RPCs, never a raw INSERT/UPDATE, so that the authoritative
  -- audit_logs entry and the RPCs' own state-transition/concurrency
  -- guards (FOR UPDATE row lock, exact status-transition checks) can
  -- never be bypassed.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending'
       OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.paid_by IS NOT NULL OR NEW.paid_at IS NOT NULL
       OR NEW.payment_date IS NOT NULL OR NEW.payment_method IS NOT NULL
       OR NEW.payment_reference IS NOT NULL OR NEW.payment_notes IS NOT NULL
    THEN
      RAISE EXCEPTION 'A new terminal due must be created as pending, with no approval/payment metadata -- those fields are set only by the approve/pay workflow actions';
    END IF;
  ELSE
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.paid_by IS DISTINCT FROM OLD.paid_by
       OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
       OR NEW.payment_date IS DISTINCT FROM OLD.payment_date
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
       OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
       OR NEW.payment_notes IS DISTINCT FROM OLD.payment_notes
    THEN
      RAISE EXCEPTION 'Status and approval/payment metadata may only be changed via the approve/pay workflow actions, not by directly editing a terminal due';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Deliberately NOT callable directly by anyone -- this is a trigger-only
-- function, same convention as prevent_profile_privilege_escalation().
REVOKE ALL ON FUNCTION protect_terminal_dues_workflow_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_terminal_dues_workflow_columns() FROM anon;
REVOKE ALL ON FUNCTION protect_terminal_dues_workflow_columns() FROM authenticated;

DROP TRIGGER IF EXISTS trigger_protect_terminal_dues_workflow_columns ON terminal_dues;
CREATE TRIGGER trigger_protect_terminal_dues_workflow_columns
BEFORE INSERT OR UPDATE ON terminal_dues
FOR EACH ROW EXECUTE FUNCTION protect_terminal_dues_workflow_columns();

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
--     explicit terminal_dues.create/.edit seed rows), but can no longer
--     change its status by any path.
--   * A caller who is is_business_admin() (role='admin' or legacy
--     role_level=1) does NOT automatically gain terminal_dues.approve/pay
--     -- unlike every other permission in this app. Only a profile whose
--     literal `role` is 'admin' (approve) or 'accountant' (pay) gets these,
--     per the new explicit seed rows -- see this migration's header.
--   * REAL TIGHTENING #1 (found and fixed before this migration was ever
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
--   * REAL TIGHTENING #2 (same class of gap, found and fixed in the same
--     pre-staging review, before this migration was ever applied anywhere):
--     the INSERT (create) policy had the IDENTICAL
--     current_user_role_level() <= 2 OR has_permission('terminal_dues.create')
--     shape and the IDENTICAL empirically-reproduced hole -- a FUNCTIONAL
--     Admin, a legacy Admin (role_level=1), and a legacy Manager
--     (role_level=2) could all directly INSERT a brand-new terminal_dues
--     row. It now requires has_explicit_permission('terminal_dues.create')
--     only -- only hr_manager (its existing explicit seed row) retains
--     create access. Accountant and Operations Manager were already
--     correctly blocked (neither role_level<=2 nor any terminal_dues.create
--     grant) and remain so.
--   * True super admin (is_super_admin()) behavior is unchanged everywhere
--     in this migration.
--   * REAL TIGHTENING #3 (release-blocking, found during PR #36 audit,
--     before this migration was ever applied anywhere): the ORIGINAL
--     shape of PART 4/4b's UPDATE/INSERT policies -- even with the
--     has_explicit_permission()-only fix from tightenings #1/#2 already
--     applied -- still let any caller holding terminal_dues.create/.edit
--     directly INSERT a row with status='approved'/'paid' or forge
--     approved_by/approved_at/paid_by/paid_at/payment_date/
--     payment_method/payment_reference/payment_notes on an UPDATE while
--     leaving status='pending' (which trivially satisfies both policies'
--     own status check). Empirically reproduced against this exact
--     migration chain in a disposable local Postgres instance. PART 6
--     (protect_terminal_dues_workflow_columns(), a BEFORE INSERT OR
--     UPDATE trigger) now closes this completely -- see PART 6's own
--     header for the full analysis, including why column-level INSERT/
--     UPDATE privileges were considered and rejected (they cannot express
--     the required is_super_admin() conditional bypass, since every
--     session -- super admin or not -- connects as the SAME
--     `authenticated` Postgres role).
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
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'protect_terminal_dues_workflow_columns';
--   -- expected: 1 row, prosecdef = false (deliberately SECURITY INVOKER --
--   -- see PART 6's own comment for why)
--   SELECT tgname, tgenabled FROM pg_trigger
--     WHERE tgrelid = 'terminal_dues'::regclass AND tgname = 'trigger_protect_terminal_dues_workflow_columns';
--   -- expected: 1 row, tgenabled = 'O' (enabled)
--   SELECT role, permission FROM role_permissions WHERE permission LIKE 'terminal_dues.%' ORDER BY role, permission;
--   -- expected: accountant/terminal_dues.pay, accountant/terminal_dues.view,
--   -- admin/terminal_dues.approve, admin/terminal_dues.view,
--   -- hr_manager/terminal_dues.create, hr_manager/terminal_dues.edit,
--   -- hr_manager/terminal_dues.view (NO hr_manager/terminal_dues.process row)
--   SELECT policyname, cmd, qual, with_check FROM pg_policies
--     WHERE tablename = 'terminal_dues' AND cmd IN ('UPDATE','INSERT');
--   -- expected: 2 rows. The UPDATE row's qual/with_check and the INSERT
--   -- row's with_check must each contain "has_explicit_permission" and
--   -- must NOT contain "current_user_role_level" or "has_permission(" --
--   -- if either does, the corresponding separation-of-duties fix above
--   -- did not apply. The INSERT row's with_check must also contain
--   -- "status = 'pending'".
--   -- Functional check, as an HR Manager session (terminal_dues.create/
--   -- .edit, no .approve/.pay): a direct INSERT with status='approved' or
--   -- status='paid' must RAISE; a direct UPDATE of an existing pending
--   -- row setting approved_by/paid_by/payment_reference must RAISE; a
--   -- normal create (status omitted or 'pending', no other workflow
--   -- fields set) and a normal edit of financial fields only must both
--   -- SUCCEED. As a super admin session: a direct UPDATE setting status/
--   -- approved_by directly must still SUCCEED (documented bypass,
--   -- unchanged).
--
-- ROLLBACK SQL:
--   DROP TRIGGER IF EXISTS trigger_protect_terminal_dues_workflow_columns ON terminal_dues;
--   DROP FUNCTION IF EXISTS protect_terminal_dues_workflow_columns();
--   DROP FUNCTION IF EXISTS return_terminal_due_for_correction(UUID, TEXT);
--   DROP FUNCTION IF EXISTS record_terminal_due_payment(UUID, DATE, TEXT, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS approve_terminal_due(UUID);
--   DROP FUNCTION IF EXISTS has_explicit_permission(TEXT);
--   DELETE FROM role_permissions WHERE (role, permission) IN
--     (('admin','terminal_dues.view'), ('admin','terminal_dues.approve'), ('accountant','terminal_dues.pay'));
--   INSERT INTO role_permissions (role, permission) VALUES ('hr_manager', 'terminal_dues.process') ON CONFLICT DO NOTHING;
--   -- Then re-apply 20260817000002's ORIGINAL "Terminal dues: update within
--   -- tenant+region, action or legacy permitted" UPDATE policy AND its
--   -- ORIGINAL "Terminal dues: create within tenant+region, action or
--   -- legacy permitted" INSERT policy verbatim (DROP POLICY IF EXISTS the
--   -- two new policy names on terminal_dues first, then the two original
--   -- CREATE POLICY statements).
--   -- New terminal_dues columns are left in place (dropping them would
--   -- destroy any approval/payment audit data already recorded) --
--   -- ALTER TABLE terminal_dues DROP COLUMN IF EXISTS <col> for each of the
--   -- 8 new columns only if a full rollback of the schema is truly needed.
-- ============================================================
