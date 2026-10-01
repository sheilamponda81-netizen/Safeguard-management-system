import { describe, it, expect } from 'vitest';
import { PAYABLE_EMPLOYEE_STATUSES } from './employeeStatus';

// Regression coverage for the Payroll/Payment reconciliation fix: this
// whitelist is what Payroll.tsx's current/future-month employee roster
// query now filters on (replacing a bare `.eq('status', 'Active')` that
// silently excluded every approved-leave employee from payroll entirely).
describe('PAYABLE_EMPLOYEE_STATUSES', () => {
  it('includes Active and On Leave -- approved leave must not exclude an employee from payroll', () => {
    expect(PAYABLE_EMPLOYEE_STATUSES).toContain('Active');
    expect(PAYABLE_EMPLOYEE_STATUSES).toContain('On Leave');
  });

  it('is a narrow whitelist, not every status -- a non-payable status (e.g. Suspended) must stay excluded', () => {
    expect(PAYABLE_EMPLOYEE_STATUSES).not.toContain('Suspended');
    expect(PAYABLE_EMPLOYEE_STATUSES).not.toContain('Terminated');
    expect(PAYABLE_EMPLOYEE_STATUSES).not.toContain('Deleted');
    expect(PAYABLE_EMPLOYEE_STATUSES.length).toBe(2);
  });
});
