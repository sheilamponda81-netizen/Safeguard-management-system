// Single place that decides which net-pay figure the Payment page/export
// shows for one employee/month. Extracted as a pure function so the
// precedence rule is directly testable without a Supabase round-trip --
// see src/pages/Payments.tsx's fetchPaymentData, the only caller.
//
// BUSINESS RULE (the fix for the Payroll/Payment reconciliation bug):
// finalized payroll is the single source of truth for payment. Once an
// approved payroll row exists for an employee/month, Payment MUST show
// exactly that figure -- never a stale `payment_status.net_pay` recorded
// before that payroll run existed (or before it was corrected/reapproved),
// and never an independent live recalculation. `payment_status.net_pay`
// and the live estimate remain exactly as before as fallbacks, in that
// order, for an employee/month that has no approved payroll row at all.
export interface ResolvePaymentNetPayInput {
  /** Finalized (approval_status = 'approved') payroll.net_pay for this employee/month, if one exists. */
  approvedPayrollNetPay: number | undefined;
  /** Previously recorded payment_status.net_pay for this employee/month, if one exists. */
  paymentStatusNetPay: number | undefined;
  /** calculateLivePayroll's current estimate -- always computable, used only as the last resort. */
  liveEstimateNetPay: number;
}

export interface ResolvePaymentNetPayResult {
  netPay: number;
  /** True only when neither a finalized payroll row nor a recorded payment exists yet. */
  netPayIsEstimate: boolean;
}

export function resolvePaymentNetPay(input: ResolvePaymentNetPayInput): ResolvePaymentNetPayResult {
  if (input.approvedPayrollNetPay !== undefined) {
    return { netPay: input.approvedPayrollNetPay, netPayIsEstimate: false };
  }
  if (input.paymentStatusNetPay !== undefined) {
    return { netPay: input.paymentStatusNetPay, netPayIsEstimate: false };
  }
  return { netPay: input.liveEstimateNetPay, netPayIsEstimate: true };
}
