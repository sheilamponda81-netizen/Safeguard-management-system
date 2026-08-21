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
  TERMINAL_DUES_PROCESS: 'terminal_dues.process',
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
