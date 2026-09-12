import { describe, it, expect } from 'vitest';
import {
  buildOpenDueStatusMap,
  getOpenDueLabel,
  isOpenDueUniqueViolation,
  DUPLICATE_OPEN_DUE_MESSAGE,
} from './terminalDuesDuplicates';

// Regression coverage for the real staging duplicate: HR was able to
// create two Pending terminal_dues rows for the same employee (Andrew
// Simakweli, SFG-S-428) because nothing -- not the UI, not the database --
// checked for an existing open row. The real fix is the database's
// partial unique index; these functions only drive employee-selector
// disabling and duplicate-attempt messaging.

describe('buildOpenDueStatusMap', () => {
  it('maps an employee with a pending row to "pending"', () => {
    const map = buildOpenDueStatusMap([{ employee_id: 'e1', status: 'pending' }]);
    expect(map.get('e1')).toBe('pending');
  });

  it('maps an employee with an approved row to "approved"', () => {
    const map = buildOpenDueStatusMap([{ employee_id: 'e1', status: 'approved' }]);
    expect(map.get('e1')).toBe('approved');
  });

  it('an employee with ONLY a paid row is absent from the map -- Paid never blocks a new calculation', () => {
    const map = buildOpenDueStatusMap([{ employee_id: 'e1', status: 'paid' }]);
    expect(map.has('e1')).toBe(false);
  });

  it('two different employees each get their own independent entry', () => {
    const map = buildOpenDueStatusMap([
      { employee_id: 'e1', status: 'pending' },
      { employee_id: 'e2', status: 'approved' },
    ]);
    expect(map.get('e1')).toBe('pending');
    expect(map.get('e2')).toBe('approved');
  });

  it('an employee with a paid row AND a separate open row still shows the open one', () => {
    const map = buildOpenDueStatusMap([
      { employee_id: 'e1', status: 'paid' },
      { employee_id: 'e1', status: 'pending' },
    ]);
    expect(map.get('e1')).toBe('pending');
  });

  it('empty input yields an empty map', () => {
    expect(buildOpenDueStatusMap([]).size).toBe(0);
  });
});

describe('getOpenDueLabel', () => {
  it('pending status reads "Existing Pending Terminal Due"', () => {
    expect(getOpenDueLabel('pending')).toBe('Existing Pending Terminal Due');
  });

  it('approved status reads "Existing Approved Terminal Due"', () => {
    expect(getOpenDueLabel('approved')).toBe('Existing Approved Terminal Due');
  });

  it('no open status (undefined) returns null -- employee is selectable', () => {
    expect(getOpenDueLabel(undefined)).toBeNull();
  });
});

describe('isOpenDueUniqueViolation', () => {
  it('recognizes a genuine 23505 violation of the specific index', () => {
    const error = { code: '23505', message: 'duplicate key value violates unique constraint "idx_terminal_dues_one_open_per_employee"' };
    expect(isOpenDueUniqueViolation(error)).toBe(true);
  });

  it('does NOT match a 23505 from an unrelated constraint', () => {
    const error = { code: '23505', message: 'duplicate key value violates unique constraint "terminal_dues_pkey"' };
    expect(isOpenDueUniqueViolation(error)).toBe(false);
  });

  it('does NOT match a non-23505 error', () => {
    const error = { code: '23503', message: 'idx_terminal_dues_one_open_per_employee' };
    expect(isOpenDueUniqueViolation(error)).toBe(false);
  });

  it('does NOT match a plain Error with no code', () => {
    expect(isOpenDueUniqueViolation(new Error('idx_terminal_dues_one_open_per_employee'))).toBe(false);
  });

  it('does NOT match null/undefined/non-object input', () => {
    expect(isOpenDueUniqueViolation(null)).toBe(false);
    expect(isOpenDueUniqueViolation(undefined)).toBe(false);
    expect(isOpenDueUniqueViolation('some string')).toBe(false);
  });
});

describe('DUPLICATE_OPEN_DUE_MESSAGE', () => {
  it('is the exact friendly message required for the frontend', () => {
    expect(DUPLICATE_OPEN_DUE_MESSAGE).toBe('This employee already has an open Terminal Due.');
  });
});
