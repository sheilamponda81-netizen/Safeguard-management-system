import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Stage C Step 12A: the Temporary / Permanent Off Day tab's write path is
// now ONE atomic RPC call (applyWeekdayTransition -> roster_apply_weekday_transition)
// covering every affected week plus the single "bridge" week/date the
// rolling-seven-day rest rule sometimes requires -- replacing Step 12's
// per-week loop over rescheduleOffDay (which risked a partial outcome)
// and its direct assignRecurringPattern call in the Permanent branch.
// Same established precedent as this directory's other Roster.*.test.ts
// files (no component-test harness in this repo -- see
// Roster.employeeSearch.test.ts's own header) -- these pin how Roster.tsx
// wires the weekday+duration workflow: required fields, the
// Temporary/Permanent mode toggle, the multi-week/bridge-aware plan, the
// single atomic submission call, the bridge-day confirmation gate, and
// the plain-language rolling-rest-conflict explanation.
const rosterSource = fs.readFileSync(path.resolve(__dirname, './Roster.tsx'), 'utf-8');

describe('Temporary / Permanent Off Day: weekday-based fields replace the old exact-date-pair form', () => {
  it('no longer asks for two exact calendar dates -- original/replacement are weekday selects, not date inputs', () => {
    expect(rosterSource).not.toMatch(/const \[rescheduleOriginalDate, setRescheduleOriginalDate\]/);
    expect(rosterSource).not.toMatch(/const \[rescheduleReplacementDate, setRescheduleReplacementDate\]/);
    expect(rosterSource).toMatch(/const \[rescheduleOriginalWeekday, setRescheduleOriginalWeekday\] = useState\('3'\);/);
    expect(rosterSource).toMatch(/const \[rescheduleNewWeekday, setRescheduleNewWeekday\] = useState\('0'\);/);
  });

  it('has a single "week containing" date anchor, a shift selector, a duration control, a Permanent toggle, a reason, and a bridge-acknowledgment flag', () => {
    expect(rosterSource).toMatch(/const \[rescheduleWeekAnchor, setRescheduleWeekAnchor\] = useState\(defaults\.today\);/);
    expect(rosterSource).toMatch(/const \[rescheduleShift, setRescheduleShift\] = useState<'day' \| 'night'>\('day'\);/);
    expect(rosterSource).toMatch(/const \[rescheduleDurationMode, setRescheduleDurationMode\] = useState<'1' \| '2' \| '3' \| 'custom'>\('1'\);/);
    expect(rosterSource).toMatch(/const \[rescheduleCustomWeeks, setRescheduleCustomWeeks\] = useState\('4'\);/);
    expect(rosterSource).toMatch(/const \[rescheduleIsPermanent, setRescheduleIsPermanent\] = useState\(false\);/);
    expect(rosterSource).toMatch(/const \[rescheduleReason, setRescheduleReason\] = useState\(''\);/);
    expect(rosterSource).toMatch(/const \[rescheduleBridgeAcknowledged, setRescheduleBridgeAcknowledged\] = useState\(false\);/);
  });

  it('still uses the searchable EmployeeSingleSelect combobox, unchanged from Phase 2B.2C\'s employee-search work', () => {
    expect(rosterSource).toMatch(/<EmployeeSingleSelect employees=\{employees\} value=\{rescheduleEmployeeId\} onChange=\{setRescheduleEmployeeId\} \/>/);
  });

  it('Stage C Step 12E: auto-selects the Original Off weekday from the week\'s actual resolved Off day(s), never from today\'s date in isolation', () => {
    const effect = rosterSource.match(/useEffect\(\(\) => \{\s*\n\s*setRescheduleMultiOffChoiceMade\(false\);[\s\S]*?\n {2}\}, \[weekSummary\]\);/)?.[0] ?? '';
    expect(effect).toMatch(/if \(!weekSummary \|\| weekSummary\.actualOffDays\.length !== 1\) return;/);
    expect(effect).toMatch(/setRescheduleOriginalWeekday\(String\(weekSummary\.actualOffDays\[0\]\.weekdayJs\)\);/);
  });

  it('Stage C Step 12E: detects the normal shift for the SELECTED WEEK, not today\'s date, via the pure resolver helper', () => {
    const effect = rosterSource.match(/useEffect\(\(\) => \{\s*\n\s*if \(!rescheduleEmployeeId \|\| !rescheduleWeekStart\) return;[\s\S]*?\n {2}\}, \[rescheduleEmployeeId, rescheduleWeekStart, shiftPatterns\]\);/)?.[0] ?? '';
    expect(effect).toMatch(/resolveActiveShiftType\(rescheduleEmployeeId, rescheduleWeekStart, shiftPatterns\)/);
  });

  it('Stage C Step 12E: fetches dated assignments scoped to the selected week independently of the Calendar tab\'s own range, so the week summary is never missing data', () => {
    expect(rosterSource).toMatch(/const \[rescheduleWeekAssignments, setRescheduleWeekAssignments\] = useState<DateAssignmentRow\[\]>\(\[\]\);/);
    expect(rosterSource).toMatch(/fetchActiveDateAssignments\(addDays\(rescheduleWeekStart, -1\), addDays\(rescheduleWeekStart, 7\)\)/);
  });

  it('Stage C Step 12E: summarizes the week\'s actual Off day(s) via summarizeWeekSchedule/describeWeekOffDays, using the same resolver the Calendar tab uses', () => {
    expect(rosterSource).toMatch(/summarizeWeekSchedule\(rescheduleEmployeeId, rescheduleWeekStart, rescheduleWeekAssignments, patterns, shiftPatterns\)/);
    expect(rosterSource).toMatch(/describeWeekOffDays\(rescheduleSelectedEmployee\.fullName, weekSummary\)/);
  });
});

describe('Temporary / Permanent Off Day: the plan is built from the pure, independently-tested plan-builder helpers, one per mode', () => {
  it('imports buildTemporaryReschedulePlan, buildPermanentWeekdayTransitionPlan, applyWeekdayTransition and explainRollingRestConflict', () => {
    expect(rosterSource).toMatch(/buildTemporaryReschedulePlan/);
    expect(rosterSource).toMatch(/buildPermanentWeekdayTransitionPlan/);
    expect(rosterSource).toMatch(/applyWeekdayTransition/);
    expect(rosterSource).toMatch(/explainRollingRestConflict/);
  });

  it('reschedulePlan is built ONLY for Temporary mode -- it returns [] when rescheduleIsPermanent is true, one week per unit of duration otherwise', () => {
    const def = rosterSource.match(/const reschedulePlan: TemporaryRescheduleWeekPlan\[\] = useMemo\(\(\) => \{[\s\S]*?\n {2}\}, \[[\s\S]*?\]\);/)?.[0] ?? '';
    expect(def).toMatch(/if \(!rescheduleEmployeeId \|\| !rescheduleWeekStart \|\| rescheduleSameWeekday \|\| rescheduleIsPermanent\) return \[\];/);
    expect(def).toMatch(/buildTemporaryReschedulePlan\(/);
  });

  it('permanentPlan is built ONLY for Permanent mode, using buildPermanentWeekdayTransitionPlan', () => {
    const def = rosterSource.match(/const permanentPlan: PermanentWeekdayTransitionPlan \| null = useMemo\(\(\) => \{[\s\S]*?\n {2}\}, \[[\s\S]*?\]\);/)?.[0] ?? '';
    expect(def).toMatch(/if \(!rescheduleEmployeeId \|\| !rescheduleWeekStart \|\| rescheduleSameWeekday \|\| !rescheduleIsPermanent\) return null;/);
    expect(def).toMatch(/buildPermanentWeekdayTransitionPlan\(/);
  });

  it('rescheduleBridgeDate is derived uniformly from whichever plan is active for the current mode', () => {
    expect(rosterSource).toMatch(
      /const rescheduleBridgeDate: string \| null = rescheduleIsPermanent\s*\n\s*\? permanentPlan\?\.bridgeDate \?\? null\s*\n\s*: reschedulePlan\.find\(\(w\) => w\.isBridgeWeek\)\?\.originalDate \?\? null;/
    );
  });

  it('resets the bridge-day acknowledgment whenever the bridge date itself changes, so a stale confirmation can never carry over to a different plan', () => {
    expect(rosterSource).toMatch(
      /useEffect\(\(\) => \{\s*\n\s*setRescheduleBridgeAcknowledged\(false\);\s*\n\s*\}, \[rescheduleBridgeDate\]\);/
    );
  });
});

describe('Temporary / Permanent Off Day: submission is gated on every required field, every week being clean, and any bridge day being explicitly confirmed', () => {
  it('canSubmitReschedule requires employee, a valid week, different weekdays, a non-empty reason, a sane duration, a built plan for the active mode, every Temporary week unblocked, bridge acknowledgment when a bridge is needed, and an explicit multi-Off-day choice when the week has more than one', () => {
    const def = rosterSource.match(/const canSubmitReschedule =[\s\S]*?\(!weekSummary \|\| weekSummary\.actualOffDays\.length <= 1 \|\| rescheduleMultiOffChoiceMade\);/)?.[0] ?? '';
    expect(def).toMatch(/!!rescheduleEmployeeId/);
    expect(def).toMatch(/!!rescheduleWeekStart/);
    expect(def).toMatch(/!rescheduleSameWeekday/);
    expect(def).toMatch(/!!rescheduleReason\.trim\(\)/);
    expect(def).toMatch(/rescheduleDurationWeeks >= 1/);
    expect(def).toMatch(/rescheduleDurationWeeks <= MAX_TEMPORARY_RESCHEDULE_WEEKS/);
    expect(def).toMatch(/\(rescheduleIsPermanent \? !!permanentPlan : reschedulePlan\.length > 0\)/);
    expect(def).toMatch(/\(rescheduleIsPermanent \|\| reschedulePlan\.every\(\(w\) => !w\.preview\.blockingReason\)\)/);
    expect(def).toMatch(/\(!rescheduleBridgeDate \|\| rescheduleBridgeAcknowledged\)/);
    expect(def).toMatch(/\(!weekSummary \|\| weekSummary\.actualOffDays\.length <= 1 \|\| rescheduleMultiOffChoiceMade\)/);
  });

  it('the submit Button is disabled whenever canSubmitReschedule is false', () => {
    expect(rosterSource).toMatch(/<Button onClick=\{handleSubmitReschedule\} disabled=\{submitting \|\| !canSubmitReschedule\}>/);
  });

  it('handleSubmitReschedule refuses to call any RPC at all when canSubmitReschedule is false (defense in depth beyond the disabled button)', () => {
    const fn = rosterSource.match(/const handleSubmitReschedule = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[/)?.[0] ?? '';
    expect(fn).toMatch(/if \(!canSubmitReschedule\) \{/);
  });
});

describe('Temporary / Permanent Off Day: a single atomic applyWeekdayTransition call handles BOTH modes -- no per-week loop, no direct assignRecurringPattern/rescheduleOffDay call', () => {
  it('calls applyWeekdayTransition exactly once, passing mode, both weekdays, shift, week start, duration, and reason', () => {
    const fn = rosterSource.match(/const handleSubmitReschedule = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[/)?.[0] ?? '';
    expect(fn).toMatch(
      /applyWeekdayTransition\(\s*\n\s*rescheduleEmployeeId,\s*\n\s*rescheduleIsPermanent \? 'permanent' : 'temporary',\s*\n\s*rescheduleOriginalWeekdayNum,\s*\n\s*rescheduleNewWeekdayNum,\s*\n\s*rescheduleShift,\s*\n\s*rescheduleWeekStart,\s*\n\s*rescheduleIsPermanent \? 1 : rescheduleDurationWeeks,\s*\n\s*rescheduleReason\s*\n\s*\);/
    );
  });

  it('never calls assignRecurringPattern or rescheduleOffDay directly from this handler', () => {
    const fn = rosterSource.match(/const handleSubmitReschedule = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[/)?.[0] ?? '';
    expect(fn).not.toMatch(/assignRecurringPattern\(/);
    expect(fn).not.toMatch(/rescheduleOffDay\(/);
  });

  it('reports any server-confirmed bridge date back to the administrator in the success notification, for both modes', () => {
    const fn = rosterSource.match(/const handleSubmitReschedule = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[/)?.[0] ?? '';
    expect(fn).toMatch(/const bridgeNote = result\.bridgeDate/);
    expect(fn).toMatch(/kept as an additional Off day to preserve the mandatory rolling seven-day rest requirement/);
  });

  it('composes a plain-language explanation (employee, why, which working days, what to try) when the server rejects the whole transition for the rolling-rest rule', () => {
    const fn = rosterSource.match(/const handleSubmitReschedule = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[/)?.[0] ?? '';
    expect(fn).toMatch(/explainRollingRestConflict\(rawMessage, rescheduleEmployeeId, dateAssignments, patterns, shiftPatterns\)/);
    // Stage C Step 14: the explanation is now a single ready-made,
    // weekday-phrased sentence (explanation.summary) rather than the
    // handler composing raw ISO dates inline -- see rosterSchedule.ts's
    // explainRollingRestConflict and its own tests for the exact wording.
    expect(fn).toMatch(/\$\{humanized\} \$\{explanation\.summary\}/);
  });
});

describe('Temporary / Permanent Off Day: the preview shows Before/After, the bridge week/date distinctly, and flags only the specific weeks with an issue', () => {
  it('renders one preview row per week with the computed dates and resolved Before state', () => {
    expect(rosterSource).toMatch(/\{reschedulePlan\.map\(\(week\) => \(/);
    expect(rosterSource).toMatch(/week\.preview\.originalResolved/);
    expect(rosterSource).toMatch(/week\.preview\.replacementResolved/);
  });

  it('shows the employee\'s name AND employee number in the preview heading, not only an internal id', () => {
    expect(rosterSource).toMatch(/Preview for \{rescheduleSelectedEmployee\.fullName\}/);
    expect(rosterSource).toMatch(/\(\{rescheduleSelectedEmployee\.employeeNumber\}\)/);
  });

  it('a week-specific blockingReason is shown only for that week\'s own card', () => {
    expect(rosterSource).toMatch(/\{week\.preview\.blockingReason && \(/);
  });

  it('renders the bridge week distinctly, explaining that its original weekday stays Off rather than being converted', () => {
    expect(rosterSource).toMatch(/week\.isBridgeWeek \? \(/);
    expect(rosterSource).toMatch(/stays <Badge color="gold">off<\/Badge> \(not converted to \{rescheduleShift\}\)/);
  });

  it('Permanent mode\'s preview explicitly states historical dates before the effective date are never rewritten, and names the bridge date when one applies', () => {
    const permanentPreview = rosterSource.slice(rosterSource.indexOf('rescheduleIsPermanent && permanentPlan ? (\n'));
    expect(permanentPreview.slice(0, 700)).toMatch(/This never rewrites any date before/);
    expect(permanentPreview.slice(0, 1500)).toMatch(/permanentPlan\.bridgeDate && \(/);
  });

  it('shows one confirmation checkbox, gated on rescheduleBridgeDate, bound to rescheduleBridgeAcknowledged, shared by both modes', () => {
    expect(rosterSource).toMatch(/\{rescheduleBridgeDate && \(/);
    expect(rosterSource).toMatch(/checked=\{rescheduleBridgeAcknowledged\}/);
    expect(rosterSource).toMatch(/onChange=\{\(e\) => setRescheduleBridgeAcknowledged\(e\.target\.checked\)\}/);
  });
});

describe('Temporary / Permanent Off Day: all roster forms humanize RPC error messages (employee UUID -> name/number)', () => {
  it('imports humanizeRosterError from rosterService', () => {
    expect(rosterSource).toMatch(/humanizeRosterError/);
  });

  it('the Temporary/Permanent form\'s own error path passes the result through humanizeRosterError', () => {
    expect(rosterSource).toMatch(/humanizeRosterError\(rawMessage, employees\)/);
  });
});
