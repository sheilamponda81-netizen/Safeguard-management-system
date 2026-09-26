import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserProfile } from './currentProfile';

// Mock only the underlying hasPermission() (it hits Supabase) so these
// tests exercise resolveAttendanceWritePermissions()'s own legacy/functional
// branching and fail-closed logic without a network call -- hasPermission()
// itself (including its is_business_admin() bypass) is already covered by
// permissions.test.ts. Everything else from './permissions' (PERMISSIONS,
// canChooseAnyRegion, isBusinessAdmin -- all pure, no Supabase) stays real,
// since canEditAttendanceInRegion below (HOTFIX) calls canChooseAnyRegion()
// directly and needs the genuine implementation, not a stub.
vi.mock('./permissions', async () => {
  const actual = await vi.importActual<typeof import('./permissions')>('./permissions');
  return { ...actual, hasPermission: vi.fn() };
});

import { hasPermission } from './permissions';
import { resolveAttendanceWritePermissions, canEditAttendanceInRegion } from './attendancePermissions';

const mockedHasPermission = vi.mocked(hasPermission);

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

describe('resolveAttendanceWritePermissions', () => {
  beforeEach(() => {
    mockedHasPermission.mockReset();
  });

  it('Functional Admin (role_level=null) is editable via has_permission()/is_business_admin() bypass', async () => {
    // Functional Admin: hasPermission() resolves true for both create and
    // edit via its own is_business_admin() bypass -- resolveAttendanceWritePermissions
    // does not special-case this, it just asks the real permission system.
    mockedHasPermission.mockResolvedValue(true);

    const result = await resolveAttendanceWritePermissions(makeProfile({ role: 'admin', role_level: null }));

    expect(result).toEqual({ canCreateAttendance: true, canEditAttendance: true });
  });

  it('Operations Manager (functional, no attendance.create/attendance.edit seeded) is read-only', async () => {
    mockedHasPermission.mockResolvedValue(false);

    const result = await resolveAttendanceWritePermissions(makeProfile({ role: 'operations_manager', role_level: null }));

    expect(result).toEqual({ canCreateAttendance: false, canEditAttendance: false });
    // Functional path must never consult hasPermission with a legacy shortcut --
    // it should have been asked about both permissions explicitly.
    expect(mockedHasPermission).toHaveBeenCalledWith('attendance.create');
    expect(mockedHasPermission).toHaveBeenCalledWith('attendance.edit');
  });

  it('Legacy Supervisor (role_level=3) matches the backend <= 3 write compatibility boundary: editable', async () => {
    const result = await resolveAttendanceWritePermissions(makeProfile({ role: null, role_level: 3 }));

    expect(result).toEqual({ canCreateAttendance: true, canEditAttendance: true });
    // Legacy path must be decided locally from role_level, never by calling
    // the (always-false-for-legacy) has_permission() RPC.
    expect(mockedHasPermission).not.toHaveBeenCalled();
  });

  it('Legacy Staff (role_level=4) is read-only, mirroring the backend boundary excluding level 4', async () => {
    const result = await resolveAttendanceWritePermissions(makeProfile({ role: null, role_level: 4 }));

    expect(result).toEqual({ canCreateAttendance: false, canEditAttendance: false });
    expect(mockedHasPermission).not.toHaveBeenCalled();
  });

  it('Legacy Manager (role_level=2) remains editable (within the <= 3 band)', async () => {
    const result = await resolveAttendanceWritePermissions(makeProfile({ role: null, role_level: 2 }));

    expect(result).toEqual({ canCreateAttendance: true, canEditAttendance: true });
  });

  it('fails closed (both false) when the underlying permission check throws', async () => {
    mockedHasPermission.mockRejectedValue(new Error('network error'));

    const result = await resolveAttendanceWritePermissions(makeProfile({ role: 'accountant', role_level: null }));

    expect(result).toEqual({ canCreateAttendance: false, canEditAttendance: false });
  });

  it('fails closed for a null profile by treating it as functional and asking has_permission()', async () => {
    mockedHasPermission.mockResolvedValue(false);

    const result = await resolveAttendanceWritePermissions(null);

    expect(result).toEqual({ canCreateAttendance: false, canEditAttendance: false });
  });
});

// HOTFIX (STAGING blocker 1): confirmed root cause -- Attendance.tsx's
// per-cell edit handler used to exempt only is_super_admin from its own
// region check, so a Business Admin (role='admin', region_id=NULL -- the
// confirmed STAGING persona) hit "You can only edit attendance for
// employees in your region" even though region_allowed() at the database
// layer already grants Business Admins tenant-wide region access. This is
// the extracted, directly-testable version of that gate.
describe('canEditAttendanceInRegion', () => {
  it('Super Admin may edit an employee in any region', () => {
    const profile = makeProfile({ is_super_admin: true, role: 'hr_manager', region_id: 'r1' });
    expect(canEditAttendanceInRegion(profile, 'r2')).toBe(true);
    expect(canEditAttendanceInRegion(profile, null)).toBe(true);
  });

  it('Business Admin (role="admin", region_id=null -- the confirmed STAGING persona) may edit an employee in any region', () => {
    const profile = makeProfile({ role: 'admin', role_level: null, is_super_admin: false, region_id: null });
    expect(canEditAttendanceInRegion(profile, 'r1')).toBe(true);
    expect(canEditAttendanceInRegion(profile, 'r2')).toBe(true);
  });

  it('legacy Business Admin (role_level=1) may edit an employee in any region', () => {
    const profile = makeProfile({ role: null, role_level: 1, is_super_admin: false, region_id: null });
    expect(canEditAttendanceInRegion(profile, 'r1')).toBe(true);
  });

  it('a region-scoped account may edit an employee in its own region', () => {
    const profile = makeProfile({ role: 'hr_manager', role_level: null, region_id: 'r1' });
    expect(canEditAttendanceInRegion(profile, 'r1')).toBe(true);
  });

  it('a region-scoped account may NOT edit an employee outside its own region', () => {
    const profile = makeProfile({ role: 'hr_manager', role_level: null, region_id: 'r1' });
    expect(canEditAttendanceInRegion(profile, 'r2')).toBe(false);
  });

  it('a region-scoped legacy account (role_level=3) may NOT edit an employee outside its own region', () => {
    const profile = makeProfile({ role: null, role_level: 3, region_id: 'r1' });
    expect(canEditAttendanceInRegion(profile, 'r2')).toBe(false);
  });

  it('fails closed for a null profile', () => {
    expect(canEditAttendanceInRegion(null, 'r1')).toBe(false);
  });
});
