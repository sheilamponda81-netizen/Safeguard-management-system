import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const getUserMock = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
  },
}));

const { processPayrollBatch } = await import('./payrollProcessing');

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
    expect(result).toEqual({ success: false, error: 'No payroll records supplied' });
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
    expect(result).toEqual({ success: true, month: '2026-08', deletedCount: 3, insertedCount: 5 });
  });

  it('surfaces a validation error raised inside the RPC (e.g. already-approved month) as a structured failure, not a thrown exception', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Cannot reprocess 2026-08: 2 of the targeted employees already have approved payroll for this month. Reject the existing approval first.' },
    });
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already have approved payroll/);
  });

  it('surfaces a network-level throw as a structured failure too', async () => {
    rpcMock.mockRejectedValueOnce(new Error('network error'));
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result).toEqual({ success: false, error: 'network error' });
  });

  it('treats a missing/malformed RPC response as a failure rather than assuming success', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    const result = await processPayrollBatch('2026-08', [sampleRecord]);
    expect(result.success).toBe(false);
  });

  it('still calls the RPC even when auth.getUser() cannot resolve an email (passes null, matching the RPC default)', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    rpcMock.mockResolvedValueOnce({ data: { success: true, month: '2026-08', deletedCount: 0, insertedCount: 1 }, error: null });
    await processPayrollBatch('2026-08', [sampleRecord]);
    expect(rpcMock).toHaveBeenCalledWith('process_payroll_batch', expect.objectContaining({ p_user_email: null }));
  });
});
