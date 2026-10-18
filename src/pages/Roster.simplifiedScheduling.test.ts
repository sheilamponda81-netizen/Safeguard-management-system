import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Stage C Step 15B: "Simplify the Entire Roster to Monday-Sunday Weekly
// Scheduling." The business owner finalized a simpler model and asked
// to REMOVE the user-facing Correct / Cancel Special Assignment
// workflow and the ability to create additional dated Off assignments
// from the Assign Dates tab -- both added in Stage C Steps 13-15.
// Stage C Step 16A went further and removed the Assign Dates tab
// itself entirely, leaving three production tabs (Calendar, Recurring
// Schedule, Temporary / Permanent Off Day). These tests pin both
// REMOVALS from the UI (no component-test harness in this repo, same
// source-pinned convention as every other Roster.*.test.ts file) while
// confirming the underlying database capabilities (roster_assign_dates,
// roster_cancel_date_assignments, and the pure helpers that back them)
// were NOT dropped -- they remain available as dormant,
// administrator-only historical-correction paths, per the explicit
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

// Stage C Step 16A: "Simplify Production Roster to Three Tabs." The
// Assign Dates tab (ad hoc dated Day/Night overrides) was removed
// entirely from the production interface -- the business primarily
// uses recurring Day/Night schedules and weekly Off-day changes, and
// temporary individual shift overrides are not required for the
// initial production release. Same policy as Step 15B's Correct/Cancel
// removal: the UI feature is gone, but roster_assign_dates, its
// rosterService.ts wrapper, and every historical dated assignment it
// already wrote are NOT dropped -- they remain a dormant,
// administrator-reachable-only-via-future-UI capability, and every
// historical dated exception stays fully readable on the Calendar tab.
describe('Assign Dates: fully removed from the UI (Stage C Step 16A)', () => {
  it('no tab id, label, state, handler, or local search for Assign Dates remains in Roster.tsx', () => {
    expect(rosterSource).not.toMatch(/'assign-dates'/);
    expect(rosterSource).not.toMatch(/label: 'Assign Dates'/);
    expect(rosterSource).not.toMatch(/ASSIGNMENT_TYPE_OPTIONS/);
    for (const symbol of [
      'assignEmployeeIds', 'assignType', 'assignDateFrom', 'assignDateTo', 'assignReason',
      'assignSearch', 'assignFilteredEmployees', 'handleSubmitAssignDates',
    ]) {
      expect(rosterSource).not.toContain(symbol);
    }
  });

  it('Roster.tsx no longer imports the assignDates RPC wrapper or the AssignmentType type', () => {
    expect(rosterSource).not.toMatch(/\bassignDates\b/);
    expect(rosterSource).not.toMatch(/\bAssignmentType\b/);
  });

  it('only three tabs remain: Calendar, Recurring Schedule, and Temporary / Permanent Off Day', () => {
    const tabsDef = rosterSource.match(/tabs=\{\[[\s\S]*?\]\}/)?.[0] ?? '';
    expect(tabsDef).toMatch(/id: 'calendar', label: 'Calendar'/);
    expect(tabsDef).toMatch(/id: 'off-pattern', label: 'Recurring Schedule'/);
    expect(tabsDef).toMatch(/id: 'reschedule', label: 'Temporary \/ Permanent Off Day'/);
    expect((tabsDef.match(/id: '/g) || []).length).toBe(3);
  });

  it("the TabId type itself only allows the three remaining tabs", () => {
    expect(rosterSource).toMatch(/type TabId = 'calendar' \| 'off-pattern' \| 'reschedule';/);
  });

  it('the Recurring Schedule tab\'s own explanatory text no longer references the removed Assign Dates tab by name, but still explains that a dated exception overrides the recurring pattern for one date only', () => {
    expect(rosterSource).toMatch(/A historical\s*\n\s*dated exception always overrides this for that one date only, and remains visible on the Calendar tab\./);
    expect(rosterSource).not.toMatch(/\(Assign Dates tab\)/);
  });
});

describe('Database layer: the capability is retained, not dropped, even though no UI control reaches it', () => {
  it('rosterService.ts still exports assignDates and cancelDateAssignments, thin wrappers around their unmodified RPCs', () => {
    expect(rosterServiceSource).toMatch(/export async function assignDates\(/);
    expect(rosterServiceSource).toMatch(/roster_assign_dates/);
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
