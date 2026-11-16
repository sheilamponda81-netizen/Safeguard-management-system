// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage B: pure,
// DB-free orchestration for the read-only "Attendance Calculation
// Preview" page. Joins already-fetched roster data, fingerprint events,
// and official attendance rows per employee/shift-date and delegates the
// actual calculation entirely to the Stage A engine
// (attendanceCalculationEngine.ts) and the Stage A site-alert aggregator
// (attendanceSiteAlerts.ts) -- this module adds NO business rules of its
// own, it only decides WHICH (employee, date) pairs to compute and HOW
// to resolve each one's coverage policy before handing off.
//
// COVERAGE POLICY (the central new requirement): export time and
// verified data completeness are different things. An administrator can
// type an export timestamp purely for record-keeping/display, and that
// alone NEVER becomes coverage -- resolveCoveragePolicy only produces an
// active, 'confirmed_complete' ShiftCoverage when an authorized operator
// has ALSO explicitly ticked a separate confirmation, AND named the
// specific workstation(s) they are vouching for. Every other workstation
// -- including the real HikCentral access points, which this module
// never assumes cover anyone's assigned workstation -- stays
// 'insufficient', which the Stage A engine already turns into Pending
// rather than a false Absent.
import { DAY_SHIFT, NIGHT_SHIFT, DateAssignmentRow, OffDayPatternRow, ShiftPatternRow, ResolvedSchedule, resolveScheduleForDate } from './rosterSchedule';
import {
  AttendanceCalculationResult,
  AttendanceCalculationStatus,
  NormalizedFingerprintEvent,
  ShiftCoverage,
  calculateAttendanceStatus,
} from './attendanceCalculationEngine';
import { SiteAlertCase } from './attendanceSiteAlerts';
import { AFRICA_BLANTYRE_OFFSET_MINUTES } from './hikcentralExcelParser';
import { EmployeeLite } from './hikcentralPersonMapping';

/** Trims and case/whitespace-folds only -- never a fuzzy or abbreviation-aware match. Merges "Chirimba " / "chirimba" / "CHIRIMBA", never "LIMBE VACCANT HOUSE" into "VACANT HOUSE" (confirmed distinct sites). */
export function normalizeWorkstationKey(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

function parseBlantyreLocalDateTimeToUtcIso(local: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!match) return null;
  const [, yStr, moStr, dStr, hStr, miStr] = match;
  const utcMillis =
    Date.UTC(Number(yStr), Number(moStr) - 1, Number(dStr), Number(hStr), Number(miStr), 0) - AFRICA_BLANTYRE_OFFSET_MINUTES * 60_000;
  return new Date(utcMillis).toISOString();
}

export interface CoverageConfirmationInput {
  /** "YYYY-MM-DDTHH:mm" from a <input type="datetime-local">, Africa/Blantyre wall-clock -- administrator-entered, descriptive only. Never read from the latest fingerprint event. */
  exportTimeBlantyreLocal: string;
  /** Comma/newline-separated workstation names the operator is explicitly vouching for -- exact match after normalizeWorkstationKey, never a blanket "all sites" default. */
  confirmedWorkstationsRaw: string;
  /** The separate, explicit operator action. Typing an export time alone (above) never sets this. */
  operatorConfirmed: boolean;
}

export interface ResolvedCoveragePolicy {
  confirmedWorkstationKeys: Set<string>;
  exportTimeUtcIso: string | null;
  /** True only when every one of: operator ticked confirmation, a valid export time was entered, and at least one workstation was named. */
  isActive: boolean;
}

export function resolveCoveragePolicy(input: CoverageConfirmationInput): ResolvedCoveragePolicy {
  const exportTimeUtcIso = parseBlantyreLocalDateTimeToUtcIso(input.exportTimeBlantyreLocal);
  const confirmedWorkstationKeys = new Set(
    input.confirmedWorkstationsRaw
      .split(/[,\n]/)
      .map((s) => normalizeWorkstationKey(s))
      .filter((s) => s.length > 0)
  );
  const isActive = input.operatorConfirmed && exportTimeUtcIso !== null && confirmedWorkstationKeys.size > 0;
  return { confirmedWorkstationKeys, exportTimeUtcIso, isActive };
}

/** The ShiftCoverage to use for a given (already-normalized) workstation key -- 'insufficient' for every workstation not explicitly named in an ACTIVE policy, never a default to 'confirmed_complete'. */
export function coverageForWorkstationKey(policy: ResolvedCoveragePolicy, workstationKey: string): ShiftCoverage {
  if (!policy.isActive || !policy.confirmedWorkstationKeys.has(workstationKey)) return { status: 'insufficient' };
  return { status: 'confirmed_complete', verifiedThroughIso: policy.exportTimeUtcIso! };
}

export interface AttendanceCalculationPreviewRow {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  workstation: string;
  shiftDate: string;
  resolvedShift: ResolvedSchedule;
  expectedShiftTimes: { scheduledStart: string; scheduledEnd: string } | null;
  calculation: AttendanceCalculationResult;
  officialStatus: string | null;
  /** False means this employee has no active HikCentral Person Mapping at all -- zero events is a MAPPING gap, not evidence of absence, so coverage is always forced 'insufficient' for them regardless of any operator confirmation (see buildAttendanceCalculationPreviewRows). */
  hasActiveMapping: boolean;
}

/**
 * Every employeeId appearing in at least one active dated assignment,
 * recurring Off pattern, or recurring Day/Night shift pattern -- "has
 * roster evidence" for the empty-state check and the row-candidate union
 * below. PRODUCTION HOTFIX: previously omitted the recurring shift
 * pattern (the third, lowest-priority tier roster_resolve_schedule/
 * resolveScheduleForDate already resolve from), so an employee scheduled
 * ONLY via a recurring Day/Night pattern (no per-date override, no
 * fingerprint scan yet) was invisible to this collector and therefore
 * excluded from candidateEmployees entirely -- "Scheduled shifts" could
 * undercount, including down to zero for a date range with no per-date
 * overrides at all even though recurring patterns existed.
 */
export function collectEmployeeIdsWithRosterEvidence(
  datedAssignments: DateAssignmentRow[],
  patterns: OffDayPatternRow[],
  shiftPatterns: ShiftPatternRow[] = []
): Set<string> {
  const ids = new Set<string>();
  for (const a of datedAssignments) ids.add(a.employeeId);
  for (const p of patterns) ids.add(p.employeeId);
  for (const p of shiftPatterns) ids.add(p.employeeId);
  return ids;
}

/** Every employeeId with at least one normalized fingerprint event -- "has fingerprint evidence". */
export function collectEmployeeIdsWithFingerprintEvidence(eventsByEmployeeId: Map<string, NormalizedFingerprintEvent[]>): Set<string> {
  const ids = new Set<string>();
  for (const [employeeId, events] of eventsByEmployeeId) if (events.length > 0) ids.add(employeeId);
  return ids;
}

/**
 * True iff at least one employee has BOTH roster and fingerprint
 * evidence. NOT used to gate row generation or the page's empty state
 * (the preview is roster-first: an employee with a resolved Day/Night
 * shift and zero fingerprint events must still appear, calculating
 * Pending or -- only once coverage is genuinely confirmed -- Absent).
 * Kept as a diagnostic signal only (e.g. for a non-blocking note that
 * the two sources don't currently overlap in time).
 */
export function hasAnyEmployeeWithBothRosterAndFingerprintEvidence(rosterIds: Set<string>, fingerprintIds: Set<string>): boolean {
  for (const id of rosterIds) if (fingerprintIds.has(id)) return true;
  return false;
}

/** Earliest/latest of an already-fetched list of plain date-like strings (YYYY-MM-DD, or an ISO instant -- compared lexicographically, same convention used throughout this codebase). Null for an empty list. */
export function describeDateExtent(dates: string[]): { earliest: string; latest: string } | null {
  if (dates.length === 0) return null;
  let earliest = dates[0];
  let latest = dates[0];
  for (const d of dates) {
    if (d < earliest) earliest = d;
    if (d > latest) latest = d;
  }
  return { earliest, latest };
}

export function expectedShiftTimesFor(resolvedShift: ResolvedSchedule): { scheduledStart: string; scheduledEnd: string } | null {
  if (resolvedShift === 'day') return { scheduledStart: DAY_SHIFT.scheduledStart, scheduledEnd: DAY_SHIFT.scheduledEnd };
  if (resolvedShift === 'night') return { scheduledStart: NIGHT_SHIFT.scheduledStart, scheduledEnd: NIGHT_SHIFT.scheduledEnd };
  return null;
}

/**
 * Builds one preview row per (employee, shiftDate) pair for the supplied
 * candidate employees -- the caller decides which employees are worth
 * computing at all (this module provides the evidence-based helpers
 * above for that), so this stays a simple nested loop with no hidden
 * filtering. ROSTER-FIRST: an employee with a resolved Day/Night shift
 * and zero fingerprint events is still given a row (resolving to
 * Pending unless coverage is genuinely confirmed) -- callers must pass
 * every roster-evidenced employee here even when they have no entry in
 * `eventsByEmployeeId` at all, never only the ones who happen to have
 * scanned. Every actual calculation is delegated to
 * calculateAttendanceStatus (Stage A) -- this function only resolves the
 * roster schedule (resolveScheduleForDate, also pre-existing) and looks
 * up each employee's events/coverage/official-status from the supplied
 * maps.
 */
export function buildAttendanceCalculationPreviewRows(params: {
  employees: EmployeeLite[];
  shiftDates: string[];
  datedAssignments: DateAssignmentRow[];
  patterns: OffDayPatternRow[];
  /** The recurring Day/Night baseline -- see resolveScheduleForDate's precedence (dated assignment > off-day pattern > this > unassigned), identical to the server-authoritative roster_resolve_schedule(). Defaults to [] only so existing callers/tests that genuinely have none don't need to pass an empty array explicitly; the real preview page always supplies the full fetched set. */
  shiftPatterns?: ShiftPatternRow[];
  eventsByEmployeeId: Map<string, NormalizedFingerprintEvent[]>;
  coveragePolicy: ResolvedCoveragePolicy;
  officialStatusByKey: Map<string, string>;
  /** Employees with NO active HikCentral Person Mapping always get forced 'insufficient' coverage, regardless of any operator workstation confirmation -- their zero events reflect an unresolved mapping, never an observed absence. */
  employeeIdsWithActiveMapping: Set<string>;
}): AttendanceCalculationPreviewRow[] {
  const { employees, shiftDates, datedAssignments, patterns, shiftPatterns = [], eventsByEmployeeId, coveragePolicy, officialStatusByKey, employeeIdsWithActiveMapping } = params;
  const rows: AttendanceCalculationPreviewRow[] = [];

  for (const employee of employees) {
    const events = eventsByEmployeeId.get(employee.id) ?? [];
    const hasActiveMapping = employeeIdsWithActiveMapping.has(employee.id);
    const coverage = hasActiveMapping
      ? coverageForWorkstationKey(coveragePolicy, normalizeWorkstationKey(employee.workstation || ''))
      : ({ status: 'insufficient' } as const);
    for (const shiftDate of shiftDates) {
      const resolvedShift = resolveScheduleForDate(employee.id, shiftDate, datedAssignments, patterns, shiftPatterns);
      const calculation = calculateAttendanceStatus({ shiftDate, resolvedShift, events, coverage });
      rows.push({
        employeeId: employee.id,
        employeeName: employee.fullName,
        employeeNumber: employee.employeeNumber,
        workstation: employee.workstation || '',
        shiftDate,
        resolvedShift,
        expectedShiftTimes: expectedShiftTimesFor(resolvedShift),
        calculation,
        officialStatus: officialStatusByKey.get(`${employee.id}|${shiftDate}`) ?? null,
        hasActiveMapping,
      });
    }
  }
  return rows;
}

export interface AttendancePreviewRowFilters {
  siteFilter?: string;
  shiftFilter?: ResolvedSchedule | '';
  resultFilter?: AttendanceCalculationStatus | '';
  employeeSearch?: string;
}

export function filterAttendancePreviewRows(
  rows: AttendanceCalculationPreviewRow[],
  filters: AttendancePreviewRowFilters
): AttendanceCalculationPreviewRow[] {
  const search = (filters.employeeSearch ?? '').trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.siteFilter && row.workstation !== filters.siteFilter) return false;
    if (filters.shiftFilter && row.resolvedShift !== filters.shiftFilter) return false;
    if (filters.resultFilter && row.calculation.status !== filters.resultFilter) return false;
    if (search && !(row.employeeName.toLowerCase().includes(search) || row.employeeNumber.toLowerCase().includes(search))) return false;
    return true;
  });
}

/**
 * Maps already-computed rows into the Stage A site-alert aggregator's
 * input shape, grouping by the CONSERVATIVELY NORMALIZED workstation key
 * (never the raw string, so "Chirimba " and "CHIRIMBA" count as the same
 * site; never fuzzy-merged, so genuinely different sites never collide).
 * Only Day/Night rows participate -- Off/Unassigned rows have no
 * meaningful "confirmed fingerprint-related absence" to contribute, and
 * aggregateSiteAlerts itself already excludes every non-'absent' status.
 * Returns a normalized-key -> representative-original-spelling map
 * alongside, purely for display (the alert's own `workstation` field is
 * the normalized key).
 */
export function buildSiteAlertCasesFromRows(rows: AttendanceCalculationPreviewRow[]): {
  cases: SiteAlertCase[];
  workstationLabelByKey: Map<string, string>;
} {
  const workstationLabelByKey = new Map<string, string>();
  const cases: SiteAlertCase[] = [];
  for (const row of rows) {
    if (row.resolvedShift !== 'day' && row.resolvedShift !== 'night') continue;
    const key = normalizeWorkstationKey(row.workstation);
    if (!workstationLabelByKey.has(key)) workstationLabelByKey.set(key, row.workstation);
    cases.push({ employeeId: row.employeeId, workstation: key, shift: row.resolvedShift, shiftDate: row.shiftDate, result: row.calculation });
  }
  return { cases, workstationLabelByKey };
}
