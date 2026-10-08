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
import { AssignmentType, DateAssignmentRow, OffDayPatternRow } from './rosterSchedule';
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

export async function fetchActiveEmployeesForRoster(): Promise<EmployeeLite[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('id, employee_number, full_name, workstation, status, is_deleted')
    .eq('status', 'Active')
    .or('is_deleted.is.null,is_deleted.eq.false');
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

export interface RescheduleOffDayResult {
  success: boolean;
  outcome: RosterRpcOutcome;
  error?: string;
}

/** The atomic composite operation: move an Off day to a new date, optionally assigning explicit work on the vacated date, in one transaction. */
export async function rescheduleOffDay(
  employeeId: string,
  newOffDate: string,
  correctionReason: string,
  vacatedWorkDate?: string,
  vacatedWorkAssignmentType?: 'day' | 'night'
): Promise<RescheduleOffDayResult> {
  try {
    const { error } = await supabase.rpc('roster_reschedule_off_day', {
      p_employee_id: employeeId,
      p_new_off_date: newOffDate,
      p_vacated_work_date: vacatedWorkDate ?? null,
      p_vacated_work_assignment_type: vacatedWorkAssignmentType ?? null,
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
