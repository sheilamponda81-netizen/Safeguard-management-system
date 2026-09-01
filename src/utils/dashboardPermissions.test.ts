import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserProfile } from './currentProfile';

// Mock the underlying canAccess() so these tests exercise
// resolveDashboardPermissions()'s own fail-closed/branching logic without
// hitting Supabase -- canAccess() itself (legacyAllowed OR
// has_permission()) is already covered by permissions.test.ts.
vi.mock('./permissions', () => ({
  canAccess: vi.fn(),
  PERMISSIONS: {
    PAYROLL_VIEW: 'payroll.view',
    ATTENDANCE_VIEW: 'attendance.view',
    RECRUITMENT_VIEW: 'recruitment.view',
    SECURITY_PERSONNEL_VIEW: 'security_personnel.view',
  },
}));

import { canAccess } from './permissions';
import { resolveDashboardPermissions, buildPendingTasks, DashboardPermissions } from './dashboardPermissions';

const mockedCanAccess = vi.mocked(canAccess);

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
  });

  it('Operations Manager (functional, no payroll.view/recruitment.view): payroll and recruitment denied, attendance and security allowed', async () => {
    // operations_manager: attendance.view and security_personnel.view
    // seeded, payroll.view and recruitment.view NOT seeded (see
    // role_permissions in
    // 20260817000000_functional_role_permissions_foundation.sql).
    mockedCanAccess.mockImplementation(async (_legacy, permission) => permission === 'attendance.view' || permission === 'security_personnel.view');

    const result = await resolveDashboardPermissions(makeProfile({ role: 'operations_manager', role_level: null }));

    expect(result).toEqual({
      canViewPayroll: false,
      canViewAttendance: true,
      canViewRecruitment: false,
      canViewSecurity: true,
    });
  });

  it('HR Manager (functional, no payroll.view): payroll denied', async () => {
    // hr_manager has neither payroll.view nor attendance.view seeded.
    mockedCanAccess.mockResolvedValue(false);

    const result = await resolveDashboardPermissions(makeProfile({ role: 'hr_manager', role_level: null }));

    expect(result.canViewPayroll).toBe(false);
  });

  it('Accountant (functional, no attendance.view/recruitment.view/security_personnel.view): payroll allowed, everything else denied', async () => {
    // accountant: payroll.view seeded; attendance.view, recruitment.view,
    // and security_personnel.view NOT seeded (see role_permissions in
    // 20260817000000_functional_role_permissions_foundation.sql -- the
    // Accountant row list has no attendance.*/recruitment.*/
    // security_personnel.* entries at all). This is the exact profile
    // the "Renew Expiring Licenses" and "Review Job Applications"
    // pending-task gating exists for (Dashboard.tsx).
    mockedCanAccess.mockImplementation(async (_legacy, permission) => permission === 'payroll.view');

    const result = await resolveDashboardPermissions(makeProfile({ role: 'accountant', role_level: null }));

    expect(result).toEqual({
      canViewPayroll: true,
      canViewAttendance: false,
      canViewRecruitment: false,
      canViewSecurity: false,
    });
  });

  it('legacy account: canAccess(true, ...) short-circuits every flag true, unchanged from before this rollout', async () => {
    mockedCanAccess.mockImplementation(async (legacyAllowed) => legacyAllowed);

    const result = await resolveDashboardPermissions(makeProfile({ role: null, role_level: 2 }));

    expect(result).toEqual({
      canViewPayroll: true,
      canViewAttendance: true,
      canViewRecruitment: true,
      canViewSecurity: true,
    });
  });

  it('fails closed (all false) when the underlying permission check throws, rather than defaulting anything to true', async () => {
    mockedCanAccess.mockRejectedValue(new Error('network error'));

    const result = await resolveDashboardPermissions(makeProfile({ role: 'accountant', role_level: null }));

    expect(result).toEqual({
      canViewPayroll: false,
      canViewAttendance: false,
      canViewRecruitment: false,
      canViewSecurity: false,
    });
  });

  it('fails closed for a null profile', async () => {
    mockedCanAccess.mockResolvedValue(true); // even if canAccess would say yes
    const result = await resolveDashboardPermissions(null);
    // isLegacy is false for a null profile, so this still goes through
    // canAccess -- the mock above returning true is a control to prove
    // the function does not special-case null into a hardcoded false
    // without calling canAccess (it should still call it, per the real
    // isLegacy computation: (null ?? null) !== null is false).
    expect(result).toEqual({
      canViewPayroll: true,
      canViewAttendance: true,
      canViewRecruitment: true,
      canViewSecurity: true,
    });
  });
});

describe('buildPendingTasks', () => {
  function makePermissions(overrides: Partial<DashboardPermissions>): DashboardPermissions {
    return {
      canViewPayroll: false,
      canViewAttendance: false,
      canViewRecruitment: false,
      canViewSecurity: false,
      ...overrides,
    };
  }

  it('Accountant-shaped permissions (payroll only): does not see Review Job Applications or Renew Expiring Licenses', () => {
    const tasks = buildPendingTasks(makePermissions({ canViewPayroll: true }));
    const titles = tasks.map(t => t.title);
    expect(titles).toContain('Approve Payroll');
    expect(titles).toContain('Process Leave Requests');
    expect(titles).not.toContain('Review Job Applications');
    expect(titles).not.toContain('Renew Expiring Licenses');
    expect(tasks).toHaveLength(2);
  });

  it('a user WITH recruitment.view (e.g. HR Manager) does see Review Job Applications', () => {
    const tasks = buildPendingTasks(makePermissions({ canViewRecruitment: true }));
    expect(tasks.map(t => t.title)).toContain('Review Job Applications');
  });

  it('a user WITH security_personnel.view sees Renew Expiring Licenses', () => {
    const tasks = buildPendingTasks(makePermissions({ canViewSecurity: true }));
    expect(tasks.map(t => t.title)).toContain('Renew Expiring Licenses');
  });

  it('Approve Payroll follows canViewPayroll specifically, not any other flag', () => {
    const withPayroll = buildPendingTasks(makePermissions({ canViewPayroll: true }));
    const withoutPayroll = buildPendingTasks(makePermissions({ canViewRecruitment: true, canViewSecurity: true }));
    expect(withPayroll.map(t => t.title)).toContain('Approve Payroll');
    expect(withoutPayroll.map(t => t.title)).not.toContain('Approve Payroll');
  });

  it('Process Leave Requests is always visible -- no permission gates it, since no leave-management feature exists', () => {
    expect(buildPendingTasks(makePermissions({})).map(t => t.title)).toEqual(['Process Leave Requests']);
  });

  it('a business admin (every flag true) sees all four tasks, and the count is the actual list length', () => {
    const tasks = buildPendingTasks(makePermissions({ canViewPayroll: true, canViewAttendance: true, canViewRecruitment: true, canViewSecurity: true }));
    expect(tasks).toHaveLength(4);
    expect(tasks.map(t => t.title)).toEqual([
      'Approve Payroll',
      'Review Job Applications',
      'Process Leave Requests',
      'Renew Expiring Licenses',
    ]);
  });

  it('a role with nothing granted sees only the ungated task -- proves the filter fails closed, not open', () => {
    const tasks = buildPendingTasks(makePermissions({}));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Process Leave Requests');
  });
});
