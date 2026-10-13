import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Stage C Step 6B: recurring Day/Night shift pattern UI. Same established
// precedent as this directory's other Roster.*.test.ts files (no
// component-test harness in this repo -- see Roster.employeeSearch.test.ts's
// own header) -- these pin how Roster.tsx wires the extended "Recurring
// Schedule" tab: the combined atomic save call, the independent
// update-this-field-or-not checkboxes, the Calendar's recurring-vs-exception
// marker, and that the old two-call (off-pattern-only) design is gone.
const rosterSource = fs.readFileSync(path.resolve(__dirname, './Roster.tsx'), 'utf-8');

describe('Recurring Schedule tab: the old off-pattern-only RPC call is gone', () => {
  it('no longer imports or calls assignOffPattern', () => {
    expect(rosterSource).not.toMatch(/assignOffPattern/);
  });

  it('no longer has the old handleSubmitOffPattern handler name', () => {
    expect(rosterSource).not.toMatch(/handleSubmitOffPattern/);
  });
});

describe('Recurring Schedule tab: the new combined atomic save call', () => {
  it('imports assignRecurringPattern and fetchActiveShiftPatterns', () => {
    expect(rosterSource).toMatch(/assignRecurringPattern/);
    expect(rosterSource).toMatch(/fetchActiveShiftPatterns/);
  });

  it('calls assignRecurringPattern with weekday/shiftType gated by their own "update this field" checkboxes, not always both', () => {
    expect(rosterSource).toMatch(/weekday: offPatternUpdateOffDay \? Number\(offPatternWeekday\) : undefined/);
    expect(rosterSource).toMatch(/shiftType: offPatternUpdateShift \? offPatternShiftType : undefined/);
  });

  it('has independent toggle state for each half of the recurring pattern', () => {
    expect(rosterSource).toMatch(/const \[offPatternUpdateOffDay, setOffPatternUpdateOffDay\] = useState\(true\);/);
    expect(rosterSource).toMatch(/const \[offPatternUpdateShift, setOffPatternUpdateShift\] = useState\(true\);/);
    expect(rosterSource).toMatch(/const \[offPatternShiftType, setOffPatternShiftType\] = useState<'day' \| 'night'>\('day'\);/);
  });

  it('requires at least one of the two halves to be selected before submitting', () => {
    expect(rosterSource).toMatch(/if \(!offPatternUpdateOffDay && !offPatternUpdateShift\)/);
    expect(rosterSource).toMatch(/Select at least one of weekly Off day or normal shift to update\./);
  });

  it('disables the Save button when neither half is selected, not just when no employees are selected', () => {
    expect(rosterSource).toMatch(/disabled=\{submitting \|\| offPatternEmployeeIds\.size === 0 \|\| \(!offPatternUpdateOffDay && !offPatternUpdateShift\)\}/);
  });

  it('explains the schedule continues until changed', () => {
    expect(rosterSource).toMatch(/until changed/i);
  });
});

describe('Recurring Schedule tab: fetched data flows into the resolver everywhere it is used', () => {
  it('loadData fetches shift patterns alongside off-day patterns and stores them in state', () => {
    expect(rosterSource).toMatch(/fetchActiveShiftPatterns\(\),/);
    expect(rosterSource).toMatch(/setShiftPatterns\(shiftPats\);/);
  });

  it('the Calendar grid passes shiftPatterns into resolveScheduleForDate', () => {
    expect(rosterSource).toMatch(/resolveScheduleForDate\(emp\.id, d, dateAssignments, patterns, shiftPatterns\)/);
  });

  it('the Reschedule Off Day preview passes shiftPatterns into buildRescheduleOffDayPreview', () => {
    expect(rosterSource).toMatch(
      /buildRescheduleOffDayPreview\(rescheduleEmployeeId, rescheduleOriginalDate, rescheduleReplacementDate, rescheduleShift, dateAssignments, patterns, shiftPatterns\)/
    );
  });
});

describe('Calendar tab: recurring-vs-exception visual distinction', () => {
  it('computes whether a cell is an explicit dated exception, independent of the resolved value', () => {
    expect(rosterSource).toMatch(/isExplicitException/);
  });

  it('renders a visible marker only for explicit exceptions, not for recurring-rule results', () => {
    expect(rosterSource).toMatch(/\{isExplicitException && \(/);
  });

  it('does not accidentally overwrite dated assignments -- the marker is purely additive to the existing Badge, never replacing it', () => {
    expect(rosterSource).toMatch(/<Badge color=\{color\}>\s*\{resolved\}/);
  });
});
