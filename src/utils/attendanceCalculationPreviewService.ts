// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage B: read-only
// data access for the Attendance Calculation Preview page. Every query
// here is a plain SELECT (RLS-scoped, same as every other page in this
// app) -- there is no .insert()/.update()/.upsert() anywhere in this
// file, and no RPC call either. Reuses the existing roster, HikCentral
// Attendance Preview, and employee-batching data-access functions
// unchanged rather than re-querying the same tables a second way.
import { supabase } from '../lib/supabase';
import { fetchInEmployeeIdBatches } from './employeeBatchFetch';
import { fetchActiveDateAssignments, fetchActiveOffDayPatterns, fetchActiveShiftPatterns, fetchActiveEmployeesForRoster } from './rosterService';
import { fetchIdentifiedEventsInRange } from './hikcentralAttendancePreviewService';
import { splitByActiveMapping, blantyreDateRangeToUtcBounds } from './hikcentralAttendancePreview';
import { fetchActiveHikCentralPersonMappings } from './hikcentralPersonMappingService';
import { normalizeStoredFingerprintEventsForEmployee } from './attendanceFingerprintAdapters';
import { NormalizedFingerprintEvent } from './attendanceCalculationEngine';
import { DateAssignmentRow, OffDayPatternRow, ShiftPatternRow, addDays } from './rosterSchedule';
import { EmployeeLite } from './hikcentralPersonMapping';
import { ServerCoverageEvidence } from './attendanceCalculationPreview';

export interface AttendanceCalculationPreviewData {
  employees: EmployeeLite[];
  datedAssignments: DateAssignmentRow[];
  patterns: OffDayPatternRow[];
  /** PRODUCTION HOTFIX: the recurring Day/Night baseline (roster_resolve_schedule's own third resolution tier, server-authoritative) -- previously never fetched here at all, so this preview undercounted (sometimes to zero) any employee whose schedule comes only from a recurring pattern rather than an explicit per-date override. See resolveScheduleForDate's precedence: dated assignment > off-day pattern > this > unassigned. */
  shiftPatterns: ShiftPatternRow[];
  eventsByEmployeeId: Map<string, NormalizedFingerprintEvent[]>;
  officialStatusByKey: Map<string, string>;
  /** Every employeeId with at least one ACTIVE HikCentral Person Mapping -- i.e. an employee this preview could ever observe a scan for at all. An employee absent from this set has zero events for an entirely different reason than "didn't scan": nobody has confirmed which HikCentral identity is theirs yet. See attendanceCalculationPreview.ts's use of this set -- it must never be treated as equivalent to a confirmed absence. */
  employeeIdsWithActiveMapping: Set<string>;
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

  const [employees, datedAssignments, patterns, shiftPatterns, mappings] = await Promise.all([
    fetchActiveEmployeesForRoster(),
    fetchActiveDateAssignments(dateFrom, dateTo),
    fetchActiveOffDayPatterns(),
    fetchActiveShiftPatterns(),
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

  const employeeIdsWithActiveMapping = new Set(mappings.map((m) => m.employeeId));

  return { employees, datedAssignments, patterns, shiftPatterns, eventsByEmployeeId, officialStatusByKey, employeeIdsWithActiveMapping };
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

/**
 * Task 3 (Phase 2 completion): the Evidence Centre's own "automatic vs.
 * manual" filter needs to know HOW the official attendance row was
 * decided, not just what it says. Deliberately a SEPARATE, additive
 * export rather than widening fetchOfficialAttendanceStatusByKey's own
 * return shape -- that function (and officialStatusByKey's plain
 * Map<string, string> type) is shared by three other pages
 * (AttendanceCalculationPreview, AttendanceServerCalculationPreview,
 * AttendanceWhatIfSimulation) that have no use for this and should
 * never need to change just because the Evidence Centre grew a new
 * filter. Read-only -- same RLS-scoped plain SELECT, same batching
 * utility, as its sibling above.
 */
export async function fetchOfficialAttendanceSourceByKey(employeeIds: string[], dateFrom: string, dateTo: string): Promise<Map<string, string | null>> {
  const rows = await fetchInEmployeeIdBatches<{ employee_id: string; date: string; source: string | null }>(
    employeeIds,
    (batch, from, to, withCount) =>
      supabase
        .from('attendance')
        .select('employee_id, date, source', withCount ? { count: 'exact' } : undefined)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .in('employee_id', batch)
        .range(from, to)
  );
  const byKey = new Map<string, string | null>();
  for (const row of rows) byKey.set(`${row.employee_id}|${row.date}`, row.source);
  return byKey;
}

/**
 * Attendance coverage-consistency improvement: the read-only, server-
 * authoritative coverage explanation (attendance_coverage_explain,
 * 20261120020000_attendance_coverage_explain.sql) for every (employee,
 * date) pair in range -- see combineCoverageSources in
 * attendanceCalculationPreview.ts for how a caller actually uses this.
 * A plain RPC call, same read-only guarantee as fetchServerCalculationPreview
 * -- this function never writes anything, and the RPC it calls has no
 * write path at all. Batches by employee id the same way the other
 * exports in this file do, since the RPC's own cost scales with
 * employeeIds.length * (dateTo - dateFrom) and a very wide employee
 * selection could otherwise build an oversized single request.
 */
export async function fetchAttendanceCoverageExplain(employeeIds: string[], dateFrom: string, dateTo: string): Promise<Map<string, ServerCoverageEvidence>> {
  const rows = await fetchInEmployeeIdBatches<{
    employee_id: string; shift_date: string; resolved_shift: string; coverage_provenance: string;
    sufficient_evidence: boolean; official_engine_trusts_this: boolean; confirmed_through: string | null; reason: string;
  }>(
    employeeIds,
    async (batch) => {
      const { data, error } = await supabase.rpc('attendance_coverage_explain', {
        p_employee_ids: batch,
        p_date_from: dateFrom,
        p_date_to: dateTo,
      });
      // This RPC returns its complete, already-bounded result set (one
      // row per employee x date in range, both bounded by this page's
      // own MAX_RANGE_DAYS) in a single call -- no server-side .range()
      // pagination applies to an RPC's return value, so there is no
      // partial page to request further; count is reported as the full
      // length so fetchAllPages' loop ends after this one page.
      return { data, error, count: data?.length ?? 0 };
    }
  );
  const byKey = new Map<string, ServerCoverageEvidence>();
  for (const row of rows) {
    byKey.set(`${row.employee_id}|${row.shift_date}`, {
      resolvedShift: row.resolved_shift,
      coverageProvenance: row.coverage_provenance,
      sufficientEvidence: row.sufficient_evidence,
      officialEngineTrustsThis: row.official_engine_trusts_this,
      confirmedThroughIso: row.confirmed_through,
      reason: row.reason,
    });
  }
  return byKey;
}
