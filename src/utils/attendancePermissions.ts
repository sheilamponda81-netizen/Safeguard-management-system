import { hasPermission, PERMISSIONS, canChooseAnyRegion } from './permissions';
import { UserProfile } from './currentProfile';

export interface AttendanceWritePermissions {
  canCreateAttendance: boolean;
  canEditAttendance: boolean;
}

// Fail-closed by design. A single grid-cell click on Attendance.tsx can
// result in either an INSERT (no record yet for that day) or an UPDATE
// (a record already exists) -- see processSingleUpdate -- and the backend
// gates those independently (has_permission('attendance.create') /
// has_permission('attendance.edit'), supabase/migrations/
// 20260817000002_functional_roles_indirect_region_tables.sql), so both are
// resolved and returned separately; the caller combines them
// (canCreateAttendance && canEditAttendance) into a single "can modify"
// gate for the grid.
//
// Legacy accounts mirror the backend's write boundary EXACTLY --
// current_user_role_level() <= 3, NOT "any non-null role_level". Legacy
// Staff (role_level 4) must be read-only here exactly like the backend's
// attendance INSERT/UPDATE RLS policies (`current_user_role_level() <= 3
// OR has_permission(...)`) already deny them. The `<= 3` comparison is
// only ever evaluated inside the already-non-null branch below -- doing
// it unguarded against a possibly-null role_level would be unsafe, since
// JS coerces `null <= 3` to true, unlike SQL's NULL-safe comparison.
//
// Functional accounts ask the real permission system instead of a
// hardcoded role-name/role_level-presence check. hasPermission() has its
// own is_business_admin() bypass (mirrors the backend's has_permission()
// bypass), so a functional Admin (role='admin', role_level=NULL) resolves
// to true here with no special-casing of its own, and Operations Manager
// (attendance.view only, no create/edit seeded) correctly resolves false.
// HOTFIX: the grid's per-cell edit handler (Attendance.tsx updateAttendance)
// used to only exempt is_super_admin from its own region check, leaving a
// Business Admin (role='admin' or role_level=1, region_id usually NULL)
// blocked with "You can only edit attendance for employees in your region"
// even though canModifyAttendance (above) already said they may write, and
// the database's region_allowed() already grants them tenant-wide region
// access exactly like it does for is_super_admin. This mirrors that same
// bypass client-side via the shared canChooseAnyRegion() helper, so a
// genuinely region-scoped account (neither Super Admin nor Business Admin)
// remains the only case still compared against employeeRegionId.
export function canEditAttendanceInRegion(profile: UserProfile | null, employeeRegionId: string | null | undefined): boolean {
  if (!profile) return false;
  if (canChooseAnyRegion(profile)) return true;
  return employeeRegionId === profile.region_id;
}

export async function resolveAttendanceWritePermissions(profile: UserProfile | null): Promise<AttendanceWritePermissions> {
  try {
    const isLegacy = (profile?.role_level ?? null) !== null;
    if (isLegacy) {
      const legacyCanWrite = profile!.role_level! <= 3;
      return { canCreateAttendance: legacyCanWrite, canEditAttendance: legacyCanWrite };
    }
    const [canCreateAttendance, canEditAttendance] = await Promise.all([
      hasPermission(PERMISSIONS.ATTENDANCE_CREATE),
      hasPermission(PERMISSIONS.ATTENDANCE_EDIT),
    ]);
    return { canCreateAttendance, canEditAttendance };
  } catch (err) {
    console.error('Error resolving attendance edit permissions:', err);
    return { canCreateAttendance: false, canEditAttendance: false };
  }
}
