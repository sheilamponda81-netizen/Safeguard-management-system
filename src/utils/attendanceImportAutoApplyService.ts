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
import { fetchAllPages } from './employeeBatchFetch';

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
  // PRODUCTION HOTFIX: was a single unpaginated query -- PostgREST's
  // 1000-row cap silently truncated the Active, non-deleted employee
  // population (already past 1000), meaning a workstation name that only
  // appeared among employees past the cap could silently vanish from this
  // checklist. fetchAllPages() (see Employees.tsx's identical fix) pages
  // through `.range()` until the server's own exact count is fully met.
  // `id` is a unique, deterministic order for stable page boundaries --
  // `workstation` itself is not unique and is the only other column
  // selected.
  const rows = await fetchAllPages<{ workstation: string | null }>((rangeFrom, rangeTo, withExactCount) => {
    const q = withExactCount
      ? supabase.from('employees').select('workstation', { count: 'exact' })
      : supabase.from('employees').select('workstation');
    return q
      .not('workstation', 'is', null)
      .eq('status', 'Active')
      .eq('is_deleted', false)
      .order('id')
      .range(rangeFrom, rangeTo);
  });
  const values = new Set<string>();
  rows.forEach((r) => {
    const v = (r.workstation || '').trim();
    if (v) values.add(v);
  });
  return Array.from(values).sort();
}

// ---- Stage C Step 11: employee -> HikCentral terminal assignment ----

/**
 * Active employee_hikcentral_terminals rows, keyed by employee_id -- the
 * expected terminal(s) each employee is genuinely associated with,
 * completely independent of employees.workstation. An employee absent
 * from this map has NO assigned terminal and can never resolve Absent
 * (see the Step 11 migration's attendance_resolve_and_calculate header).
 */
export async function fetchEmployeeTerminalAssignments(): Promise<Map<string, string[]>> {
  const { data, error } = await supabase
    .from('employee_hikcentral_terminals')
    .select('employee_id, access_point')
    .eq('is_active', true);
  if (error) throw error;
  const byEmployee = new Map<string, string[]>();
  (data || []).forEach((row: { employee_id: string; access_point: string }) => {
    const existing = byEmployee.get(row.employee_id);
    if (existing) existing.push(row.access_point);
    else byEmployee.set(row.employee_id, [row.access_point]);
  });
  return byEmployee;
}

/**
 * Sets one employee's COMPLETE desired set of assigned terminals in one
 * call (an "approved terminal group" is simply this set) -- reconciles
 * by revoking whatever's active-but-no-longer-declared and inserting
 * whatever's newly declared. Never infers a terminal from a single
 * observed fingerprint -- this is always an explicit administrator
 * declaration.
 */
export async function setEmployeeHikCentralTerminals(employeeId: string, accessPoints: string[]): Promise<void> {
  const { error } = await supabase.rpc('set_employee_hikcentral_terminals', {
    p_employee_id: employeeId,
    p_access_points: accessPoints,
  });
  if (error) throw error;
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

export type ProcessImportBatchOutcome = 'success' | 'unauthorized' | 'missing_rpc' | 'network_error' | 'unexpected_response' | 'needs_override_reason';

export interface NeedsTerminalConfigurationEmployee {
  employeeId: string;
  fullName: string;
}

/**
 * Phase 3: present only when outcome === 'needs_override_reason'. Nothing
 * has been written yet when this comes back -- no confirmation row, no
 * attendance calculation -- the declared coverage period reaches further
 * than the latest fingerprint event actually observed (for these access
 * points, within the declared window) supports. latestObservedEventAtIso
 * is diagnostic evidence only, per the corrected design principle -- it
 * is shown to help a human decide, never treated as proof either way.
 */
export interface CoverageEvidenceWarning {
  latestObservedEventAtIso: string | null;
  declaredCoversThroughIso: string;
  accessPoints: string[];
}

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
  /**
   * Stage C Step 11: mapped, in-scope, rostered employees with NO active
   * assigned HikCentral terminal -- they can never resolve Absent (see
   * the migration's attendance_resolve_and_calculate header) and are
   * surfaced here so an operator configures them, instead of the gap
   * going unnoticed.
   */
  needsTerminalConfiguration?: NeedsTerminalConfigurationEmployee[];
  coverageEvidenceWarning?: CoverageEvidenceWarning;
}

interface ProcessImportBatchRpcResponse {
  confirmation_id: string;
  employee_count: number;
  applied_count: number;
  unchanged_count: number;
  skipped_count: number;
  failed_count: number;
  rows: unknown[];
  needs_terminal_configuration?: Array<{ employee_id: string; full_name: string }> | null;
}

function isProcessImportBatchRpcResponse(data: unknown): data is ProcessImportBatchRpcResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { employee_count?: unknown }).employee_count === 'number' &&
    typeof (data as { applied_count?: unknown }).applied_count === 'number'
  );
}

interface NeedsOverrideReasonRpcResponse {
  status: 'needs_override_reason';
  latest_observed_event_at: string | null;
  declared_covers_through: string;
  access_points: string[];
}

function isNeedsOverrideReasonRpcResponse(data: unknown): data is NeedsOverrideReasonRpcResponse {
  return typeof data === 'object' && data !== null && (data as { status?: unknown }).status === 'needs_override_reason';
}

/**
 * Automatically records the declared coverage (idempotent -- reuses an
 * identical existing unrevoked confirmation rather than duplicating it)
 * and applies automatic attendance (now including a genuinely-confirmed
 * Absent) for every eligible employee over the declared date range --
 * ONE call, immediately after a successful import, no separate
 * confirmation step.
 *
 * Stage C Step 11: accessPoints is now the PRIMARY, required
 * declaration -- Safeguard has many employee workstations but only a
 * handful of centrally located HikCentral terminals, so requiring a
 * workstation selection for a normal import was backwards. workstations
 * is now optional, legacy, additive scope-inclusion only; it can never
 * by itself make anyone Absent-eligible (that now flows exclusively
 * through each employee's own assigned-terminal coverage -- see
 * employee_hikcentral_terminals / set_employee_hikcentral_terminals).
 */
export async function processHikCentralImportBatch(params: {
  importBatchId: string;
  accessPoints: string[];
  periodFromDate: string;
  periodToDate: string;
  dateFrom: string;
  dateTo: string;
  notes?: string;
  /** Optional, legacy, additive scope-inclusion only -- see this function's header. */
  workstations?: string[];
  /**
   * Phase 3: an explicit, human-authored reason confirming the declared
   * coverage period is correct even though it reaches beyond the latest
   * fingerprint evidence actually observed. Only consulted by the server
   * when that gap is actually detected; omit on a normal call. Blank/
   * whitespace-only is treated as not supplied (never silently accepted
   * as a reason). NEVER sufficient by itself -- see independentlyVerified.
   */
  overrideReason?: string;
  /**
   * Phase 3: a SEPARATE, required, explicit attestation that the
   * administrator actually checked the export's completeness against
   * HikCentral or the relevant site -- never inferred from overrideReason
   * merely being non-empty. The server rejects an override that supplies
   * a reason but not this flag, exactly as if neither were supplied.
   */
  independentlyVerified?: boolean;
}): Promise<ProcessImportBatchResult> {
  const { coversFromIso, coversThroughIso } = periodToCoverageWindow(params.periodFromDate, params.periodToDate);
  try {
    const { data, error } = await supabase.rpc('attendance_process_import_batch', {
      p_import_batch_id: params.importBatchId,
      p_access_points: params.accessPoints,
      p_covers_from: coversFromIso,
      p_covers_through: coversThroughIso,
      p_date_from: params.dateFrom,
      p_date_to: params.dateTo,
      p_notes: params.notes ?? null,
      p_workstations: params.workstations && params.workstations.length > 0 ? params.workstations : null,
      p_override_reason: params.overrideReason && params.overrideReason.trim() ? params.overrideReason.trim() : null,
      p_independently_verified: params.independentlyVerified === true,
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

    if (isNeedsOverrideReasonRpcResponse(data)) {
      return {
        success: false,
        outcome: 'needs_override_reason',
        error: 'The declared coverage period extends beyond the latest fingerprint evidence observed for these access points. Narrow the declared period to match the evidence, or provide an explicit reason to confirm this coverage anyway.',
        coverageEvidenceWarning: {
          latestObservedEventAtIso: data.latest_observed_event_at,
          declaredCoversThroughIso: data.declared_covers_through,
          accessPoints: data.access_points || [],
        },
      };
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
      needsTerminalConfiguration: (data.needs_terminal_configuration || []).map((e) => ({ employeeId: e.employee_id, fullName: e.full_name })),
    };
  } catch {
    return {
      success: false,
      outcome: 'network_error',
      error: 'Network error while processing automatic attendance for this import. Please try again.',
    };
  }
}
