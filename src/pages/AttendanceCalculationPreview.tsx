// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage B, plus the
// Attendance Review usability redesign.
//
// Shows what the Stage A pure engine (attendanceCalculationEngine.ts)
// WOULD calculate for each employee/shift-date, using real roster
// resolution and real fingerprint data -- but writes nothing. There is
// no save/apply/confirm action anywhere on this page. The existing
// official `attendance.status` (and its decision source) is shown
// purely for read-only comparison.
//
// COVERAGE: an administrator-entered export time is never, by itself,
// treated as proof that fingerprint data is complete -- see
// attendanceCalculationPreview.ts's resolveCoveragePolicy. Only an
// explicit operator confirmation, naming specific workstations, turns
// it into real coverage for those workstations. Every other employee's
// shift stays Pending rather than silently becoming a false Absent.
//
// USABILITY REDESIGN (this pass): replaces the former stacked-card list
// with a compact register (Table/THead/TBody/TR/TH/TD, genuine
// Previous/Next pagination over the COMPLETE filtered result -- no
// row-count cap of any kind), adds a decision-source column/filter, a
// documented "Needs Review" filter (see classifyAttendanceReviewSignal's
// own header for its exact, deliberately non-misleading semantics), and
// moves the Details view into a Modal so the default row stays concise.
// Still strictly read-only: no new write path of any kind is added.
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Eye, Search, AlertTriangle, RefreshCw, Clock, MapPin, CalendarDays, ClipboardCheck,
  ShieldCheck, ChevronDown, ChevronUp, Info, CheckCircle2, XCircle, HelpCircle, History, User,
} from '../utils/icons';
import { Card, Button, Badge, PageHeader, EmptyState, Input, Select, StatCard, Modal, Table, THead, TBody, TR, TH, TD } from '../components/ui';
import { hasPermission, PERMISSIONS } from '../utils/permissions';
import { expandDateRange, ResolvedSchedule } from '../utils/rosterSchedule';
import { AttendanceCalculationStatus } from '../utils/attendanceCalculationEngine';
import {
  resolveCoveragePolicy, collectEmployeeIdsWithRosterEvidence, collectEmployeeIdsWithFingerprintEvidence,
  hasAnyEmployeeWithBothRosterAndFingerprintEvidence, describeDateExtent, buildAttendanceCalculationPreviewRows,
  filterAttendancePreviewRows, buildSiteAlertCasesFromRows, classifyAttendanceReviewSignal,
  AttendanceCalculationPreviewRow, AttendanceReviewSignal, ServerCoverageEvidence,
} from '../utils/attendanceCalculationPreview';
import { aggregateSiteAlerts, SiteAlert } from '../utils/attendanceSiteAlerts';
import { fetchAttendanceCalculationPreviewData, fetchOfficialAttendanceSourceByKey, fetchAttendanceCoverageExplain } from '../utils/attendanceCalculationPreviewService';
import { fetchAuditTimelineForEmployeeDate, AttendanceAuditEntry } from '../utils/attendanceEvidenceService';
import { fetchProfileFullNamesById } from '../utils/hikcentralPersonMappingService';

// This page joins employees x roster x fingerprint x official-attendance
// per date, which is heavier per day than the simpler scan-grouping
// preview -- a tighter range cap than that page's 92 days.
const MAX_RANGE_DAYS = 31;
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

const RESULT_LABELS: Record<AttendanceCalculationStatus, string> = {
  present: 'Present',
  late: 'Late',
  absent: 'Absent',
  pending: 'Pending',
  off: 'Off',
  unassigned: 'Unassigned',
};

const RESULT_COLORS: Record<AttendanceCalculationStatus, 'green' | 'gold' | 'red' | 'gray' | 'blue' | 'navy'> = {
  present: 'green',
  late: 'gold',
  absent: 'red',
  pending: 'gray',
  off: 'blue',
  unassigned: 'navy',
};

const OFFICIAL_STATUS_LABELS: Record<string, string> = {
  P: 'Present', A: 'Absent', L: 'Late', LV: 'Leave', SL: 'Sick Leave', '-': 'Not marked',
};

/** 'automatic' | 'manual' | null (no source recorded, e.g. a row from before this column existed) -- never guessed from a preview/official mismatch. */
type SourceFilter = 'automatic' | 'manual' | '';
/** See classifyAttendanceReviewSignal's own header for exactly what each of these means and why 'uncertain' is kept separate from 'contradiction'. */
type ReviewFilter = '' | 'any' | 'contradiction' | 'uncertain';

function sourceLabel(source: string | null | undefined, hasOfficialStatus: boolean): string {
  if (source === 'automatic') return 'Automatic';
  if (source === 'manual') return 'Manual';
  // No source recorded at all. Only ambiguous ("Unknown") when there IS
  // an official status to have a source for -- otherwise there's simply
  // nothing to attribute yet, which is not the same claim.
  return hasOfficialStatus ? 'Unknown' : '—';
}

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { from: toDateInputValue(from), to: toDateInputValue(to) };
}

function daySpan(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

function formatLocalTime(iso: string | null): string {
  if (!iso) return '—';
  // Display-only Africa/Blantyre HH:MM, consistent with how the rest of
  // the HikCentral preview pages render a UTC instant locally.
  const d = new Date(new Date(iso).getTime() + 2 * 60 * 60_000);
  return d.toISOString().slice(11, 16);
}

function rowKeyOf(row: AttendanceCalculationPreviewRow): string {
  return `${row.employeeId}|${row.shiftDate}`;
}

type ManualDetailState =
  | { status: 'loading' }
  | { status: 'ready'; entries: AttendanceAuditEntry[]; reviewerNameById: Map<string, string> }
  | { status: 'error'; message: string };

/**
 * Compact detail Modal for one employee-day -- deliberately LIGHTER than
 * the Attendance Evidence Centre's own per-row drill-down (raw scan
 * lists, coverage-confirmation history, the server's own recalculation
 * RPC): this page's job is everyday review, not forensic investigation.
 * For a manual decision, fetches ONLY this employee-day's own audit
 * timeline (never a tenant-wide query) plus a best-effort reviewer name
 * -- lazily, only while the modal for THAT row is open, and only once
 * per row per page load (cached by key). Never invents a reviewer,
 * reason, or timestamp that wasn't actually recorded.
 */
function AttendanceReviewDetailsModal({
  row, open, onClose, officialSource, reviewSignal, manualDetail, serverCoverage,
}: {
  row: AttendanceCalculationPreviewRow | null;
  open: boolean;
  onClose: () => void;
  officialSource: string | null;
  reviewSignal: AttendanceReviewSignal;
  manualDetail: ManualDetailState | null;
  serverCoverage: ServerCoverageEvidence | null;
}) {
  if (!row) return <Modal open={open} onClose={onClose} title="Attendance details" size="lg"><p className="text-sm text-slate-500">No row selected.</p></Modal>;

  const mappingProblem = !row.hasActiveMapping && (row.resolvedShift === 'day' || row.resolvedShift === 'night');
  const isProvisional = row.calculation.basis === 'check_in_only_provisional';
  // Attendance coverage-consistency improvement: prefer explaining
  // coverage with the real, persisted, server-evidence reason whenever
  // one exists for this employee-day -- this is the SAME trustworthy
  // explanation attendance_coverage_explain gives Stage C, so HR sees
  // one consistent story rather than a bare "confirmed"/"insufficient"
  // toggle. An operator's own live, session-typed confirmation (this
  // page's existing coverage-settings section, still below) can still
  // independently reach 'confirmed_complete' even when server evidence
  // alone would not -- that case is called out explicitly rather than
  // overwritten by the server's own (here, insufficient) reason.
  const coverageFromServer = row.coverage.status === 'confirmed_complete' && serverCoverage?.confirmedThroughIso === row.coverage.verifiedThroughIso;
  const coverageText =
    row.coverage.status === 'confirmed_complete'
      ? coverageFromServer
        ? `${serverCoverage!.reason} (confirmed through ${formatLocalTime(serverCoverage!.confirmedThroughIso)}, Blantyre)`
        : `Confirmed complete through ${formatLocalTime(row.coverage.verifiedThroughIso ?? null)} (Blantyre) -- operator-confirmed this session`
      : !row.hasActiveMapping
      ? 'Insufficient -- no HikCentral person mapping confirmed for this employee yet'
      : serverCoverage?.reason ?? 'Insufficient -- no coverage confirmed for this workstation';

  return (
    <Modal open={open} onClose={onClose} title={`${row.employeeName} (${row.employeeNumber})`} size="lg">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
          <span className="inline-flex items-center gap-1"><CalendarDays size={13} /> {row.shiftDate}</span>
          <span>&middot;</span>
          <span className="inline-flex items-center gap-1"><MapPin size={13} /> {row.workstation || '—'}</span>
          <span>&middot;</span>
          <span className="capitalize">{row.resolvedShift}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Expected shift start / end</p>
            <p className="text-slate-700">{row.expectedShiftTimes ? `${row.expectedShiftTimes.scheduledStart} – ${row.expectedShiftTimes.scheduledEnd}` : '—'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Actual matched scans</p>
            <p className="text-slate-700 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1"><Clock size={11} className="text-slate-400" /> Check-in: {formatLocalTime(row.calculation.checkInIso)}</span>
              <span className="inline-flex items-center gap-1"><Clock size={11} className="text-slate-400" /> Checkout: {formatLocalTime(row.calculation.checkOutIso)}</span>
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Fingerprint coverage state</p>
            <p className="text-slate-700">{coverageText}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Calculated result</p>
            <p className="flex items-center gap-2">
              <Badge color={RESULT_COLORS[row.calculation.status]}>{RESULT_LABELS[row.calculation.status]}</Badge>
              {isProvisional && (
                <span title="Credited from a single valid check-in alone, before the checkout window closed -- not yet a confirmed result.">
                  <Badge color="gold">Provisional</Badge>
                </span>
              )}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Official attendance status</p>
            <p className="text-slate-700">{row.officialStatus ? (OFFICIAL_STATUS_LABELS[row.officialStatus] ?? row.officialStatus) : 'Not marked'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Official decision source</p>
            <p className="text-slate-700">{sourceLabel(officialSource, !!row.officialStatus)}</p>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Calculation explanation</p>
          <p className="text-sm text-slate-600">{row.calculation.reason}</p>
          {mappingProblem && (
            <p className="text-amber-700 text-sm mt-1 flex items-start gap-1">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              No HikCentral person mapping confirmed yet for this employee -- zero scans here does not mean they were absent.
            </p>
          )}
        </div>

        {reviewSignal !== 'none' && (
          <div className={reviewSignal === 'contradiction' ? 'rounded-lg border border-red-200 bg-red-50 p-3' : 'rounded-lg border border-amber-200 bg-amber-50 p-3'}>
            <p className={reviewSignal === 'contradiction' ? 'text-sm text-red-800 flex items-start gap-2' : 'text-sm text-amber-800 flex items-start gap-2'}>
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              {reviewSignal === 'contradiction'
                ? "The official record and this page's own calculation disagree. This is a read-only investigation signal, not proof the official record is wrong -- it does not change official Attendance or Payroll."
                : "This page's own calculation cannot yet confirm or dispute the official record (fingerprint evidence is still incomplete or only provisional) -- this is a gap in current evidence, not a confirmed conflict."}
            </p>
          </div>
        )}

        {officialSource === 'manual' && (
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1 flex items-center gap-1"><History size={13} /> Manual decision history</p>
            {manualDetail === null || manualDetail.status === 'loading' ? (
              <p className="text-sm text-slate-400">Loading audit history…</p>
            ) : manualDetail.status === 'error' ? (
              <p className="text-sm text-red-600">Could not load audit history: {manualDetail.message}</p>
            ) : manualDetail.entries.length === 0 ? (
              <p className="text-sm text-amber-700">Historical source unavailable -- no audit record was found for this employee-day.</p>
            ) : (
              <ul className="text-sm space-y-2">
                {manualDetail.entries.map((entry, i) => (
                  <li key={i} className="border-t border-slate-100 pt-2">
                    <p className="text-slate-700">
                      {formatLocalTime(entry.changedAtIso)} on {entry.changedAtIso.slice(0, 10)} &middot;{' '}
                      {entry.oldStatus ? (OFFICIAL_STATUS_LABELS[entry.oldStatus] ?? entry.oldStatus) : '(none)'} &rarr;{' '}
                      {OFFICIAL_STATUS_LABELS[entry.newStatus] ?? entry.newStatus}
                    </p>
                    <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                      <User size={11} />
                      Reviewer: {entry.changedBy ? (manualDetail.reviewerNameById.get(entry.changedBy) ?? 'Unknown (name not available)') : 'Unknown'}
                    </p>
                    {entry.reason ? (
                      <p className="text-xs text-slate-600 mt-0.5">Reason: "{entry.reason}"</p>
                    ) : (
                      <p className="text-xs text-amber-600 mt-0.5">No reason recorded for this change.</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <p className="text-xs text-slate-400 border-t border-slate-100 pt-3">
          This is a read-only summary. For raw fingerprint scans, coverage-confirmation history, and the server's own
          recalculation for this employee-day, use the Evidence Centre tab.
        </p>
      </div>
    </Modal>
  );
}

export default function AttendanceCalculationPreviewPage() {
  const [canView, setCanView] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);

  const defaults = useMemo(defaultDateRange, []);
  const [fromDate, setFromDate] = useState(defaults.from);
  const [toDate, setToDate] = useState(defaults.to);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [shiftFilter, setShiftFilter] = useState<ResolvedSchedule | ''>('');
  const [resultFilter, setResultFilter] = useState<AttendanceCalculationStatus | ''>('');
  const [officialStatusFilter, setOfficialStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('');
  // Default view: scheduled Day/Night shifts only -- Off/Unassigned days
  // are real, correct results (never a bug), but repeating them for
  // every employee on every date would flood the list. This toggle is
  // purely a display preference; it never changes what was calculated
  // or how many rows exist underneath.
  const [showOffUnassigned, setShowOffUnassigned] = useState(false);
  const [coverageSectionOpen, setCoverageSectionOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0]);

  // Coverage workflow inputs -- see attendanceCalculationPreview.ts's
  // resolveCoveragePolicy for why typing an export time alone never
  // confirms coverage.
  const [exportTimeBlantyreLocal, setExportTimeBlantyreLocal] = useState('');
  const [confirmedWorkstationsRaw, setConfirmedWorkstationsRaw] = useState('');
  const [operatorConfirmed, setOperatorConfirmed] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchAttendanceCalculationPreviewData>> | null>(null);
  const [officialSourceByKey, setOfficialSourceByKey] = useState<Map<string, string | null>>(new Map());
  const [serverCoverageByKey, setServerCoverageByKey] = useState<Map<string, ServerCoverageEvidence>>(new Map());
  const [expandedAlertIndex, setExpandedAlertIndex] = useState<number | null>(null);

  const [detailsRow, setDetailsRow] = useState<AttendanceCalculationPreviewRow | null>(null);
  const [manualDetailByKey, setManualDetailByKey] = useState<Map<string, ManualDetailState>>(new Map());

  const rangeTooWide = daySpan(fromDate, toDate) > MAX_RANGE_DAYS;
  const rangeInvalid = fromDate > toDate;

  useEffect(() => {
    (async () => {
      setCanView(await hasPermission(PERMISSIONS.ATTENDANCE_MAP_HIKCENTRAL_PERSONS));
      setPermissionsLoaded(true);
    })();
  }, []);

  const loadData = useCallback(async () => {
    if (rangeInvalid || rangeTooWide) return;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await fetchAttendanceCalculationPreviewData(fromDate, toDate);
      const [sourceByKey, coverageByKey] = await Promise.all([
        fetchOfficialAttendanceSourceByKey(result.employees.map((e) => e.id), fromDate, toDate),
        fetchAttendanceCoverageExplain(result.employees.map((e) => e.id), fromDate, toDate),
      ]);
      setData(result);
      setOfficialSourceByKey(sourceByKey);
      setServerCoverageByKey(coverageByKey);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the Attendance Review.');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, rangeInvalid, rangeTooWide]);

  useEffect(() => {
    if (permissionsLoaded && canView) loadData();
  }, [permissionsLoaded, canView, loadData]);

  const coveragePolicy = useMemo(
    () => resolveCoveragePolicy({ exportTimeBlantyreLocal, confirmedWorkstationsRaw, operatorConfirmed }),
    [exportTimeBlantyreLocal, confirmedWorkstationsRaw, operatorConfirmed]
  );

  const rosterIds = useMemo(
    () => (data ? collectEmployeeIdsWithRosterEvidence(data.datedAssignments, data.patterns, data.shiftPatterns) : new Set<string>()),
    [data]
  );
  const fingerprintIds = useMemo(
    () => (data ? collectEmployeeIdsWithFingerprintEvidence(data.eventsByEmployeeId) : new Set<string>()),
    [data]
  );
  const hasOverlap = useMemo(() => hasAnyEmployeeWithBothRosterAndFingerprintEvidence(rosterIds, fingerprintIds), [rosterIds, fingerprintIds]);

  const rosterDateExtent = useMemo(
    () => (data ? describeDateExtent(data.datedAssignments.map((a) => a.assignmentDate)) : null),
    [data]
  );
  const fingerprintDateExtent = useMemo(() => {
    if (!data) return null;
    const allTimestamps: string[] = [];
    for (const events of data.eventsByEmployeeId.values()) for (const e of events) allTimestamps.push(e.timestampIso.slice(0, 10));
    return describeDateExtent(allTimestamps);
  }, [data]);

  const shiftDates = useMemo(() => (rangeInvalid || rangeTooWide ? [] : expandDateRange(fromDate, toDate)), [fromDate, toDate, rangeInvalid, rangeTooWide]);

  const candidateEmployees = useMemo(() => {
    if (!data) return [];
    const candidateIds = new Set([...rosterIds, ...fingerprintIds]);
    return data.employees.filter((e) => candidateIds.has(e.id));
  }, [data, rosterIds, fingerprintIds]);

  // ROSTER-FIRST: every employee with roster OR fingerprint evidence
  // (candidateEmployees, the union) gets a row for every shiftDate --
  // never gated on the two sources overlapping. An employee with a
  // resolved Day/Night shift and zero fingerprint events still appears,
  // calculating Pending (or Absent only once coverage is genuinely
  // confirmed for their workstation -- see resolveCoveragePolicy).
  const rows: AttendanceCalculationPreviewRow[] = useMemo(() => {
    if (!data) return [];
    return buildAttendanceCalculationPreviewRows({
      employees: candidateEmployees,
      shiftDates,
      datedAssignments: data.datedAssignments,
      patterns: data.patterns,
      shiftPatterns: data.shiftPatterns,
      eventsByEmployeeId: data.eventsByEmployeeId,
      coveragePolicy,
      officialStatusByKey: data.officialStatusByKey,
      employeeIdsWithActiveMapping: data.employeeIdsWithActiveMapping,
      serverCoverageByKey,
      asOfIso: new Date().toISOString(),
    });
  }, [data, candidateEmployees, shiftDates, coveragePolicy, serverCoverageByKey]);

  const siteOptions = useMemo(() => Array.from(new Set(rows.map((r) => r.workstation))).sort(), [rows]);

  // Default view hides Off/Unassigned rows (never a bug, just noise at
  // scale) UNLESS the user explicitly asked for them, either via the
  // "Show Off/Unassigned" toggle or by picking "Off"/"Unassigned"
  // directly in the Shift filter -- an explicit choice always wins.
  const filteredRows = useMemo(() => {
    let base = filterAttendancePreviewRows(rows, { siteFilter, shiftFilter, resultFilter, employeeSearch });
    if (!(showOffUnassigned || shiftFilter === 'off' || shiftFilter === 'unassigned')) {
      base = base.filter((r) => r.resolvedShift === 'day' || r.resolvedShift === 'night');
    }
    if (officialStatusFilter) {
      base = base.filter((r) => r.officialStatus === officialStatusFilter);
    }
    if (sourceFilter) {
      base = base.filter((r) => officialSourceByKey.get(rowKeyOf(r)) === sourceFilter);
    }
    if (reviewFilter) {
      base = base.filter((r) => {
        const signal = classifyAttendanceReviewSignal(r);
        if (reviewFilter === 'any') return signal !== 'none';
        return signal === reviewFilter;
      });
    }
    return base;
  }, [rows, siteFilter, shiftFilter, resultFilter, employeeSearch, showOffUnassigned, officialStatusFilter, sourceFilter, reviewFilter, officialSourceByKey]);

  // Genuine pagination over the COMPLETE filtered result -- there is no
  // row-count cap anywhere above this. The underlying data fetch is
  // already bounded (MAX_RANGE_DAYS calendar days, RLS-scoped employees
  // only) and already exhaustively paginated at the network layer
  // (fetchAllPages/fetchInEmployeeIdBatches), so building every row for
  // the selected range and paginating the resulting in-memory array is a
  // proven, non-truncating architecture -- the same one the Evidence
  // Centre uses, fixed there during the Phase 2 release review after an
  // earlier version of this exact page still capped display at 500 rows
  // underneath a later-added "page 1 of N" label. Never repeat that: no
  // slice() of any kind happens before totalPages/visibleRows below.
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [siteFilter, shiftFilter, resultFilter, employeeSearch, showOffUnassigned, officialStatusFilter, sourceFilter, reviewFilter, fromDate, toDate, pageSize]);

  const siteAlerts: SiteAlert[] = useMemo(() => {
    if (rows.length === 0) return [];
    const { cases, workstationLabelByKey } = buildSiteAlertCasesFromRows(rows);
    return aggregateSiteAlerts(cases).map((alert) => ({ ...alert, workstation: workstationLabelByKey.get(alert.workstation) ?? alert.workstation }));
  }, [rows]);

  // Summary counts are deliberately computed from `rows` -- every row
  // calculated for the selected date range -- NOT from `filteredRows`/
  // `visibleRows`. They are therefore unaffected by any filter, the
  // Off/Unassigned toggle, or pagination. These are CALCULATED PREVIEW
  // totals, not official attendance totals -- the subtitle below makes
  // this explicit per the "clearly label if filters/pagination limit
  // scope, and never conflate preview with official" requirement.
  const summaryCounts = useMemo(() => {
    const counts = { scheduled: 0, present: 0, late: 0, absent: 0, pending: 0 };
    for (const row of rows) {
      if (row.resolvedShift === 'day' || row.resolvedShift === 'night') counts.scheduled++;
      if (row.calculation.status === 'present') counts.present++;
      else if (row.calculation.status === 'late') counts.late++;
      else if (row.calculation.status === 'absent') counts.absent++;
      else if (row.calculation.status === 'pending') counts.pending++;
    }
    return counts;
  }, [rows]);

  const employeeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of candidateEmployees) map.set(e.id, `${e.fullName} (${e.employeeNumber})`);
    return map;
  }, [candidateEmployees]);

  /** Toggles resultFilter when a summary card for that result is clicked -- clicking the same one again clears it. Only Present/Late/Absent/Pending map onto a calculated-result value; Scheduled/Site alerts don't and are not clickable. */
  const toggleResultFilter = useCallback((status: AttendanceCalculationStatus) => {
    setResultFilter((current) => (current === status ? '' : status));
  }, []);

  const openDetails = useCallback((row: AttendanceCalculationPreviewRow) => {
    setDetailsRow(row);
    const key = rowKeyOf(row);
    const source = officialSourceByKey.get(key);
    if (source === 'manual' && !manualDetailByKey.has(key)) {
      setManualDetailByKey((prev) => new Map(prev).set(key, { status: 'loading' }));
      (async () => {
        try {
          const entries = await fetchAuditTimelineForEmployeeDate(row.employeeId, row.shiftDate);
          const reviewerIds = entries.map((e) => e.changedBy).filter((id): id is string => !!id);
          const reviewerNameById = await fetchProfileFullNamesById(reviewerIds);
          setManualDetailByKey((prev) => new Map(prev).set(key, { status: 'ready', entries, reviewerNameById }));
        } catch (err) {
          setManualDetailByKey((prev) => new Map(prev).set(key, { status: 'error', message: err instanceof Error ? err.message : 'Unknown error' }));
        }
      })();
    }
  }, [officialSourceByKey, manualDetailByKey]);

  if (!permissionsLoaded) {
    return <div className="p-8 text-center text-slate-400">Loading...</div>;
  }

  if (!canView) {
    return (
      <div className="space-y-6">
        <PageHeader title="Attendance Review" subtitle="Calculated Present/Late/Absent/Pending results, compared against the official attendance record -- read-only." />
        <Card className="p-6 bg-amber-50 border-amber-200 border">
          <p className="text-sm text-amber-800">You do not have permission to view Attendance Review.</p>
        </Card>
      </div>
    );
  }

  const detailsKey = detailsRow ? rowKeyOf(detailsRow) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Attendance Review"
        subtitle="Calculated Present/Late/Absent/Pending results from roster + fingerprint data -- read-only. Nothing here writes to official Attendance or Payroll."
        actions={<Button variant="outline" onClick={loadData}><RefreshCw size={14} /> Refresh</Button>}
      />

      <Card className="p-3 bg-blue-50 border-blue-200 border">
        <div className="flex items-start gap-2">
          <Eye size={16} className="text-blue-600 shrink-0 mt-0.5" />
          <p className="text-xs text-blue-800">
            Every result below is a <strong>calculation preview</strong>, using the same engine that will later power the
            official Attendance page. Nothing here is saved anywhere, and no official Attendance or Payroll record is ever
            changed by viewing, filtering, or expanding rows on this page.
          </p>
        </div>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard title="Scheduled shifts" value={summaryCounts.scheduled.toLocaleString()} icon={CalendarDays} accent="navy" />
        {(['present', 'late', 'absent', 'pending'] as const).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => toggleResultFilter(status)}
            className="text-left rounded-xl focus:outline-none focus:ring-2 focus:ring-[#081C3A]"
            aria-pressed={resultFilter === status}
            title={`Filter the register to Calculated result = ${RESULT_LABELS[status]}`}
          >
            <StatCard
              title={RESULT_LABELS[status]}
              value={summaryCounts[status].toLocaleString()}
              icon={status === 'present' ? CheckCircle2 : status === 'late' ? Clock : status === 'absent' ? XCircle : HelpCircle}
              accent={status === 'present' ? 'green' : status === 'late' ? 'gold' : status === 'absent' ? 'red' : 'blue'}
              sub={resultFilter === status ? 'Filter active -- click to clear' : undefined}
            />
          </button>
        ))}
        <StatCard title="Site alerts" value={siteAlerts.length.toLocaleString()} icon={AlertTriangle} accent={siteAlerts.length > 0 ? 'red' : 'navy'} />
      </div>
      <p className="text-xs text-slate-400 -mt-1">
        Totals cover every shift <strong>calculated</strong> for {fromDate} to {toDate} -- they are calculation-preview
        totals, not official attendance totals, and are not affected by any filter, the Off/Unassigned toggle, or
        pagination below. Click Present, Late, Absent, or Pending to filter the register to that calculated result.
      </p>

      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Input label="From (Blantyre date)" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <Input label="To (Blantyre date)" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          <Input label="Search employee" icon={Search} placeholder="Name or employee number..." value={employeeSearch} onChange={(e) => setEmployeeSearch(e.target.value)} />
          <Select
            label="Site / workstation"
            value={siteFilter}
            onChange={(e) => setSiteFilter(e.target.value)}
            options={[{ label: 'All sites', value: '' }, ...siteOptions.map((s) => ({ label: s, value: s }))]}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
          <Select
            label="Shift"
            value={shiftFilter}
            onChange={(e) => setShiftFilter(e.target.value as ResolvedSchedule | '')}
            options={[
              { label: 'All shifts', value: '' },
              { label: 'Day', value: 'day' },
              { label: 'Night', value: 'night' },
              { label: 'Off', value: 'off' },
              { label: 'Unassigned', value: 'unassigned' },
            ]}
          />
          <Select
            label="Calculated result"
            value={resultFilter}
            onChange={(e) => setResultFilter(e.target.value as AttendanceCalculationStatus | '')}
            options={[{ label: 'All results', value: '' }, ...Object.entries(RESULT_LABELS).map(([value, label]) => ({ label, value }))]}
          />
          <Select
            label="Official status"
            value={officialStatusFilter}
            onChange={(e) => setOfficialStatusFilter(e.target.value)}
            options={[{ label: 'All official statuses', value: '' }, ...Object.entries(OFFICIAL_STATUS_LABELS).map(([value, label]) => ({ label, value }))]}
          />
          <Select
            label="Official decision source"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
            options={[
              { label: 'Automatic or manual', value: '' },
              { label: 'Automatic only', value: 'automatic' },
              { label: 'Manual only', value: 'manual' },
            ]}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
          <Select
            label="Needs review"
            value={reviewFilter}
            onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)}
            options={[
              { label: 'All rows', value: '' },
              { label: 'Needs review (any reason)', value: 'any' },
              { label: 'Confirmed discrepancy only', value: 'contradiction' },
              { label: 'Unconfirmed evidence only', value: 'uncertain' },
            ]}
          />
          <Select
            label="Page size"
            value={String(pageSize)}
            onChange={(e) => setPageSize(Number(e.target.value))}
            options={PAGE_SIZE_OPTIONS.map((n) => ({ label: `${n} per page`, value: String(n) }))}
          />
          <label className="flex items-center gap-2 text-sm text-slate-600 self-end pb-2.5">
            <input type="checkbox" checked={showOffUnassigned} onChange={(e) => setShowOffUnassigned(e.target.checked)} />
            Show Off / Unassigned days
          </label>
        </div>
        <p className="text-xs text-slate-400 mt-2">
          "Needs review" compares this page's own calculation against the official record. A disagreement here is a
          read-only investigation signal, never proof the official record is wrong -- "Unconfirmed evidence" means the
          calculation can't yet confirm or dispute the official record (e.g. still Pending or only a provisional
          single-scan credit), which is different from a confirmed "Discrepancy".
        </p>
        {rangeInvalid && <p className="text-xs text-red-600 mt-2">The "From" date must not be after the "To" date.</p>}
        {!rangeInvalid && rangeTooWide && (
          <p className="text-xs text-red-600 mt-2">That range spans more than {MAX_RANGE_DAYS} days. Please narrow it.</p>
        )}
      </Card>

      {loadError && (
        <Card className="p-4 bg-red-50 border-red-200 border">
          <p className="text-sm text-red-700">{loadError}</p>
        </Card>
      )}

      {loading ? (
        <div className="p-8 text-center text-slate-400" role="status">Loading...</div>
      ) : candidateEmployees.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No roster assignments or fingerprint records found for this range"
          description={
            `Roster assignments found: ${rosterDateExtent ? `${rosterDateExtent.earliest} to ${rosterDateExtent.latest}` : 'none in this range'}. ` +
            `Fingerprint data found: ${fingerprintDateExtent ? `${fingerprintDateExtent.earliest} to ${fingerprintDateExtent.latest}` : 'none in this range'}. ` +
            `This preview is roster-first and does not need fingerprint records to calculate a result -- a scheduled Day/Night shift with no scans still shows as Pending. ` +
            `There is simply no roster assignment and no fingerprint record for any employee in this range yet. Pick a different range, or assign roster shifts for this period.`
          }
        />
      ) : (
        <>
          {!hasOverlap && (
            <Card className="p-3 bg-slate-50 border-slate-200 border">
              <p className="text-xs text-slate-600 flex items-center gap-2">
                <Info size={14} className="text-slate-400 shrink-0" />
                Roster assignments ({rosterDateExtent ? `${rosterDateExtent.earliest} to ${rosterDateExtent.latest}` : 'none'}) and fingerprint
                records ({fingerprintDateExtent ? `${fingerprintDateExtent.earliest} to ${fingerprintDateExtent.latest}` : 'none'}) do not
                currently overlap in this range -- the rows below are still calculated from roster data alone and will show Pending for any
                missing checkout/check-in evidence, never a false Absent.
              </p>
            </Card>
          )}
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-slate-700 flex items-center gap-2"><AlertTriangle size={16} className="text-amber-500" /> Site-level alerts</p>
              <p className="text-xs text-slate-400">5+ distinct employees with a confirmed fingerprint-related absence at the same workstation/shift/date</p>
            </div>
            {siteAlerts.length === 0 ? (
              <p className="text-sm text-slate-500">No site alerts for the current range.</p>
            ) : (
              <div className="space-y-2">
                {siteAlerts.map((alert, idx) => (
                  <div key={`${alert.workstation}|${alert.shift}|${alert.shiftDate}`} className="border border-amber-200 bg-amber-50 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-amber-900 flex items-center gap-1"><MapPin size={13} /> {alert.workstation} &middot; {alert.shift === 'day' ? 'Day' : 'Night'} shift &middot; {alert.shiftDate}</p>
                        <p className="text-sm text-amber-800 mt-1">{alert.message}</p>
                      </div>
                      <Badge color="orange">{alert.totalCount} affected</Badge>
                    </div>
                    <button
                      onClick={() => setExpandedAlertIndex(expandedAlertIndex === idx ? null : idx)}
                      className="text-xs text-amber-700 mt-2 flex items-center gap-1 hover:underline"
                    >
                      {expandedAlertIndex === idx ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      {expandedAlertIndex === idx ? 'Hide' : 'Show'} affected employees
                    </button>
                    {expandedAlertIndex === idx && (
                      <ul className="mt-2 text-xs text-amber-900 grid grid-cols-1 md:grid-cols-2 gap-1">
                        {alert.affectedEmployeeIds.map((id) => (
                          <li key={id}>{employeeNameById.get(id) ?? id}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {visibleRows.length === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="No rows match the current filters"
              description={
                showOffUnassigned || shiftFilter === 'off' || shiftFilter === 'unassigned'
                  ? 'Try widening the filters above.'
                  : 'Try widening the filters above, or turn on "Show Off / Unassigned days" -- Day/Night shifts are hidden if none match.'
              }
            />
          ) : (
            <Card className="p-0 overflow-hidden">
              <Table>
                <THead>
                  <TR hover={false}>
                    <TH>Employee</TH>
                    <TH>Date</TH>
                    <TH>Site</TH>
                    <TH>Shift</TH>
                    <TH>Calculated</TH>
                    <TH>Official status</TH>
                    <TH>Decision source</TH>
                    <TH>Details</TH>
                  </TR>
                </THead>
                <TBody>
                  {visibleRows.map((row) => {
                    const key = rowKeyOf(row);
                    const source = officialSourceByKey.get(key) ?? null;
                    const signal = classifyAttendanceReviewSignal(row);
                    const mappingProblem = !row.hasActiveMapping && (row.resolvedShift === 'day' || row.resolvedShift === 'night');
                    return (
                      <TR key={key}>
                        <TD className="font-medium text-slate-800">
                          <span className="flex items-center gap-1.5">
                            {row.employeeName}
                            {mappingProblem && (
                              <span title="No HikCentral person mapping confirmed yet for this employee">
                                <AlertTriangle size={13} className="text-amber-500" />
                              </span>
                            )}
                          </span>
                          <span className="block text-xs text-slate-400">{row.employeeNumber}</span>
                        </TD>
                        <TD>{row.shiftDate}</TD>
                        <TD>{row.workstation || '—'}</TD>
                        <TD className="capitalize">{row.resolvedShift}</TD>
                        <TD>
                          <span className="flex items-center gap-1.5">
                            <Badge color={RESULT_COLORS[row.calculation.status]}>{RESULT_LABELS[row.calculation.status]}</Badge>
                            {row.calculation.basis === 'check_in_only_provisional' && (
                              <span title="Credited from a single valid check-in alone, before the checkout window closed -- not yet a confirmed result.">
                                <Badge color="gold">Provisional</Badge>
                              </span>
                            )}
                          </span>
                        </TD>
                        <TD>
                          <span className="flex items-center gap-1.5">
                            {row.officialStatus ? (OFFICIAL_STATUS_LABELS[row.officialStatus] ?? row.officialStatus) : '—'}
                            {signal === 'contradiction' && (
                              <span title="Confirmed discrepancy -- the official record and this page's own calculation disagree. Read-only investigation signal only.">
                                <AlertTriangle size={13} className="text-red-500" />
                              </span>
                            )}
                            {signal === 'uncertain' && (
                              <span title="Evidence is still incomplete or only provisional -- this page cannot yet confirm or dispute the official record.">
                                <HelpCircle size={13} className="text-amber-500" />
                              </span>
                            )}
                          </span>
                        </TD>
                        <TD className="text-xs">{sourceLabel(source, !!row.officialStatus)}</TD>
                        <TD>
                          <Button variant="ghost" size="sm" onClick={() => openDetails(row)}>
                            <Eye size={14} /> Details
                          </Button>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
              <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-t border-slate-100">
                <p className="text-xs text-slate-400">
                  {filteredRows.length.toLocaleString()} matching row{filteredRows.length === 1 ? '' : 's'}
                  {totalPages > 1 ? ` -- page ${currentPage} of ${totalPages}` : ''}
                </p>
                {totalPages > 1 && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>Previous</Button>
                    <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>Next</Button>
                  </div>
                )}
              </div>
            </Card>
          )}
        </>
      )}

      <Card className="p-4">
        <button onClick={() => setCoverageSectionOpen((v) => !v)} className="w-full flex items-center justify-between gap-3 text-left">
          <span className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-slate-500" />
            <span className="text-sm font-semibold text-slate-700">Advanced: fingerprint coverage settings</span>
          </span>
          <span className="flex items-center gap-2">
            {coveragePolicy.isActive ? (
              <Badge color="green">Confirmed for {coveragePolicy.confirmedWorkstationKeys.size} workstation(s)</Badge>
            ) : (
              <Badge color="gray">Not confirmed -- missing evidence shows Pending</Badge>
            )}
            {coverageSectionOpen ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
          </span>
        </button>
        {coverageSectionOpen && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <p className="text-xs text-slate-500 mb-3">
              This page now also checks the real, persisted, evidence-checked coverage the server itself trusts -- a shift can
              show calculated <strong>Absent</strong> without typing anything below if that server evidence is genuinely
              sufficient. An export time typed here by itself is still <strong>not</strong> proof that fingerprint data is
              complete, though: a shift with a missing checkout stays <strong>Pending</strong> (never a false Absent) unless
              either that server evidence is sufficient, or an authorized operator explicitly confirms, below, that data is
              complete through a given time for specific, named workstations.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                label="Export time supplied by administrator (Blantyre local)"
                type="datetime-local"
                value={exportTimeBlantyreLocal}
                onChange={(e) => setExportTimeBlantyreLocal(e.target.value)}
              />
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Confirmed-coverage workstations (comma or newline separated)</label>
                <textarea
                  value={confirmedWorkstationsRaw}
                  onChange={(e) => setConfirmedWorkstationsRaw(e.target.value)}
                  placeholder="e.g. CHIRIMBA, HEAD OFFICE"
                  rows={2}
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] focus:border-transparent outline-none bg-white"
                />
              </div>
            </div>
            <label className="flex items-start gap-2 mt-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={operatorConfirmed}
                onChange={(e) => setOperatorConfirmed(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                I am an authorized operator and I confirm fingerprint data is complete through the time above, for exactly the
                workstation(s) named above. Unnamed workstations -- including the HikCentral access points, which are not assumed
                to cover every employee's assigned workstation -- remain Pending for missing evidence.
              </span>
            </label>
            {coveragePolicy.isActive ? (
              <p className="text-xs text-green-700 mt-2 flex items-center gap-1"><ShieldCheck size={12} /> Coverage confirmed for {coveragePolicy.confirmedWorkstationKeys.size} workstation(s) through {exportTimeBlantyreLocal || '—'} (Blantyre).</p>
            ) : (
              <p className="text-xs text-slate-500 mt-2 flex items-center gap-1"><Info size={12} /> No coverage confirmed yet -- every shift with missing evidence will show Pending.</p>
            )}
          </div>
        )}
      </Card>

      <AttendanceReviewDetailsModal
        row={detailsRow}
        open={detailsRow !== null}
        onClose={() => setDetailsRow(null)}
        officialSource={detailsKey ? (officialSourceByKey.get(detailsKey) ?? null) : null}
        reviewSignal={detailsRow ? classifyAttendanceReviewSignal(detailsRow) : 'none'}
        manualDetail={detailsKey ? (manualDetailByKey.get(detailsKey) ?? null) : null}
        serverCoverage={detailsKey ? (serverCoverageByKey.get(detailsKey) ?? null) : null}
      />
    </div>
  );
}
