import { describe, it, expect } from 'vitest';
import { sumOrdinaryDeductionsTotal, OrdinaryDeductionFields } from './payrollRequestSnapshotDeductions';

// Mirrors the six scenarios from the 2026-11-04 corrective migration's own
// disposable-Postgres verification (see migration header). Synthetic
// fixture values only -- no real financial records.
describe('sumOrdinaryDeductionsTotal (parity with compute_payroll_request_snapshot fix)', () => {
  it('sums correctly when all three fields are present', () => {
    const records: OrdinaryDeductionFields[] = [{ paye: 100, pension: 50, uniform_deduction: 10 }];
    expect(sumOrdinaryDeductionsTotal(records)).toBe(160);
  });

  it('does not drop the row when one optional field is missing (key absent)', () => {
    const records: OrdinaryDeductionFields[] = [{ paye: 100, pension: 50 }];
    expect(sumOrdinaryDeductionsTotal(records)).toBe(150);
  });

  it('does not drop the row when one optional field is explicitly null', () => {
    const records: OrdinaryDeductionFields[] = [{ paye: 100, pension: 50, uniform_deduction: null }];
    expect(sumOrdinaryDeductionsTotal(records)).toBe(150);
  });

  it('does not drop the row when two optional fields are missing', () => {
    const records: OrdinaryDeductionFields[] = [{ paye: 100 }];
    expect(sumOrdinaryDeductionsTotal(records)).toBe(100);
  });

  it('returns zero when all optional fields are absent', () => {
    const records: OrdinaryDeductionFields[] = [{}];
    expect(sumOrdinaryDeductionsTotal(records)).toBe(0);
  });

  it('does not zero out other employees when only some records have missing fields', () => {
    const records: OrdinaryDeductionFields[] = [
      { paye: 100, pension: 50, uniform_deduction: 10 },
      { paye: 80, pension: null, uniform_deduction: 5 },
      { paye: 60, pension: 20 },
    ];
    // 160 + 85 + 80 = 325 -- the pre-fix formula would have silently
    // contributed 0 for the second and third employees here.
    expect(sumOrdinaryDeductionsTotal(records)).toBe(325);
  });

  it('handles numeric precision and zero values correctly', () => {
    const records: OrdinaryDeductionFields[] = [
      { paye: 0, pension: 0.01, uniform_deduction: 0 },
      { paye: 33.33, pension: 0, uniform_deduction: 0.34 },
    ];
    expect(sumOrdinaryDeductionsTotal(records)).toBeCloseTo(33.68, 2);
  });
});
