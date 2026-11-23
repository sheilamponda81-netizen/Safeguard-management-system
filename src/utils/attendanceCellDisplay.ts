// Final roster/off-day display integrity review (screenshots: UPILE
// MWANYEKONDE, SFG-S-149). Pure logic behind the Monthly Register
// grid's cell display, extracted from Attendance.tsx's own
// getCellDisplayCode for direct unit testing -- no Supabase calls.
//
// THE PROBLEM: before this fix, a cell with no persisted `attendance`
// row always rendered as plain '-' (styled identically to a genuine
// scheduled Off day), because the grid read only the `attendance` table
// itself and defaulted to '-' whenever no row existed. That silently
// conflated three entirely different situations:
//   - a genuinely scheduled Off day (expected to have no row --
//     automatic processing never writes Off/Unassigned at all);
//   - an employee with NO roster configured for that date at all
//     (Unassigned -- a data-completeness gap, not a rest day);
//   - an ordinary SCHEDULED WORKING day that simply has not been
//     processed/imported yet (Pending).
//
// THE FIX: when no attendance row exists, resolve the roster's own
// schedule for that date using resolveScheduleForDate -- the EXACT
// SAME resolver Roster Management's Calendar and the server's
// attendance engine (roster_resolve_schedule) already use -- and
// display accordingly. This is DISPLAY ONLY: it never writes an
// attendance or payroll record merely to show a scheduled Off day, and
// it never changes what a grid click writes (Attendance.tsx's
// click-to-cycle handler still reads the real persisted status via
// getAttendanceStatus, completely independent of this function).
import { DateAssignmentRow, OffDayPatternRow, ShiftPatternRow, resolveScheduleForDate } from './rosterSchedule';

/**
 * 'UNASSIGNED' and 'PENDING' are DISPLAY-ONLY codes -- never written to
 * `attendance.status` (that CHECK constraint still only allows
 * P/A/L/LV/SL/-) and never read back from it. '-' continues to mean
 * Off exactly as before, but is now only shown for a date that
 * genuinely resolves 'off', never merely assumed from a blank row.
 */
export type AttendanceCellDisplayCode = 'P' | 'A' | 'L' | 'LV' | 'SL' | '-' | 'UNASSIGNED' | 'PENDING';

/**
 * `recordedStatus` is whatever the persisted `attendance` row's own
 * `status` column says (P/A/L/LV/SL/-), or undefined/null when no row
 * exists for this employee/date at all. A recorded status is ALWAYS
 * shown as-is -- this function only ever disambiguates the no-row case.
 */
export function resolveAttendanceCellDisplayCode(
  recordedStatus: string | null | undefined,
  employeeId: string,
  date: string,
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): AttendanceCellDisplayCode {
  if (recordedStatus) return recordedStatus as AttendanceCellDisplayCode;
  const resolved = resolveScheduleForDate(employeeId, date, datedAssignments, patterns, shiftPatterns);
  if (resolved === 'off') return '-';
  if (resolved === 'unassigned') return 'UNASSIGNED';
  return 'PENDING'; // resolved 'day' or 'night', but no attendance row exists yet
}
