// Pure row/detail-action visibility rules for Terminal Dues, extracted so
// the exact responsibility-model boundary (HR: create/edit Pending only;
// Admin: approve Pending, return Approved for correction, NEVER create/
// edit/pay; Accountant: record payment on Approved only, NEVER create/
// edit/approve) is testable independent of React and Supabase, and lives
// in exactly one place rather than duplicated inline in TerminalDues.tsx's
// row and detail-modal JSX.
//
// The four inputs are themselves ALL resolved via hasExplicitPermission()
// in TerminalDues.tsx (see its fetchUserProfile()) -- this module does not
// re-derive them from a role or role_level, only from the already-resolved
// booleans, so it can never reintroduce the business-admin/legacy-role
// shortcut bug this fix removes (a functional Admin seeing the Edit
// pencil because hasPermission()'s is_business_admin() shortcut granted
// terminal_dues.edit "for free").
export interface TerminalDuePermissions {
  canCreate: boolean;
  canEdit: boolean;
  canApprove: boolean;
  canPay: boolean;
}

export type TerminalDueStatus = 'pending' | 'approved' | 'paid';

export interface TerminalDueRowActions {
  showEdit: boolean;
  showApprove: boolean;
  showReturnForCorrection: boolean;
  showRecordPayment: boolean;
}

export function getVisibleTerminalDueActions(
  status: TerminalDueStatus,
  perms: TerminalDuePermissions
): TerminalDueRowActions {
  return {
    showEdit: perms.canEdit && status === 'pending',
    showApprove: perms.canApprove && status === 'pending',
    showReturnForCorrection: perms.canApprove && status === 'approved',
    showRecordPayment: perms.canPay && status === 'approved',
  };
}

// Whether the "RETURNED FOR CORRECTION" panel belongs in View Details.
// return_reason (20260907000000) is populated by
// return_terminal_due_for_correction() and cleared by
// approve_terminal_due() on re-approval, so it is non-null ONLY while a
// Pending row is CURRENTLY awaiting correction -- an ordinary Pending
// record that was never returned has return_reason NULL and this
// correctly returns false. The status check is redundant with that
// invariant (return_reason is always cleared before a row leaves
// Pending) but kept explicit as a second, independent guard: this panel
// must never render on an Approved or Paid row even if some future bug
// left a stale return_reason behind.
export function shouldShowReturnedForCorrectionBanner(
  status: TerminalDueStatus,
  returnReason: string | null
): boolean {
  return status === 'pending' && !!returnReason;
}
