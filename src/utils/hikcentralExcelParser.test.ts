import { describe, it, expect } from 'vitest';
import { readSheet } from 'read-excel-file/node';
import { buildTestXlsx, XlsxRow } from './testFixtures/buildTestXlsx';
import {
  parseHikCentralSheet,
  parseHikCentralTimeToUtcIso,
  summarizeHikCentralParseResult,
  isEligibleSuccessfulEvent,
  HikCentralFileError,
  SheetRow,
} from './hikcentralExcelParser';

// Mirrors the REAL HikCentral export structure exactly as inspected:
// rows 1-6 are report metadata, row 8 holds the real headers, data starts
// row 9, and "Captured Picture" appears twice. Uses only synthetic,
// clearly-fake names -- no real employee names or production HikCentral
// data, per the task's explicit requirement.
const METADATA_ROWS: XlsxRow[] = [
  ['Person Authentication Record'],
  ['Time Range: 2026-09-22 00:00:00 - 2026-09-28 23:59:59'],
  ['Generated: 2026-09-28 09:46:11'],
  [],
  ['Device: SAFEGUARD-TEST'],
  [],
];

const HEADER_ROW: XlsxRow = [
  'Captured Picture', 'Captured Picture', 'Profile', 'First Name', 'Last Name',
  'Person No.', 'Skin-Surface Temperature', 'Temperature Status', 'Mask Wearing Status',
  'Card No.', 'Department', 'Position', 'Time', 'Access Point', 'Card Reader',
  'Authentication Result', 'Event Type', 'Attendance Type',
];

function dataRow(overrides: Partial<{
  personNo: string | number | null;
  firstName: string;
  lastName: string;
  time: string;
  accessPoint: string;
  cardReader: string;
  authResult: string;
  eventType: string;
}>): XlsxRow {
  const {
    personNo = '00000174', firstName = 'TEST', lastName = 'PERSON',
    time = '2026-09-28 07:27:44', accessPoint = 'MTL - CHICHIRI_Door_1',
    cardReader = 'Cardreader 01', authResult = 'Authorization',
    eventType = 'Access Granted by Fingerprint',
  } = overrides;
  return [
    null, null, null, firstName, lastName, personNo, null, null, null, null,
    null, null, time, accessPoint, cardReader, authResult, eventType, 'Undefined',
  ];
}

async function parseRows(rows: XlsxRow[]) {
  const buffer = await buildTestXlsx(rows);
  const sheet = await readSheet(buffer, 1);
  return parseHikCentralSheet(sheet as unknown as SheetRow[]);
}

describe('parseHikCentralSheet', () => {
  // 1. Header detection despite metadata rows
  it('finds the header row past 6 leading metadata rows, matching the real export shape', async () => {
    const result = await parseRows([...METADATA_ROWS, HEADER_ROW, dataRow({})]);
    expect(result.headerRowIndex).toBe(6); // 0-based: row 7 in 1-based terms = the real export's row 8... (6 metadata rows at indices 0-5, header at index 6)
    expect(result.rows).toHaveLength(1);
  });

  // 2. Duplicate "Captured Picture" headers
  it('handles the two duplicate "Captured Picture" headers without error or column confusion', async () => {
    const result = await parseRows([...METADATA_ROWS, HEADER_ROW, dataRow({ personNo: '00000174' })]);
    expect(result.rowErrors).toHaveLength(0);
    expect(result.rows[0].hikcentralPersonNo).toBe('00000174');
  });

  // 3. Leading zeros preserved exactly
  it('preserves "00000174" exactly, as a string, never truncating leading zeros', async () => {
    const result = await parseRows([...METADATA_ROWS, HEADER_ROW, dataRow({ personNo: '00000174' })]);
    expect(result.rows[0].hikcentralPersonNo).toBe('00000174');
    expect(result.rows[0].hikcentralPersonNo).not.toBe('174');
  });

  // 4. Africa/Blantyre timestamp interpretation
  it('interprets "2026-09-28 07:27:44" as Africa/Blantyre (UTC+02:00), not local/UTC', async () => {
    const result = await parseRows([...METADATA_ROWS, HEADER_ROW, dataRow({ time: '2026-09-28 07:27:44' })]);
    // 07:27:44 +02:00 == 05:27:44 UTC
    expect(result.rows[0].eventTimeIso).toBe('2026-09-28T05:27:44.000Z');
  });

  // 5. Authorization vs Failed classification
  it('classifies Authorization vs Failed rows correctly in the summary', async () => {
    const result = await parseRows([
      ...METADATA_ROWS, HEADER_ROW,
      dataRow({ personNo: '00000174', authResult: 'Authorization', eventType: 'Access Granted by Fingerprint' }),
      dataRow({ personNo: '00000175', authResult: 'Failed', eventType: 'Fingerprint Does Not Exist' }),
      dataRow({ personNo: '00000176', authResult: 'Failed', eventType: 'Employee ID Does Not Exist' }),
    ]);
    const summary = summarizeHikCentralParseResult(result);
    expect(summary.authorizationCount).toBe(1);
    expect(summary.failedCount).toBe(2);
    expect(isEligibleSuccessfulEvent(result.rows[0])).toBe(true);
    expect(isEligibleSuccessfulEvent(result.rows[1])).toBe(false);
  });

  // 6. Successful row with missing Person No.
  it('preserves a successful event with no Person No. as a distinct, still-eligible row', async () => {
    const result = await parseRows([...METADATA_ROWS, HEADER_ROW, dataRow({ personNo: null })]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].hikcentralPersonNo).toBeNull();
    expect(isEligibleSuccessfulEvent(result.rows[0])).toBe(true);
    const summary = summarizeHikCentralParseResult(result);
    expect(summary.withoutPersonNoCount).toBe(1);
    expect(summary.withPersonNoCount).toBe(0);
  });

  // 7. Malformed timestamp
  it('rejects a malformed Time value as a row-level error, not a thrown exception', async () => {
    const result = await parseRows([...METADATA_ROWS, HEADER_ROW, dataRow({ time: 'not-a-real-timestamp' })]);
    expect(result.rows).toHaveLength(0);
    expect(result.rowErrors).toHaveLength(1);
    expect(result.rowErrors[0].message).toMatch(/Time/);
  });

  it('rejects an impossible calendar date (2026-02-30) as malformed, not silently normalized', () => {
    expect(parseHikCentralTimeToUtcIso('2026-02-30 07:27:44')).toBeNull();
  });

  // 8. Missing required column -> file-level error
  it('rejects the whole file when a required column is missing from the header row', async () => {
    const brokenHeader = HEADER_ROW.filter((h) => h !== 'Authentication Result');
    const buffer = await buildTestXlsx([...METADATA_ROWS, brokenHeader, dataRow({})]);
    const sheet = await readSheet(buffer, 1);
    expect(() => parseHikCentralSheet(sheet as unknown as SheetRow[])).toThrow(HikCentralFileError);
    expect(() => parseHikCentralSheet(sheet as unknown as SheetRow[])).toThrow(/Authentication Result/);
  });

  // 9. Empty workbook / no data rows
  it('rejects a file with a valid header but zero data rows', async () => {
    const buffer = await buildTestXlsx([...METADATA_ROWS, HEADER_ROW]);
    const sheet = await readSheet(buffer, 1);
    expect(() => parseHikCentralSheet(sheet as unknown as SheetRow[])).toThrow(/no data rows/);
  });

  it('rejects a completely empty workbook', async () => {
    const buffer = await buildTestXlsx([]);
    const sheet = await readSheet(buffer, 1);
    expect(() => parseHikCentralSheet(sheet as unknown as SheetRow[])).toThrow(HikCentralFileError);
  });

  it('reproduces the real sample file\'s exact observed statistics for an equivalent synthetic mix', async () => {
    // Mirrors (at small scale) the real distribution: 732 Authorization-
    // with-Person-No, 238 Authorization-without-Person-No, 306 Failed,
    // 71 unique Person Nos among the identified ones -- here as a 10-row
    // proportional analogue so the summary math itself is exercised
    // end-to-end, not because 10 rows literally reproduce 1,276.
    const rows = [
      dataRow({ personNo: '00000174' }),
      dataRow({ personNo: '00000174' }), // same person, second punch
      dataRow({ personNo: '00000175' }),
      dataRow({ personNo: null }),
      dataRow({ personNo: null }),
      dataRow({ authResult: 'Failed', eventType: 'Fingerprint Does Not Exist', personNo: null }),
      dataRow({ authResult: 'Failed', eventType: 'Employee ID Does Not Exist', personNo: null }),
    ];
    const result = await parseRows([...METADATA_ROWS, HEADER_ROW, ...rows]);
    const summary = summarizeHikCentralParseResult(result);
    expect(summary.totalRows).toBe(7);
    expect(summary.authorizationCount).toBe(5);
    expect(summary.failedCount).toBe(2);
    expect(summary.withPersonNoCount).toBe(3);
    expect(summary.withoutPersonNoCount).toBe(2);
    expect(summary.uniquePersonNoCount).toBe(2); // 00000174, 00000175
    expect(summary.accessPoints).toEqual(['MTL - CHICHIRI_Door_1']);
  });
});

describe('parseHikCentralTimeToUtcIso', () => {
  it('returns null for a non-date, non-string cell', () => {
    expect(parseHikCentralTimeToUtcIso(42)).toBeNull();
    expect(parseHikCentralTimeToUtcIso(true)).toBeNull();
    expect(parseHikCentralTimeToUtcIso(null)).toBeNull();
    expect(parseHikCentralTimeToUtcIso(undefined)).toBeNull();
  });

  it('interprets a date-typed cell (JS Date, UTC fields = naive wall clock) as Africa/Blantyre too', () => {
    // A hypothetical date-typed OOXML cell decoded to a Date whose UTC
    // fields are 2026-09-28 07:27:44 -- same interpretation as the
    // string case: treated as Africa/Blantyre wall time, i.e. 05:27:44Z.
    const cell = new Date(Date.UTC(2026, 8, 28, 7, 27, 44));
    expect(parseHikCentralTimeToUtcIso(cell)).toBe('2026-09-28T05:27:44.000Z');
  });
});
