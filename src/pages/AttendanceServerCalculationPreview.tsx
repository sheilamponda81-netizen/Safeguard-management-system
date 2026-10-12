// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage C, Step 3.
//
// Read-only comparison of the SERVER-side calculation engine
// (attendance_resolve_and_calculate, via attendance_preview_calculate)
// against the existing client-side Stage A/B JavaScript preview, for a
// single employee over a bounded date range. Writes nothing -- there is
// no save/apply/confirm action that actually executes anywhere on this
// page. The "Apply to Monthly Register" control below is a deliberately
// disabled placeholder: the workflow it will eventually drive
// (attendance_apply_automatic, already permission-gated and already
// protective of manual edits/payroll/Pending/Off/Unassigned/unverified
// Absent -- see that RPC's own definition) is NOT enabled by this
// change. It stays disabled until BOTH (a) the tenant-scoping and
// coverage-window corrective migration (20261013000000) is reviewed and
// applied, and (b) a controlled STAGING test of that fix is approved.
//
// PREREQUISITE NOTE: as of this page's introduction, a read-only check
// against STAGING found ZERO overlap between employees with an active
// HikCentral Person Mapping and employees with ANY roster Day/Night
// evidence -- every real (employee, date) pair currently resolves to
// 'unassigned' before the engine ever reaches event/coverage logic. The
// readiness panel below runs that same check live and reports it
// plainly; this page never fabricates a working example to compensate.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Server, AlertTriangle, RefreshCw, Lock, Search, Info } from '../utils/icons';
import { Card, Button, Badge, Select } from '../components/ui';
import { hasPermission, PERMISSIONS } from '../utils/permissions';
import { expandDateRange } from '../utils/rosterSchedule';
import { AttendanceCalculationStatus, AttendanceCalculationBasis } from '../utils/attendanceCalculationEngine';
import { fetchServerCalculationPreview, checkAutomaticAttendanceReadiness, AutomaticAttendanceReadiness } from '../utils/attendanceServerPreviewService';
import { fetchAttendanceCalculationPreviewData } from '../utils/attendanceCalculationPreviewService';
import { resolveCoveragePolicy, buildAttendanceCalculationPreviewRows } from '../utils/attendanceCalculationPreview';
import { fetchActiveEmployeesForRoster } from '../utils/rosterService';
import { EmployeeLite } from '../utils/hikcentralPersonMapping';
import { getBlantyreToday } from '../utils/rosterCalendarNav';
import { getErrorMessage } from '../utils/errorHandler';

const MAX_RANGE_DAYS = 14;

const STATUS_LABELS: Record<AttendanceCalculationStatus, string> = {
  present: 'Present', late: 'Late', absent: 'Absent', pending: 'Pending', off: 'Off', unassigned: 'Unassigned',
};

const STATUS_COLORS: Record<AttendanceCalculationStatus, 'green' | 'gold' | 'red' | 'gray' | 'blue' | 'navy'> = {
  present: 'green', late: 'gold', absent: 'red', pending: 'gray', off: 'blue', unassigned: 'navy',
};

function defaultDateRange(): { from: string; to: string } {
  const today = getBlantyreToday();
  const from = new Date(today);
  from.setDate(from.getDate() - 6);
  return { from: from.toISOString().slice(0, 10), to: today };
}

interface ComparisonRow {
  date: string;
  serverStatus: AttendanceCalculationStatus | null;
  serverBasis: AttendanceCalculationBasis | null;
  jsStatus: AttendanceCalculationStatus | null;
  jsBasis: AttendanceCalculationBasis | null;
  match: boolean;
}

export default function AttendanceServerCalculationPreview() {
  const [canView, setCanView] = useState(false);
  const [canApply, setCanApply] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);

  const defaults = useMemo(defaultDateRange, []);
  const [fromDate, setFromDate] = useState(defaults.from);
  const [toDate, setToDate] = useState(defaults.to);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [employeeSearch, setEmployeeSearch] = useState('');

  const [readiness, setReadiness] = useState<AutomaticAttendanceReadiness | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [rows, setRows] = useState<ComparisonRow[] | null>(null);

  const rangeInvalid = fromDate > toDate;
  const rangeTooWide = expandDateRange(fromDate, toDate).length > MAX_RANGE_DAYS;

  useEffect(() => {
    (async () => {
      const [view, apply] = await Promise.all([
        hasPermission(PERMISSIONS.ATTENDANCE_MAP_HIKCENTRAL_PERSONS),
        hasPermission(PERMISSIONS.ATTENDANCE_AUTO_APPLY),
      ]);
      setCanView(view);
      setCanApply(apply);
      setPermissionsLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!permissionsLoaded || !canView) return;
    fetchActiveEmployeesForRoster().then(setEmployees).catch(() => setEmployees([]));
    checkAutomaticAttendanceReadiness()
      .then(setReadiness)
      .catch((err) => setReadinessError(getErrorMessage(err)));
  }, [permissionsLoaded, canView]);

  const filteredEmployees = useMemo(() => {
    const q = employeeSearch.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => e.fullName.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q));
  }, [employees, employeeSearch]);

  const runComparison = useCallback(async () => {
    if (!selectedEmployeeId || rangeInvalid || rangeTooWide) return;
    setLoading(true);
    setRunError(null);
    setRows(null);
    try {
      const shiftDates = expandDateRange(fromDate, toDate);
      const employee = employees.find((e) => e.id === selectedEmployeeId);
      if (!employee) throw new Error('Select an employee first.');

      const [serverRows, previewData] = await Promise.all([
        fetchServerCalculationPreview([selectedEmployeeId], fromDate, toDate),
        fetchAttendanceCalculationPreviewData(fromDate, toDate),
      ]);

      // No operator-typed export time/workstation confirmation is applied
      // on the JS side here (this is a read-only comparison view, not the
      // coverage-confirmation workflow) -- the JS engine's own coverage
      // therefore stays 'insufficient' unless the official attendance
      // record already shows one. The server engine reads REAL durable
      // fingerprint_coverage_confirmations rows instead (none exist on
      // STAGING yet, per the readiness panel above), so the two sides can
      // only diverge once confirmations exist -- worth re-checking once
      // they do, not an oversight today.
      const coveragePolicy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '', confirmedWorkstationsRaw: '', operatorConfirmed: false });
      const jsRows = buildAttendanceCalculationPreviewRows({
        employees: [employee],
        shiftDates,
        datedAssignments: previewData.datedAssignments,
        patterns: previewData.patterns,
        eventsByEmployeeId: previewData.eventsByEmployeeId,
        coveragePolicy,
        officialStatusByKey: previewData.officialStatusByKey,
        employeeIdsWithActiveMapping: previewData.employeeIdsWithActiveMapping,
      });

      const serverByDate = new Map(serverRows.map((r) => [r.attendanceDate, r]));
      const jsByDate = new Map(jsRows.map((r) => [r.shiftDate, r]));

      const combined: ComparisonRow[] = shiftDates.map((date) => {
        const server = serverByDate.get(date);
        const js = jsByDate.get(date);
        return {
          date,
          serverStatus: server?.status ?? null,
          serverBasis: server?.calculationBasis ?? null,
          jsStatus: js?.calculation.status ?? null,
          jsBasis: js && js.calculation.basis !== 'not_applicable' ? js.calculation.basis : null,
          match: (server?.status ?? null) === (js?.calculation.status ?? null),
        };
      });
      setRows(combined);
    } catch (err) {
      setRunError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [selectedEmployeeId, fromDate, toDate, rangeInvalid, rangeTooWide, employees]);

  if (!permissionsLoaded) return null;
  if (!canView) return null;

  const mismatchCount = rows ? rows.filter((r) => !r.match).length : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <Server size={18} className="text-slate-500 mt-0.5 shrink-0" />
        <div>
          <h4 className="text-sm font-semibold text-slate-800">Server Calculation Preview (Stage C)</h4>
          <p className="text-xs text-slate-500 mt-0.5">
            Compares the server's own copy of the calculation engine against the JavaScript preview above, for one employee at a time. Read-only -- nothing here writes to the official attendance register.
          </p>
        </div>
      </div>

      <Card className="p-4 bg-slate-50">
        <div className="flex items-start gap-2 text-xs text-slate-600">
          <Info size={14} className="mt-0.5 shrink-0" />
          {readinessError ? (
            <span>Could not run the readiness check: {readinessError}</span>
          ) : !readiness ? (
            <span>Checking whether enough real data exists for a meaningful demonstration…</span>
          ) : readiness.overlapEmployeeCount === 0 ? (
            <span>
              <strong>No employee currently has both</strong> an active HikCentral Person Mapping ({readiness.mappedEmployeeCount} employee(s) mapped) <strong>and</strong> any roster Day/Night evidence ({readiness.rosterEvidencedEmployeeCount} employee(s) with a dated assignment or recurring Off pattern) -- every real (employee, date) pair will resolve to Unassigned below, not a fabricated demo. {readiness.coverageConfirmationCount === 0 && 'No fingerprint coverage confirmations exist yet either, so no Absent result can be confirmed either.'} Add a roster Day/Night assignment for a mapped employee covering a date with real fingerprint events to see a non-trivial result.
            </span>
          ) : (
            <span>
              {readiness.overlapEmployeeCount} employee(s) have both an active mapping and roster evidence -- a meaningful comparison is possible for at least one employee.
              {readiness.coverageConfirmationCount === 0 && ' No fingerprint coverage confirmations exist yet, so only Present/Late/Pending (never a confirmed Absent) can resolve until one is recorded.'}
            </span>
          )}
        </div>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="relative md:col-span-2">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={employeeSearch}
              onChange={(e) => setEmployeeSearch(e.target.value)}
              placeholder="Search employee..."
              className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>
          <Select
            value={selectedEmployeeId}
            onChange={(e) => setSelectedEmployeeId(e.target.value)}
            options={[{ label: 'Select employee...', value: '' }, ...filteredEmployees.map((e) => ({ label: `${e.fullName} (${e.employeeNumber})`, value: e.id }))]}
          />
          <div className="flex gap-2">
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-full px-2 py-2.5 text-sm border border-slate-200 rounded-lg" />
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-full px-2 py-2.5 text-sm border border-slate-200 rounded-lg" />
          </div>
        </div>
        {rangeTooWide && <p className="text-xs text-red-600">Range too wide -- please select {MAX_RANGE_DAYS} days or fewer.</p>}
        {rangeInvalid && <p className="text-xs text-red-600">The start date must not be after the end date.</p>}
        <Button onClick={runComparison} disabled={!selectedEmployeeId || rangeInvalid || rangeTooWide || loading}>
          {loading ? <span className="flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Running...</span> : 'Run Server Preview'}
        </Button>
        {runError && (
          <div className="flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle size={14} /> {runError}
          </div>
        )}
      </Card>

      {rows && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h5 className="text-sm font-semibold text-slate-800">Comparison results</h5>
            <Badge color={mismatchCount === 0 ? 'green' : 'red'}>{mismatchCount === 0 ? 'All match' : `${mismatchCount} mismatch(es)`}</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Server result</th>
                  <th className="py-2 pr-4">JS preview result</th>
                  <th className="py-2 pr-4">Match</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.date} className="border-b border-slate-100">
                    <td className="py-2 pr-4 text-slate-700">{r.date}</td>
                    <td className="py-2 pr-4">
                      {r.serverStatus && <Badge color={STATUS_COLORS[r.serverStatus]}>{STATUS_LABELS[r.serverStatus]}{r.serverBasis === 'check_in_only_provisional' ? ' (provisional)' : ''}</Badge>}
                    </td>
                    <td className="py-2 pr-4">
                      {r.jsStatus && <Badge color={STATUS_COLORS[r.jsStatus]}>{STATUS_LABELS[r.jsStatus]}{r.jsBasis === 'check_in_only_provisional' ? ' (provisional)' : ''}</Badge>}
                    </td>
                    <td className="py-2 pr-4">{r.match ? '✓' : '✗'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {canApply && (
        <Card className="p-4 bg-amber-50 border border-amber-200">
          <div className="flex items-start gap-2">
            <Lock size={16} className="text-amber-700 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800">Apply eligible results to the Monthly Register</p>
              <p className="text-xs text-amber-700 mt-1">
                Disabled pending the tenant-scoping/coverage-window corrective migration and a controlled STAGING test being approved. When enabled, this will call the already-protected attendance_apply_automatic RPC, which never writes Pending/Off/Unassigned or an unverified Absent, never overwrites a manual correction, and refuses to touch a month with approved payroll.
              </p>
              <Button className="mt-3" disabled title="Disabled until the SQL fix and controlled STAGING testing are approved">
                Apply to Monthly Register
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
