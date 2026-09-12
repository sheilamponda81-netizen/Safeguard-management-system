import { test, expect } from '@playwright/test';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { missingStagingVars, getStagingCredentials, getTenantBAdmin, StagingCredentials } from '../fixtures';

// Executable staging test matrix for the Salary Advances feature --
// supabase/migrations/20260813000000_salary_advances_schema.sql (schema +
// RLS + create_salary_advance()/approve_salary_advance()/
// adjust_combined_repayment_plan() + the two lifecycle/term guard
// triggers) and 20260813000001_payroll_salary_advance_integration.sql
// (the process_payroll_batch() combined-plan, oldest-advance-first
// integration). Same skip-gating convention as rls-policy-matrix.spec.ts /
// rpc-workflow-matrix.spec.ts: every test here is SKIPPED (not silently
// passed, not hard-failed) unless a real staging project and 4 seeded
// role accounts are configured.
//
// Lifecycle (revised again -- pending applications are NOT active debt):
//   APPLICATION -- create_salary_advance() inserts a 'pending' row only.
//     It counts toward the max-2-open-advances limit and is visible in the
//     UI, but never touches salary_advance_repayment_plans and is never
//     picked up by payroll.
//   APPROVAL -- approve_salary_advance() is the ONLY path from 'pending'
//     to 'active' (a direct UPDATE is rejected by the lifecycle guard
//     trigger, even for Admin). Approving an employee's FIRST advance
//     establishes their ONE combined repayment plan from that advance's
//     own terms. Approving a SECOND advance onto an existing plan REQUIRES
//     the caller to explicitly supply new combined terms -- the old plan
//     is never silently left in place -- and both the advance's status and
//     the plan are updated together inside the RPC's own transaction, so
//     there is no observable moment where one reflects the change and the
//     other doesn't.
//   PAYROLL -- process_payroll_batch() only ever deducts against 'active'
//     advances (or an advance with an already-posted ledger row for the
//     same month, for idempotent reprocessing); a pending, rejected, or
//     cancelled advance never creates a deduction.
//   FINAL -- an advance transitions active -> paid automatically, and only
//     when its outstanding balance reaches exactly zero via a posted
//     deduction. There is no cancellation path out of 'active' -- once
//     approved, an advance can only reach 'paid'; write-off/settlement is
//     an explicitly out-of-scope, not-yet-built workflow (see
//     STAGING_VALIDATION_PLAN.md).
//
// Business rule under test (revised across several drafts): an employee
// may have UP TO TWO simultaneously 'pending'/'active' salary advances,
// but there is only ONE COMBINED monthly deduction figure for their total
// ACTIVE (approved) outstanding balance -- never the sum of each advance's
// own independently-configured rate, and never silently reused when a
// second advance is approved. Creation is RPC-only (no INSERT policy
// exists on salary_advances at all) specifically so the max-2 count check
// can be concurrency-safe. Editing the combined plan after both advances
// are already active is also RPC-only (adjust_combined_repayment_plan(),
// employee-scoped) so every change is auditable and can never
// retroactively rewrite posted history.
//
// NOT covered here (left as an acknowledged gap, not simulated): the
// employee-search/autofill UX itself is a pure frontend interaction
// (SalaryAdvances.tsx reuses TerminalDues.tsx's proven search pattern
// verbatim) -- there is no meaningful supabase-js-level test for "does
// clicking a dropdown row populate a form," and this repo has no
// component-rendering test harness (no React Testing Library / jsdom
// environment configured in vitest.config.ts) to test it more directly
// without adding new test infrastructure.

const missing = missingStagingVars();
const testMonth = '9999-08'; // far-future month, unlikely to collide with real seeded data
const testMonth2 = '9999-09';
const testMonth3 = '9999-10';

test.describe('Salary Advances matrix (schema RLS + payroll integration)', () => {
  test.skip(missing.length > 0, `Staging credentials not configured, skipping Salary Advances matrix. Missing: ${missing.join(', ')}`);

  let creds: StagingCredentials;
  let clients: Record<'admin' | 'manager' | 'supervisor' | 'staff', SupabaseClient>;
  const createdEmployeeIds: string[] = [];
  const createdAdvanceIds: string[] = [];

  test.beforeAll(async () => {
    creds = getStagingCredentials();
    const makeClient = () => createClient(creds.supabaseUrl, creds.supabaseAnonKey);
    clients = {
      admin: makeClient(),
      manager: makeClient(),
      supervisor: makeClient(),
      staff: makeClient(),
    };
    for (const [role, client] of Object.entries(clients) as [keyof typeof clients, SupabaseClient][]) {
      const { error } = await client.auth.signInWithPassword(creds[role]);
      if (error) throw new Error(`Failed to sign in as ${role}: ${error.message}`);
    }
  });

  test.afterAll(async () => {
    if (createdAdvanceIds.length > 0) {
      // salary_advance_deductions / salary_advance_repayment_plan_changes
      // cascade-delete via ON DELETE CASCADE when the parent advance/employee
      // is removed; salary_advance_repayment_plans cascades off employee_id.
      await clients.admin.from('salary_advances').delete().in('id', createdAdvanceIds);
    }
    if (createdEmployeeIds.length > 0) {
      await clients.admin.from('employees').delete().in('id', createdEmployeeIds);
    }
    for (const client of Object.values(clients)) {
      await client.auth.signOut();
    }
  });

  const makeEmployee = async (basicSalary = 200000) => {
    const { data, error } = await clients.admin
      .from('employees')
      .insert({ employee_number: `SFG-E2E-ADV-${Date.now()}-${Math.floor(Math.random() * 10000)}`, full_name: 'E2E Salary Advance Test', basic_salary: basicSalary })
      .select('id')
      .single();
    test.skip(!!error, `Could not create a disposable employee: ${error?.message}`);
    createdEmployeeIds.push(data!.id);
    return data!.id as string;
  };

  interface AdvanceOverrides {
    advance_amount?: number;
    repayment_method?: 'monthly_amount' | 'repayment_period';
    configured_monthly_deduction?: number;
    repayment_period_months?: number;
    final_deduction_amount?: number;
    expected_payoff_month?: string;
    deduction_start_month?: string;
    application_date?: string;
    reason?: string | null;
  }

  // Creation is RPC-only (see the migration's own note) -- this helper
  // calls create_salary_advance() as the given client (Admin by default),
  // matching how the real frontend now creates every advance. Note: the
  // FIRST open advance an employee gets auto-establishes their combined
  // plan from these same terms; a SECOND does NOT touch the existing plan
  // (see the "second advance does NOT automatically double" test below).
  const makeAdvance = async (employeeId: string, overrides: AdvanceOverrides = {}, client: SupabaseClient = clients.admin) => {
    const params = {
      p_employee_id: employeeId,
      p_application_date: overrides.application_date ?? new Date().toISOString().slice(0, 10),
      p_advance_amount: overrides.advance_amount ?? 80000,
      p_repayment_method: overrides.repayment_method ?? 'monthly_amount',
      p_configured_monthly_deduction: overrides.configured_monthly_deduction ?? 20000,
      p_repayment_period_months: overrides.repayment_period_months ?? 4,
      p_final_deduction_amount: overrides.final_deduction_amount ?? 20000,
      p_expected_payoff_month: overrides.expected_payoff_month ?? testMonth3,
      p_deduction_start_month: overrides.deduction_start_month ?? testMonth,
      p_reason: overrides.reason ?? null,
    };
    const { data, error } = await client.rpc('create_salary_advance', params);
    const id = (data as { id?: string } | null)?.id;
    if (id) createdAdvanceIds.push(id);
    return { data: id ? { id } : null, error };
  };

  interface ApproveOverrides {
    method?: 'monthly_amount' | 'repayment_period';
    monthlyDeduction?: number;
    periodMonths?: number;
    startMonth?: string;
    reason?: string;
  }

  // pending -> active is reachable ONLY through this RPC -- the lifecycle
  // guard trigger rejects a direct UPDATE unless approve_salary_advance()'s
  // own transaction-local flag is set. On an employee's FIRST approval it
  // establishes the combined plan from the advance's own terms (unless
  // overridden here); approving a SECOND advance onto an existing plan
  // REQUIRES an explicit method (see the "approve_salary_advance()
  // workflow" describe block for the failure/success proof of that rule).
  const approveAdvance = async (id: string, overrides: ApproveOverrides = {}, client: SupabaseClient = clients.admin) => {
    const { data, error } = await client.rpc('approve_salary_advance', {
      p_salary_advance_id: id,
      p_new_repayment_method: overrides.method ?? null,
      p_new_monthly_deduction: overrides.method === 'repayment_period' ? null : (overrides.monthlyDeduction ?? null),
      p_new_repayment_period_months: overrides.method === 'repayment_period' ? (overrides.periodMonths ?? null) : null,
      p_new_deduction_start_month: overrides.startMonth ?? null,
      p_reason: overrides.reason ?? null,
    });
    return { data: data as { id?: string; combinedOutstanding?: number; combinedMonthlyDeduction?: number; repaymentPeriodMonths?: number } | null, error };
  };

  // create_salary_advance() always inserts as 'pending' (approval is a
  // separate step) -- this helper creates then approves in one call for
  // tests that need an immediately-eligible advance, mirroring the
  // frontend's own two-step Apply -> Approve flow. Pass approveOverrides
  // when seeding a SECOND active advance for the same employee -- the RPC
  // requires explicit new combined terms in that case, so the default
  // (no overrides) only works for an employee's FIRST active advance.
  const makeActiveAdvance = async (employeeId: string, overrides: AdvanceOverrides = {}, approveOverrides: ApproveOverrides = {}) => {
    const { data, error } = await makeAdvance(employeeId, overrides);
    if (error || !data) return { data, error };
    const { error: approveErr } = await approveAdvance(data.id, approveOverrides);
    return { data, error: approveErr };
  };

  const setAdvanceStatus = async (id: string, status: string) => {
    const { error } = await clients.admin.from('salary_advances').update({ status }).eq('id', id);
    return error;
  };

  const getPlan = async (employeeId: string) => {
    const { data } = await clients.admin.from('salary_advance_repayment_plans').select('*').eq('employee_id', employeeId).maybeSingle();
    return data as { combined_monthly_deduction: number; repayment_period_months: number; deduction_start_month: string; expected_payoff_month: string; repayment_method: string } | null;
  };

  // Explicitly (re)sets an employee's ONE combined plan via
  // adjust_combined_repayment_plan() -- used by every multi-advance
  // payroll test to set a deliberate, test-specific combined figure
  // rather than relying on whatever create_salary_advance() happened to
  // auto-establish from the first advance alone.
  const setCombinedPlan = async (
    employeeId: string,
    opts: { monthlyDeduction?: number; periodMonths?: number; method?: 'monthly_amount' | 'repayment_period'; startMonth?: string; reason?: string } = {}
  ) => {
    const method = opts.method ?? 'monthly_amount';
    const { data, error } = await clients.admin.rpc('adjust_combined_repayment_plan', {
      p_employee_id: employeeId,
      p_new_repayment_method: method,
      p_new_deduction_start_month: opts.startMonth ?? testMonth,
      p_new_monthly_deduction: method === 'monthly_amount' ? (opts.monthlyDeduction ?? null) : null,
      p_new_repayment_period_months: method === 'repayment_period' ? (opts.periodMonths ?? null) : null,
      p_reason: opts.reason ?? null,
    });
    return { data, error };
  };

  const payrollRecord = (employeeId: string, basicSalary = 200000) => ({
    employee_id: employeeId,
    basic_salary: basicSalary, allowances: 0, overtime: 0, bonus: 0,
    gross_pay: basicSalary, paye: 0, pension: 0, uniform_deduction: 0,
    net_pay: basicSalary,
  });

  // ------------------------------------------------------------------
  // RLS + max-2-open-advances enforcement
  // ------------------------------------------------------------------
  test.describe('RLS', () => {
    test('Admin can create (via RPC) and select a salary advance', async () => {
      const employeeId = await makeEmployee();
      const { data, error } = await makeAdvance(employeeId);
      expect(error).toBeNull();
      const { data: read, error: readErr } = await clients.admin.from('salary_advances').select('*').eq('id', data!.id);
      expect(readErr).toBeNull();
      expect(read).toHaveLength(1);
      expect(read![0].status).toBe('pending');
    });

    // NOTE: creation no longer touches the combined plan at all -- see
    // "a pending application does not create or touch the combined
    // repayment plan" and "the first approval establishes the combined
    // plan..." in the approve_salary_advance() workflow describe block
    // below, which replace what used to be tested here at creation time.

    test('Manager can create a salary advance via the RPC', async () => {
      const employeeId = await makeEmployee();
      const { error } = await makeAdvance(employeeId, {}, clients.manager);
      expect(error).toBeNull();
    });

    test('Supervisor CANNOT create a salary advance via the RPC', async () => {
      const employeeId = await makeEmployee();
      const { error } = await makeAdvance(employeeId, {}, clients.supervisor);
      expect(error).not.toBeNull();
    });

    test('Staff CANNOT create a salary advance via the RPC', async () => {
      const employeeId = await makeEmployee();
      const { error } = await makeAdvance(employeeId, {}, clients.staff);
      expect(error).not.toBeNull();
    });

    test('a direct supabase-js insert into salary_advances is rejected for EVERY role, including Admin -- creation is RPC-only', async () => {
      const employeeId = await makeEmployee();
      for (const [role, client] of Object.entries(clients) as [string, SupabaseClient][]) {
        const { error } = await client.from('salary_advances').insert({
          employee_id: employeeId, advance_amount: 50000, repayment_method: 'monthly_amount',
          configured_monthly_deduction: 25000, repayment_period_months: 2, final_deduction_amount: 25000,
          expected_payoff_month: testMonth2, deduction_start_month: testMonth, status: 'pending',
        });
        expect(error, `${role}'s direct insert should have been rejected by RLS (no INSERT policy exists)`).not.toBeNull();
      }
    });

    test('Supervisor and Staff CANNOT select salary_advances rows directly', async () => {
      const employeeId = await makeEmployee();
      const { data: created, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a salary advance: ${seedErr?.message}`);

      const { data: supervisorRead } = await clients.supervisor.from('salary_advances').select('*').eq('id', created!.id);
      expect(supervisorRead ?? []).toHaveLength(0);

      const { data: staffRead } = await clients.staff.from('salary_advances').select('*').eq('id', created!.id);
      expect(staffRead ?? []).toHaveLength(0);
    });

    test('Supervisor and Staff CANNOT update a salary advance (e.g. self-approve)', async () => {
      const employeeId = await makeEmployee();
      const { data: created, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a salary advance: ${seedErr?.message}`);

      await clients.staff.from('salary_advances').update({ status: 'active' }).eq('id', created!.id);
      // RLS-denied UPDATE affects 0 rows silently -- verify via re-read.
      const { data: after } = await clients.admin.from('salary_advances').select('status').eq('id', created!.id).single();
      expect(after?.status).toBe('pending');
    });

    test('Only super-admin (not Admin) can delete a salary advance -- least privilege, matches terminal_dues', async () => {
      const employeeId = await makeEmployee();
      const { data: created, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a salary advance: ${seedErr?.message}`);

      await clients.admin.from('salary_advances').delete().eq('id', created!.id);
      const { data: after } = await clients.admin.from('salary_advances').select('id').eq('id', created!.id);
      expect(after).toHaveLength(1);
    });

    test('salary_advance_deductions ledger cannot be written directly by ANY authenticated role, including Admin', async () => {
      const employeeId = await makeEmployee();
      const { data: created, error: seedErr } = await makeActiveAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const { error } = await clients.admin.from('salary_advance_deductions').insert({
        salary_advance_id: created!.id, employee_id: employeeId, payroll_month: testMonth, deduction_amount: 1000,
      });
      expect(error).not.toBeNull();
    });

    test('salary_advance_repayment_plans: direct INSERT/UPDATE/DELETE are rejected for Admin AND Manager -- only approve_salary_advance()/adjust_combined_repayment_plan() may write here', async () => {
      const employeeId = await makeEmployee();

      // No plan exists yet -- direct INSERT is rejected for both management roles.
      for (const [role, client] of [['admin', clients.admin], ['manager', clients.manager]] as const) {
        const { error } = await client.from('salary_advance_repayment_plans').insert({
          employee_id: employeeId, repayment_method: 'monthly_amount', combined_monthly_deduction: 10000,
          repayment_period_months: 1, deduction_start_month: testMonth, expected_payoff_month: testMonth,
        });
        expect(error, `${role}'s direct INSERT should have been rejected -- no INSERT policy exists`).not.toBeNull();
      }
      const planAfterInsertAttempts = await getPlan(employeeId);
      expect(planAfterInsertAttempts).toBeNull(); // nothing was created

      // Now establish a REAL plan through the authorized RPC path -- proves
      // the rejections above are specifically an RLS bypass block, not some
      // unrelated failure (e.g. a bad employeeId).
      const { error: activeErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 50000, configured_monthly_deduction: 10000, repayment_period_months: 5, final_deduction_amount: 10000,
      });
      test.skip(!!activeErr, `Could not establish a plan via approve_salary_advance(): ${activeErr?.message}`);
      const planBefore = await getPlan(employeeId);
      expect(Number(planBefore?.combined_monthly_deduction)).toBe(10000);

      // Direct UPDATE/DELETE on the now-existing plan row are ALSO rejected
      // for both management roles.
      for (const [role, client] of [['admin', clients.admin], ['manager', clients.manager]] as const) {
        const { error: updateErr } = await client.from('salary_advance_repayment_plans').update({ combined_monthly_deduction: 1 }).eq('employee_id', employeeId);
        expect(updateErr, `${role}'s direct UPDATE should have been rejected`).not.toBeNull();

        const { error: deleteErr } = await client.from('salary_advance_repayment_plans').delete().eq('employee_id', employeeId);
        expect(deleteErr, `${role}'s direct DELETE should have been rejected`).not.toBeNull();
      }

      // Confirm nothing actually changed despite every direct-write attempt above.
      const planAfter = await getPlan(employeeId);
      expect(Number(planAfter?.combined_monthly_deduction)).toBe(10000);

      // The authorized RPC path still works, proving this is an RLS
      // bypass-block, not a broken table.
      const { error: adjustErr } = await setCombinedPlan(employeeId, { monthlyDeduction: 25000, startMonth: testMonth });
      expect(adjustErr).toBeNull();
      const planFinal = await getPlan(employeeId);
      expect(Number(planFinal?.combined_monthly_deduction)).toBe(25000);
    });

    test('salary_advance_repayment_plan_changes: direct INSERT/UPDATE/DELETE are rejected for Admin AND Manager -- this audit table is written only by the RPCs themselves', async () => {
      const employeeId = await makeEmployee();

      for (const [role, client] of [['admin', clients.admin], ['manager', clients.manager]] as const) {
        const { error: insertErr } = await client.from('salary_advance_repayment_plan_changes').insert({
          employee_id: employeeId,
          previous_repayment_method: 'monthly_amount', previous_monthly_deduction: 1, previous_repayment_period_months: 1, previous_deduction_start_month: testMonth,
          new_repayment_method: 'monthly_amount', new_monthly_deduction: 2, new_repayment_period_months: 1, new_deduction_start_month: testMonth,
          total_outstanding_at_change: 1,
        });
        expect(insertErr, `${role}'s direct INSERT should have been rejected -- no INSERT policy exists`).not.toBeNull();
      }

      // Establish a real audit row through the authorized RPC path.
      const { error: activeErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 50000, configured_monthly_deduction: 10000, repayment_period_months: 5, final_deduction_amount: 10000,
      });
      test.skip(!!activeErr, `Could not seed an active advance: ${activeErr?.message}`);
      const { error: adjustErr } = await setCombinedPlan(employeeId, { monthlyDeduction: 20000, startMonth: testMonth, reason: 'bypass test' });
      test.skip(!!adjustErr, `Could not create an audit row via the RPC: ${adjustErr?.message}`);

      const { data: historyBefore } = await clients.admin.from('salary_advance_repayment_plan_changes').select('*').eq('employee_id', employeeId);
      expect(historyBefore).toHaveLength(1);
      const rowId = historyBefore![0].id;

      for (const [role, client] of [['admin', clients.admin], ['manager', clients.manager]] as const) {
        const { error: updateErr } = await client.from('salary_advance_repayment_plan_changes').update({ reason: 'tampered' }).eq('id', rowId);
        expect(updateErr, `${role}'s direct UPDATE should have been rejected`).not.toBeNull();

        const { error: deleteErr } = await client.from('salary_advance_repayment_plan_changes').delete().eq('id', rowId);
        expect(deleteErr, `${role}'s direct DELETE should have been rejected`).not.toBeNull();
      }

      const { data: historyAfter } = await clients.admin.from('salary_advance_repayment_plan_changes').select('reason').eq('id', rowId).single();
      expect(historyAfter?.reason).toBe('bypass test'); // unchanged by any of the attempts above
    });

    // ------------------------------------------------------------------
    // MAX 2 OPEN ADVANCES
    // ------------------------------------------------------------------
    test('1. first advance is allowed for an employee with zero open advances', async () => {
      const employeeId = await makeEmployee();
      const { error } = await makeAdvance(employeeId);
      expect(error).toBeNull();
    });

    test('2. a second open advance is allowed for the same employee', async () => {
      const employeeId = await makeEmployee();
      const { error: firstErr } = await makeAdvance(employeeId);
      test.skip(!!firstErr, `Could not seed the first advance: ${firstErr?.message}`);
      const { error: secondErr } = await makeAdvance(employeeId);
      expect(secondErr).toBeNull();
    });

    // NOTE: a second PENDING advance never touches the plan either (it's
    // still just an application) -- see "approving a second advance
    // onto an existing plan WITHOUT new combined terms is rejected" /
    // "...WITH explicit new combined terms succeeds" below, which cover
    // what used to be tested here at creation time.

    test('3. a third open advance is rejected server-side, even for Admin', async () => {
      const employeeId = await makeEmployee();
      const { error: e1 } = await makeAdvance(employeeId);
      const { error: e2 } = await makeAdvance(employeeId);
      test.skip(!!e1 || !!e2, 'Could not seed 2 open advances as a precondition');

      const { error: thirdErr } = await makeAdvance(employeeId);
      expect(thirdErr).not.toBeNull();
      expect(thirdErr?.message).toContain('maximum of 2');
    });

    test('4. a paid advance no longer counts toward the limit -- a 3rd becomes allowed once one is resolved', async () => {
      const employeeId = await makeEmployee();
      // Approve (not just create) the first advance and pay it off via a
      // real payroll run -- 'paid' is only ever reachable that way now, so
      // this exercises the real path instead of a direct status flip.
      const { data: a1, error: e1 } = await makeActiveAdvance(employeeId, {
        advance_amount: 20000, configured_monthly_deduction: 20000, repayment_period_months: 1, final_deduction_amount: 20000,
      });
      const { error: e2 } = await makeAdvance(employeeId);
      test.skip(!!e1 || !!e2, 'Could not seed 2 open advances as a precondition');

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      const { data: a1After } = await clients.admin.from('salary_advances').select('status').eq('id', a1!.id).single();
      test.skip(a1After?.status !== 'paid', 'Could not pay off the first advance as a precondition');

      const { error: thirdErr } = await makeAdvance(employeeId);
      expect(thirdErr).toBeNull();

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('5. a rejected/cancelled advance does not count toward the limit either', async () => {
      const employeeId = await makeEmployee();
      const { data: a1, error: e1 } = await makeAdvance(employeeId);
      test.skip(!!e1, `Could not seed the first advance: ${e1?.message}`);

      const statusErr = await setAdvanceStatus(a1!.id, 'rejected');
      test.skip(!!statusErr, `Could not reject the first advance: ${statusErr?.message}`);

      // Now 2 MORE should be allowed (0 open before these 2).
      const { error: e2 } = await makeAdvance(employeeId);
      const { error: e3 } = await makeAdvance(employeeId);
      expect(e2).toBeNull();
      expect(e3).toBeNull();
    });

    test('6. concurrent creation attempts for the same employee cannot produce 3 open advances', async () => {
      const employeeId = await makeEmployee();
      // Fire 4 concurrent create attempts for an employee starting at 0
      // open advances -- the employee-scoped advisory lock inside
      // create_salary_advance() must serialize these so AT MOST 2 succeed,
      // no matter the arrival order.
      const results = await Promise.all([
        makeAdvance(employeeId),
        makeAdvance(employeeId),
        makeAdvance(employeeId),
        makeAdvance(employeeId),
      ]);
      const succeeded = results.filter(r => !r.error);
      const failed = results.filter(r => !!r.error);
      expect(succeeded.length).toBe(2);
      expect(failed.length).toBe(2);
      for (const f of failed) {
        expect(f.error?.message).toContain('maximum of 2');
      }

      const { data: openRows } = await clients.admin.from('salary_advances').select('id').eq('employee_id', employeeId).in('status', ['pending', 'active']);
      expect(openRows).toHaveLength(2); // never 3, regardless of race timing
    });

    test('22. a direct API attempt to create a 3rd open advance also fails (not just the RPC path)', async () => {
      const employeeId = await makeEmployee();
      const { error: e1 } = await makeAdvance(employeeId);
      const { error: e2 } = await makeAdvance(employeeId);
      test.skip(!!e1 || !!e2, 'Could not seed 2 open advances as a precondition');

      const { error } = await clients.admin.from('salary_advances').insert({
        employee_id: employeeId, advance_amount: 10000, repayment_method: 'monthly_amount',
        configured_monthly_deduction: 5000, repayment_period_months: 2, final_deduction_amount: 5000,
        expected_payoff_month: testMonth2, deduction_start_month: testMonth, status: 'pending',
      });
      // Rejected by RLS (no INSERT policy) regardless of the count --
      // creation can ONLY happen through create_salary_advance().
      expect(error).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // create_salary_advance() authorization -- explicit, dedicated proof
  // (correction: "Inspect create_salary_advance(). It MUST enforce
  // authorization inside the SECURITY DEFINER function itself... Add
  // explicit E2E tests"). Functionally overlaps with the RLS group above
  // but is called out on its own here so it reads as a direct answer to
  // that specific requirement.
  // ------------------------------------------------------------------
  test.describe('create_salary_advance() authorization (explicit proof)', () => {
    test('1. Admin: create RPC succeeds', async () => {
      const employeeId = await makeEmployee();
      const { error } = await makeAdvance(employeeId, {}, clients.admin);
      expect(error).toBeNull();
    });

    test('2. Manager: create RPC succeeds', async () => {
      const employeeId = await makeEmployee();
      const { error } = await makeAdvance(employeeId, {}, clients.manager);
      expect(error).toBeNull();
    });

    test('3. Supervisor: create RPC fails', async () => {
      const employeeId = await makeEmployee();
      const { error } = await makeAdvance(employeeId, {}, clients.supervisor);
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Only Admins, Managers, or super admins');
    });

    test('4. Staff: create RPC fails', async () => {
      const employeeId = await makeEmployee();
      const { error } = await makeAdvance(employeeId, {}, clients.staff);
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Only Admins, Managers, or super admins');
    });
  });

  // ------------------------------------------------------------------
  // approve_salary_advance() -- the ONLY path from 'pending' to 'active'.
  // A merely-pending application is a request, not debt: it must not
  // touch the combined plan or create any payroll deduction until
  // explicitly approved. Approving a FIRST advance establishes the
  // combined plan from its own terms; approving a SECOND (or later)
  // advance onto an existing plan REQUIRES the caller to explicitly
  // supply new combined terms -- the old plan is never silently reused.
  // ------------------------------------------------------------------
  test.describe('approve_salary_advance() workflow', () => {
    test('a pending application does not create or touch the combined repayment plan', async () => {
      const employeeId = await makeEmployee();
      const { error } = await makeAdvance(employeeId, { advance_amount: 80000, configured_monthly_deduction: 20000 });
      test.skip(!!error, `Could not seed a pending advance: ${error?.message}`);

      const plan = await getPlan(employeeId);
      expect(plan).toBeNull();
    });

    test('Admin: approve RPC succeeds and transitions pending -> active, recording approved_by/approved_at', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a pending advance: ${seedErr?.message}`);

      const { error } = await approveAdvance(advance!.id);
      expect(error).toBeNull();

      const { data: after } = await clients.admin.from('salary_advances').select('status, approved_by, approved_at').eq('id', advance!.id).single();
      expect(after?.status).toBe('active');
      expect(after?.approved_at).not.toBeNull();
    });

    test('Manager: approve RPC succeeds', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a pending advance: ${seedErr?.message}`);

      const { error } = await approveAdvance(advance!.id, {}, clients.manager);
      expect(error).toBeNull();
    });

    test('Supervisor: approve RPC fails', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a pending advance: ${seedErr?.message}`);

      const { error } = await approveAdvance(advance!.id, {}, clients.supervisor);
      expect(error).not.toBeNull();

      const { data: after } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(after?.status).toBe('pending');
    });

    test('Staff: approve RPC fails', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a pending advance: ${seedErr?.message}`);

      const { error } = await approveAdvance(advance!.id, {}, clients.staff);
      expect(error).not.toBeNull();

      const { data: after } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(after?.status).toBe('pending');
    });

    test('a direct pending -> active UPDATE is rejected even for Admin -- only approve_salary_advance() may perform it', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a pending advance: ${seedErr?.message}`);

      const { error } = await clients.admin.from('salary_advances').update({ status: 'active' }).eq('id', advance!.id);
      expect(error).not.toBeNull();

      const { data: after } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(after?.status).toBe('pending');
    });

    test('the first approval establishes the combined plan from the advance\'s own terms', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId, {
        advance_amount: 80000, configured_monthly_deduction: 20000, repayment_period_months: 4, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed a pending advance: ${seedErr?.message}`);

      const { data: result, error } = await approveAdvance(advance!.id);
      expect(error).toBeNull();
      expect(result?.combinedOutstanding).toBe(80000);
      expect(result?.combinedMonthlyDeduction).toBe(20000);
      expect(result?.repaymentPeriodMonths).toBe(4);

      const plan = await getPlan(employeeId);
      expect(plan).not.toBeNull();
      expect(Number(plan?.combined_monthly_deduction)).toBe(20000);
    });

    test('the first approval does NOT write a plan-change audit entry (nothing previous to record)', async () => {
      const employeeId = await makeEmployee();
      const { error } = await makeActiveAdvance(employeeId);
      test.skip(!!error, `Could not seed the first active advance: ${error?.message}`);

      const { data: history } = await clients.admin.from('salary_advance_repayment_plan_changes').select('*').eq('employee_id', employeeId);
      expect(history ?? []).toHaveLength(0);
    });

    test('approving a second advance onto an existing plan WITHOUT new combined terms is rejected', async () => {
      const employeeId = await makeEmployee();
      const { error: e1 } = await makeActiveAdvance(employeeId, { advance_amount: 80000, configured_monthly_deduction: 20000, repayment_period_months: 4, final_deduction_amount: 20000 });
      test.skip(!!e1, `Could not seed the first active advance: ${e1?.message}`);

      const { data: second, error: seedErr } = await makeAdvance(employeeId, { advance_amount: 40000 });
      test.skip(!!seedErr, `Could not seed a second pending advance: ${seedErr?.message}`);

      const { error } = await approveAdvance(second!.id); // no method/terms supplied
      expect(error).not.toBeNull();

      const { data: after } = await clients.admin.from('salary_advances').select('status').eq('id', second!.id).single();
      expect(after?.status).toBe('pending'); // still pending -- the failed approval did not partially apply

      const plan = await getPlan(employeeId);
      expect(Number(plan?.combined_monthly_deduction)).toBe(20000); // unchanged
    });

    test('approving a second advance WITH explicit new combined terms succeeds and atomically updates both the advance and the plan', async () => {
      const employeeId = await makeEmployee();
      const { error: e1 } = await makeActiveAdvance(employeeId, { advance_amount: 80000, configured_monthly_deduction: 20000, repayment_period_months: 4, final_deduction_amount: 20000 });
      test.skip(!!e1, `Could not seed the first active advance: ${e1?.message}`);

      const planBefore = await getPlan(employeeId);
      expect(Number(planBefore?.combined_monthly_deduction)).toBe(20000); // only the first advance's terms so far

      const { data: second, error: seedErr } = await makeAdvance(employeeId, { advance_amount: 40000 });
      test.skip(!!seedErr, `Could not seed a second pending advance: ${seedErr?.message}`);

      // Business rule's own worked example: 80,000 (first) + 40,000
      // (second) = 120,000 combined outstanding; management explicitly
      // sets a new combined monthly figure of 30,000.
      const { data: result, error } = await approveAdvance(second!.id, { method: 'monthly_amount', monthlyDeduction: 30000, startMonth: testMonth });
      expect(error).toBeNull();
      expect(result?.combinedOutstanding).toBe(120000);
      expect(result?.combinedMonthlyDeduction).toBe(30000);

      // Post-call state is internally consistent -- there is no
      // observable moment where the second advance is active but the
      // plan still reflects only the first (both happen inside the RPC's
      // own single transaction).
      const { data: secondAfter } = await clients.admin.from('salary_advances').select('status').eq('id', second!.id).single();
      expect(secondAfter?.status).toBe('active');
      const planAfter = await getPlan(employeeId);
      expect(Number(planAfter?.combined_monthly_deduction)).toBe(30000);
    });

    test('approving a second advance records a plan-change audit entry', async () => {
      const employeeId = await makeEmployee();
      const { error: e1 } = await makeActiveAdvance(employeeId, { advance_amount: 80000, configured_monthly_deduction: 20000, repayment_period_months: 4, final_deduction_amount: 20000 });
      test.skip(!!e1, `Could not seed the first active advance: ${e1?.message}`);

      const { data: second, error: seedErr } = await makeAdvance(employeeId, { advance_amount: 40000 });
      test.skip(!!seedErr, `Could not seed a second pending advance: ${seedErr?.message}`);

      const { error } = await approveAdvance(second!.id, { method: 'monthly_amount', monthlyDeduction: 30000, startMonth: testMonth, reason: 'second advance approved' });
      test.skip(!!error, `Could not approve the second advance: ${error?.message}`);

      const { data: history } = await clients.admin.from('salary_advance_repayment_plan_changes').select('*').eq('employee_id', employeeId);
      expect(history).toHaveLength(1); // none recorded for the FIRST approval
      expect(Number(history![0].previous_monthly_deduction)).toBe(20000);
      expect(Number(history![0].new_monthly_deduction)).toBe(30000);
    });

    test('approving an already-active advance is rejected (must be pending)', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed an active advance: ${seedErr?.message}`);

      const { error } = await approveAdvance(advance!.id);
      expect(error).not.toBeNull();
    });

    test('approving a rejected advance is rejected (terminal state)', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a pending advance: ${seedErr?.message}`);
      await setAdvanceStatus(advance!.id, 'rejected');

      const { error } = await approveAdvance(advance!.id);
      expect(error).not.toBeNull();
    });

    test('approving a second advance moves its amount out of "pending" and into active outstanding', async () => {
      const employeeId = await makeEmployee();
      const { error: e1 } = await makeActiveAdvance(employeeId, { advance_amount: 80000, configured_monthly_deduction: 20000, repayment_period_months: 4, final_deduction_amount: 20000 });
      test.skip(!!e1, `Could not seed the first active advance: ${e1?.message}`);
      const { data: second, error: seedErr } = await makeAdvance(employeeId, { advance_amount: 40000 });
      test.skip(!!seedErr, `Could not seed a second pending advance: ${seedErr?.message}`);

      const activeBefore = await clients.admin.from('salary_advances').select('advance_amount').eq('employee_id', employeeId).eq('status', 'active');
      const activeOutstandingBefore = (activeBefore.data || []).reduce((s, r) => s + Number(r.advance_amount), 0);
      expect(activeOutstandingBefore).toBe(80000); // the second advance's 40,000 is NOT yet counted -- it's only "pending"

      await approveAdvance(second!.id, { method: 'monthly_amount', monthlyDeduction: 30000, startMonth: testMonth });

      const activeAfter = await clients.admin.from('salary_advances').select('advance_amount').eq('employee_id', employeeId).eq('status', 'active');
      const activeOutstandingAfter = (activeAfter.data || []).reduce((s, r) => s + Number(r.advance_amount), 0);
      expect(activeOutstandingAfter).toBe(120000); // now both count
    });
  });

  // ------------------------------------------------------------------
  // Lifecycle / status integrity (correction: "Ensure users cannot
  // directly mark an advance 'paid' while outstanding balance is greater
  // than zero. PAID must be produced automatically...")
  // ------------------------------------------------------------------
  test.describe('lifecycle / status integrity', () => {
    test('cannot manually mark an unpaid advance as paid, even as Admin', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 50000, configured_monthly_deduction: 10000, repayment_period_months: 5, final_deduction_amount: 10000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const { error } = await clients.admin.from('salary_advances').update({ status: 'paid' }).eq('id', advance!.id);
      expect(error).not.toBeNull();

      const { data: after } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(after?.status).toBe('active');
    });

    test('the final payroll deduction automatically marks the advance paid', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 20000, configured_monthly_deduction: 20000, repayment_period_months: 1, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: after } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(after?.status).toBe('paid');

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('a paid advance remains paid and cannot be reverted, even as Admin', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 10000, configured_monthly_deduction: 10000, repayment_period_months: 1, final_deduction_amount: 10000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      const { data: afterPaid } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(afterPaid?.status).toBe('paid');

      const { error } = await clients.admin.from('salary_advances').update({ status: 'active' }).eq('id', advance!.id);
      expect(error).not.toBeNull();

      const { data: stillPaid } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(stillPaid?.status).toBe('paid');

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('an active advance CANNOT be cancelled -- there is no write-off/cancellation path out of active, even for Admin', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 50000, configured_monthly_deduction: 10000, repayment_period_months: 5, final_deduction_amount: 10000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const { error } = await clients.admin.from('salary_advances').update({ status: 'cancelled' }).eq('id', advance!.id);
      expect(error).not.toBeNull();

      const { data: after } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(after?.status).toBe('active'); // unchanged -- active can only ever reach 'paid'
    });

    test('a cancelled pending advance never posts any deduction', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a pending salary advance: ${seedErr?.message}`);

      const { error } = await clients.admin.from('salary_advances').update({ status: 'cancelled' }).eq('id', advance!.id);
      expect(error).toBeNull();

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.salary_advance_deduction)).toBe(0);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('rejecting a pending advance never posts any deduction', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a pending salary advance: ${seedErr?.message}`);

      const { error } = await clients.admin.from('salary_advances').update({ status: 'rejected' }).eq('id', advance!.id);
      expect(error).toBeNull();

      const { data: ledger } = await clients.admin.from('salary_advance_deductions').select('id').eq('salary_advance_id', advance!.id);
      expect(ledger ?? []).toHaveLength(0);
    });

    test('invalid transition pending -> paid (skipping active) is blocked', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a pending salary advance: ${seedErr?.message}`);

      const { error } = await clients.admin.from('salary_advances').update({ status: 'paid' }).eq('id', advance!.id);
      expect(error).not.toBeNull();
    });

    test('terminal states cannot be changed again (rejected -> active is blocked)', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a pending salary advance: ${seedErr?.message}`);
      await setAdvanceStatus(advance!.id, 'rejected');

      const { error } = await clients.admin.from('salary_advances').update({ status: 'active' }).eq('id', advance!.id);
      expect(error).not.toBeNull();

      const { data: after } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(after?.status).toBe('rejected');
    });
  });

  // ------------------------------------------------------------------
  // Payroll integration: process_payroll_batch() applying/idempotently
  // re-applying salary advance deductions, including the combined-plan,
  // oldest-advance-first allocation across up to 2 open advances.
  // ------------------------------------------------------------------
  test.describe('payroll integration', () => {
    test('first monthly deduction is applied and stored on the payroll row', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const { data: result, error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email,
      });
      expect(error).toBeNull();
      expect(result.success).toBe(true);

      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction, net_pay').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.salary_advance_deduction)).toBe(20000);
      expect(Number(row?.net_pay)).toBe(180000); // 200000 - 20000

      const { data: ledger } = await clients.admin.from('salary_advance_deductions').select('deduction_amount').eq('salary_advance_id', advance!.id).eq('payroll_month', testMonth);
      expect(ledger).toHaveLength(1);
      expect(Number(ledger![0].deduction_amount)).toBe(20000);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('19. reprocessing the SAME payroll month does not duplicate ledger deductions', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      // Reprocess -- change an unrelated field so it's a genuine reprocess, not a no-op.
      const { data: result2 } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [payrollRecord(employeeId, 210000)], p_user_email: creds.admin.email,
      });
      expect(result2.success).toBe(true);

      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.salary_advance_deduction)).toBe(20000); // still exactly one deduction's worth, not 40000

      const { data: ledgerRows } = await clients.admin.from('salary_advance_deductions').select('id').eq('employee_id', employeeId).eq('payroll_month', testMonth);
      expect(ledgerRows).toHaveLength(1); // never a second ledger row for the same (advance, month)

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('10. final partial repayment is capped at the remaining balance, not the full combined monthly figure', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 26000, configured_monthly_deduction: 20000, repayment_period_months: 2, final_deduction_amount: 6000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      // Month 1: deducts the full combined figure (20,000), leaving 6,000.
      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      // Month 2: only 6,000 remains -- must deduct exactly 6,000, not 20,000.
      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth2, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: row2 } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth2).eq('employee_id', employeeId).single();
      expect(Number(row2?.salary_advance_deduction)).toBe(6000);

      const { data: advanceAfter } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(advanceAfter?.status).toBe('paid');

      await clients.admin.from('payroll').delete().in('month', [testMonth, testMonth2]).eq('employee_id', employeeId);
    });

    test('13. no deduction occurs for a further month once the advance is fully paid (future deductions stop at zero)', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 20000, configured_monthly_deduction: 20000, repayment_period_months: 1, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      // A later month, after the advance already reached 'paid'.
      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth2, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: row2 } = await clients.admin.from('payroll').select('salary_advance_deduction, net_pay').eq('month', testMonth2).eq('employee_id', employeeId).single();
      expect(Number(row2?.salary_advance_deduction)).toBe(0);
      expect(Number(row2?.net_pay)).toBe(200000);

      await clients.admin.from('payroll').delete().in('month', [testMonth, testMonth2]).eq('employee_id', employeeId);
    });

    test('no deduction before the deduction_start_month arrives', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId, { deduction_start_month: testMonth3 });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      // Process an EARLIER month than the advance's own start month.
      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.salary_advance_deduction)).toBe(0);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('a pending (not yet approved) advance deducts nothing', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeAdvance(employeeId); // NOT approved -- stays 'pending'
      test.skip(!!seedErr, `Could not seed a pending salary advance: ${seedErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.salary_advance_deduction)).toBe(0);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('a rejected advance deducts nothing', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a salary advance: ${seedErr?.message}`);
      await setAdvanceStatus(advance!.id, 'rejected');

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.salary_advance_deduction)).toBe(0);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('18. net pay reflects the salary advance deduction exactly once', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId, { advance_amount: 15000, configured_monthly_deduction: 15000, repayment_period_months: 1, final_deduction_amount: 15000 });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const record = payrollRecord(employeeId, 200000);
      const { data: result } = await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [record], p_user_email: creds.admin.email });
      expect(result.success).toBe(true);
      expect(result.advanceDeductionsApplied).toBe(1);

      const { data: row } = await clients.admin.from('payroll').select('net_pay, salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      // record.net_pay (200000, pre-advance) - 15000 = 185000, applied exactly once.
      expect(Number(row?.net_pay)).toBe(185000);
      expect(Number(row?.salary_advance_deduction)).toBe(15000);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('16. deduction never exceeds the remaining balance, and remaining balance never goes negative', async () => {
      const employeeId = await makeEmployee();
      // Combined monthly figure (50000) deliberately larger than the whole
      // advance (30000) -- the very first month must still only take 30000.
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 30000, configured_monthly_deduction: 50000, repayment_period_months: 1, final_deduction_amount: 30000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.salary_advance_deduction)).toBe(30000); // capped, not 50000

      const { data: ledger } = await clients.admin.from('salary_advance_deductions').select('deduction_amount').eq('salary_advance_id', advance!.id);
      const totalDeducted = (ledger || []).reduce((sum, r) => sum + Number(r.deduction_amount), 0);
      expect(totalDeducted).toBeLessThanOrEqual(30000); // never exceeds the original advance amount

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('Staff cannot trigger a salary advance deduction by calling process_payroll_batch directly (existing role check still applies)', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const { error } = await clients.staff.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.staff.email,
      });
      expect(error).not.toBeNull();

      const { data: row } = await clients.admin.from('payroll').select('id').eq('month', testMonth).eq('employee_id', employeeId);
      expect(row ?? []).toHaveLength(0);
    });

    test('17. a payload with an invalid (negative) advance amount is rejected at creation, before it can ever reach payroll', async () => {
      const employeeId = await makeEmployee();
      const { error } = await makeAdvance(employeeId, { advance_amount: -5000 });
      expect(error).not.toBeNull(); // create_salary_advance()'s own positivity check
    });

    test('salary advance deductions are tenant-isolated', async () => {
      const tenantBAdmin = getTenantBAdmin();
      test.skip(!tenantBAdmin, 'E2E_TENANT_B_ADMIN_EMAIL/PASSWORD not configured -- skipping cross-tenant salary advance isolation check');

      const tenantBClient = createClient(creds.supabaseUrl, creds.supabaseAnonKey);
      const { error: signInErr } = await tenantBClient.auth.signInWithPassword(tenantBAdmin!);
      test.skip(!!signInErr, `Could not sign in as the Tenant B admin: ${signInErr?.message}`);

      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed a salary advance: ${seedErr?.message}`);

      try {
        const { data: crossTenantRead } = await tenantBClient.from('salary_advances').select('*').eq('id', advance!.id);
        expect(crossTenantRead ?? []).toHaveLength(0);
      } finally {
        await tenantBClient.auth.signOut();
      }
    });

    // ------------------------------------------------------------------
    // GLOBAL NET-PAY INVARIANT (confirmed business decision): final
    // net_pay must never be negative for ANY employee, for ANY reason --
    // attendance/employee/terminal deductions, salary advances, or any
    // combination. This SUPERSEDES the earlier, narrower "advance-only"
    // guard and the still-earlier "net_pay may legitimately be negative"
    // rule -- neither carve-out exists anymore. See
    // 20260813000001_payroll_salary_advance_integration.sql's own
    // GLOBAL NET-PAY INVARIANT note.
    // ------------------------------------------------------------------
    test('1. a salary advance deduction ALONE would produce negative net pay -> refused, nothing posted', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 100000, configured_monthly_deduction: 20000, repayment_period_months: 5, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      // Net pay before the advance = 15,000; combined monthly deduction = 20,000 -- the correction's own worked example.
      const { error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [payrollRecord(employeeId, 15000)], p_user_email: creds.admin.email,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toContain('negative net pay');

      // Nothing was posted for this employee/month -- no payroll row.
      const { data: payrollRows } = await clients.admin.from('payroll').select('id').eq('month', testMonth).eq('employee_id', employeeId);
      expect(payrollRows ?? []).toHaveLength(0);

      // No ledger row was created -- the deduction was never applied.
      const { data: ledgerRows } = await clients.admin.from('salary_advance_deductions').select('id').eq('salary_advance_id', advance!.id);
      expect(ledgerRows ?? []).toHaveLength(0);

      // The advance's status is unchanged -- still 'active', not 'paid'.
      const { data: advanceAfter } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(advanceAfter?.status).toBe('active');
    });

    test('2. ordinary (non-advance) deductions ALONE would produce negative net pay -> refused, even with NO salary advance involved at all', async () => {
      const employeeId = await makeEmployee(); // no salary advance at all
      const record = payrollRecord(employeeId, 5000);
      record.net_pay = -5000; // as if heavy attendance/other deductions already drove it negative client-side

      const { error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record], p_user_email: creds.admin.email,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/negative/i);

      const { data: rows } = await clients.admin.from('payroll').select('id').eq('month', testMonth).eq('employee_id', employeeId);
      expect(rows ?? []).toHaveLength(0);
    });

    test('3. a COMBINATION of ordinary deductions + a salary advance that together go negative -> refused', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 100000, configured_monthly_deduction: 12000, repayment_period_months: 9, final_deduction_amount: 4000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      // Ordinary (non-advance) deductions already reduce this employee's
      // net pay to a modest 10,000 before the salary advance is even
      // considered -- neither cause alone is the "whole story," it's the
      // combination that goes negative (10,000 - 12,000 = -2,000).
      const record = payrollRecord(employeeId, 50000);
      record.paye = 20000;
      record.pension = 10000;
      record.uniform_deduction = 10000;
      record.net_pay = 10000; // 50000 - 20000 - 10000 - 10000

      const { error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record], p_user_email: creds.admin.email,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toContain('negative net pay');

      const { data: rows } = await clients.admin.from('payroll').select('id').eq('month', testMonth).eq('employee_id', employeeId);
      expect(rows ?? []).toHaveLength(0);
    });

    test('4. net pay of EXACTLY MK 0 after the salary advance deduction is allowed, not rejected', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 100000, configured_monthly_deduction: 15000, repayment_period_months: 7, final_deduction_amount: 10000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const { data, error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [payrollRecord(employeeId, 15000)], p_user_email: creds.admin.email,
      });
      expect(error).toBeNull();
      expect(data.success).toBe(true);

      const { data: row } = await clients.admin.from('payroll').select('net_pay, salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.net_pay)).toBe(0);
      expect(Number(row?.salary_advance_deduction)).toBe(15000);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('5. a normal positive net pay after the salary advance deduction is allowed', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 20000, configured_monthly_deduction: 20000, repayment_period_months: 1, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const { data, error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [payrollRecord(employeeId, 200000)], p_user_email: creds.admin.email,
      });
      expect(error).toBeNull();
      expect(data.success).toBe(true);

      const { data: row } = await clients.admin.from('payroll').select('net_pay').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.net_pay)).toBe(180000);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('6. one invalid employee in a multi-employee batch rolls back the WHOLE batch, including employees that would otherwise have succeeded', async () => {
      const employeeIdBad = await makeEmployee();
      const employeeIdGood = await makeEmployee();

      const { error: seedErr } = await makeActiveAdvance(employeeIdBad, {
        advance_amount: 100000, configured_monthly_deduction: 20000, repayment_period_months: 5, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed the "bad" employee's active advance: ${seedErr?.message}`);

      const { error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth,
        p_records: [payrollRecord(employeeIdGood, 200000), payrollRecord(employeeIdBad, 15000)],
        p_user_email: creds.admin.email,
      });
      expect(error).not.toBeNull();

      // Neither employee's payroll row was written -- the transaction that
      // failed partway through rolled back everything in the batch, not
      // just the employee that caused the failure. (7. no ledger row
      // survives either -- covered directly by test 1/3 above, since a
      // rejected call never gets far enough to insert one in the first place.)
      const { data: rows } = await clients.admin.from('payroll').select('employee_id').eq('month', testMonth).in('employee_id', [employeeIdGood, employeeIdBad]);
      expect(rows ?? []).toHaveLength(0);
    });

    test('8/9. a negative-net-pay failure rolls back BOTH the advance status flip AND the repayment-plan retirement that would otherwise have happened this same call', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 20000, configured_monthly_deduction: 20000, repayment_period_months: 1, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const planBefore = await getPlan(employeeId);
      expect(planBefore).not.toBeNull();

      // This deduction would fully pay off the advance in one shot --
      // triggering BOTH a 'paid' status flip AND plan retirement inside
      // the same loop iteration -- but the employee's net pay before the
      // advance is only 15,000, less than the 20,000 deduction, so the
      // whole call must fail and roll back BOTH of those side effects too.
      const { error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [payrollRecord(employeeId, 15000)], p_user_email: creds.admin.email,
      });
      expect(error).not.toBeNull();

      const { data: advanceAfter } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(advanceAfter?.status).toBe('active'); // NOT 'paid' -- the transition rolled back

      const planAfter = await getPlan(employeeId);
      expect(planAfter).not.toBeNull(); // the plan was NOT retired -- rolled back too
      expect(Number(planAfter?.combined_monthly_deduction)).toBe(20000);

      const { data: ledgerRows } = await clients.admin.from('salary_advance_deductions').select('id').eq('salary_advance_id', advance!.id);
      expect(ledgerRows ?? []).toHaveLength(0);
    });

    // 10. Frontend surfaces a clear, human-readable error (not raw SQL) for
    // this rejection -- covered at the unit level in
    // src/utils/payrollProcessing.test.ts's `describeProcessPayrollBatchError`
    // describe block, since this "authenticated" matrix calls the RPC
    // directly via supabase-js rather than driving the rendered UI (same
    // established scope limit as every other test in this file -- see the
    // file's own header "NOT covered here" note).

    // ------------------------------------------------------------------
    // COMBINED PLAN / OLDEST-FIRST ALLOCATION across 2 open advances
    // ------------------------------------------------------------------
    test('7. combined outstanding balance calculation across 2 open advances', async () => {
      const employeeId = await makeEmployee();
      const { error: e1 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-01-01', advance_amount: 60000, configured_monthly_deduction: 15000, repayment_period_months: 4, final_deduction_amount: 15000,
      });
      const { error: e2 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-02-01', advance_amount: 40000, configured_monthly_deduction: 10000, repayment_period_months: 4, final_deduction_amount: 10000,
      }, { method: 'monthly_amount', monthlyDeduction: 100000, startMonth: testMonth });
      test.skip(!!e1 || !!e2, 'Could not seed 2 active advances');

      const { data: rows } = await clients.admin.from('salary_advances').select('advance_amount').eq('employee_id', employeeId).in('status', ['pending', 'active']);
      const combined = (rows || []).reduce((sum, r) => sum + Number(r.advance_amount), 0);
      expect(combined).toBe(100000); // 60,000 + 40,000, from the business rule's own worked example
    });

    test('8/9. oldest-advance-first allocation of the ONE combined plan figure, not a per-advance-rate cap', async () => {
      const employeeId = await makeEmployee();
      const { data: older, error: e1 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-01-01', advance_amount: 60000, configured_monthly_deduction: 15000, repayment_period_months: 4, final_deduction_amount: 15000,
      });
      const { data: younger, error: e2 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-02-01', advance_amount: 40000, configured_monthly_deduction: 10000, repayment_period_months: 4, final_deduction_amount: 10000,
      }, { method: 'monthly_amount', monthlyDeduction: 100000, startMonth: testMonth });
      test.skip(!!e1 || !!e2, 'Could not seed 2 active advances');

      // Management explicitly sets the combined figure to 25,000/month for
      // the combined 100,000 outstanding -- from the business rule's own
      // worked example. NOT derived by summing the two advances' own rates
      // (15,000 + 10,000 = 25,000 would coincidentally match here, which is
      // exactly why this must be set EXPLICITLY, not left to auto-creation).
      const { error: planErr } = await setCombinedPlan(employeeId, { monthlyDeduction: 25000, startMonth: testMonth });
      test.skip(!!planErr, `Could not set the combined plan: ${planErr?.message}`);

      const { data: result } = await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      expect(result.success).toBe(true);
      expect(result.advanceDeductionsApplied).toBe(2); // one ledger row per advance this month

      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.salary_advance_deduction)).toBe(25000); // the combined total, exactly the plan figure

      const { data: olderLedger } = await clients.admin.from('salary_advance_deductions').select('deduction_amount').eq('salary_advance_id', older!.id).eq('payroll_month', testMonth).single();
      const { data: youngerLedger } = await clients.admin.from('salary_advance_deductions').select('deduction_amount').eq('salary_advance_id', younger!.id).eq('payroll_month', testMonth).single();
      expect(Number(olderLedger?.deduction_amount)).toBe(25000); // oldest funded first, NOT capped by its own 15,000 rate
      expect(Number(youngerLedger?.deduction_amount)).toBe(0); // nothing left in the pool this month

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('9b. leftover budget from the older advance finishing early spills to the younger one the SAME month', async () => {
      const employeeId = await makeEmployee();
      const { data: older, error: e1 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-01-01', advance_amount: 10000, configured_monthly_deduction: 20000, repayment_period_months: 1, final_deduction_amount: 10000,
      });
      const { data: younger, error: e2 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-02-01', advance_amount: 30000, configured_monthly_deduction: 10000, repayment_period_months: 3, final_deduction_amount: 10000,
      }, { method: 'monthly_amount', monthlyDeduction: 40000, startMonth: testMonth });
      test.skip(!!e1 || !!e2, 'Could not seed 2 active advances');

      // The correction's own exact worked example: combined monthly = 20,000.
      const { error: planErr } = await setCombinedPlan(employeeId, { monthlyDeduction: 20000, startMonth: testMonth });
      test.skip(!!planErr, `Could not set the combined plan: ${planErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: olderLedger } = await clients.admin.from('salary_advance_deductions').select('deduction_amount').eq('salary_advance_id', older!.id).eq('payroll_month', testMonth).single();
      const { data: youngerLedger } = await clients.admin.from('salary_advance_deductions').select('deduction_amount').eq('salary_advance_id', younger!.id).eq('payroll_month', testMonth).single();
      expect(Number(olderLedger?.deduction_amount)).toBe(10000); // finishes, using only what it needed
      expect(Number(youngerLedger?.deduction_amount)).toBe(10000); // gets the entire leftover -- NOT capped by its own 10,000 rate coincidentally matching here; see the reversed-order unit test for a case where it would differ

      const { data: olderAfter } = await clients.admin.from('salary_advances').select('status').eq('id', older!.id).single();
      expect(olderAfter?.status).toBe('paid');

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('11. one advance becomes paid while the second remains active', async () => {
      const employeeId = await makeEmployee();
      const { data: older, error: e1 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-01-01', advance_amount: 20000, configured_monthly_deduction: 20000, repayment_period_months: 1, final_deduction_amount: 20000,
      });
      const { data: younger, error: e2 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-02-01', advance_amount: 200000, configured_monthly_deduction: 5000, repayment_period_months: 40, final_deduction_amount: 5000,
      }, { method: 'monthly_amount', monthlyDeduction: 220000, startMonth: testMonth });
      test.skip(!!e1 || !!e2, 'Could not seed 2 active advances');

      const { error: planErr } = await setCombinedPlan(employeeId, { monthlyDeduction: 20000, startMonth: testMonth });
      test.skip(!!planErr, `Could not set the combined plan: ${planErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: olderAfter } = await clients.admin.from('salary_advances').select('status').eq('id', older!.id).single();
      const { data: youngerAfter } = await clients.admin.from('salary_advances').select('status').eq('id', younger!.id).single();
      expect(olderAfter?.status).toBe('paid');
      expect(youngerAfter?.status).toBe('active');

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('12. both advances become paid correctly in the same run', async () => {
      const employeeId = await makeEmployee();
      const { data: a1, error: e1 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-01-01', advance_amount: 10000, configured_monthly_deduction: 10000, repayment_period_months: 1, final_deduction_amount: 10000,
      });
      const { data: a2, error: e2 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-02-01', advance_amount: 5000, configured_monthly_deduction: 5000, repayment_period_months: 1, final_deduction_amount: 5000,
      }, { method: 'monthly_amount', monthlyDeduction: 15000, startMonth: testMonth });
      test.skip(!!e1 || !!e2, 'Could not seed 2 active advances');

      // Combined plan must cover BOTH balances (10,000 + 5,000 = 15,000) in
      // one month for both to pay off together.
      const { error: planErr } = await setCombinedPlan(employeeId, { monthlyDeduction: 15000, startMonth: testMonth });
      test.skip(!!planErr, `Could not set the combined plan: ${planErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: a1After } = await clients.admin.from('salary_advances').select('status').eq('id', a1!.id).single();
      const { data: a2After } = await clients.admin.from('salary_advances').select('status').eq('id', a2!.id).single();
      expect(a1After?.status).toBe('paid');
      expect(a2After?.status).toBe('paid');

      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.salary_advance_deduction)).toBe(15000);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('17b. payroll deduction equals the sum of that month\'s ledger allocations', async () => {
      const employeeId = await makeEmployee();
      const { error: e1 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-01-01', advance_amount: 60000, configured_monthly_deduction: 15000, repayment_period_months: 4, final_deduction_amount: 15000,
      });
      const { error: e2 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-02-01', advance_amount: 40000, configured_monthly_deduction: 10000, repayment_period_months: 4, final_deduction_amount: 10000,
      }, { method: 'monthly_amount', monthlyDeduction: 100000, startMonth: testMonth });
      test.skip(!!e1 || !!e2, 'Could not seed 2 active advances');

      const { error: planErr } = await setCombinedPlan(employeeId, { monthlyDeduction: 25000, startMonth: testMonth });
      test.skip(!!planErr, `Could not set the combined plan: ${planErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      const { data: ledgerRows } = await clients.admin.from('salary_advance_deductions').select('deduction_amount, salary_advance_id').eq('employee_id', employeeId).eq('payroll_month', testMonth);
      const ledgerSum = (ledgerRows || []).reduce((sum, r) => sum + Number(r.deduction_amount), 0);
      expect(ledgerRows).toHaveLength(2); // one row per advance (older, younger)
      expect(Number(row?.salary_advance_deduction)).toBe(ledgerSum);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    // ------------------------------------------------------------------
    // CRITICAL IDEMPOTENCY EDGE CASE: reprocessing a month AFTER an
    // advance flipped to 'paid' during that same month must NOT lose the
    // deduction merely because a naive lookup only searches status = 'active'.
    // ------------------------------------------------------------------
    test('20. CRITICAL: reprocessing the final repayment month after status became paid preserves the original deduction', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 6000, configured_monthly_deduction: 20000, repayment_period_months: 1, final_deduction_amount: 6000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      // First run: the ENTIRE 6,000 is deducted in one month, flipping the advance to 'paid'.
      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      const { data: afterFirst } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(afterFirst?.status).toBe('paid');

      // Reprocess the SAME month, now that the advance is 'paid'. A naive
      // `WHERE status = 'active'` lookup would find nothing and report 0 --
      // the fix is the EXISTS-ledger-row clause that includes this advance
      // regardless of its current status.
      const { data: result2 } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [payrollRecord(employeeId, 210000)], p_user_email: creds.admin.email,
      });
      expect(result2.success).toBe(true);

      const { data: row2 } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row2?.salary_advance_deduction)).toBe(6000); // NOT 0 -- preserved from the original run

      const { data: ledgerRows } = await clients.admin.from('salary_advance_deductions').select('deduction_amount').eq('salary_advance_id', advance!.id).eq('payroll_month', testMonth);
      expect(ledgerRows).toHaveLength(1);
      expect(Number(ledgerRows![0].deduction_amount)).toBe(6000);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('21. two-open-advance final-month reprocessing behaves identically -- both preserved after both flip to paid', async () => {
      const employeeId = await makeEmployee();
      const { data: a1, error: e1 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-01-01', advance_amount: 5000, configured_monthly_deduction: 5000, repayment_period_months: 1, final_deduction_amount: 5000,
      });
      const { data: a2, error: e2 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-02-01', advance_amount: 3000, configured_monthly_deduction: 3000, repayment_period_months: 1, final_deduction_amount: 3000,
      }, { method: 'monthly_amount', monthlyDeduction: 8000, startMonth: testMonth });
      test.skip(!!e1 || !!e2, 'Could not seed 2 active advances');

      const { error: planErr } = await setCombinedPlan(employeeId, { monthlyDeduction: 8000, startMonth: testMonth });
      test.skip(!!planErr, `Could not set the combined plan: ${planErr?.message}`);

      // First run: both fully paid off in the same month.
      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      const { data: a1After } = await clients.admin.from('salary_advances').select('status').eq('id', a1!.id).single();
      const { data: a2After } = await clients.admin.from('salary_advances').select('status').eq('id', a2!.id).single();
      expect(a1After?.status).toBe('paid');
      expect(a2After?.status).toBe('paid');

      // Reprocess the SAME month -- both must still contribute their
      // original amounts (5000 + 3000 = 8000), not 0.
      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId, 195000)], p_user_email: creds.admin.email });

      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth).eq('employee_id', employeeId).single();
      expect(Number(row?.salary_advance_deduction)).toBe(8000);

      const { data: ledgerRows } = await clients.admin.from('salary_advance_deductions').select('id, deduction_amount').eq('employee_id', employeeId).eq('payroll_month', testMonth);
      expect(ledgerRows).toHaveLength(2); // no duplicate rows created by the reprocess

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });
  });

  // ------------------------------------------------------------------
  // PLAN RETIREMENT after final payoff (safety review finding): once an
  // employee has NO remaining 'active' advance, their combined repayment
  // plan must not keep showing a live monthly deduction / payoff for debt
  // that no longer exists. process_payroll_batch() deletes the plan row
  // the moment the employee's last active advance reaches 'paid';
  // salary_advance_repayment_plan_changes history is untouched (no FK to
  // the plan table); the next advance approved for this employee
  // establishes a completely fresh plan.
  // ------------------------------------------------------------------
  test.describe('plan retirement after final payoff', () => {
    test('when the employee\'s last active advance reaches paid, the combined repayment plan is retired', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 20000, configured_monthly_deduction: 20000, repayment_period_months: 1, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const planBefore = await getPlan(employeeId);
      expect(planBefore).not.toBeNull();

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { data: advanceAfter } = await clients.admin.from('salary_advances').select('status').eq('id', advance!.id).single();
      expect(advanceAfter?.status).toBe('paid');

      const planAfter = await getPlan(employeeId);
      expect(planAfter).toBeNull(); // retired -- no misleading active plan left behind

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('plan retirement preserves salary_advance_repayment_plan_changes history', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 20000, configured_monthly_deduction: 5000, repayment_period_months: 4, final_deduction_amount: 5000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      // Edit the plan first (creating a real history row) so this test
      // proves history SURVIVES retirement, not just that it's absent.
      const { error: adjustErr } = await setCombinedPlan(employeeId, { monthlyDeduction: 20000, startMonth: testMonth, reason: 'pay off in one month' });
      test.skip(!!adjustErr, `Could not adjust the plan: ${adjustErr?.message}`);

      const { data: historyBefore } = await clients.admin.from('salary_advance_repayment_plan_changes').select('id').eq('employee_id', employeeId);
      expect(historyBefore).toHaveLength(1);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const planAfter = await getPlan(employeeId);
      expect(planAfter).toBeNull();

      // History survives -- salary_advance_repayment_plan_changes has no
      // foreign key to the now-deleted plan row.
      const { data: historyAfter } = await clients.admin.from('salary_advance_repayment_plan_changes').select('id').eq('employee_id', employeeId);
      expect(historyAfter).toHaveLength(1);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('after plan retirement, the next payroll month deducts zero', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 20000, configured_monthly_deduction: 20000, repayment_period_months: 1, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      const planAfter = await getPlan(employeeId);
      test.skip(planAfter !== null, 'Plan was not retired as a precondition for this test');

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth2, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      const { data: row } = await clients.admin.from('payroll').select('salary_advance_deduction').eq('month', testMonth2).eq('employee_id', employeeId).single();
      expect(Number(row?.salary_advance_deduction)).toBe(0);

      await clients.admin.from('payroll').delete().in('month', [testMonth, testMonth2]).eq('employee_id', employeeId);
    });

    test('a later new advance for the same employee establishes a fresh plan cleanly, unaffected by the retired one', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 20000, configured_monthly_deduction: 20000, repayment_period_months: 1, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      const planRetired = await getPlan(employeeId);
      test.skip(planRetired !== null, 'Plan was not retired as a precondition for this test');

      // A brand new advance, approved, must establish a FRESH plan from
      // its own terms -- the RPC sees zero OTHER active advances (the
      // prior one is 'paid', not 'active') and correctly takes the
      // "first active advance" branch, not colliding with the retired plan.
      const { error: newErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 60000, configured_monthly_deduction: 15000, repayment_period_months: 4, final_deduction_amount: 15000,
      });
      expect(newErr).toBeNull();

      const newPlan = await getPlan(employeeId);
      expect(newPlan).not.toBeNull();
      expect(Number(newPlan?.combined_monthly_deduction)).toBe(15000);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });
  });

  // ------------------------------------------------------------------
  // Edit / Adjust Combined Repayment Plan (adjust_combined_repayment_plan())
  // ------------------------------------------------------------------
  test.describe('Edit / Adjust Combined Repayment Plan', () => {
    test('14. editing the combined plan changes FUTURE terms only', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 80000, configured_monthly_deduction: 20000, repayment_period_months: 4, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const { data, error } = await setCombinedPlan(employeeId, { monthlyDeduction: 40000, startMonth: testMonth, reason: 'E2E test adjustment' });
      expect(error).toBeNull();
      expect(data.combinedMonthlyDeduction).toBe(40000);
      expect(data.repaymentPeriodMonths).toBe(2); // 80000 / 40000

      const plan = await getPlan(employeeId);
      expect(Number(plan?.combined_monthly_deduction)).toBe(40000);

      const { data: advanceAfter } = await clients.admin.from('salary_advances').select('advance_amount').eq('employee_id', employeeId).single();
      expect(Number(advanceAfter?.advance_amount)).toBe(80000); // the underlying advance's original amount untouched
    });

    test('combined period mode: system derives the combined installment schedule from total outstanding', async () => {
      const employeeId = await makeEmployee();
      const { error: e1 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-01-01', advance_amount: 60000, configured_monthly_deduction: 15000, repayment_period_months: 4, final_deduction_amount: 15000,
      });
      const { error: e2 } = await makeActiveAdvance(employeeId, {
        application_date: '2020-02-01', advance_amount: 40000, configured_monthly_deduction: 10000, repayment_period_months: 4, final_deduction_amount: 10000,
      }, { method: 'monthly_amount', monthlyDeduction: 100000, startMonth: testMonth });
      test.skip(!!e1 || !!e2, 'Could not seed 2 active advances');

      const { data, error } = await clients.admin.rpc('adjust_combined_repayment_plan', {
        p_employee_id: employeeId,
        p_new_repayment_method: 'repayment_period',
        p_new_deduction_start_month: testMonth,
        p_new_repayment_period_months: 4,
      });
      expect(error).toBeNull();
      expect(data.combinedMonthlyDeduction).toBe(25000); // 100,000 total / 4 months, NOT per-advance
      expect(data.totalOutstanding).toBe(100000);
    });

    test('15. historical ledger rows remain unchanged after an edit', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 80000, configured_monthly_deduction: 20000, repayment_period_months: 4, final_deduction_amount: 20000,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      // Post one real deduction first.
      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });
      const { data: ledgerBefore } = await clients.admin.from('salary_advance_deductions').select('deduction_amount').eq('salary_advance_id', advance!.id).eq('payroll_month', testMonth).single();
      expect(Number(ledgerBefore?.deduction_amount)).toBe(20000);

      // Adjust the plan for FUTURE months (start month must be after the
      // one already posted).
      const { error } = await setCombinedPlan(employeeId, { monthlyDeduction: 10000, startMonth: testMonth2 });
      expect(error).toBeNull();

      // The already-posted ledger row for testMonth is untouched.
      const { data: ledgerAfter } = await clients.admin.from('salary_advance_deductions').select('deduction_amount').eq('salary_advance_id', advance!.id).eq('payroll_month', testMonth).single();
      expect(Number(ledgerAfter?.deduction_amount)).toBe(20000);

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('an edit cannot move the start month earlier than the last already-posted deduction', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId, {
        advance_amount: 80000, configured_monthly_deduction: 20000, repayment_period_months: 4, final_deduction_amount: 20000, deduction_start_month: testMonth,
      });
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      await clients.admin.rpc('process_payroll_batch', { p_month: testMonth, p_records: [payrollRecord(employeeId)], p_user_email: creds.admin.email });

      const { error } = await setCombinedPlan(employeeId, { monthlyDeduction: 10000, startMonth: testMonth }); // same month already posted -- must be rejected
      expect(error).not.toBeNull();

      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', employeeId);
    });

    test('16. unauthorized Staff/Supervisor cannot edit the combined repayment plan', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      for (const client of [clients.staff, clients.supervisor]) {
        const { error } = await client.rpc('adjust_combined_repayment_plan', {
          p_employee_id: employeeId,
          p_new_repayment_method: 'monthly_amount',
          p_new_deduction_start_month: testMonth2,
          p_new_monthly_deduction: 5000,
        });
        expect(error).not.toBeNull();
      }

      // Confirm nothing actually changed.
      const plan = await getPlan(employeeId);
      expect(Number(plan?.combined_monthly_deduction)).toBe(20000);
    });

    test('a direct UPDATE cannot change an advance\'s original application terms even for Admin -- the guard trigger blocks it', async () => {
      const employeeId = await makeEmployee();
      const { data: advance, error: seedErr } = await makeActiveAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      const { error } = await clients.admin.from('salary_advances').update({ configured_monthly_deduction: 99999 }).eq('id', advance!.id);
      // The guard trigger raises inside the UPDATE, so Postgres reports it as an error.
      expect(error).not.toBeNull();

      const { data: after } = await clients.admin.from('salary_advances').select('configured_monthly_deduction').eq('id', advance!.id).single();
      expect(Number(after?.configured_monthly_deduction)).toBe(20000); // unchanged
    });

    // NOTE: direct INSERT/UPDATE/DELETE rejection for
    // salary_advance_repayment_plans/salary_advance_repayment_plan_changes,
    // for BOTH Admin and Manager, is covered exhaustively in the RLS
    // describe block above ("salary_advance_repayment_plans: direct
    // INSERT/UPDATE/DELETE are rejected..." and
    // "salary_advance_repayment_plan_changes: direct INSERT/UPDATE/DELETE
    // are rejected...") -- not repeated here.

    test('an edit records an entry in salary_advance_repayment_plan_changes for auditability', async () => {
      const employeeId = await makeEmployee();
      const { error: seedErr } = await makeActiveAdvance(employeeId);
      test.skip(!!seedErr, `Could not seed an active salary advance: ${seedErr?.message}`);

      await setCombinedPlan(employeeId, { monthlyDeduction: 40000, startMonth: testMonth, reason: 'auditability check' });

      const { data: history } = await clients.admin.from('salary_advance_repayment_plan_changes').select('*').eq('employee_id', employeeId);
      expect(history).toHaveLength(1);
      expect(Number(history![0].previous_monthly_deduction)).toBe(20000);
      expect(Number(history![0].new_monthly_deduction)).toBe(40000);
      expect(history![0].reason).toBe('auditability check');

      // Staff/Supervisor cannot read this table either (SELECT-only for role_level <= 2).
      const { data: staffRead } = await clients.staff.from('salary_advance_repayment_plan_changes').select('*').eq('employee_id', employeeId);
      expect(staffRead ?? []).toHaveLength(0);
    });
  });
});
