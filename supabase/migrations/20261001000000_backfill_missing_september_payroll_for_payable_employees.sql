-- ============================================================
-- MIGRATION: Backfill missing September 2026 payroll rows for
-- payable (Active or approved-leave) employees
-- Date: 2026-10-01
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- -----------------------------------------------------------
-- An accountant-reported Payroll vs Payment reconciliation gap for
-- September 2026 (868 employees / MK 122,536,600 on Payroll vs a larger
-- population/total on Payment) was traced to a real application bug,
-- now fixed in code (see src/pages/Payroll.tsx's employee roster query
-- and src/utils/employeeStatus.ts): the roster that "Process Payroll"
-- is run against was filtered to `status = 'Active'` ONLY, silently
-- excluding every employee on APPROVED LEAVE from payroll entirely --
-- in direct violation of the business rule that being on leave must
-- never exclude an employee from pay.
--
-- The code fix only changes what the NEXT payroll run includes. It does
-- NOT retroactively create the missing September rows for employees who
-- were already wrongly excluded when September was processed and
-- approved. This migration does exactly that, and ONLY that -- it is a
-- one-time DATA correction, deliberately generic (keyed on employee
-- STATUS, never on a hardcoded name or id), scoped to September 2026
-- only.
--
-- WHAT THIS MIGRATION DOES
-- -----------------------------------------------------------
-- For every employee with status IN ('Active', 'On Leave'),
-- is_deleted = false, who does NOT already have an
-- approval_status = 'approved' payroll row for month = '2026-09':
--   INSERT one new payroll row, computed with the exact same formula
--   src/utils/payrollCalculations.ts's calculateLivePayroll() uses
--   (gross = basic + allowances(0) + overtime(0) + bonus(0); paye/pension
--   from system_settings' current rates; uniform deduction from the
--   employee's own uniform_deduction value, applied only if their
--   position requires a uniform, defaulting to "requires uniform" when
--   the position isn't found in `positions` -- matching
--   calculateLivePayroll's own `?? true` default exactly), with
--   approval_status = 'pending' (NOT auto-approved -- a human must
--   still review and approve newly-backfilled pay exactly like any
--   other freshly processed payroll row).
--
-- SAFETY
-- -----------------------------------------------------------
-- - The existing UNIQUE(employee_id, month) constraint on `payroll`
--   makes this migration idempotent in practice: if it's accidentally
--   run twice, the second run finds nothing left to insert (the
--   `NOT EXISTS` check covers ANY row for that employee/month, approved
--   or not, so a second run can't create a duplicate).
-- - It NEVER touches an existing payroll row -- no UPDATE, no DELETE --
--   so the 868 (or however many) already-approved September rows for
--   other employees are completely untouched.
-- - It explicitly REFUSES (raises an exception, inserting nothing) if
--   it finds a payable employee missing a September row who ALSO has an
--   active salary advance -- that case needs the proper pooled
--   allocation logic in process_payroll_batch()'s RPC (deduction ledger,
--   remaining-balance tracking), which this migration deliberately does
--   not reimplement. Such an employee must instead be processed through
--   the normal "Process Payroll" UI flow.
-- - Does not create/drop/alter any table, does not touch `attendance`,
--   `employee_deductions`, `payment_status`, or any permission.
-- - Does not delete or modify the one pre-existing failed/legacy row
--   this investigation found elsewhere (e.g. a since-deleted employee's
--   stray approved row) -- entirely out of scope here.
-- ============================================================

DO $$
DECLARE
  v_blocking_count INTEGER;
  v_paye_threshold NUMERIC;
  v_paye_rate NUMERIC;
  v_pension_rate NUMERIC;
  v_default_uniform_deduction NUMERIC;
BEGIN
  -- Refuse to proceed at all if any in-scope employee has an active
  -- salary advance -- see header comment. Nothing is inserted for
  -- anyone if this check trips, so a human can resolve the flagged
  -- employee(s) via the normal payroll flow and re-run this migration
  -- (or, more likely by then, just use "Process Payroll" for everyone).
  SELECT COUNT(*) INTO v_blocking_count
  FROM employees e
  WHERE e.status IN ('Active', 'On Leave') AND e.is_deleted = false
    AND NOT EXISTS (
      SELECT 1 FROM payroll p WHERE p.employee_id = e.id AND p.month = '2026-09'
    )
    AND EXISTS (
      SELECT 1 FROM salary_advances sa
      WHERE sa.employee_id = e.id AND sa.status = 'active' AND sa.deduction_start_month <= '2026-09'
    );

  IF v_blocking_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to backfill: % payable employee(s) missing a September 2026 payroll row have an active salary advance. This migration does not implement salary-advance pool allocation -- process these employee(s) through the normal Process Payroll flow instead, then re-run this migration for the rest.',
      v_blocking_count;
  END IF;

  SELECT COALESCE(MAX(value::NUMERIC), 0) INTO v_paye_threshold FROM system_settings WHERE key = 'paye_threshold';
  SELECT COALESCE(MAX(value::NUMERIC), 0) INTO v_paye_rate FROM system_settings WHERE key = 'paye_rate';
  SELECT COALESCE(MAX(value::NUMERIC), 0) INTO v_pension_rate FROM system_settings WHERE key = 'pension_employee_rate';
  SELECT COALESCE(MAX(value::NUMERIC), 0) INTO v_default_uniform_deduction FROM system_settings WHERE key = 'uniform_deduction_default';

  INSERT INTO payroll (
    tenant_id, employee_id, month, basic_salary, allowances, overtime, bonus,
    gross_pay, paye, pension, uniform_deduction, salary_advance_deduction, net_pay,
    processed_at, approval_status, approved_by, approved_at, approval_notes, updated_at
  )
  SELECT
    e.tenant_id,
    e.id,
    '2026-09',
    e.basic_salary,
    0,
    0,
    0,
    e.basic_salary AS gross_pay,
    ROUND(GREATEST(e.basic_salary - v_paye_threshold, 0) * v_paye_rate, 2) AS paye,
    ROUND(e.basic_salary * v_pension_rate, 2) AS pension,
    CASE
      WHEN COALESCE(pos.requires_uniform, true) THEN COALESCE(e.uniform_deduction, v_default_uniform_deduction)
      ELSE 0
    END AS uniform_deduction,
    0 AS salary_advance_deduction,
    e.basic_salary
      - ROUND(GREATEST(e.basic_salary - v_paye_threshold, 0) * v_paye_rate, 2)
      - ROUND(e.basic_salary * v_pension_rate, 2)
      - CASE
          WHEN COALESCE(pos.requires_uniform, true) THEN COALESCE(e.uniform_deduction, v_default_uniform_deduction)
          ELSE 0
        END AS net_pay,
    NOW(),
    'pending',
    NULL,
    NULL,
    'Backfilled by migration 20261001000000: employee was wrongly excluded from the September 2026 payroll run by a since-fixed status filter bug. Computed from current basic salary/rates at backfill time -- review before approving.',
    NOW()
  FROM employees e
  LEFT JOIN positions pos ON pos.name = e.position
  WHERE e.status IN ('Active', 'On Leave') AND e.is_deleted = false
    AND NOT EXISTS (
      SELECT 1 FROM payroll p WHERE p.employee_id = e.id AND p.month = '2026-09'
    );
END $$;
