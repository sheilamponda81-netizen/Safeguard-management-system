import { describe, it, expect } from 'vitest';
import { countsFromDeductions, deriveAttendanceCountsState } from './payrollAttendanceCounts';

describe('countsFromDeductions', () => {
  it('maps employee_id/absent_days/late_days directly, one row per employee -- the shape shared by employee_deductions and get_payroll_attendance_counts()', () => {
    const rows = [
      { employee_id: 'e1', absent_days: 3, late_days: 1 },
      { employee_id: 'e2', absent_days: 0, late_days: 0 },
    ];
    const counts = countsFromDeductions(rows);
    expect(counts.get('e1')).toEqual({ absentDays: 3, lateDays: 1 });
    expect(counts.get('e2')).toEqual({ absentDays: 0, lateDays: 0 });
  });

  it('treats a null/undefined day count as zero rather than propagating null', () => {
    const rows = [{ employee_id: 'e1', absent_days: null as unknown as number, late_days: undefined as unknown as number }];
    const counts = countsFromDeductions(rows);
    expect(counts.get('e1')).toEqual({ absentDays: 0, lateDays: 0 });
  });

  it('returns an empty map for an empty row set -- the shape both an RLS-denied historical query and a failed/empty RPC call resolve to', () => {
    const counts = countsFromDeductions([]);
    expect(counts.size).toBe(0);
    expect(counts.get('anyone')).toBeUndefined();
  });

  it('an employee with no matching row at all is simply absent from the map, not present with zeros', () => {
    const counts = countsFromDeductions([{ employee_id: 'e1', absent_days: 1, late_days: 0 }]);
    expect(counts.has('e2')).toBe(false);
  });
});

describe('deriveAttendanceCountsState (fail-closed decision Payroll.tsx renders/gates on)', () => {
  it('historical month: builds counts from the employee_deductions rows and is always unavailable:false, regardless of the (unused) RPC result', () => {
    const deductions = [{ employee_id: 'e1', absent_days: 2, late_days: 1 }];
    const state = deriveAttendanceCountsState(true, deductions, { rows: [], failed: true });
    expect(state.unavailable).toBe(false);
    expect(state.counts.get('e1')).toEqual({ absentDays: 2, lateDays: 1 });
  });

  it('current/future month, RPC succeeded: builds counts from the RPC rows, unavailable:false', () => {
    const rpcResult = { rows: [{ employee_id: 'e1', absent_days: 4, late_days: 0 }], failed: false };
    const state = deriveAttendanceCountsState(false, [], rpcResult);
    expect(state.unavailable).toBe(false);
    expect(state.counts.get('e1')).toEqual({ absentDays: 4, lateDays: 0 });
  });

  it('current/future month, RPC failed: unavailable:true and counts is empty -- never a fabricated zero treated as real', () => {
    const rpcResult = { rows: [], failed: true };
    const state = deriveAttendanceCountsState(false, [], rpcResult);
    expect(state.unavailable).toBe(true);
    expect(state.counts.size).toBe(0);
  });

  it('current/future month never reads the employee_deductions argument at all, even if non-empty', () => {
    const staleDeductions = [{ employee_id: 'e1', absent_days: 99, late_days: 99 }];
    const rpcResult = { rows: [{ employee_id: 'e1', absent_days: 1, late_days: 1 }], failed: false };
    const state = deriveAttendanceCountsState(false, staleDeductions, rpcResult);
    expect(state.counts.get('e1')).toEqual({ absentDays: 1, lateDays: 1 });
  });
});
