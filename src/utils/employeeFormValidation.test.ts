import { describe, it, expect } from 'vitest';
import { validateEmployeeForm, EmployeeFormValidationFields } from './employeeFormValidation';

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
