import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Phase 2B.2C: Reschedule Off Day, Policy Option A UI. Same established
// precedent as this directory's other Roster.*.test.ts files (no
// component-test harness in this repo -- see Roster.employeeSearch.test.ts's
// own header) -- these pin how Roster.tsx wires the new mandatory-swap
// workflow: required fields, the removed optional checkbox, the
// before/after preview, and submit-button gating.
const rosterSource = fs.readFileSync(path.resolve(__dirname, './Roster.tsx'), 'utf-8');

describe('Reschedule Off Day: the old optional "also assign work on the vacated date" design is gone', () => {
  it('no checkbox, vacated-date, or vacated-type state remains', () => {
    expect(rosterSource).not.toMatch(/rescheduleAssignVacated/);
    expect(rosterSource).not.toMatch(/rescheduleVacatedDate/);
    expect(rosterSource).not.toMatch(/rescheduleVacatedType/);
    expect(rosterSource).not.toMatch(/Also assign work on the vacated date/);
  });

  it('no longer calls rescheduleOffDay with the old 5-argument (employeeId, newOffDate, reason, vacatedDate?, vacatedType?) shape', () => {
    expect(rosterSource).not.toMatch(/rescheduleNewOffDate/);
  });
});

describe('Reschedule Off Day: the new mandatory fields all exist as required state', () => {
  it('has original date, replacement date, shift, and reason state', () => {
    expect(rosterSource).toMatch(/const \[rescheduleOriginalDate, setRescheduleOriginalDate\] = useState\(''\);/);
    expect(rosterSource).toMatch(/const \[rescheduleReplacementDate, setRescheduleReplacementDate\] = useState\(''\);/);
    expect(rosterSource).toMatch(/const \[rescheduleShift, setRescheduleShift\] = useState<'day' \| 'night'>\('day'\);/);
    expect(rosterSource).toMatch(/const \[rescheduleReason, setRescheduleReason\] = useState\(''\);/);
  });

  it('calls rescheduleOffDay with the new 5-argument (employeeId, originalDate, replacementDate, shift, reason) shape', () => {
    expect(rosterSource).toMatch(
      /rescheduleOffDay\(\s*\n\s*rescheduleEmployeeId,\s*\n\s*rescheduleOriginalDate,\s*\n\s*rescheduleReplacementDate,\s*\n\s*rescheduleShift,\s*\n\s*rescheduleReason\s*\n\s*\)/
    );
  });

  it('still uses the searchable EmployeeSingleSelect combobox, unchanged from Phase 2B.2C\'s employee-search work', () => {
    expect(rosterSource).toMatch(/<EmployeeSingleSelect employees=\{employees\} value=\{rescheduleEmployeeId\} onChange=\{setRescheduleEmployeeId\} \/>/);
  });
});

describe('Reschedule Off Day: submission is gated on every required field and the advisory preview having no blocking issue', () => {
  it('canSubmitReschedule requires employee, both dates, a non-empty reason, and an unblocked preview', () => {
    const def = rosterSource.match(/const canSubmitReschedule =[\s\S]*?;/)?.[0] ?? '';
    expect(def).toMatch(/!!rescheduleEmployeeId/);
    expect(def).toMatch(/!!rescheduleOriginalDate/);
    expect(def).toMatch(/!!rescheduleReplacementDate/);
    expect(def).toMatch(/!!rescheduleReason\.trim\(\)/);
    expect(def).toMatch(/!reschedulePreview\.blockingReason/);
  });

  it('the submit Button is disabled whenever canSubmitReschedule is false', () => {
    expect(rosterSource).toMatch(/<Button onClick=\{handleSubmitReschedule\} disabled=\{submitting \|\| !canSubmitReschedule\}>/);
  });

  it('handleSubmitReschedule refuses to call the RPC at all when canSubmitReschedule is false (defense in depth beyond the disabled button)', () => {
    const fn = rosterSource.match(/const handleSubmitReschedule = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[/)?.[0] ?? '';
    expect(fn).toMatch(/if \(!canSubmitReschedule\) \{/);
  });
});

describe('Reschedule Off Day: the Before/After preview is wired from the pure, independently-tested buildRescheduleOffDayPreview helper', () => {
  it('imports buildRescheduleOffDayPreview from rosterSchedule', () => {
    expect(rosterSource).toMatch(/buildRescheduleOffDayPreview/);
  });

  it('computes the preview from employee id, both dates, and the chosen shift, fed by the already-loaded dateAssignments/patterns/shiftPatterns state', () => {
    // Stage C Step 6B added shiftPatterns as a 7th argument so the preview
    // correctly accounts for a recurring Day/Night baseline, not just the
    // recurring Off-day pattern -- see Roster.recurringSchedule.test.ts.
    expect(rosterSource).toMatch(
      /buildRescheduleOffDayPreview\(rescheduleEmployeeId, rescheduleOriginalDate, rescheduleReplacementDate, rescheduleShift, dateAssignments, patterns, shiftPatterns\)/
    );
  });

  it('shows the employee\'s name AND employee number in the preview heading, not only an internal id', () => {
    expect(rosterSource).toMatch(/Preview for \{rescheduleSelectedEmployee\.fullName\}/);
    expect(rosterSource).toMatch(/\(\{rescheduleSelectedEmployee\.employeeNumber\}\)/);
  });

  it('the preview shows the ACTUAL resolved state for both dates in "Before" -- never hardcodes the original date as Off', () => {
    const beforeBlock = rosterSource.match(/Before<\/p>[\s\S]*?After<\/p>/)?.[0] ?? '';
    expect(beforeBlock).toMatch(/\{reschedulePreview\.originalResolved\}/);
    expect(beforeBlock).toMatch(/\{reschedulePreview\.replacementResolved\}/);
  });

  it('the preview shows the chosen shift for the original date and "off" for the replacement date in "After"', () => {
    const afterBlock = rosterSource.slice(rosterSource.indexOf('After</p>'));
    expect(afterBlock.slice(0, 600)).toMatch(/\{rescheduleShift\}/);
    expect(afterBlock.slice(0, 600)).toMatch(/>off<\/Badge>/);
  });

  it('surfaces the preview\'s blockingReason to the Admin when present, and otherwise states the preview is advisory', () => {
    expect(rosterSource).toMatch(/\{reschedulePreview\.blockingReason\}/);
    expect(rosterSource).toMatch(/This preview is advisory\. The database independently re-verifies every rule/);
  });
});

describe('Reschedule Off Day: all three roster forms humanize RPC error messages (employee UUID -> name/number)', () => {
  it('imports humanizeRosterError from rosterService', () => {
    expect(rosterSource).toMatch(/humanizeRosterError/);
  });

  it('every showNotification(..., \'error\') call that surfaces an RPC result.error passes it through humanizeRosterError', () => {
    const matches = rosterSource.match(/showNotification\(humanizeRosterError\(result\.error \|\| '[^']*', employees\), 'error'\)/g) || [];
    expect(matches.length).toBe(3); // off-pattern, assign-dates, reschedule
  });
});
