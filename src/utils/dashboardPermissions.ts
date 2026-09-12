import { canAccess, hasExplicitPermission, PERMISSIONS } from './permissions';
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
  // Terminal Dues approve/pay: resolved via hasExplicitPermission(), the
  // SAME narrow helper TerminalDues.tsx itself uses for its Approve/Record
  // Payment actions (see permissions.ts) -- deliberately NOT canAccess()/
  // hasPermission(), which would grant these "for free" to a business
  // admin/legacy role_level<=2 account the same way TerminalDues.tsx's own
  // Edit/Create checks used to (the bug this pass fixes). Only a true
  // super admin or an account with an explicit terminal_dues.approve/.pay
  // role_permissions row gets a task here -- an HR Manager (view/create/
  // edit only) never does.
  canApproveTerminalDues: boolean;
  canPayTerminalDues: boolean;
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
    const [canApproveTerminalDues, canPayTerminalDues] = await Promise.all([
      hasExplicitPermission(PERMISSIONS.TERMINAL_DUES_APPROVE),
      hasExplicitPermission(PERMISSIONS.TERMINAL_DUES_PAY),
    ]);
    return { canViewPayroll, canViewAttendance, canViewRecruitment, canViewSecurity, canApprovePayroll, canApproveTerminalDues, canPayTerminalDues };
  } catch (err) {
    console.error('Error resolving dashboard permissions:', err);
    return { canViewPayroll: false, canViewAttendance: false, canViewRecruitment: false, canViewSecurity: false, canApprovePayroll: false, canApproveTerminalDues: false, canPayTerminalDues: false };
  }
}

export interface PendingTask {
  key: 'approve-payroll' | 'review-applications' | 'renew-licenses' | 'approve-terminal-dues' | 'pay-terminal-dues';
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
  // Terminal Dues: a real, actionable count (rows the caller is actually
  // authorized to see, per RLS -- tenant/region/permission), never derived
  // from employee headcount. canApproveTerminalDues/canPayTerminalDues come
  // from hasExplicitPermission() (see resolveDashboardPermissions above),
  // so an HR Manager -- who can view/create/edit but holds neither
  // permission -- never gets either task, regardless of how many Pending
  // or Approved rows exist.
  canApproveTerminalDues: boolean;
  pendingTerminalDuesApprovalCount: number;
  canPayTerminalDues: boolean;
  approvedTerminalDuesPaymentCount: number;
}

export function buildPendingTasks(inputs: PendingTaskInputs): PendingTask[] {
  // inputs.pendingPayrollApprovalCount counts DISTINCT payroll months/runs
  // awaiting approval, not employee rows (see Dashboard.tsx's own
  // pendingPayrollMonthKeys comment) -- so the title itself must say
  // "month(s)"/"period(s)", not just show a bare number next to "Approve
  // Payroll", or a reader would reasonably assume it means employees.
  const payrollTaskTitle = inputs.pendingPayrollApprovalCount === 1
    ? 'Payroll Awaiting Approval'
    : 'Payroll Periods Awaiting Approval';
  const allTasks: (PendingTask & { visible: boolean })[] = [
    {
      key: 'approve-payroll', title: payrollTaskTitle, due: 'Today', priority: 'high',
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
    {
      key: 'approve-terminal-dues', title: 'Terminal Dues Awaiting Approval', due: 'Today', priority: 'high',
      count: inputs.pendingTerminalDuesApprovalCount,
      visible: inputs.canApproveTerminalDues && inputs.pendingTerminalDuesApprovalCount > 0,
    },
    {
      key: 'pay-terminal-dues', title: 'Terminal Dues Awaiting Payment', due: 'This Week', priority: 'high',
      count: inputs.approvedTerminalDuesPaymentCount,
      visible: inputs.canPayTerminalDues && inputs.approvedTerminalDuesPaymentCount > 0,
    },
  ];
  return allTasks.filter(task => task.visible).map(({ visible: _visible, ...task }) => task);
}
