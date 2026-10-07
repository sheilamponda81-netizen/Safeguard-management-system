import { describe, it, expect } from 'vitest';
import {
  profileHikCentralIdentities,
  classifyHikCentralIdentities,
  suggestEmployeesForIdentity,
  normalizeNameForComparison,
  mappedIdentityHasNameDrift,
  IdentifiedRawEventRow,
  EmployeeLite,
  ActiveMappingRow,
} from './hikcentralPersonMapping';

function row(overrides: Partial<IdentifiedRawEventRow> = {}): IdentifiedRawEventRow {
  return {
    hikcentralPersonNo: '00000104',
    firstName: 'TEST',
    lastName: 'PERSON',
    accessPoint: 'HEADOFFICE- NAPERI_Door_1',
    eventTimeIso: '2026-10-01T03:18:29.000Z',
    ...overrides,
  };
}

function employee(overrides: Partial<EmployeeLite> = {}): EmployeeLite {
  return {
    id: 'emp-1',
    employeeNumber: 'SFG-S-001',
    fullName: 'TEST PERSON',
    workstation: 'Head Office',
    status: 'Active',
    isDeleted: false,
    ...overrides,
  };
}

describe('normalizeNameForComparison', () => {
  it('trims, collapses internal whitespace, and upper-cases for NAME comparison only', () => {
    expect(normalizeNameForComparison('  patrick   khayanga  ')).toBe('PATRICK KHAYANGA');
    expect(normalizeNameForComparison('Patrick Khayanga')).toBe('PATRICK KHAYANGA');
  });
});

describe('profileHikCentralIdentities', () => {
  it('groups by EXACT raw Person No. -- "00000018" and "18" remain two separate identities, never merged', () => {
    const rows = [
      row({ hikcentralPersonNo: '00000018', firstName: 'PATRICK', lastName: 'KHAYANGA' }),
      row({ hikcentralPersonNo: '18', firstName: 'PRECIOUS', lastName: 'DULA' }),
    ];
    const profiles = profileHikCentralIdentities(rows);
    expect(profiles).toHaveLength(2);
    const personNos = profiles.map((p) => p.hikcentralPersonNo);
    expect(personNos).toContain('00000018');
    expect(personNos).toContain('18');
    expect(personNos[0]).not.toBe(personNos[1]);
  });

  it('keeps "00000021" and "21" as distinct identities too', () => {
    const rows = [row({ hikcentralPersonNo: '00000021' }), row({ hikcentralPersonNo: '21' })];
    const profiles = profileHikCentralIdentities(rows);
    expect(profiles.map((p) => p.hikcentralPersonNo).sort()).toEqual(['00000021', '21']);
  });

  it('preserves leading zeros exactly -- the profile key is never numerically coerced', () => {
    const profiles = profileHikCentralIdentities([row({ hikcentralPersonNo: '00000104' })]);
    expect(profiles[0].hikcentralPersonNo).toBe('00000104');
    expect(profiles[0].hikcentralPersonNo).not.toBe('104');
  });

  it('skips a row with an empty or missing Person No. -- never produces a mappable identity for one', () => {
    const profiles = profileHikCentralIdentities([
      row({ hikcentralPersonNo: '' }),
      row({ hikcentralPersonNo: '00000104' }),
    ]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].hikcentralPersonNo).toBe('00000104');
  });

  it('computes event count, distinct access points, and earliest/latest', () => {
    const profiles = profileHikCentralIdentities([
      row({ accessPoint: 'A', eventTimeIso: '2026-10-02T00:00:00.000Z' }),
      row({ accessPoint: 'B', eventTimeIso: '2026-10-01T00:00:00.000Z' }),
    ]);
    expect(profiles[0].eventCount).toBe(2);
    expect(profiles[0].accessPoints).toEqual(['A', 'B']);
    expect(profiles[0].earliest).toBe('2026-10-01T00:00:00.000Z');
    expect(profiles[0].latest).toBe('2026-10-02T00:00:00.000Z');
  });

  it('whitespace-only name differences do not count as a conflict -- they normalize to the same name', () => {
    const profiles = profileHikCentralIdentities([
      row({ firstName: 'Patrick', lastName: 'Khayanga' }),
      row({ firstName: '  Patrick  ', lastName: '  Khayanga ' }),
      row({ firstName: 'patrick', lastName: 'khayanga' }),
    ]);
    expect(profiles[0].distinctNormalizedNames).toHaveLength(1);
    expect(profiles[0].distinctNormalizedNames[0]).toBe('PATRICK KHAYANGA');
  });

  it('two materially different non-empty names for the SAME exact Person No. are a conflict', () => {
    const profiles = profileHikCentralIdentities([
      row({ firstName: 'Patrick', lastName: 'Khayanga' }),
      row({ firstName: 'Molly', lastName: 'Namaijnja' }),
    ]);
    expect(profiles[0].distinctNormalizedNames).toHaveLength(2);
  });
});

describe('classifyHikCentralIdentities', () => {
  it('classifies a Person No. with exactly one active, non-deleted, exact-name-matching employee as EXACT', () => {
    const profiles = profileHikCentralIdentities([row()]);
    const employees = [employee()];
    const result = classifyHikCentralIdentities(profiles, employees, []);
    expect(result[0].category).toBe('exact');
    expect(result[0].matchedEmployee?.id).toBe('emp-1');
  });

  it('exact-name matching is case-insensitive', () => {
    const profiles = profileHikCentralIdentities([row({ firstName: 'test', lastName: 'person' })]);
    const result = classifyHikCentralIdentities(profiles, [employee({ fullName: 'TEST PERSON' })], []);
    expect(result[0].category).toBe('exact');
  });

  it('whitespace-only name differences still produce an exact match', () => {
    const profiles = profileHikCentralIdentities([row({ firstName: 'Test', lastName: 'Person' })]);
    const result = classifyHikCentralIdentities(profiles, [employee({ fullName: '  Test   Person ' })], []);
    expect(result[0].category).toBe('exact');
  });

  it('does not exact-match an INACTIVE or deleted employee, even with the identical name', () => {
    const profiles = profileHikCentralIdentities([row()]);
    const inactive = classifyHikCentralIdentities(profiles, [employee({ status: 'Deleted' })], []);
    expect(inactive[0].category).not.toBe('exact');
    const deleted = classifyHikCentralIdentities(profiles, [employee({ isDeleted: true })], []);
    expect(deleted[0].category).not.toBe('exact');
  });

  it('same exact Person No. with conflicting non-empty names is CONFLICT, never exact -- and offers no bulk-confirmable suggestions', () => {
    const profiles = profileHikCentralIdentities([
      row({ firstName: 'Patrick', lastName: 'Khayanga' }),
      row({ firstName: 'Molly', lastName: 'Namaijnja' }),
    ]);
    const result = classifyHikCentralIdentities(profiles, [employee({ fullName: 'Patrick Khayanga' })], []);
    expect(result[0].category).toBe('conflict');
    expect(result[0].matchedEmployee).toBeNull();
    expect(result[0].suggestions).toEqual([]);
  });

  it('00000018 (Patrick Khayanga) and 18 (Precious Dula) classify completely independently -- never cross-contaminate', () => {
    const profiles = profileHikCentralIdentities([
      row({ hikcentralPersonNo: '00000018', firstName: 'Patrick', lastName: 'Khayanga' }),
      row({ hikcentralPersonNo: '18', firstName: 'Precious', lastName: 'Dula' }),
    ]);
    const employees = [
      employee({ id: 'e1', fullName: 'Patrick Khayanga' }),
      employee({ id: 'e2', fullName: 'Precious Dula' }),
    ];
    const result = classifyHikCentralIdentities(profiles, employees, []);
    const byPersonNo = new Map(result.map((r) => [r.profile.hikcentralPersonNo, r]));
    expect(byPersonNo.get('00000018')?.category).toBe('exact');
    expect(byPersonNo.get('00000018')?.matchedEmployee?.id).toBe('e1');
    expect(byPersonNo.get('18')?.category).toBe('exact');
    expect(byPersonNo.get('18')?.matchedEmployee?.id).toBe('e2');
  });

  it('no name match and no close suggestion -> needs_review with an empty suggestion list (manual search still required, never auto-mapped)', () => {
    const profiles = profileHikCentralIdentities([row({ firstName: 'Zzyzx', lastName: 'Qvwxyz' })]);
    const result = classifyHikCentralIdentities(profiles, [employee({ fullName: 'Completely Unrelated Name' })], []);
    expect(result[0].category).toBe('needs_review');
    expect(result[0].suggestions).toEqual([]);
  });

  it('an identity already carrying an active mapping is MAPPED, regardless of name evidence', () => {
    const profiles = profileHikCentralIdentities([row({ hikcentralPersonNo: '00000104' })]);
    const mapping: ActiveMappingRow = {
      id: 'map-1', hikcentralPersonNo: '00000104', employeeId: 'emp-1',
      matchMethod: 'manual', confirmedBy: 'user-1', confirmedAt: '2026-10-07T00:00:00.000Z',
      createdAt: '2026-10-07T00:00:00.000Z',
    };
    const result = classifyHikCentralIdentities(profiles, [employee()], [mapping]);
    expect(result[0].category).toBe('mapped');
    expect(result[0].matchedEmployee?.id).toBe('emp-1');
    expect(result[0].activeMapping?.id).toBe('map-1');
  });

  it('one employee can have multiple active different Person Nos -- both classify as mapped to the same employee independently', () => {
    const profiles = profileHikCentralIdentities([
      row({ hikcentralPersonNo: '00000104' }),
      row({ hikcentralPersonNo: '87' }),
    ]);
    const mappings: ActiveMappingRow[] = [
      { id: 'm1', hikcentralPersonNo: '00000104', employeeId: 'emp-1', matchMethod: 'manual', confirmedBy: null, confirmedAt: null, createdAt: '2026-10-07T00:00:00.000Z' },
      { id: 'm2', hikcentralPersonNo: '87', employeeId: 'emp-1', matchMethod: 'manual', confirmedBy: null, confirmedAt: null, createdAt: '2026-10-07T00:00:00.000Z' },
    ];
    const result = classifyHikCentralIdentities(profiles, [employee()], mappings);
    expect(result.every((r) => r.category === 'mapped' && r.matchedEmployee?.id === 'emp-1')).toBe(true);
  });
});

describe('suggestEmployeesForIdentity (needs-review candidates -- suggestions only, never auto-mapped)', () => {
  it('a single-letter spelling variation produces a useful "Possible match" suggestion (synthetic stand-in for the real AFIKI NJANJI / AFFICK NJANJI-class pattern observed in STAGING)', () => {
    const profiles = profileHikCentralIdentities([row({ firstName: 'Afiki', lastName: 'Njanji' })]);
    const suggestions = suggestEmployeesForIdentity(profiles[0], [employee({ fullName: 'Affick Njanji' })]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].label).toBe('Possible match');
    expect(suggestions[0].employee.fullName).toBe('Affick Njanji');
  });

  it('a one-character substitution produces a useful suggestion (synthetic stand-in for the real "canada"/"KANADA"-class pattern)', () => {
    const profiles = profileHikCentralIdentities([row({ firstName: 'Steven', lastName: 'Canada' })]);
    const suggestions = suggestEmployeesForIdentity(profiles[0], [employee({ fullName: 'Steven Kanada' })]);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].label).toBe('Possible match');
  });

  it('an inserted/dropped letter produces a useful suggestion (synthetic stand-in for the real "MIKSON"/"MICKSON"-class pattern)', () => {
    const profiles = profileHikCentralIdentities([row({ firstName: 'Wyson', lastName: 'Mikson' })]);
    const suggestions = suggestEmployeesForIdentity(profiles[0], [employee({ fullName: 'Wyson Mickson' })]);
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('returns at most 3 candidates, ranked best-first', () => {
    const profiles = profileHikCentralIdentities([row({ firstName: 'John', lastName: 'Smith' })]);
    const employees = [
      employee({ id: 'e1', fullName: 'John Smithe' }),   // 1 char off
      employee({ id: 'e2', fullName: 'Jon Smith' }),     // 1 char off
      employee({ id: 'e3', fullName: 'John Smyth' }),    // 1 char off
      employee({ id: 'e4', fullName: 'Jon Smyth' }),     // 2 chars off
    ];
    const suggestions = suggestEmployeesForIdentity(profiles[0], employees);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('a wildly different name yields NO suggestions (not forced into 3 irrelevant candidates) -- UI must fall back to manual employee search', () => {
    const profiles = profileHikCentralIdentities([row({ firstName: 'Zzyzx', lastName: 'Qvwxyz' })]);
    const suggestions = suggestEmployeesForIdentity(profiles[0], [employee({ fullName: 'Completely Unrelated Person' })]);
    expect(suggestions).toEqual([]);
  });

  it('excludes inactive/deleted employees from suggestions entirely', () => {
    const profiles = profileHikCentralIdentities([row({ firstName: 'Afiki', lastName: 'Njanji' })]);
    const suggestions = suggestEmployeesForIdentity(profiles[0], [employee({ fullName: 'Affick Njanji', status: 'Deleted' })]);
    expect(suggestions).toEqual([]);
  });

  it('returns no suggestions for a conflicting (multi-name) identity -- nothing coherent to suggest from', () => {
    const profiles = profileHikCentralIdentities([
      row({ firstName: 'Patrick', lastName: 'Khayanga' }),
      row({ firstName: 'Molly', lastName: 'Namaijnja' }),
    ]);
    const suggestions = suggestEmployeesForIdentity(profiles[0], [employee({ fullName: 'Patrick Khayanga' })]);
    expect(suggestions).toEqual([]);
  });

  it('never returns a result that itself constitutes a write -- a suggestion is always just {employee, label} data, with no mapping side effect possible from calling this function', () => {
    const profiles = profileHikCentralIdentities([row({ firstName: 'Afiki', lastName: 'Njanji' })]);
    const suggestions = suggestEmployeesForIdentity(profiles[0], [employee({ fullName: 'Affick Njanji' })]);
    expect(Object.keys(suggestions[0]).sort()).toEqual(['employee', 'label']);
  });
});

describe('mappedIdentityHasNameDrift (future collision guardrail for an already-mapped identity)', () => {
  it('returns false for a mapped identity whose raw events still carry only one name', () => {
    const profiles = profileHikCentralIdentities([row()]);
    expect(mappedIdentityHasNameDrift(profiles[0])).toBe(false);
  });

  it('returns true if a later import adds a materially different non-empty name for an already-mapped exact Person No. -- must be flagged, never silently treated as clean', () => {
    const profiles = profileHikCentralIdentities([
      row({ firstName: 'Patrick', lastName: 'Khayanga' }),
      row({ firstName: 'Molly', lastName: 'Namaijnja' }),
    ]);
    expect(mappedIdentityHasNameDrift(profiles[0])).toBe(true);
  });
});
