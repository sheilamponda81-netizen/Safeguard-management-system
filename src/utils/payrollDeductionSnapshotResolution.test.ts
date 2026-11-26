import { describe, it, expect } from 'vitest';
import { resolveDeductionSnapshot, PayrollDeductionSnapshotRow } from './payrollDeductionSnapshotResolution';

describe('resolveDeductionSnapshot', () => {
  // I: missing/incomplete historical snapshots fall back honestly --
  // "missing" case: no rows at all for this payroll_id.
  it('returns null when no snapshot rows exist for this payroll_id -- the caller must fall back, never fabricate', () => {
    expect(resolveDeductionSnapshot(null)).toBeNull();
    expect(resolveDeductionSnapshot(undefined)).toBeNull();
    expect(resolveDeductionSnapshot([])).toBeNull();
  });

  it('a fully-resolved snapshot (no unallocated row) reports complete: true', () => {
    const rows: PayrollDeductionSnapshotRow[] = [
      { category: 'uniform', amount: 4200, quantity: null, rate: null, source: 'uniform_rate_config' },
      { category: 'absence', amount: 5000, quantity: 1, rate: 5000, source: 'live_attendance_count' },
      { category: 'late', amount: 0, quantity: 0, rate: 2000, source: 'live_attendance_count' },
      { category: 'lecture', amount: 0, quantity: null, rate: null, source: 'no_record_zero' },
      { category: 'appearance', amount: 0, quantity: null, rate: null, source: 'no_record_zero' },
    ];
    const resolved = resolveDeductionSnapshot(rows);
    expect(resolved).not.toBeNull();
    expect(resolved).toMatchObject({
      available: true,
      uniformDeduction: 4200,
      absenceDeduction: 5000,
      absenceDays: 1,
      absenceRate: 5000,
      lateDeduction: 0,
      lectureDeduction: 0,
      appearanceDeduction: 0,
      unallocatedAmount: 0,
      complete: true,
    });
  });

  // F / "unallocated is never hidden": a snapshot with a genuinely
  // unresolved remainder must surface it explicitly and never report
  // complete: true.
  it('a snapshot with an unallocated row reports complete: false and surfaces the unresolved amount -- never silently dropped, never folded into uniform', () => {
    const rows: PayrollDeductionSnapshotRow[] = [
      { category: 'uniform', amount: 0, quantity: null, rate: null, source: 'uniform_rate_config' },
      { category: 'absence', amount: 0, quantity: 0, rate: 5000, source: 'live_attendance_count' },
      { category: 'late', amount: 0, quantity: 0, rate: 2000, source: 'live_attendance_count' },
      { category: 'lecture', amount: 0, quantity: null, rate: null, source: 'no_record_zero' },
      { category: 'appearance', amount: 0, quantity: null, rate: null, source: 'no_record_zero' },
      { category: 'unallocated', amount: 4200, quantity: null, rate: null, source: 'unresolved_remainder' },
    ];
    const resolved = resolveDeductionSnapshot(rows);
    expect(resolved).not.toBeNull();
    expect(resolved!.uniformDeduction).toBe(0);
    expect(resolved!.unallocatedAmount).toBe(4200);
    expect(resolved!.complete).toBe(false);
  });

  // D: an absence deduction correctly shows its day count and rate, not just a total.
  it('exposes absence/late quantity and rate for the drill-down UI to cite as evidence', () => {
    const rows: PayrollDeductionSnapshotRow[] = [
      { category: 'absence', amount: 10000, quantity: 2, rate: 5000, source: 'live_attendance_count' },
      { category: 'late', amount: 4000, quantity: 2, rate: 2000, source: 'live_attendance_count' },
    ];
    const resolved = resolveDeductionSnapshot(rows);
    expect(resolved).toMatchObject({
      absenceDeduction: 10000, absenceDays: 2, absenceRate: 5000,
      lateDeduction: 4000, lateDays: 2, lateRate: 2000,
    });
  });

  it('a category missing from the row set (e.g. lecture never written because it was 0) defaults honestly to 0, not undefined/NaN', () => {
    const rows: PayrollDeductionSnapshotRow[] = [
      { category: 'uniform', amount: 4200, quantity: null, rate: null, source: 'uniform_rate_config' },
    ];
    const resolved = resolveDeductionSnapshot(rows);
    expect(resolved).toMatchObject({
      absenceDeduction: 0, absenceDays: null, absenceRate: null,
      lateDeduction: 0, lateDays: null, lateRate: null,
      lectureDeduction: 0, appearanceDeduction: 0,
      unallocatedAmount: 0, complete: true,
    });
  });
});
