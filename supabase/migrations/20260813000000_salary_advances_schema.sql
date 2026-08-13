-- ============================================================
-- MIGRATION: Salary Advances / Salary Loan schema
-- Date: 2026-08-13 (revised three times same-day: max-2-open-advances
-- business rule; then a single COMBINED repayment plan per employee;
-- then the APPLICATION vs APPROVAL split below)
-- ============================================================
--
-- New feature: employees can be granted a salary advance, repaid via
-- automatic monthly payroll deductions until fully repaid. Five tables.
--
-- LIFECYCLE SUMMARY (the most recent correction, stated up front):
--   APPLICATION (create_salary_advance()) -> row starts 'pending'. A
--   pending advance is a REQUEST, not active debt: it counts toward the
--   max-2-open-slots limit and is visible in the UI, but it is NEVER
--   included in payroll deductions and NEVER changes the employee's
--   combined repayment plan. Creating an advance touches ONLY the
--   `salary_advances` table -- nothing else.
--   APPROVAL (approve_salary_advance()) -> the ONLY way 'pending' becomes
--   'active'. Establishes or updates the employee's ONE combined
--   repayment plan ATOMICALLY in the same transaction as the status
--   flip -- there is never an observable intermediate state where an
--   advance is 'active' but the plan still reflects only the prior
--   advance(s). See that function's own header below for the full
--   first-vs-second-advance rules.
--   PAYROLL (process_payroll_batch()) -> deducts against 'active' advances
--   only (plus already-posted ledger rows, for reprocessing idempotency).
--   FINAL (process_payroll_batch(), automatic) -> 'active' -> 'paid' the
--   moment the derived balance hits zero. 'paid'/'rejected'/'cancelled'
--   are all terminal -- there is deliberately NO write-off/settlement
--   workflow for an active unpaid advance in this migration; see
--   "LIFECYCLE / STATUS INTEGRITY" below for why `active -> cancelled`
--   was removed from an earlier draft.
--
-- `salary_advances` -- one row per advance APPLICATION/loan. Holds the
-- terms as originally applied for (amount, repayment method, monthly
-- deduction, repayment period, start month) and its current lifecycle
-- status. These application-term columns are IMMUTABLE financial history
-- once the row is inserted (enforced by a trigger below) -- they record
-- what was originally requested, not the ongoing plan payroll actually
-- follows (that only exists once the advance is approved -- see the
-- LIFECYCLE SUMMARY above). An employee may have UP TO TWO rows in
-- 'pending'/'active' status at once (see "MAX 2 OPEN ADVANCES" below).
-- Outstanding balance per advance is always DERIVED (advance_amount minus
-- the SUM of this advance's own rows in the ledger table below), never a
-- mutable field.
--
-- `salary_advance_deductions` -- the repayment ledger. One row per
-- (advance, payroll month) actually deducted -- the audit trail ("do NOT
-- simply store one mutable balance number with no repayment history").
-- Deliberately has NO foreign key to `payroll`'s own primary key:
-- process_payroll_batch() DELETEs and re-INSERTs a month's payroll rows
-- wholesale on every reprocess, so a payroll row's own `id` is not a
-- stable reference -- `employee_id` + `payroll_month` (TEXT 'YYYY-MM',
-- matching payroll.month's own convention) is the stable reference
-- instead. `UNIQUE(salary_advance_id, payroll_month)` provides
-- reprocessing idempotency. When an employee has 2 active advances, a
-- single payroll month can produce TWO ledger rows (one per advance) --
-- see 20260813000001's oldest-advance-first allocation of the ONE
-- combined plan below.
--
-- `salary_advance_repayment_plans` -- **the ONE current, living repayment
-- plan per employee, representing APPROVED/ACTIVE debt only** (a
-- dedicated table, not fields duplicated onto each advance -- see "WHY A
-- DEDICATED PLAN TABLE" below). Business rule this corrects: when an
-- employee has two active advances, there is ONE combined monthly
-- deduction figure for their TOTAL active outstanding balance -- NOT the
-- sum of each advance's own independently-configured rate, and NEVER
-- influenced by a merely-pending application. `UNIQUE(employee_id)` -- at
-- most one current plan per employee. Established/updated ONLY by
-- `approve_salary_advance()` (never by `create_salary_advance()`, and
-- never for a pending advance) -- see the LIFECYCLE SUMMARY above.
--
-- `salary_advance_repayment_plan_changes` -- audit history for combined
-- plan changes, employee-scoped (one employee can have many change rows
-- over time, but only one live plan). Records who changed the combined
-- plan, from what, to what, and the employee's total outstanding balance
-- at that moment. Written by `approve_salary_advance()` (when approving a
-- 2nd-or-later advance onto an existing plan) and by
-- `adjust_combined_repayment_plan()` (a later, independent edit to an
-- already-active plan).
--
-- WHY A DEDICATED PLAN TABLE (vs. duplicating combined fields onto
-- `salary_advances` rows): the combined plan is a property of the
-- EMPLOYEE'S ACTIVE DEBT (their current total repayment arrangement), not
-- of any single advance and not of a merely-requested one -- duplicating
-- it onto both open advances' rows would require keeping two rows in
-- lockstep on every edit (an easy place for a bug to let them drift) and
-- would blur "what was originally applied for" (immutable, per-advance)
-- with "what's currently being deducted" (living, employee-level, active
-- only). A separate table keeps both concerns single-sourced:
-- `salary_advances` stays pure historical record of every application
-- regardless of outcome, this table is the one place payroll reads a
-- monthly figure from, and it simply does not exist until an employee's
-- first advance is approved.
-- ============================================================

CREATE TABLE IF NOT EXISTS salary_advances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  application_date DATE NOT NULL DEFAULT CURRENT_DATE,
  advance_amount NUMERIC(14,2) NOT NULL CHECK (advance_amount > 0),
  repayment_method TEXT NOT NULL CHECK (repayment_method IN ('monthly_amount', 'repayment_period')),
  -- These 4 columns capture the schedule AS ORIGINALLY APPLIED FOR --
  -- historical record only. Once 2 advances are open, ongoing payroll
  -- deductions are governed by this EMPLOYEE's single row in
  -- salary_advance_repayment_plans below, not by these columns directly.
  configured_monthly_deduction NUMERIC(14,2) NOT NULL CHECK (configured_monthly_deduction > 0),
  repayment_period_months INTEGER NOT NULL CHECK (repayment_period_months > 0),
  final_deduction_amount NUMERIC(14,2) NOT NULL CHECK (final_deduction_amount > 0),
  expected_payoff_month TEXT NOT NULL, -- 'YYYY-MM', as originally applied for -- display/history only
  deduction_start_month TEXT NOT NULL, -- 'YYYY-MM' -- matches payroll.month/employee_deductions.month's own TEXT convention
  reason TEXT,
  -- Single lifecycle status: 'pending' (submitted application -- NOT
  -- active debt; awaiting an Admin/Manager decision) -> 'active' (ONLY
  -- reachable via approve_salary_advance(), which atomically establishes/
  -- updates the employee's combined repayment plan in the same
  -- transaction -- a direct UPDATE can never perform this transition, see
  -- the guard trigger below) -> 'paid' (fully repaid -- set AUTOMATICALLY
  -- and ONLY by process_payroll_batch() when the derived outstanding
  -- balance reaches zero; the guard trigger blocks any direct UPDATE from
  -- setting 'paid' while a balance remains) OR 'rejected'/'cancelled'
  -- (terminal, reachable ONLY from 'pending' -- an ACTIVE advance can NOT
  -- be cancelled through this schema; see "LIFECYCLE / STATUS INTEGRITY"
  -- below for why that was deliberately removed).
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'paid', 'rejected', 'cancelled')),
  approved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MAX 2 OPEN ADVANCES PER EMPLOYEE
-- ============================================================
-- Business rule: an employee may have AT MOST TWO simultaneously
-- 'pending'/'active' advances. A plain UNIQUE index can express "at most
-- one" but CANNOT express "at most two" -- there is no index shape that
-- rejects only a 3rd matching row while allowing the first two. So this
-- is enforced procedurally in create_salary_advance() below: an
-- employee-scoped advisory lock (pg_advisory_xact_lock, keyed off the
-- employee's own id) serializes any concurrent creation attempts for the
-- SAME employee for the rest of that transaction, then a plain
-- `SELECT COUNT(*) ... WHERE status IN ('pending','active')` is safe to
-- trust (no other transaction can be concurrently inserting for this same
-- employee while the lock is held) and rejects a 3rd. This is the same
-- "SECURITY DEFINER + advisory lock + count check" shape already used by
-- process_payroll_batch()'s own per-tenant+month lock.
--
-- Creation is ONLY possible through create_salary_advance() -- there is
-- deliberately NO INSERT policy on this table for `authenticated` (see
-- the RLS section below), so a direct supabase-js `.insert()` call
-- (which cannot take the advisory lock or run the count check) is
-- rejected by RLS outright, for every role including Admin/super-admin.
CREATE INDEX IF NOT EXISTS idx_salary_advances_tenant_id ON salary_advances(tenant_id);
CREATE INDEX IF NOT EXISTS idx_salary_advances_employee_id ON salary_advances(employee_id);
CREATE INDEX IF NOT EXISTS idx_salary_advances_tenant_status ON salary_advances(tenant_id, status);
-- Backs create_salary_advance()'s open-advance count check and
-- process_payroll_batch()'s per-employee "which advances are eligible
-- this month" lookup, both filtered by employee_id + status.
CREATE INDEX IF NOT EXISTS idx_salary_advances_employee_status ON salary_advances(employee_id, status);

CREATE TABLE IF NOT EXISTS salary_advance_deductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  salary_advance_id UUID NOT NULL REFERENCES salary_advances(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  payroll_month TEXT NOT NULL,
  deduction_amount NUMERIC(14,2) NOT NULL CHECK (deduction_amount > 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (salary_advance_id, payroll_month)
);

CREATE INDEX IF NOT EXISTS idx_salary_advance_deductions_tenant_id ON salary_advance_deductions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_salary_advance_deductions_advance_id ON salary_advance_deductions(salary_advance_id);
CREATE INDEX IF NOT EXISTS idx_salary_advance_deductions_employee_month ON salary_advance_deductions(employee_id, payroll_month);

-- The ONE current combined repayment plan per employee, representing
-- APPROVED/ACTIVE debt only -- see the header comment's "WHY A DEDICATED
-- PLAN TABLE" section. `UNIQUE(employee_id)`: at most one live plan per
-- employee, upserted by approve_salary_advance() (never by
-- create_salary_advance() -- a pending application never touches this
-- table) and adjust_combined_repayment_plan().
CREATE TABLE IF NOT EXISTS salary_advance_repayment_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  repayment_method TEXT NOT NULL CHECK (repayment_method IN ('monthly_amount', 'repayment_period')),
  combined_monthly_deduction NUMERIC(14,2) NOT NULL CHECK (combined_monthly_deduction > 0),
  repayment_period_months INTEGER NOT NULL CHECK (repayment_period_months > 0),
  deduction_start_month TEXT NOT NULL, -- 'YYYY-MM'
  expected_payoff_month TEXT NOT NULL, -- 'YYYY-MM'
  changed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_salary_advance_repayment_plans_tenant_id ON salary_advance_repayment_plans(tenant_id);

-- Edit/Adjust Repayment Plan audit history -- one row per combined-plan
-- change, employee-scoped (not advance-scoped, since the plan itself is
-- employee-scoped). See adjust_combined_repayment_plan() below, the only writer.
CREATE TABLE IF NOT EXISTS salary_advance_repayment_plan_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  changed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  previous_repayment_method TEXT NOT NULL,
  previous_monthly_deduction NUMERIC(14,2) NOT NULL,
  previous_repayment_period_months INTEGER NOT NULL,
  previous_deduction_start_month TEXT NOT NULL,
  new_repayment_method TEXT NOT NULL,
  new_monthly_deduction NUMERIC(14,2) NOT NULL,
  new_repayment_period_months INTEGER NOT NULL,
  new_deduction_start_month TEXT NOT NULL,
  -- The employee's TOTAL derived outstanding balance (across every open
  -- advance) AT THE MOMENT of this change -- the basis the new combined
  -- schedule was calculated from, kept here so a later reviewer can audit
  -- the arithmetic without recomputing it from the ledger as of a past
  -- point in time.
  total_outstanding_at_change NUMERIC(14,2) NOT NULL,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_salary_advance_repayment_plan_changes_employee_id ON salary_advance_repayment_plan_changes(employee_id);
CREATE INDEX IF NOT EXISTS idx_salary_advance_repayment_plan_changes_tenant_id ON salary_advance_repayment_plan_changes(tenant_id);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE salary_advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_advance_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_advance_repayment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_advance_repayment_plan_changes ENABLE ROW LEVEL SECURITY;

-- salary_advances: management access mirrors terminal_dues' CURRENT
-- (post-hardening) final state -- SELECT/UPDATE require role_level <= 2
-- (Admin or Manager) or super-admin; DELETE further restricted to
-- super-admin only, least-privilege, matching the same reasoning applied
-- to payment_status/terminal_dues/employee_deductions in
-- 20260803000000_role_level_rls_hardening.sql.
--
-- Deliberately NO INSERT policy: creating a new advance requires the
-- employee-scoped advisory lock + open-advance count check that only
-- create_salary_advance() (SECURITY DEFINER, bypasses RLS for its own
-- insert) can safely perform -- see "MAX 2 OPEN ADVANCES" above. A direct
-- supabase-js `.insert()` from any role, including super-admin, is
-- rejected by RLS with no matching policy. create_salary_advance() ALSO
-- re-enforces role_level <= 2 OR is_super_admin() INSIDE the function
-- body itself (not just via the absent RLS policy) -- since it is
-- SECURITY DEFINER and bypasses RLS entirely for its own writes, the
-- function's own check is the ONLY thing standing between an
-- authenticated Supervisor/Staff caller and a successful insert; there is
-- no RLS policy to silently fall back on if that in-function check were
-- ever removed. See the function definition below for the exact check.
DROP POLICY IF EXISTS "Managers can view salary advances in their tenant" ON salary_advances;
CREATE POLICY "Managers can view salary advances in their tenant" ON salary_advances
FOR SELECT USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

DROP POLICY IF EXISTS "Managers can insert salary advances in their tenant" ON salary_advances;

-- UPDATE remains available directly (not RPC-only) for the two STATUS
-- transitions that don't establish/change the combined plan and so don't
-- need an atomic RPC: pending -> rejected and pending -> cancelled (the
-- frontend's Reject/Cancel-while-pending actions, a plain
-- `.update({status, ...})` call). Repayment-TERM columns are permanently
-- immutable (guarded by a trigger below, no bypass at all -- see
-- "LIFECYCLE / STATUS INTEGRITY"), and status transitions themselves are
-- constrained to a defined state machine by a second trigger -- which
-- ADDITIONALLY requires a transaction-local flag only
-- approve_salary_advance() sets before pending -> active can succeed, and
-- no longer permits active -> cancelled at all -- so this broad UPDATE
-- policy is safe in practice: role_level is the first gate, the two
-- triggers are the second and third.
DROP POLICY IF EXISTS "Managers can update salary advances in their tenant" ON salary_advances;
CREATE POLICY "Managers can update salary advances in their tenant" ON salary_advances
FOR UPDATE USING (
  tenant_id = get_current_tenant_id() OR is_super_admin() = true
)
WITH CHECK (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

DROP POLICY IF EXISTS "Super admins can delete salary advances" ON salary_advances;
CREATE POLICY "Super admins can delete salary advances" ON salary_advances
FOR DELETE USING (is_super_admin() = true);

-- ============================================================
-- GUARD TRIGGER 1: a salary advance's ORIGINAL APPLICATION TERMS are
-- immutable financial history from the moment it's created -- no RPC or
-- direct UPDATE may ever change them again (unlike the previous draft of
-- this migration, there is no bypass flag here at all: nothing legitimate
-- needs to modify these columns post-creation now that the COMBINED plan
-- table is what payroll actually reads from). Only status/approval
-- columns may change via direct UPDATE.
-- ============================================================
CREATE OR REPLACE FUNCTION guard_salary_advance_plan_terms()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.advance_amount IS DISTINCT FROM OLD.advance_amount OR
    NEW.repayment_method IS DISTINCT FROM OLD.repayment_method OR
    NEW.configured_monthly_deduction IS DISTINCT FROM OLD.configured_monthly_deduction OR
    NEW.repayment_period_months IS DISTINCT FROM OLD.repayment_period_months OR
    NEW.final_deduction_amount IS DISTINCT FROM OLD.final_deduction_amount OR
    NEW.deduction_start_month IS DISTINCT FROM OLD.deduction_start_month OR
    NEW.expected_payoff_month IS DISTINCT FROM OLD.expected_payoff_month OR
    NEW.application_date IS DISTINCT FROM OLD.application_date
  ) THEN
    RAISE EXCEPTION 'A salary advance''s original application terms are immutable financial history -- the combined repayment plan (salary_advance_repayment_plans) governs ongoing deductions instead';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_salary_advance_plan_terms ON salary_advances;
CREATE TRIGGER trg_guard_salary_advance_plan_terms
BEFORE UPDATE ON salary_advances
FOR EACH ROW EXECUTE FUNCTION guard_salary_advance_plan_terms();

-- ============================================================
-- GUARD TRIGGER 2 (LIFECYCLE / STATUS INTEGRITY): defines and enforces
-- the full salary-advance status state machine at the database level, not
-- just in frontend code:
--   pending -> active   ONLY via approve_salary_advance() -- gated by a
--              transaction-local flag (`app.allow_salary_advance_approval`)
--              that ONLY that RPC sets, immediately before its own
--              UPDATE, in the SAME transaction it establishes/updates the
--              combined plan in. A direct `supabase-js`
--              `.update({status:'active'})` -- from ANY role, including
--              super-admin -- has no way to set that flag and is
--              therefore always rejected. This is what makes "approval
--              always atomically carries the plan change with it"
--              actually true, not just a frontend convention.
--   pending -> rejected | cancelled -- freely, no flag needed (a merely
--              requested advance was never active debt to begin with).
--   active  -> paid (ONLY if the derived outstanding balance is exactly
--              zero -- computed HERE from salary_advance_deductions, not
--              trusted from the caller, so process_payroll_batch()'s own
--              legitimate transition passes through automatically (it
--              only ever sets 'paid' when the balance IS zero) while a
--              direct "mark this paid to skip a debt" UPDATE is rejected
--              regardless of who issues it, including a super-admin).
--   active  -> cancelled -- **REMOVED** (an earlier draft allowed this
--              freely; corrected because it let active, unpaid debt
--              simply vanish with no repayment and no business-approved
--              write-off process). An active advance now has exactly one
--              path forward: `active -> paid`, automatically, when its
--              real ledger balance reaches zero. If a genuine write-off/
--              settlement capability is ever needed, it must be built as
--              its own separate, audited business workflow -- not
--              invented here as a side effect of this correction.
--   paid | rejected | cancelled -> * : BLOCKED entirely (terminal states).
--              Reopening a rejected/cancelled advance, or reversing a paid
--              one, requires a real, explicit, separately-designed
--              workflow -- not provided here, and deliberately not
--              silently allowed by omission.
-- Fires only when NEW.status IS DISTINCT FROM OLD.status -- a plain
-- update to approved_by/approved_at/updated_at with status unchanged is
-- unaffected.
-- ============================================================
CREATE OR REPLACE FUNCTION guard_salary_advance_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_total_deducted NUMERIC;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('paid', 'rejected', 'cancelled') THEN
      RAISE EXCEPTION 'Cannot change the status of a % salary advance -- this is a terminal state', OLD.status;
    END IF;

    IF NOT (
      (OLD.status = 'pending' AND NEW.status IN ('active', 'rejected', 'cancelled')) OR
      (OLD.status = 'active' AND NEW.status = 'paid')
    ) THEN
      RAISE EXCEPTION 'Invalid salary advance status transition: % -> %', OLD.status, NEW.status;
    END IF;

    IF OLD.status = 'pending' AND NEW.status = 'active' THEN
      IF COALESCE(current_setting('app.allow_salary_advance_approval', true), 'false') <> 'true' THEN
        RAISE EXCEPTION 'A salary advance can only be approved via approve_salary_advance()';
      END IF;
    END IF;

    IF NEW.status = 'paid' THEN
      SELECT COALESCE(SUM(deduction_amount), 0) INTO v_total_deducted
      FROM salary_advance_deductions WHERE salary_advance_id = NEW.id;

      IF (NEW.advance_amount - v_total_deducted) > 0 THEN
        RAISE EXCEPTION 'Cannot mark this advance paid -- outstanding balance is not zero (remaining %)', (NEW.advance_amount - v_total_deducted);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_salary_advance_status_transition ON salary_advances;
CREATE TRIGGER trg_guard_salary_advance_status_transition
BEFORE UPDATE ON salary_advances
FOR EACH ROW EXECUTE FUNCTION guard_salary_advance_status_transition();

-- salary_advance_deductions: the repayment ledger is written EXCLUSIVELY
-- by process_payroll_batch() (SECURITY DEFINER, bypasses RLS for its own
-- writes -- see 20260813000001) -- same pattern already established by
-- guard_id_counters/employee_number_counters in this schema: RLS enabled
-- with a SELECT-only policy for `authenticated`, and deliberately NO
-- INSERT/UPDATE/DELETE policy at all.
DROP POLICY IF EXISTS "Managers can view salary advance deductions in their tenant" ON salary_advance_deductions;
CREATE POLICY "Managers can view salary advance deductions in their tenant" ON salary_advance_deductions
FOR SELECT USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

-- salary_advance_repayment_plans: written ONLY by approve_salary_advance()
-- (never by create_salary_advance() -- a pending application never
-- touches this table) and adjust_combined_repayment_plan() -- same "only
-- these functions may write here" pattern, SELECT-only RLS.
DROP POLICY IF EXISTS "Managers can view salary advance repayment plans in their tenant" ON salary_advance_repayment_plans;
CREATE POLICY "Managers can view salary advance repayment plans in their tenant" ON salary_advance_repayment_plans
FOR SELECT USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

-- salary_advance_repayment_plan_changes: same "written only by its one
-- RPC" pattern as the deduction ledger -- SELECT-only for management
-- roles, no INSERT/UPDATE/DELETE policy at all.
DROP POLICY IF EXISTS "Managers can view salary advance plan changes in their tenant" ON salary_advance_repayment_plan_changes;
CREATE POLICY "Managers can view salary advance plan changes in their tenant" ON salary_advance_repayment_plan_changes
FOR SELECT USING (
  (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
  AND (current_user_role_level() <= 2 OR is_super_admin() = true)
);

-- ============================================================
-- create_salary_advance(): the ONLY way to create a new salary advance
-- APPLICATION. Always inserts as 'pending' -- a pending advance is a
-- REQUEST, not active debt (see the file header's LIFECYCLE SUMMARY):
-- it counts toward the max-2-open-slots limit and is visible in the UI,
-- but this function touches ONLY the `salary_advances` table. It never
-- creates or refreshes `salary_advance_repayment_plans` -- that table
-- represents approved/active debt only, and is established/updated
-- exclusively by approve_salary_advance() below, at approval time, not
-- application time.
--
-- AUTHORIZATION: this check happens INSIDE this SECURITY DEFINER function
-- body, is the SOLE gate (there is no INSERT RLS policy to also rely on
-- -- see the RLS section above), and is evaluated on every call
-- regardless of caller:
--   ALLOWED: is_super_admin() = true, OR current_user_role_level() <= 2
--   DENIED:  role_level 3 (Supervisor), role_level 4 (Staff)
-- An authenticated Supervisor/Staff session calling this RPC directly
-- (bypassing the UI entirely) fails with the exception below -- proven by
-- e2e/authenticated/salary-advances-matrix.spec.ts's dedicated "create
-- RPC authorization" test group (Admin succeeds, Manager succeeds,
-- Supervisor fails, Staff fails).
--
-- Also enforces the max-2-open-advances-per-employee business rule
-- concurrency-safely (see "MAX 2 OPEN ADVANCES" above) and validates
-- basic positivity/shape and that the schedule is internally consistent.
-- ============================================================
CREATE OR REPLACE FUNCTION create_salary_advance(
  p_employee_id UUID,
  p_application_date DATE,
  p_advance_amount NUMERIC,
  p_repayment_method TEXT,
  p_configured_monthly_deduction NUMERIC,
  p_repayment_period_months INTEGER,
  p_final_deduction_amount NUMERIC,
  p_expected_payoff_month TEXT,
  p_deduction_start_month TEXT,
  p_reason TEXT DEFAULT NULL
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
  v_open_count INTEGER;
  v_new_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT tenant_id, role_level, is_super_admin INTO v_tenant_id, v_role_level, v_is_super_admin
  FROM profiles WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- AUTHORIZATION -- see the function's own header comment above. This is
  -- the ONLY gate (SECURITY DEFINER bypasses RLS for the INSERT below).
  IF NOT (v_is_super_admin OR v_role_level <= 2) THEN
    RAISE EXCEPTION 'Only Admins, Managers, or super admins may create salary advances';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'Employee does not belong to your tenant';
  END IF;

  IF p_advance_amount IS NULL OR p_advance_amount <= 0 THEN
    RAISE EXCEPTION 'Advance amount must be a positive number';
  END IF;
  IF p_configured_monthly_deduction IS NULL OR p_configured_monthly_deduction <= 0 THEN
    RAISE EXCEPTION 'Monthly deduction must be a positive number';
  END IF;
  IF p_repayment_period_months IS NULL OR p_repayment_period_months <= 0 THEN
    RAISE EXCEPTION 'Repayment period must be a positive whole number of months';
  END IF;
  IF p_final_deduction_amount IS NULL OR p_final_deduction_amount <= 0 THEN
    RAISE EXCEPTION 'Final deduction amount must be a positive number';
  END IF;
  IF p_repayment_method NOT IN ('monthly_amount', 'repayment_period') THEN
    RAISE EXCEPTION 'Repayment method must be either monthly_amount or repayment_period';
  END IF;
  IF p_deduction_start_month IS NULL OR p_deduction_start_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Deduction start month must be in YYYY-MM format';
  END IF;
  IF ROUND(p_advance_amount - p_configured_monthly_deduction * (p_repayment_period_months - 1), 2) <> ROUND(p_final_deduction_amount, 2) THEN
    RAISE EXCEPTION 'Repayment schedule is internally inconsistent -- final deduction does not reconcile with the advance amount, monthly deduction, and period';
  END IF;

  -- Employee-scoped advisory lock -- serializes concurrent creation
  -- attempts for the SAME employee so the open-advance count check below
  -- can never race. Held for the rest of this transaction only.
  PERFORM pg_advisory_xact_lock(hashtext('salary_advance:' || p_employee_id::text));

  SELECT COUNT(*) INTO v_open_count
  FROM salary_advances
  WHERE employee_id = p_employee_id AND status IN ('pending', 'active');

  IF v_open_count >= 2 THEN
    RAISE EXCEPTION 'Employee already has the maximum of 2 open salary advances (pending or active). Resolve one before creating another.';
  END IF;

  INSERT INTO salary_advances (
    tenant_id, employee_id, application_date, advance_amount, repayment_method,
    configured_monthly_deduction, repayment_period_months, final_deduction_amount,
    expected_payoff_month, deduction_start_month, reason, status
  ) VALUES (
    v_tenant_id, p_employee_id, p_application_date, ROUND(p_advance_amount, 2), p_repayment_method,
    ROUND(p_configured_monthly_deduction, 2), p_repayment_period_months, ROUND(p_final_deduction_amount, 2),
    p_expected_payoff_month, p_deduction_start_month, p_reason, 'pending'
  ) RETURNING id INTO v_new_id;

  -- Deliberately NOTHING else happens here -- no
  -- salary_advance_repayment_plans write of any kind. A pending
  -- application must NOT change the employee's combined repayment plan;
  -- see approve_salary_advance() below for where that happens.
  RETURN jsonb_build_object('success', true, 'id', v_new_id);
END;
$$;

REVOKE ALL ON FUNCTION create_salary_advance(UUID, DATE, NUMERIC, TEXT, NUMERIC, INTEGER, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_salary_advance(UUID, DATE, NUMERIC, TEXT, NUMERIC, INTEGER, NUMERIC, TEXT, TEXT, TEXT) TO authenticated;

-- ============================================================
-- approve_salary_advance(): the ONLY way a salary advance moves from
-- 'pending' to 'active'. This is where a mere APPLICATION becomes real,
-- payroll-deducted debt -- so this single SECURITY DEFINER transaction
-- does ALL of the following atomically (all-or-nothing; if any check
-- fails, NOTHING persists, including the status flip):
--   1. Locks the target advance row (`FOR UPDATE`).
--   2. Verifies it is currently 'pending' (cannot approve an already-
--      active/paid/rejected/cancelled row).
--   3. Verifies the caller's tenant matches (or is super-admin).
--   4. Takes the SAME employee-scoped advisory lock
--      (`pg_advisory_xact_lock(hashtext('salary_advance:' || employee_id))`)
--      create_salary_advance() uses -- serializes this approval against
--      any concurrent creation/approval for the same employee.
--   5/6. Computes the employee's ACTIVE outstanding balance BEFORE this
--      approval (SUM over every OTHER 'active' advance's derived
--      remaining balance -- the advance being approved is still
--      'pending' at this point so it's naturally excluded), then adds
--      THIS advance's own full amount to get the new combined total.
--   7. Establishes or updates the ONE `salary_advance_repayment_plans`
--      row for this employee -- see "FIRST vs SECOND ADVANCE APPROVAL"
--      below for the exact rule governing what terms are used.
--   8. Flips status 'pending' -> 'active' (via a transaction-local flag
--      that lets the guard trigger permit this specific transition
--      through -- see GUARD TRIGGER 2 above; no other code path can
--      perform this transition).
--   9. Records `approved_by`/`approved_at` in the same UPDATE.
--   10. Writes a `salary_advance_repayment_plan_changes` audit row --
--      but ONLY when an existing plan is being CHANGED (a second-or-later
--      approval); establishing the very first plan is not a "change" from
--      a prior state, so no audit-history row exists for it (there is
--      nothing to compare against) -- the plan row's own `changed_by`/
--      `changed_at` already records who established it and when.
--   11. All of the above is one Postgres function invocation, hence one
--      transaction -- there is no intermediate commit point, so an error
--      at any step rolls back everything, including the status flip.
--
-- AUTHORIZATION (same pattern as create_salary_advance(), enforced
-- INSIDE this SECURITY DEFINER body, not left to RLS/frontend):
--   ALLOWED: is_super_admin() = true, OR current_user_role_level() <= 2
--   DENIED:  role_level 3 (Supervisor), role_level 4 (Staff)
--
-- FIRST vs SECOND ADVANCE APPROVAL (the business rule this function
-- exists to enforce):
--   FIRST active advance (no OTHER 'active' advance exists for this
--   employee yet): the new combined plan defaults to THIS advance's own
--   application terms (repayment_method/configured_monthly_deduction/
--   repayment_period_months/deduction_start_month) -- but the caller MAY
--   override them via p_new_repayment_method/p_new_monthly_deduction/
--   p_new_repayment_period_months/p_new_deduction_start_month, since "the
--   final active repayment plan is established during approval," not
--   frozen at application time.
--   SECOND (or later) active advance (>=1 OTHER 'active' advance already
--   exists): p_new_repayment_method, and EITHER p_new_monthly_deduction
--   OR p_new_repayment_period_months, are REQUIRED -- omitting them
--   raises an exception rather than silently reusing the old plan's
--   figures. This is the mechanism that guarantees there is never an
--   observable state where a second advance is 'active' while the
--   combined plan still reflects only the first.
-- ============================================================
CREATE OR REPLACE FUNCTION approve_salary_advance(
  p_salary_advance_id UUID,
  p_new_repayment_method TEXT DEFAULT NULL,
  p_new_monthly_deduction NUMERIC DEFAULT NULL,
  p_new_repayment_period_months INTEGER DEFAULT NULL,
  p_new_deduction_start_month TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
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
  v_advance RECORD;
  v_other_active_outstanding NUMERIC;
  v_other_active_count INTEGER;
  v_new_combined_outstanding NUMERIC;
  v_existing_plan RECORD;
  v_method TEXT;
  v_start_month TEXT;
  v_min_start_month TEXT;
  v_last_posted_month TEXT;
  v_new_monthly NUMERIC;
  v_new_months INTEGER;
  v_new_payoff_month TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT tenant_id, role_level, is_super_admin INTO v_tenant_id, v_role_level, v_is_super_admin
  FROM profiles WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (v_is_super_admin OR v_role_level <= 2) THEN
    RAISE EXCEPTION 'Only Admins, Managers, or super admins may approve salary advances';
  END IF;

  -- Step 1: lock the target advance.
  SELECT * INTO v_advance FROM salary_advances WHERE id = p_salary_advance_id FOR UPDATE;

  -- Step 3: tenant check.
  IF v_advance IS NULL OR (v_advance.tenant_id <> v_tenant_id AND NOT v_is_super_admin) THEN
    RAISE EXCEPTION 'Salary advance not found';
  END IF;

  -- Step 2: must be pending.
  IF v_advance.status <> 'pending' THEN
    RAISE EXCEPTION 'Cannot approve a % advance -- only pending advances can be approved', v_advance.status;
  END IF;

  -- Step 4: employee-scoped advisory lock -- same key create_salary_advance() uses.
  PERFORM pg_advisory_xact_lock(hashtext('salary_advance:' || v_advance.employee_id::text));

  -- Steps 5/6: ACTIVE outstanding balance before approval (every OTHER
  -- active advance), then include the advance being approved.
  SELECT COALESCE(SUM(sa.advance_amount - COALESCE(ledger.repaid, 0)), 0), COUNT(*)
    INTO v_other_active_outstanding, v_other_active_count
  FROM salary_advances sa
  LEFT JOIN (
    SELECT salary_advance_id, SUM(deduction_amount) AS repaid
    FROM salary_advance_deductions GROUP BY salary_advance_id
  ) ledger ON ledger.salary_advance_id = sa.id
  WHERE sa.employee_id = v_advance.employee_id AND sa.status = 'active';

  v_new_combined_outstanding := v_other_active_outstanding + v_advance.advance_amount;

  SELECT * INTO v_existing_plan FROM salary_advance_repayment_plans WHERE employee_id = v_advance.employee_id;

  IF v_other_active_count = 0 THEN
    -- FIRST active advance: default to this advance's own application
    -- terms unless the caller explicitly overrides them at approval time.
    v_method := COALESCE(p_new_repayment_method, v_advance.repayment_method);
    v_start_month := COALESCE(p_new_deduction_start_month, v_advance.deduction_start_month);
  ELSE
    -- SECOND (or later) active advance: management MUST explicitly
    -- supply a new combined repayment method -- approval must never
    -- leave the old plan silently reflecting only the prior advance(s).
    IF p_new_repayment_method IS NULL THEN
      RAISE EXCEPTION 'An existing active advance is already outstanding for this employee -- a new combined repayment method and monthly amount or period must be provided to approve a second advance';
    END IF;
    v_method := p_new_repayment_method;
    v_start_month := COALESCE(p_new_deduction_start_month, v_advance.deduction_start_month);
  END IF;

  IF v_start_month IS NULL OR v_start_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Deduction start month must be in YYYY-MM format';
  END IF;

  -- The new start month can never be earlier than the month AFTER the
  -- last already-posted deduction for ANY of this employee's advances.
  SELECT MAX(payroll_month) INTO v_last_posted_month
  FROM salary_advance_deductions WHERE employee_id = v_advance.employee_id;

  IF v_last_posted_month IS NOT NULL THEN
    v_min_start_month := to_char((to_date(v_last_posted_month || '-01', 'YYYY-MM-DD') + INTERVAL '1 month')::date, 'YYYY-MM');
    IF v_start_month < v_min_start_month THEN
      RAISE EXCEPTION 'New deduction start month cannot be earlier than % (the month after the last already-posted deduction)', v_min_start_month;
    END IF;
  END IF;

  IF v_method = 'monthly_amount' THEN
    IF p_new_monthly_deduction IS NULL THEN
      IF v_other_active_count = 0 THEN
        v_new_monthly := ROUND(v_advance.configured_monthly_deduction, 2);
      ELSE
        RAISE EXCEPTION 'A new combined monthly deduction amount must be provided to approve a second advance';
      END IF;
    ELSE
      IF p_new_monthly_deduction <= 0 THEN
        RAISE EXCEPTION 'Monthly deduction must be a positive number';
      END IF;
      v_new_monthly := ROUND(p_new_monthly_deduction, 2);
    END IF;
    v_new_months := CEIL(v_new_combined_outstanding / v_new_monthly);
  ELSIF v_method = 'repayment_period' THEN
    IF p_new_repayment_period_months IS NULL THEN
      IF v_other_active_count = 0 THEN
        v_new_months := v_advance.repayment_period_months;
      ELSE
        RAISE EXCEPTION 'A new combined repayment period (number of months) must be provided to approve a second advance';
      END IF;
    ELSE
      IF p_new_repayment_period_months <= 0 THEN
        RAISE EXCEPTION 'Repayment period must be a positive whole number of months';
      END IF;
      v_new_months := p_new_repayment_period_months;
    END IF;
    v_new_monthly := FLOOR(v_new_combined_outstanding / v_new_months);
    IF v_new_monthly <= 0 THEN
      RAISE EXCEPTION 'Repayment period is too long for the combined outstanding balance -- the monthly deduction would round to zero';
    END IF;
  ELSE
    RAISE EXCEPTION 'Repayment method must be either monthly_amount or repayment_period';
  END IF;

  v_new_payoff_month := to_char(
    (to_date(v_start_month || '-01', 'YYYY-MM-DD') + ((v_new_months - 1) || ' months')::interval)::date,
    'YYYY-MM'
  );

  -- Step 10: audit history ONLY when an existing plan is being changed.
  IF v_existing_plan IS NOT NULL THEN
    INSERT INTO salary_advance_repayment_plan_changes (
      tenant_id, employee_id, changed_by,
      previous_repayment_method, previous_monthly_deduction, previous_repayment_period_months, previous_deduction_start_month,
      new_repayment_method, new_monthly_deduction, new_repayment_period_months, new_deduction_start_month,
      total_outstanding_at_change, reason
    ) VALUES (
      v_tenant_id, v_advance.employee_id, v_caller_id,
      v_existing_plan.repayment_method, v_existing_plan.combined_monthly_deduction, v_existing_plan.repayment_period_months, v_existing_plan.deduction_start_month,
      v_method, v_new_monthly, v_new_months, v_start_month,
      v_new_combined_outstanding, COALESCE(p_reason, 'Additional salary advance approved -- combined repayment plan updated')
    );
  END IF;

  -- Step 7: establish/update the ONE combined plan.
  INSERT INTO salary_advance_repayment_plans (
    tenant_id, employee_id, repayment_method, combined_monthly_deduction,
    repayment_period_months, deduction_start_month, expected_payoff_month, changed_by
  ) VALUES (
    v_tenant_id, v_advance.employee_id, v_method, v_new_monthly,
    v_new_months, v_start_month, v_new_payoff_month, v_caller_id
  )
  ON CONFLICT (employee_id) DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id,
    repayment_method = EXCLUDED.repayment_method,
    combined_monthly_deduction = EXCLUDED.combined_monthly_deduction,
    repayment_period_months = EXCLUDED.repayment_period_months,
    deduction_start_month = EXCLUDED.deduction_start_month,
    expected_payoff_month = EXCLUDED.expected_payoff_month,
    changed_by = EXCLUDED.changed_by,
    changed_at = NOW();

  -- Step 8: lets the guard trigger permit this specific pending -> active
  -- transition through, for this transaction only (`is_local = true` --
  -- resets automatically at COMMIT, never leaks to any other session).
  PERFORM set_config('app.allow_salary_advance_approval', 'true', true);

  -- Steps 8/9: the status flip + approval bookkeeping, in the SAME
  -- transaction as the plan write above -- there is no commit boundary
  -- between "plan updated" and "advance active," so no external observer
  -- can ever see one without the other.
  UPDATE salary_advances SET
    status = 'active',
    approved_by = v_caller_id,
    approved_at = NOW(),
    updated_at = NOW()
  WHERE id = p_salary_advance_id;

  RETURN jsonb_build_object(
    'success', true,
    'id', p_salary_advance_id,
    'combinedMonthlyDeduction', v_new_monthly,
    'repaymentPeriodMonths', v_new_months,
    'expectedPayoffMonth', v_new_payoff_month,
    'combinedOutstanding', v_new_combined_outstanding
  );
END;
$$;

REVOKE ALL ON FUNCTION approve_salary_advance(UUID, TEXT, NUMERIC, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_salary_advance(UUID, TEXT, NUMERIC, INTEGER, TEXT, TEXT) TO authenticated;

-- ============================================================
-- adjust_combined_repayment_plan(): a LATER, independent edit to an
-- ALREADY-ACTIVE combined plan (e.g. management renegotiates the monthly
-- figure weeks after approval) -- distinct from approve_salary_advance()
-- above, which is the ONLY way the plan is first established or updated
-- as part of bringing a second advance active. EMPLOYEE-scoped (not
-- advance-scoped), since the plan itself is one-per-employee. Changes
-- ONLY future terms of the ONE combined plan, recomputed from the
-- employee's current TOTAL DERIVED outstanding balance across every
-- 'active' advance -- never from any single advance's own original
-- amount, and never touching `salary_advances` or
-- `salary_advance_deductions` at all (posted ledger rows are immutable
-- financial history). Never allows the new start month to move earlier
-- than the month after the last ALREADY-POSTED deduction for ANY of this
-- employee's advances, so an edit can never retroactively rewrite what
-- already happened. Requires an existing plan (raises otherwise) --
-- correct, since a plan now only ever exists once at least one advance
-- has been approved.
-- ============================================================
CREATE OR REPLACE FUNCTION adjust_combined_repayment_plan(
  p_employee_id UUID,
  p_new_repayment_method TEXT,
  p_new_deduction_start_month TEXT,
  p_new_monthly_deduction NUMERIC DEFAULT NULL,
  p_new_repayment_period_months INTEGER DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
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
  v_plan RECORD;
  v_total_outstanding NUMERIC;
  v_last_posted_month TEXT;
  v_min_start_month TEXT;
  v_new_monthly NUMERIC;
  v_new_months INTEGER;
  v_new_payoff_month TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT tenant_id, role_level, is_super_admin INTO v_tenant_id, v_role_level, v_is_super_admin
  FROM profiles WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  IF NOT (v_is_super_admin OR v_role_level <= 2) THEN
    RAISE EXCEPTION 'Only Admins, Managers, or super admins may adjust a repayment plan';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'Employee does not belong to your tenant';
  END IF;

  -- Lock the plan row for the rest of this transaction -- prevents a
  -- concurrent payroll run or another edit from reading/writing it mid-recalculation.
  SELECT * INTO v_plan FROM salary_advance_repayment_plans WHERE employee_id = p_employee_id FOR UPDATE;

  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'This employee has no current repayment plan to adjust -- create a salary advance first';
  END IF;

  -- Combined outstanding = SUM of remaining balance across every
  -- currently 'active' advance for this employee -- the exact same
  -- eligibility set this plan's monthly figure is allocated against in
  -- payroll (see 20260813000001) -- never the original combined total,
  -- always the CURRENT derived balance.
  SELECT COALESCE(SUM(sa.advance_amount - COALESCE(ledger.repaid, 0)), 0)
    INTO v_total_outstanding
  FROM salary_advances sa
  LEFT JOIN (
    SELECT salary_advance_id, SUM(deduction_amount) AS repaid
    FROM salary_advance_deductions GROUP BY salary_advance_id
  ) ledger ON ledger.salary_advance_id = sa.id
  WHERE sa.employee_id = p_employee_id AND sa.status = 'active';

  IF v_total_outstanding IS NULL OR v_total_outstanding <= 0 THEN
    RAISE EXCEPTION 'This employee has no remaining salary advance balance to adjust';
  END IF;

  -- The new start month can never be earlier than the month AFTER the
  -- last already-posted deduction for ANY of this employee's advances.
  SELECT MAX(payroll_month) INTO v_last_posted_month
  FROM salary_advance_deductions WHERE employee_id = p_employee_id;

  IF v_last_posted_month IS NOT NULL THEN
    v_min_start_month := to_char((to_date(v_last_posted_month || '-01', 'YYYY-MM-DD') + INTERVAL '1 month')::date, 'YYYY-MM');
  ELSE
    v_min_start_month := v_plan.deduction_start_month;
  END IF;

  IF p_new_deduction_start_month IS NULL OR p_new_deduction_start_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Deduction start month must be in YYYY-MM format';
  END IF;
  IF p_new_deduction_start_month < v_min_start_month THEN
    RAISE EXCEPTION 'New deduction start month cannot be earlier than % (the month after the last already-posted deduction)', v_min_start_month;
  END IF;

  IF p_new_repayment_method = 'monthly_amount' THEN
    IF p_new_monthly_deduction IS NULL OR p_new_monthly_deduction <= 0 THEN
      RAISE EXCEPTION 'Monthly deduction must be a positive number';
    END IF;
    v_new_monthly := ROUND(p_new_monthly_deduction, 2);
    v_new_months := CEIL(v_total_outstanding / v_new_monthly);
  ELSIF p_new_repayment_method = 'repayment_period' THEN
    IF p_new_repayment_period_months IS NULL OR p_new_repayment_period_months <= 0 THEN
      RAISE EXCEPTION 'Repayment period must be a positive whole number of months';
    END IF;
    v_new_months := p_new_repayment_period_months;
    v_new_monthly := FLOOR(v_total_outstanding / v_new_months);
    IF v_new_monthly <= 0 THEN
      RAISE EXCEPTION 'Repayment period is too long for the remaining balance -- the monthly deduction would round to zero';
    END IF;
  ELSE
    RAISE EXCEPTION 'Repayment method must be either monthly_amount or repayment_period';
  END IF;

  v_new_payoff_month := to_char(
    (to_date(p_new_deduction_start_month || '-01', 'YYYY-MM-DD') + ((v_new_months - 1) || ' months')::interval)::date,
    'YYYY-MM'
  );

  INSERT INTO salary_advance_repayment_plan_changes (
    tenant_id, employee_id, changed_by,
    previous_repayment_method, previous_monthly_deduction, previous_repayment_period_months, previous_deduction_start_month,
    new_repayment_method, new_monthly_deduction, new_repayment_period_months, new_deduction_start_month,
    total_outstanding_at_change, reason
  ) VALUES (
    v_tenant_id, p_employee_id, v_caller_id,
    v_plan.repayment_method, v_plan.combined_monthly_deduction, v_plan.repayment_period_months, v_plan.deduction_start_month,
    p_new_repayment_method, v_new_monthly, v_new_months, p_new_deduction_start_month,
    v_total_outstanding, p_reason
  );

  UPDATE salary_advance_repayment_plans SET
    repayment_method = p_new_repayment_method,
    combined_monthly_deduction = v_new_monthly,
    repayment_period_months = v_new_months,
    deduction_start_month = p_new_deduction_start_month,
    expected_payoff_month = v_new_payoff_month,
    changed_by = v_caller_id,
    changed_at = NOW()
  WHERE employee_id = p_employee_id;

  RETURN jsonb_build_object(
    'success', true,
    'employeeId', p_employee_id,
    'combinedMonthlyDeduction', v_new_monthly,
    'repaymentPeriodMonths', v_new_months,
    'expectedPayoffMonth', v_new_payoff_month,
    'totalOutstanding', v_total_outstanding
  );
END;
$$;

REVOKE ALL ON FUNCTION adjust_combined_repayment_plan(UUID, TEXT, TEXT, NUMERIC, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adjust_combined_repayment_plan(UUID, TEXT, TEXT, NUMERIC, INTEGER, TEXT) TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- CREATE TABLE/INDEX IF NOT EXISTS,
-- DROP POLICY IF EXISTS + CREATE POLICY, DROP TRIGGER IF EXISTS + CREATE
-- TRIGGER, and CREATE OR REPLACE FUNCTION throughout.
--
-- DEPENDENCIES: get_current_tenant_id(), is_super_admin(),
-- current_user_role_level() (all pre-existing, confirmed present in
-- STAGING per the verified facts this pass was given). `employees`,
-- `tenants`, `profiles` tables must exist (they do).
--
-- PREFLIGHT: none needed -- all four tables are new and start empty.
--
-- LOCKING / PRODUCTION TRAFFIC IMPACT: new table/function/trigger
-- creation only -- no existing table is altered, no existing data touched
-- or scanned.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT tablename, rowsecurity FROM pg_tables WHERE tablename IN
--     ('salary_advances','salary_advance_deductions','salary_advance_repayment_plans','salary_advance_repayment_plan_changes');
--   -- expected: all four rowsecurity = true
--   SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename IN
--     ('salary_advances','salary_advance_deductions','salary_advance_repayment_plans','salary_advance_repayment_plan_changes') ORDER BY tablename, cmd;
--   -- expected: salary_advances has SELECT/UPDATE/DELETE policies (NO INSERT policy);
--   -- the other three tables each have ONLY a SELECT policy
--   SELECT conname FROM pg_constraint WHERE conrelid = 'salary_advance_repayment_plans'::regclass AND contype = 'u';
--   -- expected: 1 row -- UNIQUE(employee_id), backing the ON CONFLICT upsert in approve_salary_advance()
--   SELECT proname, prosecdef FROM pg_proc WHERE proname IN
--     ('create_salary_advance','approve_salary_advance','adjust_combined_repayment_plan');
--   -- expected: all three prosecdef = true
--   SELECT tgname FROM pg_trigger WHERE tgname IN
--     ('trg_guard_salary_advance_plan_terms','trg_guard_salary_advance_status_transition');
--   -- expected: 2 rows
--
-- FUNCTIONAL CHECKS (require a STAGING project with a test employee,
-- since these can't be exercised from this environment):
--   Application vs approval: create advance #1 as Admin/Manager via
--   create_salary_advance() -- confirm it is 'pending' and NO
--   salary_advance_repayment_plans row exists yet for this employee.
--   Process payroll for this employee -- confirm salary_advance_deduction
--   is 0 (a pending advance must never be deducted). Call
--   approve_salary_advance() -- confirm status flips to 'active' AND a
--   plan row now exists with the advance's own terms, in the SAME call.
--   Second advance: create advance #2 (still 'pending') -- confirm the
--   plan is UNCHANGED. Call approve_salary_advance() for advance #2
--   WITHOUT p_new_repayment_method -- expect an exception (new combined
--   terms are required). Call it again WITH explicit new terms -- confirm
--   the plan updates to the new combined figure computed from BOTH
--   advances' combined outstanding, a salary_advance_repayment_plan_changes
--   row is written, and advance #2 is now 'active' -- all in one call.
--   Create advance #3 -- expect the "maximum of 2" exception (pending
--   still counts toward the limit).
--   Authorization: call create_salary_advance() AND approve_salary_advance()
--   as Supervisor/Staff -- expect an authorization exception for both, not
--   a silent no-op.
--   Bypass check: attempt `UPDATE salary_advances SET status = 'active'`
--   directly on a pending row, as Admin -- expect the guard trigger's
--   exception (only approve_salary_advance() may perform this transition).
--   Attempt `UPDATE salary_advances SET status = 'cancelled'` on an ACTIVE
--   (not pending) row -- expect rejection (active -> cancelled no longer
--   exists as a transition). Attempt `UPDATE salary_advances SET status =
--   'paid'` on an advance with a nonzero derived balance -- expect the
--   guard trigger's exception. Attempt any UPDATE on a
--   'paid'/'rejected'/'cancelled' row's status -- expect rejection.
--
-- ROLLBACK SQL (safe at any time IF this migration's own frontend/RPC
-- changes have not yet reached an environment that depends on them --
-- see 20260813000001's own rollback note for the RPC-side dependency):
--   DROP FUNCTION IF EXISTS adjust_combined_repayment_plan(UUID, TEXT, TEXT, NUMERIC, INTEGER, TEXT);
--   DROP FUNCTION IF EXISTS approve_salary_advance(UUID, TEXT, NUMERIC, INTEGER, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS create_salary_advance(UUID, DATE, NUMERIC, TEXT, NUMERIC, INTEGER, NUMERIC, TEXT, TEXT, TEXT);
--   DROP TRIGGER IF EXISTS trg_guard_salary_advance_status_transition ON salary_advances;
--   DROP FUNCTION IF EXISTS guard_salary_advance_status_transition();
--   DROP TRIGGER IF EXISTS trg_guard_salary_advance_plan_terms ON salary_advances;
--   DROP FUNCTION IF EXISTS guard_salary_advance_plan_terms();
--   DROP TABLE IF EXISTS salary_advance_repayment_plan_changes;
--   DROP TABLE IF EXISTS salary_advance_repayment_plans;
--   DROP TABLE IF EXISTS salary_advance_deductions;
--   DROP TABLE IF EXISTS salary_advances;
-- All are pure additions -- no existing table/column is touched, so
-- dropping them removes only this new feature's own data.
-- ============================================================
