import { canAccess, PERMISSIONS } from './permissions';
import { UserProfile } from './currentProfile';

export interface DashboardPermissions {
  canViewPayroll: boolean;
  canViewAttendance: boolean;
  canViewRecruitment: boolean;
  canViewSecurity: boolean;
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
    const [canViewPayroll, canViewAttendance, canViewRecruitment, canViewSecurity] = await Promise.all([
      canAccess(isLegacy, PERMISSIONS.PAYROLL_VIEW),
      canAccess(isLegacy, PERMISSIONS.ATTENDANCE_VIEW),
      canAccess(isLegacy, PERMISSIONS.RECRUITMENT_VIEW),
      canAccess(isLegacy, PERMISSIONS.SECURITY_PERSONNEL_VIEW),
    ]);
    return { canViewPayroll, canViewAttendance, canViewRecruitment, canViewSecurity };
  } catch (err) {
    console.error('Error resolving dashboard permissions:', err);
    return { canViewPayroll: false, canViewAttendance: false, canViewRecruitment: false, canViewSecurity: false };
  }
}

export interface PendingTask {
  key: 'approve-payroll' | 'review-applications' | 'process-leave' | 'renew-licenses';
  title: string;
  due: string;
  priority: 'high' | 'medium';
}

// Dashboard.tsx's static "Pending Tasks" widget, gated by the same
// DashboardPermissions flags it already uses to gate its own data
// fetches -- extracted so the filtering logic is independently
// unit-testable without rendering the page. "Process Leave Requests" is
// deliberately left ungated: no leave-management feature or permission
// exists anywhere in this app to gate it against (confirmed by
// inspecting permissions.ts's full PERMISSIONS list and every page in
// src/pages) -- inventing one here would be a business rule this audit
// has no source for.
export function buildPendingTasks(permissions: DashboardPermissions): PendingTask[] {
  const allTasks: (PendingTask & { visible: boolean })[] = [
    { key: 'approve-payroll', title: 'Approve Payroll', due: 'Today', priority: 'high', visible: permissions.canViewPayroll },
    { key: 'review-applications', title: 'Review Job Applications', due: 'Tomorrow', priority: 'medium', visible: permissions.canViewRecruitment },
    { key: 'process-leave', title: 'Process Leave Requests', due: '2 days', priority: 'medium', visible: true },
    { key: 'renew-licenses', title: 'Renew Expiring Licenses', due: 'This Week', priority: 'high', visible: permissions.canViewSecurity },
  ];
  return allTasks.filter(task => task.visible).map(({ visible: _visible, ...task }) => task);
}
