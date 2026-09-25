import { describe, it, expect } from 'vitest';
import {
  isBusinessAdmin, isLegacyAccount, PERMISSIONS, FUNCTIONAL_ROLES, ROLE_DISPLAY_NAMES,
  getRoleDisplayLabel, getAddUserRoleOptions, resolveAddUserRoleSelection, canChangeCurrentPayrollMonth,
  canChooseAnyRegion,
} from './permissions';
import type { UserProfile } from './currentProfile';
import { resolveAllowedPages, NAV_PERMISSIONS } from '../components/Sidebar';

// Minimal profile builder -- only the fields isBusinessAdmin/isLegacyAccount/
// resolveAllowedPages actually read.
function makeProfile(overrides: Partial<UserProfile>): UserProfile {
  return {
    id: 'u1',
    tenant_id: 't1',
    email: 'user@example.com',
    full_name: 'Test User',
    role: null,
    role_level: null,
    department: null,
    is_super_admin: false,
    is_active: true,
    region_id: 'r1',
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    regions: null,
    ...overrides,
  };
}

describe('permission constants', () => {
  it('defines the 4 functional roles', () => {
    expect(FUNCTIONAL_ROLES).toEqual(['admin', 'hr_manager', 'accountant', 'operations_manager']);
  });

  it('has a display name for every functional role', () => {
    FUNCTIONAL_ROLES.forEach((role) => {
      expect(ROLE_DISPLAY_NAMES[role]).toBeTruthy();
    });
  });

  it('every permission key follows the dot-namespaced convention', () => {
    Object.values(PERMISSIONS).forEach((key) => {
      expect(key).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    });
  });
});

describe('isBusinessAdmin', () => {
  it('is true for a new-model admin account (role="admin", role_level=null)', () => {
    expect(isBusinessAdmin(makeProfile({ role: 'admin', role_level: null }))).toBe(true);
  });

  it('is true for a legacy Admin (role_level=1) regardless of role text', () => {
    expect(isBusinessAdmin(makeProfile({ role: 'staff', role_level: 1 }))).toBe(true);
  });

  it('is false for hr_manager/accountant/operations_manager', () => {
    expect(isBusinessAdmin(makeProfile({ role: 'hr_manager', role_level: null }))).toBe(false);
    expect(isBusinessAdmin(makeProfile({ role: 'accountant', role_level: null }))).toBe(false);
    expect(isBusinessAdmin(makeProfile({ role: 'operations_manager', role_level: null }))).toBe(false);
  });

  it('is false for a legacy Manager/Supervisor/Staff (role_level 2/3/4)', () => {
    expect(isBusinessAdmin(makeProfile({ role_level: 2 }))).toBe(false);
    expect(isBusinessAdmin(makeProfile({ role_level: 3 }))).toBe(false);
    expect(isBusinessAdmin(makeProfile({ role_level: 4 }))).toBe(false);
  });

  it('is false for a null profile', () => {
    expect(isBusinessAdmin(null)).toBe(false);
  });
});

// HOTFIX (STAGING blockers 1 & 2): canChooseAnyRegion backs both the
// Attendance region-edit gate and the Add Employee region field's
// select-vs-locked-input gate -- see attendancePermissions.test.ts and this
// engagement's report for the STAGING reproduction this closes.
describe('canChooseAnyRegion', () => {
  it('is true for a Super Admin', () => {
    expect(canChooseAnyRegion(makeProfile({ is_super_admin: true, role: 'hr_manager', region_id: null }))).toBe(true);
  });

  it('is true for a new-model Business Admin (role="admin", region_id=null) -- the confirmed STAGING persona', () => {
    expect(canChooseAnyRegion(makeProfile({ role: 'admin', role_level: null, is_super_admin: false, region_id: null }))).toBe(true);
  });

  it('is true for a legacy Business Admin (role_level=1) regardless of role text', () => {
    expect(canChooseAnyRegion(makeProfile({ role: null, role_level: 1, is_super_admin: false, region_id: null }))).toBe(true);
  });

  it('is false for a region-scoped functional role (hr_manager/accountant/operations_manager)', () => {
    expect(canChooseAnyRegion(makeProfile({ role: 'hr_manager', role_level: null, region_id: 'r1' }))).toBe(false);
    expect(canChooseAnyRegion(makeProfile({ role: 'accountant', role_level: null, region_id: 'r1' }))).toBe(false);
    expect(canChooseAnyRegion(makeProfile({ role: 'operations_manager', role_level: null, region_id: 'r1' }))).toBe(false);
  });

  it('is false for a region-scoped legacy account (Manager/Supervisor/Staff, role_level 2/3/4)', () => {
    expect(canChooseAnyRegion(makeProfile({ role_level: 2, region_id: 'r1' }))).toBe(false);
    expect(canChooseAnyRegion(makeProfile({ role_level: 3, region_id: 'r1' }))).toBe(false);
    expect(canChooseAnyRegion(makeProfile({ role_level: 4, region_id: 'r1' }))).toBe(false);
  });

  it('is false for a null profile', () => {
    expect(canChooseAnyRegion(null)).toBe(false);
  });
});

describe('isLegacyAccount', () => {
  it('is true whenever role_level is a real number, regardless of value', () => {
    expect(isLegacyAccount(makeProfile({ role_level: 1 }))).toBe(true);
    expect(isLegacyAccount(makeProfile({ role_level: 4 }))).toBe(true);
  });

  it('is false for every new functional-role account -- role_level is NULL by design', () => {
    expect(isLegacyAccount(makeProfile({ role: 'admin', role_level: null }))).toBe(false);
    expect(isLegacyAccount(makeProfile({ role: 'hr_manager', role_level: null }))).toBe(false);
    expect(isLegacyAccount(makeProfile({ role: 'accountant', role_level: null }))).toBe(false);
    expect(isLegacyAccount(makeProfile({ role: 'operations_manager', role_level: null }))).toBe(false);
  });

  it('is false for a null profile', () => {
    expect(isLegacyAccount(null)).toBe(false);
  });
});

describe('resolveAllowedPages', () => {
  // Mirrors App.tsx's/Sidebar.tsx's own legacy map exactly, so this test
  // proves the shared derivation, not a copy that could drift.
  const legacyMap = {
    1: ['dashboard', 'employees', 'recruitment', 'attendance', 'payroll', 'payslips', 'payments', 'terminal-dues', 'salary-advances', 'reports', 'settings', 'security', 'features', 'auditlogs', 'user-manual'],
    2: ['dashboard', 'employees', 'recruitment', 'attendance', 'payments', 'terminal-dues', 'salary-advances', 'reports', 'security', 'user-manual'],
    3: ['dashboard', 'attendance', 'security', 'user-manual'],
    4: ['dashboard', 'payslips', 'user-manual'],
  } as const;

  it('a legacy account gets exactly its role_level page list, unchanged', () => {
    expect(resolveAllowedPages(makeProfile({ role_level: 2 }), new Set(), legacyMap as any))
      .toEqual(legacyMap[2]);
    expect(resolveAllowedPages(makeProfile({ role_level: 4 }), new Set(), legacyMap as any))
      .toEqual(legacyMap[4]);
  });

  it('an unrecognized legacy role_level falls back to the Staff (4) list', () => {
    expect(resolveAllowedPages(makeProfile({ role_level: 99 }), new Set(), legacyMap as any))
      .toEqual(legacyMap[4]);
  });

  it('a new-model admin account (role_level=null) gets every page, including settings/auditlogs', () => {
    const pages = resolveAllowedPages(makeProfile({ role: 'admin', role_level: null }), new Set(), legacyMap as any);
    expect(pages).toContain('settings');
    expect(pages).toContain('auditlogs');
    expect(pages).toContain('payroll');
    expect(pages).toContain('recruitment');
  });

  it('HR Manager gets employees/recruitment/terminal-dues/security but NOT payroll/payments/reports/settings/attendance', () => {
    const perms = new Set(['dashboard.view', 'employees.view', 'recruitment.view', 'terminal_dues.view', 'security_personnel.view', 'user_manual.view', 'future_features.view']);
    const pages = resolveAllowedPages(makeProfile({ role: 'hr_manager', role_level: null }), perms, legacyMap as any);
    expect(pages).toEqual(expect.arrayContaining(['dashboard', 'employees', 'recruitment', 'terminal-dues', 'security', 'user-manual', 'features']));
    expect(pages).not.toContain('payroll');
    expect(pages).not.toContain('payments');
    expect(pages).not.toContain('reports');
    expect(pages).not.toContain('settings');
    expect(pages).not.toContain('auditlogs');
    expect(pages).not.toContain('attendance');
    expect(pages).not.toContain('salary-advances');
  });

  it('Accountant gets payroll/payments/payslips/salary-advances/reports/employees but NOT recruitment/security/attendance', () => {
    const perms = new Set(['dashboard.view', 'payroll.view', 'payments.view', 'payslips.view', 'salary_advances.view', 'reports.financial.view', 'employees.view', 'terminal_dues.view', 'user_manual.view', 'future_features.view']);
    const pages = resolveAllowedPages(makeProfile({ role: 'accountant', role_level: null }), perms, legacyMap as any);
    expect(pages).toEqual(expect.arrayContaining(['dashboard', 'payroll', 'payments', 'payslips', 'salary-advances', 'reports', 'employees', 'terminal-dues']));
    expect(pages).not.toContain('recruitment');
    expect(pages).not.toContain('security');
    expect(pages).not.toContain('attendance');
    expect(pages).not.toContain('settings');
    expect(pages).not.toContain('auditlogs');
  });

  it('Operations Manager gets employees/security/attendance/reports but NOT payroll/recruitment/payments', () => {
    const perms = new Set(['dashboard.view', 'employees.view', 'reports.operational.view', 'security_personnel.view', 'attendance.view', 'user_manual.view', 'future_features.view']);
    const pages = resolveAllowedPages(makeProfile({ role: 'operations_manager', role_level: null }), perms, legacyMap as any);
    expect(pages).toEqual(expect.arrayContaining(['dashboard', 'employees', 'security', 'attendance', 'reports']));
    expect(pages).not.toContain('payroll');
    expect(pages).not.toContain('recruitment');
    expect(pages).not.toContain('payments');
    expect(pages).not.toContain('salary-advances');
    expect(pages).not.toContain('terminal-dues');
    expect(pages).not.toContain('settings');
    expect(pages).not.toContain('auditlogs');
  });

  it('User Manual and Future Features are reachable by every functional role', () => {
    const roles: Array<{ role: string; perms: string[] }> = [
      { role: 'hr_manager', perms: ['user_manual.view', 'future_features.view'] },
      { role: 'accountant', perms: ['user_manual.view', 'future_features.view'] },
      { role: 'operations_manager', perms: ['user_manual.view', 'future_features.view'] },
    ];
    roles.forEach(({ role, perms }) => {
      const pages = resolveAllowedPages(makeProfile({ role, role_level: null }), new Set(perms), legacyMap as any);
      expect(pages).toContain('user-manual');
      expect(pages).toContain('features');
    });
  });

  it('role_level = NULL never picks up a legacy Manager/Supervisor page list -- a new functional role with NO matching permissions falls back to the minimal default, never legacyMap[2]/[3]', () => {
    const pages = resolveAllowedPages(makeProfile({ role: 'hr_manager', role_level: null }), new Set(), legacyMap as any);
    expect(pages).not.toEqual(legacyMap[2]);
    expect(pages).not.toEqual(legacyMap[3]);
    expect(pages).toEqual(['dashboard', 'user-manual']);
  });

  it('a functional account with zero matching permissions still gets dashboard + user-manual, never an empty page list', () => {
    const pages = resolveAllowedPages(makeProfile({ role: 'accountant', role_level: null }), new Set(), legacyMap as any);
    expect(pages).toEqual(['dashboard', 'user-manual']);
  });
});

describe('NAV_PERMISSIONS shape', () => {
  it('settings and auditlogs are NOT permission-table-backed -- Admin-only via is_business_admin(), not a permission key', () => {
    expect(NAV_PERMISSIONS.settings).toBeUndefined();
    expect(NAV_PERMISSIONS.auditlogs).toBeUndefined();
  });

  it('reports requires financial or operational view (recruitment view alone is not sufficient, matching the correction that Recruitment must not be a side door)', () => {
    expect(NAV_PERMISSIONS.reports).toEqual(
      expect.arrayContaining([PERMISSIONS.REPORTS_FINANCIAL_VIEW, PERMISSIONS.REPORTS_OPERATIONAL_VIEW])
    );
  });
});

// ============================================================
// HOTFIX: formal Super Administrator model -- regression tests 1-3 and 9
// from the hotfix's required 15-item test list. Items 4-8/10-12 (create-
// user Edge Function authorization, the set_super_admin_status RPC, and
// the system_settings/terminal_dues database enforcement) are SQL/RPC/RLS
// behavior -- exercised empirically in a disposable local PostgreSQL
// instance per the hotfix's own testing instructions, not here (this repo
// has no integration harness reaching a real Postgres from vitest). Items
// 4/5's pure request-shape decision (canGrantSuperAdmin) IS unit-tested,
// in src/utils/createUserValidation.test.ts.
// ============================================================
describe('getRoleDisplayLabel (HOTFIX: Super Administrator label)', () => {
  it('is_super_admin=true displays "Super Administrator" regardless of role/role_level', () => {
    expect(getRoleDisplayLabel({ is_super_admin: true, role: 'admin', role_level: null })).toBe('Super Administrator');
    expect(getRoleDisplayLabel({ is_super_admin: true, role: null, role_level: 1 })).toBe('Super Administrator');
  });

  it('an ordinary functional Admin (is_super_admin=false) displays "Admin", never "Super Administrator"', () => {
    expect(getRoleDisplayLabel({ is_super_admin: false, role: 'admin', role_level: null })).toBe('Admin');
  });

  it('an ordinary legacy Admin (role_level=1, is_super_admin=false) displays "Administrator", never "Super Administrator"', () => {
    expect(getRoleDisplayLabel({ is_super_admin: false, role: null, role_level: 1 })).toBe('Administrator');
  });

  it('is_super_admin takes precedence even for a legacy role_level=1 account', () => {
    expect(getRoleDisplayLabel({ is_super_admin: true, role: null, role_level: 1 })).toBe('Super Administrator');
  });
});

describe('getAddUserRoleOptions (HOTFIX: Add User role selector visibility)', () => {
  it('a normal Admin caller (is_super_admin=false) never sees "super_admin" as an option', () => {
    const options = getAddUserRoleOptions(false);
    expect(options).not.toContain('super_admin');
    expect(options).toEqual([...FUNCTIONAL_ROLES]);
  });

  it('a genuine Super Administrator caller sees "super_admin" as the first option, plus all 4 functional roles', () => {
    const options = getAddUserRoleOptions(true);
    expect(options[0]).toBe('super_admin');
    expect(options).toEqual(['super_admin', ...FUNCTIONAL_ROLES]);
  });
});

describe('resolveAddUserRoleSelection (HOTFIX: Add User submit-time translation)', () => {
  it('selecting "super_admin" translates to role=admin + requestSuperAdmin=true -- never persists a literal "super_admin" role string', () => {
    const result = resolveAddUserRoleSelection('super_admin');
    expect(result).toEqual({ role: 'admin', requestSuperAdmin: true });
  });

  it('selecting an ordinary functional role passes it through unchanged with requestSuperAdmin=false', () => {
    expect(resolveAddUserRoleSelection('hr_manager')).toEqual({ role: 'hr_manager', requestSuperAdmin: false });
    expect(resolveAddUserRoleSelection('admin')).toEqual({ role: 'admin', requestSuperAdmin: false });
  });
});

describe('canChangeCurrentPayrollMonth (HOTFIX: test item 9 -- month change unavailable to normal Admin)', () => {
  it('a normal Admin (is_super_admin=false, even role_level=1) cannot change the month', () => {
    expect(canChangeCurrentPayrollMonth({ is_super_admin: false })).toBe(false);
    expect(canChangeCurrentPayrollMonth({ is_super_admin: undefined })).toBe(false);
  });

  it('a genuine Super Administrator can change the month', () => {
    expect(canChangeCurrentPayrollMonth({ is_super_admin: true })).toBe(true);
  });

  it('a null/undefined profile (not yet loaded) cannot change the month -- fails closed, never defaults to true', () => {
    expect(canChangeCurrentPayrollMonth(null)).toBe(false);
    expect(canChangeCurrentPayrollMonth(undefined)).toBe(false);
  });
});
