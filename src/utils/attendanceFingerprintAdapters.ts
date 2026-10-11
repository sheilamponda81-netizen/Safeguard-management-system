// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage A: the ONLY
// source-specific file in this feature. Converts already-parsed
// HikCentral Excel rows into the attendance calculation engine's
// source-independent `NormalizedFingerprintEvent[]` shape.
//
// This is where source-specific filtering belongs (today: Excel column
// values like "Authentication Result" / "Event Type"; later: whatever a
// live HikCentral API call returns) -- the calculation engine itself
// must never know these vocabularies. A future HikCentral API
// integration needs only its own adapter of this same shape; the engine
// in attendanceCalculationEngine.ts does not change.
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
