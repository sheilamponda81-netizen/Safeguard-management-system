import { describe, it, expect } from 'vitest';
import { calculateAttendanceStatus, getShiftWindows, AttendanceCalculationInput, NormalizedFingerprintEvent, ShiftCoverage } from './attendanceCalculationEngine';

const DAY_DATE = '2026-10-05';
const NIGHT_DATE = '2026-10-05'; // the Night shift's starting date; its checkout window falls on 2026-10-06

function ev(timestampIso: string): NormalizedFingerprintEvent {
  return { timestampIso };
}

function insufficientCoverage(): ShiftCoverage {
  return { status: 'insufficient' };
}

function coverageThrough(verifiedThroughIso: string): ShiftCoverage {
  return { status: 'confirmed_complete', verifiedThroughIso };
}

function dayInput(overrides: Partial<AttendanceCalculationInput> = {}): AttendanceCalculationInput {
  return { shiftDate: DAY_DATE, resolvedShift: 'day', events: [], coverage: insufficientCoverage(), ...overrides };
}

function nightInput(overrides: Partial<AttendanceCalculationInput> = {}): AttendanceCalculationInput {
  return { shiftDate: NIGHT_DATE, resolvedShift: 'night', events: [], coverage: insufficientCoverage(), ...overrides };
}

describe('calculateAttendanceStatus -- Off and Unassigned', () => {
  it('Off day is never Absent, regardless of events or coverage', () => {
    const result = calculateAttendanceStatus({ shiftDate: DAY_DATE, resolvedShift: 'off', events: [], coverage: insufficientCoverage() });
    expect(result.status).toBe('off');
  });

  it('Unassigned day is never Absent, regardless of events or coverage', () => {
    const result = calculateAttendanceStatus({ shiftDate: DAY_DATE, resolvedShift: 'unassigned', events: [], coverage: coverageThrough('2026-10-06T00:00:00.000Z') });
    expect(result.status).toBe('unassigned');
  });
});

describe('calculateAttendanceStatus -- Day shift grace boundary (exact 15 minutes)', () => {
  it('check-in exactly at 06:15:00 Blantyre is Present (grace boundary is inclusive)', () => {
    const windows = getShiftWindows('day', DAY_DATE);
    expect(windows.lateAfterIso).toBe('2026-10-05T04:15:00.000Z'); // 06:15 Blantyre = 04:15 UTC
    const input = dayInput({
      events: [ev('2026-10-05T04:15:00.000Z'), ev('2026-10-05T14:00:00.000Z')], // checkout within 16:00-20:00 Blantyre = 14:00-18:00 UTC
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('present');
  });

  it('check-in one second after 06:15:00 Blantyre is Late', () => {
    const input = dayInput({
      events: [ev('2026-10-05T04:15:01.000Z'), ev('2026-10-05T14:00:00.000Z')],
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('late');
  });

  it('check-in well before grace (06:05) is Present', () => {
    const input = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z'), ev('2026-10-05T14:00:00.000Z')],
    });
    expect(calculateAttendanceStatus(input).status).toBe('present');
  });
});

describe('calculateAttendanceStatus -- earliest check-in wins, repeated scans do not penalize', () => {
  it('uses the earliest successful check-in even when later repeated scans exist', () => {
    const input = dayInput({
      events: [
        ev('2026-10-05T04:30:00.000Z'), // 06:30 Blantyre, would be Late if used
        ev('2026-10-05T04:05:00.000Z'), // 06:05 Blantyre -- earliest, on time
        ev('2026-10-05T04:40:00.000Z'), // another later repeat
        ev('2026-10-05T14:00:00.000Z'), // checkout
      ],
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('present');
    expect(result.checkInIso).toBe('2026-10-05T04:05:00.000Z');
  });
});

describe('calculateAttendanceStatus -- first valid checkout wins', () => {
  it('uses the earliest scan within the checkout window even when a later repeat exists', () => {
    const input = dayInput({
      events: [
        ev('2026-10-05T04:05:00.000Z'), // check-in
        ev('2026-10-05T14:30:00.000Z'), // first checkout scan, 16:30 Blantyre
        ev('2026-10-05T17:00:00.000Z'), // a later repeat tap, 19:00 Blantyre
      ],
    });
    const result = calculateAttendanceStatus(input);
    expect(result.checkOutIso).toBe('2026-10-05T14:30:00.000Z');
  });
});

describe('calculateAttendanceStatus -- missing check-in / missing checkout', () => {
  it('valid check-in, no checkout, checkout window confirmed closed -> Absent', () => {
    const input = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z')],
      coverage: coverageThrough('2026-10-05T18:00:00.000Z'), // past 20:00 Blantyre checkout window end (18:00 UTC)
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('absent');
    expect(result.checkInIso).not.toBeNull();
    expect(result.checkOutIso).toBeNull();
  });

  it('valid checkout, no check-in, coverage confirmed -> Absent', () => {
    const input = dayInput({
      events: [ev('2026-10-05T14:30:00.000Z')], // only a checkout-window scan
      coverage: coverageThrough('2026-10-05T18:00:00.000Z'),
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('absent');
    expect(result.checkInIso).toBeNull();
    expect(result.checkOutIso).not.toBeNull();
  });

  it('no check-in and no checkout, coverage confirmed -> Absent', () => {
    const input = dayInput({ events: [], coverage: coverageThrough('2026-10-05T18:00:00.000Z') });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('absent');
    expect(result.checkInIso).toBeNull();
    expect(result.checkOutIso).toBeNull();
  });
});

describe('calculateAttendanceStatus -- Night shift crossing midnight', () => {
  it('Night check-in on the starting date and checkout on the next calendar date both resolve correctly', () => {
    // Night check-in window 16:00-20:00 Blantyre on 2026-10-05 = 14:00-18:00 UTC on 2026-10-05.
    // Night checkout window 04:00-08:00 Blantyre on 2026-10-06 = 02:00-06:00 UTC on 2026-10-06.
    const windows = getShiftWindows('night', NIGHT_DATE);
    expect(windows.checkInWindowStartIso).toBe('2026-10-05T14:00:00.000Z');
    expect(windows.checkOutWindowStartIso).toBe('2026-10-06T02:00:00.000Z');
    expect(windows.checkOutWindowEndIso).toBe('2026-10-06T06:00:00.000Z');

    const input = nightInput({
      events: [
        ev('2026-10-05T14:05:00.000Z'), // 16:05 Blantyre check-in, on time (late after 18:15 Blantyre = 16:15 UTC)
        ev('2026-10-06T03:00:00.000Z'), // 05:00 Blantyre checkout, next calendar date
      ],
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('present');
    expect(result.checkInIso).toBe('2026-10-05T14:05:00.000Z');
    expect(result.checkOutIso).toBe('2026-10-06T03:00:00.000Z');
  });

  it('Night late grace boundary is 18:15 Blantyre (16:15 UTC)', () => {
    const windows = getShiftWindows('night', NIGHT_DATE);
    expect(windows.lateAfterIso).toBe('2026-10-05T16:15:00.000Z');
    const input = nightInput({
      events: [ev('2026-10-05T16:15:01.000Z'), ev('2026-10-06T03:00:00.000Z')],
    });
    expect(calculateAttendanceStatus(input).status).toBe('late');
  });

  it('a Night check-in scan never counts as a checkout, even if it is the only scan and the checkout window later opens', () => {
    const input = nightInput({
      events: [ev('2026-10-05T14:05:00.000Z')], // only a check-in-window scan
      coverage: coverageThrough('2026-10-06T06:00:00.000Z'), // checkout window fully closed
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('absent');
    expect(result.checkInIso).not.toBeNull();
    expect(result.checkOutIso).toBeNull();
  });
});

describe('calculateAttendanceStatus -- Excel export timing / PENDING, not Absent', () => {
  it('Day guard checked in 06:05, export at 14:00, no checkout yet -> Pending', () => {
    const input = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z')], // 06:05 Blantyre
      coverage: coverageThrough('2026-10-05T12:00:00.000Z'), // 14:00 Blantyre export moment
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('pending');
    expect(result.checkInIso).not.toBeNull();
  });

  it('Day shift ended at 18:00 but checkout window open until 20:00 -> still Pending, not Absent', () => {
    const input = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z')],
      coverage: coverageThrough('2026-10-05T16:30:00.000Z'), // 18:30 Blantyre -- after shift end, before checkout window closes at 20:00
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('pending');
  });

  it('Night guard checked in 18:05, export at 23:00 -> Pending', () => {
    const input = nightInput({
      events: [ev('2026-10-05T16:05:00.000Z')], // 18:05 Blantyre = 16:05 UTC
      coverage: coverageThrough('2026-10-05T21:00:00.000Z'), // 23:00 Blantyre export moment
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('pending');
  });

  it('Night shift ends 06:00 next morning but checkout window open until 08:00 -> still Pending', () => {
    const input = nightInput({
      events: [ev('2026-10-05T14:05:00.000Z')],
      coverage: coverageThrough('2026-10-06T04:30:00.000Z'), // 06:30 Blantyre -- after shift end, before checkout window closes at 08:00
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('pending');
  });

  it('after the checkout window closes and coverage is confirmed, a Day shift with no checkout finalizes to Absent', () => {
    const input = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z')],
      coverage: coverageThrough('2026-10-05T18:00:00.000Z'), // 20:00 Blantyre -- checkout window fully closed
    });
    expect(calculateAttendanceStatus(input).status).toBe('absent');
  });
});

describe('calculateAttendanceStatus -- incomplete/unknown coverage', () => {
  it('explicit insufficient coverage with no scans at all -> Pending, never Absent', () => {
    const input = dayInput({ events: [], coverage: insufficientCoverage() });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('pending');
  });

  it('coverage confirmed_complete but verifiedThroughIso missing is treated as insufficient (never silently Absent)', () => {
    const input = dayInput({ events: [], coverage: { status: 'confirmed_complete' } });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('pending');
  });
});

describe('calculateAttendanceStatus -- recalculation when later fingerprint data becomes available', () => {
  it('is a pure function: re-running with a fuller event list and updated coverage supersedes the earlier Pending result without any special-cased "recalculation" path', () => {
    const partial = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z')],
      coverage: coverageThrough('2026-10-05T12:00:00.000Z'),
    });
    const firstRun = calculateAttendanceStatus(partial);
    expect(firstRun.status).toBe('pending');

    // A later, overlapping import adds the checkout scan and confirms coverage further.
    const fuller = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z'), ev('2026-10-05T14:30:00.000Z')],
      coverage: coverageThrough('2026-10-05T18:00:00.000Z'),
    });
    const secondRun = calculateAttendanceStatus(fuller);
    expect(secondRun.status).toBe('present');
    expect(secondRun.checkOutIso).not.toBeNull();
  });
});
