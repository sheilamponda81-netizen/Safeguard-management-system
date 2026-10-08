// Safeguard HikCentral Attendance MVP -- Phase 2B.1: Roster Management
// Foundation.
//
// Admin-only by design (default; Operations read access is a separate,
// later decision -- see the migration's header). The REAL security
// boundary is server-side (RLS + the three SECURITY DEFINER RPCs in
// supabase/migrations/20261008000000_roster_management_foundation.sql,
// which revoke direct table INSERT/UPDATE from every client session
// entirely) -- this page's own isBusinessAdmin()/is_super_admin check
// below is a defense-in-depth UX convenience only, never the thing that
// actually stops an unauthorized write.
//
// This page never touches attendance/payroll/payment_status/
// employee_deductions, never generates attendance from HikCentral data,
// and computes no Present/Absent/Late/hours-worked/deduction value.
import { useState, useEffect, useMemo, useCallback } from 'react';
import { CalendarDays, Search, Users as UsersIcon, RefreshCw, AlertTriangle, ChevronLeft, ChevronRight } from '../utils/icons';
import { Card, Button, Badge, PageHeader, EmptyState, Input, Select, Tabs, Table, THead, TBody, TR, TH, TD } from '../components/ui';
import { getCurrentProfile, UserProfile } from '../utils/currentProfile';
import { isBusinessAdmin } from '../utils/permissions';
import { showNotification } from '../utils/clickHandlers';
import {
  resolveScheduleForDate, expandDateRange, addDays, WEEKDAY_LABELS,
  AssignmentType, OffDayPatternRow, DateAssignmentRow,
} from '../utils/rosterSchedule';
import {
  CalendarViewMode, getBlantyreToday, startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  shiftCalendarRange, formatDayHeading, formatPeriodHeading, isValidDateRange, dateRangeLengthDays, MAX_CUSTOM_RANGE_DAYS,
} from '../utils/rosterCalendarNav';
import { EmployeeLite } from '../utils/hikcentralPersonMapping';
import {
  fetchActiveOffDayPatterns, fetchActiveDateAssignments, fetchActiveEmployeesForRoster,
  assignOffPattern, assignDates, rescheduleOffDay,
} from '../utils/rosterService';

type TabId = 'calendar' | 'off-pattern' | 'assign-dates' | 'reschedule';

const ASSIGNMENT_TYPE_OPTIONS = [
  { label: 'Day shift', value: 'day' },
  { label: 'Night shift', value: 'night' },
  { label: 'Off (dated exception)', value: 'off' },
];

const WEEKDAY_OPTIONS = WEEKDAY_LABELS.map((label, value) => ({ label, value: String(value) }));

function defaultCalendarRange(): { from: string; to: string; today: string } {
  const today = getBlantyreToday();
  return { from: startOfWeek(today), to: endOfWeek(today), today };
}

export default function RosterPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const canManage = !!profile && (isBusinessAdmin(profile) || profile.is_super_admin === true);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [patterns, setPatterns] = useState<OffDayPatternRow[]>([]);
  const [dateAssignments, setDateAssignments] = useState<DateAssignmentRow[]>([]);

  const [activeTab, setActiveTab] = useState<TabId>('calendar');
  const [employeeSearch, setEmployeeSearch] = useState('');
  const defaults = useMemo(defaultCalendarRange, []);
  const [calendarFrom, setCalendarFrom] = useState(defaults.from);
  const [calendarTo, setCalendarTo] = useState(defaults.to);
  const [calendarViewMode, setCalendarViewMode] = useState<CalendarViewMode>('week');
  const [submitting, setSubmitting] = useState(false);

  const isCalendarRangeValid = isValidDateRange(calendarFrom, calendarTo);
  const calendarRangeTooLarge =
    calendarViewMode === 'custom' && isCalendarRangeValid && dateRangeLengthDays(calendarFrom, calendarTo) > MAX_CUSTOM_RANGE_DAYS;

  const handleCalendarNav = useCallback(
    (direction: 1 | -1) => {
      // Guarded here too, not just via the buttons' `disabled` attribute --
      // an invalid (inverted) or oversized custom range has no grid shown
      // to navigate, so silently shifting it further would only ever
      // produce another hidden range (same policy as loadData's own
      // shouldFetchAssignments guard below).
      if (!isCalendarRangeValid || calendarRangeTooLarge) return;
      const next = shiftCalendarRange(calendarFrom, calendarTo, calendarViewMode, direction);
      setCalendarFrom(next.from);
      setCalendarTo(next.to);
    },
    [calendarFrom, calendarTo, calendarViewMode, isCalendarRangeValid, calendarRangeTooLarge]
  );

  const handleCalendarToday = useCallback(() => {
    const today = getBlantyreToday();
    setCalendarViewMode('week');
    setCalendarFrom(startOfWeek(today));
    setCalendarTo(endOfWeek(today));
  }, []);

  const handleCalendarViewMode = useCallback(
    (mode: 'week' | 'month') => {
      const anchor = isCalendarRangeValid ? calendarFrom : getBlantyreToday();
      setCalendarViewMode(mode);
      if (mode === 'week') {
        setCalendarFrom(startOfWeek(anchor));
        setCalendarTo(endOfWeek(anchor));
      } else {
        setCalendarFrom(startOfMonth(anchor));
        setCalendarTo(endOfMonth(anchor));
      }
    },
    [calendarFrom, isCalendarRangeValid]
  );

  const handleCalendarFromChange = useCallback((value: string) => {
    setCalendarViewMode('custom');
    setCalendarFrom(value);
  }, []);

  const handleCalendarToChange = useCallback((value: string) => {
    setCalendarViewMode('custom');
    setCalendarTo(value);
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // An invalid (inverted) or oversized custom range can never resolve
      // to a sensible calendar grid -- skip the (potentially huge, always
      // pointless) date-assignments fetch rather than send PostgREST a
      // query that would just return zero or excessive rows. Employees
      // and patterns are still needed by the other tabs regardless of
      // what the Calendar tab's range currently is.
      const shouldFetchAssignments = isCalendarRangeValid && !calendarRangeTooLarge;
      const [emps, pats, assigns] = await Promise.all([
        fetchActiveEmployeesForRoster(),
        fetchActiveOffDayPatterns(),
        shouldFetchAssignments
          ? fetchActiveDateAssignments(addDays(calendarFrom, -1), addDays(calendarTo, 1))
          : Promise.resolve([]),
      ]);
      setEmployees(emps);
      setPatterns(pats);
      setDateAssignments(assigns);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load roster data.');
    } finally {
      setLoading(false);
    }
  }, [calendarFrom, calendarTo, isCalendarRangeValid, calendarRangeTooLarge]);

  useEffect(() => {
    (async () => {
      setProfile(await getCurrentProfile());
      setProfileLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (profileLoaded && canManage) loadData();
  }, [profileLoaded, canManage, loadData]);

  const filteredEmployees = useMemo(() => {
    const q = employeeSearch.trim().toLowerCase();
    if (q === '') return employees;
    return employees.filter((e) => e.fullName.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q));
  }, [employees, employeeSearch]);

  const calendarDates = useMemo(() => {
    if (!isCalendarRangeValid || calendarRangeTooLarge) return [];
    return expandDateRange(calendarFrom, calendarTo);
  }, [calendarFrom, calendarTo, isCalendarRangeValid, calendarRangeTooLarge]);

  const calendarPeriodHeading = useMemo(
    () => formatPeriodHeading(calendarViewMode, calendarFrom, calendarTo),
    [calendarViewMode, calendarFrom, calendarTo]
  );

  // --- Set recurring Off-day pattern form ---
  const [offPatternEmployeeIds, setOffPatternEmployeeIds] = useState<Set<string>>(new Set());
  const [offPatternWeekday, setOffPatternWeekday] = useState('0');
  const [offPatternEffectiveFrom, setOffPatternEffectiveFrom] = useState(defaults.today);
  const [offPatternReason, setOffPatternReason] = useState('');

  const handleSubmitOffPattern = useCallback(async () => {
    if (offPatternEmployeeIds.size === 0) {
      showNotification('Select at least one employee.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const result = await assignOffPattern(
        Array.from(offPatternEmployeeIds),
        Number(offPatternWeekday),
        offPatternEffectiveFrom,
        offPatternReason || undefined
      );
      if (result.success) {
        showNotification(
          `Updated ${result.assignedCount} employee(s).${result.alreadySetCount ? ` ${result.alreadySetCount} already set.` : ''}`,
          'success'
        );
        setOffPatternEmployeeIds(new Set());
        setOffPatternReason('');
        await loadData();
      } else {
        showNotification(result.error || 'Could not set the Off-day pattern.', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }, [offPatternEmployeeIds, offPatternWeekday, offPatternEffectiveFrom, offPatternReason, loadData]);

  // --- Assign Day/Night/Off for a date range form ---
  const [assignEmployeeIds, setAssignEmployeeIds] = useState<Set<string>>(new Set());
  const [assignType, setAssignType] = useState<AssignmentType>('day');
  const [assignDateFrom, setAssignDateFrom] = useState(defaults.today);
  const [assignDateTo, setAssignDateTo] = useState(defaults.today);
  const [assignReason, setAssignReason] = useState('');

  const handleSubmitAssignDates = useCallback(async () => {
    if (assignEmployeeIds.size === 0) {
      showNotification('Select at least one employee.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const result = await assignDates(
        Array.from(assignEmployeeIds),
        assignDateFrom,
        assignDateTo,
        assignType,
        assignReason || undefined
      );
      if (result.success) {
        showNotification(
          `Assigned ${result.assignedCount} day(s).${result.alreadySetCount ? ` ${result.alreadySetCount} already set.` : ''}`,
          'success'
        );
        setAssignEmployeeIds(new Set());
        setAssignReason('');
        await loadData();
      } else {
        showNotification(result.error || 'Could not assign the selected dates.', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }, [assignEmployeeIds, assignDateFrom, assignDateTo, assignType, assignReason, loadData]);

  // --- Reschedule Off day (atomic composite) form ---
  const [rescheduleEmployeeId, setRescheduleEmployeeId] = useState('');
  const [rescheduleNewOffDate, setRescheduleNewOffDate] = useState(defaults.today);
  const [rescheduleVacatedDate, setRescheduleVacatedDate] = useState('');
  const [rescheduleVacatedType, setRescheduleVacatedType] = useState<'day' | 'night'>('day');
  const [rescheduleAssignVacated, setRescheduleAssignVacated] = useState(false);
  const [rescheduleReason, setRescheduleReason] = useState('');

  const handleSubmitReschedule = useCallback(async () => {
    if (!rescheduleEmployeeId) {
      showNotification('Select an employee.', 'error');
      return;
    }
    if (!rescheduleReason.trim()) {
      showNotification('A reason is required to reschedule an Off day.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const result = await rescheduleOffDay(
        rescheduleEmployeeId,
        rescheduleNewOffDate,
        rescheduleReason,
        rescheduleAssignVacated ? rescheduleVacatedDate : undefined,
        rescheduleAssignVacated ? rescheduleVacatedType : undefined
      );
      if (result.success) {
        showNotification('Off day rescheduled.', 'success');
        setRescheduleReason('');
        setRescheduleVacatedDate('');
        setRescheduleAssignVacated(false);
        await loadData();
      } else {
        showNotification(result.error || 'Could not reschedule the Off day.', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }, [rescheduleEmployeeId, rescheduleNewOffDate, rescheduleReason, rescheduleAssignVacated, rescheduleVacatedDate, rescheduleVacatedType, loadData]);

  const toggleInSet = (set: Set<string>, setSet: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSet(next);
  };

  if (!profileLoaded) {
    return <div className="p-8 text-center text-slate-400">Loading...</div>;
  }

  if (!canManage) {
    return (
      <div className="space-y-6">
        <PageHeader title="Roster Management" subtitle="Off-day patterns, Day/Night shift assignments, and scheduling history." />
        <Card className="p-6 bg-amber-50 border-amber-200 border">
          <p className="text-sm text-amber-800">Roster management is Admin-only. You do not have access to this page.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roster Management"
        subtitle="Recurring Off-day patterns and dated Day/Night assignments. Off, Unassigned, Absence, Leave, and Sick Leave remain distinct -- nothing here writes attendance or payroll."
        actions={<Button variant="outline" onClick={loadData}><RefreshCw size={14} /> Refresh</Button>}
      />

      {loadError && (
        <Card className="p-4 bg-red-50 border-red-200 border">
          <p className="text-sm text-red-700">{loadError}</p>
        </Card>
      )}

      <Input icon={Search} placeholder="Search employee by name or number..." value={employeeSearch} onChange={(e) => setEmployeeSearch(e.target.value)} />

      <Tabs
        tabs={[
          { id: 'calendar', label: 'Calendar', icon: CalendarDays },
          { id: 'off-pattern', label: 'Recurring Off Day', icon: UsersIcon },
          { id: 'assign-dates', label: 'Assign Dates', icon: CalendarDays },
          { id: 'reschedule', label: 'Reschedule Off Day', icon: AlertTriangle },
        ]}
        active={activeTab}
        onChange={(id) => setActiveTab(id as TabId)}
      />

      {loading ? (
        <div className="p-8 text-center text-slate-400">Loading roster data...</div>
      ) : activeTab === 'calendar' ? (
        <div className="space-y-3">
          <Card className="p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => handleCalendarNav(-1)} disabled={!isCalendarRangeValid || calendarRangeTooLarge} title="Previous period">
                  <ChevronLeft size={16} />
                </Button>
                <Button variant="outline" size="sm" onClick={() => handleCalendarNav(1)} disabled={!isCalendarRangeValid || calendarRangeTooLarge} title="Next period">
                  <ChevronRight size={16} />
                </Button>
                <Button variant="outline" size="sm" onClick={handleCalendarToday}>Today</Button>
                <h2 className="text-base font-semibold text-slate-800 ml-2">{calendarPeriodHeading}</h2>
              </div>
              <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
                <button
                  type="button"
                  onClick={() => handleCalendarViewMode('week')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${calendarViewMode === 'week' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Week
                </button>
                <button
                  type="button"
                  onClick={() => handleCalendarViewMode('month')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${calendarViewMode === 'month' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Month
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input label="From" type="date" value={calendarFrom} onChange={(e) => handleCalendarFromChange(e.target.value)} />
              <Input label="To" type="date" value={calendarTo} onChange={(e) => handleCalendarToChange(e.target.value)} />
            </div>
            {calendarViewMode === 'custom' && isCalendarRangeValid && !calendarRangeTooLarge && (
              <p className="text-xs text-slate-500">Custom range selected – Previous/Next will now move by this range's own length ({dateRangeLengthDays(calendarFrom, calendarTo)} day(s)). Switch back to Week or Month at any time.</p>
            )}
            {calendarViewMode === 'custom' && isCalendarRangeValid && calendarRangeTooLarge && (
              <p className="text-xs text-amber-700">Previous/Next are unavailable for this range. Shorten it to {MAX_CUSTOM_RANGE_DAYS} days or fewer, or switch to Week or Month view.</p>
            )}
          </Card>

          {!isCalendarRangeValid ? (
            <Card className="p-4 bg-red-50 border-red-200 border">
              <p className="text-sm font-semibold text-red-800">Invalid date range</p>
              <p className="text-sm text-red-700 mt-1">The To date must be on or after the From date. Adjust one of the dates above to see the calendar.</p>
            </Card>
          ) : calendarRangeTooLarge ? (
            <Card className="p-4 bg-amber-50 border-amber-200 border">
              <p className="text-sm text-amber-800">
                This custom range is too large to display ({dateRangeLengthDays(calendarFrom, calendarTo)} days – the maximum is {MAX_CUSTOM_RANGE_DAYS}).
                Narrow the From/To dates above, or use Week or Month view.
              </p>
            </Card>
          ) : filteredEmployees.length === 0 ? (
            <EmptyState icon={UsersIcon} title="No employees match your search" description="Adjust the search above." />
          ) : (
            <Table>
              <THead>
                <TR hover={false}>
                  <TH className="sticky left-0 z-10 bg-[#F8FAFC]">Employee</TH>
                  {calendarDates.map((d) => (
                    <TH key={d}>{formatDayHeading(d)}</TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {filteredEmployees.slice(0, 100).map((emp) => (
                  <TR key={emp.id}>
                    <TD className="sticky left-0 z-10 bg-white font-medium text-slate-800">{emp.fullName}<span className="block text-xs text-slate-500 font-normal">{emp.employeeNumber}</span></TD>
                    {calendarDates.map((d) => {
                      const resolved = resolveScheduleForDate(emp.id, d, dateAssignments, patterns);
                      const color = resolved === 'off' ? 'gold' : resolved === 'day' ? 'navy' : resolved === 'night' ? 'blue' : 'gray';
                      return (
                        <TD key={d}>
                          <Badge color={color}>{resolved}</Badge>
                        </TD>
                      );
                    })}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {isCalendarRangeValid && !calendarRangeTooLarge && filteredEmployees.length > 100 && (
            <p className="text-xs text-slate-500">Showing the first 100 of {filteredEmployees.length} matching employees. Narrow your search to see the rest.</p>
          )}
        </div>
      ) : activeTab === 'off-pattern' ? (
        <Card className="p-5 space-y-4">
          <p className="text-sm text-slate-600">Select employees, then the weekday that should be their recurring Off day and the date it takes effect.</p>
          <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
            {filteredEmployees.map((emp) => (
              <label key={emp.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <input type="checkbox" checked={offPatternEmployeeIds.has(emp.id)} onChange={() => toggleInSet(offPatternEmployeeIds, setOffPatternEmployeeIds, emp.id)} />
                {emp.fullName} <span className="text-xs text-slate-500">{emp.employeeNumber}</span>
              </label>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Select label="Off weekday" value={offPatternWeekday} onChange={(e) => setOffPatternWeekday(e.target.value)} options={WEEKDAY_OPTIONS} />
            <Input label="Effective from" type="date" value={offPatternEffectiveFrom} onChange={(e) => setOffPatternEffectiveFrom(e.target.value)} />
          </div>
          <Input label="Reason (required only if this changes an existing pattern)" value={offPatternReason} onChange={(e) => setOffPatternReason(e.target.value)} placeholder="e.g. Operations requested change, see email 10/8" />
          <Button onClick={handleSubmitOffPattern} disabled={submitting || offPatternEmployeeIds.size === 0}>
            {submitting ? 'Saving...' : `Set Off Day for ${offPatternEmployeeIds.size} Employee(s)`}
          </Button>
        </Card>
      ) : activeTab === 'assign-dates' ? (
        <Card className="p-5 space-y-4">
          <p className="text-sm text-slate-600">Assign Day, Night, or a dated Off exception across a date range for one or more employees.</p>
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            A working assignment cannot be placed on a date an employee is already scheduled Off -- this is always blocked, with no override.
            To work a normally-Off date, use the <strong>Reschedule Off Day</strong> tab, which moves the Off day and assigns the vacated date atomically.
          </p>
          <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
            {filteredEmployees.map((emp) => (
              <label key={emp.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <input type="checkbox" checked={assignEmployeeIds.has(emp.id)} onChange={() => toggleInSet(assignEmployeeIds, setAssignEmployeeIds, emp.id)} />
                {emp.fullName} <span className="text-xs text-slate-500">{emp.employeeNumber}</span>
              </label>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input label="From" type="date" value={assignDateFrom} onChange={(e) => setAssignDateFrom(e.target.value)} />
            <Input label="To" type="date" value={assignDateTo} onChange={(e) => setAssignDateTo(e.target.value)} />
            <Select label="Assignment" value={assignType} onChange={(e) => setAssignType(e.target.value as AssignmentType)} options={ASSIGNMENT_TYPE_OPTIONS} />
          </div>
          <Input label="Reason (required for a change to an existing assignment)" value={assignReason} onChange={(e) => setAssignReason(e.target.value)} />
          <Button onClick={handleSubmitAssignDates} disabled={submitting || assignEmployeeIds.size === 0}>
            {submitting ? 'Saving...' : `Assign ${assignType} to ${assignEmployeeIds.size} Employee(s)`}
          </Button>
        </Card>
      ) : (
        <Card className="p-5 space-y-4">
          <p className="text-sm text-slate-600">
            Move one employee's Off day to a new date, optionally assigning explicit work on the date being vacated --
            both changes are validated and committed together.
          </p>
          <Select
            label="Employee"
            value={rescheduleEmployeeId}
            onChange={(e) => setRescheduleEmployeeId(e.target.value)}
            options={[{ label: 'Select an employee...', value: '' }, ...filteredEmployees.map((e) => ({ label: `${e.fullName} (${e.employeeNumber})`, value: e.id }))]}
          />
          <Input label="New Off date" type="date" value={rescheduleNewOffDate} onChange={(e) => setRescheduleNewOffDate(e.target.value)} />
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={rescheduleAssignVacated} onChange={(e) => setRescheduleAssignVacated(e.target.checked)} />
            Also assign work on the vacated date
          </label>
          {rescheduleAssignVacated && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input label="Vacated date" type="date" value={rescheduleVacatedDate} onChange={(e) => setRescheduleVacatedDate(e.target.value)} />
              <Select
                label="Assignment"
                value={rescheduleVacatedType}
                onChange={(e) => setRescheduleVacatedType(e.target.value as 'day' | 'night')}
                options={[{ label: 'Day shift', value: 'day' }, { label: 'Night shift', value: 'night' }]}
              />
            </div>
          )}
          <Input label="Reason (required)" value={rescheduleReason} onChange={(e) => setRescheduleReason(e.target.value)} placeholder="e.g. Operations requested swap for this week only" required />
          <Button onClick={handleSubmitReschedule} disabled={submitting || !rescheduleEmployeeId}>
            {submitting ? 'Saving...' : 'Reschedule Off Day'}
          </Button>
        </Card>
      )}
    </div>
  );
}
