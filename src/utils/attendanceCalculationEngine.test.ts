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

describe('calculateAttendanceStatus -- early export rule: Present/Late credited from check-in alone', () => {
  it('Day guard checked in 06:05 (on time), export at 14:00, no checkout yet -> Present, provisional', () => {
    const input = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z')], // 06:05 Blantyre
      coverage: coverageThrough('2026-10-05T12:00:00.000Z'), // 14:00 Blantyre export moment -- explicit cutoff, never inferred from the event itself
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('present');
    expect(result.basis).toBe('check_in_only_provisional');
    expect(result.checkInIso).not.toBeNull();
    expect(result.checkOutIso).toBeNull();
  });

  it('Day guard checked in 06:30 (after grace), export at 14:00, no checkout yet -> Late, provisional', () => {
    const input = dayInput({
      events: [ev('2026-10-05T04:30:00.000Z')], // 06:30 Blantyre, after the 06:15 grace boundary
      coverage: coverageThrough('2026-10-05T12:00:00.000Z'),
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('late');
    expect(result.basis).toBe('check_in_only_provisional');
  });

  it('Day shift ended at 18:00 but checkout window open until 20:00, on-time check-in -> Present, not held as Pending', () => {
    const input = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z')],
      coverage: coverageThrough('2026-10-05T16:30:00.000Z'), // 18:30 Blantyre -- after shift end, before checkout window closes at 20:00
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('present');
    expect(result.basis).toBe('check_in_only_provisional');
  });

  it('Night guard checked in 18:05 (on time), export at 23:00, no checkout yet -> Present, provisional', () => {
    const input = nightInput({
      events: [ev('2026-10-05T16:05:00.000Z')], // 18:05 Blantyre = 16:05 UTC
      coverage: coverageThrough('2026-10-05T21:00:00.000Z'), // 23:00 Blantyre export moment
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('present');
    expect(result.basis).toBe('check_in_only_provisional');
  });

  it('Night guard checked in 18:30 (after grace), export at 23:00, no checkout yet -> Late, provisional', () => {
    const input = nightInput({
      events: [ev('2026-10-05T16:30:00.000Z')], // 18:30 Blantyre, after the 18:15 grace boundary
      coverage: coverageThrough('2026-10-05T21:00:00.000Z'),
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('late');
    expect(result.basis).toBe('check_in_only_provisional');
  });

  it('Night shift ends 06:00 next morning but checkout window open until 08:00, on-time check-in -> Present, not held as Pending', () => {
    const input = nightInput({
      events: [ev('2026-10-05T14:05:00.000Z')],
      coverage: coverageThrough('2026-10-06T04:30:00.000Z'), // 06:30 Blantyre -- after shift end, before checkout window closes at 08:00
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('present');
    expect(result.basis).toBe('check_in_only_provisional');
  });

  it('a missing check-in is NEVER credited Present and remains Pending under an early export, for both Day and Night', () => {
    const dayResult = calculateAttendanceStatus(dayInput({ events: [], coverage: coverageThrough('2026-10-05T12:00:00.000Z') }));
    expect(dayResult.status).toBe('pending');
    expect(dayResult.basis).toBe('not_applicable');

    const nightResult = calculateAttendanceStatus(nightInput({ events: [], coverage: coverageThrough('2026-10-05T21:00:00.000Z') }));
    expect(nightResult.status).toBe('pending');
  });

  it('after the checkout window closes and coverage is confirmed, a Day shift with no checkout finalizes to Absent (the early-export credit does not survive full coverage)', () => {
    const input = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z')],
      coverage: coverageThrough('2026-10-05T18:00:00.000Z'), // 20:00 Blantyre -- checkout window fully closed
    });
    const result = calculateAttendanceStatus(input);
    expect(result.status).toBe('absent');
    expect(result.basis).toBe('not_applicable');
  });

  it('a confirmed Present (both scans) is distinguishable from an early-export-credited Present via `basis`, with the same status value', () => {
    const confirmed = calculateAttendanceStatus(
      dayInput({ events: [ev('2026-10-05T04:05:00.000Z'), ev('2026-10-05T14:30:00.000Z')], coverage: coverageThrough('2026-10-05T18:00:00.000Z') })
    );
    const provisional = calculateAttendanceStatus(dayInput({ events: [ev('2026-10-05T04:05:00.000Z')], coverage: coverageThrough('2026-10-05T12:00:00.000Z') }));
    expect(confirmed.status).toBe('present');
    expect(provisional.status).toBe('present');
    expect(confirmed.basis).toBe('confirmed');
    expect(provisional.basis).toBe('check_in_only_provisional');
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
  it('is a pure function: re-running with no check-in yet (Pending) then a check-in arriving in a later import supersedes the earlier result', () => {
    const noDataYet = dayInput({ events: [], coverage: coverageThrough('2026-10-05T02:00:00.000Z') }); // 04:00 Blantyre -- before check-in window even opens
    const firstRun = calculateAttendanceStatus(noDataYet);
    expect(firstRun.status).toBe('pending');

    const checkInArrives = dayInput({ events: [ev('2026-10-05T04:05:00.000Z')], coverage: coverageThrough('2026-10-05T12:00:00.000Z') });
    const secondRun = calculateAttendanceStatus(checkInArrives);
    expect(secondRun.status).toBe('present');
    expect(secondRun.basis).toBe('check_in_only_provisional');
  });

  it('a check-in-only early-export Present is superseded by a confirmed Present once a later, complete export adds the checkout', () => {
    const partial = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z')],
      coverage: coverageThrough('2026-10-05T12:00:00.000Z'),
    });
    const firstRun = calculateAttendanceStatus(partial);
    expect(firstRun.status).toBe('present');
    expect(firstRun.basis).toBe('check_in_only_provisional');

    // A later, overlapping import adds the checkout scan and confirms coverage further.
    const fuller = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z'), ev('2026-10-05T14:30:00.000Z')],
      coverage: coverageThrough('2026-10-05T18:00:00.000Z'),
    });
    const secondRun = calculateAttendanceStatus(fuller);
    expect(secondRun.status).toBe('present');
    expect(secondRun.basis).toBe('confirmed');
    expect(secondRun.checkOutIso).not.toBeNull();
  });

  it('a check-in-only early-export Present can still resolve to Absent once the checkout window fully closes with no checkout ever found (the credit is provisional, not final)', () => {
    const early = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z')],
      coverage: coverageThrough('2026-10-05T12:00:00.000Z'),
    });
    const firstRun = calculateAttendanceStatus(early);
    expect(firstRun.status).toBe('present');
    expect(firstRun.basis).toBe('check_in_only_provisional');

    // A later, complete export confirms the checkout window closed and no checkout was ever recorded.
    const complete = dayInput({
      events: [ev('2026-10-05T04:05:00.000Z')],
      coverage: coverageThrough('2026-10-05T18:00:00.000Z'),
    });
    const secondRun = calculateAttendanceStatus(complete);
    expect(secondRun.status).toBe('absent');
    expect(secondRun.basis).toBe('not_applicable');
  });

  it('a check-in-only early-export Late is superseded by a confirmed Late once a later export adds the checkout', () => {
    const early = dayInput({
      events: [ev('2026-10-05T04:30:00.000Z')], // after grace
      coverage: coverageThrough('2026-10-05T12:00:00.000Z'),
    });
    expect(calculateAttendanceStatus(early).status).toBe('late');

    const complete = dayInput({
      events: [ev('2026-10-05T04:30:00.000Z'), ev('2026-10-05T14:30:00.000Z')],
      coverage: coverageThrough('2026-10-05T18:00:00.000Z'),
    });
    const result = calculateAttendanceStatus(complete);
    expect(result.status).toBe('late');
    expect(result.basis).toBe('confirmed');
  });
});
