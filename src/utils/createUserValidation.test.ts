import { describe, it, expect } from 'vitest';
// Imports the actual validation module the create-user Edge Function runs
// (supabase/functions/create-user/validation.ts) -- not a copy -- so this
// test exercises the real logic deployed server-side, not a duplicate that
// could drift. The module is plain, dependency-free TypeScript (no Deno-
// specific syntax), so it resolves fine under Node/Vite despite living
// outside src/.
import {
  isValidEmail,
  isValidPassword,
  isAllowedRole,
  isRegionRequired,
  validateCreateUserInput,
  canGrantSuperAdmin,
  MIN_PASSWORD_LENGTH,
} from '../../supabase/functions/create-user/validation';

describe('isValidEmail', () => {
  it('accepts a normal email', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
  });

  it('rejects missing @ or domain', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('user@')).toBe(false);
    expect(isValidEmail('@example.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});

describe('isValidPassword', () => {
  it(`requires at least ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(isValidPassword('short')).toBe(false);
    expect(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
    expect(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(isValidPassword('a very long and reasonable password')).toBe(true);
  });
});

describe('isAllowedRole', () => {
  it('accepts exactly the 4 functional roles', () => {
    expect(isAllowedRole('admin')).toBe(true);
    expect(isAllowedRole('hr_manager')).toBe(true);
    expect(isAllowedRole('accountant')).toBe(true);
    expect(isAllowedRole('operations_manager')).toBe(true);
  });

  it('rejects anything else, including legacy role names and is_super_admin-style strings', () => {
    expect(isAllowedRole('manager')).toBe(false);
    expect(isAllowedRole('staff')).toBe(false);
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

describe('validateCreateUserInput', () => {
  const validBase = {
    email: 'new.hr@example.com',
    password: 'a-reasonably-long-password',
    full_name: 'Jane HR',
    role: 'hr_manager',
    region_id: 'region-1',
  };

  it('accepts a fully valid non-admin input', () => {
    expect(validateCreateUserInput(validBase)).toEqual({ valid: true });
  });

  it('accepts a valid admin input with region_id null (admin needs no region)', () => {
    expect(validateCreateUserInput({ ...validBase, role: 'admin', region_id: null })).toEqual({ valid: true });
  });

  it('rejects a bad email', () => {
    const result = validateCreateUserInput({ ...validBase, email: 'not-an-email' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/email/i);
  });

  it('rejects a short password without ever including the password in the error message', () => {
    const result = validateCreateUserInput({ ...validBase, password: 'short' });
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain('short');
  });

  it('rejects an empty/whitespace-only full name', () => {
    expect(validateCreateUserInput({ ...validBase, full_name: '' }).valid).toBe(false);
    expect(validateCreateUserInput({ ...validBase, full_name: '   ' }).valid).toBe(false);
  });

  it('rejects a role outside the 4 functional roles -- e.g. attempting to create a super_admin this way', () => {
    const result = validateCreateUserInput({ ...validBase, role: 'super_admin' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/role/i);
  });

  it('rejects a non-admin role with no region_id', () => {
    const result = validateCreateUserInput({ ...validBase, region_id: null });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/region/i);
  });

  it('checks fields in a stable order (email before password before name before role before region)', () => {
    // A completely empty/invalid input should fail on email first, not
    // some other field -- confirms the validation order matches
    // create-user/index.ts's own sequential checks.
    const result = validateCreateUserInput({ email: '', password: '', full_name: '', role: '', region_id: null });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/email/i);
  });
});

// HOTFIX: formal Super Administrator model -- regression test items 4 and 5
// from the hotfix's required 15-item test list ("create-user rejects
// super-admin creation by normal Admin" / "create-user allows it for
// genuine Super Admin"). canGrantSuperAdmin is the exact authorization
// decision create-user/index.ts applies to a request body that includes
// `is_super_admin: true` -- never trusting that flag alone.
describe('canGrantSuperAdmin (HOTFIX: create-user super-admin creation authorization)', () => {
  it('a request with no is_super_admin flag is always valid, regardless of caller', () => {
    expect(canGrantSuperAdmin(false, false, 'hr_manager')).toEqual({ valid: true });
    expect(canGrantSuperAdmin(false, true, 'admin')).toEqual({ valid: true });
  });

  it('test item 4: rejects super-admin creation requested by a normal (non-super-admin) Admin', () => {
    const result = canGrantSuperAdmin(true, false, 'admin');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Super Administrator/);
  });

  it('test item 5: allows super-admin creation for a genuine Super Admin caller, target role=admin', () => {
    expect(canGrantSuperAdmin(true, true, 'admin')).toEqual({ valid: true });
  });

  it('rejects super-admin creation even for a genuine Super Admin caller if the target role is not admin -- there is no super-admin hr_manager/accountant/operations_manager', () => {
    const result = canGrantSuperAdmin(true, true, 'hr_manager');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/role=admin/);
  });

  it('never silently downgrades -- a rejected request always reports valid:false, never valid:true with is_super_admin quietly dropped', () => {
    expect(canGrantSuperAdmin(true, false, 'admin').valid).toBe(false);
    expect(canGrantSuperAdmin(true, false, 'hr_manager').valid).toBe(false);
  });
});
