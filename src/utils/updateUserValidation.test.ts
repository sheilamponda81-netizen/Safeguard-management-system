import { describe, it, expect } from 'vitest';
// Imports the actual validation module the update-user Edge Function runs
// (supabase/functions/update-user/validation.ts) -- not a copy -- so this
// test exercises the real logic deployed server-side, mirroring
// createUserValidation.test.ts's own approach.
import {
  isAllowedRole,
  isRegionRequired,
  findProtectedField,
  validateUpdateUserInput,
  PROTECTED_FIELDS,
} from '../../supabase/functions/update-user/validation';

describe('isAllowedRole', () => {
  it('accepts exactly the 4 functional roles', () => {
    expect(isAllowedRole('admin')).toBe(true);
    expect(isAllowedRole('hr_manager')).toBe(true);
    expect(isAllowedRole('accountant')).toBe(true);
    expect(isAllowedRole('operations_manager')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isAllowedRole('manager')).toBe(false);
    expect(isAllowedRole('super_admin')).toBe(false);
    expect(isAllowedRole('')).toBe(false);
  });
});

describe('isRegionRequired', () => {
  it('is false only for admin', () => {
    expect(isRegionRequired('admin')).toBe(false);
  });

  it('is true for hr_manager/accountant/operations_manager', () => {
    expect(isRegionRequired('hr_manager')).toBe(true);
    expect(isRegionRequired('accountant')).toBe(true);
    expect(isRegionRequired('operations_manager')).toBe(true);
  });
});

describe('findProtectedField', () => {
  it('returns null when no protected field is present', () => {
    expect(findProtectedField({ user_id: 'x', full_name: 'A', role: 'hr_manager', region_id: 'r' })).toBeNull();
  });

  it('detects each protected field individually, regardless of value', () => {
    for (const field of PROTECTED_FIELDS) {
      expect(findProtectedField({ user_id: 'x', [field]: null })).toBe(field);
      expect(findProtectedField({ user_id: 'x', [field]: 'anything' })).toBe(field);
    }
  });

  it('detects a protected field even when set to false/0/empty-string (own-key check, not truthiness)', () => {
    expect(findProtectedField({ is_super_admin: false })).toBe('is_super_admin');
    expect(findProtectedField({ role_level: 0 })).toBe('role_level');
    expect(findProtectedField({ email: '' })).toBe('email');
  });
});

describe('validateUpdateUserInput', () => {
  const validBase = {
    user_id: 'target-1',
    full_name: 'Jane Accountant',
    department: 'Finance',
    role: 'accountant',
    region_id: 'region-1',
  };

  it('accepts a fully valid non-admin input', () => {
    expect(validateUpdateUserInput(validBase)).toEqual({ valid: true });
  });

  it('accepts a valid admin input with region_id null', () => {
    expect(validateUpdateUserInput({ ...validBase, role: 'admin', region_id: null })).toEqual({ valid: true });
  });

  it('rejects a missing user_id', () => {
    const result = validateUpdateUserInput({ ...validBase, user_id: '' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/user_id/i);
  });

  it('rejects an empty/whitespace-only full name', () => {
    expect(validateUpdateUserInput({ ...validBase, full_name: '' }).valid).toBe(false);
    expect(validateUpdateUserInput({ ...validBase, full_name: '   ' }).valid).toBe(false);
  });

  it('rejects a role outside the 4 functional roles', () => {
    const result = validateUpdateUserInput({ ...validBase, role: 'super_admin' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/role/i);
  });

  it('rejects a non-admin role with no region_id', () => {
    const result = validateUpdateUserInput({ ...validBase, region_id: null });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/region/i);
  });
});
