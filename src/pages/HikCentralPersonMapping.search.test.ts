import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Stage C Step 11F: this repo has no component-test harness (see the
// established precedent in HikCentralImport.autoApply.test.ts) -- these
// tests pin, at the SOURCE level, that the Person Mapping page gained a
// single shared search box narrowing the rows rendered in whichever tab
// is currently active, without touching any existing selection, confirm,
// terminal-assignment, or Change action.
const source = fs.readFileSync(path.resolve(__dirname, './HikCentralPersonMapping.tsx'), 'utf-8');

describe('Stage C Step 11F: Person Mapping search', () => {
  it('defines one reusable, case-insensitive, partial-match search predicate', () => {
    const fnMatch = source.match(/function identityMatchesSearch\([\s\S]*?\n}/);
    expect(fnMatch, 'expected to find identityMatchesSearch').toBeTruthy();
    const body = fnMatch![0];
    // Person No.
    expect(body).toMatch(/hikcentralPersonNo\.toLowerCase\(\)\.includes\(query\)/);
    // Every observed HikCentral name variant, not just the first (relevant for Conflicts).
    expect(body).toMatch(/observedNamePairs\.some/);
    // Safeguard employee name + employee number, via matchedEmployee (populated for both exact and mapped).
    expect(body).toMatch(/matchedEmployee\.fullName\.toLowerCase\(\)\.includes\(query\)/);
    expect(body).toMatch(/matchedEmployee\.employeeNumber\.toLowerCase\(\)\.includes\(query\)/);
    // Needs Review candidates: suggestion employees too.
    expect(body).toMatch(/suggestions\.some/);
    expect(body).toMatch(/s\.employee\.fullName\.toLowerCase\(\)\.includes\(query\)/);
    expect(body).toMatch(/s\.employee\.employeeNumber\.toLowerCase\(\)\.includes\(query\)/);
  });

  it('renders exactly one shared search Input, after the Tabs component (applies to whichever tab is active)', () => {
    const tabsIndex = source.indexOf('<Tabs');
    const inputIndex = source.indexOf('<Input', tabsIndex);
    expect(tabsIndex).toBeGreaterThan(-1);
    expect(inputIndex).toBeGreaterThan(tabsIndex);
    const searchInputOccurrences = (source.match(/placeholder="Search by employee name, employee number, HikCentral name, or Person No\.\.\."/g) || []).length;
    expect(searchInputOccurrences).toBe(1);
  });

  it('search text is never reset by switching tabs -- setActiveTab and setSearchInput are never called together', () => {
    expect(source).not.toMatch(/setActiveTab\([^)]*\);\s*setSearchInput/);
    expect(source).not.toMatch(/onChange=\{\(id\) => \{[\s\S]*?setSearchInput\(''\)/);
    // The only place search is ever cleared is the user editing the box itself.
    const clearCalls = (source.match(/setSearchInput\(/g) || []).length;
    expect(clearCalls).toBe(1); // just the <Input onChange> itself
  });

  it('debounces filtering (searchInput updates instantly; debouncedSearch lags) so thousands of rows are not re-filtered on every keystroke', () => {
    expect(source).toMatch(/const \[searchInput, setSearchInput\] = useState\(''\);/);
    expect(source).toMatch(/const \[debouncedSearch, setDebouncedSearch\] = useState\(''\);/);
    expect(source).toMatch(/setTimeout\(\(\) => setDebouncedSearch\(searchInput\.trim\(\)\.toLowerCase\(\)\), 150\)/);
  });

  it('computes a filtered list per tab from debouncedSearch, independent of the raw per-keystroke input', () => {
    for (const name of ['filteredExactMatches', 'filteredNeedsReview', 'filteredMapped', 'filteredConflicts']) {
      const def = source.match(new RegExp(`const ${name} = useMemo\\([\\s\\S]*?\\n  \\);`));
      expect(def, `expected to find ${name}`).toBeTruthy();
      expect(def![0]).toMatch(/debouncedSearch/);
    }
  });

  it('each tab renders its filtered list, not the raw unfiltered list', () => {
    expect(source).toMatch(/\{filteredExactMatches\.map\(/);
    expect(source).toMatch(/\{filteredNeedsReview\.map\(/);
    expect(source).toMatch(/\{filteredMapped\.map\(/);
    expect(source).toMatch(/\{filteredConflicts\.map\(/);
    // The raw lists must still exist unfiltered -- for counts/stat cards/selection.
    expect(source).not.toMatch(/\{exactMatches\.map\(/);
    expect(source).not.toMatch(/\{needsReview\.map\(/);
    expect(source).not.toMatch(/\{mapped\.map\(/);
    expect(source).not.toMatch(/\{conflicts\.map\(/);
  });

  it('shows a distinct "no results" empty state per tab, only when the tab has data but the search matched nothing', () => {
    const noResultsBlocks = (source.match(/title="No matching results"/g) || []).length;
    expect(noResultsBlocks).toBe(4);
    // Each one must be gated behind the ORIGINAL (unfiltered) list being non-empty --
    // i.e. the existing "nothing exists at all" empty states are untouched and still
    // take priority over the new "no search results" state.
    expect(source).toMatch(/exactMatches\.length === 0 \? \(\s*<EmptyState icon=\{CheckCircle2\} title="No exact matches pending"[\s\S]*?\) : filteredExactMatches\.length === 0 \? \(/);
    expect(source).toMatch(/needsReview\.length === 0 \? \(\s*<EmptyState icon=\{Search\} title="Nothing needs review"[\s\S]*?\) : filteredNeedsReview\.length === 0 \? \(/);
    expect(source).toMatch(/mapped\.length === 0 \? \(\s*<EmptyState icon=\{UserCheck\} title="No confirmed mappings yet"[\s\S]*?\) : filteredMapped\.length === 0 \? \(/);
    expect(source).toMatch(/conflicts\.length === 0 \? \(\s*<EmptyState icon=\{AlertTriangle\} title="No conflicts"[\s\S]*?\) : filteredConflicts\.length === 0 \? \(/);
  });

  it('preserves every existing selection/bulk-confirm control exactly as before -- still keyed off the unfiltered arrays', () => {
    expect(source).toMatch(/checked=\{selectedExact\.size === exactMatches\.length && exactMatches\.length > 0\}/);
    expect(source).toMatch(/onChange=\{toggleSelectAllExact\}/);
    expect(source).toMatch(/\{selectedExact\.size\} of \{exactMatches\.length\} selected/);
    expect(source).toMatch(/checked=\{selectedStrongReview\.size === strongReviewIdentities\.length && strongReviewIdentities\.length > 0\}/);
    expect(source).toMatch(/const handleConfirmSelected = useCallback/);
    expect(source).toMatch(/const handleConfirmSelectedStrongReview = useCallback/);
  });

  it('preserves the terminal-assignment and Change actions on the Mapped tab untouched', () => {
    expect(source).toMatch(/onClick=\{\(\) => openTerminalModal\(i\)\}/);
    expect(source).toMatch(/onClick=\{\(\) => \{ setPickerFor\(i\.profile\); setPickerIsRemap\(true\); setPickerQuery\(''\); \}\}/);
    expect(source).toMatch(/const handleSaveTerminals = useCallback/);
  });
});
