import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// PRODUCTION HOTFIX (PR #55): SalaryAdvances.tsx, Security.tsx, and
// Attendance.tsx each embed their employee-fetch query directly inside a
// component callback (useCallback/useEffect), not as an exported function --
// this codebase has no component-test harness (no @testing-library/react;
// vitest.config.ts runs in the 'node' environment), so these call sites
// cannot be exercised with a mocked multi-page Supabase client the way the
// plain utility functions (employeeBatchFetch.test.ts,
// attendanceImportAutoApplyService.test.ts, hikcentralPersonMappingService.test.ts)
// are. Those three suites already exhaustively prove fetchAllPages()'s own
// pagination mechanics (>1000 rows, exact page boundaries, no missing/
// duplicated rows, error propagation) for ANY caller. What matters here,
// and what source-pinning (see Attendance.monthlyRegisterRpc.test.ts for
// this codebase's established precedent for exactly this situation) can
// still catch, is a regression where a future edit reverts one of these
// three call sites back to a raw unbounded query, or silently narrows/
// widens its filters, drops the deterministic tiebreaker, or stops
// propagating page errors to the existing catch block.

const salaryAdvancesSource = fs.readFileSync(path.resolve(__dirname, './SalaryAdvances.tsx'), 'utf-8');
const securitySource = fs.readFileSync(path.resolve(__dirname, './Security.tsx'), 'utf-8');
const attendanceSource = fs.readFileSync(path.resolve(__dirname, './Attendance.tsx'), 'utf-8');

function body(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('SalaryAdvances.tsx: fetchEmployees employee-fetch call site', () => {
  const fetchEmployeesBody = body(salaryAdvancesSource, 'const fetchEmployees = useCallback(async () => {', "}, [userProfile]);");

  it('imports fetchAllPages', () => {
    expect(salaryAdvancesSource).toMatch(/import \{[^}]*fetchAllPages[^}]*\} from '\.\.\/utils\/employeeBatchFetch'/);
  });

  it('no longer issues a raw, unpaginated query -- the fetch goes through fetchAllPages', () => {
    expect(fetchEmployeesBody).toMatch(/await fetchAllPages<unknown>\(/);
    expect(fetchEmployeesBody).not.toMatch(/await supabase\s*\n?\s*\.from\('employees'\)/);
  });

  it('preserves the exact Active/non-deleted status filter', () => {
    expect(fetchEmployeesBody).toMatch(/q = q\.eq\('status', 'Active'\)\.eq\('is_deleted', false\);/);
  });

  it('preserves region-scoped authorization for non-Super-Admins, and does not broaden it to Super Admins', () => {
    expect(fetchEmployeesBody).toMatch(
      /if \(!userProfile\?\.is_super_admin && userProfile\?\.region_id\) \{\s*q = q\.eq\('region_id', userProfile\.region_id\);\s*\}/
    );
  });

  it('orders by full_name with id as a unique tiebreaker, for deterministic page boundaries', () => {
    expect(fetchEmployeesBody).toMatch(/\.order\('full_name'\)\.order\('id'\)\.range\(rangeFrom, rangeTo\)/);
  });

  it('still surfaces a page/query error to the existing catch block and notification, never silently', () => {
    expect(fetchEmployeesBody).toMatch(/} catch \(err\) \{\s*console\.error\('Error fetching employees:', err\);\s*showNotification\('Failed to load employees', 'error'\);\s*\}/);
  });

  it('still maps every returned row into the same Employee shape the UI already consumes', () => {
    expect(fetchEmployeesBody).toMatch(/const mapped = \(data as unknown as EmployeeRow\[\]\)\.map\(\(emp\): Employee => \(\{/);
    expect(fetchEmployeesBody).toMatch(/setEmployees\(mapped\);/);
  });
});

describe('Security.tsx: fetchEmployees employee-fetch call site', () => {
  const fetchEmployeesBody = body(securitySource, 'const fetchEmployees = async () => {', 'setLoadingEmployees(false);');

  it('imports fetchAllPages', () => {
    expect(securitySource).toMatch(/import \{ fetchAllPages \} from '\.\.\/utils\/employeeBatchFetch';/);
  });

  it('no longer issues a raw, unpaginated query -- the fetch goes through fetchAllPages', () => {
    expect(fetchEmployeesBody).toMatch(/await fetchAllPages<EmployeeSearchResult>\(/);
  });

  it('preserves the exact non-deleted filter, with no region/tenant scoping added (this search is intentionally company-wide)', () => {
    expect(fetchEmployeesBody).toMatch(/return q\.eq\('is_deleted', false\)\.order\('full_name'\)\.order\('id'\)\.range\(rangeFrom, rangeTo\);/);
    // region_id legitimately appears in the selected columns list (it's a
    // returned field the UI already used before this fix) -- what must NOT
    // appear is a .eq('region_id', ...) FILTER narrowing the result set.
    expect(fetchEmployeesBody).not.toMatch(/\.eq\('region_id'/);
  });

  it('still surfaces a page/query error to the existing catch block, never silently', () => {
    expect(fetchEmployeesBody).toMatch(/} catch \(err\) \{\s*console\.error\('Error fetching employees:', err\);\s*\} finally \{/);
  });

  it('still assigns the paginated result to allEmployees exactly as before', () => {
    expect(fetchEmployeesBody).toMatch(/setAllEmployees\(data\);/);
  });
});

describe('Attendance.tsx: fetchData employee-fetch call site', () => {
  const fetchDataBody = body(attendanceSource, 'const fetchData = useCallback(async () => {', '}, [selectedMonth, userProfile, getDatesForMonth]);');

  it('imports fetchAllPages (alongside the existing fetchInEmployeeIdBatches/dedupeById imports)', () => {
    expect(attendanceSource).toMatch(/import \{[^}]*fetchAllPages[^}]*\} from '\.\.\/utils\/employeeBatchFetch'/);
  });

  it('no longer issues a raw, unpaginated query -- the fetch goes through fetchAllPages', () => {
    expect(fetchDataBody).toMatch(/await fetchAllPages<Employee>\(/);
  });

  it('preserves the exact non-deleted filter', () => {
    expect(fetchDataBody).toMatch(/q = q\.eq\('is_deleted', false\);/);
  });

  it('preserves region-scoped authorization for non-Super-Admins, and does not broaden it to Super Admins', () => {
    expect(fetchDataBody).toMatch(
      /if \(!userProfile\?\.is_super_admin && userProfile\?\.region_id\) \{\s*q = q\.eq\('region_id', userProfile\.region_id\);\s*\}/
    );
  });

  it('orders by id for deterministic page boundaries (no display-order column existed here before the fix)', () => {
    expect(fetchDataBody).toMatch(/return q\.order\('id'\)\.range\(rangeFrom, rangeTo\);/);
  });

  it('still feeds the full, paginated employee list into the existing attendance batch-fetch step, unchanged', () => {
    expect(fetchDataBody).toMatch(/setEmployees\(employeesData\);/);
    expect(fetchDataBody).toMatch(/const employeeIds = employeesData\.map\(e => e\.id\);/);
    expect(fetchDataBody).toMatch(/await fetchAttendanceInBatches\(\s*employeeIds,/);
  });

  it('still surfaces a page/query error through the existing outer catch, never silently', () => {
    expect(fetchDataBody).toMatch(/} catch \(err\) \{\s*console\.error\('Error fetching data:', err\);\s*setError\(getErrorMessage\(err\)\);\s*\} finally \{/);
  });
});
