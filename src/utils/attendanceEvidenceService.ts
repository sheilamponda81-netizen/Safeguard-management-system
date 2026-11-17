// Safeguard HikCentral Attendance MVP -- Attendance Evidence Centre,
// read-only v1: data access for a single employee-day's full evidence
// detail. Every query here is a plain SELECT (RLS-scoped exactly like
// every other page in this app) or a call to the EXISTING, already
// read-only attendance_preview_calculate RPC (fetchServerCalculationPreview,
// attendanceServerPreviewService.ts) -- there is no .insert()/.update()/
// .upsert()/.delete() anywhere in this file, and no new RPC or migration
// is introduced by this module. Nothing here ever writes to
// attendance, attendance_audit_log, payroll, roster, or employees.
import { supabase } from '../lib/supabase';
import { fetchAllPages } from './employeeBatchFetch';
import { fetchServerCalculationPreview, ServerCalculationPreviewRow } from './attendanceServerPreviewService';

const PAGE_SIZE = 1000;

export interface EvidenceRawEvent {
  timestampIso: string;
  accessPoint: string | null;
  cardReader: string | null;
  authenticationResult: string | null;
  eventType: string | null;
  importBatchId: string | null;
}

/**
 * Every raw event for ONE specific HikCentral person number in
 * `[fromUtcIso, toUtcIsoExclusive)` -- scoped to a single person
 * (never a whole-tenant fetch) because this is a single employee-day
 * detail view, not a tenant-wide listing. Still paginated via
 * fetchAllPages() on principle (an administrator can hand-correct
 * duplicate/odd scans onto a single person over months, and this must
 * never silently truncate), even though one person/one day is
 * realistically always far under the 1,000-row cap.
 */
export async function fetchRawEventsForPersonInRange(
  hikcentralPersonNo: string,
  fromUtcIso: string,
  toUtcIsoExclusive: string
): Promise<EvidenceRawEvent[]> {
  const rows = await fetchAllPages<{
    event_time: string;
    access_point: string | null;
    card_reader: string | null;
    authentication_result: string | null;
    event_type: string | null;
    import_batch_id: string | null;
  }>((rangeFrom, rangeTo, withExactCount) => {
    const columns = 'event_time, access_point, card_reader, authentication_result, event_type, import_batch_id';
    const q = withExactCount
      ? supabase.from('hikcentral_raw_events').select(columns, { count: 'exact' })
      : supabase.from('hikcentral_raw_events').select(columns);
    return q
      .eq('hikcentral_person_no', hikcentralPersonNo)
      .gte('event_time', fromUtcIso)
      .lt('event_time', toUtcIsoExclusive)
      .order('event_time')
      .range(rangeFrom, rangeTo);
  }, PAGE_SIZE);
  return rows.map((row) => ({
    timestampIso: row.event_time,
    accessPoint: row.access_point,
    cardReader: row.card_reader,
    authenticationResult: row.authentication_result,
    eventType: row.event_type,
    importBatchId: row.import_batch_id,
  }));
}

export interface EvidenceCoverageConfirmation {
  confirmedAt: string;
  coversFromIso: string;
  coversThroughIso: string;
  exportTimeDeclaredIso: string | null;
  accessPoints: string[];
  workstations: string[];
  revokedAt: string | null;
  revokedReason: string | null;
  /** Phase 3: the latest actual hikcentral_raw_events timestamp observed for this confirmation's access points/window at the moment it was created -- diagnostic only, never proof by itself. Null on confirmations created before Phase 3, or when no event was found at all. */
  latestObservedEventAtIso: string | null;
  /** Phase 3: true when this confirmation's declared covers_through was recorded even though it reached meaningfully beyond latestObservedEventAtIso -- always paired with a non-empty overrideReason. */
  exceedsObservedEvidence: boolean;
  overrideReason: string | null;
}

/** Every coverage confirmation (revoked or not -- revocation is shown, never hidden) whose own [covers_from, covers_through] overlaps the given window. Realistically a handful of rows per day; not expected to approach the page cap, but paginated on the same principle as the rest of this file. */
export async function fetchCoverageConfirmationsOverlapping(fromUtcIso: string, toUtcIsoExclusive: string): Promise<EvidenceCoverageConfirmation[]> {
  const rows = await fetchAllPages<{
    confirmed_at: string;
    covers_from: string;
    covers_through: string;
    export_time_declared: string | null;
    access_points: string[] | null;
    workstations: string[] | null;
    revoked_at: string | null;
    revoked_reason: string | null;
    latest_observed_event_at: string | null;
    exceeds_observed_evidence: boolean | null;
    override_reason: string | null;
  }>((rangeFrom, rangeTo, withExactCount) => {
    const columns = 'confirmed_at, covers_from, covers_through, export_time_declared, access_points, workstations, revoked_at, revoked_reason, latest_observed_event_at, exceeds_observed_evidence, override_reason';
    const q = withExactCount
      ? supabase.from('fingerprint_coverage_confirmations').select(columns, { count: 'exact' })
      : supabase.from('fingerprint_coverage_confirmations').select(columns);
    return q
      .lte('covers_from', toUtcIsoExclusive)
      .gte('covers_through', fromUtcIso)
      .order('confirmed_at')
      .range(rangeFrom, rangeTo);
  }, PAGE_SIZE);
  return rows.map((row) => ({
    confirmedAt: row.confirmed_at,
    coversFromIso: row.covers_from,
    coversThroughIso: row.covers_through,
    exportTimeDeclaredIso: row.export_time_declared,
    accessPoints: row.access_points || [],
    workstations: row.workstations || [],
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    latestObservedEventAtIso: row.latest_observed_event_at,
    exceedsObservedEvidence: row.exceeds_observed_evidence ?? false,
    overrideReason: row.override_reason,
  }));
}

export interface EvidenceImportBatch {
  id: string;
  filename: string | null;
  createdAtIso: string;
  completedAtIso: string | null;
  status: string | null;
}

/** Looks up only the specific batches named by id (e.g. the distinct importBatchId values among a day's raw events) -- never a tenant-wide batch listing. */
export async function fetchImportBatchesByIds(batchIds: string[]): Promise<EvidenceImportBatch[]> {
  const distinctIds = Array.from(new Set(batchIds.filter((id): id is string => !!id)));
  if (distinctIds.length === 0) return [];
  const { data, error } = await supabase
    .from('hikcentral_import_batches')
    .select('id, filename, created_at, completed_at, status')
    .in('id', distinctIds);
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    filename: row.filename,
    createdAtIso: row.created_at,
    completedAtIso: row.completed_at,
    status: row.status,
  }));
}

export interface AttendanceAuditEntry {
  oldStatus: string | null;
  newStatus: string;
  oldCalculationBasis: string | null;
  newCalculationBasis: string | null;
  changedBy: string | null;
  changeSource: string | null;
  reason: string | null;
  changedAtIso: string;
}

/** The full before/after/attribution timeline for one employee-day, oldest first -- read-only, never written to by this module. */
export async function fetchAuditTimelineForEmployeeDate(employeeId: string, date: string): Promise<AttendanceAuditEntry[]> {
  const { data, error } = await supabase
    .from('attendance_audit_log')
    .select('old_status, new_status, old_calculation_basis, new_calculation_basis, changed_by, change_source, reason, changed_at')
    .eq('employee_id', employeeId)
    .eq('attendance_date', date)
    .order('changed_at');
  if (error) throw error;
  return (data || []).map((row) => ({
    oldStatus: row.old_status,
    newStatus: row.new_status,
    oldCalculationBasis: row.old_calculation_basis,
    newCalculationBasis: row.new_calculation_basis,
    changedBy: row.changed_by,
    changeSource: row.change_source,
    reason: row.reason,
    changedAtIso: row.changed_at,
  }));
}

/** This employee's active HikCentral person number, or null if unmapped -- a single-row lookup for the detail view (the list view already has the tenant-wide mapping set; the detail view only ever needs one). */
export async function fetchActivePersonNoForEmployee(employeeId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('hikcentral_person_mappings')
    .select('hikcentral_person_no')
    .eq('employee_id', employeeId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data?.hikcentral_person_no ?? null;
}

export interface AttendanceEvidenceDetail {
  rawEvents: EvidenceRawEvent[];
  coverageConfirmations: EvidenceCoverageConfirmation[];
  importBatches: EvidenceImportBatch[];
  auditTimeline: AttendanceAuditEntry[];
  /** The server's OWN recalculation (attendance_preview_calculate), for the one employee/date requested -- null only if the server returned no row at all (e.g. employee has no mapping), never a client-side approximation standing in for it. */
  serverCalculation: ServerCalculationPreviewRow | null;
}

/**
 * Composes everything the Evidence Centre's detail panel needs for one
 * employee-day. `fromUtcIso`/`toUtcIsoExclusive` should already be widened
 * by the caller to cover the full relevant shift window (the same
 * widening the Attendance Calculation Preview already applies for
 * overnight shifts) -- this function does no widening of its own, so
 * that the caller's own window logic stays the single source of truth.
 */
export async function fetchAttendanceEvidenceDetail(
  employeeId: string,
  date: string,
  fromUtcIso: string,
  toUtcIsoExclusive: string
): Promise<AttendanceEvidenceDetail> {
  const [personNo, auditTimeline, coverageConfirmations, serverRows] = await Promise.all([
    fetchActivePersonNoForEmployee(employeeId),
    fetchAuditTimelineForEmployeeDate(employeeId, date),
    fetchCoverageConfirmationsOverlapping(fromUtcIso, toUtcIsoExclusive),
    fetchServerCalculationPreview([employeeId], date, date),
  ]);

  const rawEvents = personNo ? await fetchRawEventsForPersonInRange(personNo, fromUtcIso, toUtcIsoExclusive) : [];
  const importBatches = await fetchImportBatchesByIds(rawEvents.map((e) => e.importBatchId).filter((id): id is string => !!id));

  return {
    rawEvents,
    coverageConfirmations,
    importBatches,
    auditTimeline,
    serverCalculation: serverRows.find((r) => r.attendanceDate === date) ?? null,
  };
}
