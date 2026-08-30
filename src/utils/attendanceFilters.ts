export interface AttendanceFilterableEmployee {
  full_name?: string | null;
  employee_number?: string | null;
  company?: string | null;
  workstation?: string | null;
}

// Case-insensitive partial match against a possibly-null/blank field value.
// A blank filter text always matches (no filtering applied); a non-blank
// filter text against a null/blank field value never matches -- neither
// case ever throws, regardless of what's actually recorded on the employee.
function matchesText(value: string | null | undefined, filterText: string): boolean {
  const safeFilter = filterText.trim().toLowerCase();
  if (!safeFilter) return true;
  if (!value) return false;
  return value.toLowerCase().includes(safeFilter);
}

// Pure, read-only row filter for the Attendance grid -- combines the
// existing name/employee-number search with free-text Company/Resident and
// Site/Workstation search (partial, case-insensitive, AND'd together).
// Never touches attendance data itself; it only decides which
// already-fetched employee rows are displayed.
export function filterAttendanceEmployees<T extends AttendanceFilterableEmployee>(
  employees: T[],
  filters: { search: string; company: string; site: string }
): T[] {
  const safeSearch = filters.search.trim().toLowerCase();
  return employees.filter(e =>
    (!!e.full_name?.toLowerCase().includes(safeSearch) || !!e.employee_number?.toLowerCase().includes(safeSearch)) &&
    matchesText(e.company, filters.company) &&
    matchesText(e.workstation, filters.site)
  );
}
