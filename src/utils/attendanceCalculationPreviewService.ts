// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage B: read-only
// data access for the Attendance Calculation Preview page. Every query
// here is a plain SELECT (RLS-scoped, same as every other page in this
// app) -- there is no .insert()/.update()/.upsert() anywhere in this
// file, and no RPC call either. Reuses the existing roster, HikCentral
// Attendance Preview, and employee-batching data-access functions
// unchanged rather than re-querying the same tables a second way.
import { supabase } from '../lib/supabase';
import { fetchInEmployeeIdBatches } from './employeeBatchFetch';
import { fetchActiveDateAssignments, fetchActiveOffDayPatterns, fetchActiveEmployeesForRoster } from './rosterService';
import { fetchIdentifiedEventsInRange } from './hikcentralAttendancePreviewService';
import { splitByActiveMapping, blantyreDateRangeToUtcBounds } from './hikcentralAttendancePreview';
import { fetchActiveHikCentralPersonMappings } from './hikcentralPersonMappingService';
import { normalizeStoredFingerprintEventsForEmployee } from './attendanceFingerprintAdapters';
import { NormalizedFingerprintEvent } from './attendanceCalculationEngine';
import { DateAssignmentRow, OffDayPatternRow, addDays } from './rosterSchedule';
import { EmployeeLite } from './hikcentralPersonMapping';

export interface AttendanceCalculationPreviewData {
  employees: EmployeeLite[];
  datedAssignments: DateAssignmentRow[];
  patterns: OffDayPatternRow[];
  eventsByEmployeeId: Map<string, NormalizedFingerprintEvent[]>;
  officialStatusByKey: Map<string, string>;
}

/**
 * Fetches everything the pure preview builder (attendanceCalculationPreview.ts)
 * needs for one [dateFrom, dateTo] Africa/Blantyre shift-date range, all
 * read-only:
 *  - active, non-deleted employees (roster's own candidate pool, same as
 *    Roster.tsx uses -- includes `workstation`)
 *  - active dated roster assignments in range + active recurring Off
 *    patterns (unbounded by date, same as Roster.tsx already fetches)
 *  - fingerprint events: widened by +1 day past `dateTo` so a Night
 *    shift's checkout window (which falls on the morning AFTER its
 *    shiftDate) is never missed, joined to employees via the existing
 *    active Person Mappings exactly like the HikCentral Attendance
 *    Preview page already does
 *  - existing official `attendance.status` rows in range, for read-only
 *    display only -- never written to from here
 */
export async function fetchAttendanceCalculationPreviewData(dateFrom: string, dateTo: string): Promise<AttendanceCalculationPreviewData> {
  const widenedTo = addDays(dateTo, 1);

  const [employees, datedAssignments, patterns, mappings] = await Promise.all([
    fetchActiveEmployeesForRoster(),
    fetchActiveDateAssignments(dateFrom, dateTo),
    fetchActiveOffDayPatterns(),
    fetchActiveHikCentralPersonMappings(),
  ]);

  const { fromUtcIso, toUtcIsoExclusive } = blantyreDateRangeToUtcBounds(dateFrom, widenedTo);
  const identifiedEvents = await fetchIdentifiedEventsInRange(fromUtcIso, toUtcIsoExclusive);
  const personNoToEmployeeId = new Map(mappings.map((m) => [m.hikcentralPersonNo, m.employeeId]));
  const { mapped } = splitByActiveMapping(identifiedEvents, personNoToEmployeeId);

  const eventsByEmployeeId = new Map<string, NormalizedFingerprintEvent[]>();
  const distinctEmployeeIds = Array.from(new Set(mapped.map((m) => m.employeeId)));
  for (const employeeId of distinctEmployeeIds) {
    eventsByEmployeeId.set(employeeId, normalizeStoredFingerprintEventsForEmployee(mapped, employeeId));
  }

  const officialStatusByKey = await fetchOfficialAttendanceStatusByKey(
    employees.map((e) => e.id),
    dateFrom,
    dateTo
  );

  return { employees, datedAssignments, patterns, eventsByEmployeeId, officialStatusByKey };
}

/** Read-only -- `${employeeId}|${date}` -> the existing official attendance.status code, for display/comparison only. */
async function fetchOfficialAttendanceStatusByKey(employeeIds: string[], dateFrom: string, dateTo: string): Promise<Map<string, string>> {
  const rows = await fetchInEmployeeIdBatches<{ employee_id: string; date: string; status: string }>(
    employeeIds,
    (batch, from, to, withCount) =>
      supabase
        .from('attendance')
        .select('employee_id, date, status', withCount ? { count: 'exact' } : undefined)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .in('employee_id', batch)
        .range(from, to)
  );
  const byKey = new Map<string, string>();
  for (const row of rows) byKey.set(`${row.employee_id}|${row.date}`, row.status);
  return byKey;
}
