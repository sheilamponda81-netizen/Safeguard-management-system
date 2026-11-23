import { describe, it, expect } from 'vitest';
import {
  normalizeWorkstationKey, resolveCoveragePolicy, coverageForWorkstationKey,
  collectEmployeeIdsWithRosterEvidence, collectEmployeeIdsWithFingerprintEvidence,
  hasAnyEmployeeWithBothRosterAndFingerprintEvidence, describeDateExtent, expectedShiftTimesFor,
  buildAttendanceCalculationPreviewRows, filterAttendancePreviewRows, buildSiteAlertCasesFromRows,
  classifyAttendanceReviewSignal, combineCoverageSources, classifyStageCComparison, ServerCoverageEvidence,
} from './attendanceCalculationPreview';
import { NormalizedFingerprintEvent } from './attendanceCalculationEngine';
import { DateAssignmentRow, OffDayPatternRow, ShiftPatternRow } from './rosterSchedule';
import { EmployeeLite } from './hikcentralPersonMapping';
import { aggregateSiteAlerts } from './attendanceSiteAlerts';

function employee(overrides: Partial<EmployeeLite> = {}): EmployeeLite {
  return { id: 'emp-1', employeeNumber: 'SFG-S-001', fullName: 'Test Person', workstation: 'CHIRIMBA', status: 'Active', isDeleted: false, ...overrides };
}

function ev(timestampIso: string): NormalizedFingerprintEvent {
  return { timestampIso };
}

/** Convenience for tests that aren't exercising the mapping-gap distinction -- everyone is mapped. */
function allMapped(employees: EmployeeLite[]): Set<string> {
  return new Set(employees.map((e) => e.id));
}

describe('normalizeWorkstationKey', () => {
  it('merges whitespace/case differences', () => {
    expect(normalizeWorkstationKey('Chirimba ')).toBe(normalizeWorkstationKey('  chirimba'));
    expect(normalizeWorkstationKey('CHIRIMBA')).toBe(normalizeWorkstationKey('Chirimba'));
  });

  it('never merges genuinely distinct site names', () => {
    expect(normalizeWorkstationKey('LIMBE VACCANT HOUSE')).not.toBe(normalizeWorkstationKey('VACANT HOUSE'));
  });
});

describe('resolveCoveragePolicy -- unknown vs operator-confirmed coverage', () => {
  it('is inactive when the operator has not ticked confirmation, even with an export time and workstations entered', () => {
    const policy = resolveCoveragePolicy({
      exportTimeBlantyreLocal: '2026-10-05T14:00',
      confirmedWorkstationsRaw: 'CHIRIMBA',
      operatorConfirmed: false,
    });
    expect(policy.isActive).toBe(false);
  });

  it('is inactive when confirmed but no export time was entered', () => {
    const policy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '', confirmedWorkstationsRaw: 'CHIRIMBA', operatorConfirmed: true });
    expect(policy.isActive).toBe(false);
  });

  it('is inactive when confirmed with a valid time but no workstation named', () => {
    const policy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '2026-10-05T14:00', confirmedWorkstationsRaw: '', operatorConfirmed: true });
    expect(policy.isActive).toBe(false);
  });

  it('is active only when all three are present: ticked, valid time, and named workstation(s)', () => {
    const policy = resolveCoveragePolicy({
      exportTimeBlantyreLocal: '2026-10-05T14:00',
      confirmedWorkstationsRaw: 'CHIRIMBA, Head Office',
      operatorConfirmed: true,
    });
    expect(policy.isActive).toBe(true);
    expect(policy.confirmedWorkstationKeys.has('CHIRIMBA')).toBe(true);
    expect(policy.confirmedWorkstationKeys.has('HEAD OFFICE')).toBe(true);
  });

  it('typing an export time alone never becomes coverage for any workstation', () => {
    const policy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '2026-10-05T14:00', confirmedWorkstationsRaw: '', operatorConfirmed: false });
    expect(coverageForWorkstationKey(policy, 'CHIRIMBA').status).toBe('insufficient');
  });

  it('coverage applies only to explicitly named workstations -- an unnamed workstation (e.g. the 4 real HikCentral access points are not assumed to cover everyone) stays insufficient', () => {
    const policy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '2026-10-05T14:00', confirmedWorkstationsRaw: 'CHIRIMBA', operatorConfirmed: true });
    expect(coverageForWorkstationKey(policy, 'CHIRIMBA').status).toBe('confirmed_complete');
    expect(coverageForWorkstationKey(policy, 'SOME OTHER SITE').status).toBe('insufficient');
  });
});

describe('collectEmployeeIdsWithRosterEvidence / FingerprintEvidence / hasAnyEmployeeWithBoth', () => {
  it('finds evidence from both dated assignments and recurring patterns', () => {
    const assignments: DateAssignmentRow[] = [{ employeeId: 'a', assignmentDate: '2026-10-12', assignmentType: 'day', isActive: true }];
    const patterns: OffDayPatternRow[] = [{ employeeId: 'b', weekday: 0, effectiveFrom: '2026-10-11', isActive: true }];
    const ids = collectEmployeeIdsWithRosterEvidence(assignments, patterns);
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
  });

  it('empty-state condition: roster evidence (Oct 12-16) and fingerprint evidence (Sep 30-Oct 4) that do not overlap in employee identity -- mirrors real current STAGING data', () => {
    const rosterIds = collectEmployeeIdsWithRosterEvidence(
      [{ employeeId: 'ganizani', assignmentDate: '2026-10-12', assignmentType: 'day', isActive: true }],
      []
    );
    const fingerprintIds = collectEmployeeIdsWithFingerprintEvidence(new Map([['someone-else', [ev('2026-09-30T22:00:00.000Z')]]]));
    expect(hasAnyEmployeeWithBothRosterAndFingerprintEvidence(rosterIds, fingerprintIds)).toBe(false);
  });

  it('non-empty-state: the same employee id appears on both sides', () => {
    const rosterIds = collectEmployeeIdsWithRosterEvidence([{ employeeId: 'emp-1', assignmentDate: '2026-10-12', assignmentType: 'day', isActive: true }], []);
    const fingerprintIds = collectEmployeeIdsWithFingerprintEvidence(new Map([['emp-1', [ev('2026-10-12T04:05:00.000Z')]]]));
    expect(hasAnyEmployeeWithBothRosterAndFingerprintEvidence(rosterIds, fingerprintIds)).toBe(true);
  });

  it('an employee with zero events contributes no fingerprint evidence', () => {
    const fingerprintIds = collectEmployeeIdsWithFingerprintEvidence(new Map([['emp-1', []]]));
    expect(fingerprintIds.has('emp-1')).toBe(false);
  });

  // PRODUCTION HOTFIX (Attendance Review repair): roster evidence must
  // also come from the recurring Day/Night shift-pattern baseline, not
  // just dated assignments and off-day patterns -- see
  // attendanceCalculationPreviewService.ts/buildAttendanceCalculationPreviewRows's
  // own comments for the full defect this closes (an employee scheduled
  // ONLY via a recurring pattern was previously invisible here).
  it('finds evidence from a recurring Day/Night shift pattern alone, with no dated assignment and no off-day pattern at all', () => {
    const shiftPatterns: ShiftPatternRow[] = [{ employeeId: 'c', shiftType: 'day', effectiveFrom: '2026-10-01', isActive: true }];
    const ids = collectEmployeeIdsWithRosterEvidence([], [], shiftPatterns);
    expect(ids.has('c')).toBe(true);
  });

  it('omitting shiftPatterns entirely (back-compat default []) finds no shift-pattern-only employee', () => {
    const ids = collectEmployeeIdsWithRosterEvidence([], []);
    expect(ids.size).toBe(0);
  });
});

describe('describeDateExtent', () => {
  it('returns null for an empty list', () => {
    expect(describeDateExtent([])).toBeNull();
  });
  it('returns earliest/latest of the supplied list', () => {
    expect(describeDateExtent(['2026-10-02', '2026-09-30', '2026-10-04'])).toEqual({ earliest: '2026-09-30', latest: '2026-10-04' });
  });
});

describe('expectedShiftTimesFor', () => {
  it('returns the reused shift-window constants for day/night, and null for off/unassigned', () => {
    expect(expectedShiftTimesFor('day')).toEqual({ scheduledStart: '06:00', scheduledEnd: '18:00' });
    expect(expectedShiftTimesFor('night')).toEqual({ scheduledStart: '18:00', scheduledEnd: '06:00' });
    expect(expectedShiftTimesFor('off')).toBeNull();
    expect(expectedShiftTimesFor('unassigned')).toBeNull();
  });
});

describe('buildAttendanceCalculationPreviewRows -- roster resolution, shift dates, official status comparison', () => {
  const datedAssignments: DateAssignmentRow[] = [
    { employeeId: 'emp-1', assignmentDate: '2026-10-05', assignmentType: 'day', isActive: true },
    { employeeId: 'emp-1', assignmentDate: '2026-10-06', assignmentType: 'night', isActive: true },
    { employeeId: 'emp-1', assignmentDate: '2026-10-07', assignmentType: 'off', isActive: true },
  ];
  const noActivePolicy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '', confirmedWorkstationsRaw: '', operatorConfirmed: false });

  it('resolves the correct shift type per date and attaches expected shift times', () => {
    const rows = buildAttendanceCalculationPreviewRows({
      employees: [employee()],
      shiftDates: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: new Map(),
      coveragePolicy: noActivePolicy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: allMapped([employee()]),
    });
    expect(rows.map((r) => r.resolvedShift)).toEqual(['day', 'night', 'off', 'unassigned']);
    expect(rows[0].expectedShiftTimes).toEqual({ scheduledStart: '06:00', scheduledEnd: '18:00' });
    expect(rows[1].expectedShiftTimes).toEqual({ scheduledStart: '18:00', scheduledEnd: '06:00' });
    expect(rows[2].expectedShiftTimes).toBeNull();
    expect(rows[3].expectedShiftTimes).toBeNull();
  });

  it('a Day shift with an on-time confirmed check-in+checkout calculates Present, independent of whatever the official status says', () => {
    const events = new Map([['emp-1', [ev('2026-10-05T04:05:00.000Z'), ev('2026-10-05T14:30:00.000Z')]]]);
    const rows = buildAttendanceCalculationPreviewRows({
      employees: [employee()],
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: events,
      coveragePolicy: noActivePolicy,
      officialStatusByKey: new Map([['emp-1|2026-10-05', 'A']]), // deliberately contradicts the calculation
      employeeIdsWithActiveMapping: allMapped([employee()]),
    });
    expect(rows[0].calculation.status).toBe('present');
    expect(rows[0].officialStatus).toBe('A'); // shown read-only, never altering the calculation
  });

  it('an overnight Night shift resolves correctly using events on the following calendar date', () => {
    const events = new Map([['emp-1', [ev('2026-10-06T14:05:00.000Z'), ev('2026-10-07T03:00:00.000Z')]]]);
    const rows = buildAttendanceCalculationPreviewRows({
      employees: [employee()],
      shiftDates: ['2026-10-06'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: events,
      coveragePolicy: noActivePolicy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: allMapped([employee()]),
    });
    expect(rows[0].resolvedShift).toBe('night');
    expect(rows[0].calculation.status).toBe('present');
  });

  it('missing check-in and missing checkout, with no confirmed coverage, calculates Pending -- never a false Absent', () => {
    const rows = buildAttendanceCalculationPreviewRows({
      employees: [employee()],
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: new Map(),
      coveragePolicy: noActivePolicy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: allMapped([employee()]),
    });
    expect(rows[0].calculation.status).toBe('pending');
  });

  it('ROSTER-FIRST REGRESSION: an employee with a resolved Day shift and ZERO fingerprint events anywhere (eventsByEmployeeId has no entry for them at all, not even an empty array) still gets a row, never silently dropped', () => {
    const rows = buildAttendanceCalculationPreviewRows({
      employees: [employee()],
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: new Map(), // no entry for emp-1 at all -- the exact shape a "zero fingerprint records anywhere in range" employee has
      coveragePolicy: noActivePolicy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: allMapped([employee()]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedShift).toBe('day');
    expect(rows[0].calculation.status).toBe('pending');
  });

  it('missing checkout with an operator-confirmed workstation and sufficiently-late export time finalizes to Absent', () => {
    const policy = resolveCoveragePolicy({
      exportTimeBlantyreLocal: '2026-10-05T20:00', // 18:00 UTC, past the Day checkout window close
      confirmedWorkstationsRaw: 'CHIRIMBA',
      operatorConfirmed: true,
    });
    const events = new Map([['emp-1', [ev('2026-10-05T04:05:00.000Z')]]]);
    const rows = buildAttendanceCalculationPreviewRows({
      employees: [employee()],
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: events,
      coveragePolicy: policy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: allMapped([employee()]),
    });
    expect(rows[0].calculation.status).toBe('absent');
  });

  it('ROSTER-FIRST + CONFIRMED COVERAGE: a scheduled employee with a mapped identity, ZERO events, and genuinely confirmed coverage finalizes to Absent (the site-alert-relevant case)', () => {
    const policy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '2026-10-05T20:00', confirmedWorkstationsRaw: 'CHIRIMBA', operatorConfirmed: true });
    const rows = buildAttendanceCalculationPreviewRows({
      employees: [employee()],
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: new Map(),
      coveragePolicy: policy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: allMapped([employee()]),
    });
    expect(rows[0].calculation.status).toBe('absent');
  });

  it('an unconfirmed workstation never gets a false Absent even with a confirmed export time for OTHER workstations', () => {
    const policy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '2026-10-05T20:00', confirmedWorkstationsRaw: 'A DIFFERENT SITE', operatorConfirmed: true });
    const rows = buildAttendanceCalculationPreviewRows({
      employees: [employee({ workstation: 'CHIRIMBA' })],
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: new Map(),
      coveragePolicy: policy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: allMapped([employee({ workstation: 'CHIRIMBA' })]),
    });
    expect(rows[0].calculation.status).toBe('pending');
  });

  it('MAPPING-GAP: an employee with NO active HikCentral person mapping stays Pending even with confirmed coverage for their workstation and a sufficiently-late export time -- zero events must never be read as a confirmed absence for them', () => {
    const policy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '2026-10-05T20:00', confirmedWorkstationsRaw: 'CHIRIMBA', operatorConfirmed: true });
    const rows = buildAttendanceCalculationPreviewRows({
      employees: [employee()],
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: new Map(),
      coveragePolicy: policy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: new Set(), // nobody mapped
    });
    expect(rows[0].hasActiveMapping).toBe(false);
    expect(rows[0].calculation.status).toBe('pending');
  });

  it('early-export provisional Present/Late: an on-time check-in alone, with an early confirmed export time, credits Present provisionally', () => {
    const policy = resolveCoveragePolicy({
      exportTimeBlantyreLocal: '2026-10-05T14:00', // 12:00 UTC, well before the checkout window even opens
      confirmedWorkstationsRaw: 'CHIRIMBA',
      operatorConfirmed: true,
    });
    const events = new Map([['emp-1', [ev('2026-10-05T04:05:00.000Z')]]]);
    const rows = buildAttendanceCalculationPreviewRows({
      employees: [employee()],
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: events,
      coveragePolicy: policy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: allMapped([employee()]),
    });
    expect(rows[0].calculation.status).toBe('present');
    expect(rows[0].calculation.basis).toBe('check_in_only_provisional');
  });

  // PRODUCTION HOTFIX regression coverage: the Attendance Review repair.
  // These exercise shiftPatterns end-to-end through
  // buildAttendanceCalculationPreviewRows (not just resolveScheduleForDate's
  // own already-tested precedence in rosterSchedule.test.ts), proving the
  // integration -- never a simplified roster algorithm of this module's
  // own -- matches the server-authoritative roster_resolve_schedule()
  // precedence exactly: dated assignment > off-day pattern > recurring
  // shift pattern > unassigned.
  describe('recurring shift-pattern integration (Attendance Review repair)', () => {
    it('recurring pattern without any dated assignment: an employee scheduled ONLY via a shift pattern still gets a real Day/Night row, never Unassigned', () => {
      const shiftPatterns: ShiftPatternRow[] = [{ employeeId: 'emp-1', shiftType: 'day', effectiveFrom: '2026-10-01', isActive: true }];
      const rows = buildAttendanceCalculationPreviewRows({
        employees: [employee()],
        shiftDates: ['2026-10-05'],
        datedAssignments: [],
        patterns: [],
        shiftPatterns,
        eventsByEmployeeId: new Map(),
        coveragePolicy: noActivePolicy,
        officialStatusByKey: new Map(),
        employeeIdsWithActiveMapping: allMapped([employee()]),
      });
      expect(rows[0].resolvedShift).toBe('day');
      expect(rows[0].calculation.status).toBe('pending'); // no coverage confirmed -- never a false Absent
    });

    it('off-day suppression: a recurring shift pattern is correctly overridden by a matching recurring off-day pattern on the same weekday', () => {
      // 2026-10-05 is a Monday (weekday 1).
      const shiftPatterns: ShiftPatternRow[] = [{ employeeId: 'emp-1', shiftType: 'day', effectiveFrom: '2026-10-01', isActive: true }];
      const offPatterns: OffDayPatternRow[] = [{ employeeId: 'emp-1', weekday: 1, effectiveFrom: '2026-10-01', isActive: true }];
      const rows = buildAttendanceCalculationPreviewRows({
        employees: [employee()],
        shiftDates: ['2026-10-05'],
        datedAssignments: [],
        patterns: offPatterns,
        shiftPatterns,
        eventsByEmployeeId: new Map(),
        coveragePolicy: noActivePolicy,
        officialStatusByKey: new Map(),
        employeeIdsWithActiveMapping: allMapped([employee()]),
      });
      expect(rows[0].resolvedShift).toBe('off');
    });

    it('explicit dated override: a dated assignment wins over a contradicting recurring shift pattern for that one date only', () => {
      const shiftPatterns: ShiftPatternRow[] = [{ employeeId: 'emp-1', shiftType: 'day', effectiveFrom: '2026-10-01', isActive: true }];
      const datedOverride: DateAssignmentRow[] = [{ employeeId: 'emp-1', assignmentDate: '2026-10-05', assignmentType: 'night', isActive: true }];
      const rows = buildAttendanceCalculationPreviewRows({
        employees: [employee()],
        shiftDates: ['2026-10-04', '2026-10-05'],
        datedAssignments: datedOverride,
        patterns: [],
        shiftPatterns,
        eventsByEmployeeId: new Map(),
        coveragePolicy: noActivePolicy,
        officialStatusByKey: new Map(),
        employeeIdsWithActiveMapping: allMapped([employee()]),
      });
      expect(rows[0].resolvedShift).toBe('day'); // Oct 4: pattern applies, no override
      expect(rows[1].resolvedShift).toBe('night'); // Oct 5: dated override wins over the Day pattern
    });

    it('overnight shift resolved purely from a recurring Night pattern (no dated assignment) still matches events on the following calendar date', () => {
      const shiftPatterns: ShiftPatternRow[] = [{ employeeId: 'emp-1', shiftType: 'night', effectiveFrom: '2026-10-01', isActive: true }];
      const events = new Map([['emp-1', [ev('2026-10-06T14:05:00.000Z'), ev('2026-10-07T03:00:00.000Z')]]]);
      const rows = buildAttendanceCalculationPreviewRows({
        employees: [employee()],
        shiftDates: ['2026-10-06'],
        datedAssignments: [],
        patterns: [],
        shiftPatterns,
        eventsByEmployeeId: events,
        coveragePolicy: noActivePolicy,
        officialStatusByKey: new Map(),
        employeeIdsWithActiveMapping: allMapped([employee()]),
      });
      expect(rows[0].resolvedShift).toBe('night');
      expect(rows[0].calculation.status).toBe('present');
    });

    it('pattern effective-date boundary: a shift pattern has no effect before its own effectiveFrom date', () => {
      const shiftPatterns: ShiftPatternRow[] = [{ employeeId: 'emp-1', shiftType: 'day', effectiveFrom: '2026-10-10', isActive: true }];
      const rows = buildAttendanceCalculationPreviewRows({
        employees: [employee()],
        shiftDates: ['2026-10-09', '2026-10-10'],
        datedAssignments: [],
        patterns: [],
        shiftPatterns,
        eventsByEmployeeId: new Map(),
        coveragePolicy: noActivePolicy,
        officialStatusByKey: new Map(),
        employeeIdsWithActiveMapping: allMapped([employee()]),
      });
      expect(rows[0].resolvedShift).toBe('unassigned'); // before effectiveFrom: no fictional schedule
      expect(rows[1].resolvedShift).toBe('day'); // on effectiveFrom: applies
    });

    it('pattern effective-date boundary: a later superseding pattern row wins over an earlier one for a date on/after its own effectiveFrom, never an earlier-vs-later ordering mistake', () => {
      const shiftPatterns: ShiftPatternRow[] = [
        { employeeId: 'emp-1', shiftType: 'day', effectiveFrom: '2026-09-01', isActive: true },
        { employeeId: 'emp-1', shiftType: 'night', effectiveFrom: '2026-10-05', isActive: true },
      ];
      const rows = buildAttendanceCalculationPreviewRows({
        employees: [employee()],
        shiftDates: ['2026-10-04', '2026-10-05'],
        datedAssignments: [],
        patterns: [],
        shiftPatterns,
        eventsByEmployeeId: new Map(),
        coveragePolicy: noActivePolicy,
        officialStatusByKey: new Map(),
        employeeIdsWithActiveMapping: allMapped([employee()]),
      });
      expect(rows[0].resolvedShift).toBe('day'); // still under the Sep 1 pattern
      expect(rows[1].resolvedShift).toBe('night'); // the Oct 5 pattern now takes over
    });

    it('overlapping schedule evidence: a dated assignment, an off-day pattern, and a shift pattern can all exist for the same employee without ever producing more than one resolved value per date (no duplicate-shift double counting)', () => {
      const datedAssignments: DateAssignmentRow[] = [{ employeeId: 'emp-1', assignmentDate: '2026-10-07', assignmentType: 'day', isActive: true }];
      const offPatterns: OffDayPatternRow[] = [{ employeeId: 'emp-1', weekday: 1, effectiveFrom: '2026-10-01', isActive: true }]; // Monday
      const shiftPatterns: ShiftPatternRow[] = [{ employeeId: 'emp-1', shiftType: 'night', effectiveFrom: '2026-09-01', isActive: true }];
      const rows = buildAttendanceCalculationPreviewRows({
        employees: [employee()],
        shiftDates: ['2026-10-05', '2026-10-06', '2026-10-07'], // Mon, Tue, Wed
        datedAssignments,
        patterns: offPatterns,
        shiftPatterns,
        eventsByEmployeeId: new Map(),
        coveragePolicy: noActivePolicy,
        officialStatusByKey: new Map(),
        employeeIdsWithActiveMapping: allMapped([employee()]),
      });
      expect(rows).toHaveLength(3); // exactly one row per date -- never duplicated
      expect(rows[0].resolvedShift).toBe('off'); // Monday: off-day pattern wins over the Night shift pattern
      expect(rows[1].resolvedShift).toBe('night'); // Tuesday: falls through to the recurring Night pattern
      expect(rows[2].resolvedShift).toBe('day'); // Wednesday: the explicit dated override wins over everything
    });

    it('missing schedule: an employee with no dated assignment, no off-day pattern, and no shift pattern at all resolves Unassigned -- never a fictional Day/Night schedule', () => {
      const rows = buildAttendanceCalculationPreviewRows({
        employees: [employee()],
        shiftDates: ['2026-10-05'],
        datedAssignments: [],
        patterns: [],
        shiftPatterns: [],
        eventsByEmployeeId: new Map(),
        coveragePolicy: noActivePolicy,
        officialStatusByKey: new Map(),
        employeeIdsWithActiveMapping: allMapped([employee()]),
      });
      expect(rows[0].resolvedShift).toBe('unassigned');
      expect(rows[0].calculation.status).toBe('unassigned'); // never a fabricated Day/Night/Absent result
    });

    it('an INACTIVE shift pattern (is_active: false) is never consulted, even when it would otherwise be the most recent effectiveFrom', () => {
      const shiftPatterns: ShiftPatternRow[] = [
        { employeeId: 'emp-1', shiftType: 'day', effectiveFrom: '2026-09-01', isActive: true },
        { employeeId: 'emp-1', shiftType: 'night', effectiveFrom: '2026-10-01', isActive: false },
      ];
      const rows = buildAttendanceCalculationPreviewRows({
        employees: [employee()],
        shiftDates: ['2026-10-05'],
        datedAssignments: [],
        patterns: [],
        shiftPatterns,
        eventsByEmployeeId: new Map(),
        coveragePolicy: noActivePolicy,
        officialStatusByKey: new Map(),
        employeeIdsWithActiveMapping: allMapped([employee()]),
      });
      expect(rows[0].resolvedShift).toBe('day'); // the inactive Night row is skipped; Sep 1 Day pattern still applies
    });
  });
});

describe('filterAttendancePreviewRows', () => {
  const datedAssignments: DateAssignmentRow[] = [
    { employeeId: 'emp-1', assignmentDate: '2026-10-05', assignmentType: 'day', isActive: true },
    { employeeId: 'emp-2', assignmentDate: '2026-10-05', assignmentType: 'night', isActive: true },
  ];
  const noActivePolicy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '', confirmedWorkstationsRaw: '', operatorConfirmed: false });
  const filterTestEmployees = [employee({ id: 'emp-1', workstation: 'SITE A' }), employee({ id: 'emp-2', employeeNumber: 'SFG-S-002', workstation: 'SITE B' })];
  const rows = buildAttendanceCalculationPreviewRows({
    employees: filterTestEmployees,
    shiftDates: ['2026-10-05'],
    datedAssignments,
    patterns: [],
    eventsByEmployeeId: new Map(),
    coveragePolicy: noActivePolicy,
    officialStatusByKey: new Map(),
    employeeIdsWithActiveMapping: allMapped(filterTestEmployees),
  });

  it('filters by site, shift, result, and employee search independently', () => {
    expect(filterAttendancePreviewRows(rows, { siteFilter: 'SITE A' })).toHaveLength(1);
    expect(filterAttendancePreviewRows(rows, { shiftFilter: 'night' })).toHaveLength(1);
    expect(filterAttendancePreviewRows(rows, { resultFilter: 'pending' })).toHaveLength(2);
    expect(filterAttendancePreviewRows(rows, { employeeSearch: 'SFG-S-002' })).toHaveLength(1);
  });
});

describe('buildSiteAlertCasesFromRows -- site alert wiring (reuses Stage A aggregateSiteAlerts unmodified)', () => {
  function absentRows(count: number, workstation: string): ReturnType<typeof buildAttendanceCalculationPreviewRows> {
    const employees = Array.from({ length: count }, (_, i) => employee({ id: `e${i}`, workstation }));
    const datedAssignments: DateAssignmentRow[] = employees.map((e) => ({ employeeId: e.id, assignmentDate: '2026-10-05', assignmentType: 'day', isActive: true }));
    const policy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '2026-10-05T20:00', confirmedWorkstationsRaw: workstation, operatorConfirmed: true });
    return buildAttendanceCalculationPreviewRows({
      employees,
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: new Map(),
      coveragePolicy: policy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: allMapped(employees),
    });
  }

  it('exactly 5 distinct confirmed-absent employees at the same workstation/shift/date triggers one alert', () => {
    const rows = absentRows(5, 'SITE A');
    const { cases } = buildSiteAlertCasesFromRows(rows);
    const alerts = aggregateSiteAlerts(cases);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].totalCount).toBe(5);
  });

  it('exactly 4 distinct confirmed-absent employees does not trigger an alert', () => {
    const rows = absentRows(4, 'SITE A');
    const { cases } = buildSiteAlertCasesFromRows(rows);
    expect(aggregateSiteAlerts(cases)).toHaveLength(0);
  });

  it('conservative workstation normalization merges case/whitespace variants into one alert group', () => {
    const rowsA = absentRows(3, 'Chirimba ');
    const rowsB = absentRows(2, '  CHIRIMBA').map((r, i) => ({ ...r, employeeId: `other-${i}` }));
    const { cases } = buildSiteAlertCasesFromRows([...rowsA, ...rowsB]);
    const alerts = aggregateSiteAlerts(cases);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].totalCount).toBe(5);
  });

  it('never merges genuinely distinct sites even if both happen to reach the threshold', () => {
    const rows = [...absentRows(5, 'LIMBE VACCANT HOUSE'), ...absentRows(5, 'VACANT HOUSE').map((r, i) => ({ ...r, employeeId: `v-${i}` }))];
    const { cases } = buildSiteAlertCasesFromRows(rows);
    const alerts = aggregateSiteAlerts(cases);
    expect(alerts).toHaveLength(2);
  });

  it('Pending results never contribute to a site alert (insufficient coverage case)', () => {
    const employees = Array.from({ length: 6 }, (_, i) => employee({ id: `p${i}`, workstation: 'SITE A' }));
    const datedAssignments: DateAssignmentRow[] = employees.map((e) => ({ employeeId: e.id, assignmentDate: '2026-10-05', assignmentType: 'day', isActive: true }));
    const noActivePolicy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '', confirmedWorkstationsRaw: '', operatorConfirmed: false });
    const rows = buildAttendanceCalculationPreviewRows({
      employees,
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: new Map(),
      coveragePolicy: noActivePolicy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: allMapped(employees),
    });
    expect(rows.every((r) => r.calculation.status === 'pending')).toBe(true);
    const { cases } = buildSiteAlertCasesFromRows(rows);
    expect(aggregateSiteAlerts(cases)).toHaveLength(0);
  });

  it('Off/Unassigned rows never participate in site alerts', () => {
    const rows = [
      { ...absentRows(1, 'SITE A')[0], resolvedShift: 'off' as const },
      { ...absentRows(1, 'SITE A')[0], resolvedShift: 'unassigned' as const },
    ];
    const { cases } = buildSiteAlertCasesFromRows(rows);
    expect(cases).toHaveLength(0);
  });

  it('ROSTER-FIRST SITE ALERT: 5 scheduled employees with zero successful scans and genuinely confirmed coverage DO trigger a "no fingerprint records" alert', () => {
    const employees = Array.from({ length: 5 }, (_, i) => employee({ id: `z${i}`, workstation: 'SITE A' }));
    const datedAssignments: DateAssignmentRow[] = employees.map((e) => ({ employeeId: e.id, assignmentDate: '2026-10-05', assignmentType: 'day', isActive: true }));
    const policy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '2026-10-05T20:00', confirmedWorkstationsRaw: 'SITE A', operatorConfirmed: true });
    const rows = buildAttendanceCalculationPreviewRows({
      employees,
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: new Map(), // zero successful scans for all 5 -- no entries at all, not even empty arrays
      coveragePolicy: policy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: allMapped(employees),
    });
    expect(rows.every((r) => r.calculation.status === 'absent')).toBe(true);
    const { cases } = buildSiteAlertCasesFromRows(rows);
    const alerts = aggregateSiteAlerts(cases);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].totalCount).toBe(5);
    expect(alerts[0].breakdown.noFingerprintRecords).toBe(5);
  });

  it('MAPPING-GAP SITE ALERT: the same 5 scheduled employees with zero scans but NO active person mapping never trigger an alert -- a mapping gap is not a confirmed absence', () => {
    const employees = Array.from({ length: 5 }, (_, i) => employee({ id: `u${i}`, workstation: 'SITE A' }));
    const datedAssignments: DateAssignmentRow[] = employees.map((e) => ({ employeeId: e.id, assignmentDate: '2026-10-05', assignmentType: 'day', isActive: true }));
    const policy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '2026-10-05T20:00', confirmedWorkstationsRaw: 'SITE A', operatorConfirmed: true });
    const rows = buildAttendanceCalculationPreviewRows({
      employees,
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: new Map(),
      coveragePolicy: policy,
      officialStatusByKey: new Map(),
      employeeIdsWithActiveMapping: new Set(), // nobody mapped
    });
    expect(rows.every((r) => r.calculation.status === 'pending')).toBe(true);
    const { cases } = buildSiteAlertCasesFromRows(rows);
    expect(aggregateSiteAlerts(cases)).toHaveLength(0);
  });
});

// Attendance Review usability redesign: "Needs Review" filter semantics.
// See classifyAttendanceReviewSignal's own header comment for the exact
// three-way distinction this pins -- 'uncertain' (evidence not yet
// confirmed one way or the other) must never collapse into
// 'contradiction' (a genuine, confirmed disagreement).
describe('classifyAttendanceReviewSignal', () => {
  const datedAssignments: DateAssignmentRow[] = [
    { employeeId: 'emp-1', assignmentDate: '2026-10-05', assignmentType: 'day', isActive: true },
  ];
  const noActivePolicy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '', confirmedWorkstationsRaw: '', operatorConfirmed: false });

  function rowFor(params: { events?: Map<string, NormalizedFingerprintEvent[]>; officialStatus?: string; coveragePolicy?: ReturnType<typeof resolveCoveragePolicy> }) {
    const rows = buildAttendanceCalculationPreviewRows({
      employees: [employee()],
      shiftDates: ['2026-10-05'],
      datedAssignments,
      patterns: [],
      eventsByEmployeeId: params.events ?? new Map(),
      coveragePolicy: params.coveragePolicy ?? noActivePolicy,
      officialStatusByKey: params.officialStatus ? new Map([['emp-1|2026-10-05', params.officialStatus]]) : new Map(),
      employeeIdsWithActiveMapping: allMapped([employee()]),
    });
    return rows[0];
  }

  it('is "none" when there is no official status at all to compare against', () => {
    const row = rowFor({});
    expect(row.officialStatus).toBeNull();
    expect(classifyAttendanceReviewSignal(row)).toBe('none');
  });

  it('is "none" for an official status with no calculated-status analog (Leave/Sick Leave/Not marked)', () => {
    expect(classifyAttendanceReviewSignal(rowFor({ officialStatus: 'LV' }))).toBe('none');
    expect(classifyAttendanceReviewSignal(rowFor({ officialStatus: 'SL' }))).toBe('none');
    expect(classifyAttendanceReviewSignal(rowFor({ officialStatus: '-' }))).toBe('none');
  });

  it('is "none" when a CONFIRMED calculated result genuinely agrees with the official status', () => {
    const events = new Map([['emp-1', [ev('2026-10-05T04:05:00.000Z'), ev('2026-10-05T14:30:00.000Z')]]]);
    const row = rowFor({ events, officialStatus: 'P' });
    expect(row.calculation.status).toBe('present');
    expect(row.calculation.basis).toBe('confirmed');
    expect(classifyAttendanceReviewSignal(row)).toBe('none');
  });

  it('is "contradiction" when a CONFIRMED calculated result genuinely disagrees with the official status', () => {
    const events = new Map([['emp-1', [ev('2026-10-05T04:05:00.000Z'), ev('2026-10-05T14:30:00.000Z')]]]);
    const row = rowFor({ events, officialStatus: 'A' }); // official says Absent, calculation confirms Present
    expect(row.calculation.status).toBe('present');
    expect(row.calculation.basis).toBe('confirmed');
    expect(classifyAttendanceReviewSignal(row)).toBe('contradiction');
  });

  it('is "uncertain" -- NEVER "contradiction" -- when the calculation is still Pending (incomplete evidence), even though an official status already exists', () => {
    const row = rowFor({ officialStatus: 'P' }); // no events at all -> Pending
    expect(row.calculation.status).toBe('pending');
    expect(classifyAttendanceReviewSignal(row)).toBe('uncertain');
  });

  it('is "uncertain" -- NEVER "contradiction" -- when the calculation is only a provisional single-scan credit, even though it currently agrees with the official status', () => {
    const policy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '2026-10-05T14:00', confirmedWorkstationsRaw: 'CHIRIMBA', operatorConfirmed: true });
    const events = new Map([['emp-1', [ev('2026-10-05T04:05:00.000Z')]]]); // check-in only, no checkout yet
    const row = rowFor({ events, officialStatus: 'P', coveragePolicy: policy });
    expect(row.calculation.status).toBe('present');
    expect(row.calculation.basis).toBe('check_in_only_provisional');
    expect(classifyAttendanceReviewSignal(row)).toBe('uncertain');
  });
});

// Attendance coverage-consistency improvement.
describe('combineCoverageSources', () => {
  function evidence(overrides: Partial<ServerCoverageEvidence> = {}): ServerCoverageEvidence {
    return {
      resolvedShift: 'day', coverageProvenance: 'evidence_backed', sufficientEvidence: true,
      officialEngineTrustsThis: true, confirmedThroughIso: '2026-10-05T18:00:00.000Z', reason: 'test', ...overrides,
    };
  }

  it('prefers an ACTIVE operator-typed confirmation over server evidence, even when server evidence also exists', () => {
    const operator = { status: 'confirmed_complete' as const, verifiedThroughIso: '2026-10-05T20:00:00.000Z' };
    const result = combineCoverageSources(operator, evidence({ confirmedThroughIso: '2026-10-05T18:00:00.000Z' }));
    expect(result).toEqual(operator);
  });

  it('falls back to sufficient server evidence when the operator has not confirmed anything this session', () => {
    const result = combineCoverageSources({ status: 'insufficient' }, evidence());
    expect(result).toEqual({ status: 'confirmed_complete', verifiedThroughIso: '2026-10-05T18:00:00.000Z' });
  });

  it('stays insufficient when server evidence says sufficientEvidence is false, even with a confirmedThroughIso present (e.g. unsupported_historical)', () => {
    const result = combineCoverageSources({ status: 'insufficient' }, evidence({ sufficientEvidence: false, coverageProvenance: 'unsupported_historical' }));
    expect(result).toEqual({ status: 'insufficient' });
  });

  it('stays insufficient when there is no server evidence at all for this employee-day', () => {
    const result = combineCoverageSources({ status: 'insufficient' }, undefined);
    expect(result).toEqual({ status: 'insufficient' });
  });

  it('stays insufficient when server evidence is sufficient but somehow has no confirmedThroughIso (defensive -- never a confirmed_complete with no verified-through time)', () => {
    const result = combineCoverageSources({ status: 'insufficient' }, evidence({ confirmedThroughIso: null }));
    expect(result).toEqual({ status: 'insufficient' });
  });
});

describe('classifyStageCComparison', () => {
  it('is "match" when both sides agree, regardless of coverage provenance', () => {
    expect(classifyStageCComparison({ serverStatus: 'present', jsStatus: 'present', jsCoverageProvenance: 'evidence_backed' })).toBe('match');
  });

  it('is "unavailable_incomplete_comparison" when either side has no result at all', () => {
    expect(classifyStageCComparison({ serverStatus: null, jsStatus: 'present', jsCoverageProvenance: null })).toBe('unavailable_incomplete_comparison');
    expect(classifyStageCComparison({ serverStatus: 'present', jsStatus: null, jsCoverageProvenance: null })).toBe('unavailable_incomplete_comparison');
  });

  it('is "untrusted_historical_coverage" -- never a calculation-engine defect -- when the JS side\'s own coverage is an unsupported historical declaration', () => {
    expect(classifyStageCComparison({ serverStatus: 'absent', jsStatus: 'pending', jsCoverageProvenance: 'unsupported_historical' })).toBe('untrusted_historical_coverage');
  });

  it('is "different_coverage_inputs" when the JS side never reached sufficient coverage at all (no confirmation, no terminal, no mapping)', () => {
    expect(classifyStageCComparison({ serverStatus: 'absent', jsStatus: 'pending', jsCoverageProvenance: 'no_coverage' })).toBe('different_coverage_inputs');
    expect(classifyStageCComparison({ serverStatus: 'absent', jsStatus: 'pending', jsCoverageProvenance: 'no_assigned_terminal' })).toBe('different_coverage_inputs');
    expect(classifyStageCComparison({ serverStatus: 'absent', jsStatus: 'pending', jsCoverageProvenance: 'no_active_mapping' })).toBe('different_coverage_inputs');
    expect(classifyStageCComparison({ serverStatus: 'absent', jsStatus: 'pending', jsCoverageProvenance: null })).toBe('different_coverage_inputs');
  });

  it('is "genuine_calculation_disagreement" -- the one outcome worth investigating -- when they disagree despite the JS side ALSO having sufficient, trustworthy coverage', () => {
    expect(classifyStageCComparison({ serverStatus: 'absent', jsStatus: 'present', jsCoverageProvenance: 'evidence_backed' })).toBe('genuine_calculation_disagreement');
    expect(classifyStageCComparison({ serverStatus: 'absent', jsStatus: 'present', jsCoverageProvenance: 'independently_verified_override' })).toBe('genuine_calculation_disagreement');
  });

  it('never labels every difference a defect: an unsupported-historical mismatch and a genuine disagreement are classified differently even though both are plain status mismatches', () => {
    const untrusted = classifyStageCComparison({ serverStatus: 'absent', jsStatus: 'pending', jsCoverageProvenance: 'unsupported_historical' });
    const genuine = classifyStageCComparison({ serverStatus: 'absent', jsStatus: 'present', jsCoverageProvenance: 'evidence_backed' });
    expect(untrusted).not.toBe(genuine);
    expect(untrusted).not.toBe('genuine_calculation_disagreement');
  });
});
