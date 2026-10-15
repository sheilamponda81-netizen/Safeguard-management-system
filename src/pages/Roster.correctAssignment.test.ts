import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Stage C Step 13: "Correct or Cancel Special Roster Assignments." Adds a
// mode toggle to the existing Assign Dates tab -- "Assign New Dates" (the
// original, untouched workflow) vs "Correct / Cancel Special Assignment"
// (new). Correcting a special Day<->Night (or Day/Night->Off) assignment
// reuses the existing, unmodified assignDates/roster_assign_dates RPC
// wholesale (it already hard-blocks overriding a genuinely-Off date and
// enforces every other safety rule); cancelling a mistaken dated exception
// is the one genuinely new capability, via the new
// roster_cancel_date_assignments RPC, wired through the new
// cancelDateAssignments wrapper. Same established precedent as this
// directory's other Roster.*.test.ts files (no component-test harness in
// this repo) -- these pin how Roster.tsx wires the new workflow: the mode
// toggle, the range-scoped data fetch, the before/after preview, the
// protected-recurring-day handling, the required reason, and the correct
// RPC call per action.
const rosterSource = fs.readFileSync(path.resolve(__dirname, './Roster.tsx'), 'utf-8');

describe('Correct / Cancel Special Assignment: a mode toggle sits alongside the existing Assign New Dates workflow, which is otherwise untouched', () => {
  it('declares assignTabMode state, defaulting to "new" so existing behavior is unchanged until an admin opts in', () => {
    expect(rosterSource).toMatch(/const \[assignTabMode, setAssignTabMode\] = useState<'new' \| 'correct'>\('new'\);/);
  });

  it('renders both radio options for the mode toggle', () => {
    expect(rosterSource).toMatch(/checked=\{assignTabMode === 'new'\} onChange=\{\(\) => setAssignTabMode\('new'\)\}/);
    expect(rosterSource).toMatch(/checked=\{assignTabMode === 'correct'\} onChange=\{\(\) => setAssignTabMode\('correct'\)\}/);
  });

  it('wraps the ENTIRE original bulk-assign form (employee multi-select, From/To/Assignment, reason, submit) inside the "new" mode branch, unchanged', () => {
    const newBranch = rosterSource.match(/\{assignTabMode === 'new' \? \([\s\S]*?\n {10}\) : \(/)?.[0] ?? '';
    expect(newBranch).toMatch(/toggleInSet\(assignEmployeeIds, setAssignEmployeeIds, emp\.id\)/);
    expect(newBranch).toMatch(/<Select label="Assignment" value=\{assignType\} onChange=\{\(e\) => setAssignType\(e\.target\.value as AssignmentType\)\} options=\{ASSIGNMENT_TYPE_OPTIONS\} \/>/);
    expect(newBranch).toMatch(/onClick=\{handleSubmitAssignDates\}/);
  });
});

describe('Correct / Cancel Special Assignment: dedicated state, a single-employee selector, and a range-scoped fetch independent of the Calendar tab', () => {
  it('declares one employee, a date range, an action (cancel or correct-to-type), and a required reason', () => {
    expect(rosterSource).toMatch(/const \[correctEmployeeId, setCorrectEmployeeId\] = useState\(''\);/);
    expect(rosterSource).toMatch(/const \[correctDateFrom, setCorrectDateFrom\] = useState\(defaults\.today\);/);
    expect(rosterSource).toMatch(/const \[correctDateTo, setCorrectDateTo\] = useState\(defaults\.today\);/);
    expect(rosterSource).toMatch(/const \[correctAction, setCorrectAction\] = useState<'cancel' \| AssignmentType>\('cancel'\);/);
    expect(rosterSource).toMatch(/const \[correctReason, setCorrectReason\] = useState\(''\);/);
  });

  it('uses the single-employee EmployeeSingleSelect, not the multi-select checkbox list used by Assign New Dates', () => {
    expect(rosterSource).toMatch(/<EmployeeSingleSelect employees=\{employees\} value=\{correctEmployeeId\} onChange=\{setCorrectEmployeeId\} \/>/);
  });

  it('fetches dated assignments scoped to exactly the selected range, independent of the Calendar tab\'s own visible range', () => {
    const effect = rosterSource.match(/useEffect\(\(\) => \{\s*\n\s*let cancelled = false;\s*\n\s*if \(!correctEmployeeId \|\| !isCorrectRangeValid\) \{[\s\S]*?\n {2}\}, \[correctEmployeeId, correctDateFrom, correctDateTo, isCorrectRangeValid\]\);/)?.[0] ?? '';
    expect(effect).toMatch(/fetchActiveDateAssignments\(correctDateFrom, correctDateTo\)/);
  });

  it('validates the range with the same shared isValidDateRange helper used elsewhere in this file', () => {
    expect(rosterSource).toMatch(/const isCorrectRangeValid = isValidDateRange\(correctDateFrom, correctDateTo\);/);
  });
});

describe('Correct / Cancel Special Assignment: the current-schedule summary distinguishes recurring from special (dated) per date', () => {
  it('computes correctSummary via summarizeDateRangeAssignments, the new pure helper', () => {
    expect(rosterSource).toMatch(
      /summarizeDateRangeAssignments\(correctEmployeeId, correctDateFrom, correctDateTo, correctRangeAssignments, patterns, shiftPatterns\)/
    );
  });

  it('counts how many dates in range actually have a special dated assignment that can be acted on', () => {
    expect(rosterSource).toMatch(/const correctCancellableCount = useMemo\(\(\) => correctSummary\.filter\(\(d\) => d\.hasDatedException\)\.length, \[correctSummary\]\);/);
  });

  it('renders each date with its resolved Badge and an explicit Recurring-vs-Special(dated) label', () => {
    expect(rosterSource).toMatch(/<Badge color=\{scheduleBadgeColor\(d\.resolved\)\}>\{d\.resolved\}<\/Badge>/);
    expect(rosterSource).toMatch(/\{d\.hasDatedException \? 'Special \(dated\)' : 'Recurring'\}/);
  });
});

describe('Correct / Cancel Special Assignment: the before/after preview never forces Day, and blocks working-day corrections onto a genuinely Off date', () => {
  it('cancel mode\'s "after" value is the pure underlyingResolved from the summary -- whatever the recurring pattern says, not a hardcoded type', () => {
    const def = rosterSource.match(/const correctPreviewRows = useMemo\(\(\) => \{[\s\S]*?\n {2}\}, \[correctSummary, correctAction, correctEmployeeId, correctRangeAssignments, patterns, shiftPatterns\]\);/)?.[0] ?? '';
    expect(def).toMatch(/if \(correctAction === 'cancel'\) \{\s*\n\s*return \{ \.\.\.d, after: d\.hasDatedException \? d\.underlyingResolved : null, blocked: false \};/);
  });

  it('correct-to-type mode reuses wouldOverrideRecurringOffDay (the same advisory check used by Assign New Dates) to flag dates that are genuinely Off and must stay protected', () => {
    const def = rosterSource.match(/const correctPreviewRows = useMemo\(\(\) => \{[\s\S]*?\n {2}\}, \[correctSummary, correctAction, correctEmployeeId, correctRangeAssignments, patterns, shiftPatterns\]\);/)?.[0] ?? '';
    expect(def).toMatch(/wouldOverrideRecurringOffDay\(correctEmployeeId, d\.date, correctAction, correctRangeAssignments, patterns, shiftPatterns\)/);
  });

  it('a date with no dated exception in cancel mode is rendered as protected -- nothing to cancel -- never actioned', () => {
    expect(rosterSource).toMatch(/if \(correctAction === 'cancel' && !row\.hasDatedException\) \{/);
    expect(rosterSource).toMatch(/No special assignment -- protected, nothing to cancel/);
  });

  it('a blocked correct-to-type row is visibly flagged as blocked in the preview', () => {
    expect(rosterSource).toMatch(/blocked -- already Off/);
  });
});

describe('Correct / Cancel Special Assignment: submission requires employee, valid range, reason, and at least one actionable date, and is atomic per action', () => {
  it('canSubmitCorrect requires all of: employee, valid range, non-empty reason, a non-empty summary, and at least one changeable date', () => {
    const def = rosterSource.match(/const canSubmitCorrect =[\s\S]*?correctChangeableCount > 0;/)?.[0] ?? '';
    expect(def).toMatch(/!!correctEmployeeId/);
    expect(def).toMatch(/isCorrectRangeValid/);
    expect(def).toMatch(/!!correctReason\.trim\(\)/);
    expect(def).toMatch(/correctSummary\.length > 0/);
    expect(def).toMatch(/correctChangeableCount > 0/);
  });

  it('the submit Button is disabled whenever canSubmitCorrect is false', () => {
    expect(rosterSource).toMatch(/<Button onClick=\{handleSubmitCorrect\} disabled=\{submitting \|\| !canSubmitCorrect\}>/);
  });

  it('handleSubmitCorrect refuses to call any RPC at all when canSubmitCorrect is false (defense in depth beyond the disabled button)', () => {
    const fn = rosterSource.match(/const handleSubmitCorrect = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[canSubmitCorrect, correctAction, correctEmployeeId, correctDateFrom, correctDateTo, correctReason, employees, loadData\]\);/)?.[0] ?? '';
    expect(fn).toMatch(/if \(!canSubmitCorrect\) \{/);
  });

  it('cancel mode calls the new cancelDateAssignments wrapper (one atomic RPC call), never a per-date loop', () => {
    const fn = rosterSource.match(/const handleSubmitCorrect = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[canSubmitCorrect, correctAction, correctEmployeeId, correctDateFrom, correctDateTo, correctReason, employees, loadData\]\);/)?.[0] ?? '';
    expect(fn).toMatch(/correctAction === 'cancel'\s*\n\s*\? await cancelDateAssignments\(\[correctEmployeeId\], correctDateFrom, correctDateTo, correctReason\)/);
  });

  it('correct-to-type mode reuses the existing, unmodified assignDates RPC wrapper -- no new write path for this direction', () => {
    const fn = rosterSource.match(/const handleSubmitCorrect = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[canSubmitCorrect, correctAction, correctEmployeeId, correctDateFrom, correctDateTo, correctReason, employees, loadData\]\);/)?.[0] ?? '';
    expect(fn).toMatch(/: await assignDates\(\[correctEmployeeId\], correctDateFrom, correctDateTo, correctAction, correctReason\);/);
  });

  it('a failed correction is humanized through humanizeRosterError, same as every other roster form', () => {
    const fn = rosterSource.match(/const handleSubmitCorrect = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[canSubmitCorrect, correctAction, correctEmployeeId, correctDateFrom, correctDateTo, correctReason, employees, loadData\]\);/)?.[0] ?? '';
    expect(fn).toMatch(/humanizeRosterError\(result\.error \|\| 'Could not apply this correction\.', employees\)/);
  });
});

describe('Correct / Cancel Special Assignment: explanatory copy distinguishes roster Off from Leave/Sick Leave and payroll', () => {
  it('states plainly that this tool never touches attendance, Leave/Sick Leave, or payroll', () => {
    expect(rosterSource).toMatch(/never touches attendance records, approved Leave or Sick Leave, and/);
    expect(rosterSource).toMatch(/never changes payroll\./);
  });
});
