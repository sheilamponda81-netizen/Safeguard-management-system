import { describe, it, expect } from 'vitest';
import { resolveDeductionSnapshot, PayrollDeductionSnapshotRow } from './payrollDeductionSnapshotResolution';

const PAYROLL_ID = 'payroll-123';
const OTHER_PAYROLL_ID = 'payroll-999';

function row(overrides: Partial<PayrollDeductionSnapshotRow> = {}): PayrollDeductionSnapshotRow {
  return {
    payrollId: PAYROLL_ID,
    category: 'uniform',
    amount: 0,
    quantity: null,
    rate: null,
    source: 'uniform_rate_config',
    ...overrides,
  };
}

function fullSet(overrides: Partial<Record<string, Partial<PayrollDeductionSnapshotRow>>> = {}): PayrollDeductionSnapshotRow[] {
  const base: PayrollDeductionSnapshotRow[] = [
    row({ category: 'uniform', amount: 4200 }),
    row({ category: 'absence', amount: 5000, quantity: 1, rate: 5000, source: 'live_attendance_count' }),
    row({ category: 'late', amount: 0, quantity: 0, rate: 2000, source: 'live_attendance_count' }),
    row({ category: 'lecture', amount: 0, source: 'no_record_zero' }),
    row({ category: 'appearance', amount: 0, source: 'no_record_zero' }),
  ];
  return base.map(r => (overrides[r.category] ? { ...r, ...overrides[r.category] } : r));
}

describe('resolveDeductionSnapshot', () => {
  it('returns "none" when no snapshot rows exist for this payroll_id -- the caller must fall back, never fabricate', () => {
    expect(resolveDeductionSnapshot(null, { payrollId: PAYROLL_ID, bundledTotal: 4200 })).toEqual({ status: 'none' });
    expect(resolveDeductionSnapshot(undefined, { payrollId: PAYROLL_ID, bundledTotal: 4200 })).toEqual({ status: 'none' });
    expect(resolveDeductionSnapshot([], { payrollId: PAYROLL_ID, bundledTotal: 4200 })).toEqual({ status: 'none' });
  });

  // Exact five-category reconciled snapshot.
  it('a complete set of all 5 required categories that reconciles with the bundled total resolves as available', () => {
    // fullSet() sums to 4200 (uniform) + 5000 (absence) = 9200.
    const result = resolveDeductionSnapshot(fullSet(), { payrollId: PAYROLL_ID, bundledTotal: 9200 });
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.snapshot).toMatchObject({
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
    }
  });

  // Valid unresolved/unallocated category.
  it('a valid snapshot may include an optional unallocated row -- still available, but not complete, and the amount is surfaced, never dropped', () => {
    const rows = [
      ...fullSet({ uniform: { amount: 0 } }),
      row({ category: 'unallocated', amount: 4200, source: 'unresolved_remainder' }),
    ];
    // fullSet with uniform=0 sums to 5000 (absence) + 4200 (unallocated) = 9200.
    const result = resolveDeductionSnapshot(rows, { payrollId: PAYROLL_ID, bundledTotal: 9200 });
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.snapshot.unallocatedAmount).toBe(4200);
      expect(result.snapshot.uniformDeduction).toBe(0);
      expect(result.snapshot.complete).toBe(false);
    }
  });

  // Missing category.
  it('a missing required category is rejected as invalid, not silently defaulted to zero', () => {
    const rows = fullSet().filter(r => r.category !== 'late');
    const result = resolveDeductionSnapshot(rows, { payrollId: PAYROLL_ID, bundledTotal: 4200 });
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      expect(result.reason).toContain('late');
    }
  });

  it('multiple missing categories are all named in the rejection reason', () => {
    const rows = fullSet().filter(r => r.category !== 'late' && r.category !== 'lecture');
    const result = resolveDeductionSnapshot(rows, { payrollId: PAYROLL_ID, bundledTotal: 4200 });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toContain('late');
      expect(result.reason).toContain('lecture');
    }
  });

  // Duplicate category.
  it('a duplicate category is rejected as invalid', () => {
    const rows = [...fullSet(), row({ category: 'absence', amount: 1234 })];
    const result = resolveDeductionSnapshot(rows, { payrollId: PAYROLL_ID, bundledTotal: 4200 + 1234 });
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      expect(result.reason).toContain('duplicate');
      expect(result.reason).toContain('absence');
    }
  });

  // Snapshot total different from committed payroll.
  it('a category total that does not reconcile with the committed bundled deduction is rejected as invalid', () => {
    const result = resolveDeductionSnapshot(fullSet(), { payrollId: PAYROLL_ID, bundledTotal: 9999 });
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      expect(result.reason).toContain('reconcile');
    }
  });

  // Wrong payroll ID.
  it('a row whose own payrollId does not match the displayed payroll_id is rejected as invalid -- never silently mixed in from a different run', () => {
    const rows = [...fullSet().slice(0, 4), row({ category: 'appearance', amount: 0, payrollId: OTHER_PAYROLL_ID })];
    const result = resolveDeductionSnapshot(rows, { payrollId: PAYROLL_ID, bundledTotal: 4200 });
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      expect(result.reason).toContain(OTHER_PAYROLL_ID);
    }
  });

  // Negative/invalid category values.
  it('a negative amount is rejected as invalid', () => {
    const rows = fullSet({ absence: { amount: -100 } });
    const result = resolveDeductionSnapshot(rows, { payrollId: PAYROLL_ID, bundledTotal: 4200 });
    expect(result).toMatchObject({ status: 'invalid' });
  });

  it('a non-finite amount (NaN/Infinity) is rejected as invalid', () => {
    const nanRows = fullSet({ absence: { amount: NaN } });
    expect(resolveDeductionSnapshot(nanRows, { payrollId: PAYROLL_ID, bundledTotal: 4200 })).toMatchObject({ status: 'invalid' });
    const infRows = fullSet({ absence: { amount: Infinity } });
    expect(resolveDeductionSnapshot(infRows, { payrollId: PAYROLL_ID, bundledTotal: 4200 })).toMatchObject({ status: 'invalid' });
  });

  it('a negative quantity or rate is rejected as invalid even if the amount itself is fine', () => {
    const rows = fullSet({ absence: { quantity: -1 } });
    expect(resolveDeductionSnapshot(rows, { payrollId: PAYROLL_ID, bundledTotal: 4200 })).toMatchObject({ status: 'invalid' });
  });

  it('an unknown category name is rejected as invalid', () => {
    const rows = [...fullSet(), row({ category: 'hygiene' as unknown as PayrollDeductionSnapshotRow['category'], amount: 0 })];
    const result = resolveDeductionSnapshot(rows, { payrollId: PAYROLL_ID, bundledTotal: 4200 });
    expect(result).toMatchObject({ status: 'invalid' });
  });

  // Small rounding differences.
  it('a reconciliation difference within the 1-currency-unit tolerance is still accepted (matches the SQL capture function\'s own TOLERANCE)', () => {
    // fullSet() sums to 9200; 9200.6 is within the 1-unit tolerance.
    const result = resolveDeductionSnapshot(fullSet(), { payrollId: PAYROLL_ID, bundledTotal: 9200.6 });
    expect(result.status).toBe('available');
  });

  it('a reconciliation difference beyond the tolerance is rejected, even if small in relative terms -- a real few-Kwacha discrepancy must never silently disappear', () => {
    // fullSet() sums to 9200; 9202 is 2 off, beyond the 1-unit tolerance.
    const result = resolveDeductionSnapshot(fullSet(), { payrollId: PAYROLL_ID, bundledTotal: 9202 });
    expect(result).toMatchObject({ status: 'invalid' });
  });

  it('exposes absence/late quantity and rate for the drill-down UI to cite as evidence', () => {
    const rows = [
      row({ category: 'absence', amount: 10000, quantity: 2, rate: 5000 }),
      row({ category: 'late', amount: 4000, quantity: 2, rate: 2000 }),
      row({ category: 'uniform', amount: 200 }),
      row({ category: 'lecture', amount: 0 }),
      row({ category: 'appearance', amount: 0 }),
    ];
    const result = resolveDeductionSnapshot(rows, { payrollId: PAYROLL_ID, bundledTotal: 14200 });
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.snapshot).toMatchObject({
        absenceDeduction: 10000, absenceDays: 2, absenceRate: 5000,
        lateDeduction: 4000, lateDays: 2, lateRate: 2000,
      });
    }
  });
});
