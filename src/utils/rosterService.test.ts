import { describe, it, expect } from 'vitest';
import { filterEmployeesForSearch, formatEmployeeLabel, moveHighlightedIndex } from './rosterService';
import { EmployeeLite } from './hikcentralPersonMapping';

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
