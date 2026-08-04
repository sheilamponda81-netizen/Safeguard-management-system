import { test, expect } from '@playwright/test';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { missingStagingVars, getStagingCredentials, StagingCredentials } from '../fixtures';

// Integration coverage for the workflows this audit pass's instructions
// specifically called out: employee/guard ID generation + duplicate
// prevention, payroll processing/reprocessing/approval-immutability/
// partial-failure-rollback via the new atomic RPC, terminal-dues
// persistence, payment/recruitment status transitions, failed-operation
// handling, and permission-denied responses. Like
// rls-policy-matrix.spec.ts, every test here is SKIPPED (not silently
// passed, not hard-failed) unless a real staging Supabase project and 4
// seeded role accounts are configured -- see e2e/fixtures.ts for the
// exact env vars needed to activate this file.
//
// Run against staging with:
//   E2E_BASE_URL=... E2E_SUPABASE_URL=... E2E_SUPABASE_ANON_KEY=... \
//   E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... (+ manager/supervisor/staff) \
//   npx playwright test rpc-workflow-matrix
//
// NOT covered by this file: true cross-tenant separation for guard-ID/
// employee-number generation (proving two DIFFERENT tenants' counters
// are independent). That needs a second tenant/company seeded in the
// same staging project with its own set of credentials, which
// e2e/fixtures.ts does not currently provision (it's one tenant's worth
// of 4 role accounts). Each generation migration's own "STAGING TEST
// PROCEDURE" comment includes the exact manual SQL for this
// (authenticate as a user in each of two tenants, compare counters) --
// see 20260804000000_guard_id_generation.sql /
// 20260804000001_employee_number_generation.sql.

const missing = missingStagingVars();
const testMonth = '9999-11'; // far-future month, unlikely to collide with real seeded data

test.describe('RPC workflow matrix (generation, payroll atomicity, status transitions)', () => {
  test.skip(missing.length > 0, `Staging credentials not configured, skipping RPC workflow matrix. Missing: ${missing.join(', ')}`);

  let creds: StagingCredentials;
  let clients: Record<'admin' | 'manager' | 'supervisor' | 'staff', SupabaseClient>;
  let sampleRegionId: string;
  const createdEmployeeIds: string[] = [];

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

    const { data: regions, error: regionError } = await clients.admin.from('regions').select('id').limit(1);
    if (regionError || !regions?.length) throw new Error('Could not find a sample region in staging to test against');
    sampleRegionId = regions[0].id;
  });

  test.afterAll(async () => {
    // Clean up every disposable employee this file created, regardless
    // of which test created it or whether that test passed.
    if (createdEmployeeIds.length > 0) {
      await clients.admin.from('employees').delete().in('id', createdEmployeeIds);
    }
    for (const client of Object.values(clients)) {
      await client.auth.signOut();
    }
  });

  // ------------------------------------------------------------------
  // Employee number generation (20260804000001_employee_number_generation.sql)
  // ------------------------------------------------------------------
  test.describe('employee number generation', () => {
    test('generate_employee_number() returns a correctly formatted, incrementing number for a region', async () => {
      const { data: first, error: err1 } = await clients.admin.rpc('generate_employee_number', { p_region_id: sampleRegionId });
      expect(err1).toBeNull();
      expect(first).toMatch(/^SFG-[A-Z]-\d{3,}$/);

      const { data: second, error: err2 } = await clients.admin.rpc('generate_employee_number', { p_region_id: sampleRegionId });
      expect(err2).toBeNull();
      const firstNum = parseInt(first!.split('-').pop()!, 10);
      const secondNum = parseInt(second!.split('-').pop()!, 10);
      expect(secondNum).toBe(firstNum + 1);
    });

    test('10 simultaneous requests for the same region produce 10 distinct, consecutive numbers', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => clients.admin.rpc('generate_employee_number', { p_region_id: sampleRegionId }))
      );
      const values = results.map((r) => {
        expect(r.error).toBeNull();
        return parseInt(r.data!.split('-').pop()!, 10);
      });
      expect(new Set(values).size).toBe(10); // no duplicates
      expect(Math.max(...values) - Math.min(...values)).toBe(9); // no gaps
    });

    test('duplicate employee_number is rejected by the UNIQUE(tenant_id, employee_number) constraint', async () => {
      const { data: created, error: createErr } = await clients.admin
        .from('employees')
        .insert({ employee_number: `SFG-E2E-DUP-${Date.now()}`, full_name: 'E2E Duplicate Test', basic_salary: 0 })
        .select('id, employee_number')
        .single();
      test.skip(!!createErr, `Could not create the first disposable employee: ${createErr?.message}`);
      createdEmployeeIds.push(created!.id);

      const { error: dupErr } = await clients.admin
        .from('employees')
        .insert({ employee_number: created!.employee_number, full_name: 'E2E Duplicate Test 2', basic_salary: 0 });

      expect(dupErr).not.toBeNull();
      expect(dupErr?.code).toBe('23505');
    });
  });

  // ------------------------------------------------------------------
  // Guard ID generation (20260804000000_guard_id_generation.sql)
  // ------------------------------------------------------------------
  test.describe('guard ID generation', () => {
    test('generate_guard_id() returns a correctly formatted, incrementing, unique value', async () => {
      const { data: first, error: err1 } = await clients.admin.rpc('generate_guard_id');
      expect(err1).toBeNull();
      expect(first).toMatch(/^G-\d{4,}$/);

      const { data: second, error: err2 } = await clients.admin.rpc('generate_guard_id');
      expect(err2).toBeNull();
      expect(second).not.toBe(first);
      expect(parseInt(second!.slice(2), 10)).toBe(parseInt(first!.slice(2), 10) + 1);
    });

    test('10 simultaneous requests produce 10 distinct, consecutive numbers', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => clients.admin.rpc('generate_guard_id')));
      const values = results.map((r) => {
        expect(r.error).toBeNull();
        return parseInt(r.data!.slice(2), 10);
      });
      expect(new Set(values).size).toBe(10); // no duplicates
      expect(Math.max(...values) - Math.min(...values)).toBe(9); // no gaps
    });

    test('duplicate "guardId" is rejected by the UNIQUE(tenant_id, "guardId") constraint', async () => {
      const { data: guardId } = await clients.admin.rpc('generate_guard_id');
      const { data: created, error: createErr } = await clients.admin
        .from('employees')
        .insert({ employee_number: `SFG-E2E-GUARD-${Date.now()}`, full_name: 'E2E Guard Test', basic_salary: 0, guardId })
        .select('id')
        .single();
      test.skip(!!createErr, `Could not create the first disposable guard: ${createErr?.message}`);
      createdEmployeeIds.push(created!.id);

      const { error: dupErr } = await clients.admin
        .from('employees')
        .insert({ employee_number: `SFG-E2E-GUARD2-${Date.now()}`, full_name: 'E2E Guard Test 2', basic_salary: 0, guardId });

      expect(dupErr).not.toBeNull();
      expect(dupErr?.code).toBe('23505');
    });
  });

  // ------------------------------------------------------------------
  // Payroll atomicity (20260803000002_payroll_atomic_process_rpc.sql)
  // ------------------------------------------------------------------
  test.describe('process_payroll_batch atomicity', () => {
    let payrollEmployeeId: string;

    test.beforeAll(async () => {
      const { data: created, error } = await clients.admin
        .from('employees')
        .insert({ employee_number: `SFG-E2E-PAY-${Date.now()}`, full_name: 'E2E Payroll Test', basic_salary: 100000 })
        .select('id')
        .single();
      test.skip(!!error, `Could not create a disposable employee for payroll tests: ${error?.message}`);
      payrollEmployeeId = created!.id;
      createdEmployeeIds.push(payrollEmployeeId);
    });

    test.afterAll(async () => {
      await clients.admin.from('payroll').delete().eq('month', testMonth).eq('employee_id', payrollEmployeeId);
    });

    const record = (overrides: Partial<Record<string, unknown>> = {}) => ({
      employee_id: payrollEmployeeId,
      basic_salary: 100000, allowances: 0, overtime: 0, bonus: 0,
      gross_pay: 100000, paye: 15000, pension: 5000, uniform_deduction: 10000, net_pay: 70000,
      ...overrides,
    });

    test('processes a batch and returns success with insertedCount', async () => {
      const { data, error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record()], p_user_email: creds.admin.email,
      });
      expect(error).toBeNull();
      expect(data.success).toBe(true);
      expect(data.insertedCount).toBe(1);

      const { data: rows } = await clients.admin.from('payroll').select('*').eq('month', testMonth).eq('employee_id', payrollEmployeeId);
      expect(rows).toHaveLength(1);
      expect(rows![0].approval_status).toBe('pending');
    });

    test('reprocessing the same month is idempotent -- deletes the old row(s), inserts the new one, no duplicates', async () => {
      const { data, error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record({ bonus: 5000, gross_pay: 105000, net_pay: 75000 })], p_user_email: creds.admin.email,
      });
      expect(error).toBeNull();
      expect(data.success).toBe(true);
      expect(data.deletedCount).toBe(1);
      expect(data.insertedCount).toBe(1);

      const { data: rows } = await clients.admin.from('payroll').select('*').eq('month', testMonth).eq('employee_id', payrollEmployeeId);
      expect(rows).toHaveLength(1);
      expect(rows![0].bonus).toBe(5000);
    });

    test('an approved month cannot be silently reprocessed back to pending', async () => {
      await clients.admin.from('payroll').update({ approval_status: 'approved', approved_by: null, approved_at: new Date().toISOString() })
        .eq('month', testMonth).eq('employee_id', payrollEmployeeId);

      const { error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record()], p_user_email: creds.admin.email,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/already have approved payroll/i);

      const { data: rows } = await clients.admin.from('payroll').select('approval_status').eq('month', testMonth).eq('employee_id', payrollEmployeeId);
      expect(rows![0].approval_status).toBe('approved'); // unchanged -- proves the rejection was real, not just an error with a silent partial write

      // Reset back to pending so afterAll's cleanup and any later run of
      // this suite (or the two tests above, if re-run) aren't blocked by
      // this test's own approval.
      await clients.admin.from('payroll').update({ approval_status: 'pending', approved_by: null, approved_at: null }).eq('month', testMonth).eq('employee_id', payrollEmployeeId);
    });

    test('a bad row aborts the ENTIRE batch -- no partial insert', async () => {
      const { data: before } = await clients.admin.from('payroll').select('id').eq('month', testMonth).eq('employee_id', payrollEmployeeId);
      const countBefore = before?.length ?? 0;

      const { error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth,
        p_records: [record(), { employee_id: 'not-a-real-uuid', basic_salary: 'garbage' }],
        p_user_email: creds.admin.email,
      });
      expect(error).not.toBeNull();

      // The good record in the same batch must NOT have been inserted --
      // proves the DELETE+INSERT rolled back together, not partially.
      const { data: after } = await clients.admin.from('payroll').select('id').eq('month', testMonth).eq('employee_id', payrollEmployeeId);
      expect(after?.length ?? 0).toBe(countBefore);
    });

    test('Staff cannot call process_payroll_batch at all', async () => {
      const { error } = await clients.staff.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record()], p_user_email: creds.staff.email,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/only admins/i);
    });

    test('rejects a payload with the same employee_id twice, before touching the database', async () => {
      const { data: before } = await clients.admin.from('payroll').select('id').eq('month', testMonth).eq('employee_id', payrollEmployeeId);
      const countBefore = before?.length ?? 0;

      const { error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record(), record()], p_user_email: creds.admin.email,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/appears more than once/i);

      const { data: after } = await clients.admin.from('payroll').select('id').eq('month', testMonth).eq('employee_id', payrollEmployeeId);
      expect(after?.length ?? 0).toBe(countBefore);
    });

    test('rejects a negative basic_salary but allows a legitimately negative net_pay', async () => {
      const { error: negSalaryErr } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record({ basic_salary: -1000 })], p_user_email: creds.admin.email,
      });
      expect(negSalaryErr).not.toBeNull();
      expect(negSalaryErr?.message).toMatch(/negative monetary value/i);

      const { error: negNetPayErr } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record({ net_pay: -5000 })], p_user_email: creds.admin.email,
      });
      expect(negNetPayErr).toBeNull(); // net_pay may legitimately be negative -- not rejected

      const { data: row } = await clients.admin.from('payroll').select('net_pay').eq('month', testMonth).eq('employee_id', payrollEmployeeId).single();
      expect(Number(row?.net_pay)).toBe(-5000);
    });

    test('rounds monetary values to 2 decimal places on insert', async () => {
      const { error } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record({ basic_salary: 100000.999 })], p_user_email: creds.admin.email,
      });
      expect(error).toBeNull();
      const { data: row } = await clients.admin.from('payroll').select('basic_salary').eq('month', testMonth).eq('employee_id', payrollEmployeeId).single();
      expect(Number(row?.basic_salary)).toBe(100001);
    });

    test('audit log records the actual prior figures on a reprocess, not just a count', async () => {
      await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record({ basic_salary: 111111 })], p_user_email: creds.admin.email,
      });
      const { data: result } = await clients.admin.rpc('process_payroll_batch', {
        p_month: testMonth, p_records: [record({ basic_salary: 222222 })], p_user_email: creds.admin.email,
      });
      expect(result.deletedCount).toBe(1);

      const { data: logs } = await clients.admin
        .from('audit_logs')
        .select('old_data')
        .eq('entity_type', 'payroll')
        .order('created_at', { ascending: false })
        .limit(1);
      const deletedRows = logs?.[0]?.old_data?.deletedRows;
      expect(Array.isArray(deletedRows)).toBe(true);
      expect(Number(deletedRows[0]?.basic_salary)).toBe(111111);
    });
  });

  // ------------------------------------------------------------------
  // Terminal dues persistence
  // ------------------------------------------------------------------
  test.describe('terminal dues', () => {
    test('a terminal dues calculation round-trips through insert/select correctly', async () => {
      const { data: emp, error: empErr } = await clients.admin
        .from('employees')
        .insert({ employee_number: `SFG-E2E-TD-${Date.now()}`, full_name: 'E2E Terminal Dues Test', basic_salary: 100000, hire_date: '2020-01-01' })
        .select('id')
        .single();
      test.skip(!!empErr, `Could not create a disposable employee: ${empErr?.message}`);
      createdEmployeeIds.push(emp!.id);

      const { data: inserted, error: insertErr } = await clients.admin
        .from('terminal_dues')
        .insert({
          employee_id: emp!.id, date_left: '2024-01-01', termination_type: 'resignation',
          gratuity: 480000, annual_leave: 100000, uniform_refund: 0, other_benefits: 0, deductions: 0,
          subtotal: 580000, total_payable: 580000, status: 'pending',
        })
        .select()
        .single();
      expect(insertErr).toBeNull();
      expect(inserted?.total_payable).toBe(580000);

      await clients.admin.from('terminal_dues').delete().eq('id', inserted!.id);
    });
  });

  // ------------------------------------------------------------------
  // Payment status transitions
  // ------------------------------------------------------------------
  test.describe('payment status transitions', () => {
    test('pending -> paid is a normal, allowed transition for Admin', async () => {
      const { data: emp } = await clients.admin
        .from('employees')
        .insert({ employee_number: `SFG-E2E-PMT-${Date.now()}`, full_name: 'E2E Payment Test', basic_salary: 0 })
        .select('id')
        .single();
      createdEmployeeIds.push(emp!.id);

      await clients.admin.from('payment_status').insert({ employee_id: emp!.id, month: `${testMonth}-01`, status: 'pending' });
      const { error } = await clients.admin.from('payment_status').update({ status: 'paid' }).eq('employee_id', emp!.id).eq('month', `${testMonth}-01`);
      expect(error).toBeNull();

      const { data: row } = await clients.admin.from('payment_status').select('status').eq('employee_id', emp!.id).eq('month', `${testMonth}-01`).single();
      expect(row?.status).toBe('paid');

      await clients.admin.from('payment_status').delete().eq('employee_id', emp!.id).eq('month', `${testMonth}-01`);
    });
  });

  // ------------------------------------------------------------------
  // Recruitment status updates -- documents CURRENT (unrestricted)
  // behavior per Finding A19, not a desired end state.
  // ------------------------------------------------------------------
  test.describe('recruitment status updates (documents the A19 gap, does not endorse it)', () => {
    test('a Pending applicant can currently be moved directly to Accepted/Hire with no intermediate steps', async () => {
      const { data: applicant, error: createErr } = await clients.admin
        .from('applicants')
        .insert({ name: 'E2E Test Applicant', position: 'Security Guard', interview_status: 'Pending', decision: 'Pending' })
        .select('id')
        .single();
      test.skip(!!createErr, `Could not create a disposable applicant: ${createErr?.message}`);

      const { error } = await clients.admin
        .from('applicants')
        .update({ interview_status: 'Accepted', decision: 'Hire' })
        .eq('id', applicant!.id);

      // This currently succeeds -- there is no transition validation at
      // any layer (Finding A19). This test exists to make that concrete
      // and catch it automatically if/when a state machine is enforced
      // (at which point this specific assertion should be updated to
      // expect a rejection instead).
      expect(error).toBeNull();

      await clients.admin.from('applicants').delete().eq('id', applicant!.id);
    });
  });
});
