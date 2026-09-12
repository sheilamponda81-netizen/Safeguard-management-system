import { describe, it, expect } from 'vitest';
import { calculateMonthsDiff, calculateTerminalDues } from './terminalDuesCalculations';

describe('calculateMonthsDiff', () => {
  it('counts whole calendar months by year/month, not exact days', () => {
    // 2024-01-15 -> 2024-03-01 is 2 calendar months even though it's
    // less than 2 full 30-day periods -- matches the existing
    // implementation exactly (year*12 + month arithmetic, no day component).
    expect(calculateMonthsDiff('2024-01-15', '2024-03-01')).toBe(2);
  });

  it('handles a full year correctly', () => {
    expect(calculateMonthsDiff('2023-06-01', '2024-06-01')).toBe(12);
  });

  it('returns 0 for the same month', () => {
    expect(calculateMonthsDiff('2024-01-01', '2024-01-31')).toBe(0);
  });

  it('returns a negative number if dateLeft precedes hireDate', () => {
    expect(calculateMonthsDiff('2024-06-01', '2024-01-01')).toBe(-5);
  });
});

describe('calculateTerminalDues', () => {
  const base = { hireDate: '2020-01-01', dateLeft: '2024-01-01', basicSalary: 100000 };

  it('returns null when dateLeft does not come after hireDate', () => {
    expect(calculateTerminalDues({ hireDate: '2024-01-01', dateLeft: '2024-01-01', basicSalary: 100000 })).toBeNull();
    expect(calculateTerminalDues({ hireDate: '2024-06-01', dateLeft: '2024-01-01', basicSalary: 100000 })).toBeNull();
  });

  it('computes gratuity as 10% of basic salary per month worked', () => {
    // 48 months (2020-01 -> 2024-01) * 100,000 * 10% = 480,000
    const result = calculateTerminalDues(base);
    expect(result?.periodMonths).toBe(48);
    expect(result?.gratuity).toBe(480000);
  });

  it('sets annual leave payout to exactly one month of basic salary', () => {
    const result = calculateTerminalDues(base);
    expect(result?.annualLeave).toBe(100000);
  });

  it('defaults basic salary to 150000 when not provided', () => {
    const result = calculateTerminalDues({ hireDate: '2023-01-01', dateLeft: '2024-01-01' });
    expect(result?.basicSalary).toBe(150000);
    expect(result?.annualLeave).toBe(150000);
  });

  it('sums gratuity + annual leave + uniform refund + other benefits into subtotal, then subtracts deductions for total payable', () => {
    const result = calculateTerminalDues({
      ...base,
      uniformRefund: 10000,
      otherBenefits: 5000,
      deductions: 20000,
    });
    expect(result).not.toBeNull();
    const expectedSubtotal = result!.gratuity + result!.annualLeave + 10000 + 5000;
    expect(result!.subtotal).toBe(expectedSubtotal);
    expect(result!.totalPayable).toBe(expectedSubtotal - 20000);
  });

  it('treats missing uniformRefund/otherBenefits/deductions as zero', () => {
    const result = calculateTerminalDues(base);
    expect(result?.uniformRefund).toBe(0);
    expect(result?.otherBenefits).toBe(0);
    expect(result?.deductions).toBe(0);
    expect(result).not.toBeNull();
    expect(result?.subtotal).toBe(result!.gratuity + result!.annualLeave);
  });

  it('can produce a total payable greater than subtotal is not possible, but total payable can be negative if deductions exceed subtotal', () => {
    const result = calculateTerminalDues({ ...base, deductions: 100_000_000 });
    expect(result?.totalPayable).toBeLessThan(0);
  });
});
