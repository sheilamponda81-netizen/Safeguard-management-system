import { describe, it, expect } from 'vitest';
import { deriveCompanyOptions, deriveSiteOptions, filterAttendanceEmployees } from './attendanceFilters';

const employees = [
  { full_name: 'John Banda', employee_number: 'SFG-S-001', company: 'ACME LTD', workstation: 'Site X' },
  { full_name: 'Mary Phiri', employee_number: 'SFG-S-002', company: 'ACME LTD', workstation: 'Site Y' },
  { full_name: 'Grace Tembo', employee_number: 'SFG-S-003', company: 'BETA CO', workstation: 'Site Z' },
  { full_name: 'Peter Zulu', employee_number: 'SFG-S-004', company: null, workstation: '' },
];

describe('deriveCompanyOptions', () => {
  it('returns distinct, sorted, non-blank company names', () => {
    expect(deriveCompanyOptions(employees)).toEqual(['ACME LTD', 'BETA CO']);
  });

  it('returns an empty list when no employee has a company on record', () => {
    expect(deriveCompanyOptions([{ full_name: 'X', employee_number: '1', company: null, workstation: null }])).toEqual([]);
  });
});

describe('deriveSiteOptions', () => {
  it('lists every distinct site when no company is selected', () => {
    expect(deriveSiteOptions(employees, '')).toEqual(['Site X', 'Site Y', 'Site Z']);
  });

  it('narrows sites to the selected company', () => {
    expect(deriveSiteOptions(employees, 'ACME LTD')).toEqual(['Site X', 'Site Y']);
    expect(deriveSiteOptions(employees, 'BETA CO')).toEqual(['Site Z']);
  });

  it('returns an empty list for a company with no recorded workstations', () => {
    expect(deriveSiteOptions([{ full_name: 'X', employee_number: '1', company: 'EMPTY CO', workstation: null }], 'EMPTY CO')).toEqual([]);
  });
});

describe('filterAttendanceEmployees', () => {
  it('matches by name, case-insensitively', () => {
    const result = filterAttendanceEmployees(employees, { search: 'mary', company: '', site: '' });
    expect(result.map(e => e.full_name)).toEqual(['Mary Phiri']);
  });

  it('matches by employee number', () => {
    const result = filterAttendanceEmployees(employees, { search: 'SFG-S-003', company: '', site: '' });
    expect(result.map(e => e.full_name)).toEqual(['Grace Tembo']);
  });

  it('filters by company alone', () => {
    const result = filterAttendanceEmployees(employees, { search: '', company: 'ACME LTD', site: '' });
    expect(result.map(e => e.full_name)).toEqual(['John Banda', 'Mary Phiri']);
  });

  it('filters by site alone', () => {
    const result = filterAttendanceEmployees(employees, { search: '', company: '', site: 'Site Z' });
    expect(result.map(e => e.full_name)).toEqual(['Grace Tembo']);
  });

  it('combines search, company, and site filters (AND, not OR)', () => {
    const result = filterAttendanceEmployees(employees, { search: 'john', company: 'ACME LTD', site: 'Site X' });
    expect(result.map(e => e.full_name)).toEqual(['John Banda']);

    // Same search + same company, but the wrong site -- must exclude.
    const excluded = filterAttendanceEmployees(employees, { search: 'john', company: 'ACME LTD', site: 'Site Y' });
    expect(excluded).toEqual([]);
  });

  it('returns everyone when all filters are empty', () => {
    expect(filterAttendanceEmployees(employees, { search: '', company: '', site: '' })).toHaveLength(4);
  });

  it('never mutates the input array', () => {
    const copy = [...employees];
    filterAttendanceEmployees(employees, { search: 'mary', company: 'ACME LTD', site: 'Site Y' });
    expect(employees).toEqual(copy);
  });
});
