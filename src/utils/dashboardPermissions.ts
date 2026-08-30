import { canAccess, PERMISSIONS } from './permissions';
import { UserProfile } from './currentProfile';

export interface DashboardPermissions {
  canViewPayroll: boolean;
  canViewAttendance: boolean;
  canViewRecruitment: boolean;
}

// Fail-closed by design: an error resolving any of the three underlying
// canAccess() calls must never leave a flag at a stale/true value --
// Dashboard.tsx gates its Payroll fetch, Attendance fetch, and the
// get_applicant_dashboard_counts() RPC call directly on these flags (not
// merely on whether the returned data is later rendered), so a wrong
// "true" here would mean a forbidden request actually being sent, not
// just a forbidden value being displayed.
export async function resolveDashboardPermissions(profile: UserProfile | null): Promise<DashboardPermissions> {
  try {
    const isLegacy = (profile?.role_level ?? null) !== null;
    const [canViewPayroll, canViewAttendance, canViewRecruitment] = await Promise.all([
      canAccess(isLegacy, PERMISSIONS.PAYROLL_VIEW),
      canAccess(isLegacy, PERMISSIONS.ATTENDANCE_VIEW),
      canAccess(isLegacy, PERMISSIONS.RECRUITMENT_VIEW),
    ]);
    return { canViewPayroll, canViewAttendance, canViewRecruitment };
  } catch (err) {
    console.error('Error resolving dashboard permissions:', err);
    return { canViewPayroll: false, canViewAttendance: false, canViewRecruitment: false };
  }
}
