import { describe, it, expect } from 'vitest';
import { filterAttendanceEmployees } from './attendanceFilters';

const employees = [
  { full_name: 'John Banda', employee_number: 'SFG-S-001', company: 'ACME LTD', workstation: 'Site X - Chichiri' },
  { full_name: 'Mary Phiri', employee_number: 'SFG-S-002', company: 'ACME LTD', workstation: 'Site Y' },
  { full_name: 'Grace Tembo', employee_number: 'SFG-S-003', company: 'BATA SHOE COMPANY', workstation: 'Site Z' },
  { full_name: 'Peter Zulu', employee_number: 'SFG-S-004', company: null, workstation: '' },
  { full_name: 'Ruth Mvula', employee_number: 'SFG-S-005', company: undefined as string | null | undefined, workstation: undefined as string | null | undefined },
];

describe('filterAttendanceEmployees', () => {
  describe('existing employee search behavior (name/employee number)', () => {
    it('matches by name, case-insensitively', () => {
      const result = filterAttendanceEmployees(employees, { search: 'mary', company: '', site: '' });
      expect(result.map(e => e.full_name)).toEqual(['Mary Phiri']);
    });

    it('matches by employee number', () => {
      const result = filterAttendanceEmployees(employees, { search: 'SFG-S-003', company: '', site: '' });
      expect(result.map(e => e.full_name)).toEqual(['Grace Tembo']);
    });

    it('returns everyone when all filters are empty', () => {
      expect(filterAttendanceEmployees(employees, { search: '', company: '', site: '' })).toHaveLength(5);
    });

    it('never mutates the input array', () => {
      const copy = [...employees];
      filterAttendanceEmployees(employees, { search: 'mary', company: 'ACME', site: 'Site Y' });
      expect(employees).toEqual(copy);
    });
  });

  describe('company/resident search', () => {
    it('matches a partial company substring', () => {
      const result = filterAttendanceEmployees(employees, { search: '', company: 'Bata', site: '' });
      expect(result.map(e => e.full_name)).toEqual(['Grace Tembo']);
    });

    it('is case-insensitive', () => {
      const lower = filterAttendanceEmployees(employees, { search: '', company: 'acme', site: '' });
      const upper = filterAttendanceEmployees(employees, { search: '', company: 'ACME', site: '' });
      const mixed = filterAttendanceEmployees(employees, { search: '', company: 'AcMe', site: '' });
      expect(lower.map(e => e.full_name)).toEqual(['John Banda', 'Mary Phiri']);
      expect(upper).toEqual(lower);
      expect(mixed).toEqual(lower);
    });

    it('blank company search means all companies/residents', () => {
      expect(filterAttendanceEmployees(employees, { search: '', company: '', site: '' })).toHaveLength(5);
      expect(filterAttendanceEmployees(employees, { search: '', company: '   ', site: '' })).toHaveLength(5);
    });

    it('does not crash and simply excludes employees with a null/blank company when a company filter is active', () => {
      expect(() => filterAttendanceEmployees(employees, { search: '', company: 'acme', site: '' })).not.toThrow();
      const result = filterAttendanceEmployees(employees, { search: '', company: 'acme', site: '' });
      expect(result.map(e => e.full_name)).not.toContain('Peter Zulu');
      expect(result.map(e => e.full_name)).not.toContain('Ruth Mvula');
    });
  });

  describe('site/workstation search', () => {
    it('matches a partial site substring', () => {
      const result = filterAttendanceEmployees(employees, { search: '', company: '', site: 'Chichiri' });
      expect(result.map(e => e.full_name)).toEqual(['John Banda']);
    });

    it('is case-insensitive', () => {
      const lower = filterAttendanceEmployees(employees, { search: '', company: '', site: 'chichiri' });
      const upper = filterAttendanceEmployees(employees, { search: '', company: '', site: 'CHICHIRI' });
      expect(lower.map(e => e.full_name)).toEqual(['John Banda']);
      expect(upper).toEqual(lower);
    });

    it('blank site search means all sites', () => {
      expect(filterAttendanceEmployees(employees, { search: '', company: '', site: '' })).toHaveLength(5);
      expect(filterAttendanceEmployees(employees, { search: '', company: '', site: '   ' })).toHaveLength(5);
    });

    it('does not crash and simply excludes employees with a null/blank workstation when a site filter is active', () => {
      expect(() => filterAttendanceEmployees(employees, { search: '', company: '', site: 'site' })).not.toThrow();
      const result = filterAttendanceEmployees(employees, { search: '', company: '', site: 'site' });
      expect(result.map(e => e.full_name)).not.toContain('Peter Zulu');
      expect(result.map(e => e.full_name)).not.toContain('Ruth Mvula');
    });
  });

  describe('combined filtering (AND, not OR)', () => {
    it('combines employee search with company search', () => {
      const result = filterAttendanceEmployees(employees, { search: 'john', company: 'acme', site: '' });
      expect(result.map(e => e.full_name)).toEqual(['John Banda']);

      const excluded = filterAttendanceEmployees(employees, { search: 'grace', company: 'acme', site: '' });
      expect(excluded).toEqual([]);
    });

    it('combines employee search, company search, and site search', () => {
      const result = filterAttendanceEmployees(employees, { search: 'john', company: 'acme', site: 'chichiri' });
      expect(result.map(e => e.full_name)).toEqual(['John Banda']);

      // Same search + same company, but a site substring that doesn't match -- must exclude.
      const excluded = filterAttendanceEmployees(employees, { search: 'john', company: 'acme', site: 'site z' });
      expect(excluded).toEqual([]);
    });
  });

  it('handles a fully blank/null/undefined company and workstation without throwing, for any filter combination', () => {
    const edgeCase = [{ full_name: 'Edge Case', employee_number: 'SFG-S-999', company: null, workstation: undefined as string | null | undefined }];
    expect(() => filterAttendanceEmployees(edgeCase, { search: '', company: '', site: '' })).not.toThrow();
    expect(() => filterAttendanceEmployees(edgeCase, { search: '', company: 'anything', site: '' })).not.toThrow();
    expect(() => filterAttendanceEmployees(edgeCase, { search: '', company: '', site: 'anything' })).not.toThrow();
    expect(filterAttendanceEmployees(edgeCase, { search: '', company: '', site: '' })).toHaveLength(1);
    expect(filterAttendanceEmployees(edgeCase, { search: '', company: 'anything', site: '' })).toHaveLength(0);
  });
});
