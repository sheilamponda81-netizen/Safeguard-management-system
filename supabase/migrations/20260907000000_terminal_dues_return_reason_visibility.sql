-- ============================================================
-- MIGRATION: Terminal Dues return-for-correction reason visibility
-- Date: 2026-09-07
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- -----------------------------------------------------------
-- Real staging Admin acceptance testing confirmed the Return for
-- Correction workflow works end to end (RPC succeeds, record moves back
-- to Pending), but the reason Admin typed is then invisible anywhere in
-- the normal Terminal Dues UI. Root cause, confirmed by reading
-- return_terminal_due_for_correction() (20260905000000, lines 523-539):
-- it writes return_reason/returned_by ONLY into audit_logs.new_data (a
-- JSONB blob), never onto the terminal_dues row itself, and
-- TerminalDues.tsx never queries audit_logs at all.
--
-- Depending on audit_logs from the page is not viable, not just
-- unimplemented: audit_logs's own SELECT policy ("Audit logs: view is
-- Admin-only", 20260817000001 PART 4) is `is_business_admin() OR
-- is_super_admin()` ONLY -- HR Manager and Accountant have NO read access
-- to audit_logs at all, by deliberate design ("audit history is ... scoped
-- by 'are you an Admin'"). HR is exactly the audience that needs to see
-- the return reason (they're the one who has to act on it), so this is a
-- hard architectural blocker, not a permission we could loosen without a
-- much bigger, unrelated privilege change. Row-level metadata on
-- terminal_dues itself is therefore the only viable design -- HR already
-- has ordinary SELECT access to that table.
--
-- A SECOND, less obvious problem this migration also has to solve: a bare
-- `returned_by UUID` would still be unresolvable to a human name for HR.
-- The current profiles SELECT policy ("Users can view own profile or, as
-- Admin, their tenant's", 20260817000001) only lets a non-admin read
-- THEIR OWN profile row (`id = auth.uid()`) -- HR cannot read the
-- returning Admin's profile row to look up their name. (This same gap
-- already latently exists for approved_by/paid_by; nothing in the UI has
-- ever tried to render those as a name, only as timestamps, so it was
-- never surfaced before now.) Fixed the same way this table already
-- denormalizes employee_name/employee_number instead of joining
-- `employees` live: return_terminal_due_for_correction() (a SECURITY
-- DEFINER function, which -- like every other function in this table's
-- migrations -- already bypasses RLS on every table it touches) resolves
-- the calling Admin's own name ONCE at return time and stores a
-- `returned_by_name` snapshot alongside the `returned_by` UUID.
--
-- BUSINESS RULE
-- -----------------------------------------------------------
-- While a terminal_dues row is Pending BECAUSE it was returned for
-- correction, returned_by/returned_by_name/returned_at/return_reason are
-- populated and the UI shows a prominent "Returned for Correction" panel
-- in View Details. An ORDINARY newly-created Pending record (never
-- returned) has all four NULL and shows no such panel. On successful
-- re-approval (approve_terminal_due(), Pending -> Approved again), all
-- four are cleared back to NULL -- the record is no longer CURRENTLY
-- awaiting correction, so it must stop claiming to be. The historical
-- return event remains permanently in audit_logs regardless -- this
-- migration only changes what CURRENT operational state is shown, never
-- historical record-keeping.
-- ============================================================

ALTER TABLE terminal_dues
  ADD COLUMN IF NOT EXISTS returned_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS returned_by_name TEXT,
  ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS return_reason TEXT;

-- ============================================================
-- return_terminal_due_for_correction(): now also stamps the row itself
-- ============================================================
-- Everything above the final UPDATE is UNCHANGED from 20260905000000
-- (same authorization checks, same state-transition guard, same
-- row-level lock via FOR UPDATE) -- only the UPDATE's SET list and the
-- new name lookup are new. The audit_logs INSERT is also unchanged: it
-- remains the permanent historical record regardless of what the row's
-- CURRENT state later becomes.

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

  -- Resolves the CALLER's own name -- this function is SECURITY DEFINER
  -- and already bypasses RLS on every table it touches (same as the
  -- `employees`/`terminal_dues` reads above), so this is safe even though
  -- the caller (an ordinary Admin) could not read an arbitrary profiles
  -- row themselves. A snapshot, not a live join, is deliberate: the same
  -- reasoning as this table's existing employee_name/employee_number
  -- denormalization -- HR's own SELECT on terminal_dues cannot otherwise
  -- resolve a bare UUID to a name under the current profiles RLS (which
  -- only allows a non-admin to read their own profile row).
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

REVOKE ALL ON FUNCTION return_terminal_due_for_correction(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION return_terminal_due_for_correction(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION return_terminal_due_for_correction(UUID, TEXT) TO authenticated;

-- ============================================================
-- approve_terminal_due(): clears the "currently returned" instruction
-- fields on successful re-approval
-- ============================================================
-- Everything above the final UPDATE is UNCHANGED from 20260905000000.
-- Only the UPDATE's SET list gains the 4 clears below -- a record that is
-- newly Approved is, by definition, no longer awaiting correction, so it
-- must stop showing a "Returned for Correction" panel. The historical
-- return event remains in audit_logs regardless (this never touches
-- audit_logs).

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
    returned_by = NULL,
    returned_by_name = NULL,
    returned_at = NULL,
    return_reason = NULL,
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

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent. ADD COLUMN IF NOT EXISTS x4; CREATE OR
-- REPLACE FUNCTION x2 (same signatures, no DROP).
--
-- EXISTING ROWS: all 4 new columns are NULL on every existing row --
-- reads correctly as "never returned for correction," including every
-- currently-Approved or currently-Paid row and any currently-Pending row
-- that was never returned. No backfill needed or attempted.
--
-- BEHAVIOR CHANGE: return_terminal_due_for_correction() now also writes 4
-- columns on the SAME row it already updates (no new row, no new lock);
-- approve_terminal_due() now additionally NULLs those same 4 columns when
-- approving (a no-op UPDATE-wise for a record that was never returned,
-- since they are already NULL). Neither function's authorization checks,
-- state-transition guards, or audit_logs writes changed in any way.
--
-- RLS: no policy changes. terminal_dues's existing SELECT policy already
-- covers every column (RLS in Postgres is row-level, not column-level),
-- so HR/Accountant/Admin/super-admin all see these 4 new columns exactly
-- wherever they could already see the row -- no new grant needed for the
-- return reason to become visible.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--     WHERE table_name = 'terminal_dues'
--     AND column_name IN ('returned_by', 'returned_by_name', 'returned_at', 'return_reason')
--     ORDER BY column_name;
--   -- expected: 4 rows, all is_nullable = 'YES'
--
--   SELECT pg_get_functiondef('return_terminal_due_for_correction(uuid,text)'::regprocedure) LIKE '%returned_by_name%';
--   SELECT pg_get_functiondef('approve_terminal_due(uuid)'::regprocedure) LIKE '%returned_by_name = NULL%';
--   -- expected: both true
--
-- ROLLBACK SQL:
--   -- Re-apply 20260905000000's original CREATE OR REPLACE FUNCTION
--   -- bodies for return_terminal_due_for_correction() and
--   -- approve_terminal_due() (drops the new SET clauses), then:
--   ALTER TABLE terminal_dues
--     DROP COLUMN IF EXISTS returned_by,
--     DROP COLUMN IF EXISTS returned_by_name,
--     DROP COLUMN IF EXISTS returned_at,
--     DROP COLUMN IF EXISTS return_reason;
-- ============================================================
