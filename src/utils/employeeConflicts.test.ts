import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal thenable Supabase mock. Each test controls what a given
// `.eq(column, value)` lookup resolves to via `mockResponses`, keyed
// "column:value". `.neq('id', x)` is honored for real (rows with that id
// are filtered out of whatever `mockResponses` would otherwise return) so
// the "exclude the employee being edited" behavior is genuinely exercised,
// not just assumed.
const { mockResponses } = vi.hoisted(() => ({
  mockResponses: {} as Record<string, { data: any[]; error: any }>,
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => {
        let column = '';
        let value = '';
        let excludeId: string | undefined;
        const builder: any = {
          eq: (c: string, v: string) => { column = c; value = v; return builder; },
          neq: (_c: string, v: string) => { excludeId = v; return builder; },
          then: (resolve: (v: { data: any[]; error: any }) => void) => {
            const result = mockResponses[`${column}:${value}`] || { data: [], error: null };
            const data = excludeId ? (result.data || []).filter((r: any) => r.id !== excludeId) : result.data;
            resolve({ data, error: result.error });
          },
        };
        return builder;
      },
    }),
  },
}));

import {
  checkEmployeeIdentifierConflicts,
  formatIdentifierConflictMessage,
  identifierColumnFromUniqueViolation,
} from './employeeConflicts';

function conflictRow(overrides: Partial<{ id: string; full_name: string; employee_number: string; workstation: string | null; status: string | null; is_deleted: boolean }> = {}) {
  return {
    id: 'row-1',
    full_name: 'JOHN BANDA',
    employee_number: 'SFG-S-123',
    workstation: 'Site X',
    status: 'Active',
    is_deleted: false,
    ...overrides,
  };
}

describe('checkEmployeeIdentifierConflicts', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockResponses)) delete mockResponses[key];
  });

  it('reports no conflicts when all identifiers are blank or null', async () => {
    const conflicts = await checkEmployeeIdentifierConflicts({ nationalId: '', phone: null, accountNumber: '   ' });
    expect(conflicts).toEqual([]);
  });

  it('never even looks up a blank identifier, even if a stray empty-string row would otherwise match', async () => {
    // A blank/empty column value must never be treated as "shared" by every
    // other employee who also left the field blank.
    mockResponses['national_id:'] = { data: [conflictRow()], error: null };
    const conflicts = await checkEmployeeIdentifierConflicts({ nationalId: '', phone: null, accountNumber: null });
    expect(conflicts).toEqual([]);
  });

  it('reports a single-field conflict with the existing employee named', async () => {
    mockResponses['account_number:123456'] = { data: [conflictRow({ employee_number: 'SFG-S-123', full_name: 'JOHN BANDA', workstation: 'Site X', status: 'Active' })], error: null };

    const conflicts = await checkEmployeeIdentifierConflicts({ accountNumber: '123456' });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ label: 'Account number', value: '123456' });
    expect(conflicts[0].rows).toHaveLength(1);
  });

  it('surfaces MULTIPLE existing owners of the same identifier, not just the first match', async () => {
    // Historical data predating any conflict check could already have more
    // than one employee sharing a value -- must not silently drop all but one.
    mockResponses['national_id:999'] = {
      data: [
        conflictRow({ id: 'a', full_name: 'JOHN BANDA' }),
        conflictRow({ id: 'b', full_name: 'MARY PHIRI' }),
      ],
      error: null,
    };

    const conflicts = await checkEmployeeIdentifierConflicts({ nationalId: '999' });

    expect(conflicts[0].rows).toHaveLength(2);
    expect(conflicts[0].rows.map(r => r.full_name)).toEqual(['JOHN BANDA', 'MARY PHIRI']);
  });

  it('surfaces conflicts on multiple DIFFERENT identifiers in the same save, not just the first one hit', async () => {
    mockResponses['national_id:111'] = { data: [conflictRow({ id: 'a' })], error: null };
    mockResponses['phone:0977000000'] = { data: [conflictRow({ id: 'b' })], error: null };

    const conflicts = await checkEmployeeIdentifierConflicts({ nationalId: '111', phone: '0977000000', accountNumber: '' });

    expect(conflicts.map(c => c.label).sort()).toEqual(['National ID', 'Phone number']);
  });

  it('includes a soft-deleted/inactive owner instead of hiding them', async () => {
    mockResponses['phone:0977111111'] = {
      data: [conflictRow({ status: 'Suspended', is_deleted: true })],
      error: null,
    };

    const conflicts = await checkEmployeeIdentifierConflicts({ phone: '0977111111' });

    expect(conflicts[0].rows[0]).toMatchObject({ status: 'Suspended', is_deleted: true });
  });

  it('excludes the employee currently being edited so it never conflicts with its own unchanged identifier', async () => {
    mockResponses['national_id:555'] = { data: [conflictRow({ id: 'self-id' })], error: null };

    const conflicts = await checkEmployeeIdentifierConflicts({ nationalId: '555' }, 'self-id');

    expect(conflicts).toEqual([]);
  });

  it('still reports a real conflict during an edit when the match is a DIFFERENT employee', async () => {
    mockResponses['national_id:555'] = { data: [conflictRow({ id: 'other-id' })], error: null };

    const conflicts = await checkEmployeeIdentifierConflicts({ nationalId: '555' }, 'self-id');

    expect(conflicts).toHaveLength(1);
  });
});

describe('formatIdentifierConflictMessage', () => {
  it('names the employee, employee number, site, and status for a single conflict', () => {
    const message = formatIdentifierConflictMessage([
      { label: 'Account number', column: 'account_number', value: '123456', rows: [conflictRow()] },
    ]);

    expect(message).toBe('Account number 123456 is already assigned to JOHN BANDA (SFG-S-123), Site X, status Active.');
  });

  it('marks a soft-deleted owner clearly, distinct from the active status value', () => {
    const message = formatIdentifierConflictMessage([
      { label: 'Phone number', column: 'phone', value: '0977111111', rows: [conflictRow({ status: 'Suspended', is_deleted: true })] },
    ]);

    expect(message).toContain('status Suspended (Deleted)');
  });

  it('lists every matching owner when more than one historical duplicate exists', () => {
    const message = formatIdentifierConflictMessage([
      {
        label: 'National ID', column: 'national_id', value: '999',
        rows: [conflictRow({ full_name: 'JOHN BANDA' }), conflictRow({ full_name: 'MARY PHIRI' })],
      },
    ]);

    expect(message).toContain('JOHN BANDA');
    expect(message).toContain('MARY PHIRI');
    expect(message).toContain(';');
  });

  it('joins multiple conflicting identifiers into one combined message rather than only the first', () => {
    const message = formatIdentifierConflictMessage([
      { label: 'National ID', column: 'national_id', value: '111', rows: [conflictRow({ full_name: 'JOHN BANDA' })] },
      { label: 'Phone number', column: 'phone', value: '0977000000', rows: [conflictRow({ full_name: 'MARY PHIRI' })] },
    ]);

    expect(message).toContain('National ID 111');
    expect(message).toContain('Phone number 0977000000');
  });
});

describe('identifierColumnFromUniqueViolation', () => {
  it('maps a national_id constraint message to national_id', () => {
    expect(identifierColumnFromUniqueViolation({ message: 'duplicate key value violates unique constraint "employees_national_id_key"' })).toBe('national_id');
  });

  it('maps a phone constraint message to phone', () => {
    expect(identifierColumnFromUniqueViolation({ message: 'duplicate key value violates unique constraint "employees_phone_key"' })).toBe('phone');
  });

  it('maps an account_number constraint message to account_number', () => {
    expect(identifierColumnFromUniqueViolation({ message: 'duplicate key value violates unique constraint "employees_account_number_key"' })).toBe('account_number');
  });

  it('returns null for an unrelated constraint (e.g. employee_number, already handled separately)', () => {
    expect(identifierColumnFromUniqueViolation({ message: 'duplicate key value violates unique constraint "employees_tenant_id_employee_number_key"' })).toBeNull();
  });

  it('returns null for a missing/empty error', () => {
    expect(identifierColumnFromUniqueViolation(null)).toBeNull();
    expect(identifierColumnFromUniqueViolation(undefined)).toBeNull();
  });
});
