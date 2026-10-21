import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const getUserMock = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
  },
}));

const {
  submitPayrollProcessingRequest,
  approvePayrollProcessingRequest,
  rejectPayrollProcessingRequest,
  processApprovedPayrollRequest,
} = await import('./payrollApprovalWorkflow');

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

beforeEach(() => {
  rpcMock.mockReset();
  getUserMock.mockReset();
  getUserMock.mockResolvedValue({ data: { user: { email: 'accountant@example.com' } } });
});

describe('submitPayrollProcessingRequest', () => {
  it('rejects an empty record list without calling the RPC', async () => {
    const result = await submitPayrollProcessingRequest('2026-11', []);
    expect(result).toEqual({ success: false, outcome: 'validation_failed', error: 'No payroll records supplied' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('calls submit_payroll_processing_request with month/records/audit context/TD exclusions', async () => {
    rpcMock.mockResolvedValueOnce({ data: { success: true, request_id: 'req-1', status: 'pending', month: '2026-11' }, error: null });
    await submitPayrollProcessingRequest('2026-11', [sampleRecord], { totalNet: 70000 }, ['alloc-1'], 'out of balance');
    expect(rpcMock).toHaveBeenCalledWith('submit_payroll_processing_request', {
      p_month: '2026-11',
      p_records: [sampleRecord],
      p_audit_context: { totalNet: 70000 },
      p_td_excluded_ids: ['alloc-1'],
      p_td_exclusion_reason: 'out of balance',
    });
  });

  it('returns a structured success result with the new pending request id', async () => {
    rpcMock.mockResolvedValueOnce({ data: { success: true, request_id: 'req-1', status: 'pending', month: '2026-11' }, error: null });
    const result = await submitPayrollProcessingRequest('2026-11', [sampleRecord]);
    expect(result).toEqual({
      success: true,
      outcome: 'success',
      requestId: 'req-1',
      status: 'pending',
      month: '2026-11',
      combinedReference: undefined,
      insertedCount: undefined,
      terminalDues: undefined,
      ordinaryPayrollTotal: undefined,
      terminalDuesTotal: undefined,
      combinedTotal: undefined,
    });
  });

  it('classifies a duplicate-live-request exception distinctly', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'A payroll processing request for 2026-11 is already pending or approved -- wait for it to be decided, or ask an Admin to reject it first' } });
    const result = await submitPayrollProcessingRequest('2026-11', [sampleRecord]);
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('duplicate_live_request');
  });

  it('classifies an unauthorized exception', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'Only Admins, super admins, or an account explicitly granted payroll.process may submit a payroll processing request' } });
    const result = await submitPayrollProcessingRequest('2026-11', [sampleRecord]);
    expect(result.outcome).toBe('unauthorized');
  });

  it('classifies a PGRST202 (function not found) error as missing_rpc', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    const result = await submitPayrollProcessingRequest('2026-11', [sampleRecord]);
    expect(result.outcome).toBe('missing_rpc');
  });

  it('surfaces a network-level throw as a structured failure', async () => {
    rpcMock.mockRejectedValueOnce(new Error('network error'));
    const result = await submitPayrollProcessingRequest('2026-11', [sampleRecord]);
    expect(result).toEqual({ success: false, outcome: 'network_error', error: 'network error' });
  });
});

describe('approvePayrollProcessingRequest', () => {
  it('calls approve_payroll_processing_request with the request id', async () => {
    rpcMock.mockResolvedValueOnce({ data: { success: true, request_id: 'req-1', status: 'approved', month: '2026-11' }, error: null });
    await approvePayrollProcessingRequest('req-1');
    expect(rpcMock).toHaveBeenCalledWith('approve_payroll_processing_request', { p_request_id: 'req-1' });
  });

  it('classifies a self-approval exception distinctly', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'You cannot approve your own payroll processing request' } });
    const result = await approvePayrollProcessingRequest('req-1');
    expect(result.outcome).toBe('self_approval');
  });

  it('classifies an unauthorized exception', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'Only an Admin or super admin may approve a payroll processing request' } });
    const result = await approvePayrollProcessingRequest('req-1');
    expect(result.outcome).toBe('unauthorized');
  });

  it('classifies a wrong-status (already decided) exception distinctly', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'This request is no longer pending (status: rejected) -- it may have already been decided' } });
    const result = await approvePayrollProcessingRequest('req-1');
    expect(result.outcome).toBe('wrong_status');
  });

  it('classifies a not-found exception distinctly (e.g. cross-tenant)', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'Payroll processing request not found' } });
    const result = await approvePayrollProcessingRequest('req-1');
    expect(result.outcome).toBe('not_found');
  });
});

describe('rejectPayrollProcessingRequest', () => {
  it('rejects an empty reason without calling the RPC', async () => {
    const result = await rejectPayrollProcessingRequest('req-1', '   ');
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('validation_failed');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('calls reject_payroll_processing_request with the trimmed reason', async () => {
    rpcMock.mockResolvedValueOnce({ data: { success: true, request_id: 'req-1', status: 'rejected', month: '2026-11' }, error: null });
    await rejectPayrollProcessingRequest('req-1', '  Attendance totals look wrong  ');
    expect(rpcMock).toHaveBeenCalledWith('reject_payroll_processing_request', { p_request_id: 'req-1', p_reason: 'Attendance totals look wrong' });
  });
});

describe('processApprovedPayrollRequest', () => {
  it('calls process_approved_payroll_request with the request id and caller email', async () => {
    rpcMock.mockResolvedValueOnce({
      data: {
        success: true, request_id: 'req-1', status: 'processed', month: '2026-11',
        combined_reference: 'PWTD-2026-11-abc', payroll: { insertedCount: 3 },
        terminal_dues: { batch_reference: 'TDPB-2026-11-xyz', processed_count: 1, total_amount: 50000, excluded_count: 0 },
        ordinary_payroll_total: 300000, terminal_dues_total: 50000, combined_total: 350000,
      },
      error: null,
    });
    const result = await processApprovedPayrollRequest('req-1');
    expect(rpcMock).toHaveBeenCalledWith('process_approved_payroll_request', { p_request_id: 'req-1', p_user_email: 'accountant@example.com' });
    expect(result).toEqual({
      success: true,
      outcome: 'success',
      requestId: 'req-1',
      status: 'processed',
      month: '2026-11',
      combinedReference: 'PWTD-2026-11-abc',
      insertedCount: 3,
      terminalDues: { batchReference: 'TDPB-2026-11-xyz', processedCount: 1, totalAmount: 50000, excludedCount: 0 },
      ordinaryPayrollTotal: 300000,
      terminalDuesTotal: 50000,
      combinedTotal: 350000,
    });
  });

  it('classifies a stale-month exception as validation_failed', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'Refusing to process: 2026-08 is no longer the active payroll month (now 2026-07) -- this request needs a fresh submission and review' } });
    const result = await processApprovedPayrollRequest('req-1');
    expect(result.outcome).toBe('validation_failed');
  });

  it('classifies a Terminal Dues re-validation exception distinctly -- ordinary payroll in the same call also rolled back', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "Cannot process: allocation abc would bring this entitlement's total processed to 999999 against an approved entitlement of only 100000" } });
    const result = await processApprovedPayrollRequest('req-1');
    expect(result.outcome).toBe('terminal_dues_validation_failed');
  });

  it('classifies a wrong-status (not approved) exception distinctly -- prevents reuse/double-processing', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'This request is not approved (status: processed) -- it may have already been processed, or was never approved' } });
    const result = await processApprovedPayrollRequest('req-1');
    expect(result.outcome).toBe('wrong_status');
  });

  it('treats a missing/malformed RPC response as a failure rather than assuming success', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    const result = await processApprovedPayrollRequest('req-1');
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('unexpected_response');
  });
});
