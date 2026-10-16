import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Stage C Step 15B: "Simplify the Entire Roster to Monday-Sunday Weekly
// Scheduling." The business owner finalized a simpler model and asked
// to REMOVE the user-facing Correct / Cancel Special Assignment
// workflow and the ability to create additional dated Off assignments
// from the Assign Dates tab -- both added in Stage C Steps 13-15. These
// tests pin the REMOVAL from the UI (no component-test harness in this
// repo, same source-pinned convention as every other Roster.*.test.ts
// file) while confirming the underlying database capability
// (roster_cancel_date_assignments, and the pure helpers that back it)
// was NOT dropped -- it remains available as a dormant,
// administrator-only historical-correction path, per the explicit
// instruction "do not drop database tables or RPCs merely because a UI
// feature is removed."
const rosterSource = fs.readFileSync(path.resolve(__dirname, './Roster.tsx'), 'utf-8');
const rosterServiceSource = fs.readFileSync(path.resolve(__dirname, '../utils/rosterService.ts'), 'utf-8');
const rosterScheduleSource = fs.readFileSync(path.resolve(__dirname, '../utils/rosterSchedule.ts'), 'utf-8');

describe('Correct / Cancel Special Assignment: fully removed from the UI', () => {
  it('no mode toggle, no "correct" tab mode, and no Correct/Cancel heading text remain in Roster.tsx', () => {
    expect(rosterSource).not.toMatch(/assignTabMode/);
    expect(rosterSource).not.toMatch(/Correct \/ Cancel Special Assignment/);
    expect(rosterSource).not.toMatch(/Assign New Dates/); // the old mode-toggle label -- there is only one mode now, no label needed
  });

  it('none of the Correct/Cancel-specific state, memos, or handler remain', () => {
    for (const symbol of [
      'correctEmployeeId', 'correctDateFrom', 'correctDateTo', 'correctAction', 'correctReason',
      'correctRangeAssignments', 'correctSelectedEmployee', 'isCorrectRangeValid', 'correctSummary',
      'correctCancellableCount', 'correctPreviewRows', 'correctChangeableCount',
      'correctCancellationSafety', 'correctCancellationDescription', 'canSubmitCorrect', 'handleSubmitCorrect',
    ]) {
      expect(rosterSource).not.toContain(symbol);
    }
  });

  it('Roster.tsx no longer imports the cancellation-preview helpers or the cancelDateAssignments RPC wrapper', () => {
    expect(rosterSource).not.toMatch(/\bcancelDateAssignments\b/);
    expect(rosterSource).not.toMatch(/\bevaluateCancellationSafety\b/);
    expect(rosterSource).not.toMatch(/\bdescribeCancellationSafety\b/);
    expect(rosterSource).not.toMatch(/\bexplainCalendarWeekConflict\b/);
    expect(rosterSource).not.toMatch(/\bsummarizeDateRangeAssignments\b/);
  });
});

describe('Assign Dates: can no longer create an additional dated Off assignment', () => {
  it('ASSIGNMENT_TYPE_OPTIONS offers only Day and Night, never Off', () => {
    const def = rosterSource.match(/const ASSIGNMENT_TYPE_OPTIONS = \[[\s\S]*?\];/)?.[0] ?? '';
    expect(def).toMatch(/\{ label: 'Day shift', value: 'day' \}/);
    expect(def).toMatch(/\{ label: 'Night shift', value: 'night' \}/);
    expect(def).not.toMatch(/value: 'off'/);
  });

  it('the Assign Dates tab\'s own explanatory text confirms it can no longer create a dated Off exception', () => {
    expect(rosterSource).toMatch(/this tab can no longer create a dated Off exception either/);
  });

  it('still describes the hard block on placing a working assignment over a protected Off date, with no override', () => {
    expect(rosterSource).toMatch(/A working assignment cannot be placed on a date an employee is already scheduled Off -- this is always blocked, with no override/);
  });
});

describe('Database layer: the capability is retained, not dropped, even though no UI control reaches it', () => {
  it('rosterService.ts still exports cancelDateAssignments, a thin wrapper around the unmodified roster_cancel_date_assignments RPC', () => {
    expect(rosterServiceSource).toMatch(/export async function cancelDateAssignments\(/);
    expect(rosterServiceSource).toMatch(/roster_cancel_date_assignments/);
  });

  it('rosterSchedule.ts still exports every pure helper that backs that dormant capability', () => {
    for (const symbol of [
      'export function evaluateCancellationSafety(',
      'export function describeCancellationSafety(',
      'export function summarizeDateRangeAssignments(',
    ]) {
      expect(rosterScheduleSource).toContain(symbol);
    }
  });

  it('the Step 15 calendar-week business rule was reverted along with its now-unnecessary migration -- no longer exported', () => {
    for (const symbol of [
      'checkCalendarWeekOffCoverage',
      'findCalendarWeeksWithoutOffDay',
      'explainCalendarWeekConflict',
      'CalendarWeekOffCoverage',
    ]) {
      expect(rosterScheduleSource).not.toContain(symbol);
    }
  });
});

describe('Calendar: historical special Off records remain readable, even though no UI control can create new ones', () => {
  it('still renders an explicit "(special)" label and tooltip distinguishing a dated exception from a recurring result', () => {
    expect(rosterSource).toMatch(/\{resolved\}\{isExplicitException \? ' \(special\)' : ''\}/);
    expect(rosterSource).toMatch(/One-off dated exception -- the recurring pattern resumes once this is cancelled/);
  });

  it('still computes isExplicitException from the SAME dateAssignments data the Calendar always fetches -- a historical "off" dated row shows up exactly as before', () => {
    const isExplicitExceptionDef = rosterSource.match(/const isExplicitException = dateAssignments\.some\(\s*\n\s*\(a\) => a\.employeeId === emp\.id && a\.assignmentDate === d && a\.isActive\s*\n\s*\);/);
    expect(isExplicitExceptionDef).not.toBeNull();
  });

  it('the Calendar tab still resolves every cell through the single shared resolver, never a second copy of the logic', () => {
    expect(rosterSource).toMatch(/const resolved = resolveScheduleForDate\(emp\.id, d, dateAssignments, patterns, shiftPatterns\);/);
  });
});

describe('Recurring Schedule and Temporary/Permanent Off Day: unaffected by this simplification', () => {
  it('Recurring Schedule still writes both the Off weekday and the Day/Night shift in one call', () => {
    expect(rosterSource).toMatch(/handleSubmitRecurringPattern/);
    expect(rosterSource).toMatch(/assignRecurringPattern\(/);
  });

  it('Temporary/Permanent Off Day still uses the single atomic applyWeekdayTransition call, with bridge-day handling intact', () => {
    expect(rosterSource).toMatch(/applyWeekdayTransition\(/);
    expect(rosterSource).toMatch(/rescheduleBridgeDate/);
    expect(rosterSource).toMatch(/maintain the mandatory rest requirement/);
  });
});
