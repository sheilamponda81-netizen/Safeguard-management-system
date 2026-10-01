import { describe, it, expect } from 'vitest';
import { resolvePaymentNetPay } from './paymentNetPay';

// Regression coverage for the Payroll/Payment reconciliation fix: a real
// accountant-reported discrepancy between the Payroll page (~MK 122M,
// 868 employees) and the Payment page/export (~MK 126M, 873 employees)
// traced to two causes -- (1) Payroll's employee roster excluded
// approved-leave employees entirely (see employeeStatus.ts's own test),
// and (2) Payment's merge let a stale/older `payment_status.net_pay`
// silently override a finalized, approved `payroll.net_pay` whenever a
// payment_status row happened to exist. This file covers (2): the exact
// precedence rule "finalized payroll is the single source of truth".
describe('resolvePaymentNetPay', () => {
  it('uses the approved payroll net pay when one exists, even if a payment_status row has a different value', () => {
    const result = resolvePaymentNetPay({
      approvedPayrollNetPay: 147000,
      paymentStatusNetPay: 120000, // stale/older recorded value -- must NOT win
      liveEstimateNetPay: 999999,
    });
    expect(result.netPay).toBe(147000);
    expect(result.netPayIsEstimate).toBe(false);
  });

  it('uses the approved payroll net pay when no payment_status row exists at all', () => {
    const result = resolvePaymentNetPay({
      approvedPayrollNetPay: 147000,
      paymentStatusNetPay: undefined,
      liveEstimateNetPay: 999999,
    });
    expect(result.netPay).toBe(147000);
    expect(result.netPayIsEstimate).toBe(false);
  });

  it('falls back to the recorded payment_status net pay when no approved payroll row exists', () => {
    const result = resolvePaymentNetPay({
      approvedPayrollNetPay: undefined,
      paymentStatusNetPay: 120000,
      liveEstimateNetPay: 999999,
    });
    expect(result.netPay).toBe(120000);
    expect(result.netPayIsEstimate).toBe(false);
  });

  it('falls back to the live estimate only when neither an approved payroll row nor a payment_status row exists', () => {
    const result = resolvePaymentNetPay({
      approvedPayrollNetPay: undefined,
      paymentStatusNetPay: undefined,
      liveEstimateNetPay: 147000,
    });
    expect(result.netPay).toBe(147000);
    expect(result.netPayIsEstimate).toBe(true);
  });

  it('treats an approved payroll net pay of exactly 0 as present (not as "missing")', () => {
    // A real, legitimate zero net pay (e.g. fully absorbed by deductions)
    // must not be treated the same as "no approved row exists" -- `undefined`
    // is the only "missing" sentinel, never falsy-zero.
    const result = resolvePaymentNetPay({
      approvedPayrollNetPay: 0,
      paymentStatusNetPay: 50000,
      liveEstimateNetPay: 99999,
    });
    expect(result.netPay).toBe(0);
    expect(result.netPayIsEstimate).toBe(false);
  });

  it('treats a recorded payment_status net pay of exactly 0 as present when no payroll row exists', () => {
    const result = resolvePaymentNetPay({
      approvedPayrollNetPay: undefined,
      paymentStatusNetPay: 0,
      liveEstimateNetPay: 99999,
    });
    expect(result.netPay).toBe(0);
    expect(result.netPayIsEstimate).toBe(false);
  });
});
