// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readHikCentralWorkbookGrid } from './hikcentralOoxmlReader';
import { buildTestXlsx, XlsxRow } from './testFixtures/buildTestXlsx';
import {
  parseHikCentralSheet,
  parseHikCentralTimeToUtcIso,
  summarizeHikCentralParseResult,
  isEligibleSuccessfulEvent,
  HikCentralFileError,
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
  const sheet = await readHikCentralWorkbookGrid(buffer);
  return parseHikCentralSheet(sheet);
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
    const sheet = await readHikCentralWorkbookGrid(buffer);
    expect(() => parseHikCentralSheet(sheet)).toThrow(HikCentralFileError);
    expect(() => parseHikCentralSheet(sheet)).toThrow(/Authentication Result/);
  });

  // 9. Empty workbook / no data rows
  it('rejects a file with a valid header but zero data rows', async () => {
    const buffer = await buildTestXlsx([...METADATA_ROWS, HEADER_ROW]);
    const sheet = await readHikCentralWorkbookGrid(buffer);
    expect(() => parseHikCentralSheet(sheet)).toThrow(/no data rows/);
  });

  it('rejects a completely empty workbook', async () => {
    const buffer = await buildTestXlsx([]);
    const sheet = await readHikCentralWorkbookGrid(buffer);
    expect(() => parseHikCentralSheet(sheet)).toThrow(HikCentralFileError);
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

  // Pre-STAGING integrity review item 6: reproduce the REAL file's exact
  // aggregate statistics at full scale (not just proportionally), since
  // no copy of the real production file exists in this environment (it
  // was never uploaded/committed here, per the review's explicit
  // instruction not to). This is the closest available validation: a
  // synthetic file built to the exact stated real-world counts.
  it('reproduces the REAL sample file\'s exact aggregate statistics at full scale: 1,276 rows / 970 Authorization / 306 Failed / 732 successful-identified / 238 successful-anonymous / 71 unique identified Person Nos', async () => {
    const rows: XlsxRow[] = [];

    // 732 successful, identified events across exactly 71 unique Person Nos.
    for (let i = 0; i < 732; i++) {
      const personNo = String(174 + (i % 71)).padStart(8, '0');
      rows.push(dataRow({ personNo }));
    }
    // 238 successful events with no Person No.
    for (let i = 0; i < 238; i++) {
      rows.push(dataRow({ personNo: null }));
    }
    // 306 Failed events (mix of the real export's observed failure types).
    const failureTypes = ['Fingerprint Does Not Exist', 'Employee ID Does Not Exist', 'Authentication Mode Mismatch'];
    for (let i = 0; i < 306; i++) {
      rows.push(dataRow({ authResult: 'Failed', eventType: failureTypes[i % failureTypes.length], personNo: null }));
    }

    expect(rows).toHaveLength(1276);

    const result = await parseRows([...METADATA_ROWS, HEADER_ROW, ...rows]);
    const summary = summarizeHikCentralParseResult(result);

    expect(summary.totalRows).toBe(1276);
    expect(summary.authorizationCount).toBe(970); // 732 + 238
    expect(summary.failedCount).toBe(306);
    expect(summary.withPersonNoCount).toBe(732);
    expect(summary.withoutPersonNoCount).toBe(238);
    expect(summary.uniquePersonNoCount).toBe(71);
    expect(summary.rowErrorCount).toBe(0);
  });

  it('preserves Person No. "00000174" exactly (the real export\'s documented example) even inside a full-scale 1,276-row file', async () => {
    const rows: XlsxRow[] = [dataRow({ personNo: '00000174', firstName: 'ALEX', lastName: 'SAID', time: '2026-09-28 07:27:44', accessPoint: 'MTL - CHICHIRI_Door_1' })];
    for (let i = 0; i < 1275; i++) rows.push(dataRow({ personNo: String(175 + i).padStart(8, '0') }));
    const result = await parseRows([...METADATA_ROWS, HEADER_ROW, ...rows]);
    expect(result.rows[0].hikcentralPersonNo).toBe('00000174');
    expect(result.rows[0].eventTimeIso).toBe('2026-09-28T05:27:44.000Z'); // Africa/Blantyre -> UTC
  });

  it('raw_payload never contains "Captured Picture" or "Profile" -- this table must not quietly become an image-storage table', async () => {
    const result = await parseRows([...METADATA_ROWS, HEADER_ROW, dataRow({})]);
    const rawPayload = result.rows[0].rawPayload;
    expect(rawPayload).not.toHaveProperty('Captured Picture');
    expect(rawPayload).not.toHaveProperty('Profile');
    expect(rawPayload).not.toHaveProperty('Skin-Surface Temperature');
    expect(rawPayload).not.toHaveProperty('Mask Wearing Status');
    // Only the known textual/event-metadata columns should be present.
    expect(Object.keys(rawPayload).sort()).toEqual(
      ['Access Point', 'Attendance Type', 'Authentication Result', 'Card Reader', 'Event Type', 'First Name', 'Last Name', 'Person No.', 'Time'].sort()
    );
  });

  // Regression coverage for a real production bug (2026-10-06): a genuine
  // HikCentral "Person Authentication Record" export's Authentication
  // Result column literally contains "Authorized", never "Authorization"
  // -- confirmed against the real workbook's raw XML (every text cell is
  // an inline string; the value "Authorization" does not appear anywhere
  // in the sheet). The parser previously checked only for "Authorization",
  // so every single row in a real export was misclassified as Failed
  // (0 Authorization, 100% Failed, 0 for every Person-No.-derived stat)
  // even though the file's own Access Point/Time/row-count columns were
  // read correctly throughout -- see isEligibleSuccessfulEvent.
  describe('real-world "Authorized" literal (2026-10-06 regression)', () => {
    it('classifies a row with the genuine "Authorized" literal (not "Authorization") as eligible/successful', async () => {
      const result = await parseRows([
        ...METADATA_ROWS, HEADER_ROW,
        dataRow({ personNo: '00000104', authResult: 'Authorized', eventType: 'Access Granted by Fingerprint' }),
      ]);
      expect(isEligibleSuccessfulEvent(result.rows[0])).toBe(true);
      const summary = summarizeHikCentralParseResult(result);
      expect(summary.authorizationCount).toBe(1);
      expect(summary.failedCount).toBe(0);
    });

    it('still classifies the previously-assumed "Authorization" literal as eligible/successful (back-compat with pre-existing fixtures/tests)', async () => {
      const result = await parseRows([...METADATA_ROWS, HEADER_ROW, dataRow({ authResult: 'Authorization' })]);
      expect(isEligibleSuccessfulEvent(result.rows[0])).toBe(true);
    });

    it('keeps a "Failed" / "Fingerprint Does Not Exist" row classified as Failed, never matched by the "Authorized" fix', async () => {
      const result = await parseRows([
        ...METADATA_ROWS, HEADER_ROW,
        dataRow({ personNo: null, authResult: 'Failed', eventType: 'Fingerprint Does Not Exist' }),
      ]);
      expect(isEligibleSuccessfulEvent(result.rows[0])).toBe(false);
      const summary = summarizeHikCentralParseResult(result);
      expect(summary.authorizationCount).toBe(0);
      expect(summary.failedCount).toBe(1);
    });

    // Reproduces the real file's exact aggregate statistics at full scale,
    // confirmed against the genuine uploaded workbook (349 rows; this
    // test uses only synthetic names/IDs, per this file's existing
    // no-real-employee-data convention -- see the header comment above).
    it('reproduces the REAL "Authorized"-literal file\'s exact aggregate statistics: 349 rows / 223 Authorized / 126 Failed / 175 with Person No. (29 unique) among successful events', async () => {
      const rows: XlsxRow[] = [];

      // 175 successful, identified events across exactly 29 unique Person Nos.
      for (let i = 0; i < 175; i++) {
        const personNo = String(1 + (i % 29)).padStart(8, '0');
        rows.push(dataRow({ personNo, authResult: 'Authorized' }));
      }
      // 48 successful events with no Person No. (card-granted access with
      // no fingerprint-identified person -- the real file's "anonymous
      // successful" rows).
      for (let i = 0; i < 48; i++) {
        rows.push(dataRow({ personNo: null, authResult: 'Authorized' }));
      }
      // 126 Failed events, all "Fingerprint Does Not Exist" with no
      // Person No. -- matches the real file exactly (every Failed row in
      // the genuine export has a blank Person No.).
      for (let i = 0; i < 126; i++) {
        rows.push(dataRow({ personNo: null, authResult: 'Failed', eventType: 'Fingerprint Does Not Exist' }));
      }

      expect(rows).toHaveLength(349);

      const result = await parseRows([...METADATA_ROWS, HEADER_ROW, ...rows]);
      const summary = summarizeHikCentralParseResult(result);

      expect(summary.totalRows).toBe(349);
      expect(summary.authorizationCount).toBe(223); // 175 + 48
      expect(summary.failedCount).toBe(126);
      expect(summary.withPersonNoCount).toBe(175);
      expect(summary.withoutPersonNoCount).toBe(48); // among successful events only -- see hikcentralExcelParser.ts's isEligibleSuccessfulEvent/summarizeHikCentralParseResult
      expect(summary.uniquePersonNoCount).toBe(29);
      expect(summary.rowErrorCount).toBe(0);
    });
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
