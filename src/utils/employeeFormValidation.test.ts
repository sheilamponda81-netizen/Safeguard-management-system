import { describe, it, expect } from 'vitest';
import {
  validateEmployeeForm, EmployeeFormValidationFields,
  resolveEmployeeFormRegionId, resolveEmployeeUpdateRegionId,
} from './employeeFormValidation';
import { canChooseAnyRegion } from './permissions';
import type { UserProfile } from './currentProfile';

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

// A complete, otherwise-valid form -- individual tests below knock out one
// field at a time (or vary canChooseAnyRegion/region_id) rather than
// re-declare every required field per case.
function makeValidForm(overrides: Partial<EmployeeFormValidationFields> = {}): EmployeeFormValidationFields {
  return {
    employeeNumber: 'SFG-N-0001',
    fullName: 'Jane Doe',
    dob: '1990-01-01',
    gender: 'Female',
    phone: '0888123456',
    address: '123 Main St',
    position: 'Security Guard',
    department: 'Operations',
    qualification: 'standard 8',
    dateHired: '2026-01-01',
    contractType: 'Permanent',
    pay_point: 'Head Office',
    account_number: '5063532125021',
    next_of_kin_name: 'John Doe',
    next_of_kin_relationship: 'Spouse',
    next_of_kin_phone: '0888654321',
    assignment_type: 'company',
    company: 'Acme Co',
    region_id: 'r1',
    ...overrides,
  };
}

describe('validateEmployeeForm', () => {
  it('passes for a fully-filled form regardless of canChooseAnyRegion', () => {
    expect(validateEmployeeForm(makeValidForm(), true)).toBeNull();
    expect(validateEmployeeForm(makeValidForm(), false)).toBeNull();
  });

  it('requires Employee Number first, before any other field', () => {
    const result = validateEmployeeForm(makeValidForm({ employeeNumber: '' }), true);
    expect(result).toMatch(/Employee Number/);
  });

  it('reports the first missing required field by label', () => {
    expect(validateEmployeeForm(makeValidForm({ fullName: '' }))).toBe('Full Name');
    expect(validateEmployeeForm(makeValidForm({ dob: '' }))).toBe('Date of Birth');
  });

  // HOTFIX (STAGING blocker 2): canChooseAnyRegion (Super Admin OR Business
  // Admin, via src/utils/permissions.ts's canChooseAnyRegion()) now governs
  // Region requiredness here, not isSuperAdmin alone -- see
  // Employees.tsx's AddEmployeeForm render gate and permissions.test.ts for
  // the paired canChooseAnyRegion() unit coverage of who gets true/false.
  describe('Region requiredness', () => {
    it('requires Region when the caller can choose any region (Super Admin or Business Admin) and none was picked', () => {
      const result = validateEmployeeForm(makeValidForm({ region_id: '' }), true);
      expect(result).toBe('Region');
    });

    it('does NOT require Region from validateEmployeeForm when the caller cannot choose any region -- it is pre-assigned/locked instead', () => {
      const result = validateEmployeeForm(makeValidForm({ region_id: '' }), false);
      expect(result).toBeNull();
    });

    it('passes once a region has actually been picked', () => {
      expect(validateEmployeeForm(makeValidForm({ region_id: 'r2' }), true)).toBeNull();
    });
  });

  describe('assignment_type-dependent fields', () => {
    it('requires Company Name when assignment_type is "company"', () => {
      const result = validateEmployeeForm(makeValidForm({ assignment_type: 'company', company: '' }));
      expect(result).toBe('Company Name');
    });

    it('requires Resident Name when assignment_type is "resident"', () => {
      const result = validateEmployeeForm(makeValidForm({ assignment_type: 'resident', resident_name: '' }));
      expect(result).toBe('Resident Name');
    });
  });

  describe('format validation', () => {
    it('rejects a National ID that is not exactly 8 characters, when one is entered', () => {
      const result = validateEmployeeForm(makeValidForm({ nationalId: '1234567' }));
      expect(result).toMatch(/National ID/);
    });

    it('accepts a missing National ID (optional)', () => {
      expect(validateEmployeeForm(makeValidForm({ nationalId: '' }))).toBeNull();
    });

    it('rejects a phone number that is not exactly 10 digits', () => {
      const result = validateEmployeeForm(makeValidForm({ phone: '12345' }));
      expect(result).toMatch(/Phone Number/);
    });

    it('rejects a Next of Kin phone number that is not exactly 10 digits', () => {
      const result = validateEmployeeForm(makeValidForm({ next_of_kin_phone: '12345' }));
      expect(result).toMatch(/Next of Kin Phone Number/);
    });
  });
});

// HOTFIX (STAGING blocker: Edit Employee had no Region field at all -- see
// Employees.tsx's EditEmployeeForm). These two functions are the single
// source of truth for seeding the Edit form's region_id and for what
// actually reaches the employees UPDATE payload; the round trip between
// them is what a form-level "can I edit the region" test would otherwise
// need a full component render to exercise.
describe('resolveEmployeeFormRegionId (Edit form seeding)', () => {
  it('pre-populates from the employee\'s current region', () => {
    expect(resolveEmployeeFormRegionId('region-north')).toBe('region-north');
  });

  it('falls back to an empty string for a null/undefined region', () => {
    expect(resolveEmployeeFormRegionId(null)).toBe('');
    expect(resolveEmployeeFormRegionId(undefined)).toBe('');
  });
});

describe('resolveEmployeeUpdateRegionId (Edit form -> UPDATE payload)', () => {
  it('includes the changed region_id in the update payload', () => {
    expect(resolveEmployeeUpdateRegionId('region-south')).toBe('region-south');
  });

  it('fails safely to null (never an empty-string UUID) for a blank/whitespace value', () => {
    expect(resolveEmployeeUpdateRegionId('')).toBeNull();
    expect(resolveEmployeeUpdateRegionId('   ')).toBeNull();
    expect(resolveEmployeeUpdateRegionId(null)).toBeNull();
    expect(resolveEmployeeUpdateRegionId(undefined)).toBeNull();
  });
});

// HOTFIX: who gets EditEmployeeForm's free-choice Region <select> vs. the
// locked, read-only display -- same canChooseAnyRegion() helper Employees.tsx
// uses for the render gate (no second authorization definition). Full
// true/false matrix for canChooseAnyRegion() itself already lives in
// permissions.test.ts; these confirm the specific personas this STAGING
// blocker named.
describe('EditEmployeeForm Region editability (via canChooseAnyRegion)', () => {
  it('Super Admin can change an employee\'s region', () => {
    expect(canChooseAnyRegion(makeProfile({ is_super_admin: true, role: 'hr_manager', region_id: 'r1' }))).toBe(true);
  });

  it('functional Admin (role="admin", region_id=null -- the confirmed STAGING persona) can change an employee\'s region', () => {
    expect(canChooseAnyRegion(makeProfile({ role: 'admin', role_level: null, is_super_admin: false, region_id: null }))).toBe(true);
  });

  it('legacy Admin (role_level=1) can change an employee\'s region, per the current Business Admin model', () => {
    expect(canChooseAnyRegion(makeProfile({ role: null, role_level: 1, is_super_admin: false, region_id: null }))).toBe(true);
  });

  it('a region-scoped lower role cannot choose another region', () => {
    expect(canChooseAnyRegion(makeProfile({ role: 'hr_manager', role_level: null, region_id: 'r1' }))).toBe(false);
    expect(canChooseAnyRegion(makeProfile({ role: null, role_level: 3, region_id: 'r1' }))).toBe(false);
  });
});
