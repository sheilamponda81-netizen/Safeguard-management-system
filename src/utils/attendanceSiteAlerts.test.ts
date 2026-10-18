import { describe, it, expect } from 'vitest';
import { aggregateSiteAlerts, SiteAlertCase, SITE_ALERT_THRESHOLD } from './attendanceSiteAlerts';
import { AttendanceCalculationResult } from './attendanceCalculationEngine';

function absentNoRecords(): AttendanceCalculationResult {
  return { status: 'absent', checkInIso: null, checkOutIso: null, reason: 'x', basis: 'not_applicable' };
}
function absentCheckInOnly(): AttendanceCalculationResult {
  return { status: 'absent', checkInIso: '2026-10-05T04:05:00.000Z', checkOutIso: null, reason: 'x', basis: 'not_applicable' };
}
function absentCheckoutOnly(): AttendanceCalculationResult {
  return { status: 'absent', checkInIso: null, checkOutIso: '2026-10-05T14:30:00.000Z', reason: 'x', basis: 'not_applicable' };
}
function pending(): AttendanceCalculationResult {
  return { status: 'pending', checkInIso: null, checkOutIso: null, reason: 'x', basis: 'not_applicable' };
}
function present(): AttendanceCalculationResult {
  return { status: 'present', checkInIso: '2026-10-05T04:05:00.000Z', checkOutIso: '2026-10-05T14:30:00.000Z', reason: 'x', basis: 'confirmed' };
}
function off(): AttendanceCalculationResult {
  return { status: 'off', checkInIso: null, checkOutIso: null, reason: 'x', basis: 'not_applicable' };
}
function unassigned(): AttendanceCalculationResult {
  return { status: 'unassigned', checkInIso: null, checkOutIso: null, reason: 'x', basis: 'not_applicable' };
}

function caseFor(employeeId: string, result: AttendanceCalculationResult, overrides: Partial<SiteAlertCase> = {}): SiteAlertCase {
  return { employeeId, workstation: 'HEAD OFFICE', shift: 'day', shiftDate: '2026-10-05', result, ...overrides };
}

function manyCases(count: number, resultFn: () => AttendanceCalculationResult): SiteAlertCase[] {
  return Array.from({ length: count }, (_, i) => caseFor(`emp-${i}`, resultFn()));
}

describe('aggregateSiteAlerts -- threshold boundary', () => {
  it('exactly 4 distinct absent employees -> no alert', () => {
    expect(SITE_ALERT_THRESHOLD).toBe(5);
    const alerts = aggregateSiteAlerts(manyCases(4, absentNoRecords));
    expect(alerts).toHaveLength(0);
  });

  it('exactly 5 distinct absent employees -> one alert', () => {
    const alerts = aggregateSiteAlerts(manyCases(5, absentNoRecords));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].totalCount).toBe(5);
  });

  it('more than 5 distinct absent employees -> one alert with the full count', () => {
    const alerts = aggregateSiteAlerts(manyCases(8, absentNoRecords));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].totalCount).toBe(8);
  });

  it('duplicate rows for the same employee are not double counted', () => {
    const cases = [...manyCases(5, absentNoRecords), caseFor('emp-0', absentNoRecords())];
    const alerts = aggregateSiteAlerts(cases);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].totalCount).toBe(5);
  });
});

describe('aggregateSiteAlerts -- reason breakdowns', () => {
  it('category A: all no-fingerprint-records', () => {
    const alerts = aggregateSiteAlerts(manyCases(5, absentNoRecords));
    expect(alerts[0].breakdown).toEqual({ noFingerprintRecords: 5, checkInOnly: 0, checkoutOnly: 0 });
    expect(alerts[0].message).toContain('no successful fingerprint records');
    expect(alerts[0].message).not.toContain('attempt');
  });

  it('category B: all check-in only', () => {
    const alerts = aggregateSiteAlerts(manyCases(6, absentCheckInOnly));
    expect(alerts[0].breakdown).toEqual({ noFingerprintRecords: 0, checkInOnly: 6, checkoutOnly: 0 });
    expect(alerts[0].message).toContain('check-in but no valid checkout');
  });

  it('category C: all checkout only', () => {
    const alerts = aggregateSiteAlerts(manyCases(5, absentCheckoutOnly));
    expect(alerts[0].breakdown).toEqual({ noFingerprintRecords: 0, checkInOnly: 0, checkoutOnly: 5 });
    expect(alerts[0].message).toContain('checkout but no valid check-in');
  });

  it('category E: mixed causes lists each non-zero category with its count', () => {
    const cases = [
      ...Array.from({ length: 2 }, (_, i) => caseFor(`a-${i}`, absentNoRecords())),
      ...Array.from({ length: 2 }, (_, i) => caseFor(`b-${i}`, absentCheckInOnly())),
      ...Array.from({ length: 1 }, (_, i) => caseFor(`c-${i}`, absentCheckoutOnly())),
    ];
    const alerts = aggregateSiteAlerts(cases);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].breakdown).toEqual({ noFingerprintRecords: 2, checkInOnly: 2, checkoutOnly: 1 });
    expect(alerts[0].message).toContain('mixed causes');
    expect(alerts[0].message).toContain('2 with no successful fingerprint records');
    expect(alerts[0].message).toContain('2 with check-in only');
    expect(alerts[0].message).toContain('1 with checkout only');
  });
});

describe('aggregateSiteAlerts -- exclusions', () => {
  it('Pending results never count toward the threshold and never alert on their own', () => {
    const alerts = aggregateSiteAlerts(manyCases(8, pending));
    expect(alerts).toHaveLength(0);
  });

  it('Present, Off, Unassigned results never count toward the threshold', () => {
    const cases = [...manyCases(3, present), ...manyCases(3, off), ...manyCases(3, unassigned)];
    const alerts = aggregateSiteAlerts(cases);
    expect(alerts).toHaveLength(0);
  });

  it('Pending/insufficient-coverage cases mixed with fewer than 5 confirmed absences still do not alert', () => {
    const cases = [...manyCases(3, absentNoRecords), ...manyCases(10, pending)];
    const alerts = aggregateSiteAlerts(cases);
    expect(alerts).toHaveLength(0);
  });

  it('5+ confirmed absences still alert even when many other employees in the same group are Pending (an alert does not require full group resolution)', () => {
    const cases = [...manyCases(5, absentNoRecords), ...manyCases(20, pending)];
    const alerts = aggregateSiteAlerts(cases);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].totalCount).toBe(5);
  });
});

describe('aggregateSiteAlerts -- grouping', () => {
  it('groups by workstation, shift, and shift-start date independently', () => {
    const cases = [
      ...manyCases(5, absentNoRecords).map((c) => ({ ...c, workstation: 'SITE A' })),
      ...manyCases(5, absentNoRecords).map((c) => ({ ...c, workstation: 'SITE B' })),
      ...manyCases(4, absentNoRecords).map((c) => ({ ...c, workstation: 'SITE A', shift: 'night' as const })),
    ];
    const alerts = aggregateSiteAlerts(cases);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.workstation).sort()).toEqual(['SITE A', 'SITE B']);
  });

  it('does not create an alert when the data is incomplete for every case in the group (all Pending)', () => {
    const alerts = aggregateSiteAlerts(manyCases(10, pending).map((c) => ({ ...c, workstation: 'SITE C' })));
    expect(alerts.find((a) => a.workstation === 'SITE C')).toBeUndefined();
  });

  it('a confirmed absent result never blocks an alert, and an alert never blocks the underlying Absent determination of each case (independent concerns)', () => {
    const cases = manyCases(5, absentNoRecords);
    const alerts = aggregateSiteAlerts(cases);
    expect(alerts).toHaveLength(1);
    // Each underlying case result is untouched by aggregation.
    cases.forEach((c) => expect(c.result.status).toBe('absent'));
  });
});
