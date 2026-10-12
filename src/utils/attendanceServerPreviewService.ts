// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage C, Step 3:
// read-only data access for the SERVER-side calculation preview --
// calls attendance_preview_calculate (20261013010000_attendance_preview_
// calculate_rpc.sql), which only ever reads and returns computed results.
// There is no .insert()/.update()/.upsert() anywhere in this file, and
// the RPC it calls has no write path at all (a wholly separate function,
// attendance_apply_automatic, does -- never called from here).
//
// PREPARED-BUT-UNAPPLIED MIGRATION NOTICE: the RPC this file calls
// (attendance_preview_calculate) and the corrective fix it depends on
// (attendance_resolve_and_calculate's tenant-scoping and coverage-window
// corrections, 20261013000000) are NOT YET APPLIED to STAGING as of this
// change -- both migrations are prepared and isolated-Postgres tested,
// pending separate authorization. Calling fetchServerCalculationPreview
// against STAGING before that migration lands will fail with a
// "function does not exist" error; callers should treat that specific
// failure as an expected, informative state (see
// AttendanceServerCalculationPreview.tsx), not a bug in this file.
import { supabase } from '../lib/supabase';
import { AttendanceCalculationStatus, AttendanceCalculationBasis } from './attendanceCalculationEngine';

export interface ServerCalculationPreviewRow {
  employeeId: string;
  attendanceDate: string;
  status: AttendanceCalculationStatus;
  calculationBasis: AttendanceCalculationBasis | null;
  checkInAtIso: string | null;
  checkOutAtIso: string | null;
  reason: string;
}

/**
 * Runs the SERVER'S own copy of the calculation engine
 * (attendance_resolve_and_calculate, via the read-only
 * attendance_preview_calculate RPC) for the given employees/date range.
 * Never writes anything -- this is for comparison against the existing
 * client-side Stage A/B preview only.
 */
export async function fetchServerCalculationPreview(
  employeeIds: string[],
  dateFrom: string,
  dateTo: string
): Promise<ServerCalculationPreviewRow[]> {
  if (employeeIds.length === 0) return [];
  const { data, error } = await supabase.rpc('attendance_preview_calculate', {
    p_employee_ids: employeeIds,
    p_date_from: dateFrom,
    p_date_to: dateTo,
  });
  if (error) throw error;
  return (data || []).map((row: {
    employee_id: string;
    attendance_date: string;
    status: string;
    calculation_basis: string | null;
    check_in_at: string | null;
    check_out_at: string | null;
    reason: string;
  }) => ({
    employeeId: row.employee_id,
    attendanceDate: row.attendance_date,
    status: row.status as AttendanceCalculationStatus,
    calculationBasis: (row.calculation_basis as AttendanceCalculationBasis | null) ?? null,
    checkInAtIso: row.check_in_at,
    checkOutAtIso: row.check_out_at,
    reason: row.reason,
  }));
}

export interface AutomaticAttendanceReadiness {
  mappedEmployeeCount: number;
  rosterEvidencedEmployeeCount: number;
  overlapEmployeeCount: number;
  coverageConfirmationCount: number;
}

/**
 * Read-only prerequisite check for a meaningful automatic-attendance
 * demonstration: does any employee with an ACTIVE HikCentral Person
 * Mapping also have ANY roster evidence (a dated assignment or a
 * recurring Off pattern) at all? Without that overlap, every real
 * (employee, date) pair resolves to 'unassigned' before the engine ever
 * reaches event/coverage logic -- a demo would have nothing real to
 * show, and this function exists so the UI reports that plainly instead
 * of inventing data to demonstrate with.
 */
export async function checkAutomaticAttendanceReadiness(): Promise<AutomaticAttendanceReadiness> {
  const [mappingsRes, assignmentsRes, patternsRes, coverageRes] = await Promise.all([
    supabase.from('hikcentral_person_mappings').select('employee_id').eq('is_active', true),
    supabase.from('roster_date_assignments').select('employee_id').eq('is_active', true),
    supabase.from('roster_off_day_patterns').select('employee_id').eq('is_active', true),
    supabase.from('fingerprint_coverage_confirmations').select('id', { count: 'exact', head: true }),
  ]);
  if (mappingsRes.error) throw mappingsRes.error;
  if (assignmentsRes.error) throw assignmentsRes.error;
  if (patternsRes.error) throw patternsRes.error;
  if (coverageRes.error) throw coverageRes.error;

  const mappedEmployeeIds = new Set((mappingsRes.data || []).map((r) => r.employee_id as string));
  const rosterEvidencedEmployeeIds = new Set<string>([
    ...(assignmentsRes.data || []).map((r) => r.employee_id as string),
    ...(patternsRes.data || []).map((r) => r.employee_id as string),
  ]);
  let overlapEmployeeCount = 0;
  for (const id of mappedEmployeeIds) if (rosterEvidencedEmployeeIds.has(id)) overlapEmployeeCount++;

  return {
    mappedEmployeeCount: mappedEmployeeIds.size,
    rosterEvidencedEmployeeCount: rosterEvidencedEmployeeIds.size,
    overlapEmployeeCount,
    coverageConfirmationCount: coverageRes.count ?? 0,
  };
}
