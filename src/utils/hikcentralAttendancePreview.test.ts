import { describe, it, expect } from 'vitest';
import {
  buildEmployeeDayScanGroups,
  blantyreDateKey,
  blantyreTimeOfDay,
  blantyreDateRangeToUtcBounds,
  splitByActiveMapping,
  MappedScanEventRow,
  RawIdentifiedEventRow,
} from './hikcentralAttendancePreview';
import { EmployeeLite } from './hikcentralPersonMapping';

function scan(overrides: Partial<MappedScanEventRow> = {}): MappedScanEventRow {
  return {
    hikcentralPersonNo: '00000104',
    employeeId: 'emp-1',
    eventTimeIso: '2026-10-01T04:00:00.000Z', // 06:00 Blantyre
    accessPoint: 'HEADOFFICE- NAPERI_Door_1',
    ...overrides,
  };
}

function employee(overrides: Partial<EmployeeLite> = {}): EmployeeLite {
  return {
    id: 'emp-1',
    employeeNumber: 'SFG-S-001',
    fullName: 'Test Person',
    workstation: 'Head Office',
    status: 'Active',
    isDeleted: false,
    ...overrides,
  };
}

describe('blantyreDateKey / blantyreTimeOfDay (Africa/Blantyre, fixed UTC+02:00)', () => {
  it('converts a UTC instant to the correct Blantyre calendar date and time of day', () => {
    // 2026-10-04T18:26:14Z -> Blantyre 2026-10-04T20:26:14+02:00 (no date change)
    expect(blantyreDateKey('2026-10-04T18:26:14.000Z')).toBe('2026-10-04');
    expect(blantyreTimeOfDay('2026-10-04T18:26:14.000Z')).toBe('20:26:14');
  });

  it('rolls the calendar date FORWARD across midnight when the UTC instant is late enough (UTC 22:xx -> Blantyre next-day 00:xx)', () => {
    // 2026-10-01T22:30:00Z -> Blantyre 2026-10-02T00:30:00+02:00
    expect(blantyreDateKey('2026-10-01T22:30:00.000Z')).toBe('2026-10-02');
    expect(blantyreTimeOfDay('2026-10-01T22:30:00.000Z')).toBe('00:30:00');
  });

  it('never uses the host/local timezone -- the +02:00 shift is explicit arithmetic, not Date-locale-dependent', () => {
    // A value that would land on a DIFFERENT calendar date in UTC-5, UTC+0, and UTC+2
    // all at once if this function ever fell back to host-local time.
    expect(blantyreDateKey('2026-01-01T23:00:00.000Z')).toBe('2026-01-02');
  });
});

describe('blantyreDateRangeToUtcBounds', () => {
  it('converts a single-day Blantyre range into the correct UTC instant bounds', () => {
    const { fromUtcIso, toUtcIsoExclusive } = blantyreDateRangeToUtcBounds('2026-10-01', '2026-10-01');
    expect(fromUtcIso).toBe('2026-09-30T22:00:00.000Z'); // 2026-10-01T00:00:00+02:00
    expect(toUtcIsoExclusive).toBe('2026-10-01T22:00:00.000Z'); // 2026-10-02T00:00:00+02:00
  });

  it('a scan just before the naive UTC-midnight boundary is still included because the Blantyre day started 2 hours earlier', () => {
    const { fromUtcIso } = blantyreDateRangeToUtcBounds('2026-10-01', '2026-10-04');
    // 2026-09-30T23:30:00Z is Blantyre 2026-10-01T01:30:00+02:00 -- inside the requested range.
    expect('2026-09-30T23:30:00.000Z' >= fromUtcIso).toBe(true);
  });

  it('spans multiple days correctly (end date is inclusive)', () => {
    const { fromUtcIso, toUtcIsoExclusive } = blantyreDateRangeToUtcBounds('2026-10-01', '2026-10-04');
    expect(fromUtcIso).toBe('2026-09-30T22:00:00.000Z');
    expect(toUtcIsoExclusive).toBe('2026-10-04T22:00:00.000Z'); // start of 2026-10-05 Blantyre
  });
});

describe('buildEmployeeDayScanGroups: grouping', () => {
  it('groups by (employeeId, Blantyre calendar date) -- never by the raw hikcentral_person_no string', () => {
    const groups = buildEmployeeDayScanGroups(
      [scan({ eventTimeIso: '2026-10-01T04:00:00.000Z' }), scan({ eventTimeIso: '2026-10-01T15:00:00.000Z' })],
      new Map([['emp-1', employee()]])
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].employeeId).toBe('emp-1');
    expect(groups[0].localDate).toBe('2026-10-01');
    expect(groups[0].scanCount).toBe(2);
  });

  it('two different exact Person No strings mapped to the SAME employee merge into one day group (employee with multiple HikCentral identities)', () => {
    const groups = buildEmployeeDayScanGroups(
      [
        scan({ hikcentralPersonNo: '00000104', eventTimeIso: '2026-10-01T04:00:00.000Z' }),
        scan({ hikcentralPersonNo: '87', eventTimeIso: '2026-10-01T15:00:00.000Z' }), // a second, different active Person No for the SAME employee
      ],
      new Map([['emp-1', employee()]])
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].scanCount).toBe(2);
  });

  it('a leading-zero Person No and its bare-numeric look-alike, mapped to two DIFFERENT employees, never merge -- grouping is by employeeId, and the two employeeIds here are genuinely different', () => {
    const groups = buildEmployeeDayScanGroups(
      [
        scan({ hikcentralPersonNo: '00000018', employeeId: 'emp-1', eventTimeIso: '2026-10-01T04:00:00.000Z' }),
        scan({ hikcentralPersonNo: '18', employeeId: 'emp-2', eventTimeIso: '2026-10-01T04:05:00.000Z' }),
      ],
      new Map([['emp-1', employee({ id: 'emp-1' })], ['emp-2', employee({ id: 'emp-2', fullName: 'Different Person' })]])
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.employeeId).sort()).toEqual(['emp-1', 'emp-2']);
  });

  it('different employees on the same day never merge', () => {
    const groups = buildEmployeeDayScanGroups(
      [scan({ employeeId: 'emp-1' }), scan({ employeeId: 'emp-2' })],
      new Map([['emp-1', employee({ id: 'emp-1' })], ['emp-2', employee({ id: 'emp-2' })]])
    );
    expect(groups).toHaveLength(2);
  });

  it('the same employee on two different days never merges', () => {
    const groups = buildEmployeeDayScanGroups(
      [scan({ eventTimeIso: '2026-10-01T04:00:00.000Z' }), scan({ eventTimeIso: '2026-10-02T04:00:00.000Z' })],
      new Map([['emp-1', employee()]])
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.localDate)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('scans within a group are sorted chronologically regardless of input order', () => {
    const groups = buildEmployeeDayScanGroups(
      [scan({ eventTimeIso: '2026-10-01T15:00:00.000Z' }), scan({ eventTimeIso: '2026-10-01T04:00:00.000Z' })],
      new Map([['emp-1', employee()]])
    );
    expect(groups[0].scans.map((s) => s.eventTimeIso)).toEqual(['2026-10-01T04:00:00.000Z', '2026-10-01T15:00:00.000Z']);
    expect(groups[0].earliestScanIso).toBe('2026-10-01T04:00:00.000Z');
    expect(groups[0].latestScanIso).toBe('2026-10-01T15:00:00.000Z');
  });

  it('an employee no longer visible to the caller (e.g. RLS/region) still produces a group, with employee: null -- never dropped silently', () => {
    const groups = buildEmployeeDayScanGroups([scan({ employeeId: 'emp-ghost' })], new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0].employee).toBeNull();
  });
});

describe('buildEmployeeDayScanGroups: scan-count categories and flags', () => {
  it('a single scan is categorized "single_scan" and flagged for review', () => {
    const groups = buildEmployeeDayScanGroups([scan()], new Map([['emp-1', employee()]]));
    expect(groups[0].scanCountCategory).toBe('single_scan');
    expect(groups[0].reviewFlags).toContain('single_scan');
  });

  it('exactly two scans is categorized "two_scans" -- NEVER treated as a confirmed complete shift (no such flag/label exists)', () => {
    const groups = buildEmployeeDayScanGroups(
      [scan({ eventTimeIso: '2026-10-01T04:00:00.000Z' }), scan({ eventTimeIso: '2026-10-01T15:00:00.000Z' })],
      new Map([['emp-1', employee()]])
    );
    expect(groups[0].scanCountCategory).toBe('two_scans');
    expect(groups[0].reviewFlags).not.toContain('single_scan');
    expect(groups[0].reviewFlags).not.toContain('three_or_more_scans');
    // No "complete"/"confirmed" flag is ever produced by this module.
    expect(groups[0].reviewFlags.join(',')).not.toMatch(/complete|confirmed/i);
  });

  it('three or more scans is categorized "three_or_more_scans" and flagged as ambiguous for review', () => {
    const groups = buildEmployeeDayScanGroups(
      [
        scan({ eventTimeIso: '2026-10-01T04:00:00.000Z' }),
        scan({ eventTimeIso: '2026-10-01T10:00:00.000Z' }),
        scan({ eventTimeIso: '2026-10-01T15:00:00.000Z' }),
      ],
      new Map([['emp-1', employee()]])
    );
    expect(groups[0].scanCountCategory).toBe('three_or_more_scans');
    expect(groups[0].reviewFlags).toContain('three_or_more_scans');
  });

  it('exact duplicate timestamps within the same group are preserved (never silently deduped) and flagged', () => {
    const groups = buildEmployeeDayScanGroups(
      [scan({ eventTimeIso: '2026-10-01T04:00:00.000Z' }), scan({ eventTimeIso: '2026-10-01T04:00:00.000Z' })],
      new Map([['emp-1', employee()]])
    );
    expect(groups[0].scanCount).toBe(2);
    expect(groups[0].reviewFlags).toContain('duplicate_timestamp');
  });

  it('scans at two different access points on the same day are flagged "multiple_sites"', () => {
    const groups = buildEmployeeDayScanGroups(
      [
        scan({ eventTimeIso: '2026-10-01T04:00:00.000Z', accessPoint: 'AHL - LIMBE_Door_1' }),
        scan({ eventTimeIso: '2026-10-01T15:00:00.000Z', accessPoint: 'MTL - CHICHIRI_Door_1' }),
      ],
      new Map([['emp-1', employee()]])
    );
    expect(groups[0].accessPoints).toEqual(['AHL - LIMBE_Door_1', 'MTL - CHICHIRI_Door_1']);
    expect(groups[0].reviewFlags).toContain('multiple_sites');
  });

  it('a single access point produces no "multiple_sites" flag', () => {
    const groups = buildEmployeeDayScanGroups(
      [scan({ eventTimeIso: '2026-10-01T04:00:00.000Z' }), scan({ eventTimeIso: '2026-10-01T15:00:00.000Z' })],
      new Map([['emp-1', employee()]])
    );
    expect(groups[0].reviewFlags).not.toContain('multiple_sites');
  });
});

describe('buildEmployeeDayScanGroups: potential-overnight flag (midnight-boundary heuristic, presentational only)', () => {
  it('flags a day whose ONLY scan is just after local midnight', () => {
    // 2026-10-01T23:30:00Z -> Blantyre 2026-10-02T01:30:00 (hour 1, inside the 22:00-02:00 window)
    const groups = buildEmployeeDayScanGroups([scan({ eventTimeIso: '2026-10-01T23:30:00.000Z' })], new Map([['emp-1', employee()]]));
    expect(groups[0].reviewFlags).toContain('potential_overnight');
  });

  it('flags a day whose LAST scan is late at night (just before local midnight)', () => {
    // 2026-10-01T21:00:00Z -> Blantyre 23:00 (hour 23, inside the window)
    const groups = buildEmployeeDayScanGroups(
      [scan({ eventTimeIso: '2026-10-01T04:00:00.000Z' }), scan({ eventTimeIso: '2026-10-01T21:00:00.000Z' })],
      new Map([['emp-1', employee()]])
    );
    expect(groups[0].reviewFlags).toContain('potential_overnight');
  });

  it('does NOT flag an ordinary daytime-only pair of scans', () => {
    // 06:00 and 17:00 Blantyre -- both well outside the overnight window
    const groups = buildEmployeeDayScanGroups(
      [scan({ eventTimeIso: '2026-10-01T04:00:00.000Z' }), scan({ eventTimeIso: '2026-10-01T15:00:00.000Z' })],
      new Map([['emp-1', employee()]])
    );
    expect(groups[0].reviewFlags).not.toContain('potential_overnight');
  });

  it('two adjacent-day groups (one ending near midnight, the next starting near midnight) are each flagged independently, never merged into one group', () => {
    const groups = buildEmployeeDayScanGroups(
      [
        scan({ eventTimeIso: '2026-10-01T21:58:00.000Z' }), // Blantyre 2026-10-01 23:58
        scan({ eventTimeIso: '2026-10-01T22:05:00.000Z' }), // Blantyre 2026-10-02 00:05
      ],
      new Map([['emp-1', employee()]])
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].localDate).toBe('2026-10-01');
    expect(groups[1].localDate).toBe('2026-10-02');
    expect(groups[0].reviewFlags).toContain('potential_overnight');
    expect(groups[1].reviewFlags).toContain('potential_overnight');
  });

  it('exactly at the window boundary hours (22:00 and 02:00) is handled consistently (22:00 inside, 02:00 outside)', () => {
    const atTwentyTwo = buildEmployeeDayScanGroups([scan({ eventTimeIso: '2026-10-01T20:00:00.000Z' })], new Map([['emp-1', employee()]])); // Blantyre 22:00
    expect(atTwentyTwo[0].reviewFlags).toContain('potential_overnight');

    const atTwo = buildEmployeeDayScanGroups([scan({ eventTimeIso: '2026-10-01T00:00:00.000Z' })], new Map([['emp-1', employee()]])); // Blantyre 02:00
    expect(atTwo[0].reviewFlags).not.toContain('potential_overnight');
  });
});

describe('splitByActiveMapping', () => {
  function identifiedEvent(overrides: Partial<RawIdentifiedEventRow> = {}): RawIdentifiedEventRow {
    return { hikcentralPersonNo: '00000104', eventTimeIso: '2026-10-01T04:00:00.000Z', accessPoint: 'A', ...overrides };
  }

  it('routes an event whose Person No. has an active mapping into "mapped", carrying the mapped employeeId', () => {
    const { mapped, identifiedUnmappedCount } = splitByActiveMapping(
      [identifiedEvent({ hikcentralPersonNo: '00000104' })],
      new Map([['00000104', 'emp-1']])
    );
    expect(mapped).toEqual([{ hikcentralPersonNo: '00000104', employeeId: 'emp-1', eventTimeIso: '2026-10-01T04:00:00.000Z', accessPoint: 'A' }]);
    expect(identifiedUnmappedCount).toBe(0);
  });

  it('counts (never includes the row data for) an identified Person No. with no active mapping', () => {
    const { mapped, identifiedUnmappedCount } = splitByActiveMapping([identifiedEvent({ hikcentralPersonNo: '00000999' })], new Map());
    expect(mapped).toEqual([]);
    expect(identifiedUnmappedCount).toBe(1);
  });

  it('exact raw Person No. lookup -- "00000018" and "18" are looked up independently, never conflated', () => {
    const { mapped, identifiedUnmappedCount } = splitByActiveMapping(
      [identifiedEvent({ hikcentralPersonNo: '00000018' }), identifiedEvent({ hikcentralPersonNo: '18' })],
      new Map([['00000018', 'emp-1']]) // "18" (bare) is deliberately NOT in the map
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0].employeeId).toBe('emp-1');
    expect(identifiedUnmappedCount).toBe(1);
  });

  it('two different Person Nos mapped to the same employee both route to "mapped" with that employeeId (multiple HikCentral identities)', () => {
    const { mapped } = splitByActiveMapping(
      [identifiedEvent({ hikcentralPersonNo: '00000104' }), identifiedEvent({ hikcentralPersonNo: '87' })],
      new Map([['00000104', 'emp-1'], ['87', 'emp-1']])
    );
    expect(mapped.every((m) => m.employeeId === 'emp-1')).toBe(true);
    expect(mapped).toHaveLength(2);
  });
});

describe('buildEmployeeDayScanGroups: output never implies a confirmed check-in/check-out', () => {
  it('no field anywhere on the group or its scans is named/labeled checkIn/checkOut', () => {
    const groups = buildEmployeeDayScanGroups([scan()], new Map([['emp-1', employee()]]));
    const groupKeys = Object.keys(groups[0]).join(',');
    const scanKeys = Object.keys(groups[0].scans[0]).join(',');
    expect(groupKeys + scanKeys).not.toMatch(/checkin|checkout|check_in|check_out/i);
  });
});
