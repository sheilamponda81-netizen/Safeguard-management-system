// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage A: pure,
// source-independent attendance CALCULATION engine.
//
// SCOPE: given one employee's resolved roster schedule for one shift
// occurrence, a list of already-normalized successful/authorized
// fingerprint scans, and an explicit, externally-supplied data-coverage
// statement, computes a single attendance result: Present, Late, Absent,
// Off, Unassigned, or Pending. Operates only on already-fetched plain
// data -- no Supabase calls, no knowledge of Excel columns, HikCentral
// device ids, or any other source-specific vocabulary. This is what lets
// today's Excel-import pipeline and a future HikCentral live-API
// integration share one calculation path: each source only needs a thin
// adapter that produces `NormalizedFingerprintEvent[]` (see
// attendanceFingerprintAdapters.ts for the Excel one) and an honest
// `ShiftCoverage` statement; this module never changes.
//
// NOT IN SCOPE (deliberately): writing to the `attendance` table, the
// existing official status codes ('P'/'A'/'L'/'LV'/'SL'/'-'), payroll,
// or any UI. PENDING is an internal result of THIS module only -- it is
// never a value that belongs in `attendance.status`.
//
// Reuses DAY_SHIFT/NIGHT_SHIFT and the Africa/Blantyre offset already
// defined elsewhere instead of redeclaring the business numbers here.
import { DAY_SHIFT, NIGHT_SHIFT, ResolvedSchedule, addDays } from './rosterSchedule';
import { AFRICA_BLANTYRE_OFFSET_MINUTES } from './hikcentralExcelParser';

/**
 * One already-confirmed successful, authorized fingerprint scan, already
 * resolved to a single employee. Any source-specific notion of "was this
 * scan denied / unauthorized / unclear" must be resolved by the caller's
 * adapter BEFORE events reach this module -- the engine itself has no
 * concept of authentication result strings, event-type strings, or
 * device/terminal identity, which is exactly what keeps it reusable
 * across fingerprint sources.
 */
export interface NormalizedFingerprintEvent {
  /** UTC instant, ISO 8601 (e.g. a HikCentral event's parsed `eventTimeIso`). */
  timestampIso: string;
}

export type CoverageStatus = 'confirmed_complete' | 'insufficient';

/**
 * An explicit statement from the caller about how far fingerprint data is
 * known to be complete for this employee's relevant device(s)/site, as of
 * whatever moment the calculation is being run. This can NEVER be derived
 * inside this module from the scan timestamps it was given (a shift with
 * zero scans and a shift that is merely under-covered by an incomplete
 * export look identical from the event list alone) -- per the confirmed
 * investigation, no existing HikCentral Excel parser or import-batch
 * field (export-generation time, device scope, etc.) currently captures
 * this trustworthily, so it is the caller's responsibility to supply it
 * honestly. Device/site scope verification itself is also the caller's
 * responsibility: `verifiedThroughIso` is taken to already mean "coverage
 * for this employee's relevant terminal(s)" -- see the Stage A report's
 * limitations section for why this cannot be enforced here today.
 */
export interface ShiftCoverage {
  status: CoverageStatus;
  /**
   * Required when status is 'confirmed_complete'. The UTC instant up to
   * which data is verified complete -- in practice, the explicitly
   * supplied HikCentral Excel export's own cutoff/generation timestamp
   * (never inferred inside this module from the latest fingerprint event
   * it was handed; see earliestEventInWindow/calculateAttendanceStatus,
   * neither of which reads this field at all). Ignored when status is
   * 'insufficient'. When this is earlier than a shift's checkout window
   * end, that shift's export is an EARLY export for that shift -- see
   * calculateAttendanceStatus's early-export credit rule below.
   */
  verifiedThroughIso?: string;
}

export type AttendanceCalculationStatus = 'present' | 'late' | 'absent' | 'off' | 'unassigned' | 'pending';

/**
 * Distinguishes HOW a 'present'/'late' result was reached, without
 * introducing a new official attendance status code (the existing
 * `attendance.status` CHECK constraint is untouched by Stage A and
 * never sees this value):
 *  - 'confirmed': both a valid check-in and a valid checkout were found.
 *  - 'check_in_only_provisional': credited under the early-export rule --
 *    a valid check-in was found, but the checkout window is not yet
 *    confirmed closed, so there has been no opportunity to observe a
 *    checkout at all yet. This is provisional: recalculating once a
 *    later, more complete export arrives applies the normal rules again
 *    and can still resolve to 'absent' if the checkout window closes
 *    with no checkout ever recorded.
 *  - 'not_applicable': every other status (off/unassigned/pending/absent).
 */
export type AttendanceCalculationBasis = 'confirmed' | 'check_in_only_provisional' | 'not_applicable';

export interface AttendanceCalculationInput {
  /** The shift's own STARTING calendar date (Africa/Blantyre), YYYY-MM-DD -- a Night shift belongs to this date even though its checkout window falls on the next calendar date. */
  shiftDate: string;
  resolvedShift: ResolvedSchedule;
  /** This employee's successful/authorized scans in a reasonably wide surrounding window; the engine does its own windowing and ignores anything outside the applicable check-in/checkout windows. */
  events: NormalizedFingerprintEvent[];
  coverage: ShiftCoverage;
}

export interface AttendanceCalculationResult {
  status: AttendanceCalculationStatus;
  checkInIso: string | null;
  checkOutIso: string | null;
  reason: string;
  basis: AttendanceCalculationBasis;
}

function blantyreDateTimeToUtcIso(dateStr: string, hhmm: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const utcMillis = Date.UTC(y, m - 1, d, hh, mm, 0) - AFRICA_BLANTYRE_OFFSET_MINUTES * 60_000;
  return new Date(utcMillis).toISOString();
}

interface ShiftWindows {
  checkInWindowStartIso: string;
  checkInWindowEndIso: string;
  checkOutWindowStartIso: string;
  checkOutWindowEndIso: string;
  lateAfterIso: string;
}

/** Exported so the later read-only preview stage and tests can display/assert on the exact boundaries this engine is using, without recomputing them independently. */
export function getShiftWindows(resolvedShift: 'day' | 'night', shiftDate: string): ShiftWindows {
  const shift = resolvedShift === 'day' ? DAY_SHIFT : NIGHT_SHIFT;
  // Both shifts' check-in windows fall on the shift's own starting date.
  // Only a Night shift's checkout window crosses onto the next date.
  const checkOutDate = resolvedShift === 'night' ? addDays(shiftDate, 1) : shiftDate;
  return {
    checkInWindowStartIso: blantyreDateTimeToUtcIso(shiftDate, shift.validCheckInWindow[0]),
    checkInWindowEndIso: blantyreDateTimeToUtcIso(shiftDate, shift.validCheckInWindow[1]),
    checkOutWindowStartIso: blantyreDateTimeToUtcIso(checkOutDate, shift.validCheckOutWindow[0]),
    checkOutWindowEndIso: blantyreDateTimeToUtcIso(checkOutDate, shift.validCheckOutWindow[1]),
    lateAfterIso: blantyreDateTimeToUtcIso(shiftDate, shift.lateAfter),
  };
}

/** The earliest event's timestamp falling within [startIso, endIso] inclusive, or null if none. ISO 8601 UTC strings of the same fixed-width format sort lexicographically, same convention already relied on elsewhere in this codebase. */
function earliestEventInWindow(events: NormalizedFingerprintEvent[], startIso: string, endIso: string): string | null {
  let earliest: string | null = null;
  for (const e of events) {
    if (e.timestampIso < startIso || e.timestampIso > endIso) continue;
    if (earliest === null || e.timestampIso < earliest) earliest = e.timestampIso;
  }
  return earliest;
}

/**
 * The single calculation entry point. Pure and stateless: calling it
 * again later with a superset of events and an updated (now-sufficient)
 * coverage statement simply produces an updated, correct result -- there
 * is no "previous calculation" state anywhere for recalculation to
 * conflict with, which is what satisfies the no-duplicate-decisions
 * requirement at this layer (an actual write path's own duplicate
 * prevention, e.g. an upsert on (employee, date), is a later-stage
 * concern, out of scope for Stage A).
 */
export function calculateAttendanceStatus(input: AttendanceCalculationInput): AttendanceCalculationResult {
  const { resolvedShift, shiftDate, events, coverage } = input;

  if (resolvedShift === 'off') {
    return { status: 'off', checkInIso: null, checkOutIso: null, reason: 'Scheduled Off day.', basis: 'not_applicable' };
  }
  if (resolvedShift === 'unassigned') {
    return { status: 'unassigned', checkInIso: null, checkOutIso: null, reason: 'No roster assignment recorded for this date.', basis: 'not_applicable' };
  }

  const windows = getShiftWindows(resolvedShift, shiftDate);
  const checkInIso = earliestEventInWindow(events, windows.checkInWindowStartIso, windows.checkInWindowEndIso);
  const checkOutIso = earliestEventInWindow(events, windows.checkOutWindowStartIso, windows.checkOutWindowEndIso);

  if (checkInIso && checkOutIso) {
    const status: AttendanceCalculationStatus = checkInIso <= windows.lateAfterIso ? 'present' : 'late';
    const reason =
      status === 'present'
        ? 'Valid check-in within grace period and valid checkout recorded.'
        : 'Valid checkout recorded, but check-in was after the grace period.';
    return { status, checkInIso, checkOutIso, reason, basis: 'confirmed' };
  }

  // One or both of check-in/checkout are missing. Per the confirmed
  // completeness requirement, this can only be finalized as Absent once
  // the LATEST relevant window (the checkout window, which always closes
  // after the check-in window for both Day and Night) is confirmed
  // closed by verified coverage -- otherwise the missing piece might
  // simply not have happened yet, or might exist but not yet be covered
  // by verified data.
  const checkOutWindowConfirmedClosed =
    coverage.status === 'confirmed_complete' &&
    coverage.verifiedThroughIso !== undefined &&
    coverage.verifiedThroughIso >= windows.checkOutWindowEndIso;

  if (!checkOutWindowConfirmedClosed) {
    // EARLY EXPORT RULE: the export/coverage cutoff is before this
    // shift's checkout window has closed (or coverage is simply
    // unknown), so there has been no opportunity yet to observe a
    // checkout at all -- its absence carries no information. A valid,
    // already-observed check-in is real data regardless, though, and is
    // credited immediately using the same grace-period rule as a fully
    // confirmed day: Present (on time) or Late (after grace), never held
    // back as Pending merely because the checkout side of the shift
    // hasn't happened/been exported yet. This is provisional -- recalculating
    // with a later, complete export re-runs the normal rules below and
    // can still resolve to Absent if no checkout is ever found once the
    // window genuinely closes. Only the no-check-in case remains Pending
    // here: a missing check-in is NEVER assumed Absent before coverage
    // is confirmed, per the base completeness rule.
    if (checkInIso) {
      const status: AttendanceCalculationStatus = checkInIso <= windows.lateAfterIso ? 'present' : 'late';
      const reason =
        status === 'present'
          ? 'Valid check-in within grace period; credited Present under the early-export policy pending checkout window closure (no checkout observed yet).'
          : 'Check-in was after the grace period; credited Late under the early-export policy pending checkout window closure (no checkout observed yet).';
      return { status, checkInIso, checkOutIso: null, reason, basis: 'check_in_only_provisional' };
    }
    return {
      status: 'pending',
      checkInIso: null,
      checkOutIso: null,
      reason: 'No valid check-in recorded yet -- the check-in window is not yet confirmed closed or data coverage is insufficient.',
      basis: 'not_applicable',
    };
  }

  if (checkInIso && !checkOutIso) {
    return { status: 'absent', checkInIso, checkOutIso: null, reason: 'Valid check-in recorded, but no valid checkout was recorded after the checkout window closed.', basis: 'not_applicable' };
  }
  if (!checkInIso && checkOutIso) {
    return { status: 'absent', checkInIso: null, checkOutIso, reason: 'Valid checkout recorded, but no valid check-in was recorded.', basis: 'not_applicable' };
  }
  return { status: 'absent', checkInIso: null, checkOutIso: null, reason: 'No valid fingerprint scans recorded for this scheduled shift after data coverage was confirmed complete.', basis: 'not_applicable' };
}
