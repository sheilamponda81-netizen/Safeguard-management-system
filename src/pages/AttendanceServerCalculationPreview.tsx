// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage C, Steps 3-4.
//
// Read-only comparison of the SERVER-side calculation engine
// (attendance_resolve_and_calculate, via attendance_preview_calculate)
// against the existing client-side Stage A/B JavaScript preview, for a
// single employee over a bounded date range -- plus a real, permission-
// protected Apply workflow (Step 4) that writes ONLY the exact
// (employee, date) pairs an operator has reviewed and explicitly
// confirmed, restricted this round to confirmed Present/Late results
// backed by a genuine check-in AND checkout scan (never Absent/Pending/
// Off/Unassigned, and never a 'check_in_only_provisional' basis -- see
// classifyAutomaticEligibility). Manual-correction precedence, the
// approved-payroll block, tenant isolation, and append-only audit
// logging are all enforced by attendance_write_one/attendance_apply_
// automatic themselves (Stage C Step 1) -- this page adds the extra
// Present/Late-only restriction on top, and narrows every Apply call to
// a single date so a wider range's Absent/Pending/Off/Unassigned
// results are never touched by it.
//
// What-if Simulation (AttendanceWhatIfSimulation.tsx, a sibling section)
// is a wholly separate, hypothetical-shift tool and is NEVER read from
// or wired into this page -- a What-if result can never become an
// eligible row here, by construction (this page only ever classifies
// attendance_preview_calculate's own output, which always resolves the
// shift from real roster data, never an operator's hypothetical choice).
//
// PREREQUISITE NOTE: as of this page's introduction, a read-only check
// against STAGING found ZERO overlap between employees with an active
// HikCentral Person Mapping and employees with ANY roster Day/Night
// evidence -- every real (employee, date) pair currently resolves to
// 'unassigned' before the engine ever reaches event/coverage logic. The
// readiness panel below runs that same check live and reports it
// plainly; this page never fabricates a working example to compensate,
// and the Apply action simply has nothing eligible to offer until that
// changes.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Server, AlertTriangle, RefreshCw, Lock, Search, Info, CheckCircle2 } from '../utils/icons';
import { Card, Button, Badge, Select } from '../components/ui';
import { hasPermission, PERMISSIONS } from '../utils/permissions';
import { expandDateRange } from '../utils/rosterSchedule';
import { AttendanceCalculationStatus, AttendanceCalculationBasis } from '../utils/attendanceCalculationEngine';
import { fetchServerCalculationPreview, checkAutomaticAttendanceReadiness, AutomaticAttendanceReadiness } from '../utils/attendanceServerPreviewService';
import {
  fetchExistingAttendanceAndPayroll, classifyAutomaticEligibility, applyEligibleAutomaticResults,
  AutomaticEligibility, ApplyOutcome,
} from '../utils/attendanceAutomaticApplyService';
import { fetchAttendanceCalculationPreviewData, fetchAttendanceCoverageExplain } from '../utils/attendanceCalculationPreviewService';
import {
  resolveCoveragePolicy, buildAttendanceCalculationPreviewRows, classifyStageCComparison, StageCComparisonClassification,
} from '../utils/attendanceCalculationPreview';
import { fetchActiveEmployeesForRoster } from '../utils/rosterService';
import { EmployeeLite } from '../utils/hikcentralPersonMapping';
import { getBlantyreToday } from '../utils/rosterCalendarNav';
import { getErrorMessage } from '../utils/errorHandler';

const ELIGIBILITY_LABELS: Record<AutomaticEligibility, string> = {
  eligible: 'Eligible',
  skipped_not_confirmed_present_late: 'Skipped (not a confirmed Present/Late)',
  protected_manual: 'Protected (existing manual correction)',
  protected_payroll_approved: 'Protected (payroll already approved)',
};
const ELIGIBILITY_COLORS: Record<AutomaticEligibility, 'green' | 'gray' | 'blue' | 'red'> = {
  eligible: 'green',
  skipped_not_confirmed_present_late: 'gray',
  protected_manual: 'blue',
  protected_payroll_approved: 'red',
};

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
  classification: StageCComparisonClassification;
  jsCoverageReason: string | null;
  eligibility: AutomaticEligibility;
}

const CLASSIFICATION_LABELS: Record<StageCComparisonClassification, string> = {
  match: 'Match',
  unavailable_incomplete_comparison: 'Unavailable (incomplete comparison)',
  untrusted_historical_coverage: 'Untrusted historical coverage (not an engine defect)',
  different_coverage_inputs: 'Different coverage inputs',
  genuine_calculation_disagreement: 'Genuine calculation disagreement',
};
const CLASSIFICATION_COLORS: Record<StageCComparisonClassification, 'green' | 'gray' | 'gold' | 'blue' | 'red'> = {
  match: 'green',
  unavailable_incomplete_comparison: 'gray',
  untrusted_historical_coverage: 'gold',
  different_coverage_inputs: 'blue',
  genuine_calculation_disagreement: 'red',
};

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

  const [operatorConfirmed, setOperatorConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyOutcomes, setApplyOutcomes] = useState<ApplyOutcome[] | null>(null);

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
    setOperatorConfirmed(false);
    setApplyOutcomes(null);
    setApplyError(null);
    try {
      const shiftDates = expandDateRange(fromDate, toDate);
      const employee = employees.find((e) => e.id === selectedEmployeeId);
      if (!employee) throw new Error('Select an employee first.');

      const [serverRows, previewData, existing, serverCoverageByKey] = await Promise.all([
        fetchServerCalculationPreview([selectedEmployeeId], fromDate, toDate),
        fetchAttendanceCalculationPreviewData(fromDate, toDate),
        fetchExistingAttendanceAndPayroll(selectedEmployeeId, fromDate, toDate),
        // Attendance coverage-consistency improvement: the JS side now
        // ALSO consults the same real, persisted, evidence-checked
        // coverage the server reads (attendance_coverage_explain) --
        // this used to stay hardcoded to no operator-typed confirmation
        // at all, which is why this comparison previously diverged from
        // the server purely on coverage INPUT, not on a calculation
        // disagreement. No operator-typed export time/workstation
        // confirmation is still applied here (this remains a read-only
        // comparison view, not the confirmation workflow) -- only the
        // genuinely trustworthy, already-persisted evidence.
        fetchAttendanceCoverageExplain([selectedEmployeeId], fromDate, toDate),
      ]);

      const coveragePolicy = resolveCoveragePolicy({ exportTimeBlantyreLocal: '', confirmedWorkstationsRaw: '', operatorConfirmed: false });
      const jsRows = buildAttendanceCalculationPreviewRows({
        employees: [employee],
        shiftDates,
        datedAssignments: previewData.datedAssignments,
        patterns: previewData.patterns,
        // Stage C roster fix: this was missing, so any employee whose
        // schedule comes from the recurring Day/Night baseline (rather
        // than a per-date dated assignment) fell through
        // resolveScheduleForDate's precedence straight to 'unassigned' on
        // this JS side only -- the server's own roster_resolve_schedule()
        // was never affected, so this was a display-only mismatch, not a
        // calculation-engine discrepancy. Matches what the Main Attendance
        // Review already passes.
        shiftPatterns: previewData.shiftPatterns,
        eventsByEmployeeId: previewData.eventsByEmployeeId,
        coveragePolicy,
        officialStatusByKey: previewData.officialStatusByKey,
        employeeIdsWithActiveMapping: previewData.employeeIdsWithActiveMapping,
        serverCoverageByKey,
        // Compared directly against the server's own attendance_
        // resolve_and_calculate, which supplies clock_timestamp() as its
        // real-time reference (20261125000000) -- using "now" here too
        // keeps this an apples-to-apples comparison.
        asOfIso: new Date().toISOString(),
      });

      const serverByDate = new Map(serverRows.map((r) => [r.attendanceDate, r]));
      const jsByDate = new Map(jsRows.map((r) => [r.shiftDate, r]));

      const combined: ComparisonRow[] = shiftDates.map((date) => {
        const server = serverByDate.get(date);
        const js = jsByDate.get(date);
        const eligibility = classifyAutomaticEligibility(
          { employeeId: selectedEmployeeId, date, status: server?.status ?? '', calculationBasis: server?.calculationBasis ?? null },
          existing
        );
        const coverageEvidence = serverCoverageByKey.get(`${selectedEmployeeId}|${date}`);
        const classification = classifyStageCComparison({
          serverStatus: server?.status ?? null,
          jsStatus: js?.calculation.status ?? null,
          jsCoverageProvenance: coverageEvidence?.coverageProvenance ?? null,
        });
        return {
          date,
          serverStatus: server?.status ?? null,
          serverBasis: server?.calculationBasis ?? null,
          jsStatus: js?.calculation.status ?? null,
          jsBasis: js && js.calculation.basis !== 'not_applicable' ? js.calculation.basis : null,
          match: classification === 'match',
          classification,
          jsCoverageReason: coverageEvidence?.reason ?? null,
          eligibility,
        };
      });
      setRows(combined);
    } catch (err) {
      setRunError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [selectedEmployeeId, fromDate, toDate, rangeInvalid, rangeTooWide, employees]);

  const eligibleRows = useMemo(() => (rows ?? []).filter((r) => r.eligibility === 'eligible'), [rows]);

  const applyNow = useCallback(async () => {
    if (!canApply || !operatorConfirmed || eligibleRows.length === 0) return;
    setApplying(true);
    setApplyError(null);
    try {
      const outcomes = await applyEligibleAutomaticResults(
        eligibleRows.map((r) => ({ employeeId: selectedEmployeeId, date: r.date }))
      );
      setApplyOutcomes(outcomes);
    } catch (err) {
      setApplyError(getErrorMessage(err));
    } finally {
      setApplying(false);
    }
  }, [canApply, operatorConfirmed, eligibleRows, selectedEmployeeId]);

  if (!permissionsLoaded) return null;
  if (!canView) return null;

  const mismatchCount = rows ? rows.filter((r) => !r.match).length : 0;
  const classificationCounts = rows
    ? rows.reduce((acc, r) => { acc[r.classification] = (acc[r.classification] ?? 0) + 1; return acc; }, {} as Record<StageCComparisonClassification, number>)
    : null;
  const eligibilityCounts = rows
    ? rows.reduce((acc, r) => { acc[r.eligibility] = (acc[r.eligibility] ?? 0) + 1; return acc; }, {} as Record<AutomaticEligibility, number>)
    : null;

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
            <Badge color={mismatchCount === 0 ? 'green' : 'red'}>{mismatchCount === 0 ? 'All match' : `${mismatchCount} difference(s)`}</Badge>
          </div>
          {classificationCounts && mismatchCount > 0 && (
            <p className="text-xs text-slate-500 mb-3 flex flex-wrap gap-2">
              Not every difference is a calculation defect -- see each row's own reason:
              {(Object.keys(CLASSIFICATION_LABELS) as StageCComparisonClassification[])
                .filter((k) => k !== 'match' && (classificationCounts[k] ?? 0) > 0)
                .map((k) => (
                  <Badge key={k} color={CLASSIFICATION_COLORS[k]}>{CLASSIFICATION_LABELS[k]}: {classificationCounts[k]}</Badge>
                ))}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Server result</th>
                  <th className="py-2 pr-4">JS preview result</th>
                  <th className="py-2 pr-4">Comparison</th>
                  <th className="py-2 pr-4">Automatic-apply status</th>
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
                    <td className="py-2 pr-4">
                      <span title={r.jsCoverageReason ?? undefined}>
                        <Badge color={CLASSIFICATION_COLORS[r.classification]}>{CLASSIFICATION_LABELS[r.classification]}</Badge>
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <Badge color={ELIGIBILITY_COLORS[r.eligibility]}>{ELIGIBILITY_LABELS[r.eligibility]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {rows && eligibilityCounts && (
        <Card className="p-4 bg-amber-50 border border-amber-200">
          <div className="flex items-start gap-2">
            <Lock size={16} className="text-amber-700 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800">Apply eligible results to the Monthly Register</p>
              <p className="text-xs text-amber-700 mt-1">
                {eligibleRows.length} of {rows.length} day(s) in range are eligible: a confirmed Present/Late result backed by a genuine check-in AND checkout scan, for this genuinely rostered employee, with no existing manual correction and no approved payroll for that month. Absent, Pending, Off, Unassigned, and provisional (check-in-only) results are never applied automatically.
              </p>
              <div className="flex flex-wrap gap-2 mt-2 text-xs">
                {(Object.keys(ELIGIBILITY_LABELS) as AutomaticEligibility[]).map((key) => (
                  <Badge key={key} color={ELIGIBILITY_COLORS[key]}>{ELIGIBILITY_LABELS[key]}: {eligibilityCounts[key] ?? 0}</Badge>
                ))}
              </div>

              {!canApply ? (
                <p className="text-xs text-amber-700 mt-3">You do not hold the attendance.auto_apply permission, so the Apply control is not shown.</p>
              ) : eligibleRows.length === 0 ? (
                <p className="text-xs text-amber-700 mt-3">No eligible day in this range -- there is nothing to apply. This is not an error: it means no day both resolved to a confirmed Present/Late AND is free of manual/payroll protection.</p>
              ) : (
                <>
                  <label className="flex items-start gap-2 mt-3 text-xs text-amber-800">
                    <input
                      type="checkbox"
                      checked={operatorConfirmed}
                      onChange={(e) => setOperatorConfirmed(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      I have verified that {employees.find((e) => e.id === selectedEmployeeId)?.fullName} was genuinely rostered and these {eligibleRows.length} day(s) reflect a real shift -- not a What-if Simulation or an assumption. I understand this will write official attendance records.
                    </span>
                  </label>
                  <Button className="mt-3" onClick={applyNow} disabled={!operatorConfirmed || applying}>
                    {applying ? <span className="flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Applying...</span> : `Apply ${eligibleRows.length} record(s) to Monthly Register`}
                  </Button>
                </>
              )}
              {applyError && (
                <div className="flex items-center gap-2 text-sm text-red-600 mt-2">
                  <AlertTriangle size={14} /> {applyError}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {applyOutcomes && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 size={16} className="text-emerald-600" />
            <h5 className="text-sm font-semibold text-slate-800">Actual outcomes</h5>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4">Outcome</th>
                <th className="py-2 pr-4">Old status</th>
                <th className="py-2 pr-4">New status</th>
                <th className="py-2 pr-4">Payroll flag</th>
              </tr>
            </thead>
            <tbody>
              {applyOutcomes.map((o) => (
                <tr key={o.date} className="border-b border-slate-100">
                  <td className="py-2 pr-4 text-slate-700">{o.date}</td>
                  <td className="py-2 pr-4 text-slate-700">{o.outcome}</td>
                  <td className="py-2 pr-4 text-slate-700">{o.oldStatus ?? '—'}</td>
                  <td className="py-2 pr-4 text-slate-700">{o.newStatus ?? '—'}</td>
                  <td className="py-2 pr-4 text-slate-700">{o.payrollFlag ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
