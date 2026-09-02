import { canAccess, PERMISSIONS } from './permissions';
import { canApprovePayroll as canApprovePayrollFor } from './payrollPermissions';
import { UserProfile } from './currentProfile';

export interface DashboardPermissions {
  canViewPayroll: boolean;
  canViewAttendance: boolean;
  canViewRecruitment: boolean;
  canViewSecurity: boolean;
  // Separate from canViewPayroll: payroll.approve (legacy role_level === 1)
  // is strictly narrower than payroll.view. Resolved via the SAME
  // canApprovePayrollFor() function Payroll.tsx itself uses for its own
  // Approve button, so this can never drift from what the real action is
  // actually gated by.
  canApprovePayroll: boolean;
}

// Fail-closed by design: an error resolving any of the underlying
// canAccess() calls must never leave a flag at a stale/true value --
// Dashboard.tsx gates its Payroll fetch, Attendance fetch, and the
// get_applicant_dashboard_counts() RPC call directly on these flags (not
// merely on whether the returned data is later rendered), so a wrong
// "true" here would mean a forbidden request actually being sent, not
// just a forbidden value being displayed. canViewSecurity additionally
// gates the static "Renew Expiring Licenses" pending-task item (a
// Security Personnel concern) from being shown to a role with no
// security_personnel access at all -- it does not gate any data fetch,
// since Dashboard.tsx makes no security_personnel query today.
export async function resolveDashboardPermissions(profile: UserProfile | null): Promise<DashboardPermissions> {
  try {
    const isLegacy = (profile?.role_level ?? null) !== null;
    const roleContext = { isSuperAdmin: profile?.is_super_admin || false, roleLevel: profile?.role_level || 4 };
    const [canViewPayroll, canViewAttendance, canViewRecruitment, canViewSecurity] = await Promise.all([
      canAccess(isLegacy, PERMISSIONS.PAYROLL_VIEW),
      canAccess(isLegacy, PERMISSIONS.ATTENDANCE_VIEW),
      canAccess(isLegacy, PERMISSIONS.RECRUITMENT_VIEW),
      canAccess(isLegacy, PERMISSIONS.SECURITY_PERSONNEL_VIEW),
    ]);
    const canApprovePayroll = await canAccess(canApprovePayrollFor(roleContext), PERMISSIONS.PAYROLL_APPROVE);
    return { canViewPayroll, canViewAttendance, canViewRecruitment, canViewSecurity, canApprovePayroll };
  } catch (err) {
    console.error('Error resolving dashboard permissions:', err);
    return { canViewPayroll: false, canViewAttendance: false, canViewRecruitment: false, canViewSecurity: false, canApprovePayroll: false };
  }
}

export interface PendingTask {
  key: 'approve-payroll' | 'review-applications' | 'renew-licenses';
  title: string;
  due: string;
  priority: 'high' | 'medium';
  count: number;
}

// Inputs for buildPendingTasks(): permission flags PLUS the real pending
// counts each task represents. A task's own `visible` rule is always
// "authorized for the action AND count > 0" -- never permission alone.
// "Process Leave Requests" (the original 4th static demo task) is
// deliberately REMOVED, not merely gated: no leave-management feature,
// table, or permission exists anywhere in this app (confirmed by
// inspecting permissions.ts's full PERMISSIONS list and every page in
// src/pages) to determine who is responsible for it or whether anything
// is actually pending -- showing it to anyone, gated or not, would be
// decorative, not data-driven. If a real leave-management feature is
// ever built, this task belongs back here then, backed by real data.
export interface PendingTaskInputs {
  canApprovePayroll: boolean;
  pendingPayrollApprovalCount: number;
  canViewRecruitment: boolean;
  pendingRecruitmentCount: number;
  canViewSecurity: boolean;
  expiringLicensesCount: number;
}

export function buildPendingTasks(inputs: PendingTaskInputs): PendingTask[] {
  const allTasks: (PendingTask & { visible: boolean })[] = [
    {
      key: 'approve-payroll', title: 'Approve Payroll', due: 'Today', priority: 'high',
      count: inputs.pendingPayrollApprovalCount,
      visible: inputs.canApprovePayroll && inputs.pendingPayrollApprovalCount > 0,
    },
    {
      key: 'review-applications', title: 'Review Job Applications', due: 'Tomorrow', priority: 'medium',
      count: inputs.pendingRecruitmentCount,
      visible: inputs.canViewRecruitment && inputs.pendingRecruitmentCount > 0,
    },
    {
      key: 'renew-licenses', title: 'Renew Expiring Licenses', due: 'This Week', priority: 'high',
      count: inputs.expiringLicensesCount,
      visible: inputs.canViewSecurity && inputs.expiringLicensesCount > 0,
    },
  ];
  return allTasks.filter(task => task.visible).map(({ visible: _visible, ...task }) => task);
}
