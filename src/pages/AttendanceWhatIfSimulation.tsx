// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage C, Step 3:
// "What-if Simulation" -- SIMULATION ONLY, never official attendance.
//
// Reuses the existing Stage A pure engine (calculateAttendanceStatus)
// exactly as-is, fed real fingerprint scans for the chosen employee/date
// (via the existing Stage B read-only data service) and a shift the
// OPERATOR explicitly picks -- NEVER a roster-resolved shift. This is
// the entire point: it answers "if this employee had been on a Day/
// Night shift that day, what would the engine say?", without claiming
// to know whether they actually were. No roster assignment is ever
// read as authoritative here (resolvedShift from real roster data is
// deliberately never consulted), no coverage confirmation is read or
// implied (coverage is always 'insufficient' -- the only honest
// starting point when nothing has verified export completeness), and
// NOTHING on this page writes anything: no roster assignment, no
// fingerprint coverage confirmation, no attendance.status row, no
// payroll change, and no call to attendance_correct, attendance_bulk_
// correct, attendance_apply_automatic, or attendance_preview_calculate.
// This page's calculation happens entirely in the browser.
import { useState, useMemo, useCallback, useEffect } from 'react';
import { FlaskConical, Search, AlertTriangle, RefreshCw } from '../utils/icons';
import { Card, Button, Badge, Select } from '../components/ui';
import { hasPermission, PERMISSIONS } from '../utils/permissions';
import { ResolvedSchedule } from '../utils/rosterSchedule';
import { calculateAttendanceStatus, AttendanceCalculationResult } from '../utils/attendanceCalculationEngine';
import { expectedShiftTimesFor } from '../utils/attendanceCalculationPreview';
import { fetchAttendanceCalculationPreviewData } from '../utils/attendanceCalculationPreviewService';
import { fetchActiveEmployeesForRoster } from '../utils/rosterService';
import { blantyreDateKey, blantyreTimeOfDay } from '../utils/hikcentralAttendancePreview';
import { EmployeeLite } from '../utils/hikcentralPersonMapping';
import { getErrorMessage } from '../utils/errorHandler';

const STATUS_LABELS: Record<string, string> = {
  present: 'Present', late: 'Late', absent: 'Absent', pending: 'Pending', off: 'Off', unassigned: 'Unassigned',
};
const STATUS_COLORS: Record<string, 'green' | 'gold' | 'red' | 'gray' | 'blue' | 'navy'> = {
  present: 'green', late: 'gold', absent: 'red', pending: 'gray', off: 'blue', unassigned: 'navy',
};

function formatBlantyre(utcIso: string | null): string {
  if (!utcIso) return '—';
  return `${blantyreDateKey(utcIso)} ${blantyreTimeOfDay(utcIso)} (Blantyre)`;
}

export default function AttendanceWhatIfSimulation() {
  const [canView, setCanView] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [employeeSearch, setEmployeeSearch] = useState('Alim');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [simDate, setSimDate] = useState('2026-10-01');
  const [hypotheticalShift, setHypotheticalShift] = useState<'day' | 'night'>('day');

  const [loading, setLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    employeeName: string;
    scanTimesBlantyre: string[];
    officialStatus: string | null;
    calculation: AttendanceCalculationResult;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const view = await hasPermission(PERMISSIONS.ATTENDANCE_MAP_HIKCENTRAL_PERSONS);
      setCanView(view);
      setPermissionsLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!permissionsLoaded || !canView) return;
    fetchActiveEmployeesForRoster().then(setEmployees).catch(() => setEmployees([]));
  }, [permissionsLoaded, canView]);

  const filteredEmployees = useMemo(() => {
    const q = employeeSearch.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => e.fullName.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q));
  }, [employees, employeeSearch]);

  const shiftTimes = expectedShiftTimesFor(hypotheticalShift as ResolvedSchedule);

  const runSimulation = useCallback(async () => {
    if (!selectedEmployeeId || !simDate) return;
    setLoading(true);
    setRunError(null);
    setResult(null);
    try {
      const employee = employees.find((e) => e.id === selectedEmployeeId);
      if (!employee) throw new Error('Select an employee first.');

      // Read-only: real roster/fingerprint/official-attendance data for
      // this one date, exactly like the existing JS preview above uses --
      // but resolvedShift from this data is NEVER consulted below. Only
      // the real fingerprint events and the real (display-only) official
      // status are used.
      const data = await fetchAttendanceCalculationPreviewData(simDate, simDate);
      const events = data.eventsByEmployeeId.get(selectedEmployeeId) ?? [];
      const officialStatus = data.officialStatusByKey.get(`${selectedEmployeeId}|${simDate}`) ?? null;

      const calculation = calculateAttendanceStatus({
        shiftDate: simDate,
        resolvedShift: hypotheticalShift,
        events,
        coverage: { status: 'insufficient' },
        asOfIso: new Date().toISOString(),
      });

      setResult({
        employeeName: employee.fullName,
        scanTimesBlantyre: events.map((e) => formatBlantyre(e.timestampIso)),
        officialStatus,
        calculation,
      });
    } catch (err) {
      setRunError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [selectedEmployeeId, simDate, hypotheticalShift, employees]);

  if (!permissionsLoaded || !canView) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <FlaskConical size={18} className="text-slate-500 mt-0.5 shrink-0" />
        <div>
          <h4 className="text-sm font-semibold text-slate-800">What-if Simulation</h4>
          <p className="text-xs text-slate-500 mt-0.5">
            Runs the real calculation engine against an employee's actual fingerprint scans and a shift YOU choose -- not their actual roster. Answers "what would this calculate to if they had been on this shift?", nothing more.
          </p>
        </div>
      </div>

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
          <input type="date" value={simDate} onChange={(e) => setSimDate(e.target.value)} className="w-full px-2 py-2.5 text-sm border border-slate-200 rounded-lg" />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-slate-600">Hypothetical shift:</span>
          <Select
            value={hypotheticalShift}
            onChange={(e) => setHypotheticalShift(e.target.value as 'day' | 'night')}
            options={[{ label: 'Day', value: 'day' }, { label: 'Night', value: 'night' }]}
            className="w-32"
          />
          {shiftTimes && <span className="text-xs text-slate-500">({shiftTimes.scheduledStart}–{shiftTimes.scheduledEnd}, Blantyre)</span>}
        </div>
        <Button onClick={runSimulation} disabled={!selectedEmployeeId || !simDate || loading}>
          {loading ? <span className="flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Running...</span> : 'Run Simulation'}
        </Button>
        {runError && (
          <div className="flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle size={14} /> {runError}
          </div>
        )}
      </Card>

      {result && (
        <Card className="p-4 border-2 border-amber-400 bg-amber-50">
          <div className="flex items-center justify-between mb-3">
            <Badge color="orange" className="text-xs font-bold tracking-wide">SIMULATION ONLY — NOT OFFICIAL ATTENDANCE</Badge>
          </div>
          <p className="text-xs text-amber-800 mb-3">
            This does NOT confirm {result.employeeName}'s actual roster or attendance for {simDate}. It shows only what the engine would calculate if the hypothetical shift below were their real one. Nothing has been saved anywhere.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-slate-500 mb-1">Employee</p>
              <p className="font-medium text-slate-800">{result.employeeName}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Hypothetical shift</p>
              <p className="font-medium text-slate-800">{hypotheticalShift === 'day' ? 'Day' : 'Night'} ({shiftTimes?.scheduledStart}–{shiftTimes?.scheduledEnd} Blantyre) on {simDate}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Actual fingerprint scans (Africa/Blantyre)</p>
              {result.scanTimesBlantyre.length === 0 ? (
                <p className="text-slate-500 italic">No scans found for this date.</p>
              ) : (
                <ul className="list-disc list-inside text-slate-800">
                  {result.scanTimesBlantyre.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              )}
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Current official attendance (for reference only)</p>
              <p className="text-slate-800">{result.officialStatus ?? 'Not recorded'}</p>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-amber-200">
            <p className="text-xs text-slate-500 mb-1">Simulated calculation result</p>
            <div className="flex items-center gap-2">
              <Badge color={STATUS_COLORS[result.calculation.status]}>{STATUS_LABELS[result.calculation.status]}</Badge>
              {result.calculation.basis !== 'not_applicable' && <span className="text-xs text-slate-500">({result.calculation.basis})</span>}
            </div>
            <p className="text-xs text-slate-600 mt-2">{result.calculation.reason}</p>
          </div>
        </Card>
      )}
    </div>
  );
}
