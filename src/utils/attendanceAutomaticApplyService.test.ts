import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import {
  classifyAutomaticEligibility, fetchExistingAttendanceAndPayroll, applyEligibleAutomaticResults,
  ExistingAttendanceAndPayroll,
} from './attendanceAutomaticApplyService';

function existing(overrides: Partial<ExistingAttendanceAndPayroll> = {}): ExistingAttendanceAndPayroll {
  return {
    attendanceByDate: new Map(),
    payrollApprovedByMonth: new Map(),
    ...overrides,
  };
}

describe('classifyAutomaticEligibility', () => {
  it('classifies a confirmed Present with no protections as eligible', () => {
    const result = classifyAutomaticEligibility(
      { employeeId: 'e1', date: '2026-10-01', status: 'present', calculationBasis: 'confirmed' },
      existing()
    );
    expect(result).toBe('eligible');
  });

  it('classifies a confirmed Late with no protections as eligible too', () => {
    const result = classifyAutomaticEligibility(
      { employeeId: 'e1', date: '2026-10-01', status: 'late', calculationBasis: 'confirmed' },
      existing()
    );
    expect(result).toBe('eligible');
  });

  it.each(['absent', 'pending', 'off', 'unassigned'])('never classifies %s as eligible, regardless of basis', (status) => {
    const result = classifyAutomaticEligibility(
      { employeeId: 'e1', date: '2026-10-01', status, calculationBasis: null },
      existing()
    );
    expect(result).toBe('skipped_not_confirmed_present_late');
  });

  it('never classifies a provisional (check_in_only_provisional) Present/Late as eligible', () => {
    const result = classifyAutomaticEligibility(
      { employeeId: 'e1', date: '2026-10-01', status: 'present', calculationBasis: 'check_in_only_provisional' },
      existing()
    );
    expect(result).toBe('skipped_not_confirmed_present_late');
  });

  it('protects an existing manual correction even when the calculated result is a confirmed Present', () => {
    const result = classifyAutomaticEligibility(
      { employeeId: 'e1', date: '2026-10-01', status: 'present', calculationBasis: 'confirmed' },
      existing({ attendanceByDate: new Map([['2026-10-01', { status: 'A', source: 'manual' }]]) })
    );
    expect(result).toBe('protected_manual');
  });

  it('protects a month with approved payroll even when the calculated result is a confirmed Present', () => {
    const result = classifyAutomaticEligibility(
      { employeeId: 'e1', date: '2026-10-01', status: 'present', calculationBasis: 'confirmed' },
      existing({ payrollApprovedByMonth: new Map([['2026-10', true]]) })
    );
    expect(result).toBe('protected_payroll_approved');
  });

  it('checks manual protection before payroll protection (manual wins if both would apply)', () => {
    const result = classifyAutomaticEligibility(
      { employeeId: 'e1', date: '2026-10-01', status: 'present', calculationBasis: 'confirmed' },
      existing({
        attendanceByDate: new Map([['2026-10-01', { status: 'P', source: 'manual' }]]),
        payrollApprovedByMonth: new Map([['2026-10', true]]),
      })
    );
    expect(result).toBe('protected_manual');
  });

  it('an existing AUTOMATIC-source row (not manual) does not protect -- only manual does', () => {
    const result = classifyAutomaticEligibility(
      { employeeId: 'e1', date: '2026-10-01', status: 'present', calculationBasis: 'confirmed' },
      existing({ attendanceByDate: new Map([['2026-10-01', { status: 'P', source: 'automatic' }]]) })
    );
    expect(result).toBe('eligible');
  });
});

describe('fetchExistingAttendanceAndPayroll', () => {
  beforeEach(() => fromMock.mockReset());

  it('builds lookup maps from the attendance and payroll tables, read-only', async () => {
    fromMock.mockImplementationOnce(() => ({
      select: () => ({ eq: () => ({ gte: () => ({ lte: () => Promise.resolve({
        data: [{ date: '2026-10-01', status: 'A', source: 'manual' }], error: null,
      }) }) }) }),
    }));
    fromMock.mockImplementationOnce(() => ({
      select: () => ({ eq: () => Promise.resolve({
        data: [{ month: '2026-10', approval_status: 'approved' }], error: null,
      }) }),
    }));

    const result = await fetchExistingAttendanceAndPayroll('e1', '2026-10-01', '2026-10-07');
    expect(result.attendanceByDate.get('2026-10-01')).toEqual({ status: 'A', source: 'manual' });
    expect(result.payrollApprovedByMonth.get('2026-10')).toBe(true);
    expect(fromMock).toHaveBeenNthCalledWith(1, 'attendance');
    expect(fromMock).toHaveBeenNthCalledWith(2, 'payroll');
  });
});

describe('applyEligibleAutomaticResults', () => {
  beforeEach(() => rpcMock.mockReset());

  it('calls attendance_apply_automatic once per pair, with p_date_from === p_date_to (never a wider range)', async () => {
    rpcMock.mockResolvedValue({ data: [{ outcome: 'written', old_status: null, new_status: 'P', payroll_flag: null }], error: null });
    await applyEligibleAutomaticResults([{ employeeId: 'e1', date: '2026-10-01' }, { employeeId: 'e1', date: '2026-10-03' }]);
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock).toHaveBeenNthCalledWith(1, 'attendance_apply_automatic', { p_employee_ids: ['e1'], p_date_from: '2026-10-01', p_date_to: '2026-10-01' });
    expect(rpcMock).toHaveBeenNthCalledWith(2, 'attendance_apply_automatic', { p_employee_ids: ['e1'], p_date_from: '2026-10-03', p_date_to: '2026-10-03' });
  });

  it('maps outcomes to the expected shape', async () => {
    rpcMock.mockResolvedValue({ data: [{ outcome: 'written', old_status: '-', new_status: 'P', payroll_flag: null }], error: null });
    const outcomes = await applyEligibleAutomaticResults([{ employeeId: 'e1', date: '2026-10-01' }]);
    expect(outcomes).toEqual([{ employeeId: 'e1', date: '2026-10-01', outcome: 'written', oldStatus: '-', newStatus: 'P', payrollFlag: null }]);
  });

  it('propagates an RPC error rather than swallowing it', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Not authorized', code: '42501' } });
    await expect(applyEligibleAutomaticResults([{ employeeId: 'e1', date: '2026-10-01' }])).rejects.toBeTruthy();
  });

  it('calls the RPC zero times for an empty list', async () => {
    await applyEligibleAutomaticResults([]);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
