import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EmployeeLite } from './hikcentralPersonMapping';

const fromMock = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

const {
  filterEmployeesForSearch, formatEmployeeLabel, moveHighlightedIndex, humanizeRosterError,
  fetchActiveOffDayPatterns, fetchActiveShiftPatterns, fetchActiveDateAssignments,
} = await import('./rosterService');

function emp(overrides: Partial<EmployeeLite> = {}): EmployeeLite {
  return {
    id: 'emp-1',
    employeeNumber: 'SFG-S-001',
    fullName: 'Jane Doe',
    workstation: null,
    status: 'Active',
    isDeleted: false,
    ...overrides,
  };
}

describe('filterEmployeesForSearch (the single shared predicate behind every roster employee-selection surface)', () => {
  it('a blank query matches every employee', () => {
    const list = [emp({ id: '1' }), emp({ id: '2', fullName: 'John Smith' })];
    expect(filterEmployeesForSearch(list, '')).toEqual(list);
    expect(filterEmployeesForSearch(list, '   ')).toEqual(list);
  });

  it('matches by a partial, case-insensitive full name', () => {
    const list = [emp({ id: '1', fullName: 'Jane Doe' }), emp({ id: '2', fullName: 'John Smith' })];
    expect(filterEmployeesForSearch(list, 'jane')).toEqual([list[0]]);
    expect(filterEmployeesForSearch(list, 'JANE')).toEqual([list[0]]);
    expect(filterEmployeesForSearch(list, 'oe')).toEqual([list[0]]);
  });

  it('matches by a partial, case-insensitive employee number', () => {
    const list = [emp({ id: '1', employeeNumber: 'SFG-S-123' }), emp({ id: '2', employeeNumber: 'SFG-S-456' })];
    expect(filterEmployeesForSearch(list, 'sfg-s-123')).toEqual([list[0]]);
    expect(filterEmployeesForSearch(list, '456')).toEqual([list[1]]);
  });

  it('matches on either field -- a query matching the number of one employee and the name of another returns both', () => {
    const list = [
      emp({ id: '1', fullName: 'Ann Banda', employeeNumber: 'SFG-S-100' }),
      emp({ id: '2', fullName: 'Ben Zulu', employeeNumber: 'SFG-S-ANN' }),
    ];
    expect(filterEmployeesForSearch(list, 'ann').map((e) => e.id)).toEqual(['1', '2']);
  });

  it('returns an empty array, never throwing or returning undefined, when nothing matches', () => {
    const list = [emp({ id: '1', fullName: 'Jane Doe' })];
    const result = filterEmployeesForSearch(list, 'zzz-no-such-employee');
    expect(result).toEqual([]);
    expect(Array.isArray(result)).toBe(true);
  });

  it('operates on however many employees are actually passed in, including far beyond 100 -- proves search is never limited to a displayed subset', () => {
    const list: EmployeeLite[] = Array.from({ length: 935 }, (_, i) =>
      emp({ id: `emp-${i}`, employeeNumber: `SFG-S-${String(i).padStart(3, '0')}`, fullName: `Employee Number ${i}` })
    );
    // Plant a uniquely-matchable employee at position 850 -- well beyond
    // any "first 100" display cap that might exist elsewhere in the UI.
    list[850] = emp({ id: 'emp-850', employeeNumber: 'SFG-S-850', fullName: 'Zanele Mwale' });
    const byName = filterEmployeesForSearch(list, 'zanele');
    expect(byName).toHaveLength(1);
    expect(byName[0].id).toBe('emp-850');
    const byNumber = filterEmployeesForSearch(list, 'SFG-S-850');
    expect(byNumber).toHaveLength(1);
    expect(byNumber[0].id).toBe('emp-850');
  });

  it('never mutates the input array (filtering must never be mistaken for a selection operation)', () => {
    const list = [emp({ id: '1' }), emp({ id: '2', fullName: 'John Smith' })];
    const snapshot = [...list];
    filterEmployeesForSearch(list, 'john');
    expect(list).toEqual(snapshot);
  });
});

describe('formatEmployeeLabel', () => {
  it('formats as "Full Name (EMPLOYEE-NUMBER)"', () => {
    expect(formatEmployeeLabel(emp({ fullName: 'Jane Doe', employeeNumber: 'SFG-S-001' }))).toBe('Jane Doe (SFG-S-001)');
  });
});

describe('moveHighlightedIndex (Reschedule Off Day combobox keyboard navigation, pure and directly unit-testable)', () => {
  it('Arrow Down from no selection (-1) highlights the first result', () => {
    expect(moveHighlightedIndex(-1, 1, 5)).toBe(0);
  });

  it('Arrow Up from no selection (-1) highlights the last result', () => {
    expect(moveHighlightedIndex(-1, -1, 5)).toBe(4);
  });

  it('Arrow Down moves forward by one', () => {
    expect(moveHighlightedIndex(1, 1, 5)).toBe(2);
  });

  it('Arrow Up moves backward by one', () => {
    expect(moveHighlightedIndex(2, -1, 5)).toBe(1);
  });

  it('Arrow Down from the last result wraps to the first', () => {
    expect(moveHighlightedIndex(4, 1, 5)).toBe(0);
  });

  it('Arrow Up from the first result wraps to the last', () => {
    expect(moveHighlightedIndex(0, -1, 5)).toBe(4);
  });

  it('returns -1 (nothing to highlight) when there are zero results, regardless of direction', () => {
    expect(moveHighlightedIndex(-1, 1, 0)).toBe(-1);
    expect(moveHighlightedIndex(-1, -1, 0)).toBe(-1);
    expect(moveHighlightedIndex(3, 1, 0)).toBe(-1);
  });

  it('handles the single-result case without oscillating out of range', () => {
    expect(moveHighlightedIndex(0, 1, 1)).toBe(0);
    expect(moveHighlightedIndex(0, -1, 1)).toBe(0);
  });
});

describe('humanizeRosterError (Phase 2B.2C: substitute a known employee UUID in a raw Postgres rejection for a readable name/number label)', () => {
  const employees: EmployeeLite[] = [emp({ id: '11111111-1111-1111-1111-111111111111', fullName: 'Jane Doe', employeeNumber: 'SFG-S-001' })];

  it('replaces a UUID matching a known employee with "Full Name (NUMBER)"', () => {
    const message = 'This reschedule would leave employee 11111111-1111-1111-1111-111111111111 with no Off day between 2026-10-15 and 2026-10-21.';
    expect(humanizeRosterError(message, employees)).toBe(
      'This reschedule would leave employee Jane Doe (SFG-S-001) with no Off day between 2026-10-15 and 2026-10-21.'
    );
  });

  it('is case-insensitive when matching the UUID', () => {
    const message = 'Employee 11111111-1111-1111-1111-111111111111 not found';
    expect(humanizeRosterError(message, employees)).toBe('Employee Jane Doe (SFG-S-001) not found');
  });

  it('leaves a UUID that matches no known employee exactly as-is, never guessing', () => {
    const message = 'Employee 22222222-2222-2222-2222-222222222222 does not belong to your tenant';
    expect(humanizeRosterError(message, employees)).toBe(message);
  });

  it('leaves a message with no UUID at all unchanged', () => {
    expect(humanizeRosterError('Only Admin may reschedule roster Off days', employees)).toBe('Only Admin may reschedule roster Off days');
  });

  it('handles an empty or undefined-ish message without throwing', () => {
    expect(humanizeRosterError('', employees)).toBe('');
  });
});

// PRODUCTION HOTFIX (Attendance Review repair): fetchActiveOffDayPatterns,
// fetchActiveShiftPatterns, and fetchActiveDateAssignments now page
// through fetchAllPages() instead of a single unbounded query, exactly
// the same fix already applied to the 6 employee-list call sites in
// PR #55 -- see that PR's own test files for the established
// ChainableMock/mockPaginatedFrom convention this mirrors.
interface ChainableMock {
  select: (...args: unknown[]) => ChainableMock;
  eq: (...args: unknown[]) => ChainableMock;
  gte: (...args: unknown[]) => ChainableMock;
  lte: (...args: unknown[]) => ChainableMock;
  order: (...args: unknown[]) => ChainableMock;
  range: (...args: unknown[]) => Promise<{ data: unknown; error: unknown; count?: number | null }>;
}

function mockPaginatedFrom(pages: Array<{ data: unknown; error: unknown; count?: number | null }>) {
  let callIndex = 0;
  return () => {
    const builder: ChainableMock = {
      select: () => builder,
      eq: () => builder,
      gte: () => builder,
      lte: () => builder,
      order: () => builder,
      range: () => {
        const page = pages[Math.min(callIndex, pages.length - 1)];
        callIndex++;
        return Promise.resolve(page);
      },
    };
    return builder;
  };
}

describe('fetchActiveOffDayPatterns', () => {
  beforeEach(() => fromMock.mockReset());

  it('maps rows to OffDayPatternRow shape (fewer than 1,000 matches, single page)', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [{ employee_id: 'e1', weekday: 1, effective_from: '2026-10-01', is_active: true }], error: null, count: 1 },
    ]));
    const result = await fetchActiveOffDayPatterns();
    expect(result).toEqual([{ employeeId: 'e1', weekday: 1, effectiveFrom: '2026-10-01', isActive: true }]);
  });

  it('REGRESSION (PostgREST 1,000-row cap): pages past 1,000 active patterns with no missing or duplicated rows at the boundary', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ employee_id: `e${i}`, weekday: i % 7, effective_from: '2026-10-01', is_active: true }));
    const page2 = [{ employee_id: 'e1000', weekday: 2, effective_from: '2026-10-01', is_active: true }];
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: page1, error: null, count: 1001 },
      { data: page2, error: null, count: null },
    ]));
    const result = await fetchActiveOffDayPatterns();
    expect(result).toHaveLength(1001);
    expect(result.map((r) => r.employeeId)).toContain('e999');
    expect(result.map((r) => r.employeeId)).toContain('e1000');
    expect(fromMock.mock.calls.length).toBe(2);
  });

  it('propagates a query error rather than returning a partial pattern list', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: null, error: { message: 'boom' }, count: null }]));
    await expect(fetchActiveOffDayPatterns()).rejects.toBeTruthy();
  });
});

describe('fetchActiveShiftPatterns', () => {
  beforeEach(() => fromMock.mockReset());

  it('maps rows to ShiftPatternRow shape (fewer than 1,000 matches, single page)', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [{ employee_id: 'e1', shift_type: 'night', effective_from: '2026-10-01', is_active: true }], error: null, count: 1 },
    ]));
    const result = await fetchActiveShiftPatterns();
    expect(result).toEqual([{ employeeId: 'e1', shiftType: 'night', effectiveFrom: '2026-10-01', isActive: true }]);
  });

  it('REGRESSION (PostgREST 1,000-row cap): pages past 1,000 active patterns -- the exact defect that made "Scheduled shifts" undercount on the Attendance Review page', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ employee_id: `e${i}`, shift_type: i % 2 === 0 ? 'day' : 'night', effective_from: '2026-10-01', is_active: true }));
    const page2 = [{ employee_id: 'e1000', shift_type: 'day', effective_from: '2026-10-01', is_active: true }];
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: page1, error: null, count: 1001 },
      { data: page2, error: null, count: null },
    ]));
    const result = await fetchActiveShiftPatterns();
    expect(result).toHaveLength(1001);
    expect(new Set(result.map((r) => r.employeeId)).size).toBe(1001); // no duplicates
    expect(fromMock.mock.calls.length).toBe(2);
  });

  it('propagates a query error rather than returning a partial pattern list', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: null, error: { message: 'boom' }, count: null }]));
    await expect(fetchActiveShiftPatterns()).rejects.toBeTruthy();
  });

  it('filters to is_active=true only, on every page -- never broadens to inactive/superseded patterns', async () => {
    const seenCalls: string[] = [];
    let callIndex = 0;
    const pages = [{ data: [], error: null, count: 0 }];
    fromMock.mockImplementation(() => {
      const builder: ChainableMock = {
        select: () => builder,
        eq: (...args: unknown[]) => { seenCalls.push(`eq:${JSON.stringify(args)}`); return builder; },
        gte: () => builder,
        lte: () => builder,
        order: () => builder,
        range: () => {
          const page = pages[Math.min(callIndex, pages.length - 1)];
          callIndex++;
          return Promise.resolve(page);
        },
      };
      return builder;
    });
    await fetchActiveShiftPatterns();
    expect(seenCalls).toEqual([`eq:${JSON.stringify(['is_active', true])}`]);
  });
});

describe('fetchActiveDateAssignments', () => {
  beforeEach(() => fromMock.mockReset());

  it('maps rows to DateAssignmentRow shape, bounded by the given date range (fewer than 1,000 matches, single page)', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: [{ employee_id: 'e1', assignment_date: '2026-10-05', assignment_type: 'day', is_active: true }], error: null, count: 1 },
    ]));
    const result = await fetchActiveDateAssignments('2026-10-01', '2026-10-31');
    expect(result).toEqual([{ employeeId: 'e1', assignmentDate: '2026-10-05', assignmentType: 'day', isActive: true }]);
  });

  it('REGRESSION (PostgREST 1,000-row cap): a wide date range across many employees can exceed 1,000 rows even with the date-range bound already in place -- pages past it with no missing/duplicated rows', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ employee_id: `e${i}`, assignment_date: '2026-10-05', assignment_type: 'day', is_active: true }));
    const page2 = [{ employee_id: 'e1000', assignment_date: '2026-10-06', assignment_type: 'night', is_active: true }];
    fromMock.mockImplementation(mockPaginatedFrom([
      { data: page1, error: null, count: 1001 },
      { data: page2, error: null, count: null },
    ]));
    const result = await fetchActiveDateAssignments('2026-10-01', '2026-10-31');
    expect(result).toHaveLength(1001);
    expect(fromMock.mock.calls.length).toBe(2);
  });

  it('propagates a query error rather than returning a partial assignment list', async () => {
    fromMock.mockImplementation(mockPaginatedFrom([{ data: null, error: { message: 'boom' }, count: null }]));
    await expect(fetchActiveDateAssignments('2026-10-01', '2026-10-31')).rejects.toBeTruthy();
  });

  it('preserves the exact is_active + date-range filters on every page', async () => {
    const seenCalls: string[] = [];
    let callIndex = 0;
    const pages = [{ data: [], error: null, count: 0 }];
    fromMock.mockImplementation(() => {
      const builder: ChainableMock = {
        select: () => builder,
        eq: (...args: unknown[]) => { seenCalls.push(`eq:${JSON.stringify(args)}`); return builder; },
        gte: (...args: unknown[]) => { seenCalls.push(`gte:${JSON.stringify(args)}`); return builder; },
        lte: (...args: unknown[]) => { seenCalls.push(`lte:${JSON.stringify(args)}`); return builder; },
        order: () => builder,
        range: () => {
          const page = pages[Math.min(callIndex, pages.length - 1)];
          callIndex++;
          return Promise.resolve(page);
        },
      };
      return builder;
    });
    await fetchActiveDateAssignments('2026-10-01', '2026-10-31');
    expect(seenCalls).toEqual([
      `eq:${JSON.stringify(['is_active', true])}`,
      `gte:${JSON.stringify(['assignment_date', '2026-10-01'])}`,
      `lte:${JSON.stringify(['assignment_date', '2026-10-31'])}`,
    ]);
  });
});
