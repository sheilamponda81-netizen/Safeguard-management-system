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
// (handleSubmitOffPattern/handleSubmitAssignDates/handleSubmitReschedule),
// which this phase does not touch.
const rosterSource = fs.readFileSync(path.resolve(__dirname, './Roster.tsx'), 'utf-8');

const WRITE_RPC_NAMES = ['assignOffPattern(', 'assignDates(', 'rescheduleOffDay('];

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

  it('handleCalendarNav only ever sets calendarFrom/calendarTo via shiftCalendarRange -- never calls loadData, assignOffPattern, assignDates, or rescheduleOffDay directly', () => {
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

  it('the three roster write RPCs are called ONLY from the pre-existing form-submission handlers, never from any Calendar-tab code', () => {
    const submitHandlerNames = ['handleSubmitOffPattern', 'handleSubmitAssignDates', 'handleSubmitReschedule'];
    const rpcToOwner: Record<string, string> = {
      'assignOffPattern(': 'handleSubmitOffPattern',
      'assignDates(': 'handleSubmitAssignDates',
      'rescheduleOffDay(': 'handleSubmitReschedule',
    };

    // Collect every occurrence's containing handler by scanning each known
    // submit handler's own body for its RPC, and asserting the RPC name
    // appears in the WHOLE FILE exactly as many times as expected: once in
    // its import line, once in its owning submit handler's body, and never
    // anywhere else (in particular, never inside a Calendar-tab handler or
    // inside the JSX navigation controls).
    for (const [rpcCall, ownerName] of Object.entries(rpcToOwner)) {
      const ownerBody = getHandlerBody(ownerName);
      expect(ownerBody).toContain(rpcCall);

      const rpcBareName = rpcCall.slice(0, -1); // strip the trailing '('
      const totalOccurrences = (rosterSource.match(new RegExp(`\\b${rpcBareName}\\b`, 'g')) || []).length;
      // Exactly 2: once in the `import { ... } from '../utils/rosterService'` line, once as the actual call inside its owning submit handler.
      expect(totalOccurrences).toBe(2);
    }

    // Sanity: every submit handler named above actually exists and is distinct from every navigation handler.
    for (const name of submitHandlerNames) {
      expect(navigationHandlers).not.toContain(name);
    }
  });
});
