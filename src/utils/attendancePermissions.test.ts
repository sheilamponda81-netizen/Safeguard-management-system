import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserProfile } from './currentProfile';

// Mock the underlying hasPermission() so these tests exercise
// resolveAttendanceWritePermissions()'s own legacy/functional branching and
// fail-closed logic without hitting Supabase -- hasPermission() itself
// (including its is_business_admin() bypass) is already covered by
// permissions.test.ts.
vi.mock('./permissions', () => ({
  hasPermission: vi.fn(),
  PERMISSIONS: {
    ATTENDANCE_CREATE: 'attendance.create',
    ATTENDANCE_EDIT: 'attendance.edit',
  },
}));

import { hasPermission } from './permissions';
import { resolveAttendanceWritePermissions } from './attendancePermissions';

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
