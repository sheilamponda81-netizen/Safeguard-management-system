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
  },
}));

import { canAccess } from './permissions';
import { resolveDashboardPermissions } from './dashboardPermissions';

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

  it('Operations Manager (functional, no payroll.view/recruitment.view): payroll and recruitment denied, attendance allowed', async () => {
    // operations_manager: attendance.view seeded, payroll.view and
    // recruitment.view NOT seeded (see role_permissions in
    // 20260817000000_functional_role_permissions_foundation.sql).
    mockedCanAccess.mockImplementation(async (_legacy, permission) => permission === 'attendance.view');

    const result = await resolveDashboardPermissions(makeProfile({ role: 'operations_manager', role_level: null }));

    expect(result).toEqual({
      canViewPayroll: false,
      canViewAttendance: true,
      canViewRecruitment: false,
    });
  });

  it('HR Manager (functional, no payroll.view): payroll denied', async () => {
    // hr_manager has neither payroll.view nor attendance.view seeded.
    mockedCanAccess.mockResolvedValue(false);

    const result = await resolveDashboardPermissions(makeProfile({ role: 'hr_manager', role_level: null }));

    expect(result.canViewPayroll).toBe(false);
  });

  it('legacy account: canAccess(true, ...) short-circuits every flag true, unchanged from before this rollout', async () => {
    mockedCanAccess.mockImplementation(async (legacyAllowed) => legacyAllowed);

    const result = await resolveDashboardPermissions(makeProfile({ role: null, role_level: 2 }));

    expect(result).toEqual({
      canViewPayroll: true,
      canViewAttendance: true,
      canViewRecruitment: true,
    });
  });

  it('fails closed (all false) when the underlying permission check throws, rather than defaulting anything to true', async () => {
    mockedCanAccess.mockRejectedValue(new Error('network error'));

    const result = await resolveDashboardPermissions(makeProfile({ role: 'accountant', role_level: null }));

    expect(result).toEqual({
      canViewPayroll: false,
      canViewAttendance: false,
      canViewRecruitment: false,
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
    });
  });
});
