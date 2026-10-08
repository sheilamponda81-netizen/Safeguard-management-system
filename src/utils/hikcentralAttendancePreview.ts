// HikCentral Attendance MVP -- Phase 2A: read-only Attendance Preview.
//
// Pure, DB-free calculation module. Everything here operates on
// already-fetched plain data (identified raw-event rows and active person
// mappings -- see hikcentralAttendancePreviewService.ts for the data-access
// layer) and returns plain data. No Supabase calls.
//
// SCOPE (deliberately narrow -- see the read-only design audit that
// preceded this phase): this module groups already-mapped HikCentral scans
// into employee/calendar-day buckets and flags patterns worth human
// review. It NEVER computes Present/Absent/Late, hours worked, or any
// deduction -- those all require business rules (shift boundaries,
// lateness thresholds) that do not exist anywhere in this codebase yet
// (confirmed by the design audit: every `employees.shift` value is NULL in
// the real STAGING data, and there is no shift/schedule table at all).
// This module also never writes or proposes writing to the official
// `attendance` table -- it is a preview only.
//
// CORE INVARIANT (same as hikcentralPersonMapping.ts): hikcentral_person_no
// is an EXACT RAW STRING identity. This module never normalizes, casts, or
// numerically compares a Person No. -- it only ever consumes the
// EmployeeLite each raw event's Person No. was ALREADY mapped to (by the
// caller, via the active hikcentral_person_mappings rows), and groups by
// that employee's id. An employee who legitimately holds more than one
// active Person No. (schema-supported since the Person Mapping Phase 2
// migration, even though no real employee currently has one) has their
// scans from every one of their Person Nos merged into the same
// employee/day group -- see the "multiple HikCentral identities" tests.
//
// TIMEZONE: HikCentral event_time is stored as a UTC-instant TIMESTAMPTZ.
// Every "calendar date" and "time of day" decision in this module is made
// in Africa/Blantyre local time (fixed UTC+02:00, no DST -- imported from
// hikcentralExcelParser.ts's own AFRICA_BLANTYRE_OFFSET_MINUTES constant,
// so the forward (parse) and reverse (this module) conversions can never
// drift apart by using two different magic numbers).
import { AFRICA_BLANTYRE_OFFSET_MINUTES } from './hikcentralExcelParser';
import { EmployeeLite } from './hikcentralPersonMapping';

export interface MappedScanEventRow {
  hikcentralPersonNo: string;
  employeeId: string;
  eventTimeIso: string; // UTC instant, as stored in hikcentral_raw_events.event_time
  accessPoint: string | null;
}

export interface RawIdentifiedEventRow {
  hikcentralPersonNo: string; // never null/empty -- callers filter anonymous rows out before this
  eventTimeIso: string;
  accessPoint: string | null;
}

/**
 * Splits already-fetched identified events into "mapped" (joined to an
 * employee via an active person-mapping) and "identified but unmapped"
 * (a count only -- per this phase's explicit scope, unmapped events never
 * enter the employee/day grouping, same as the Person Mapping page's own
 * Needs Review/Conflict identities never produce attendance). The lookup
 * is keyed by the EXACT raw Person No. string -- never normalized, cast,
 * or compared numerically, same invariant as hikcentralPersonMapping.ts.
 */
export function splitByActiveMapping(
  events: RawIdentifiedEventRow[],
  personNoToEmployeeId: Map<string, string>
): { mapped: MappedScanEventRow[]; identifiedUnmappedCount: number } {
  const mapped: MappedScanEventRow[] = [];
  let identifiedUnmappedCount = 0;
  for (const event of events) {
    const employeeId = personNoToEmployeeId.get(event.hikcentralPersonNo);
    if (employeeId) {
      mapped.push({
        hikcentralPersonNo: event.hikcentralPersonNo,
        employeeId,
        eventTimeIso: event.eventTimeIso,
        accessPoint: event.accessPoint,
      });
    } else {
      identifiedUnmappedCount++;
    }
  }
  return { mapped, identifiedUnmappedCount };
}

export interface ObservedScan {
  eventTimeIso: string; // UTC instant
  /** HH:MM:SS in Africa/Blantyre, for display only. */
  localTime: string;
  accessPoint: string | null;
}

export type ScanCountCategory = 'single_scan' | 'two_scans' | 'three_or_more_scans';

// Deliberately presentational/triage labels, NEVER a business-rule
// determination -- see this module's header. A group can carry more than
// one flag at once (e.g. a single scan that also happens to fall in the
// overnight window).
export type ReviewFlag = 'single_scan' | 'three_or_more_scans' | 'multiple_sites' | 'potential_overnight' | 'duplicate_timestamp';

export interface EmployeeDayScanGroup {
  employeeId: string;
  employee: EmployeeLite | null; // null only if the employee record is no longer visible to the caller (e.g. RLS/region) -- display, never used for grouping
  /** Africa/Blantyre calendar date, YYYY-MM-DD. */
  localDate: string;
  scanCount: number;
  earliestScanIso: string;
  latestScanIso: string;
  /** Chronological (ascending by eventTimeIso). */
  scans: ObservedScan[];
  /** Distinct access points observed this day, sorted. */
  accessPoints: string[];
  scanCountCategory: ScanCountCategory;
  reviewFlags: ReviewFlag[];
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

interface BlantyreParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * UTC instant (ISO string, as stored) -> its Africa/Blantyre wall-clock
 * parts. The exact inverse of hikcentralExcelParser.ts's wall-clock -> UTC
 * conversion: shift the UTC instant forward by the fixed offset, then read
 * the UTC getters of the shifted instant (never the host's local getters,
 * which would be wrong in any other timezone).
 */
function utcIsoToBlantyreParts(utcIso: string): BlantyreParts {
  const utcMillis = Date.parse(utcIso);
  const shifted = new Date(utcMillis + AFRICA_BLANTYRE_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** Africa/Blantyre calendar date key, YYYY-MM-DD, for grouping. */
export function blantyreDateKey(utcIso: string): string {
  const p = utcIsoToBlantyreParts(utcIso);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Africa/Blantyre wall-clock time, HH:MM:SS, for display only. */
export function blantyreTimeOfDay(utcIso: string): string {
  const p = utcIsoToBlantyreParts(utcIso);
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/**
 * Converts a caller-selected Africa/Blantyre calendar-date range
 * (inclusive on both ends, as YYYY-MM-DD strings) into the UTC instant
 * bounds a Supabase query should filter `event_time` by: `>= fromUtcIso`
 * and `< toUtcIsoExclusive`. Centralizing this here means the
 * date-range-filter UI and the pure grouping logic agree exactly on what
 * "Blantyre calendar date" means, with no second copy of the offset
 * arithmetic in the service layer.
 */
export function blantyreDateRangeToUtcBounds(fromDate: string, toDate: string): { fromUtcIso: string; toUtcIsoExclusive: string } {
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  const fromUtcMillis = Date.UTC(fy, fm - 1, fd, 0, 0, 0) - AFRICA_BLANTYRE_OFFSET_MINUTES * 60_000;
  // Exclusive upper bound = start of the day AFTER `toDate`.
  const toUtcMillis = Date.UTC(ty, tm - 1, td + 1, 0, 0, 0) - AFRICA_BLANTYRE_OFFSET_MINUTES * 60_000;
  return { fromUtcIso: new Date(fromUtcMillis).toISOString(), toUtcIsoExclusive: new Date(toUtcMillis).toISOString() };
}

// Presentational-only heuristic window for the "potential overnight" flag:
// any scan at or after 22:00 or before 02:00 Africa/Blantyre local time
// flags its WHOLE day-group for human attention, because the design
// audit's hour-of-day histogram on the real STAGING data showed scan
// clusters at both ends of the clock consistent with night-shift
// changeovers. This is NOT a shift-start/end time (no such schedule data
// exists anywhere in this codebase -- see this module's header) -- it only
// decides which groups get a review badge, never which calendar date a
// scan "belongs to" or any attendance/lateness outcome.
export const OVERNIGHT_WINDOW_START_HOUR = 22;
export const OVERNIGHT_WINDOW_END_HOUR = 2;

function isInOvernightWindow(hour: number): boolean {
  return hour >= OVERNIGHT_WINDOW_START_HOUR || hour < OVERNIGHT_WINDOW_END_HOUR;
}

function categoryForCount(scanCount: number): ScanCountCategory {
  if (scanCount <= 1) return 'single_scan';
  if (scanCount === 2) return 'two_scans';
  return 'three_or_more_scans';
}

/**
 * Groups already-mapped scan events by (employeeId, Africa/Blantyre
 * calendar date) and computes the review flags for each group. `events`
 * must already be filtered to rows with an active person-mapping --
 * callers never pass unmapped/anonymous rows in here (see
 * hikcentralAttendancePreviewService.ts and the page component, which keep
 * those two categories as separate aggregate counts only, per this
 * phase's explicit scope).
 */
export function buildEmployeeDayScanGroups(
  events: MappedScanEventRow[],
  employeesById: Map<string, EmployeeLite>
): EmployeeDayScanGroup[] {
  const byKey = new Map<string, MappedScanEventRow[]>();
  for (const event of events) {
    const localDate = blantyreDateKey(event.eventTimeIso);
    const key = `${event.employeeId}|${localDate}`;
    const existing = byKey.get(key);
    if (existing) existing.push(event);
    else byKey.set(key, [event]);
  }

  const groups: EmployeeDayScanGroup[] = [];
  for (const [key, group] of byKey) {
    const [employeeId, localDate] = key.split('|');
    const sorted = [...group].sort((a, b) => a.eventTimeIso.localeCompare(b.eventTimeIso));
    const scans: ObservedScan[] = sorted.map((e) => ({
      eventTimeIso: e.eventTimeIso,
      localTime: blantyreTimeOfDay(e.eventTimeIso),
      accessPoint: e.accessPoint,
    }));
    const accessPoints = Array.from(new Set(sorted.map((e) => e.accessPoint).filter((a): a is string => !!a))).sort();
    const scanCount = sorted.length;
    const scanCountCategory = categoryForCount(scanCount);

    const earliestScanIso = sorted[0].eventTimeIso;
    const latestScanIso = sorted[sorted.length - 1].eventTimeIso;
    const earliestHour = utcIsoToBlantyreParts(earliestScanIso).hour;
    const latestHour = utcIsoToBlantyreParts(latestScanIso).hour;

    const hasDuplicateTimestamp = sorted.some((e, i) => i > 0 && e.eventTimeIso === sorted[i - 1].eventTimeIso);

    const reviewFlags: ReviewFlag[] = [];
    if (scanCountCategory === 'single_scan') reviewFlags.push('single_scan');
    if (scanCountCategory === 'three_or_more_scans') reviewFlags.push('three_or_more_scans');
    if (accessPoints.length > 1) reviewFlags.push('multiple_sites');
    if (isInOvernightWindow(earliestHour) || isInOvernightWindow(latestHour)) reviewFlags.push('potential_overnight');
    if (hasDuplicateTimestamp) reviewFlags.push('duplicate_timestamp');

    groups.push({
      employeeId,
      employee: employeesById.get(employeeId) ?? null,
      localDate,
      scanCount,
      earliestScanIso,
      latestScanIso,
      scans,
      accessPoints,
      scanCountCategory,
      reviewFlags,
    });
  }

  return groups.sort((a, b) => (a.localDate === b.localDate ? a.employeeId.localeCompare(b.employeeId) : a.localDate.localeCompare(b.localDate)));
}
