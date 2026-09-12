import { describe, it, expect } from 'vitest';
import {
  canProcessPayroll,
  canEditPayroll,
  canViewPayroll,
  canApprovePayroll,
  isMonthApproved,
  isPendingApproval,
} from './payrollPermissions';

describe('role permission helpers', () => {
  const admin = { isSuperAdmin: false, roleLevel: 1 };
  const manager = { isSuperAdmin: false, roleLevel: 2 };
  const supervisor = { isSuperAdmin: false, roleLevel: 3 };
  const staff = { isSuperAdmin: false, roleLevel: 4 };
  const superAdmin = { isSuperAdmin: true, roleLevel: 4 }; // a super admin with an otherwise-Staff role_level

  describe('canProcessPayroll', () => {
    it('allows only Admin (role_level 1) or a super admin', () => {
      expect(canProcessPayroll(admin)).toBe(true);
      expect(canProcessPayroll(manager)).toBe(false);
      expect(canProcessPayroll(supervisor)).toBe(false);
      expect(canProcessPayroll(staff)).toBe(false);
      expect(canProcessPayroll(superAdmin)).toBe(true);
    });
  });

  describe('canEditPayroll', () => {
    it('allows Admin and Manager (role_level <= 2), or a super admin', () => {
      expect(canEditPayroll(admin)).toBe(true);
      expect(canEditPayroll(manager)).toBe(true);
      expect(canEditPayroll(supervisor)).toBe(false);
      expect(canEditPayroll(staff)).toBe(false);
      expect(canEditPayroll(superAdmin)).toBe(true);
    });
  });

  describe('canViewPayroll', () => {
    it('allows Admin, Manager, and Supervisor (role_level <= 3), or a super admin', () => {
      expect(canViewPayroll(admin)).toBe(true);
      expect(canViewPayroll(manager)).toBe(true);
      expect(canViewPayroll(supervisor)).toBe(true);
      expect(canViewPayroll(staff)).toBe(false);
      expect(canViewPayroll(superAdmin)).toBe(true);
    });
  });

  describe('canApprovePayroll', () => {
    it('allows only Admin (role_level 1) or a super admin -- same rule as processing', () => {
      expect(canApprovePayroll(admin)).toBe(true);
      expect(canApprovePayroll(manager)).toBe(false);
      expect(canApprovePayroll(supervisor)).toBe(false);
      expect(canApprovePayroll(staff)).toBe(false);
      expect(canApprovePayroll(superAdmin)).toBe(true);
    });
  });
});

describe('isMonthApproved / isPendingApproval (payroll approval immutability logic)', () => {
  it('an empty payroll run is neither approved nor pending', () => {
    expect(isMonthApproved([])).toBe(false);
    expect(isPendingApproval([])).toBe(false);
  });

  it('is approved only when every record is approved', () => {
    const allApproved = [{ approval_status: 'approved' }, { approval_status: 'approved' }];
    expect(isMonthApproved(allApproved)).toBe(true);
    expect(isPendingApproval(allApproved)).toBe(false);
  });

  it('is pending when all records are pending', () => {
    const allPending = [{ approval_status: 'pending' }, { approval_status: 'pending' }];
    expect(isMonthApproved(allPending)).toBe(false);
    expect(isPendingApproval(allPending)).toBe(true);
  });

  it('a partially-approved batch is pending, not approved -- approval cannot be "mostly" true', () => {
    const partial = [{ approval_status: 'approved' }, { approval_status: 'pending' }];
    expect(isMonthApproved(partial)).toBe(false);
    expect(isPendingApproval(partial)).toBe(true);
  });

  it('a rejected batch is pending, not approved', () => {
    const rejected = [{ approval_status: 'rejected' }];
    expect(isMonthApproved(rejected)).toBe(false);
    expect(isPendingApproval(rejected)).toBe(true);
  });
});
