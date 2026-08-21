-- ============================================================
-- MIGRATION: Functional role / permission system -- Phase B, part 2
-- Indirect-region tables: payroll, attendance, payment_status,
-- employee_deductions, terminal_dues, salary_advances + its 3 related
-- tables. None of these have their own region_id column -- region is
-- derived from employee_id -> employees.region_id, the authoritative
-- source (see 20260817000000/20260817000001's own header notes on why
-- no region_id is added to any of these tables).
-- Date: 2026-08-17
-- ============================================================
--
-- Same safe-transition shape as 20260817000001, region check replaced
-- with an EXISTS join to the owning employee:
--   EXISTS (SELECT 1 FROM employees e WHERE e.id = <table>.employee_id AND region_allowed(e.region_id))
-- region_allowed() already returns true unconditionally for
-- is_business_admin()/is_super_admin(), so this join only actually
-- constrains a region-scoped functional or legacy user. Indexed on
-- employees.id (primary key) -- a standard, well-performing pattern at
-- this application's realistic per-tenant employee counts.
-- ============================================================

-- ============================================================
-- PART 1: payroll
-- ============================================================
-- Legacy compatibility preserved exactly as live today: SELECT tenant-
-- only (no role_level gate, unchanged), INSERT/UPDATE role_level = 1
-- (20260727000001), DELETE super-admin-only (20260803000000).
-- ============================================================

DROP POLICY IF EXISTS "Users can view payroll in their tenant" ON payroll;
CREATE POLICY "Payroll: view within tenant+region, action or legacy permitted" ON payroll
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = payroll.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() IS NOT NULL OR has_permission('payroll.view'))
    )
  )
);

DROP POLICY IF EXISTS "Admins can insert payroll in their tenant" ON payroll;
CREATE POLICY "Payroll: insert within tenant+region, action or legacy permitted" ON payroll
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = payroll.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() = 1 OR has_permission('payroll.process'))
    )
  )
);

DROP POLICY IF EXISTS "Admins can update payroll in their tenant" ON payroll;
CREATE POLICY "Payroll: update within tenant+region, action or legacy permitted" ON payroll
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = payroll.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() = 1 OR has_permission('payroll.process') OR has_permission('payroll.approve'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = payroll.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() = 1 OR has_permission('payroll.process') OR has_permission('payroll.approve'))
    )
  )
);
-- "Super admins can delete payroll" unchanged.

-- ============================================================
-- PART 2: attendance
-- ============================================================
-- FINAL BUSINESS RULE, exactly per instruction: Admin full, Operations
-- Manager READ-ONLY, HR Manager/Accountant DENIED. Legacy Supervisor
-- TEMPORARILY retains write access (a future department will own
-- attendance.create/edit -- not invented here). Legacy write access is
-- scoped to role_level <= 3 (Admin/Manager/Supervisor), NOT the
-- unrestricted "any role_level" that today's actual (ungated) policy
-- technically allows -- role_level <= 3 is what Sidebar.tsx's OWN nav
-- map already treats as "legitimate" (Staff/role_level 4 has never had
-- a frontend path to the Attendance page at all, per roleMenuItems[4]),
-- so this tightens an unenforced-but-never-actually-reachable gap rather
-- than removing real, used access. New operations_manager accounts get
-- role_level = NULL by construction (see the create-user Edge Function),
-- so they can NEVER match `current_user_role_level() <= 3` -- they rely
-- exclusively on has_permission('attendance.view'), which the seeded
-- matrix grants read-only, matching the business rule exactly.
-- SELECT itself stays legacy-open to ANY authenticated legacy account
-- (matching today's real, ungated SELECT behavior) plus the new
-- attendance.view permission for operations_manager.
-- ============================================================

DROP POLICY IF EXISTS "Users can view attendance in their tenant" ON attendance;
CREATE POLICY "Attendance: view within tenant+region, action or legacy permitted" ON attendance
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = attendance.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() IS NOT NULL OR has_permission('attendance.view'))
    )
  )
);

DROP POLICY IF EXISTS "Users can insert attendance in their tenant" ON attendance;
CREATE POLICY "Attendance: create within tenant+region, legacy Supervisor+ or new permission" ON attendance
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = attendance.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 3 OR has_permission('attendance.create'))
    )
  )
);

DROP POLICY IF EXISTS "Users can update attendance in their tenant" ON attendance;
CREATE POLICY "Attendance: update within tenant+region, legacy Supervisor+ or new permission" ON attendance
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = attendance.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 3 OR has_permission('attendance.edit'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = attendance.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 3 OR has_permission('attendance.edit'))
    )
  )
);
-- DELETE ("Users can delete attendance in their tenant", tenant-only,
-- never role-gated) is left AS-IS deliberately -- out of scope for this
-- pass (no business rule above discusses attendance deletion, and
-- narrowing it isn't required to satisfy any instruction in this round).

-- ============================================================
-- PART 3: payment_status (Payments)
-- ============================================================
-- Legacy: SELECT/INSERT/UPDATE role_level <= 2 (20260803000000), DELETE
-- super-admin-only.
-- ============================================================

DROP POLICY IF EXISTS "Managers can view payment status in their tenant" ON payment_status;
CREATE POLICY "Payments: view within tenant+region, action or legacy permitted" ON payment_status
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = payment_status.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('payments.view'))
    )
  )
);

DROP POLICY IF EXISTS "Managers can insert payment status in their tenant" ON payment_status;
CREATE POLICY "Payments: create within tenant+region, action or legacy permitted" ON payment_status
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = payment_status.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('payments.manage'))
    )
  )
);

DROP POLICY IF EXISTS "Managers can update payment status in their tenant" ON payment_status;
CREATE POLICY "Payments: update within tenant+region, action or legacy permitted" ON payment_status
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = payment_status.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('payments.manage'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = payment_status.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('payments.manage'))
    )
  )
);
-- "Super admins can delete payment status" unchanged.

-- ============================================================
-- PART 4: employee_deductions (Attendance-adjacent deductions)
-- ============================================================
-- Legacy: SELECT tenant-only (no gate -- Payslips.tsx, role_level
-- 4-reachable, reads this directly), INSERT/UPDATE role_level <= 3
-- (20260803000000), DELETE super-admin-only. Write gated the same way as
-- attendance itself (Admin-only under the new model, legacy Supervisor+
-- temporarily preserved) since these deductions are edited from the
-- Attendance page.
-- ============================================================

DROP POLICY IF EXISTS "Users can view deductions in their tenant" ON employee_deductions;
CREATE POLICY "Deductions: view within tenant+region, legacy open or new permission" ON employee_deductions
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_deductions.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() IS NOT NULL OR has_permission('attendance.view') OR has_permission('payslips.view'))
    )
  )
);

DROP POLICY IF EXISTS "Attendance roles can insert deductions in their tenant" ON employee_deductions;
CREATE POLICY "Deductions: create within tenant+region, legacy Supervisor+ or new permission" ON employee_deductions
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_deductions.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 3 OR has_permission('attendance.create'))
    )
  )
);

DROP POLICY IF EXISTS "Attendance roles can update deductions in their tenant" ON employee_deductions;
CREATE POLICY "Deductions: update within tenant+region, legacy Supervisor+ or new permission" ON employee_deductions
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_deductions.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 3 OR has_permission('attendance.edit'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_deductions.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 3 OR has_permission('attendance.edit'))
    )
  )
);
-- "Super admins can delete deductions" unchanged.

-- ============================================================
-- PART 5: terminal_dues
-- ============================================================
-- Legacy: SELECT/INSERT/UPDATE role_level <= 2 (20260803000000), DELETE
-- super-admin-only. Accountant is explicitly READ-ONLY (no create/edit/
-- process permission granted in the seed matrix) -- HR Manager gets full.
-- ============================================================

DROP POLICY IF EXISTS "Managers can view terminal dues in their tenant" ON terminal_dues;
CREATE POLICY "Terminal dues: view within tenant+region, action or legacy permitted" ON terminal_dues
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = terminal_dues.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('terminal_dues.view'))
    )
  )
);

DROP POLICY IF EXISTS "Managers can insert terminal dues in their tenant" ON terminal_dues;
CREATE POLICY "Terminal dues: create within tenant+region, action or legacy permitted" ON terminal_dues
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = terminal_dues.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('terminal_dues.create'))
    )
  )
);

DROP POLICY IF EXISTS "Managers can update terminal dues in their tenant" ON terminal_dues;
CREATE POLICY "Terminal dues: update within tenant+region, action or legacy permitted" ON terminal_dues
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = terminal_dues.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('terminal_dues.edit') OR has_permission('terminal_dues.process'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = terminal_dues.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('terminal_dues.edit') OR has_permission('terminal_dues.process'))
    )
  )
);
-- "Super admins can delete terminal dues" unchanged.

-- ============================================================
-- PART 6: salary_advances + its 3 related tables
-- ============================================================
-- Legacy: SELECT/UPDATE role_level <= 2 (20260813000000); deliberately NO
-- INSERT policy (creation is RPC-only, see create_salary_advance() in
-- 20260817000002_functional_roles_rpc_authorization.sql, part of this
-- same rollout); DELETE super-admin-only. HR Manager AND Accountant both
-- get full salary-advance access under the new model; Operations Manager
-- is denied entirely.
-- ============================================================

DROP POLICY IF EXISTS "Managers can view salary advances in their tenant" ON salary_advances;
CREATE POLICY "Salary advances: view within tenant+region, action or legacy permitted" ON salary_advances
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = salary_advances.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('salary_advances.view'))
    )
  )
);

DROP POLICY IF EXISTS "Managers can update salary advances in their tenant" ON salary_advances;
CREATE POLICY "Salary advances: update within tenant+region, action or legacy permitted" ON salary_advances
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = salary_advances.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('salary_advances.view'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = salary_advances.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('salary_advances.view'))
    )
  )
);
-- "Super admins can delete salary advances" unchanged. Direct UPDATE via
-- this policy is still further restricted to pending->rejected/cancelled
-- only by the existing guard_salary_advance_status_transition trigger
-- (20260813000000, unchanged) -- this RLS policy governs WHO may attempt
-- an update at all; the trigger governs WHICH transitions are valid.

DROP POLICY IF EXISTS "Managers can view salary advance deductions in their tenant" ON salary_advance_deductions;
CREATE POLICY "Salary advance deductions: view within tenant+region, action or legacy permitted" ON salary_advance_deductions
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = salary_advance_deductions.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('salary_advances.view'))
    )
  )
);

DROP POLICY IF EXISTS "Managers can view salary advance repayment plans in their tenant" ON salary_advance_repayment_plans;
CREATE POLICY "Salary advance repayment plans: view within tenant+region, action or legacy permitted" ON salary_advance_repayment_plans
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = salary_advance_repayment_plans.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('salary_advances.view'))
    )
  )
);

DROP POLICY IF EXISTS "Managers can view salary advance plan changes in their tenant" ON salary_advance_repayment_plan_changes;
CREATE POLICY "Salary advance plan changes: view within tenant+region, action or legacy permitted" ON salary_advance_repayment_plan_changes
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = salary_advance_repayment_plan_changes.employee_id AND region_allowed(e.region_id))
      AND (current_user_role_level() <= 2 OR has_permission('salary_advances.view'))
    )
  )
);

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- DROP POLICY IF EXISTS + CREATE
-- POLICY throughout.
--
-- DEPENDENCIES: 20260817000000 (region_allowed()/has_permission()/
-- is_current_user_active()), 20260813000000 (the 4 salary-advance tables).
--
-- BEHAVIOR CHANGE FOR EXISTING (LEGACY) CALLERS: region enforcement is
-- NEW on all 9 tables in this file -- previously tenant-wide for a
-- legacy account with role_level satisfying the existing threshold, now
-- additionally scoped to their own assigned region (or unaffected if
-- their own region_id is NULL, i.e. "all regions," matching how
-- is_super_admin already worked). Attendance/employee_deductions WRITE
-- access for a legacy account is now explicitly bounded to role_level
-- <= 3 rather than being ungated -- as documented above, Staff/role_level
-- 4 never had a frontend path to reach this regardless, so this closes an
-- unenforced gap rather than removing used access; confirm this against
-- real STAGING accounts before relying on that claim in production.
--
-- VERIFICATION SQL:
--   SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename IN
--     ('payroll','attendance','payment_status','employee_deductions',
--      'terminal_dues','salary_advances','salary_advance_deductions',
--      'salary_advance_repayment_plans','salary_advance_repayment_plan_changes')
--   ORDER BY tablename, cmd;
--
-- ROLLBACK: re-run each superseded migration's own CREATE POLICY blocks
-- verbatim (20260727000000 for the base tenant-only shape,
-- 20260727000001/20260803000000/20260813000000 for the role_level overlays).
-- ============================================================
