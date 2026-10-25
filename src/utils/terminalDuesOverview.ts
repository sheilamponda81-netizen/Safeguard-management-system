// Terminal Dues Records -- Management Financial Overview.
//
// Pure, display-only aggregation over the SAME authoritative sources the
// rest of the Terminal Dues UI already uses -- this module invents no new
// money. The ledger principles mirror TerminalDuesAllocations.tsx's own
// reservedByEntitlement/processedByEntitlement and
// TerminalDuesPaymentHistoryTab's outstanding-balance calculation, and the
// outstanding-balance formula (total_payable - processed) matches the
// server-side balance check added by
// 20261103000000_terminal_dues_allocation_balance_processed_fix.sql.
//
// THREE authoritative facts, never recomputed here, only read:
//   1. terminal_dues.status: 'pending' (not yet a confirmed liability),
//      'approved' (confirmed; total_payable is authoritative until a
//      revision is APPROVED, which replaces it in place), or 'paid'
//      (legacy one-shot payment via record_terminal_due_payment() -- this
//      status is reachable ONLY for an entitlement with no linked modern
//      terminal_due_calculations row, per the legacy payment guard,
//      20261021000001_terminal_dues_legacy_payment_guard.sql).
//   2. terminal_due_allocations rows for an 'approved' entitlement:
//      'processed' = actually paid via Process Payroll; 'approved' =
//      reserved/committed but NOT yet paid; 'submitted'/'held'/'rejected'/
//      'excluded' never count toward anything paid or reserved.
//   3. A legacy 'paid' row's evidence (payment_date/payment_method/
//      payment_reference/paid_at) is the ONLY record of that payment --
//      there is no allocation ledger entry for it by design, so its full
//      total_payable is treated as actually paid, never invented or
//      assumed to be zero just because the ledger is empty for it.
export type TerminalDueRecordStatus = 'pending' | 'approved' | 'paid';
export type TerminalDueAllocationLedgerStatus = 'submitted' | 'approved' | 'rejected' | 'held' | 'processed' | 'excluded';

export interface OverviewEntitlement {
  id: string;
  status: TerminalDueRecordStatus;
  total_payable: number;
}

export interface OverviewAllocation {
  terminal_due_id: string;
  status: TerminalDueAllocationLedgerStatus;
  proposed_amount: number;
  last_decided_amount: number | null;
}

export type SettlementStatus = 'pending_approval' | 'not_yet_processed' | 'partially_processed' | 'fully_settled';

export interface EntitlementFinancials {
  totalEntitlement: number;
  /** Confirmed, already-paid amount: the full legacy amount for a 'paid'
   *  row, or the sum of 'processed' allocations for an 'approved' row.
   *  Never includes merely-approved/reserved amounts. */
  actuallyPaid: number;
  /** Approved allocations not yet processed by Process Payroll -- reserved
   *  against the entitlement, explicitly NOT paid. Always 0 for a
   *  'pending' or legacy 'paid' entitlement. */
  approvedUnprocessed: number;
  /** total_payable - actuallyPaid, clamped to >= 0. 0 for a 'pending'
   *  entitlement (not yet a confirmed liability at all). */
  remainingLiability: number;
  /** What could still be allocated for a future payroll month:
   *  total_payable - actuallyPaid - approvedUnprocessed, clamped to >= 0. */
  availableForFutureAllocation: number;
  /** True only for a legacy one-shot payment (status === 'paid'). */
  isLegacyPaid: boolean;
  /** True when a legacy 'paid' row ALSO has allocation ledger rows -- a
   *  state the schema does not prevent but which should never happen in
   *  practice (see the legacy payment guard's own scope note). Surfaced as
   *  an explicit reconciliation warning, never silently resolved by
   *  inventing which figure is "right". */
  hasLedgerConflict: boolean;
  settlementStatus: SettlementStatus;
}

function allocationAmount(a: OverviewAllocation): number {
  return Number(a.last_decided_amount ?? a.proposed_amount);
}

/**
 * Computes the five distinct financial figures for one entitlement, given
 * only the allocation rows that belong to it. Callers must pre-filter
 * `allocations` to `a.terminal_due_id === entitlement.id` -- this function
 * does not filter by id itself so it stays usable from a single grouped
 * pass (see summarizeTerminalDuesOverview).
 */
export function computeEntitlementFinancials(
  entitlement: OverviewEntitlement,
  allocations: OverviewAllocation[]
): EntitlementFinancials {
  const totalEntitlement = Number(entitlement.total_payable) || 0;

  if (entitlement.status === 'pending') {
    return {
      totalEntitlement,
      actuallyPaid: 0,
      approvedUnprocessed: 0,
      remainingLiability: 0,
      availableForFutureAllocation: 0,
      isLegacyPaid: false,
      hasLedgerConflict: false,
      settlementStatus: 'pending_approval',
    };
  }

  if (entitlement.status === 'paid') {
    return {
      totalEntitlement,
      actuallyPaid: totalEntitlement,
      approvedUnprocessed: 0,
      remainingLiability: 0,
      availableForFutureAllocation: 0,
      isLegacyPaid: true,
      hasLedgerConflict: allocations.length > 0,
      settlementStatus: 'fully_settled',
    };
  }

  // status === 'approved'
  const processedSum = allocations.filter(a => a.status === 'processed').reduce((sum, a) => sum + allocationAmount(a), 0);
  const approvedSum = allocations.filter(a => a.status === 'approved').reduce((sum, a) => sum + allocationAmount(a), 0);

  const remainingLiability = Math.max(0, totalEntitlement - processedSum);
  const availableForFutureAllocation = Math.max(0, totalEntitlement - processedSum - approvedSum);
  const settlementStatus: SettlementStatus =
    processedSum > 0 && processedSum >= totalEntitlement
      ? 'fully_settled'
      : processedSum > 0 || approvedSum > 0
        ? 'partially_processed'
        : 'not_yet_processed';

  return {
    totalEntitlement,
    actuallyPaid: processedSum,
    approvedUnprocessed: approvedSum,
    remainingLiability,
    availableForFutureAllocation,
    isLegacyPaid: false,
    hasLedgerConflict: false,
    settlementStatus,
  };
}

export interface TerminalDuesOverviewSummary {
  /** A. Sum of total_payable for every 'approved' or 'paid' entitlement
   *  (i.e. every entitlement that is a confirmed liability) and their
   *  count -- a 'pending' entitlement is excluded entirely, never counted
   *  as zero within this total (it simply isn't part of it). */
  confirmedEntitlementTotal: number;
  confirmedEntitlementCount: number;
  /** B. Sum of actuallyPaid across every confirmed entitlement. */
  actuallyPaidTotal: number;
  /** C. Sum of remainingLiability across every confirmed entitlement. */
  remainingLiabilityTotal: number;
  /** D. Sum of approvedUnprocessed across every confirmed entitlement --
   *  reserved/approved for an upcoming payroll run, never paid. */
  approvedForPayrollTotal: number;
  /** E. actuallyPaidTotal / confirmedEntitlementTotal * 100, 0 when the
   *  denominator is 0 (never NaN/Infinity). */
  settlementProgressPct: number;
  pendingApprovalCount: number;
  pendingApprovalTotal: number;
  /** Entitlements whose legacy 'paid' status conflicts with the presence
   *  of allocation ledger rows -- see hasLedgerConflict. */
  ledgerConflictCount: number;
}

export function summarizeTerminalDuesOverview(
  entitlements: OverviewEntitlement[],
  allocations: OverviewAllocation[]
): TerminalDuesOverviewSummary {
  const allocationsByEntitlement = new Map<string, OverviewAllocation[]>();
  for (const a of allocations) {
    const list = allocationsByEntitlement.get(a.terminal_due_id) || [];
    list.push(a);
    allocationsByEntitlement.set(a.terminal_due_id, list);
  }

  let confirmedEntitlementTotal = 0;
  let confirmedEntitlementCount = 0;
  let actuallyPaidTotal = 0;
  let remainingLiabilityTotal = 0;
  let approvedForPayrollTotal = 0;
  let pendingApprovalCount = 0;
  let pendingApprovalTotal = 0;
  let ledgerConflictCount = 0;

  for (const e of entitlements) {
    const financials = computeEntitlementFinancials(e, allocationsByEntitlement.get(e.id) || []);
    if (e.status === 'pending') {
      pendingApprovalCount += 1;
      pendingApprovalTotal += financials.totalEntitlement;
      continue;
    }
    confirmedEntitlementCount += 1;
    confirmedEntitlementTotal += financials.totalEntitlement;
    actuallyPaidTotal += financials.actuallyPaid;
    remainingLiabilityTotal += financials.remainingLiability;
    approvedForPayrollTotal += financials.approvedUnprocessed;
    if (financials.hasLedgerConflict) ledgerConflictCount += 1;
  }

  const settlementProgressPct = confirmedEntitlementTotal > 0
    ? Math.min(100, (actuallyPaidTotal / confirmedEntitlementTotal) * 100)
    : 0;

  return {
    confirmedEntitlementTotal,
    confirmedEntitlementCount,
    actuallyPaidTotal,
    remainingLiabilityTotal,
    approvedForPayrollTotal,
    settlementProgressPct,
    pendingApprovalCount,
    pendingApprovalTotal,
    ledgerConflictCount,
  };
}

// ---------------------------------------------------------------------------
// Interactive status filters (Step 3). "Rejected" is deliberately not one
// of these -- terminal_dues.status has no 'rejected' value; the closest
// real transition (Admin "Return for Correction") sends an approved row
// back to 'pending' with a return_reason, which the Pending Approval
// filter and the existing returned-for-correction banner already surface.
// Inventing a separate Rejected bucket here would not reflect the
// authoritative schema.
// ---------------------------------------------------------------------------
export type OverviewFilter = 'all' | 'pending_approval' | 'outstanding' | 'fully_settled';

export function matchesOverviewFilter(
  filter: OverviewFilter,
  entitlement: OverviewEntitlement,
  financials: EntitlementFinancials
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'pending_approval':
      return entitlement.status === 'pending';
    case 'outstanding':
      // "Unpaid and partially paid approved entitlements" -- never a
      // 'pending' entitlement (it isn't approved yet) and never one
      // that is already fully settled.
      return entitlement.status === 'approved' && financials.settlementStatus !== 'fully_settled';
    case 'fully_settled':
      return financials.settlementStatus === 'fully_settled';
  }
}
