export interface AttendanceFilterableEmployee {
  full_name?: string | null;
  employee_number?: string | null;
  company?: string | null;
  workstation?: string | null;
}

// Distinct, sorted company names actually present among the given
// employees -- blank/null companies are never offered as a filter option.
export function deriveCompanyOptions<T extends AttendanceFilterableEmployee>(employees: T[]): string[] {
  const values = new Set<string>();
  employees.forEach(e => { if (e.company && e.company.trim() !== '') values.add(e.company); });
  return Array.from(values).sort();
}

// Distinct, sorted workstation/site names -- narrowed to whichever
// workstations actually appear among employees of `selectedCompany` when
// one is given ("where practical": if no employee of that company has a
// workstation recorded, the list is simply empty, never a guess). With no
// company selected, every workstation across all employees is offered.
export function deriveSiteOptions<T extends AttendanceFilterableEmployee>(employees: T[], selectedCompany: string): string[] {
  const values = new Set<string>();
  employees.forEach(e => {
    if (!e.workstation || e.workstation.trim() === '') return;
    if (selectedCompany && e.company !== selectedCompany) return;
    values.add(e.workstation);
  });
  return Array.from(values).sort();
}

// Pure, read-only row filter for the Attendance grid -- combines the
// existing name/employee-number search with the new Company and Site
// filters. Never touches attendance data itself; it only decides which
// already-fetched employee rows are displayed.
export function filterAttendanceEmployees<T extends AttendanceFilterableEmployee>(
  employees: T[],
  filters: { search: string; company: string; site: string }
): T[] {
  const safeSearch = filters.search.toLowerCase();
  return employees.filter(e =>
    (!!e.full_name?.toLowerCase().includes(safeSearch) || !!e.employee_number?.toLowerCase().includes(safeSearch)) &&
    (!filters.company || e.company === filters.company) &&
    (!filters.site || e.workstation === filters.site)
  );
}
