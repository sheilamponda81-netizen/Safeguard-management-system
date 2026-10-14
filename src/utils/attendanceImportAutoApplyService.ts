// Safeguard HikCentral Attendance MVP -- Stage C, Step 8: connects a
// successful HikCentral import directly to automatic attendance
// calculation and write-through, via the new
// attendance_process_import_batch RPC (supabase/migrations/
// 20261016000000_attendance_import_auto_apply.sql). Called automatically
// by HikCentralImport.tsx immediately after import_hikcentral_raw_events
// succeeds -- there is no separate confirmation screen/button for this.
//
// Follows the same never-throws, discriminated-outcome convention as
// hikcentralImportService.ts's importHikCentralRawEvents().
import { supabase } from '../lib/supabase';
import { AFRICA_BLANTYRE_OFFSET_MINUTES } from './hikcentralExcelParser';

const RPC_NOT_FOUND_CODE = 'PGRST202';

/**
 * Africa/Blantyre is a fixed UTC+2 offset, no DST -- same formula as the
 * (private) blantyreDateTimeToUtcIso in attendanceCalculationEngine.ts
 * and the SQL attendance_blantyre_to_utc() function: treat the given
 * local wall-clock date+time as if it were already UTC, then subtract
 * the offset to get the real UTC instant.
 */
function blantyreToUtcIso(dateStr: string, hhmm: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const utcMillis = Date.UTC(y, m - 1, d, hh, mm, 0) - AFRICA_BLANTYRE_OFFSET_MINUTES * 60_000;
  return new Date(utcMillis).toISOString();
}

/**
 * The declared period an administrator asserts a HikCentral export
 * covers, as two Africa/Blantyre calendar dates (inclusive) -- converted
 * here to the exact UTC instants fingerprint_coverage_confirmations
 * needs: from the START of periodFromDate's day to the END of
 * periodToDate's day (23:59), so the confirmation fully spans every
 * shift whose own calendar date falls anywhere in the declared range,
 * including a Night shift starting on periodToDate itself (its checkout
 * window reaches into the following morning -- see the companion
 * attendance_process_import_batch comment for why only a caller who
 * explicitly includes that extra day gets Night shifts on the period's
 * last date credited at all; this helper does not silently add it).
 */
export function periodToCoverageWindow(periodFromDate: string, periodToDate: string): { coversFromIso: string; coversThroughIso: string } {
  return {
    coversFromIso: blantyreToUtcIso(periodFromDate, '00:00'),
    coversThroughIso: blantyreToUtcIso(periodToDate, '23:59'),
  };
}

/** The Africa/Blantyre calendar date (YYYY-MM-DD) a UTC instant falls on -- used only to PRE-FILL the import page's period inputs from the file's own earliest/latest event timestamps as a convenience default; the administrator still explicitly confirms (or adjusts) the declared period before import, it is never silently trusted as proof of coverage on its own. */
export function isoToBlantyreDateStr(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + AFRICA_BLANTYRE_OFFSET_MINUTES * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Distinct, non-empty `employees.workstation` values for the caller's own tenant (RLS-scoped) -- used to populate the import page's "which workstations does this export cover" checklist. Read-only. */
export async function fetchDistinctWorkstations(): Promise<string[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('workstation')
    .not('workstation', 'is', null)
    .eq('status', 'Active')
    .eq('is_deleted', false);
  if (error) throw error;
  const values = new Set<string>();
  (data || []).forEach((r: { workstation: string | null }) => {
    const v = (r.workstation || '').trim();
    if (v) values.add(v);
  });
  return Array.from(values).sort();
}

// ---- Stage C Step 10: batch continuity (coverage timeline / gaps) ----

export interface CoverageTimelineEntry {
  scopeType: 'workstation' | 'access_point';
  scopeKey: string;
  firstCoveredDate: string;
  lastCoveredDate: string;
  nextExpectedDate: string;
  missingDates: string[];
}

interface CoverageTimelineRpcRow {
  scope_type: 'workstation' | 'access_point';
  scope_key: string;
  first_covered_date: string;
  last_covered_date: string;
  next_expected_date: string;
  missing_dates: string[] | null;
}

/**
 * Per declared workstation/access_point: the earliest and latest
 * Africa/Blantyre calendar date any non-revoked coverage confirmation
 * declares as covered, the next date to upload, and any calendar dates
 * BETWEEN those two that no confirmation covers -- a genuine gap in the
 * declared timeline. Never inferred from whether anyone fingerprinted;
 * purely a readback of administrator-declared coverage confirmations
 * (hikcentral_coverage_timeline RPC). Throws on error -- callers decide
 * how to degrade (the import page treats "RPC not found" as "this
 * environment predates Step 10" and simply hides the panel).
 */
export async function fetchCoverageTimeline(lookbackDays = 120): Promise<CoverageTimelineEntry[]> {
  const { data, error } = await supabase.rpc('hikcentral_coverage_timeline', { p_lookback_days: lookbackDays });
  if (error) throw error;
  return ((data || []) as CoverageTimelineRpcRow[]).map((row) => ({
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    firstCoveredDate: row.first_covered_date,
    lastCoveredDate: row.last_covered_date,
    nextExpectedDate: row.next_expected_date,
    missingDates: row.missing_dates || [],
  }));
}

// ---- Stage C Step 10: site-level absence alerts ----

export interface SiteAbsenceAlertEmployee {
  employeeId: string;
  fullName: string;
}

export interface SiteAbsenceAlert {
  id: string;
  site: string;
  alertDate: string;
  status: 'open' | 'closed';
  absentCountAtCreation: number;
  currentAbsentCount: number;
  affectedEmployees: SiteAbsenceAlertEmployee[];
  createdAt: string;
  closedBy: string | null;
  closedAt: string | null;
  closedNote: string | null;
}

interface SiteAbsenceAlertRpcRow {
  id: string;
  site: string;
  alert_date: string;
  status: 'open' | 'closed';
  absent_count_at_creation: number;
  current_absent_count: number;
  affected_employees: Array<{ employee_id: string; full_name: string }> | null;
  created_at: string;
  closed_by: string | null;
  closed_at: string | null;
  closed_note: string | null;
}

function mapSiteAbsenceAlertRow(row: SiteAbsenceAlertRpcRow): SiteAbsenceAlert {
  return {
    id: row.id,
    site: row.site,
    alertDate: row.alert_date,
    status: row.status,
    absentCountAtCreation: row.absent_count_at_creation,
    currentAbsentCount: row.current_absent_count,
    affectedEmployees: (row.affected_employees || []).map((e) => ({ employeeId: e.employee_id, fullName: e.full_name })),
    createdAt: row.created_at,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    closedNote: row.closed_note,
  };
}

/**
 * Automatically-created alerts for 5+ employees Absent at the same
 * SCHEDULED site on the same date (attendance_site_absence_alerts,
 * populated by a database trigger on attendance -- never created from
 * this client). current_absent_count/affected_employees are recomputed
 * LIVE against today's attendance, so a later manual correction that
 * drops the count below 5 is reflected here without deleting the
 * alert's own audit record (created_at/absent_count_at_creation never
 * change). Pass status to filter ('open' | 'closed'); omit for both.
 */
export async function fetchSiteAbsenceAlerts(status?: 'open' | 'closed'): Promise<SiteAbsenceAlert[]> {
  const { data, error } = await supabase.rpc('attendance_site_absence_alerts_list', { p_status: status ?? null });
  if (error) throw error;
  return ((data || []) as SiteAbsenceAlertRpcRow[]).map(mapSiteAbsenceAlertRow);
}

/**
 * Acknowledges (closes) a site absence alert with a required note. Never
 * modifies attendance -- only the alert row's own status/closed_* columns.
 * Idempotent: acknowledging an already-closed alert returns it unchanged
 * rather than erroring.
 */
export async function acknowledgeSiteAlert(alertId: string, note: string): Promise<SiteAbsenceAlert> {
  const { data, error } = await supabase.rpc('attendance_site_alert_acknowledge', { p_alert_id: alertId, p_note: note });
  if (error) throw error;
  return mapSiteAbsenceAlertRow(data as SiteAbsenceAlertRpcRow);
}

export type ProcessImportBatchOutcome = 'success' | 'unauthorized' | 'missing_rpc' | 'network_error' | 'unexpected_response';

export interface ProcessImportBatchResult {
  success: boolean;
  outcome: ProcessImportBatchOutcome;
  error?: string;
  confirmationId?: string;
  employeeCount?: number;
  appliedCount?: number;
  unchangedCount?: number;
  skippedCount?: number;
  failedCount?: number;
}

interface ProcessImportBatchRpcResponse {
  confirmation_id: string;
  employee_count: number;
  applied_count: number;
  unchanged_count: number;
  skipped_count: number;
  failed_count: number;
  rows: unknown[];
}

function isProcessImportBatchRpcResponse(data: unknown): data is ProcessImportBatchRpcResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { employee_count?: unknown }).employee_count === 'number' &&
    typeof (data as { applied_count?: unknown }).applied_count === 'number'
  );
}

/**
 * Automatically records the declared coverage (idempotent -- reuses an
 * identical existing unrevoked confirmation rather than duplicating it)
 * and applies automatic attendance (now including a genuinely-confirmed
 * Absent) for every active employee at the declared workstations, over
 * the declared date range -- ONE call, immediately after a successful
 * import, no separate confirmation step.
 */
export async function processHikCentralImportBatch(params: {
  importBatchId: string;
  workstations: string[];
  periodFromDate: string;
  periodToDate: string;
  dateFrom: string;
  dateTo: string;
  notes?: string;
  /**
   * HikCentral's own access_point values this import's raw events were
   * actually observed at (e.g. the parsed file's summary.accessPoints) --
   * Stage C Step 8B correction. Independent of employees.workstation: an
   * employee whose stored home workstation differs from the site they
   * actually badged in at (a guard transferred between sites) is still
   * recognized for automatic Present/Late, because their mapped identity
   * is matched here by the authoritative access_point actually recorded
   * by HikCentral, not by comparing against a free-text home-workstation
   * field. Optional -- omitting it falls back to workstation-only scope
   * (the pre-Step-8B behavior).
   */
  accessPoints?: string[];
}): Promise<ProcessImportBatchResult> {
  const { coversFromIso, coversThroughIso } = periodToCoverageWindow(params.periodFromDate, params.periodToDate);
  try {
    const { data, error } = await supabase.rpc('attendance_process_import_batch', {
      p_import_batch_id: params.importBatchId,
      p_workstations: params.workstations,
      p_covers_from: coversFromIso,
      p_covers_through: coversThroughIso,
      p_date_from: params.dateFrom,
      p_date_to: params.dateTo,
      p_notes: params.notes ?? null,
      p_access_points: params.accessPoints && params.accessPoints.length > 0 ? params.accessPoints : null,
    });

    if (error) {
      if (error.code === RPC_NOT_FOUND_CODE) {
        return {
          success: false,
          outcome: 'missing_rpc',
          error: 'Automatic attendance processing is not available yet in this environment (database migration not applied).',
        };
      }
      return { success: false, outcome: 'unauthorized', error: error.message };
    }

    if (!isProcessImportBatchRpcResponse(data)) {
      return { success: false, outcome: 'unexpected_response', error: 'Unexpected response from the server while processing attendance for this import.' };
    }

    return {
      success: true,
      outcome: 'success',
      confirmationId: data.confirmation_id,
      employeeCount: data.employee_count,
      appliedCount: data.applied_count,
      unchangedCount: data.unchanged_count,
      skippedCount: data.skipped_count,
      failedCount: data.failed_count,
    };
  } catch {
    return {
      success: false,
      outcome: 'network_error',
      error: 'Network error while processing automatic attendance for this import. Please try again.',
    };
  }
}
