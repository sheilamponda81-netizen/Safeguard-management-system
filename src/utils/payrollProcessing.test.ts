import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const getUserMock = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
  },
}));

const { processPayrollBatch, describeProcessPayrollBatchError } = await import('./payrollProcessing');

const sampleRecord = {
  employee_id: 'emp-1',
  basic_salary: 100000,
  allowances: 0,
  overtime: 0,
  bonus: 0,
  gross_pay: 100000,
  paye: 15000,
  pension: 5000,
  uniform_deduction: 10000,
  net_pay: 70000,
};

describe('processPayrollBatch', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    getUserMock.mockReset();
    getUserMock.mockResolvedValue({ data: { user: { email: 'admin@example.com' } } });
  });

  it('rejects an empty record list without calling the RPC at all', async () => {
    const result = await processPayrollBatch('2026-08', []);
    expect(result).toEqual({ success: false, outcome: 'validation_failed', error: 'No payroll records supplied' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('passes month, records, the caller email, and audit context to the RPC', async () => {
    rpcMock.mockResolvedValueOnce({ data: { success: true, month: '2026-08', deletedCount: 0, insertedCount: 1 }, error: null });
    await processPayrollBatch('2026-08', [sampleRecord], { employeeCount: 1 });
    expect(rpcMock).toHaveBeenCalledWith('process_payroll_batch', {
      p_month: '2026-08',
      p_records: [sampleRecord],
      p_user_email: 'admin@example.com',
      p_audit_context: { employeeCount: 1 },
    });
  });

  it('returns a structured success result with deleted/inserted counts', async () => {
    rpcMock.mockResolvedValueOnce({ data: { success: true, month: '2026-08', deletedCount: 3, insertedCount: 5 }, error: null });
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result).toEqual({ success: true, outcome: 'success', month: '2026-08', deletedCount: 3, insertedCount: 5 });
  });

  it('surfaces an already-approved-month conflict raised inside the RPC as a structured failure, not a thrown exception', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Cannot reprocess 2026-08: 2 of the targeted employees already have approved payroll for this month. Reject the existing approval first.' },
    });
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('approved_conflict');
    expect(result.error).toMatch(/already have approved payroll/);
  });

  it('classifies an authorization exception raised inside the RPC as "unauthorized"', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Only Admins or super admins may process payroll' },
    });
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('unauthorized');
  });

  it('classifies any other exception raised inside the RPC as "validation_failed"', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Refusing to process: the same employee_id appears more than once in this batch' },
    });
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('validation_failed');
  });

  it('classifies a PGRST202 (function not found) error as "missing_rpc" with a non-technical message, not the raw Postgrest error', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function public.process_payroll_batch in the schema cache' },
    });
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('missing_rpc');
    expect(result.error).not.toMatch(/schema cache/);
  });

  it('surfaces a network-level throw as a structured failure too', async () => {
    rpcMock.mockRejectedValueOnce(new Error('network error'));
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result).toEqual({ success: false, outcome: 'network_error', error: 'network error' });
  });

  it('treats a missing/malformed RPC response as a failure rather than assuming success', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('unexpected_response');
  });

  it('treats a response missing a required field (e.g. insertedCount) as unexpected, not success', async () => {
    rpcMock.mockResolvedValueOnce({ data: { success: true, month: '2026-08', deletedCount: 3 }, error: null });
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('unexpected_response');
  });

  it('still calls the RPC even when auth.getUser() cannot resolve an email (passes null, matching the RPC default)', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    rpcMock.mockResolvedValueOnce({ data: { success: true, month: '2026-08', deletedCount: 0, insertedCount: 1 }, error: null });
    await processPayrollBatch('2026-08', [sampleRecord]);
    expect(rpcMock).toHaveBeenCalledWith('process_payroll_batch', expect.objectContaining({ p_user_email: null }));
  });

  it('classifies the global net-pay-invariant exception (advance-caused) as "validation_failed"', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: "Refusing to process payroll for employee 11111111-1111-1111-1111-111111111111: this would produce a negative net pay of -5000 (net pay 15000 minus a salary advance deduction of 20000). Final payroll net pay must never be negative -- resolve this before processing (e.g. reduce the combined repayment plan, move this employee's deduction to a later month, or review their other deductions) -- nothing has been applied and the transaction has been rolled back." },
    });
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('validation_failed');
    expect(result.error).toMatch(/negative net pay/);
  });

  it('classifies the payload-level negative-net-pay rejection (no salary advance involved) as "validation_failed"', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Refusing to process payroll: one or more records has a missing, non-numeric, or negative monetary value -- every amount, including net_pay, must be zero or positive. Final payroll net pay must never be negative; review the deductions for the affected employee(s) and try again.' },
    });
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('validation_failed');
    expect(result.error).toMatch(/net pay must never be negative/);
  });
});

describe('describeProcessPayrollBatchError', () => {
  const employeeId = '11111111-1111-1111-1111-111111111111';
  const advanceError = `Refusing to process payroll for employee ${employeeId}: this would produce a negative net pay of -5000 (net pay 15000 minus a salary advance deduction of 20000). Final payroll net pay must never be negative -- resolve this before processing.`;

  it('rewrites the advance-caused negative-net-pay error into a human-readable message naming the employee, when the name can be resolved', () => {
    const result = describeProcessPayrollBatchError(advanceError, id => (id === employeeId ? 'Jane Banda' : undefined));
    expect(result).toBe('Payroll cannot be processed because deductions would make net pay negative for Jane Banda. Review the deductions and try again.');
  });

  it('falls back to the raw RPC message when the employee cannot be resolved to a name', () => {
    const result = describeProcessPayrollBatchError(advanceError, () => undefined);
    expect(result).toBe(advanceError);
  });

  it('leaves every other error message untouched, e.g. the payload-level (no-UUID) negative-net-pay rejection', () => {
    const message = 'Refusing to process payroll: one or more records has a missing, non-numeric, or negative monetary value -- every amount, including net_pay, must be zero or positive.';
    expect(describeProcessPayrollBatchError(message, () => 'Jane Banda')).toBe(message);
  });

  it('leaves an unrelated error (e.g. duplicate employee_id) completely untouched', () => {
    const message = 'Refusing to process: the same employee_id appears more than once in this batch';
    expect(describeProcessPayrollBatchError(message, () => 'Jane Banda')).toBe(message);
  });
});
