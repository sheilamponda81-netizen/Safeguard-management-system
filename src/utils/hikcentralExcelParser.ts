// HikCentral Attendance MVP -- Phase 1: Excel parser.
//
// Pure/testable: everything here operates on an already-read grid of
// cell values (or a raw file buffer for the top-level entry point) and
// returns plain data -- no Supabase calls, no DOM/File API assumptions
// beyond what the caller already resolved into a buffer. Ingestion (the
// server-authoritative RPC call) is a separate concern, see
// src/utils/hikcentralIngestion.ts.
//
// TIMEZONE (approved product decision 8): HikCentral export times such
// as "2026-09-28 07:27:44" carry NO timezone marker. They are ALWAYS
// interpreted as Africa/Blantyre, which is a fixed UTC+02:00 offset with
// no daylight-saving rules (Malawi has never observed DST) -- so this is
// a constant offset, not a timezone-database lookup. This module never
// uses `new Date(string)` (locale/host-timezone-dependent) or the
// browser/server's local timezone for this conversion; the wall-clock
// components are parsed explicitly and the UTC instant is computed by
// subtracting the fixed offset by hand.

const REQUIRED_HEADERS = [
  'Person No.',
  'First Name',
  'Last Name',
  'Time',
  'Access Point',
  'Card Reader',
  'Authentication Result',
  'Event Type',
] as const;

// Present in the real export but not required for this MVP to function
// (Attendance Type is always 'Undefined' today -- see the ingestion
// migration's header). Read into rawPayload if present, never required.
const OPTIONAL_KNOWN_HEADERS = ['Attendance Type'] as const;

const MAX_HEADER_SCAN_ROWS = 20;
const AFRICA_BLANTYRE_OFFSET_MINUTES = 2 * 60; // UTC+02:00, no DST

export type SheetCell = string | number | boolean | Date | null | undefined;
export type SheetRow = SheetCell[];

export class HikCentralFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HikCentralFileError';
  }
}

export interface RowValidationError {
  /** 1-based row number in the original file, for a user-facing error message. */
  rowNumber: number;
  message: string;
}

export interface ParsedHikCentralRow {
  rowNumber: number;
  hikcentralPersonNo: string | null;
  firstName: string | null;
  lastName: string | null;
  /** ISO 8601 UTC instant, converted from the Africa/Blantyre wall-clock time. */
  eventTimeIso: string;
  accessPoint: string | null;
  cardReader: string | null;
  authenticationResult: string;
  eventType: string;
  attendanceType: string | null;
  /** Every column from the header row, keyed by header text, verbatim cell values. */
  rawPayload: Record<string, SheetCell>;
}

export interface HikCentralParseResult {
  headerRowIndex: number;
  rows: ParsedHikCentralRow[];
  rowErrors: RowValidationError[];
}

/** Preserves "00000174" exactly. Never re-derives digits from a numeric cell value. */
function cellToPersonNo(cell: SheetCell): string | null {
  if (cell === null || cell === undefined) return null;
  const text = String(cell).trim();
  return text === '' ? null : text;
}

function cellToText(cell: SheetCell): string | null {
  if (cell === null || cell === undefined) return null;
  const text = String(cell).trim();
  return text === '' ? null : text;
}

/**
 * Scans the first MAX_HEADER_SCAN_ROWS rows for the one containing every
 * REQUIRED_HEADERS value as an exact (trimmed) cell match. Does not
 * assume any fixed row index -- the real export's metadata block has
 * been observed at rows 1-6 with headers at row 8, but a future export
 * version changing that length must not break this.
 */
function findHeaderRow(sheet: SheetRow[]): { rowIndex: number; headerNameToColumnIndex: Map<string, number> } {
  const scanLimit = Math.min(sheet.length, MAX_HEADER_SCAN_ROWS);
  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex++) {
    const row = sheet[rowIndex] || [];
    const headerNameToColumnIndex = new Map<string, number>();
    for (let colIndex = 0; colIndex < row.length; colIndex++) {
      const text = cellToText(row[colIndex]);
      // Duplicate header names (the real export has "Captured Picture"
      // twice): first occurrence wins. We never look up a duplicated
      // name for any required/optional column, so this never matters in
      // practice -- it's here purely so the map has deterministic,
      // documented behavior rather than silently overwriting.
      if (text && !headerNameToColumnIndex.has(text)) {
        headerNameToColumnIndex.set(text, colIndex);
      }
    }
    const hasAllRequired = REQUIRED_HEADERS.every((h) => headerNameToColumnIndex.has(h));
    if (hasAllRequired) {
      return { rowIndex, headerNameToColumnIndex };
    }
  }
  throw new HikCentralFileError(
    `Could not find a header row containing all required columns (${REQUIRED_HEADERS.join(', ')}) ` +
    `within the first ${scanLimit} rows of the file.`
  );
}

/**
 * Parses a HikCentral "Time" cell as an explicit Africa/Blantyre
 * (UTC+02:00, no DST) wall-clock value and returns the equivalent UTC
 * instant as an ISO 8601 string. Returns null (never throws) for a
 * malformed value -- callers turn that into a row-level error, not a
 * file-level abort.
 */
export function parseHikCentralTimeToUtcIso(cell: SheetCell): string | null {
  let year: number, month: number, day: number, hour: number, minute: number, second: number;

  if (cell instanceof Date) {
    // A date-typed OOXML cell decodes (per every mainstream XLSX reader,
    // including read-excel-file) to a JS Date whose UTC fields carry the
    // spreadsheet's naive wall-clock components -- Excel serial dates
    // have no timezone of their own. We read those UTC fields as the
    // Africa/Blantyre wall clock, never the Date object's own instant
    // (which would silently apply UTC, not +02:00, if used directly).
    year = cell.getUTCFullYear();
    month = cell.getUTCMonth() + 1;
    day = cell.getUTCDate();
    hour = cell.getUTCHours();
    minute = cell.getUTCMinutes();
    second = cell.getUTCSeconds();
  } else if (typeof cell === 'string') {
    const match = cell.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
    hour = Number(match[4]);
    minute = Number(match[5]);
    second = Number(match[6]);
  } else {
    // A bare number (unrecognized Excel serial date, no date formatting
    // detected by the parser) is deliberately treated as malformed
    // rather than guessed at -- there is no safe way to know it was
    // intended as a date at all without the cell's number format, which
    // read-excel-file's raw grid mode does not expose.
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - AFRICA_BLANTYRE_OFFSET_MINUTES * 60_000;
  const result = new Date(utcMillis);
  // Date.UTC silently normalizes an out-of-range value (e.g. day=32) into
  // the next month instead of erroring -- re-derive the UTC calendar
  // fields (BEFORE re-applying the offset) and compare, so "2026-02-30"
  // is rejected as malformed instead of silently becoming 2026-03-02.
  const localCheck = new Date(utcMillis + AFRICA_BLANTYRE_OFFSET_MINUTES * 60_000);
  if (
    localCheck.getUTCFullYear() !== year ||
    localCheck.getUTCMonth() + 1 !== month ||
    localCheck.getUTCDate() !== day
  ) {
    return null;
  }

  return result.toISOString();
}

/**
 * Parses an already-loaded HikCentral export grid (e.g. the output of
 * `readSheet()` from read-excel-file) into classified rows + row-level
 * errors. Throws HikCentralFileError only for FILE-level problems
 * (missing required column, no data rows at all) -- never for a single
 * bad row, which becomes a RowValidationError instead.
 */
export function parseHikCentralSheet(sheet: SheetRow[]): HikCentralParseResult {
  if (!sheet || sheet.length === 0) {
    throw new HikCentralFileError('The uploaded file has no rows at all.');
  }

  const { rowIndex: headerRowIndex, headerNameToColumnIndex } = findHeaderRow(sheet);

  const allKnownHeaders = [...REQUIRED_HEADERS, ...OPTIONAL_KNOWN_HEADERS];
  const dataRows = sheet.slice(headerRowIndex + 1);

  if (dataRows.every((row) => !row || row.every((c) => c === null || c === undefined || c === ''))) {
    throw new HikCentralFileError('The file has a valid header row but no data rows beneath it.');
  }

  const personNoCol = headerNameToColumnIndex.get('Person No.')!;
  const firstNameCol = headerNameToColumnIndex.get('First Name')!;
  const lastNameCol = headerNameToColumnIndex.get('Last Name')!;
  const timeCol = headerNameToColumnIndex.get('Time')!;
  const accessPointCol = headerNameToColumnIndex.get('Access Point')!;
  const cardReaderCol = headerNameToColumnIndex.get('Card Reader')!;
  const authResultCol = headerNameToColumnIndex.get('Authentication Result')!;
  const eventTypeCol = headerNameToColumnIndex.get('Event Type')!;
  const attendanceTypeCol = headerNameToColumnIndex.get('Attendance Type');

  const rows: ParsedHikCentralRow[] = [];
  const rowErrors: RowValidationError[] = [];

  dataRows.forEach((row, offset) => {
    const rowNumber = headerRowIndex + 2 + offset; // 1-based, matching the original file
    const isBlankRow = !row || row.every((c) => c === null || c === undefined || c === '');
    if (isBlankRow) return; // skip fully blank rows silently, not an error

    const authenticationResult = cellToText(row[authResultCol]);
    const eventType = cellToText(row[eventTypeCol]);
    const eventTimeIso = parseHikCentralTimeToUtcIso(row[timeCol]);

    if (!authenticationResult) {
      rowErrors.push({ rowNumber, message: 'Missing Authentication Result.' });
      return;
    }
    if (!eventType) {
      rowErrors.push({ rowNumber, message: 'Missing Event Type.' });
      return;
    }
    if (!eventTimeIso) {
      rowErrors.push({ rowNumber, message: `Malformed or unparseable Time value: ${JSON.stringify(row[timeCol])}` });
      return;
    }

    const rawPayload: Record<string, SheetCell> = {};
    for (const header of allKnownHeaders) {
      const colIndex = headerNameToColumnIndex.get(header);
      if (colIndex !== undefined) rawPayload[header] = row[colIndex];
    }

    rows.push({
      rowNumber,
      hikcentralPersonNo: cellToPersonNo(row[personNoCol]),
      firstName: cellToText(row[firstNameCol]),
      lastName: cellToText(row[lastNameCol]),
      eventTimeIso,
      accessPoint: cellToText(row[accessPointCol]),
      cardReader: cellToText(row[cardReaderCol]),
      authenticationResult,
      eventType,
      attendanceType: attendanceTypeCol !== undefined ? cellToText(row[attendanceTypeCol]) : null,
      rawPayload,
    });
  });

  return { headerRowIndex, rows, rowErrors };
}

export interface HikCentralImportSummary {
  totalRows: number;
  authorizationCount: number;
  failedCount: number;
  withPersonNoCount: number;
  withoutPersonNoCount: number;
  uniquePersonNoCount: number;
  accessPoints: string[];
  dateRange: { earliest: string; latest: string } | null;
  rowErrorCount: number;
}

const SUCCESSFUL_EVENT_TYPE = 'Access Granted by Fingerprint';

export function isEligibleSuccessfulEvent(row: ParsedHikCentralRow): boolean {
  return row.authenticationResult === 'Authorization' && row.eventType === SUCCESSFUL_EVENT_TYPE;
}

export function summarizeHikCentralParseResult(result: HikCentralParseResult): HikCentralImportSummary {
  const { rows, rowErrors } = result;
  const successful = rows.filter(isEligibleSuccessfulEvent);
  const failed = rows.filter((r) => !isEligibleSuccessfulEvent(r));
  const withPersonNo = successful.filter((r) => r.hikcentralPersonNo !== null);
  const withoutPersonNo = successful.filter((r) => r.hikcentralPersonNo === null);
  const uniquePersonNos = new Set(withPersonNo.map((r) => r.hikcentralPersonNo));
  const accessPoints = new Set<string>();
  rows.forEach((r) => { if (r.accessPoint) accessPoints.add(r.accessPoint); });

  let earliest: string | null = null;
  let latest: string | null = null;
  for (const r of rows) {
    if (earliest === null || r.eventTimeIso < earliest) earliest = r.eventTimeIso;
    if (latest === null || r.eventTimeIso > latest) latest = r.eventTimeIso;
  }

  return {
    totalRows: rows.length + rowErrors.length,
    authorizationCount: successful.length,
    failedCount: failed.length,
    withPersonNoCount: withPersonNo.length,
    withoutPersonNoCount: withoutPersonNo.length,
    uniquePersonNoCount: uniquePersonNos.size,
    accessPoints: Array.from(accessPoints).sort(),
    dateRange: earliest && latest ? { earliest, latest } : null,
    rowErrorCount: rowErrors.length,
  };
}
