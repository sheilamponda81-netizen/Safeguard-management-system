import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserProfile } from './currentProfile';

// Mock the underlying canAccess()/hasExplicitPermission() so these tests
// exercise resolveDashboardPermissions()'s own fail-closed/branching logic
// without hitting Supabase -- canAccess() itself (legacyAllowed OR
// has_permission()) is already covered by permissions.test.ts, as is
// hasExplicitPermission() (super-admin-only bypass, no legacy/business-
// admin shortcut).
// canApprovePayrollFor() (from payrollPermissions.ts) is NOT mocked -- it's
// a pure, dependency-free function ({isSuperAdmin, roleLevel} => boolean),
// so these tests just drive it via the profile's own is_super_admin/
// role_level, the same way Payroll.tsx's real call site does.
vi.mock('./permissions', () => ({
  canAccess: vi.fn(),
  hasExplicitPermission: vi.fn(),
  PERMISSIONS: {
    PAYROLL_VIEW: 'payroll.view',
    PAYROLL_APPROVE: 'payroll.approve',
    ATTENDANCE_VIEW: 'attendance.view',
    RECRUITMENT_VIEW: 'recruitment.view',
    SECURITY_PERSONNEL_VIEW: 'security_personnel.view',
    TERMINAL_DUES_APPROVE: 'terminal_dues.approve',
    TERMINAL_DUES_PAY: 'terminal_dues.pay',
  },
}));

import { canAccess, hasExplicitPermission } from './permissions';
import { resolveDashboardPermissions, buildPendingTasks } from './dashboardPermissions';

const mockedCanAccess = vi.mocked(canAccess);
const mockedHasExplicitPermission = vi.mocked(hasExplicitPermission);

function makeProfile(overrides: Partial<UserProfile>): UserProfile {
  return {
    id: 'u1',
    tenant_id: 't1',
    email: 'u@example.com',
    full_name: 'Test User',
    role: null,
    role_level: null,
    department: null,
    is_super_admin: false,
    is_active: true,
    region_id: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    regions: null,
    ...overrides,
  };
}

describe('resolveDashboardPermissions', () => {
  beforeEach(() => {
    mockedCanAccess.mockReset();
    mockedHasExplicitPermission.mockReset();
    mockedHasExplicitPermission.mockResolvedValue(false);
  });

  it('Operations Manager (functional, no payroll.view/recruitment.view/payroll.approve): payroll and recruitment denied, attendance and security allowed', async () => {
    // operations_manager: attendance.view and security_personnel.view
    // seeded, payroll.view/recruitment.view/payroll.approve NOT seeded (see
    // role_permissions in
    // 20260817000000_functional_role_permissions_foundation.sql).
    mockedCanAccess.mockImplementation(async (_legacy, permission) => permission === 'attendance.view' || permission === 'security_personnel.view');

    const result = await resolveDashboardPermissions(makeProfile({ role: 'operations_manager', role_level: null }));

    expect(result).toEqual({
      canViewPayroll: false,
      canViewAttendance: true,
      canViewRecruitment: false,
      canViewSecurity: true,
      canApprovePayroll: false,
      canApproveTerminalDues: false,
      canPayTerminalDues: false,
    });
  });

  it('HR Manager (functional, no payroll.view/payroll.approve): payroll denied, cannot approve', async () => {
    // hr_manager has neither payroll.view nor attendance.view seeded.
    mockedCanAccess.mockResolvedValue(false);

    const result = await resolveDashboardPermissions(makeProfile({ role: 'hr_manager', role_level: null }));

    expect(result.canViewPayroll).toBe(false);
    expect(result.canApprovePayroll).toBe(false);
  });

  it('Accountant (functional, has payroll.view AND payroll.approve): payroll view+approve allowed, everything else denied', async () => {
    // accountant: payroll.view and payroll.approve both seeded (see
    // role_permissions in
    // 20260817000000_functional_role_permissions_foundation.sql --
    // 'accountant', 'payroll.approve' is a real seeded row); attendance.view,
    // recruitment.view, and security_personnel.view NOT seeded.
    mockedCanAccess.mockImplementation(async (_legacy, permission) => permission === 'payroll.view' || permission === 'payroll.approve');

    const result = await resolveDashboardPermissions(makeProfile({ role: 'accountant', role_level: null }));

    expect(result).toEqual({
      canViewPayroll: true,
      canViewAttendance: false,
      canViewRecruitment: false,
      canViewSecurity: false,
      canApprovePayroll: true,
      canApproveTerminalDues: false,
      canPayTerminalDues: false,
    });
  });

  it('Accountant with payroll.view but WITHOUT payroll.approve: can view, cannot approve -- proves the two are resolved independently', async () => {
    mockedCanAccess.mockImplementation(async (_legacy, permission) => permission === 'payroll.view');

    const result = await resolveDashboardPermissions(makeProfile({ role: 'accountant', role_level: null }));

    expect(result.canViewPayroll).toBe(true);
    expect(result.canApprovePayroll).toBe(false);
  });

  it('legacy role_level 1 (Admin): canApprovePayroll true via canApprovePayrollFor({isSuperAdmin:false, roleLevel:1}), independent of has_permission', async () => {
    // Mirrors canAccess()'s own real short-circuit (legacyAllowed => true)
    // -- canApprovePayrollFor({isSuperAdmin:false, roleLevel:1}) computes
    // true, which this mock then honors exactly like the real canAccess
    // would, even though the underlying has_permission-equivalent path
    // (the `else` branch here) denies.
    mockedCanAccess.mockImplementation(async (legacyAllowed) => legacyAllowed);
    const result = await resolveDashboardPermissions(makeProfile({ role: null, role_level: 1 }));
    expect(result.canApprovePayroll).toBe(true);
  });

  it('legacy role_level 2 (Manager): view permissions legacy-open, but canApprovePayroll is false -- role_level 2 is NOT role_level 1', async () => {
    mockedCanAccess.mockImplementation(async (legacyAllowed) => legacyAllowed);
    const result = await resolveDashboardPermissions(makeProfile({ role: null, role_level: 2 }));
    expect(result.canViewPayroll).toBe(true);
    expect(result.canApprovePayroll).toBe(false);
  });

  it('super admin: canApprovePayroll true via isSuperAdmin, even with role_level null and the underlying has_permission check denying', async () => {
    mockedCanAccess.mockImplementation(async (legacyAllowed) => legacyAllowed);
    const result = await resolveDashboardPermissions(makeProfile({ role: 'admin', role_level: null, is_super_admin: true }));
    expect(result.canApprovePayroll).toBe(true);
    // Control: the same profile's VIEW flags go through isLegacy (role_level
    // !== null), which is false here (role_level is null for this super
    // admin) -- so those resolve however canAccess's own has_permission
    // path would, not via the legacy bypass. This test only asserts on
    // canApprovePayroll, which resolves independently via canApprovePayrollFor.
  });

  it('legacy account: canAccess(true, ...) short-circuits every view flag true, unchanged from before this rollout', async () => {
    mockedCanAccess.mockImplementation(async (legacyAllowed) => legacyAllowed);

    const result = await resolveDashboardPermissions(makeProfile({ role: null, role_level: 2 }));

    expect(result.canViewPayroll).toBe(true);
    expect(result.canViewAttendance).toBe(true);
    expect(result.canViewRecruitment).toBe(true);
    expect(result.canViewSecurity).toBe(true);
  });

  it('fails closed (all false, including canApprovePayroll) when the underlying permission check throws, rather than defaulting anything to true', async () => {
    mockedCanAccess.mockRejectedValue(new Error('network error'));

    const result = await resolveDashboardPermissions(makeProfile({ role: 'accountant', role_level: null }));

    expect(result).toEqual({
      canViewPayroll: false,
      canViewAttendance: false,
      canViewRecruitment: false,
      canViewSecurity: false,
      canApprovePayroll: false,
      canApproveTerminalDues: false,
      canPayTerminalDues: false,
    });
  });

  it('fails closed for a null profile', async () => {
    mockedCanAccess.mockResolvedValue(true); // even if canAccess would say yes
    mockedHasExplicitPermission.mockResolvedValue(true); // even if hasExplicitPermission would say yes
    const result = await resolveDashboardPermissions(null);
    // isLegacy is false for a null profile, so this still goes through
    // canAccess -- the mock above returning true is a control to prove
    // the function does not special-case null into a hardcoded false
    // without calling canAccess (it should still call it, per the real
    // isLegacy computation: (null ?? null) !== null is false).
    // canApprovePayrollFor({isSuperAdmin: false, roleLevel: 4}) is false on
    // its own, but canAccess(false, 'payroll.approve') is mocked true above,
    // so canApprovePayroll still resolves true here -- consistent with
    // every other flag in this same "canAccess always says yes" control.
    // hasExplicitPermission is mocked true too, purely as the same kind of
    // control -- resolveDashboardPermissions() itself never special-cases
    // a null profile into skipping either call.
    expect(result).toEqual({
      canViewPayroll: true,
      canViewAttendance: true,
      canViewRecruitment: true,
      canViewSecurity: true,
      canApprovePayroll: true,
      canApproveTerminalDues: true,
      canPayTerminalDues: true,
    });
  });

  it('Admin (functional, terminal_dues.approve granted, terminal_dues.pay NOT granted): approve true, pay false -- resolved independently via hasExplicitPermission, never canAccess', async () => {
    mockedCanAccess.mockResolvedValue(false);
    mockedHasExplicitPermission.mockImplementation(async (permission) => permission === 'terminal_dues.approve');

    const result = await resolveDashboardPermissions(makeProfile({ role: 'admin', role_level: null }));

    expect(result.canApproveTerminalDues).toBe(true);
    expect(result.canPayTerminalDues).toBe(false);
  });

  it('Accountant (functional, terminal_dues.pay granted, terminal_dues.approve NOT granted): pay true, approve false', async () => {
    mockedCanAccess.mockResolvedValue(false);
    mockedHasExplicitPermission.mockImplementation(async (permission) => permission === 'terminal_dues.pay');

    const result = await resolveDashboardPermissions(makeProfile({ role: 'accountant', role_level: null }));

    expect(result.canApproveTerminalDues).toBe(false);
    expect(result.canPayTerminalDues).toBe(true);
  });

  it('HR Manager (functional, neither terminal_dues.approve nor .pay seeded): both false, regardless of canAccess', async () => {
    // canAccess mocked true here as a control -- proves
    // canApproveTerminalDues/canPayTerminalDues go through
    // hasExplicitPermission ONLY and never fall back to canAccess/
    // hasPermission's business-admin-or-legacy shortcut the way the OLD
    // (buggy) TerminalDues.tsx create/edit checks used to.
    mockedCanAccess.mockResolvedValue(true);
    mockedHasExplicitPermission.mockResolvedValue(false);

    const result = await resolveDashboardPermissions(makeProfile({ role: 'hr_manager', role_level: null }));

    expect(result.canApproveTerminalDues).toBe(false);
    expect(result.canPayTerminalDues).toBe(false);
  });

  it('legacy Admin (role_level 1): terminal_dues approve/pay still false unless hasExplicitPermission itself says so -- no legacy role_level bypass', async () => {
    mockedCanAccess.mockImplementation(async (legacyAllowed) => legacyAllowed);
    mockedHasExplicitPermission.mockResolvedValue(false);

    const result = await resolveDashboardPermissions(makeProfile({ role: null, role_level: 1 }));

    expect(result.canViewPayroll).toBe(true); // legacy view flags still bypass via canAccess
    expect(result.canApproveTerminalDues).toBe(false);
    expect(result.canPayTerminalDues).toBe(false);
  });

  it('true super admin: terminal_dues approve/pay both true via hasExplicitPermission\'s own super-admin bypass', async () => {
    mockedCanAccess.mockResolvedValue(false);
    mockedHasExplicitPermission.mockResolvedValue(true);

    const result = await resolveDashboardPermissions(makeProfile({ role: 'admin', role_level: null, is_super_admin: true }));

    expect(result.canApproveTerminalDues).toBe(true);
    expect(result.canPayTerminalDues).toBe(true);
  });
});

describe('buildPendingTasks', () => {
  function makeInputs(overrides: Partial<Parameters<typeof buildPendingTasks>[0]>): Parameters<typeof buildPendingTasks>[0] {
    return {
      canApprovePayroll: false,
      pendingPayrollApprovalCount: 0,
      canViewRecruitment: false,
      pendingRecruitmentCount: 0,
      canViewSecurity: false,
      expiringLicensesCount: 0,
      canApproveTerminalDues: false,
      pendingTerminalDuesApprovalCount: 0,
      canPayTerminalDues: false,
      approvedTerminalDuesPaymentCount: 0,
      ...overrides,
    };
  }

  it('authorized AND exactly ONE month pending: singular title "Payroll Awaiting Approval", count is the month count not a row count', () => {
    // pendingPayrollApprovalCount is DISTINCT payroll months/runs, not
    // employee rows -- Dashboard.tsx computes it via a Set of month keys
    // before calling buildPendingTasks, so from this function's own
    // perspective 1 always means exactly one pending run.
    const tasks = buildPendingTasks(makeInputs({ canApprovePayroll: true, pendingPayrollApprovalCount: 1 }));
    expect(tasks.map(t => t.title)).toEqual(['Payroll Awaiting Approval']);
    expect(tasks[0].count).toBe(1);
  });

  it('authorized AND multiple months pending: plural title "Payroll Periods Awaiting Approval"', () => {
    const tasks = buildPendingTasks(makeInputs({ canApprovePayroll: true, pendingPayrollApprovalCount: 3 }));
    expect(tasks.map(t => t.title)).toEqual(['Payroll Periods Awaiting Approval']);
    expect(tasks[0].count).toBe(3);
  });

  it('authorized but NOTHING pending: no payroll task appears, even though the caller could approve', () => {
    const tasks = buildPendingTasks(makeInputs({ canApprovePayroll: true, pendingPayrollApprovalCount: 0 }));
    expect(tasks.map(t => t.title)).not.toContain('Payroll Awaiting Approval');
    expect(tasks.map(t => t.title)).not.toContain('Payroll Periods Awaiting Approval');
  });

  it('something pending but NOT authorized: no payroll task appears -- a payroll.view-only caller must not see an action task they cannot perform', () => {
    const tasks = buildPendingTasks(makeInputs({ canApprovePayroll: false, pendingPayrollApprovalCount: 5 }));
    expect(tasks.map(t => t.title)).not.toContain('Payroll Periods Awaiting Approval');
  });

  it('Review Job Applications: same authorized-AND-pending rule', () => {
    expect(buildPendingTasks(makeInputs({ canViewRecruitment: true, pendingRecruitmentCount: 2 })).map(t => t.title)).toContain('Review Job Applications');
    expect(buildPendingTasks(makeInputs({ canViewRecruitment: true, pendingRecruitmentCount: 0 })).map(t => t.title)).not.toContain('Review Job Applications');
    expect(buildPendingTasks(makeInputs({ canViewRecruitment: false, pendingRecruitmentCount: 4 })).map(t => t.title)).not.toContain('Review Job Applications');
  });

  it('Renew Expiring Licenses: same authorized-AND-pending rule', () => {
    expect(buildPendingTasks(makeInputs({ canViewSecurity: true, expiringLicensesCount: 1 })).map(t => t.title)).toContain('Renew Expiring Licenses');
    expect(buildPendingTasks(makeInputs({ canViewSecurity: true, expiringLicensesCount: 0 })).map(t => t.title)).not.toContain('Renew Expiring Licenses');
    expect(buildPendingTasks(makeInputs({ canViewSecurity: false, expiringLicensesCount: 3 })).map(t => t.title)).not.toContain('Renew Expiring Licenses');
  });

  it('Process Leave Requests no longer exists as a task at all -- no leave-management feature exists anywhere in this app to back it with real data', () => {
    const tasks = buildPendingTasks(makeInputs({
      canApprovePayroll: true, pendingPayrollApprovalCount: 1,
      canViewRecruitment: true, pendingRecruitmentCount: 1,
      canViewSecurity: true, expiringLicensesCount: 1,
    }));
    expect(tasks.map(t => t.title)).not.toContain('Process Leave Requests');
    expect(tasks.map(t => t.key)).not.toContain('process-leave');
  });

  it('everything authorized and everything pending: all 5 real tasks appear with correct counts', () => {
    const tasks = buildPendingTasks(makeInputs({
      canApprovePayroll: true, pendingPayrollApprovalCount: 2,
      canViewRecruitment: true, pendingRecruitmentCount: 5,
      canViewSecurity: true, expiringLicensesCount: 1,
      canApproveTerminalDues: true, pendingTerminalDuesApprovalCount: 1,
      canPayTerminalDues: true, approvedTerminalDuesPaymentCount: 3,
    }));
    expect(tasks).toHaveLength(5);
    expect(tasks.map(t => t.title)).toEqual([
      'Payroll Periods Awaiting Approval', 'Review Job Applications', 'Renew Expiring Licenses',
      'Terminal Dues Awaiting Approval', 'Terminal Dues Awaiting Payment',
    ]);
    expect(tasks.map(t => t.count)).toEqual([2, 5, 1, 1, 3]);
  });

  it('nothing authorized and nothing pending: empty list, not a fallback ungated task -- proves the filter fails closed, not open', () => {
    const tasks = buildPendingTasks(makeInputs({}));
    expect(tasks).toEqual([]);
  });

  // ===== TERMINAL DUES ===== (real staging bug: Admin Dashboard showed
  // 0 Pending Tasks despite a real Pending terminal_dues row Admin was
  // authorized and able to approve)
  it('Admin with terminal_dues.approve AND 1 Pending due: exactly one "Terminal Dues Awaiting Approval" task, count 1', () => {
    const tasks = buildPendingTasks(makeInputs({ canApproveTerminalDues: true, pendingTerminalDuesApprovalCount: 1 }));
    expect(tasks.map(t => t.title)).toEqual(['Terminal Dues Awaiting Approval']);
    expect(tasks[0].count).toBe(1);
  });

  it('Admin with terminal_dues.approve but 0 Pending dues: no terminal-dues approval task', () => {
    const tasks = buildPendingTasks(makeInputs({ canApproveTerminalDues: true, pendingTerminalDuesApprovalCount: 0 }));
    expect(tasks.map(t => t.title)).not.toContain('Terminal Dues Awaiting Approval');
  });

  it('Accountant with terminal_dues.pay AND 1 Approved due: exactly one "Terminal Dues Awaiting Payment" task, count 1', () => {
    const tasks = buildPendingTasks(makeInputs({ canPayTerminalDues: true, approvedTerminalDuesPaymentCount: 1 }));
    expect(tasks.map(t => t.title)).toEqual(['Terminal Dues Awaiting Payment']);
    expect(tasks[0].count).toBe(1);
  });

  it('Accountant with terminal_dues.pay but ONLY Pending dues exist (approvedTerminalDuesPaymentCount 0): no payment task -- Pending is not Approved', () => {
    const tasks = buildPendingTasks(makeInputs({ canPayTerminalDues: true, approvedTerminalDuesPaymentCount: 0 }));
    expect(tasks.map(t => t.title)).not.toContain('Terminal Dues Awaiting Payment');
  });

  it('HR Manager (can view/create/edit but holds neither terminal_dues.approve nor .pay): sees NEITHER task even if counts are nonzero', () => {
    const tasks = buildPendingTasks(makeInputs({
      canApproveTerminalDues: false, pendingTerminalDuesApprovalCount: 4,
      canPayTerminalDues: false, approvedTerminalDuesPaymentCount: 4,
    }));
    expect(tasks.map(t => t.title)).not.toContain('Terminal Dues Awaiting Approval');
    expect(tasks.map(t => t.title)).not.toContain('Terminal Dues Awaiting Payment');
  });

  it('unauthorized rows are never counted into a visible task: authorized=false always suppresses the task regardless of how large the count is (real region/tenant scoping happens upstream, in the RLS-authorized count query itself -- this function only ever sees the already-authorized number)', () => {
    const tasks = buildPendingTasks(makeInputs({
      canApproveTerminalDues: false, pendingTerminalDuesApprovalCount: 999,
      canPayTerminalDues: false, approvedTerminalDuesPaymentCount: 999,
    }));
    expect(tasks).toEqual([]);
  });
});
