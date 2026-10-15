// Safeguard HikCentral Attendance MVP -- Phase 2B.1: Roster Management
// Foundation data access.
//
// All reads are plain, RLS-scoped (Admin-only, see the migration's RLS
// policies) SELECTs. All writes go through the three SECURITY DEFINER
// RPCs -- there is no direct .insert()/.update() call against either
// roster table anywhere in this file, because none would succeed (the
// migration revokes INSERT/UPDATE table privileges from `authenticated`
// entirely; see supabase/migrations/20261008000000_roster_management_foundation.sql).
// Follows the same never-throws, discriminated-outcome RPC-wrapper
// pattern already established by hikcentralPersonMappingService.ts.
import { supabase } from '../lib/supabase';
import { AssignmentType, DateAssignmentRow, OffDayPatternRow, ShiftPatternRow } from './rosterSchedule';
import { EmployeeLite } from './hikcentralPersonMapping';

export async function fetchActiveOffDayPatterns(): Promise<OffDayPatternRow[]> {
  const { data, error } = await supabase
    .from('roster_off_day_patterns')
    .select('employee_id, weekday, effective_from, is_active')
    .eq('is_active', true);
  if (error) throw error;
  return (data || []).map((row) => ({
    employeeId: row.employee_id,
    weekday: row.weekday,
    effectiveFrom: row.effective_from,
    isActive: row.is_active,
  }));
}

/** Stage C Step 6B: recurring Day/Night baseline, symmetric to fetchActiveOffDayPatterns above. */
export async function fetchActiveShiftPatterns(): Promise<ShiftPatternRow[]> {
  const { data, error } = await supabase
    .from('roster_shift_patterns')
    .select('employee_id, shift_type, effective_from, is_active')
    .eq('is_active', true);
  if (error) throw error;
  return (data || []).map((row) => ({
    employeeId: row.employee_id,
    shiftType: row.shift_type as 'day' | 'night',
    effectiveFrom: row.effective_from,
    isActive: row.is_active,
  }));
}

/** Bounded by a date range (required) -- never an unbounded fetch of every dated assignment ever made. */
export async function fetchActiveDateAssignments(dateFrom: string, dateTo: string): Promise<DateAssignmentRow[]> {
  const { data, error } = await supabase
    .from('roster_date_assignments')
    .select('employee_id, assignment_date, assignment_type, is_active')
    .eq('is_active', true)
    .gte('assignment_date', dateFrom)
    .lte('assignment_date', dateTo);
  if (error) throw error;
  return (data || []).map((row) => ({
    employeeId: row.employee_id,
    assignmentDate: row.assignment_date,
    assignmentType: row.assignment_type as AssignmentType,
    isActive: row.is_active,
  }));
}

// Phase 2B.2C: a single, explicit, documented bound rather than relying on
// whatever PostgREST's own default row cap happens to be today -- RLS
// already scopes this to the caller's own tenant, so this is a safety
// ceiling against a single tenant's Active, non-deleted headcount growing
// far beyond anything the roster UI's search/select widgets are designed
// to browse, not a pagination mechanism. At the current ~935 employees
// (STAGING, 2026-10) this is never reached; if it ever is, every roster
// employee-search surface (Calendar, Recurring Off Day, Assign Dates,
// Reschedule Off Day) searches only within the fetched set, so search
// would need to be made properly server-side at that point -- see this
// function's and filterEmployeesForSearch's own callers in Roster.tsx.
const MAX_ROSTER_EMPLOYEES_FETCHED = 5000;

export async function fetchActiveEmployeesForRoster(): Promise<EmployeeLite[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('id, employee_number, full_name, workstation, status, is_deleted')
    .eq('status', 'Active')
    .or('is_deleted.is.null,is_deleted.eq.false')
    .limit(MAX_ROSTER_EMPLOYEES_FETCHED);
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    employeeNumber: row.employee_number,
    fullName: row.full_name,
    workstation: row.workstation,
    status: row.status,
    isDeleted: row.is_deleted,
  }));
}

/**
 * The single shared employee-search predicate used by every roster
 * employee-selection surface (Calendar's grid filter, Recurring Off Day's
 * and Assign Dates' checkbox lists, and the Reschedule Off Day combobox) --
 * case-insensitive partial match on full name OR employee number. A blank
 * query matches everyone. Operates on an already-fetched, already
 * tenant-scoped (via RLS) array -- it never queries the network itself,
 * so it is correct over however many employees were actually fetched,
 * never limited to whatever subset a caller happens to be displaying.
 */
export function filterEmployeesForSearch(employees: EmployeeLite[], query: string): EmployeeLite[] {
  const q = query.trim().toLowerCase();
  if (q === '') return employees;
  return employees.filter((e) => e.fullName.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q));
}

/** "Full Name (EMP-NUMBER)" -- the one display label every roster employee-selection surface uses, so a combobox's closed-state text and a multi-select checkbox's row label never drift apart. */
export function formatEmployeeLabel(employee: EmployeeLite): string {
  return `${employee.fullName} (${employee.employeeNumber})`;
}

/**
 * Moves a combobox's highlighted result index by one Arrow key press,
 * clamped to the current result count -- pure so the Reschedule Off Day
 * single-select combobox's keyboard navigation is directly unit-testable
 * without mounting any component. Wraps around in both directions (Arrow
 * Down past the last result returns to the first, Arrow Up past the first
 * returns to the last), matching common combobox convention. Returns -1
 * (nothing highlighted) when there are no results to highlight at all.
 */
export function moveHighlightedIndex(currentIndex: number, direction: 1 | -1, resultCount: number): number {
  if (resultCount === 0) return -1;
  if (currentIndex < 0) return direction === 1 ? 0 : resultCount - 1;
  return (currentIndex + direction + resultCount) % resultCount;
}

export type RosterRpcOutcome = 'success' | 'unauthorized' | 'missing_rpc' | 'network_error' | 'unexpected_response';

export interface RosterRpcResult {
  success: boolean;
  outcome: RosterRpcOutcome;
  error?: string;
  assignedCount?: number;
  alreadySetCount?: number;
}

const RPC_NOT_FOUND_CODE = 'PGRST202';

function isCountedRpcSuccess(data: unknown): data is { assigned_count: number; already_set_count: number } {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { assigned_count?: unknown }).assigned_count === 'number' &&
    typeof (data as { already_set_count?: unknown }).already_set_count === 'number'
  );
}

async function callCountedRpc(name: string, args: Record<string, unknown>): Promise<RosterRpcResult> {
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) {
      if (error.code === RPC_NOT_FOUND_CODE) {
        return { success: false, outcome: 'missing_rpc', error: 'Roster management is not available yet in this environment (database migration not applied).' };
      }
      return { success: false, outcome: 'unauthorized', error: error.message };
    }
    if (!isCountedRpcSuccess(data)) {
      return { success: false, outcome: 'unexpected_response', error: 'Unexpected response from the server while updating the roster.' };
    }
    return { success: true, outcome: 'success', assignedCount: data.assigned_count, alreadySetCount: data.already_set_count };
  } catch {
    return { success: false, outcome: 'network_error', error: 'Network error while updating the roster. Please try again.' };
  }
}

/** Individual or bulk recurring Off-day pattern assignment. */
export async function assignOffPattern(
  employeeIds: string[],
  weekday: number,
  effectiveFrom: string,
  correctionReason?: string
): Promise<RosterRpcResult> {
  return callCountedRpc('roster_assign_off_pattern', {
    p_employee_ids: employeeIds,
    p_weekday: weekday,
    p_effective_from: effectiveFrom,
    p_correction_reason: correctionReason ?? null,
  });
}

/**
 * Stage C Step 6B: saves a recurring weekly Off day, a recurring Day/Night
 * baseline, or both together, for one or more employees, in a single
 * atomic RPC call (roster_assign_recurring_pattern) -- replaces the
 * Step 6A proposal's two sequential RPC calls. Pass only `weekday` to
 * change just the Off day, only `shiftType` to change just the normal
 * shift, or both to change them together as one "Save recurring
 * pattern" action: either both changes land, or neither does, since
 * both writes happen inside the RPC's own single transaction.
 */
export async function assignRecurringPattern(
  employeeIds: string[],
  pattern: { weekday?: number; shiftType?: 'day' | 'night' },
  effectiveFrom: string,
  correctionReason?: string
): Promise<RosterRpcResult> {
  return callCountedRpc('roster_assign_recurring_pattern', {
    p_employee_ids: employeeIds,
    p_weekday: pattern.weekday ?? null,
    p_shift_type: pattern.shiftType ?? null,
    p_effective_from: effectiveFrom,
    p_correction_reason: correctionReason ?? null,
  });
}

/** Individual, date-range, or bulk dated Day/Night/Off assignment. */
export async function assignDates(
  employeeIds: string[],
  dateFrom: string,
  dateTo: string,
  assignmentType: AssignmentType,
  correctionReason?: string
): Promise<RosterRpcResult> {
  return callCountedRpc('roster_assign_dates', {
    p_employee_ids: employeeIds,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_assignment_type: assignmentType,
    p_correction_reason: correctionReason ?? null,
  });
}

/**
 * Stage C Step 13: cancels a mistaken dated exception across a date
 * range, restoring whatever the employee's underlying recurring
 * Off-day/shift pattern says for each date (Day, Night, Off, or
 * unassigned) -- never forcing a specific value. A date with no active
 * dated exception (already governed directly by the recurring pattern)
 * is left untouched and simply counted as skipped -- this is how
 * genuine recurring Off/working days stay protected from this tool.
 * Shares roster_assign_dates' own response shape (assigned_count here
 * means "cancelled", already_set_count means "skipped, nothing to
 * cancel") so the existing callCountedRpc wrapper applies unchanged.
 */
export async function cancelDateAssignments(
  employeeIds: string[],
  dateFrom: string,
  dateTo: string,
  correctionReason: string
): Promise<RosterRpcResult> {
  return callCountedRpc('roster_cancel_date_assignments', {
    p_employee_ids: employeeIds,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_correction_reason: correctionReason,
  });
}

export interface RescheduleOffDayResult {
  success: boolean;
  outcome: RosterRpcOutcome;
  error?: string;
}

/**
 * The atomic composite operation (Phase 2B.2C, Policy Option A): move an
 * employee's genuine, currently-Off original date to a different
 * replacement date, converting the original date into a real Day or Night
 * shift, in one transaction. Both the original date's Off-ness and the
 * replacement date's eligibility are independently re-verified server-side
 * by roster_reschedule_off_day (20261009000000_roster_reschedule_off_day_option_a.sql)
 * -- this function is a thin RPC wrapper only, never itself the authority.
 * There is no longer an "optionally assign work on the vacated date" mode:
 * converting the original date into a real shift is now mandatory on every
 * call, closing the gap where the old 5-parameter signature could leave
 * the real Off day untouched while adding an unrelated second one.
 */
export async function rescheduleOffDay(
  employeeId: string,
  originalOffDate: string,
  replacementOffDate: string,
  originalDateShift: 'day' | 'night',
  correctionReason: string
): Promise<RescheduleOffDayResult> {
  try {
    const { error } = await supabase.rpc('roster_reschedule_off_day', {
      p_employee_id: employeeId,
      p_original_off_date: originalOffDate,
      p_replacement_off_date: replacementOffDate,
      p_original_date_shift: originalDateShift,
      p_correction_reason: correctionReason,
    });
    if (error) {
      if (error.code === RPC_NOT_FOUND_CODE) {
        return { success: false, outcome: 'missing_rpc', error: 'Roster management is not available yet in this environment (database migration not applied).' };
      }
      return { success: false, outcome: 'unauthorized', error: error.message };
    }
    return { success: true, outcome: 'success' };
  } catch {
    return { success: false, outcome: 'network_error', error: 'Network error while rescheduling the Off day. Please try again.' };
  }
}

export interface ApplyWeekdayTransitionResult {
  success: boolean;
  outcome: RosterRpcOutcome;
  error?: string;
  mode?: 'temporary' | 'permanent';
  /** The one date (if any) kept Off as a bridge, to preserve the rolling seven-day rest rule across the transition -- see roster_apply_weekday_transition's migration header. */
  bridgeDate?: string | null;
  weeksApplied?: number;
}

/**
 * Stage C Step 12A: the single, atomic RPC behind the Temporary/
 * Permanent Off Day tab -- replaces Step 12's per-week loop over
 * rescheduleOffDay. Computes and applies the ENTIRE multi-week change
 * (every affected week, plus the one bridge week/date when the
 * rolling-seven-day rest rule requires one) in one transaction: either
 * every week is written, or (on any rejection) none are -- there is no
 * partial-application outcome. See roster_apply_weekday_transition's
 * migration header for the full bridge-day proof this wraps.
 */
export async function applyWeekdayTransition(
  employeeId: string,
  mode: 'temporary' | 'permanent',
  originalWeekday: number,
  newWeekday: number,
  shiftType: 'day' | 'night',
  weekStart: string,
  durationWeeks: number,
  correctionReason: string
): Promise<ApplyWeekdayTransitionResult> {
  try {
    const { data, error } = await supabase.rpc('roster_apply_weekday_transition', {
      p_employee_id: employeeId,
      p_mode: mode,
      p_original_weekday: originalWeekday,
      p_new_weekday: newWeekday,
      p_shift_type: shiftType,
      p_week_start: weekStart,
      p_duration_weeks: durationWeeks,
      p_correction_reason: correctionReason,
    });
    if (error) {
      if (error.code === RPC_NOT_FOUND_CODE) {
        return { success: false, outcome: 'missing_rpc', error: 'Roster management is not available yet in this environment (database migration not applied).' };
      }
      return { success: false, outcome: 'unauthorized', error: error.message };
    }
    const result = data as { mode?: string; bridge_date?: string | null; weeks_applied?: number } | null;
    return {
      success: true,
      outcome: 'success',
      mode: result?.mode as 'temporary' | 'permanent' | undefined,
      bridgeDate: result?.bridge_date ?? null,
      weeksApplied: result?.weeks_applied,
    };
  } catch {
    return { success: false, outcome: 'network_error', error: 'Network error while applying the weekday transition. Please try again.' };
  }
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Replaces any employee UUID embedded in a raw Postgres rejection message
 * (e.g. "...employee <uuid> with no Off day between...") with that
 * employee's "Full Name (EMP-NUMBER)" label, when the UUID matches a
 * currently-fetched employee -- closes the Phase 2B.2C STAGING preflight
 * finding that Admin otherwise sees an internal id instead of a name.
 * Pure string substitution; a UUID not found in `employees` (e.g. it
 * belongs to another tenant, or the list is stale) is left exactly as-is,
 * never replaced with a guess.
 */
export function humanizeRosterError(message: string, employees: EmployeeLite[]): string {
  if (!message) return message;
  return message.replace(UUID_RE, (match) => {
    const emp = employees.find((e) => e.id.toLowerCase() === match.toLowerCase());
    return emp ? formatEmployeeLabel(emp) : match;
  });
}
