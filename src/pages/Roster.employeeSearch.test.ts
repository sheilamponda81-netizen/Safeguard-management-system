import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Phase 2B.2C: employee search across the four Roster Management tabs.
// This codebase has no component-test harness (no @testing-library/react,
// and vitest.config.ts runs tests in the 'node' environment, not 'jsdom' --
// see rosterMigrationSecurity.test.ts's and Roster.calendarNavigation.test.ts's
// own headers for the established precedent of pinning a hard-to-runtime-test
// UI invariant at the source level). The actual search MATCHING logic
// (filterEmployeesForSearch, formatEmployeeLabel, moveHighlightedIndex) is
// pure and fully unit-tested with real assertions in rosterService.test.ts --
// these tests instead verify how Roster.tsx actually WIRES that logic: that
// each tab's search is independent, that selection state is never cleared
// by a search change, and that single-select and multi-select use genuinely
// different data structures.
const rosterSource = fs.readFileSync(path.resolve(__dirname, './Roster.tsx'), 'utf-8');

describe('Roster employee search: each tab has its own independent search state', () => {
  it('Calendar keeps using the shared page-level employeeSearch (unchanged, as required)', () => {
    expect(rosterSource).toMatch(/const filteredEmployees = useMemo\(\(\) => filterEmployeesForSearch\(employees, employeeSearch\)/);
  });

  it('Recurring Off Day has its own local search state, decoupled from employeeSearch', () => {
    expect(rosterSource).toMatch(/const \[offPatternSearch, setOffPatternSearch\] = useState\(''\);/);
    expect(rosterSource).toMatch(/const offPatternFilteredEmployees = useMemo\(\(\) => filterEmployeesForSearch\(employees, offPatternSearch\)/);
  });

  it('Assign Dates has its own local search state, decoupled from employeeSearch', () => {
    expect(rosterSource).toMatch(/const \[assignSearch, setAssignSearch\] = useState\(''\);/);
    expect(rosterSource).toMatch(/const assignFilteredEmployees = useMemo\(\(\) => filterEmployeesForSearch\(employees, assignSearch\)/);
  });

  it('Reschedule Off Day uses the EmployeeSingleSelect combobox, fed the full, unfiltered employees array (the combobox owns its own search internally)', () => {
    expect(rosterSource).toMatch(/<EmployeeSingleSelect employees=\{employees\} value=\{rescheduleEmployeeId\} onChange=\{setRescheduleEmployeeId\} \/>/);
  });

});

describe('Roster employee search: selection state is never cleared by a search change (filtering and selection are structurally independent)', () => {
  it('the only setters offPatternSearch\'s input onChange ever calls are search setters -- never setOffPatternEmployeeIds', () => {
    const match = rosterSource.match(/value=\{offPatternSearch\} onChange=\{\(e\) => setOffPatternSearch\(e\.target\.value\)\}/);
    expect(match).toBeTruthy();
  });

  it('the only setters assignSearch\'s input onChange ever calls are search setters -- never setAssignEmployeeIds', () => {
    const match = rosterSource.match(/value=\{assignSearch\} onChange=\{\(e\) => setAssignSearch\(e\.target\.value\)\}/);
    expect(match).toBeTruthy();
  });

  it('checkbox selection for both multi-select tabs still goes exclusively through the pre-existing toggleInSet helper, which this phase did not modify', () => {
    const toggleInSetDef = rosterSource.match(/const toggleInSet = \(set: Set<string>, setSet: \(s: Set<string>\) => void, id: string\) => \{[\s\S]*?\n {2}\};/);
    expect(toggleInSetDef).toBeTruthy();
    expect(toggleInSetDef![0]).toMatch(/const next = new Set\(set\);/);
    expect(toggleInSetDef![0]).not.toMatch(/Search|filter/i);
  });
});

describe('Roster employee search: single-select (Reschedule Off Day) and multi-select (Recurring Off Day, Assign Dates) use genuinely different data structures', () => {
  it('rescheduleEmployeeId is a plain string (zero or one selection) -- never a Set', () => {
    expect(rosterSource).toMatch(/const \[rescheduleEmployeeId, setRescheduleEmployeeId\] = useState\(''\);/);
    expect(rosterSource).not.toMatch(/rescheduleEmployeeId.*Set</);
  });

  it('offPatternEmployeeIds and assignEmployeeIds are both Set<string> (any number of selections)', () => {
    expect(rosterSource).toMatch(/const \[offPatternEmployeeIds, setOffPatternEmployeeIds\] = useState<Set<string>>\(new Set\(\)\);/);
    expect(rosterSource).toMatch(/const \[assignEmployeeIds, setAssignEmployeeIds\] = useState<Set<string>>\(new Set\(\)\);/);
  });

  it('EmployeeSingleSelect\'s onChange prop type takes exactly one employeeId (string), never an array or Set -- confirming its contract is genuinely single-select', () => {
    const def = rosterSource.match(/function EmployeeSingleSelect\(\{ employees, value, onChange, placeholder \}: \{[\s\S]*?\}\)/);
    expect(def).toBeTruthy();
    expect(def![0]).toMatch(/value: string;/);
    expect(def![0]).toMatch(/onChange: \(employeeId: string\) => void;/);
  });
});

describe('Roster employee search: selected-count visibility and empty-results messaging', () => {
  it('Recurring Off Day shows a visible selected count above its checkbox list, not only on the submit button', () => {
    expect(rosterSource).toMatch(/\{offPatternEmployeeIds\.size\} selected<\/span>/);
  });

  it('Assign Dates shows a visible selected count above its checkbox list, not only on the submit button', () => {
    expect(rosterSource).toMatch(/\{assignEmployeeIds\.size\} selected<\/span>/);
  });

  it('Recurring Off Day shows an explicit empty-results message when its local search matches nobody', () => {
    expect(rosterSource).toMatch(/offPatternFilteredEmployees\.length === 0 \? \(\s*\n\s*<EmptyState/);
  });

  it('Assign Dates shows an explicit empty-results message when its local search matches nobody', () => {
    expect(rosterSource).toMatch(/assignFilteredEmployees\.length === 0 \? \(\s*\n\s*<EmptyState/);
  });

  it('EmployeeSingleSelect shows an explicit empty-results message when nothing matches', () => {
    expect(rosterSource).toMatch(/No employees match your search\./);
  });
});

describe('Roster employee search: fetching the complete eligible employee set (rosterService)', () => {
  const rosterServiceSource = fs.readFileSync(path.resolve(__dirname, '../utils/rosterService.ts'), 'utf-8');

  it('fetchActiveEmployeesForRoster keeps the existing Active, non-deleted eligibility filter unchanged', () => {
    expect(rosterServiceSource).toMatch(/\.eq\('status', 'Active'\)/);
    expect(rosterServiceSource).toMatch(/\.or\('is_deleted\.is\.null,is_deleted\.eq\.false'\)/);
  });

  it('fetchActiveEmployeesForRoster now has an explicit, documented upper bound rather than relying on an undocumented platform default', () => {
    expect(rosterServiceSource).toMatch(/const MAX_ROSTER_EMPLOYEES_FETCHED = 5000;/);
    expect(rosterServiceSource).toMatch(/\.limit\(MAX_ROSTER_EMPLOYEES_FETCHED\);/);
  });

  it('that bound is comfortably larger than the current real employee count, so search is not silently truncated today', () => {
    const match = rosterServiceSource.match(/MAX_ROSTER_EMPLOYEES_FETCHED = (\d+);/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeGreaterThan(935 * 2);
  });
});
