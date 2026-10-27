// Phase 4B Part 3 -- pure content builder for the Terminal Dues Payment
// Statement. No DOM/React dependency, so the content logic is testable
// in isolation; Terminal­DuesPaymentHistory.tsx wraps this in an HTML
// document for print/download.
//
// Every figure here comes from already-stored, already-approved columns
// (terminal_dues' own gratuity/annual_leave/uniform_refund/other_benefits/
// deductions/total_payable, and the terminal_due_allocations ledger) --
// nothing is recalculated. "Payroll Processed" is the only payment label
// used anywhere in this module; this schema has no bank-payment
// confirmation to report, so none is implied.
import { getMonthLabel } from './currentMonth';

export interface StatementSubject {
  name: string;
  reference: string | null;
  isHistorical: boolean;
  dateJoined: string | null;
  dateLeft: string | null;
  reasonForLeaving: string | null;
  payPoint: string | null;
  accountNumber: string | null;
}

export interface StatementEntitlement {
  version: number;
  pensionArrears: number;
  annualLeaveRefund: number;
  uniformRefund: number;
  outstandingSalary: number;
  lessNoticeDeduction: number;
  totalEntitlements: number;
  finalApprovedEntitlement: number;
  approvedAt: string | null;
}

export interface StatementAllocation {
  payrollMonth: string;
  amount: number;
  processingReference: string | null;
  processedAt: string | null;
}

export interface TerminalDuesStatementInput {
  subject: StatementSubject;
  entitlement: StatementEntitlement;
  /** Every PROCESSED allocation for this entitlement, any month, oldest first. */
  processedAllocations: StatementAllocation[];
  /** The one allocation processed as part of THIS statement's payroll
   * month, if any -- must be a member of processedAllocations too. */
  currentMonthAllocation: StatementAllocation | null;
  statementMonth: string;
}

export interface TerminalDuesStatementSummary {
  totalProcessedToDate: number;
  outstandingBalance: number;
  isFullySettled: boolean;
  settlementBasis: string;
  priorProcessedAllocations: StatementAllocation[];
}

/**
 * Pure derivation of the statement's summary figures -- total processed,
 * outstanding balance, and a plain-language settlement basis string.
 * "Fully settled" requires total processed >= the final approved
 * entitlement; never claims a bank payment, only that payroll processing
 * has run for the full amount.
 */
export function summarizeTerminalDuesStatement(input: TerminalDuesStatementInput): TerminalDuesStatementSummary {
  const totalProcessedToDate = input.processedAllocations.reduce((sum, a) => sum + a.amount, 0);
  const outstandingBalance = Math.max(0, input.entitlement.finalApprovedEntitlement - totalProcessedToDate);
  const isFullySettled = totalProcessedToDate > 0 && totalProcessedToDate >= input.entitlement.finalApprovedEntitlement;

  const priorProcessedAllocations = input.currentMonthAllocation
    ? input.processedAllocations.filter(a => a !== input.currentMonthAllocation)
    : input.processedAllocations;

  let settlementBasis: string;
  if (isFullySettled) {
    const last = input.processedAllocations[input.processedAllocations.length - 1];
    settlementBasis = last
      ? `Settled by Payroll Processing -- reference ${last.processingReference || '(none)'}, ${getMonthLabel(last.payrollMonth)}`
      : 'Settled by Payroll Processing';
  } else if (totalProcessedToDate > 0) {
    settlementBasis = 'Partially processed -- further payment(s) expected';
  } else {
    settlementBasis = 'Not yet processed';
  }

  return { totalProcessedToDate, outstandingBalance, isFullySettled, settlementBasis, priorProcessedAllocations };
}
