// Safeguard HikCentral Attendance MVP -- Attendance Evidence Centre,
// read-only v1.
//
// Purpose (the user's own practical requirement): "When an employee
// disputes an absence or lateness, HR must be able to retrieve the
// date, fingerprint scans, roster, calculated result, original recorded
// decision, reason and responsible reviewer." This page answers exactly
// that, for one employee-day at a time, drilled into from a searchable
// list.
//
// STRICTLY READ-ONLY: there is no save/apply/confirm/correct action
// anywhere on this page, and no RPC call that writes anything. The list
// reuses the EXISTING Attendance Calculation Preview data/row-building
// (fetchAttendanceCalculationPreviewData, buildAttendanceCalculationPreviewRows)
// unmodified -- this page adds a new "evidence completeness" filter and a
// per-row detail drill-down, never a second calculation engine. The
// detail drill-down reuses the EXISTING server-authoritative recalculation
// RPC (fetchServerCalculationPreview, attendance_preview_calculate) for
// the "calculated result" shown -- never a client-only approximation.
//
// PRESERVED RULE (unchanged, enforced entirely by attendanceCalculationEngine.ts,
// which this page never modifies): an incomplete check-in/checkout pair
// becomes Absent only once data coverage is confirmed complete AND the
// checkout window has closed; otherwise it stays Pending. This page only
// EXPLAINS that result -- it never recomputes it differently.
import { Fragment, useState, useEffect, useMemo, useCallback } from 'react';
import {
  Eye, Search, RefreshCw, CalendarDays, ClipboardCheck, MapPin,
  ChevronDown, ChevronUp, FileText, History,
} from '../utils/icons';
import { Card, Button, Badge, PageHeader, EmptyState, Input, Select } from '../components/ui';
import { hasPermission, PERMISSIONS } from '../utils/permissions';
import { expandDateRange, ResolvedSchedule, addDays } from '../utils/rosterSchedule';
import { AttendanceCalculationStatus, getShiftWindows } from '../utils/attendanceCalculationEngine';
import {
  resolveCoveragePolicy, collectEmployeeIdsWithRosterEvidence, buildAttendanceCalculationPreviewRows,
  filterAttendancePreviewRows, AttendanceCalculationPreviewRow,
} from '../utils/attendanceCalculationPreview';
import { fetchAttendanceCalculationPreviewData, fetchOfficialAttendanceSourceByKey } from '../utils/attendanceCalculationPreviewService';
import {
  fetchAttendanceEvidenceDetail, AttendanceEvidenceDetail,
} from '../utils/attendanceEvidenceService';
import { classifyRawEventsForEvidence, deriveEvidenceCompleteness, EvidenceCompleteness, EVIDENCE_COMPLETENESS_LABELS } from '../utils/attendanceEvidence';
import { blantyreDateRangeToUtcBounds } from '../utils/hikcentralAttendancePreview';

const MAX_RANGE_DAYS = 31;
const PAGE_SIZE = 25;

/** Maps an official P/A/L code onto the same status space row.calculation.status already uses, for the "Discrepancies only" filter -- LV/SL/'-' have no calculated-status analog and are never treated as a discrepancy. */
const OFFICIAL_TO_CALC_STATUS: Partial<Record<string, AttendanceCalculationStatus>> = { P: 'present', A: 'absent', L: 'late' };

type SourceFilter = 'automatic' | 'manual' | '';

const RESULT_LABELS: Record<AttendanceCalculationStatus, string> = {
  present: 'Present', late: 'Late', absent: 'Absent', pending: 'Pending', off: 'Off', unassigned: 'Unassigned',
};
const OFFICIAL_STATUS_LABELS: Record<string, string> = {
  P: 'Present', A: 'Absent', L: 'Late', LV: 'Leave', SL: 'Sick Leave', '-': 'Not marked',
};

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
  const d = new Date(new Date(iso).getTime() + 2 * 60 * 60_000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function rowKeyOf(row: AttendanceCalculationPreviewRow): string {
  return `${row.employeeId}|${row.shiftDate}`;
}

type DetailState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; detail: AttendanceEvidenceDetail };

function EvidenceDetailPanel({ row, state }: { row: AttendanceCalculationPreviewRow; state: DetailState }) {
  if (state.status === 'loading') {
    return <div className="p-4 text-sm text-slate-400">Loading evidence...</div>;
  }
  if (state.status === 'error') {
    return <div className="p-4 text-sm text-red-700">Could not load evidence: {state.message}</div>;
  }
  const { detail } = state;
  const windows = row.resolvedShift === 'day' || row.resolvedShift === 'night'
    ? getShiftWindows(row.resolvedShift, row.shiftDate)
    : null;
  const classified = windows
    ? classifyRawEventsForEvidence(detail.rawEvents, windows, row.calculation.checkInIso, row.calculation.checkOutIso)
    : [];
  const server = detail.serverCalculation;

  return (
    <div className="p-4 space-y-4 bg-slate-50">
      {/* A. Identity + schedule */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div><span className="text-slate-400">Employee</span><div className="font-medium">{row.employeeName} ({row.employeeNumber})</div></div>
        <div><span className="text-slate-400">Date</span><div className="font-medium">{row.shiftDate}</div></div>
        <div><span className="text-slate-400">Site</span><div className="font-medium">{row.workstation || '—'}</div></div>
        <div><span className="text-slate-400">Resolved shift</span><div className="font-medium capitalize">{row.resolvedShift}</div></div>
        {windows && (
          <>
            <div><span className="text-slate-400">Valid check-in window</span><div className="font-medium">{formatLocalTime(windows.checkInWindowStartIso)} – {formatLocalTime(windows.checkInWindowEndIso)}</div></div>
            <div><span className="text-slate-400">Valid checkout window</span><div className="font-medium">{formatLocalTime(windows.checkOutWindowStartIso)} – {formatLocalTime(windows.checkOutWindowEndIso)}</div></div>
          </>
        )}
      </div>

      {/* B. Fingerprint evidence */}
      <div>
        <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1"><ClipboardCheck size={14} /> Fingerprint evidence</h4>
        {classified.length === 0 ? (
          <p className="text-xs text-slate-400">No fingerprint scans found in the relevant window for this employee.</p>
        ) : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-slate-400">
              <th className="py-1">Time (Blantyre)</th><th>Access point</th><th>Outcome</th>
            </tr></thead>
            <tbody>
              {classified.map((e, i) => (
                <tr key={i} className="border-t border-slate-200">
                  <td className="py-1">{formatLocalTime(e.timestampIso)}</td>
                  <td>{e.accessPoint || '—'}</td>
                  <td>
                    {e.role === 'matched_check_in' && <Badge color="green">Matched check-in</Badge>}
                    {e.role === 'matched_check_out' && <Badge color="green">Matched checkout</Badge>}
                    {e.role === 'excluded' && <span className="text-slate-500">Excluded — {e.excludedReason}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {detail.coverageConfirmations.length > 0 && (
          <div className="mt-2 text-xs text-slate-500 space-y-1">
            {detail.coverageConfirmations.map((c, i) => (
              <p key={i}>
                Coverage confirmed {formatLocalTime(c.confirmedAt)} by {c.confirmedBy}, declared through {formatLocalTime(c.coversThroughIso)}
                {c.workstations.length > 0 ? ` for ${c.workstations.join(', ')}` : ''}
                {c.revokedAt ? ` — REVOKED ${formatLocalTime(c.revokedAt)}${c.revokedReason ? `: ${c.revokedReason}` : ''}` : ''}.
                {c.exceedsObservedEvidence && (
                  <span className="text-amber-700 font-medium">
                    {' '}⚠ Declared coverage exceeded the latest observed fingerprint evidence
                    {c.latestObservedEventAtIso ? ` (last observed scan: ${formatLocalTime(c.latestObservedEventAtIso)})` : ' (no scan observed at all in this window)'}
                    {c.overrideReason ? ` — override reason: "${c.overrideReason}"` : ' — no override reason recorded'}
                    {c.independentlyVerified ? ' — administrator attested independent verification against HikCentral/the site.' : ' — NOT independently verified (should not be possible; flag for review).'}
                  </span>
                )}
              </p>
            ))}
          </div>
        )}
        {detail.importBatches.length > 0 && (
          <div className="mt-1 text-xs text-slate-400">
            Import batch{detail.importBatches.length > 1 ? 'es' : ''}: {detail.importBatches.map((b) => b.filename || b.id).join(', ')}
          </div>
        )}
      </div>

      {/* C. Calculation explanation */}
      <div>
        <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1"><FileText size={14} /> Calculation explanation</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
          <div><span className="text-slate-400">Official recorded status</span><div className="font-medium">{row.officialStatus ? OFFICIAL_STATUS_LABELS[row.officialStatus] || row.officialStatus : 'Not recorded'}</div></div>
          <div><span className="text-slate-400">Server recalculation (live)</span><div className="font-medium">{server ? RESULT_LABELS[server.status] : 'Unavailable'}</div></div>
          <div><span className="text-slate-400">Client preview (same engine)</span><div className="font-medium">{RESULT_LABELS[row.calculation.status]}</div></div>
        </div>
        <p className="text-xs text-slate-500 mt-2">{row.calculation.reason}</p>
        {server && row.officialStatus && OFFICIAL_STATUS_LABELS[row.officialStatus] && RESULT_LABELS[server.status] !== OFFICIAL_STATUS_LABELS[row.officialStatus] && (
          <p className="text-xs text-amber-700 mt-1 font-medium">⚠ The server's live recalculation disagrees with the official recorded status — this employee-day may need review.</p>
        )}
      </div>

      {/* D. Audit timeline */}
      <div>
        <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1"><History size={14} /> Decision & audit timeline</h4>
        {detail.auditTimeline.length === 0 ? (
          <p className="text-xs text-slate-400">No recorded status changes for this employee-day.</p>
        ) : (
          <ul className="text-xs space-y-1">
            {detail.auditTimeline.map((a, i) => (
              <li key={i} className="border-t border-slate-200 pt-1">
                {formatLocalTime(a.changedAtIso)} — {a.oldStatus ?? '(none)'} → {a.newStatus} ({a.changeSource || 'unknown'})
                {a.reason ? <> — "{a.reason}"</> : <span className="text-amber-600"> — no reason recorded</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function AttendanceEvidenceCentrePage() {
  const [canView, setCanView] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);

  const defaults = useMemo(defaultDateRange, []);
  const [fromDate, setFromDate] = useState(defaults.from);
  const [toDate, setToDate] = useState(defaults.to);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [shiftFilter, setShiftFilter] = useState<ResolvedSchedule | ''>('');
  const [resultFilter, setResultFilter] = useState<AttendanceCalculationStatus | ''>('');
  const [evidenceFilter, setEvidenceFilter] = useState<EvidenceCompleteness | ''>('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('');
  const [discrepancyOnly, setDiscrepancyOnly] = useState(false);
  const [page, setPage] = useState(1);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchAttendanceCalculationPreviewData>> | null>(null);
  const [officialSourceByKey, setOfficialSourceByKey] = useState<Map<string, string | null>>(new Map());

  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [detailByRowKey, setDetailByRowKey] = useState<Map<string, DetailState>>(new Map());

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
      const sourceByKey = await fetchOfficialAttendanceSourceByKey(result.employees.map((e) => e.id), fromDate, toDate);
      setData(result);
      setOfficialSourceByKey(sourceByKey);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load Attendance Evidence Centre data.');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, rangeInvalid, rangeTooWide]);

  useEffect(() => {
    if (permissionsLoaded && canView) loadData();
  }, [permissionsLoaded, canView, loadData]);

  const coveragePolicy = useMemo(
    () => resolveCoveragePolicy({ exportTimeBlantyreLocal: '', confirmedWorkstationsRaw: '', operatorConfirmed: false }),
    []
  );

  const rosterIds = useMemo(
    () => (data ? collectEmployeeIdsWithRosterEvidence(data.datedAssignments, data.patterns, data.shiftPatterns) : new Set<string>()),
    [data]
  );
  const fingerprintIds = useMemo(() => {
    if (!data) return new Set<string>();
    const ids = new Set<string>();
    for (const [employeeId, events] of data.eventsByEmployeeId) if (events.length > 0) ids.add(employeeId);
    return ids;
  }, [data]);

  const candidateEmployees = useMemo(() => {
    if (!data) return [];
    const candidateIds = new Set([...rosterIds, ...fingerprintIds]);
    return data.employees.filter((e) => candidateIds.has(e.id));
  }, [data, rosterIds, fingerprintIds]);

  const shiftDates = useMemo(() => (rangeInvalid || rangeTooWide ? [] : expandDateRange(fromDate, toDate)), [fromDate, toDate, rangeInvalid, rangeTooWide]);

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
    });
  }, [data, candidateEmployees, shiftDates, coveragePolicy]);

  const filteredRows = useMemo(() => {
    let base = filterAttendancePreviewRows(rows, { siteFilter, shiftFilter, resultFilter, employeeSearch })
      .filter((r) => r.resolvedShift === 'day' || r.resolvedShift === 'night');
    if (evidenceFilter) {
      base = base.filter((r) => deriveEvidenceCompleteness(r.calculation.checkInIso, r.calculation.checkOutIso) === evidenceFilter);
    }
    if (sourceFilter) {
      base = base.filter((r) => officialSourceByKey.get(`${r.employeeId}|${r.shiftDate}`) === sourceFilter);
    }
    if (discrepancyOnly) {
      base = base.filter((r) => {
        const expected = r.officialStatus ? OFFICIAL_TO_CALC_STATUS[r.officialStatus] : undefined;
        return expected !== undefined && expected !== r.calculation.status;
      });
    }
    return base;
  }, [rows, siteFilter, shiftFilter, resultFilter, employeeSearch, evidenceFilter, sourceFilter, discrepancyOnly, officialSourceByKey]);

  // Client-side pagination over the already-fetched, already-filtered
  // rows -- a real server-side paginated fetch isn't justified here:
  // the underlying data fetch is already bounded (MAX_RANGE_DAYS calendar
  // days, RLS-scoped employees only), and this page's own row-building
  // needs the full roster/fingerprint data for the range regardless of
  // which page is being viewed.
  //
  // Final Phase 2 release review: this used to also slice to a fixed
  // 500-row cap before paginating, with a "narrow the filters to see
  // more" message for anything past it -- a leftover from before
  // pagination existed. That meant Previous/Next could never reach a
  // row past position 500 at all, no matter how a user paged, silently
  // defeating pagination's own purpose for any result set bigger than
  // 500 rows. Removed: pagination alone is now what makes an
  // arbitrarily large, fully-filtered result set reachable.
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [siteFilter, shiftFilter, resultFilter, employeeSearch, evidenceFilter, sourceFilter, discrepancyOnly, fromDate, toDate]);

  const siteOptions = useMemo(() => Array.from(new Set(rows.map((r) => r.workstation))).sort(), [rows]);

  const toggleRow = useCallback((row: AttendanceCalculationPreviewRow) => {
    const key = rowKeyOf(row);
    if (expandedRowKey === key) {
      setExpandedRowKey(null);
      return;
    }
    setExpandedRowKey(key);
    if (!detailByRowKey.has(key)) {
      setDetailByRowKey((prev) => new Map(prev).set(key, { status: 'loading' }));
      (async () => {
        try {
          const windows = row.resolvedShift === 'day' || row.resolvedShift === 'night' ? getShiftWindows(row.resolvedShift, row.shiftDate) : null;
          // Widen the fetch window a few hours past each shift-window boundary so
          // genuinely EXCLUDED (too-early/too-late) scans are still visible to the
          // reviewer, not just the ones the engine matched.
          const fromUtcIso = windows
            ? new Date(new Date(windows.checkInWindowStartIso).getTime() - 4 * 60 * 60_000).toISOString()
            : blantyreDateRangeToUtcBounds(row.shiftDate, row.shiftDate).fromUtcIso;
          const toUtcIsoExclusive = windows
            ? new Date(new Date(windows.checkOutWindowEndIso).getTime() + 4 * 60 * 60_000).toISOString()
            : blantyreDateRangeToUtcBounds(row.shiftDate, addDays(row.shiftDate, 1)).toUtcIsoExclusive;
          const detail = await fetchAttendanceEvidenceDetail(row.employeeId, row.shiftDate, fromUtcIso, toUtcIsoExclusive);
          setDetailByRowKey((prev) => new Map(prev).set(key, { status: 'ready', detail }));
        } catch (err) {
          setDetailByRowKey((prev) => new Map(prev).set(key, { status: 'error', message: err instanceof Error ? err.message : 'Unknown error' }));
        }
      })();
    }
  }, [expandedRowKey, detailByRowKey]);

  if (!permissionsLoaded) {
    return <div className="p-8 text-center text-slate-400">Loading...</div>;
  }
  if (!canView) {
    return (
      <div className="space-y-6">
        <PageHeader title="Attendance Evidence Centre" subtitle="Search and review individual attendance decisions with full supporting evidence." />
        <Card className="p-6 bg-amber-50 border-amber-200 border">
          <p className="text-sm text-amber-800">You do not have permission to view the Attendance Evidence Centre.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Attendance Evidence Centre"
        subtitle="Search any employee-day and see the exact evidence behind its attendance result -- read-only. Nothing here writes to official Attendance, Payroll, or the audit log."
        actions={<Button variant="outline" onClick={loadData}><RefreshCw size={14} /> Refresh</Button>}
      />

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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
          <Select
            label="Shift"
            value={shiftFilter}
            onChange={(e) => setShiftFilter(e.target.value as ResolvedSchedule | '')}
            options={[
              { label: 'All shifts', value: '' },
              { label: 'Day', value: 'day' },
              { label: 'Night', value: 'night' },
            ]}
          />
          <Select
            label="Calculated result"
            value={resultFilter}
            onChange={(e) => setResultFilter(e.target.value as AttendanceCalculationStatus | '')}
            options={[
              { label: 'All results', value: '' },
              { label: 'Present', value: 'present' },
              { label: 'Late', value: 'late' },
              { label: 'Absent', value: 'absent' },
              { label: 'Pending', value: 'pending' },
            ]}
          />
          <Select
            label="Evidence completeness"
            value={evidenceFilter}
            onChange={(e) => setEvidenceFilter(e.target.value as EvidenceCompleteness | '')}
            options={[
              { label: 'All evidence', value: '' },
              ...(Object.keys(EVIDENCE_COMPLETENESS_LABELS) as EvidenceCompleteness[]).map((k) => ({ label: EVIDENCE_COMPLETENESS_LABELS[k], value: k })),
            ]}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
          <Select
            label="Decision source"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
            options={[
              { label: 'Automatic or manual', value: '' },
              { label: 'Automatic only', value: 'automatic' },
              { label: 'Manual only', value: 'manual' },
            ]}
          />
          <label className="flex items-center gap-2 text-sm text-slate-700 self-end pb-2.5 cursor-pointer">
            <input type="checkbox" checked={discrepancyOnly} onChange={(e) => setDiscrepancyOnly(e.target.checked)} />
            Discrepancies only (official status doesn&apos;t match this page&apos;s own calculation)
          </label>
        </div>
        {rangeInvalid && <p className="text-xs text-red-600 mt-2">The "From" date must not be after the "To" date.</p>}
        {!rangeInvalid && rangeTooWide && <p className="text-xs text-red-600 mt-2">Date range cannot exceed {MAX_RANGE_DAYS} days.</p>}
      </Card>

      {loadError && (
        <Card className="p-4 bg-red-50 border-red-200 border">
          <p className="text-sm text-red-700">{loadError}</p>
        </Card>
      )}

      {loading ? (
        <div className="p-8 text-center text-slate-400">Loading...</div>
      ) : candidateEmployees.length === 0 ? (
        <EmptyState icon={CalendarDays} title="No roster assignments or fingerprint records found for this range" description="Pick a different date range, or assign roster shifts for this period." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="p-3">Employee</th><th>Date</th><th>Site</th><th>Shift</th>
                <th>Official</th><th>Source</th><th>Calculated</th><th>Evidence</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const key = rowKeyOf(row);
                const expanded = expandedRowKey === key;
                const completeness = deriveEvidenceCompleteness(row.calculation.checkInIso, row.calculation.checkOutIso);
                return (
                  <Fragment key={key}>
                    <tr className="border-t border-slate-100 cursor-pointer hover:bg-slate-50" onClick={() => toggleRow(row)}>
                      <td className="p-3">{row.employeeName} ({row.employeeNumber})</td>
                      <td>{row.shiftDate}</td>
                      <td className="flex items-center gap-1"><MapPin size={12} className="text-slate-300" />{row.workstation || '—'}</td>
                      <td className="capitalize">{row.resolvedShift}</td>
                      <td>{row.officialStatus ? OFFICIAL_STATUS_LABELS[row.officialStatus] || row.officialStatus : '—'}</td>
                      <td className="text-xs capitalize">{officialSourceByKey.get(`${row.employeeId}|${row.shiftDate}`) || '—'}</td>
                      <td>
                        {row.calculation.status === 'present' && <Badge color="green">Present</Badge>}
                        {row.calculation.status === 'late' && <Badge color="gold">Late</Badge>}
                        {row.calculation.status === 'absent' && <Badge color="red">Absent</Badge>}
                        {row.calculation.status === 'pending' && <Badge color="blue">Pending</Badge>}
                      </td>
                      <td className="text-xs text-slate-500">{EVIDENCE_COMPLETENESS_LABELS[completeness]}</td>
                      <td className="p-3 text-right">
                        <Button variant="ghost" size="sm">
                          <Eye size={14} /> {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </Button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={9} className="p-0">
                          <EvidenceDetailPanel row={row} state={detailByRowKey.get(key) ?? { status: 'loading' }} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <div className="flex items-center justify-between p-3 border-t border-slate-100">
            <p className="text-xs text-slate-400">
              {filteredRows.length} matching row{filteredRows.length === 1 ? '' : 's'}
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
    </div>
  );
}
