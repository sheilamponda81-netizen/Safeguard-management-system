import { supabase } from '../lib/supabase';
import { getCurrentProfile, UserProfile } from './currentProfile';

// Mirrors the permission keys seeded into `role_permissions` by
// supabase/migrations/20260817000000_functional_role_permissions_foundation.sql
// PART 2. Keep these two lists in sync by hand -- there is deliberately no
// single shared source file between SQL and TypeScript for this small,
// fixed permission set (see that migration's header for why a static,
// migration-defined table was chosen over a fully dynamic RBAC shape).
export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard.view',
  EMPLOYEES_VIEW: 'employees.view',
  EMPLOYEES_CREATE: 'employees.create',
  EMPLOYEES_EDIT: 'employees.edit',
  EMPLOYEES_DELETE: 'employees.delete',
  RECRUITMENT_VIEW: 'recruitment.view',
  RECRUITMENT_CREATE: 'recruitment.create',
  RECRUITMENT_EDIT: 'recruitment.edit',
  RECRUITMENT_DELETE: 'recruitment.delete',
  SALARY_ADVANCES_VIEW: 'salary_advances.view',
  SALARY_ADVANCES_CREATE: 'salary_advances.create',
  SALARY_ADVANCES_APPROVE: 'salary_advances.approve',
  SALARY_ADVANCES_ADJUST: 'salary_advances.adjust',
  TERMINAL_DUES_VIEW: 'terminal_dues.view',
  TERMINAL_DUES_CREATE: 'terminal_dues.create',
  TERMINAL_DUES_EDIT: 'terminal_dues.edit',
  // terminal_dues.process retired (separation-of-duties migration,
  // 20260905000000) -- status changes now go through the narrow
  // approve/pay/return RPCs below, each gated by its own permission key,
  // never a single blanket "process" permission.
  TERMINAL_DUES_APPROVE: 'terminal_dues.approve',
  TERMINAL_DUES_PAY: 'terminal_dues.pay',
  SECURITY_PERSONNEL_VIEW: 'security_personnel.view',
  SECURITY_PERSONNEL_CREATE: 'security_personnel.create',
  SECURITY_PERSONNEL_EDIT: 'security_personnel.edit',
  SECURITY_PERSONNEL_DELETE: 'security_personnel.delete',
  PAYROLL_VIEW: 'payroll.view',
  PAYROLL_PROCESS: 'payroll.process',
  PAYROLL_APPROVE: 'payroll.approve',
  PAYMENTS_VIEW: 'payments.view',
  PAYMENTS_MANAGE: 'payments.manage',
  PAYSLIPS_VIEW: 'payslips.view',
  REPORTS_FINANCIAL_VIEW: 'reports.financial.view',
  REPORTS_FINANCIAL_EXPORT: 'reports.financial.export',
  REPORTS_RECRUITMENT_VIEW: 'reports.recruitment.view',
  REPORTS_RECRUITMENT_EXPORT: 'reports.recruitment.export',
  REPORTS_OPERATIONAL_VIEW: 'reports.operational.view',
  REPORTS_OPERATIONAL_EXPORT: 'reports.operational.export',
  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_CREATE: 'attendance.create',
  ATTENDANCE_EDIT: 'attendance.edit',
  // HikCentral Attendance MVP Phase 1 (20260929000000_hikcentral_attendance_ingestion_foundation.sql)
  // -- import/preview/mapping only, no "apply attendance" permission yet.
  ATTENDANCE_IMPORT_HIKCENTRAL: 'attendance.import_hikcentral',
  ATTENDANCE_MAP_HIKCENTRAL_PERSONS: 'attendance.map_hikcentral_persons',
  USER_MANUAL_VIEW: 'user_manual.view',
  FUTURE_FEATURES_VIEW: 'future_features.view',
} as const;

export type PermissionKey = typeof PERMISSIONS[keyof typeof PERMISSIONS];

// FUNCTIONAL_ROLES / FunctionalRole -- the 4 new, non-hierarchical roles.
// A profile whose `role` is NOT one of these (e.g. legacy 'staff'/
// 'manager'/'supervisor' free-text values) is a LEGACY account, identified
// instead by `role_level IS NOT NULL` (see isLegacyAccount below).
export const FUNCTIONAL_ROLES = ['admin', 'hr_manager', 'accountant', 'operations_manager'] as const;
export type FunctionalRole = typeof FUNCTIONAL_ROLES[number];

export const ROLE_DISPLAY_NAMES: Record<FunctionalRole, string> = {
  admin: 'Admin',
  hr_manager: 'Human Resource Manager',
  accountant: 'Accountant',
  operations_manager: 'Operational Manager',
};

// Mirrors is_business_admin(): role = 'admin' OR role_level = 1. Full
// authority, same tenant, regardless of region -- distinct from
// is_super_admin (profiles.is_super_admin, cross-tenant platform bypass,
// never granted through the normal Create User flow).
export function isBusinessAdmin(profile: UserProfile | null): boolean {
  if (!profile) return false;
  return profile.role === 'admin' || profile.role_level === 1;
}

// HOTFIX: mirrors region_allowed()'s tenant-wide bypass -- that function
// returns true unconditionally for is_business_admin() the same way it
// does for is_super_admin(), so at the database layer a Business Admin
// already has access to every region in their tenant, not just their own
// profile's region_id. Frontend region gates (Attendance's edit check,
// the Add Employee region field) must grant the same bypass instead of
// checking is_super_admin alone, or a Business Admin with no region_id of
// their own (the normal case -- Business Admin authority is tenant-wide,
// not tied to one region) gets incorrectly treated as region-scoped.
// Genuinely region-scoped roles (a legacy Supervisor/Staff, or a
// functional HR Manager/Accountant/Operations Manager) are unaffected --
// they still fall through to false here, same as before.
export function canChooseAnyRegion(profile: UserProfile | null): boolean {
  if (!profile) return false;
  return profile.is_super_admin === true || isBusinessAdmin(profile);
}

// HOTFIX: generic "may this caller act on a record belonging to this
// region" gate -- canChooseAnyRegion() covers the Super Admin/Business
// Admin bypass, and this adds the one remaining case: a genuinely
// region-scoped caller acting on a record in their OWN region. Used by
// Employees.tsx's edit-employee gate (STAGING: "You cannot edit employees
// from other regions" was blocking a Business Admin with region_id=NULL
// the same way the Attendance/Add-Employee gates were before them) --
// intentionally the same shape as attendancePermissions.ts's
// canEditAttendanceInRegion(), so a future region-scoped gate (e.g.
// delete/restore employee, which still have the pre-fix is_super_admin-only
// check as of this commit) can reuse this instead of a third copy.
export function canActOnRegion(profile: UserProfile | null, recordRegionId: string | null | undefined): boolean {
  if (!profile) return false;
  if (canChooseAnyRegion(profile)) return true;
  return recordRegionId === profile.region_id;
}

// HOTFIX: single source of truth for "what role label does this profile
// display", used by both Sidebar.tsx (the account's own label in the nav)
// and UserManagement.tsx's getRoleBadge (every OTHER user's label in the
// admin table). Extracted specifically so the two surfaces cannot drift
// out of sync -- before this hotfix each had its own independent
// role_level/role branching, and is_super_admin was only ever checked in
// neither, which was the exact bug this hotfix fixes. is_super_admin is
// checked with the HIGHEST precedence -- it is an orthogonal axis from
// role/role_level (a Super Administrator's role_level/role still reads as
// an ordinary Administrator underneath).
const LEGACY_ROLE_LEVEL_NAMES: Record<number, string> = {
  1: 'Administrator',
  2: 'Manager',
  3: 'Supervisor',
  4: 'Staff',
};

export interface RoleDisplayProfile {
  is_super_admin?: boolean | null;
  role_level?: number | null;
  role?: string | null;
}

export function getRoleDisplayLabel(profile: RoleDisplayProfile | null | undefined): string {
  if (!profile) return 'User';
  if (profile.is_super_admin === true) return 'Super Administrator';
  if (profile.role_level != null && profile.role_level in LEGACY_ROLE_LEVEL_NAMES) {
    return LEGACY_ROLE_LEVEL_NAMES[profile.role_level];
  }
  if (profile.role && profile.role in ROLE_DISPLAY_NAMES) {
    return ROLE_DISPLAY_NAMES[profile.role as FunctionalRole];
  }
  return 'User';
}

// HOTFIX: UserManagement.tsx's Add User role selector. 'super_admin' is a
// UI-only value, never persisted as profiles.role -- see
// resolveAddUserRoleSelection below for the translation applied at submit
// time. Extracted as a pure function (rather than left as an inline JSX
// conditional) so "Super Administrator does not appear at all for a
// non-super-admin caller" has its own direct unit test, independent of any
// component-rendering test infrastructure this repo does not have.
export type AddUserRoleOption = FunctionalRole | 'super_admin';

export function getAddUserRoleOptions(callerIsSuperAdmin: boolean): AddUserRoleOption[] {
  return callerIsSuperAdmin ? ['super_admin', ...FUNCTIONAL_ROLES] : [...FUNCTIONAL_ROLES];
}

// The exact translation UserManagement.tsx's addUser() applies before
// calling create-user/index.ts: the UI-only 'super_admin' selection never
// reaches the network as a role value -- it becomes role='admin' plus an
// explicit is_super_admin request flag, which create-user/index.ts's own
// canGrantSuperAdmin (supabase/functions/create-user/validation.ts)
// independently re-authorizes server-side.
export function resolveAddUserRoleSelection(selection: AddUserRoleOption): { role: FunctionalRole; requestSuperAdmin: boolean } {
  if (selection === 'super_admin') {
    return { role: 'admin', requestSuperAdmin: true };
  }
  return { role: selection, requestSuperAdmin: false };
}

// HOTFIX: changing current_payroll_month is Super-Admin-only -- an
// ordinary Administrator (role_level===1 or role==='admin') no longer
// qualifies, per the formal Super Administrator model. Used by
// MonthSettings.tsx for both its render-time gate (canChangeMonth) and its
// handleSaveMonth pre-check, so the two can never independently drift.
// This is a UI-only convenience; the actual enforcement is the key-aware
// system_settings RLS policy (see the hotfix migration).
export function canChangeCurrentPayrollMonth(profile: { is_super_admin?: boolean | null } | null | undefined): boolean {
  return profile?.is_super_admin === true;
}

// A LEGACY account is any profile that still carries a real numeric
// role_level (1-4). Every NEW functional-role account has role_level =
// NULL by design (see supabase/migrations/20260817000000's header) --
// this is the frontend mirror of that same structural guarantee: it is
// never possible for isLegacyAccount() to be true for an account created
// through the new Create User flow.
export function isLegacyAccount(profile: UserProfile | null): boolean {
  return !!profile && profile.role_level !== null && profile.role_level !== undefined;
}

let permCache: { userId: string; permissions: Set<string> } | null = null;
let permInFlight: Promise<Set<string>> | null = null;

// Fetches the caller's own permission set via the get_my_permissions() RPC
// (SECURITY DEFINER, server-resolves the caller's identity -- never trusts
// a client-supplied role/tenant), cached per session exactly like
// getCurrentProfile(). Returns an empty set for an inactive/deleted/
// unauthenticated caller (get_my_permissions() itself already returns no
// rows for those), and the FULL distinct permission list for a business
// admin (also mirrored server-side).
export async function getMyPermissions(forceRefresh = false): Promise<Set<string>> {
  const profile = await getCurrentProfile(forceRefresh);
  if (!profile) return new Set();

  if (!forceRefresh && permCache && permCache.userId === profile.id) {
    return permCache.permissions;
  }
  if (!forceRefresh && permInFlight) {
    return permInFlight;
  }

  const fetchAndCache = async () => {
    try {
      const { data, error } = await supabase.rpc('get_my_permissions');
      if (error) throw error;
      const permissions = new Set<string>((data || []).map((row: { permission: string }) => row.permission));
      permCache = { userId: profile.id, permissions };
      return permissions;
    } finally {
      permInFlight = null;
    }
  };

  permInFlight = fetchAndCache();
  return permInFlight;
}

// hasPermission(): the frontend mirror of the has_permission() SQL helper.
// Use this ALONE only for a capability that has no legacy equivalent at
// all (e.g. a brand-new operations_manager-only view). For any page/action
// a legacy role could already reach, use canAccess() below instead, so
// existing legacy accounts are never regressed.
export async function hasPermission(permission: PermissionKey): Promise<boolean> {
  const profile = await getCurrentProfile();
  if (!profile || !profile.is_active || profile.deleted_at) return false;
  if (isBusinessAdmin(profile)) return true;
  const perms = await getMyPermissions();
  return perms.has(permission);
}

// hasExplicitPermission(): a DELIBERATELY NARROWER cousin of hasPermission()
// -- calls the has_explicit_permission() SQL RPC (see migration
// 20260905000000), which has NO is_business_admin() shortcut. Use this
// ONLY where a business admin/functional Admin account must NOT receive a
// capability "for free" the way every other permission in this app grants
// it (currently: Terminal Dues approve/pay/return-for-correction, where
// Admin explicitly must not gain payment authority merely by being an
// Admin). Mirrors the true-super-admin bypass only -- never role_level,
// never is_business_admin().
export async function hasExplicitPermission(permission: PermissionKey): Promise<boolean> {
  const profile = await getCurrentProfile();
  if (!profile || !profile.is_active || profile.deleted_at) return false;
  if (profile.is_super_admin) return true;
  const { data, error } = await supabase.rpc('has_explicit_permission', { p_permission: permission });
  if (error) return false;
  return !!data;
}

// canAccess(): the composable frontend shape matching every RLS
// policy/RPC in this rollout -- `legacyAllowed OR has_permission(...)`.
// `legacyAllowed` should be computed from the EXACT SAME role_level
// condition the page already used before this rollout (so an existing
// legacy account sees zero behavior change), with the caller responsible
// for using a null-safe fallback (e.g. `profile?.role_level || 4`, the
// convention already used throughout this codebase) when deriving it --
// a raw `profile.role_level <= N` comparison is NOT safe to pass in
// directly, since JavaScript coerces `null <= N` to `true` (unlike SQL's
// NULL-safe comparison semantics), which would silently over-grant access
// to a new functional-role account whose role_level is null.
export async function canAccess(legacyAllowed: boolean, permission: PermissionKey): Promise<boolean> {
  if (legacyAllowed) return true;
  return hasPermission(permission);
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    permCache = null;
  }
});
