import { describe, it, expect } from 'vitest';
import {
  normalizeWorkstationKey, resolveCoveragePolicy, coverageForWorkstationKey,
  collectEmployeeIdsWithRosterEvidence, collectEmployeeIdsWithFingerprintEvidence,
  hasAnyEmployeeWithBothRosterAndFingerprintEvidence, describeDateExtent, expectedShiftTimesFor,
  buildAttendanceCalculationPreviewRows, filterAttendancePreviewRows, buildSiteAlertCasesFromRows,
} from './attendanceCalculationPreview';
import { NormalizedFingerprintEvent } from './attendanceCalculationEngine';
import { DateAssignmentRow, OffDayPatternRow } from './rosterSchedule';
import { EmployeeLite } from './hikcentralPersonMapping';
import { aggregateSiteAlerts } from './attendanceSiteAlerts';

function employee(overrides: Partial<EmployeeLite> = {}): EmployeeLite {
  return { id: 'emp-1', employeeNumber: 'SFG-S-001', fullName: 'Test Person', workstation: 'CHIRIMBA', status: 'Active', isDeleted: false, ...overrides };
}

function ev(timestampIso: string): NormalizedFingerprintEvent {
  return { timestampIso };
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
    });
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
    });
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
    });
    expect(rows[0].calculation.status).toBe('present');
    expect(rows[0].calculation.basis).toBe('check_in_only_provisional');
  });
});

describe('filterAttendancePreviewRows', () => {
  const datedAssignments: DateAssignmentRow[] = [
    { employeeId: 'emp-1', assignmentDate: '2026-10-05', assignmentType: 'day', isActive: true },
    { employeeId: 'emp-2', assignmentDate: '2026-10-05', assignmentType: 'night', isActive: true },
  ];
  const noActivePolicy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '', confirmedWorkstationsRaw: '', operatorConfirmed: false });
  const rows = buildAttendanceCalculationPreviewRows({
    employees: [employee({ id: 'emp-1', workstation: 'SITE A' }), employee({ id: 'emp-2', employeeNumber: 'SFG-S-002', workstation: 'SITE B' })],
    shiftDates: ['2026-10-05'],
    datedAssignments,
    patterns: [],
    eventsByEmployeeId: new Map(),
    coveragePolicy: noActivePolicy,
    officialStatusByKey: new Map(),
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
});
