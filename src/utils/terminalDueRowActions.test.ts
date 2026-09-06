import { describe, it, expect } from 'vitest';
import { getVisibleTerminalDueActions, shouldShowReturnedForCorrectionBanner, TerminalDuePermissions } from './terminalDueRowActions';

// Regression coverage for the real staging bug: a functional Admin's row
// still showed the Edit/pencil action on a Pending Terminal Due, because
// canEditTerminalDue/canCreateTerminalDue (TerminalDues.tsx) used to be
// resolved via canAccess()/hasPermission() -- which grants a business
// admin every permission "for free" -- instead of hasExplicitPermission(),
// the same narrow helper canApproveTerminalDue/canPayTerminalDue already
// used. These tests exercise the exact per-role, per-status action matrix
// the business now requires; TerminalDues.tsx now derives every one of its
// four permission booleans (canCreate/canEdit/canApprove/canPay) via
// hasExplicitPermission(), so passing each role's REAL resolved values
// here is equivalent to asserting what that role actually sees.

const HR: TerminalDuePermissions = { canCreate: true, canEdit: true, canApprove: false, canPay: false };
const ADMIN: TerminalDuePermissions = { canCreate: false, canEdit: false, canApprove: true, canPay: false };
const ACCOUNTANT: TerminalDuePermissions = { canCreate: false, canEdit: false, canApprove: false, canPay: true };

describe('getVisibleTerminalDueActions', () => {
  it('HR Manager on a Pending due: Edit visible, nothing else', () => {
    const actions = getVisibleTerminalDueActions('pending', HR);
    expect(actions).toEqual({
      showEdit: true,
      showApprove: false,
      showReturnForCorrection: false,
      showRecordPayment: false,
    });
  });

  it('HR Manager on an Approved due: nothing visible -- HR never approves/pays/edits a non-Pending row', () => {
    const actions = getVisibleTerminalDueActions('approved', HR);
    expect(actions).toEqual({
      showEdit: false,
      showApprove: false,
      showReturnForCorrection: false,
      showRecordPayment: false,
    });
  });

  it('Admin on a Pending due: Approve visible, Edit NOT visible -- the real staging bug this fixes', () => {
    const actions = getVisibleTerminalDueActions('pending', ADMIN);
    expect(actions).toEqual({
      showEdit: false,
      showApprove: true,
      showReturnForCorrection: false,
      showRecordPayment: false,
    });
  });

  it('Admin on an Approved due: Return for Correction visible, never Record Payment', () => {
    const actions = getVisibleTerminalDueActions('approved', ADMIN);
    expect(actions).toEqual({
      showEdit: false,
      showApprove: false,
      showReturnForCorrection: true,
      showRecordPayment: false,
    });
  });

  it('Accountant on a Pending due: nothing visible -- view only', () => {
    const actions = getVisibleTerminalDueActions('pending', ACCOUNTANT);
    expect(actions).toEqual({
      showEdit: false,
      showApprove: false,
      showReturnForCorrection: false,
      showRecordPayment: false,
    });
  });

  it('Accountant on an Approved due: Record Payment visible, nothing else', () => {
    const actions = getVisibleTerminalDueActions('approved', ACCOUNTANT);
    expect(actions).toEqual({
      showEdit: false,
      showApprove: false,
      showReturnForCorrection: false,
      showRecordPayment: true,
    });
  });

  it('Paid due: no action is ever visible, for any role, regardless of permissions', () => {
    for (const perms of [HR, ADMIN, ACCOUNTANT, { canCreate: true, canEdit: true, canApprove: true, canPay: true }]) {
      const actions = getVisibleTerminalDueActions('paid', perms);
      expect(actions).toEqual({
        showEdit: false,
        showApprove: false,
        showReturnForCorrection: false,
        showRecordPayment: false,
      });
    }
  });

  it('a true super admin (all four permissions true) still only sees the action matching the row\'s actual status', () => {
    const superAdmin: TerminalDuePermissions = { canCreate: true, canEdit: true, canApprove: true, canPay: true };
    expect(getVisibleTerminalDueActions('pending', superAdmin)).toEqual({
      showEdit: true,
      showApprove: true,
      showReturnForCorrection: false,
      showRecordPayment: false,
    });
    expect(getVisibleTerminalDueActions('approved', superAdmin)).toEqual({
      showEdit: false,
      showApprove: false,
      showReturnForCorrection: true,
      showRecordPayment: true,
    });
  });
});

// Regression coverage for the real staging gap: the Return for Correction
// reason was written by return_terminal_due_for_correction() but nowhere
// visible in the UI (only inside audit_logs.new_data, which HR has no
// SELECT access to at all -- see 20260907000000's migration header).
describe('shouldShowReturnedForCorrectionBanner', () => {
  it('an ordinary Pending record that was never returned (return_reason NULL) never shows the banner', () => {
    expect(shouldShowReturnedForCorrectionBanner('pending', null)).toBe(false);
  });

  it('a Pending record that WAS returned (return_reason set) shows the banner', () => {
    expect(shouldShowReturnedForCorrectionBanner('pending', 'Uniform refund amount looks wrong')).toBe(true);
  });

  it('an empty-string return_reason does not show the banner', () => {
    expect(shouldShowReturnedForCorrectionBanner('pending', '')).toBe(false);
  });

  it('never shows on an Approved row even if return_reason were somehow still set', () => {
    expect(shouldShowReturnedForCorrectionBanner('approved', 'stale reason')).toBe(false);
  });

  it('never shows on a Paid row even if return_reason were somehow still set', () => {
    expect(shouldShowReturnedForCorrectionBanner('paid', 'stale reason')).toBe(false);
  });
});
