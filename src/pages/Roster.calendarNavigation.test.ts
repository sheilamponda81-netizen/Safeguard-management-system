import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Phase 2B.2A: this codebase has no component-test harness (no
// @testing-library/react dependency, and vitest.config.ts runs tests in
// the 'node' environment, not 'jsdom' -- see rosterMigrationSecurity.test.ts's
// own header for the established precedent of pinning an invariant at the
// SOURCE level when it cannot be runtime-tested without new test
// infrastructure this task was not authorized to add). These tests prove,
// from the actual committed source, that every Calendar-tab navigation
// handler (Previous/Next, Today, Week/Month toggle, and the From/To date
// inputs) only ever touches calendar VIEW state (calendarFrom/calendarTo/
// calendarViewMode) and read-only data loading -- never one of the three
// roster write RPCs. The write RPCs remain reachable ONLY from the three
// existing form-submission handlers on the other tabs
// (handleSubmitRecurringPattern/handleSubmitAssignDates/handleSubmitReschedule),
// which this phase does not touch. (Stage C Step 6B renamed
// handleSubmitOffPattern/assignOffPattern to handleSubmitRecurringPattern/
// assignRecurringPattern when the Off-day and Shift-type patterns were
// combined into one atomic save -- see Roster.recurringSchedule.test.ts.)
const rosterSource = fs.readFileSync(path.resolve(__dirname, './Roster.tsx'), 'utf-8');

const WRITE_RPC_NAMES = ['assignRecurringPattern(', 'assignDates(', 'applyWeekdayTransition('];

function getHandlerBody(name: string): string {
  // Each handler is declared as `const <name> = useCallback(<fn>, [deps]);`
  // -- capture from the declaration through the closing `}, [...]);` of its
  // own useCallback call (non-greedy up to the first such terminator after
  // the opening brace, which is correct here because none of these five
  // handlers nests another useCallback inside its body).
  const re = new RegExp(`const ${name} = useCallback\\([\\s\\S]*?\\n  \\}, \\[[^\\]]*\\]\\);`);
  const match = rosterSource.match(re);
  expect(match, `expected to find handler ${name} in Roster.tsx`).toBeTruthy();
  return match![0];
}

describe('Roster calendar navigation: no handler ever calls a roster write RPC', () => {
  const navigationHandlers = [
    'handleCalendarNav',
    'handleCalendarToday',
    'handleCalendarViewMode',
    'handleCalendarFromChange',
    'handleCalendarToChange',
  ];

  it.each(navigationHandlers)('%s never references any of the three write RPC calls', (name) => {
    const body = getHandlerBody(name);
    for (const rpcCall of WRITE_RPC_NAMES) {
      expect(body).not.toContain(rpcCall);
    }
  });

  it('handleCalendarNav only ever sets calendarFrom/calendarTo via shiftCalendarRange -- never calls loadData, assignRecurringPattern, assignDates, or applyWeekdayTransition directly', () => {
    const body = getHandlerBody('handleCalendarNav');
    expect(body).toMatch(/shiftCalendarRange\(calendarFrom, calendarTo, calendarViewMode, direction\)/);
    expect(body).toMatch(/setCalendarFrom\(next\.from\)/);
    expect(body).toMatch(/setCalendarTo\(next\.to\)/);
    expect(body).not.toMatch(/loadData\(\)/);
  });

  it('handleCalendarToday only ever resets to the current Blantyre week -- never writes', () => {
    const body = getHandlerBody('handleCalendarToday');
    expect(body).toMatch(/getBlantyreToday\(\)/);
    expect(body).toMatch(/setCalendarViewMode\('week'\)/);
    expect(body).toMatch(/setCalendarFrom\(startOfWeek\(today\)\)/);
    expect(body).toMatch(/setCalendarTo\(endOfWeek\(today\)\)/);
  });

  it('handleCalendarViewMode only ever recomputes the range for week/month -- never writes', () => {
    const body = getHandlerBody('handleCalendarViewMode');
    expect(body).toMatch(/startOfMonth\(anchor\)/);
    expect(body).toMatch(/endOfMonth\(anchor\)/);
  });

  it('the roster write RPCs are called ONLY from the pre-existing/declared form-submission handlers, never from any Calendar-tab code', () => {
    const submitHandlerNames = ['handleSubmitRecurringPattern', 'handleSubmitReschedule'];
    // Stage C Step 12A: the Temporary/Permanent Off Day tab calls ONE
    // atomic RPC, applyWeekdayTransition, for BOTH modes (replacing the
    // old per-week rescheduleOffDay loop and the old direct
    // assignRecurringPattern call in the Permanent branch).
    // Stage C Step 15B: the Correct/Cancel Special Assignment workflow
    // (and its second assignDates call site, and its sole ownership of
    // cancelDateAssignments) was REMOVED from the UI per the business
    // owner's simplified design -- every write RPC is single-owner
    // again, exactly as before Stage C Step 13. cancelDateAssignments
    // itself was NOT dropped (see Roster.simplifiedScheduling.test.ts)
    // -- it simply has no UI call site anymore, so it is intentionally
    // absent from this map.
    // Stage C Step 16A: the Assign Dates tab itself (and its own
    // assignDates call site/handleSubmitAssignDates handler) was removed
    // from the production interface entirely -- assignDates is likewise
    // intentionally absent from this map and from submitHandlerNames.
    // assignDates() itself was NOT dropped from rosterService.ts/the
    // database (see Roster.simplifiedScheduling.test.ts) -- it simply
    // has no UI call site anymore.
    const rpcToOwners: Record<string, string[]> = {
      'assignRecurringPattern(': ['handleSubmitRecurringPattern'],
      'applyWeekdayTransition(': ['handleSubmitReschedule'],
    };

    // Collect every occurrence's containing handler by scanning each known
    // submit handler's own body for its RPC, and asserting the RPC name
    // appears in the WHOLE FILE exactly as many times as expected: once in
    // its import line, once per owning submit handler's body, and never
    // anywhere else EXCEPT inside this file's own prose comments explaining
    // the reuse (in particular, never inside a Calendar-tab handler or
    // inside the JSX navigation controls).
    for (const [rpcCall, ownerNames] of Object.entries(rpcToOwners)) {
      for (const ownerName of ownerNames) {
        const ownerBody = getHandlerBody(ownerName);
        expect(ownerBody).toContain(rpcCall);
      }

      const rpcBareName = rpcCall.slice(0, -1); // strip the trailing '('
      const codeOccurrences = (rosterSource.match(new RegExp(`\\b${rpcBareName}\\(`, 'g')) || []).length;
      // Exactly one call site per declared owner, with no call sites outside those owners.
      expect(codeOccurrences).toBe(ownerNames.length);
    }

    for (const [rpcCall, ownerNames] of Object.entries(rpcToOwners)) {
      for (const navName of navigationHandlers) {
        expect(getHandlerBody(navName)).not.toContain(rpcCall);
      }
      // No other handler among the three submit handlers calls an RPC it does not own.
      for (const otherOwner of submitHandlerNames.filter((n) => !ownerNames.includes(n))) {
        expect(getHandlerBody(otherOwner)).not.toContain(rpcCall);
      }
    }

    // Sanity: every submit handler named above actually exists and is distinct from every navigation handler.
    for (const name of submitHandlerNames) {
      expect(navigationHandlers).not.toContain(name);
    }
  });
});

// Extracts the Calendar tab's whole JSX block (from the `activeTab === 'calendar'` branch up to the next `) : activeTab ===` branch), used by the polish-fix tests below to anchor their assertions to the actual rendered markup.
function getCalendarTabJsx(): string {
  const match = rosterSource.match(/activeTab === 'calendar' \? \([\s\S]*?\n\s*\) : activeTab === 'off-pattern'/);
  expect(match, 'expected to find the Calendar tab JSX block in Roster.tsx').toBeTruthy();
  return match![0];
}

describe('Roster calendar UX polish: date-range separator, invalid-range heading, oversized-range navigation', () => {
  it('never renders the old double-hyphen "--" as a date-range separator anywhere in the Calendar tab', () => {
    const jsx = getCalendarTabJsx();
    // Stage C Step 14 added a legitimate explanatory paragraph to the
    // Calendar tab (distinguishing recurring vs special Off, Unassigned,
    // and Leave/Sick Leave) that, like the page subtitle and the Assign
    // Dates tab's own prose, uses "--" as an ordinary sentence dash --
    // that is not what this test guards against. The actual anti-pattern
    // is two raw ISO dates stitched together with "--" as a range
    // separator (e.g. "2026-10-01--2026-10-07"), which must never appear.
    expect(jsx).not.toMatch(/\d{4}-\d{2}-\d{2}\s*--\s*\d{4}-\d{2}-\d{2}/);
  });

  it('formatPeriodHeading\'s en dash is actually what the heading element renders (calendarPeriodHeading, not a second copy of the separator logic in the component)', () => {
    const jsx = getCalendarTabJsx();
    expect(jsx).toMatch(/<h2[^>]*>\{calendarPeriodHeading\}<\/h2>/);
  });

  it('shows a clear "Invalid date range" heading when From is later than To, and still preserves the original validation sentence', () => {
    const jsx = getCalendarTabJsx();
    expect(jsx).toMatch(/\{!isCalendarRangeValid \? \(/);
    expect(jsx).toMatch(/Invalid date range/);
    expect(jsx).toMatch(/The To date must be on or after the From date\. Adjust one of the dates above to see the calendar\./);
  });

  it('the custom-range helper paragraph only renders when the range is valid -- it can never show the misleading "? day(s)" fallback, because that fallback no longer exists in the source at all', () => {
    const jsx = getCalendarTabJsx();
    expect(rosterSource).not.toContain("day(s)) : '?'");
    expect(rosterSource).not.toContain("'?' day(s)");
    expect(jsx).toMatch(/calendarViewMode === 'custom' && isCalendarRangeValid && !calendarRangeTooLarge && \(/);
  });

  it('shows a distinct, action-oriented navigation message (not the day-count helper) when a valid custom range is oversized', () => {
    const jsx = getCalendarTabJsx();
    expect(jsx).toMatch(/calendarViewMode === 'custom' && isCalendarRangeValid && calendarRangeTooLarge && \(/);
    expect(jsx).toMatch(/Previous\/Next are unavailable for this range\. Shorten it to \{MAX_CUSTOM_RANGE_DAYS\} days or fewer, or switch to Week or Month view\./);
  });

  it('preserves the existing maximum-range warning Card contents (day count and the configured maximum)', () => {
    const jsx = getCalendarTabJsx();
    expect(jsx).toMatch(/This custom range is too large to display \(\{dateRangeLengthDays\(calendarFrom, calendarTo\)\} days/);
    expect(jsx).toMatch(/the maximum is \{MAX_CUSTOM_RANGE_DAYS\}\)/);
  });

  it('disables Previous/Next both when the range is invalid AND when a valid custom range is oversized -- not only on inversion', () => {
    const jsx = getCalendarTabJsx();
    const disabledAttrs = jsx.match(/disabled=\{!isCalendarRangeValid \|\| calendarRangeTooLarge\}/g) || [];
    expect(disabledAttrs.length).toBe(2); // Previous and Next buttons
  });

  it('handleCalendarNav itself (not just the buttons\' disabled attribute) refuses to navigate while the range is invalid or oversized', () => {
    const body = getHandlerBody('handleCalendarNav');
    expect(body).toMatch(/if \(!isCalendarRangeValid \|\| calendarRangeTooLarge\) return;/);
  });
});
