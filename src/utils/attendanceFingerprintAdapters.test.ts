import { describe, it, expect } from 'vitest';
import { normalizeHikCentralRowsForEmployee } from './attendanceFingerprintAdapters';
import { ParsedHikCentralRow } from './hikcentralExcelParser';

function row(overrides: Partial<ParsedHikCentralRow> = {}): ParsedHikCentralRow {
  return {
    rowNumber: 2,
    hikcentralPersonNo: '00000104',
    firstName: 'Test',
    lastName: 'Person',
    eventTimeIso: '2026-10-05T04:05:00.000Z',
    accessPoint: 'HEADOFFICE- NAPERI_Door_1',
    cardReader: null,
    authenticationResult: 'Authorized',
    eventType: 'Access Granted by Fingerprint',
    attendanceType: 'Undefined',
    rawPayload: {},
    ...overrides,
  };
}

describe('normalizeHikCentralRowsForEmployee -- denied and repeated scans', () => {
  it('excludes denied/failed rows (wrong authentication result or event type)', () => {
    const rows = [
      row({ eventTimeIso: '2026-10-05T04:05:00.000Z' }),
      row({ eventTimeIso: '2026-10-05T04:06:00.000Z', authenticationResult: 'Denied' }),
      row({ eventTimeIso: '2026-10-05T04:07:00.000Z', eventType: 'Access Denied' }),
    ];
    const result = normalizeHikCentralRowsForEmployee(rows, '00000104');
    expect(result).toEqual([{ timestampIso: '2026-10-05T04:05:00.000Z' }]);
  });

  it('keeps repeated successful scans -- filtering repeats is the calculation engine\'s job, not the adapter\'s', () => {
    const rows = [
      row({ eventTimeIso: '2026-10-05T04:05:00.000Z' }),
      row({ eventTimeIso: '2026-10-05T04:06:00.000Z' }),
      row({ eventTimeIso: '2026-10-05T04:07:00.000Z' }),
    ];
    const result = normalizeHikCentralRowsForEmployee(rows, '00000104');
    expect(result).toHaveLength(3);
  });

  it('excludes rows belonging to a different HikCentral person number', () => {
    const rows = [row({ hikcentralPersonNo: '00000104' }), row({ hikcentralPersonNo: '00000999' })];
    const result = normalizeHikCentralRowsForEmployee(rows, '00000104');
    expect(result).toHaveLength(1);
  });

  it('accepts both real-export "Authorized" and legacy-fixture "Authorization" as successful', () => {
    const rows = [row({ authenticationResult: 'Authorized' }), row({ authenticationResult: 'Authorization', eventTimeIso: '2026-10-05T04:08:00.000Z' })];
    const result = normalizeHikCentralRowsForEmployee(rows, '00000104');
    expect(result).toHaveLength(2);
  });
});
