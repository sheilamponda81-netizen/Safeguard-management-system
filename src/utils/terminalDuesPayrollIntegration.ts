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

// ---------------------------------------------------------------------------
// Pre-submission Terminal Dues preview (Payroll.tsx main page, before any
// processing request exists or the confirm modal is opened). DISPLAY-ONLY,
// same as the rest of this module -- an informational estimate, never the
// authority. The authoritative figures remain compute_payroll_request_snapshot()
// (captured into payroll_processing_requests.financial_snapshot at submission)
// and process_terminal_due_allocations_batch() (at actual processing); this
// function duplicates none of their logic, it only summarizes the caller's
// already-fetched `terminal_due_allocations` rows for the active month.
// ---------------------------------------------------------------------------

export interface TerminalDuePreviewDueInfo {
  employee_name: string;
  employee_number: string | null;
  historical_employee_id: string | null;
}

export interface TerminalDuePreviewAllocation {
  id: string;
  terminal_due_id: string;
  status: TerminalDueAllocationStatus;
  proposed_amount: number;
  last_decided_amount: number | null;
}

export interface TerminalDuePreviewRecipient {
  terminalDueId: string;
  employeeName: string;
  employeeNumber: string | null;
  isHistorical: boolean;
  amount: number;
  /** Only 'approved' or 'processed' rows ever reach this list -- the
   * caller queries exactly those two statuses, and this function also
   * defensively ignores any other status rather than trusting the
   * caller's filter alone. */
  status: 'approved' | 'processed';
}

export interface TerminalDuePayrollPreview {
  /** Count/total of 'approved' (not yet processed) allocations only --
   * 'processed' allocations are deliberately excluded from both, per the
   * requirement to show them separately from the still-pending amount. */
  approvedUnprocessedCount: number;
  approvedUnprocessedTotal: number;
  /** Every 'approved' or 'processed' recipient for the month, sorted by
   * name, each carrying its own status so the two groups can still be
   * told apart in a single compact list. One row per entitlement per
   * month by schema design (terminal_due_allocations has at most one row
   * per (terminal_due_id, payroll_month)), so summing this list never
   * double-counts a recipient. */
  recipients: TerminalDuePreviewRecipient[];
}

/**
 * Builds the compact pre-submission preview from allocation rows already
 * scoped by the caller to one payroll month (so another month's rows are
 * never included) and to 'approved'/'processed' status (so rejected,
 * submitted-but-unapproved, held, or excluded rows are never included in
 * the payable total or the recipient list). Historical and terminated
 * recipients are supported identically to active ones -- `employee_name`/
 * `employee_number` are read directly from the denormalized columns on
 * `terminal_dues` regardless of whether `employee_id` or
 * `historical_employee_id` is set, exactly as the rest of the Terminal
 * Dues UI already does.
 */
export function buildTerminalDuePayrollPreview(
  allocations: TerminalDuePreviewAllocation[],
  dueById: Map<string, TerminalDuePreviewDueInfo>
): TerminalDuePayrollPreview {
  let approvedUnprocessedCount = 0;
  let approvedUnprocessedTotal = 0;
  const recipients: TerminalDuePreviewRecipient[] = [];

  for (const a of allocations) {
    if (a.status !== 'approved' && a.status !== 'processed') continue;

    const due = dueById.get(a.terminal_due_id);
    const amount = Number(a.last_decided_amount ?? a.proposed_amount);

    if (a.status === 'approved') {
      approvedUnprocessedCount += 1;
      approvedUnprocessedTotal += amount;
    }

    recipients.push({
      terminalDueId: a.terminal_due_id,
      employeeName: due?.employee_name || 'Unknown',
      employeeNumber: due?.employee_number ?? null,
      isHistorical: !!due?.historical_employee_id,
      amount,
      status: a.status,
    });
  }

  recipients.sort((a, b) => a.employeeName.localeCompare(b.employeeName));

  return { approvedUnprocessedCount, approvedUnprocessedTotal, recipients };
}
