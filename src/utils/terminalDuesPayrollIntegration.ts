// Terminal Dues Phase 3A -- pure, testable eligibility/exception
// detection for the "Terminal Dues summary" shown before Process
// Payroll runs. This is DISPLAY-ONLY: process_terminal_due_allocations_batch()
// (supabase/migrations/20261026000000_terminal_dues_payroll_processing.sql)
// re-validates everything itself, server-side, before writing anything --
// this module exists so the UI can show the same picture (eligible
// count/total, exceptions, carried-forward count) without a round trip,
// never so the server can skip its own checks.
export type TerminalDueAllocationStatus = 'submitted' | 'approved' | 'rejected' | 'held' | 'processed' | 'excluded';

export interface TerminalDueAllocationForSummary {
  id: string;
  terminal_due_id: string;
  status: TerminalDueAllocationStatus;
  proposed_amount: number;
  carried_forward_from_id: string | null;
  employee_name: string;
  employee_number: string | null;
}

export interface TerminalDueEntitlementForSummary {
  id: string;
  status: 'pending' | 'approved' | 'paid';
  total_payable: number;
  has_pending_revision: boolean;
  /** Sum of this entitlement's own already-processed allocations, across
   *  every month -- the true outstanding balance never derives from
   *  merely-approved amounts (approving an allocation never reduces it). */
  already_processed_total: number;
}

export type TerminalDueExceptionReason =
  | 'entitlement_not_approved'
  | 'pending_revision'
  | 'exceeds_outstanding_balance';

export interface TerminalDueProcessingException {
  allocationId: string;
  employeeName: string;
  employeeNumber: string | null;
  proposedAmount: number;
  reason: TerminalDueExceptionReason;
  message: string;
}

export interface TerminalDuePayrollSummary {
  eligibleCount: number;
  eligibleTotal: number;
  exceptions: TerminalDueProcessingException[];
  carriedForwardCount: number;
}

function describeException(reason: TerminalDueExceptionReason, entitlement: TerminalDueEntitlementForSummary): string {
  switch (reason) {
    case 'entitlement_not_approved':
      return `The underlying entitlement is no longer approved (status: ${entitlement.status}) -- resolve this or exclude the allocation to continue.`;
    case 'pending_revision':
      return 'This entitlement has a pending revision awaiting Admin review -- decide the revision first, or exclude the allocation to continue.';
    case 'exceeds_outstanding_balance':
      return `Processing this amount would exceed the entitlement's approved total -- correct the allocation or exclude it to continue.`;
  }
}

/**
 * Classifies every 'approved' allocation for the active month as either
 * eligible (will be processed) or an exception (blocks the whole batch
 * unless explicitly excluded) -- mirroring, for display purposes only,
 * the exact checks process_terminal_due_allocations_batch() itself
 * performs server-side. Submitted/rejected/held/processed/excluded rows
 * are never candidates at all (same as the RPC's own WHERE clause), so
 * they contribute to neither eligibleCount nor exceptions.
 */
export function summarizeTerminalDuePayrollBatch(
  allocations: TerminalDueAllocationForSummary[],
  entitlementsById: Map<string, TerminalDueEntitlementForSummary>
): TerminalDuePayrollSummary {
  let eligibleCount = 0;
  let eligibleTotal = 0;
  let carriedForwardCount = 0;
  const exceptions: TerminalDueProcessingException[] = [];

  for (const alloc of allocations) {
    if (alloc.carried_forward_from_id) {
      carriedForwardCount += 1;
    }

    if (alloc.status !== 'approved') continue;

    const entitlement = entitlementsById.get(alloc.terminal_due_id);
    let reason: TerminalDueExceptionReason | null = null;

    if (!entitlement || entitlement.status !== 'approved') {
      reason = 'entitlement_not_approved';
    } else if (entitlement.has_pending_revision) {
      reason = 'pending_revision';
    } else if (entitlement.already_processed_total + alloc.proposed_amount > entitlement.total_payable) {
      reason = 'exceeds_outstanding_balance';
    }

    if (reason) {
      exceptions.push({
        allocationId: alloc.id,
        employeeName: alloc.employee_name,
        employeeNumber: alloc.employee_number,
        proposedAmount: alloc.proposed_amount,
        reason,
        message: describeException(reason, entitlement ?? { id: alloc.terminal_due_id, status: 'pending', total_payable: 0, has_pending_revision: false, already_processed_total: 0 }),
      });
    } else {
      eligibleCount += 1;
      eligibleTotal += alloc.proposed_amount;
    }
  }

  return { eligibleCount, eligibleTotal, exceptions, carriedForwardCount };
}

export interface CombinedPayrollTotals {
  ordinaryPayrollTotal: number;
  terminalDuesTotal: number;
  combinedTotal: number;
}

export function computeCombinedPayrollTotals(ordinaryPayrollTotal: number, terminalDuesEligibleTotal: number): CombinedPayrollTotals {
  return {
    ordinaryPayrollTotal,
    terminalDuesTotal: terminalDuesEligibleTotal,
    combinedTotal: ordinaryPayrollTotal + terminalDuesEligibleTotal,
  };
}
