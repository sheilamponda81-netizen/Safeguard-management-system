// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage A/B: the ONLY
// source-specific file in this feature. Converts already-fetched
// HikCentral rows -- from an Excel parse (Stage A) or from the
// `hikcentral_raw_events` table (Stage B's preview) -- into the
// attendance calculation engine's source-independent
// `NormalizedFingerprintEvent[]` shape.
//
// This is where source-specific filtering belongs (today: Excel column
// values like "Authentication Result" / "Event Type", or the already-
// ingested DB row shape; later: whatever a live HikCentral API call
// returns) -- the calculation engine itself must never know these
// vocabularies. A future HikCentral API integration needs only its own
// adapter of this same shape; the engine in attendanceCalculationEngine.ts
// does not change.
import { ParsedHikCentralRow, isEligibleSuccessfulEvent } from './hikcentralExcelParser';
import { NormalizedFingerprintEvent } from './attendanceCalculationEngine';

/**
 * Filters a batch of parsed HikCentral rows down to one employee's
 * successful, authorized scans only (denied/failed/unrecognized rows are
 * dropped here, using the existing eligibility classifier -- never
 * re-implemented), matched by HikCentral person number.
 */
export function normalizeHikCentralRowsForEmployee(
  rows: ParsedHikCentralRow[],
  hikcentralPersonNo: string
): NormalizedFingerprintEvent[] {
  return rows
    .filter((row) => row.hikcentralPersonNo === hikcentralPersonNo && isEligibleSuccessfulEvent(row))
    .map((row) => ({ timestampIso: row.eventTimeIso }));
}

/**
 * Converts already-mapped, already-stored HikCentral raw-event rows
 * (one employee's scans, already joined via an active Person Mapping --
 * see attendanceCalculationPreviewService.ts) into normalized events.
 * No eligibility re-filtering happens here: `import_hikcentral_raw_events`
 * (supabase/migrations/20261007010000_hikcentral_anonymous_fingerprint_cross_file_fix.sql)
 * only ever inserts rows where authentication_result IN ('Authorization',
 * 'Authorized') AND event_type = 'Access Granted by Fingerprint' -- every
 * row that reaches this table is already a successful, authorized scan,
 * so re-applying isEligibleSuccessfulEvent here would be redundant (and
 * wrong, since these DB rows don't carry the Excel-specific
 * authenticationResult/eventType fields `isEligibleSuccessfulEvent`
 * reads -- it is deliberately NOT called on this path).
 */
export function normalizeStoredFingerprintEventsForEmployee(
  rows: { employeeId: string; eventTimeIso: string }[],
  employeeId: string
): NormalizedFingerprintEvent[] {
  return rows.filter((row) => row.employeeId === employeeId).map((row) => ({ timestampIso: row.eventTimeIso }));
}
