// Extracted from Payroll.tsx's fetchUserProfile() (the canProcessPayroll/
// canEditPayroll/canViewPayroll/canApprovePayroll booleans) and its
// isMonthApproved/isPendingApproval useMemo values, so this permission
// and approval-status logic is unit-testable without rendering the page
// or touching Supabase. Behavior is unchanged -- these are the exact
// same conditions, just as standalone functions.

export interface RoleContext {
  isSuperAdmin: boolean;
  roleLevel: number;
}

/** Only Admin (role_level 1) or a super admin may process/reprocess payroll. */
export function canProcessPayroll({ isSuperAdmin, roleLevel }: RoleContext): boolean {
  return isSuperAdmin || roleLevel === 1;
}

/** Admin or Manager (role_level <= 2) may edit payroll entries before processing. */
export function canEditPayroll({ isSuperAdmin, roleLevel }: RoleContext): boolean {
  return isSuperAdmin || roleLevel <= 2;
}

/** Admin, Manager, or Supervisor (role_level <= 3) may view payroll. */
export function canViewPayroll({ isSuperAdmin, roleLevel }: RoleContext): boolean {
  return isSuperAdmin || roleLevel <= 3;
}

/** Only Admin (role_level 1) or a super admin may approve/reject payroll. */
export function canApprovePayroll({ isSuperAdmin, roleLevel }: RoleContext): boolean {
  return isSuperAdmin || roleLevel === 1;
}

export interface PayrollApprovalRecord {
  approval_status?: string;
}

/**
 * A month counts as approved only when there ARE records and every one of
 * them is approved -- an empty payroll run is never "approved" (there's
 * nothing to have approved).
 */
export function isMonthApproved(records: PayrollApprovalRecord[]): boolean {
  return records.length > 0 && records.every((record) => record.approval_status === 'approved');
}

/**
 * Pending approval means there ARE records, the month isn't already fully
 * approved, and at least one record is still not approved (covers both
 * "all pending" and a partially-approved batch).
 */
export function isPendingApproval(records: PayrollApprovalRecord[]): boolean {
  return records.length > 0 && !isMonthApproved(records) && records.some((record) => record.approval_status !== 'approved');
}
