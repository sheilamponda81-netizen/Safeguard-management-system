// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage B: read-only
// Attendance Calculation Preview.
//
// Shows what the Stage A pure engine (attendanceCalculationEngine.ts)
// WOULD calculate for each employee/shift-date, using real roster
// resolution and real fingerprint data -- but writes nothing. There is
// no save/apply/confirm action anywhere on this page. The existing
// official `attendance.status` is shown purely for read-only comparison.
//
// COVERAGE: an administrator-entered export time is never, by itself,
// treated as proof that fingerprint data is complete -- see
// attendanceCalculationPreview.ts's resolveCoveragePolicy. Only an
// explicit operator confirmation, naming specific workstations, turns
// it into real coverage for those workstations. Every other employee's
// shift stays Pending rather than silently becoming a false Absent.
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Eye, Search, AlertTriangle, RefreshCw, Clock, MapPin, CalendarDays, ClipboardCheck,
  ShieldCheck, ChevronDown, ChevronUp, Info, CheckCircle2, XCircle, HelpCircle,
} from '../utils/icons';
import { Card, Button, Badge, PageHeader, EmptyState, Input, Select, StatCard } from '../components/ui';
import { hasPermission, PERMISSIONS } from '../utils/permissions';
import { expandDateRange, ResolvedSchedule } from '../utils/rosterSchedule';
import { AttendanceCalculationStatus } from '../utils/attendanceCalculationEngine';
import {
  resolveCoveragePolicy, collectEmployeeIdsWithRosterEvidence, collectEmployeeIdsWithFingerprintEvidence,
  hasAnyEmployeeWithBothRosterAndFingerprintEvidence, describeDateExtent, buildAttendanceCalculationPreviewRows,
  filterAttendancePreviewRows, buildSiteAlertCasesFromRows, AttendanceCalculationPreviewRow,
} from '../utils/attendanceCalculationPreview';
import { aggregateSiteAlerts, SiteAlert } from '../utils/attendanceSiteAlerts';
import { fetchAttendanceCalculationPreviewData } from '../utils/attendanceCalculationPreviewService';

// This page joins employees x roster x fingerprint x official-attendance
// per date, which is heavier per day than the simpler scan-grouping
// preview -- a tighter range cap than that page's 92 days.
const MAX_RANGE_DAYS = 31;
const MAX_RENDERED_ROWS = 500;

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
  // Default view: scheduled Day/Night shifts only -- Off/Unassigned days
  // are real, correct results (never a bug), but repeating them for
  // every employee on every date would flood the list. This toggle is
  // purely a display preference; it never changes what was calculated
  // or how many rows exist underneath.
  const [showOffUnassigned, setShowOffUnassigned] = useState(false);
  const [coverageSectionOpen, setCoverageSectionOpen] = useState(false);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);

  // Coverage workflow inputs -- see attendanceCalculationPreview.ts's
  // resolveCoveragePolicy for why typing an export time alone never
  // confirms coverage.
  const [exportTimeBlantyreLocal, setExportTimeBlantyreLocal] = useState('');
  const [confirmedWorkstationsRaw, setConfirmedWorkstationsRaw] = useState('');
  const [operatorConfirmed, setOperatorConfirmed] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchAttendanceCalculationPreviewData>> | null>(null);
  const [expandedAlertIndex, setExpandedAlertIndex] = useState<number | null>(null);

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
      setData(await fetchAttendanceCalculationPreviewData(fromDate, toDate));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the Attendance Calculation Preview.');
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
    });
  }, [data, candidateEmployees, shiftDates, coveragePolicy]);

  const siteOptions = useMemo(() => Array.from(new Set(rows.map((r) => r.workstation))).sort(), [rows]);

  // Default view hides Off/Unassigned rows (never a bug, just noise at
  // scale) UNLESS the user explicitly asked for them, either via the
  // "Show Off/Unassigned" toggle or by picking "Off"/"Unassigned"
  // directly in the Shift filter -- an explicit choice always wins.
  const filteredRows = useMemo(() => {
    const explicitlyFiltered = filterAttendancePreviewRows(rows, { siteFilter, shiftFilter, resultFilter, employeeSearch });
    if (showOffUnassigned || shiftFilter === 'off' || shiftFilter === 'unassigned') return explicitlyFiltered;
    return explicitlyFiltered.filter((r) => r.resolvedShift === 'day' || r.resolvedShift === 'night');
  }, [rows, siteFilter, shiftFilter, resultFilter, employeeSearch, showOffUnassigned]);

  const visibleRows = filteredRows.slice(0, MAX_RENDERED_ROWS);
  const truncated = filteredRows.length > MAX_RENDERED_ROWS;

  const siteAlerts: SiteAlert[] = useMemo(() => {
    if (rows.length === 0) return [];
    const { cases, workstationLabelByKey } = buildSiteAlertCasesFromRows(rows);
    return aggregateSiteAlerts(cases).map((alert) => ({ ...alert, workstation: workstationLabelByKey.get(alert.workstation) ?? alert.workstation }));
  }, [rows]);

  // Summary counts are deliberately computed from `rows` -- every row
  // calculated for the selected date range -- NOT from `filteredRows`/
  // `visibleRows`. They are therefore unaffected by the site/shift/
  // result filters or the Off/Unassigned toggle below, and by the
  // MAX_RENDERED_ROWS display cap; the label under the stat cards makes
  // this explicit per the "clearly label if filters/pagination limit
  // scope" requirement.
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

  if (!permissionsLoaded) {
    return <div className="p-8 text-center text-slate-400">Loading...</div>;
  }

  if (!canView) {
    return (
      <div className="space-y-6">
        <PageHeader title="Attendance Review" subtitle="Read-only preview of calculated attendance results." />
        <Card className="p-6 bg-amber-50 border-amber-200 border">
          <p className="text-sm text-amber-800">You do not have permission to view Attendance Review.</p>
        </Card>
      </div>
    );
  }

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
        <StatCard title="Present" value={summaryCounts.present.toLocaleString()} icon={CheckCircle2} accent="green" />
        <StatCard title="Late" value={summaryCounts.late.toLocaleString()} icon={Clock} accent="gold" />
        <StatCard title="Absent" value={summaryCounts.absent.toLocaleString()} icon={XCircle} accent="red" />
        <StatCard title="Pending" value={summaryCounts.pending.toLocaleString()} icon={HelpCircle} accent="blue" />
        <StatCard title="Site alerts" value={siteAlerts.length.toLocaleString()} icon={AlertTriangle} accent={siteAlerts.length > 0 ? 'red' : 'navy'} />
      </div>
      <p className="text-xs text-slate-400 -mt-1">
        Totals cover every shift calculated for {fromDate} to {toDate} -- they are not affected by the site/shift/result filters, the Off/Unassigned toggle, or the row display limit below.
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
        </div>
        {rangeInvalid && <p className="text-xs text-red-600 mt-2">The "From" date must not be after the "To" date.</p>}
        {!rangeInvalid && rangeTooWide && (
          <p className="text-xs text-red-600 mt-2">That range spans more than {MAX_RANGE_DAYS} days. Please narrow it.</p>
        )}
        <label className="flex items-center gap-2 mt-3 text-sm text-slate-600 border-t border-slate-100 pt-3">
          <input type="checkbox" checked={showOffUnassigned} onChange={(e) => setShowOffUnassigned(e.target.checked)} />
          Show Off / Unassigned days (hidden by default)
        </label>
      </Card>

      <Card className="p-4">
        <button onClick={() => setCoverageSectionOpen((v) => !v)} className="w-full flex items-center justify-between gap-3 text-left">
          <span className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-slate-500" />
            <span className="text-sm font-semibold text-slate-700">Fingerprint coverage settings</span>
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
              An export time by itself is <strong>not</strong> proof that fingerprint data is complete. A shift with a missing
              checkout stays <strong>Pending</strong> (never a false Absent) unless an authorized operator explicitly confirms,
              below, that data is complete through a given time for specific, named workstations.
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

      {loadError && (
        <Card className="p-4 bg-red-50 border-red-200 border">
          <p className="text-sm text-red-700">{loadError}</p>
        </Card>
      )}

      {loading ? (
        <div className="p-8 text-center text-slate-400">Loading...</div>
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
                  ? 'Try widening the site, shift, or result filters.'
                  : 'Try widening the site/shift/result filters, or turn on "Show Off / Unassigned days" above -- Day/Night shifts are hidden if none match.'
              }
            />
          ) : (
            <>
              {truncated && (
                <Card className="p-3 bg-amber-50 border-amber-200 border">
                  <p className="text-xs text-amber-800">
                    Showing the first {MAX_RENDERED_ROWS.toLocaleString()} of {filteredRows.length.toLocaleString()} matching rows. Narrow the date range or filters to see the rest.
                  </p>
                </Card>
              )}
              <div className="space-y-1.5">
                {visibleRows.map((row) => {
                  const rowKey = `${row.employeeId}|${row.shiftDate}`;
                  const expanded = expandedRowKey === rowKey;
                  const mappingProblem = !row.hasActiveMapping && (row.resolvedShift === 'day' || row.resolvedShift === 'night');
                  return (
                    <div key={rowKey} className="border border-slate-200 rounded-lg bg-white">
                      <button
                        onClick={() => setExpandedRowKey(expanded ? null : rowKey)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50 rounded-lg"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-slate-800 text-sm truncate">{row.employeeName}</p>
                          <p className="text-xs text-slate-400 truncate">
                            {row.employeeNumber} &middot; {row.workstation || '—'} &middot; {row.shiftDate} &middot; <span className="capitalize">{row.resolvedShift}</span>
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {mappingProblem && (
                            <span title="No HikCentral person mapping confirmed yet">
                              <AlertTriangle size={14} className="text-amber-500" />
                            </span>
                          )}
                          {row.calculation.basis === 'check_in_only_provisional' && <Badge color="gold">Provisional</Badge>}
                          <Badge color={RESULT_COLORS[row.calculation.status]}>{RESULT_LABELS[row.calculation.status]}</Badge>
                          {expanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                        </div>
                      </button>
                      {expanded && (
                        <div className="px-3 pb-3 pt-1 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                          <div>
                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Expected shift times</p>
                            <p className="text-slate-700">{row.expectedShiftTimes ? `${row.expectedShiftTimes.scheduledStart}–${row.expectedShiftTimes.scheduledEnd}` : '—'}</p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Fingerprint evidence</p>
                            <p className="text-slate-700 flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="inline-flex items-center gap-1"><Clock size={11} className="text-slate-400" /> Check-in: {formatLocalTime(row.calculation.checkInIso)}</span>
                              <span className="inline-flex items-center gap-1"><Clock size={11} className="text-slate-400" /> Checkout: {formatLocalTime(row.calculation.checkOutIso)}</span>
                            </p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Calculation basis</p>
                            <p className="text-slate-700">
                              {row.calculation.basis === 'confirmed' && 'Confirmed -- both check-in and checkout observed, or coverage genuinely confirmed.'}
                              {row.calculation.basis === 'check_in_only_provisional' && 'Provisional -- credited from an on-time/late check-in alone, before the checkout window closed.'}
                              {row.calculation.basis === 'not_applicable' && 'Not applicable to this result.'}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Official attendance status (read-only)</p>
                            <p className="text-slate-700">{row.officialStatus ? (OFFICIAL_STATUS_LABELS[row.officialStatus] ?? row.officialStatus) : 'Not marked'}</p>
                          </div>
                          <div className="sm:col-span-2">
                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Full explanation</p>
                            <p className="text-slate-600">{row.calculation.reason}</p>
                            {mappingProblem && (
                              <p className="text-amber-700 mt-1 flex items-start gap-1">
                                <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                                No HikCentral person mapping confirmed yet for this employee -- zero events here does not mean they were absent.
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
