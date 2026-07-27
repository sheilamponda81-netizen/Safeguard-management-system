-- ============================================================
-- MIGRATION: Security hardening -- close two real RLS gaps
-- Date: 2026-07-27
-- ============================================================
--
-- Both issues below were found by an authorization audit of the schema in
-- 20260727000000_reconstructed_base_schema.sql: every RLS policy in that
-- file gates only on tenant_id / is_super_admin() -- profiles.role_level
-- (1=Admin, 2=Manager, 3=Supervisor, 4=Staff), which the app itself uses
-- client-side (see src/pages/Payroll.tsx's canProcessPayroll/
-- canApprovePayroll and src/components/UserManagement.tsx's role levels),
-- was never enforced server-side anywhere. That makes every client-side
-- permission check pure UI theater: any authenticated user can bypass it
-- entirely by calling supabase-js directly (e.g. from the browser console).
--
-- ISSUE 1 -- Self privilege escalation via `profiles`
-- -----------------------------------------------------
-- The existing "Users can update their own profile" policy
-- (USING id = auth.uid() OR is_super_admin(), WITH CHECK tenant_id =
-- get_current_tenant_id() OR is_super_admin()) does not restrict which
-- COLUMNS a user may change on their own row. Concretely, any logged-in
-- user can currently run, from the browser console:
--   await supabase.from('profiles').update({ is_super_admin: true }).eq('id', myId)
-- and it succeeds -- both USING and WITH CHECK pass trivially, since
-- neither clause looks at is_super_admin/role_level/tenant_id changing.
-- That single write then bypasses every other is_super_admin() check in
-- the entire app.
--
-- RLS policies can't easily express "this specific column may not change"
-- (WITH CHECK only sees the proposed NEW row, not a NEW-vs-OLD diff) --
-- the standard, safe way to do this in Postgres is a BEFORE UPDATE trigger
-- that resets the sensitive columns back to their OLD values whenever the
-- acting user is not already a super admin. A trigger fires before the
-- write is applied, so is_super_admin() inside it still reflects the
-- caller's PRE-update status -- a non-admin attempting to grant themselves
-- admin cannot use the very update they're making to authorize itself.
--
-- ISSUE 2 -- `payroll` INSERT/UPDATE ignore role_level entirely
-- -----------------------------------------------------
-- Payroll.tsx only ever writes to the `payroll` table from two gated
-- actions: creating/saving payroll records (`canProcessPayroll`, both
-- `.insert(newRecords)` and `.insert(payrollToSave)`) and approving/
-- rejecting a payroll run (`canApprovePayroll`, `.update(...)` on
-- approval_status). Both client-side checks resolve to the same rule:
-- `role_level === 1 OR is_super_admin`. Server-side, the existing INSERT/
-- UPDATE policies allow any tenant member to write, meaning a Staff or
-- Supervisor account could call supabase-js directly to approve their own
-- payroll or fabricate/alter payroll records. This migration adds that
-- same role_level=1-or-super-admin requirement directly to the INSERT and
-- UPDATE policies on `payroll`.
-- ============================================================

-- ------------------------------------------------------------
-- ISSUE 1 FIX: lock is_super_admin / role_level / tenant_id on profiles
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_profile_privilege_escalation()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT is_super_admin() THEN
    NEW.is_super_admin := OLD.is_super_admin;
    NEW.role_level := OLD.role_level;
    NEW.tenant_id := OLD.tenant_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_prevent_profile_privilege_escalation ON profiles;
CREATE TRIGGER trigger_prevent_profile_privilege_escalation
BEFORE UPDATE ON profiles
FOR EACH ROW
EXECUTE FUNCTION prevent_profile_privilege_escalation();

-- ------------------------------------------------------------
-- ISSUE 2 FIX: require role_level = 1 (or super admin) to write payroll
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_user_role_level()
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT role_level
    FROM profiles
    WHERE id = auth.uid()
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP POLICY IF EXISTS "Users can insert payroll in their tenant" ON payroll;
CREATE POLICY "Admins can insert payroll in their tenant" ON payroll
FOR INSERT WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() = 1 OR is_super_admin() = true)
);

DROP POLICY IF EXISTS "Users can update payroll in their tenant" ON payroll;
CREATE POLICY "Admins can update payroll in their tenant" ON payroll
FOR UPDATE USING (
  tenant_id = get_current_tenant_id() OR is_super_admin() = true
)
WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() = 1 OR is_super_admin() = true)
);

-- Note: SELECT and DELETE policies on payroll are unchanged -- Payroll.tsx
-- already gates deletion nowhere (no delete path was found for this
-- table), and view access for Manager/Supervisor (canViewPayroll,
-- role_level <= 3) is a client-side convenience, not a security boundary
-- worth restricting further here.

-- ============================================================
-- END OF SECURITY HARDENING MIGRATION
-- ============================================================
