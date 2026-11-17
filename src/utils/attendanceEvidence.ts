// Safeguard HikCentral Attendance MVP -- Attendance Evidence Centre,
// read-only v1: pure, DB-free classification and summary helpers.
//
// SCOPE: this module adds NO new attendance rule of its own. It never
// recomputes "is this employee Absent/Present/Late" -- that remains
// exclusively calculateAttendanceStatus's job (attendanceCalculationEngine.ts,
// unmodified by this PR). What this module does is explain, for a
// single employee-day, WHY each individual raw fingerprint scan either
// became the matched check-in/checkout or was excluded, in plain
// language -- the thing the existing calculation result (which only
// returns the two winning timestamps, not the full candidate list) does
// not surface on its own.
import { NormalizedFingerprintEvent } from './attendanceCalculationEngine';

export interface ShiftWindowBounds {
  checkInWindowStartIso: string;
  checkInWindowEndIso: string;
  checkOutWindowStartIso: string;
  checkOutWindowEndIso: string;
}

export type ClassifiedEventRole = 'matched_check_in' | 'matched_check_out' | 'excluded';

export interface ClassifiedEvidenceEvent {
  timestampIso: string;
  accessPoint: string | null;
  role: ClassifiedEventRole;
  /** Null for a matched event; always a plain-language reason for an excluded one. */
  excludedReason: string | null;
}

/**
 * Classifies every raw event considered for one employee-day against the
 * engine's own matched check-in/checkout (already computed by
 * calculateAttendanceStatus -- never recomputed here). An event that
 * falls inside a window but isn't the one the engine picked is a real,
 * later-or-equal duplicate scan in that same window ("earliest wins" is
 * the engine's own rule, attendanceCalculationEngine.ts's
 * earliestEventInWindow) -- never silently dropped from this view, and
 * never relabeled as if it were an error.
 */
export function classifyRawEventsForEvidence(
  events: Array<NormalizedFingerprintEvent & { accessPoint: string | null }>,
  windows: ShiftWindowBounds,
  checkInIso: string | null,
  checkOutIso: string | null
): ClassifiedEvidenceEvent[] {
  return events
    .slice()
    .sort((a, b) => (a.timestampIso < b.timestampIso ? -1 : a.timestampIso > b.timestampIso ? 1 : 0))
    .map((event) => {
      if (checkInIso !== null && event.timestampIso === checkInIso) {
        return { timestampIso: event.timestampIso, accessPoint: event.accessPoint, role: 'matched_check_in' as const, excludedReason: null };
      }
      if (checkOutIso !== null && event.timestampIso === checkOutIso) {
        return { timestampIso: event.timestampIso, accessPoint: event.accessPoint, role: 'matched_check_out' as const, excludedReason: null };
      }

      const inCheckInWindow = event.timestampIso >= windows.checkInWindowStartIso && event.timestampIso <= windows.checkInWindowEndIso;
      const inCheckOutWindow = event.timestampIso >= windows.checkOutWindowStartIso && event.timestampIso <= windows.checkOutWindowEndIso;

      let excludedReason: string;
      if (inCheckInWindow) {
        excludedReason = 'Inside the valid check-in window, but a different (earlier) scan in the same window was used as the check-in.';
      } else if (inCheckOutWindow) {
        excludedReason = 'Inside the valid checkout window, but a different (earlier) scan in the same window was used as the checkout.';
      } else if (event.timestampIso < windows.checkInWindowStartIso) {
        excludedReason = 'Before the check-in window opens -- too early to count as a check-in for this shift.';
      } else if (event.timestampIso > windows.checkInWindowEndIso && event.timestampIso < windows.checkOutWindowStartIso) {
        excludedReason = 'Between the check-in and checkout windows -- outside both valid windows for this shift.';
      } else {
        excludedReason = 'After the checkout window closes -- too late to count as a checkout for this shift.';
      }
      return { timestampIso: event.timestampIso, accessPoint: event.accessPoint, role: 'excluded' as const, excludedReason };
    });
}

export type EvidenceCompleteness = 'both_found' | 'check_in_only' | 'check_out_only' | 'none_found';

/** Derived purely from the engine's own matched check-in/checkout -- never a second opinion on whether the pair is "valid", only whether each side was found at all. */
export function deriveEvidenceCompleteness(checkInIso: string | null, checkOutIso: string | null): EvidenceCompleteness {
  if (checkInIso !== null && checkOutIso !== null) return 'both_found';
  if (checkInIso !== null) return 'check_in_only';
  if (checkOutIso !== null) return 'check_out_only';
  return 'none_found';
}

export const EVIDENCE_COMPLETENESS_LABELS: Record<EvidenceCompleteness, string> = {
  both_found: 'Both check-in and checkout found',
  check_in_only: 'Check-in found, checkout not found',
  check_out_only: 'Checkout found, check-in not found',
  none_found: 'No fingerprint evidence found',
};
