import { describe, it, expect } from 'vitest';
import { countsFromRawAttendance, countsFromDeductions } from './payrollAttendanceCounts';

describe('countsFromRawAttendance (current/future branch)', () => {
  it('sums absent (A) and late (L) day rows per employee', () => {
    const rows = [
      { employee_id: 'e1', status: 'A' },
      { employee_id: 'e1', status: 'A' },
      { employee_id: 'e1', status: 'L' },
      { employee_id: 'e2', status: 'L' },
      { employee_id: 'e2', status: 'P' }, // present -- not counted either way
    ];
    const counts = countsFromRawAttendance(rows);
    expect(counts.get('e1')).toEqual({ absentDays: 2, lateDays: 1 });
    expect(counts.get('e2')).toEqual({ absentDays: 0, lateDays: 1 });
  });

  it('returns an empty map for an empty row set -- the exact shape an RLS-denied SELECT resolves to (no error, just zero rows)', () => {
    const counts = countsFromRawAttendance([]);
    expect(counts.size).toBe(0);
    expect(counts.get('anyone')).toBeUndefined();
  });

  it('an employee with no matching rows at all is simply absent from the map, not present with zeros', () => {
    const counts = countsFromRawAttendance([{ employee_id: 'e1', status: 'A' }]);
    expect(counts.has('e2')).toBe(false);
  });
});

describe('countsFromDeductions (historical branch)', () => {
  it('maps employee_deductions.absent_days/late_days directly, one row per employee', () => {
    const deductions = [
      { employee_id: 'e1', absent_days: 3, late_days: 1 },
      { employee_id: 'e2', absent_days: 0, late_days: 0 },
    ];
    const counts = countsFromDeductions(deductions);
    expect(counts.get('e1')).toEqual({ absentDays: 3, lateDays: 1 });
    expect(counts.get('e2')).toEqual({ absentDays: 0, lateDays: 0 });
  });

  it('treats a null/undefined day count as zero rather than propagating null', () => {
    const deductions = [{ employee_id: 'e1', absent_days: null as unknown as number, late_days: undefined as unknown as number }];
    const counts = countsFromDeductions(deductions);
    expect(counts.get('e1')).toEqual({ absentDays: 0, lateDays: 0 });
  });

  it('returns an empty map when no deduction rows exist for the month', () => {
    expect(countsFromDeductions([]).size).toBe(0);
  });
});
