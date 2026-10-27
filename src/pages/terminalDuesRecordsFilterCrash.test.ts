import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Regression pin for BUG 1 (Records status-filter crash: "Cannot access
// '...' before initialization"). This repo has no React component-
// rendering test infrastructure (no @testing-library/react dependency --
// see absentDeductionDisplay.test.ts's own header for the same convention),
// so this pins the fix at the source level instead.
//
// Root cause: `displayedCalculations` is a useMemo whose factory function
// reads `financialsByEntitlement` (another useMemo's result) inside the
// branch guarded by `filterStatus !== 'all'`. useMemo factories run
// synchronously during render, in source order, every render -- not
// deferred to a later event. Declaring `financialsByEntitlement` AFTER
// `displayedCalculations` in the component body meant every render
// attempted to read a `const` that, in THAT render's top-to-bottom
// execution, had not been initialized yet the moment the guarded branch
// actually ran -- a genuine temporal-dead-zone ReferenceError. The default
// filter is 'all', so the branch (and the crash) was never reached on
// initial load -- only once a user clicked Pending Approval, Outstanding,
// or Fully Settled, matching the exact reported symptom.
//
// The fix is purely a declaration-order move: `financialsByEntitlement`
// must be declared (and therefore initialized) before
// `displayedCalculations` in the component body. This test pins that
// order directly in the source text so the two can never silently swap
// back.
const terminalDuesSource = fs.readFileSync(path.resolve(__dirname, './TerminalDues.tsx'), 'utf-8');

describe('TerminalDues.tsx: financialsByEntitlement must be declared before displayedCalculations', () => {
  it('BUG 1 regression: declaration order prevents a temporal-dead-zone crash when a status filter is selected', () => {
    const financialsIndex = terminalDuesSource.indexOf('const financialsByEntitlement = useMemo(');
    const displayedIndex = terminalDuesSource.indexOf('const displayedCalculations = useMemo(');

    expect(financialsIndex).toBeGreaterThan(-1);
    expect(displayedIndex).toBeGreaterThan(-1);
    expect(financialsIndex).toBeLessThan(displayedIndex);
  });

  it('displayedCalculations still reads financialsByEntitlement only inside the non-"all" filter branch (confirms the crash-triggering code path still exists and is exercised by every non-default filter)', () => {
    const displayedBlockStart = terminalDuesSource.indexOf('const displayedCalculations = useMemo(');
    const nextBlock = terminalDuesSource.indexOf('// ===== PAGINATED DUES =====', displayedBlockStart);
    const displayedBlock = terminalDuesSource.slice(displayedBlockStart, nextBlock);

    expect(displayedBlock).toMatch(/filterStatus !== 'all'/);
    expect(displayedBlock).toMatch(/financialsByEntitlement\.get\(c\.id\)/);
    expect(displayedBlock).toMatch(/matchesOverviewFilter\(filterStatus/);
  });

  it('all three selectable status filters (pending_approval, outstanding, fully_settled) are wired to the same filterStatus state that drives displayedCalculations', () => {
    expect(terminalDuesSource).toMatch(/\['pending_approval', 'Pending Approval'\]/);
    expect(terminalDuesSource).toMatch(/\['outstanding', 'Outstanding'\]/);
    expect(terminalDuesSource).toMatch(/\['fully_settled', 'Fully Settled'\]/);
  });

  it('search and pagination logic are untouched by the fix -- displayedCalculations still filters by search after the status filter, and pagination still derives from displayedCalculations', () => {
    expect(terminalDuesSource).toMatch(/const paginatedDues = useMemo\(\(\) => \{/);
    expect(terminalDuesSource).toMatch(/displayedCalculations\.slice\(startIndex, endIndex\)/);
    expect(terminalDuesSource).toMatch(/setDuesPage\(1\);\s*\n\s*\}, \[search, filterStatus\]\);/);
  });
});
