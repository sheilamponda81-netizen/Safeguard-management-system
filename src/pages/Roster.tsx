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
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { CalendarDays, Search, Users as UsersIcon, RefreshCw, AlertTriangle, ChevronLeft, ChevronRight, X } from '../utils/icons';
import { Card, Button, Badge, PageHeader, EmptyState, Input, Select, Tabs, Table, THead, TBody, TR, TH, TD } from '../components/ui';
import { getCurrentProfile, UserProfile } from '../utils/currentProfile';
import { isBusinessAdmin } from '../utils/permissions';
import { showNotification } from '../utils/clickHandlers';
import {
  resolveScheduleForDate, expandDateRange, addDays, WEEKDAY_LABELS,
  ResolvedSchedule,
  resolveActiveShiftType, wouldOverrideRecurringOffDay,
  buildTemporaryReschedulePlan, buildPermanentWeekdayTransitionPlan, explainRollingRestConflict,
  summarizeWeekSchedule, describeWeekOffDays, formatFriendlyWeekdayDate,
  summarizeDateRangeAssignments, evaluateCancellationSafety, describeCancellationSafety,
  TemporaryRescheduleWeekPlan, PermanentWeekdayTransitionPlan, WeekScheduleSummary, DateAssignmentStatus,
  CancellationSafetyResult,
  AssignmentType, OffDayPatternRow, DateAssignmentRow, ShiftPatternRow,
} from '../utils/rosterSchedule';
import {
  CalendarViewMode, getBlantyreToday, startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  shiftCalendarRange, formatDayHeading, formatPeriodHeading, isValidDateRange, dateRangeLengthDays, MAX_CUSTOM_RANGE_DAYS,
} from '../utils/rosterCalendarNav';
import { EmployeeLite } from '../utils/hikcentralPersonMapping';
import {
  fetchActiveOffDayPatterns, fetchActiveShiftPatterns, fetchActiveDateAssignments, fetchActiveEmployeesForRoster,
  assignRecurringPattern, assignDates, cancelDateAssignments, applyWeekdayTransition, humanizeRosterError,
  filterEmployeesForSearch, formatEmployeeLabel, moveHighlightedIndex,
} from '../utils/rosterService';

/** Shared Calendar/preview color mapping -- one place for the resolved-state-to-Badge-color rule, so the Reschedule preview and the Calendar grid never drift apart. */
function scheduleBadgeColor(resolved: ResolvedSchedule): 'gold' | 'navy' | 'blue' | 'gray' {
  return resolved === 'off' ? 'gold' : resolved === 'day' ? 'navy' : resolved === 'night' ? 'blue' : 'gray';
}

// Phase 2B.2C: a reusable searchable single-employee selector for the
// Reschedule Off Day tab, replacing a plain <select> that was unusable
// once the employee list grows into the hundreds -- see this file's
// other three tabs for the equivalent multi-select search pattern
// (a local search Input above an unbounded checkbox list; a combobox
// needs its own component instead, since a native <select> cannot offer
// live type-ahead filtering). Its filtering and keyboard-navigation
// index math are the pure, independently-tested functions imported above
// (filterEmployeesForSearch, moveHighlightedIndex) -- this component is
// only the thin, untested-by-necessity wiring around them (this codebase
// has no component-test harness; see rosterMigrationSecurity.test.ts's
// own header for the established precedent).
const COMBOBOX_MAX_VISIBLE_RESULTS = 50;

function EmployeeSingleSelect({ employees, value, onChange, placeholder }: {
  employees: EmployeeLite[];
  value: string;
  onChange: (employeeId: string) => void;
  placeholder?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = employees.find((e) => e.id === value) || null;
  const matches = useMemo(() => filterEmployeesForSearch(employees, query), [employees, query]);
  const visibleMatches = matches.slice(0, COMBOBOX_MAX_VISIBLE_RESULTS);

  const openForSearch = () => {
    setQuery('');
    setHighlightedIndex(-1);
    setIsOpen(true);
  };

  const selectEmployee = (employeeId: string) => {
    onChange(employeeId);
    setQuery('');
    setHighlightedIndex(-1);
    setIsOpen(false);
  };

  const clearSelection = () => {
    onChange('');
    openForSearch();
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) { openForSearch(); return; }
      setHighlightedIndex((i) => moveHighlightedIndex(i, 1, visibleMatches.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) { openForSearch(); return; }
      setHighlightedIndex((i) => moveHighlightedIndex(i, -1, visibleMatches.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isOpen && highlightedIndex >= 0 && visibleMatches[highlightedIndex]) {
        selectEmployee(visibleMatches[highlightedIndex].id);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
      setHighlightedIndex(-1);
      setIsOpen(false);
    }
  };

  const displayValue = isOpen ? query : selected ? formatEmployeeLabel(selected) : '';

  return (
    <div className="relative">
      <label className="block text-sm font-medium text-slate-700 mb-1.5">Employee</label>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-autocomplete="list"
          value={displayValue}
          placeholder={placeholder || 'Search employee by name or number...'}
          onFocus={openForSearch}
          onChange={(e) => { setQuery(e.target.value); setHighlightedIndex(-1); setIsOpen(true); }}
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(() => setIsOpen(false), 150)}
          className="w-full pl-10 pr-9 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] focus:border-transparent outline-none bg-white"
        />
        {selected && !isOpen && (
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); clearSelection(); }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            aria-label="Clear selected employee"
            title="Clear selection"
          >
            <X size={16} />
          </button>
        )}
      </div>
      {isOpen && (
        <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg">
          {visibleMatches.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-500">No employees match your search.</p>
          ) : (
            <>
              {visibleMatches.map((emp, i) => (
                <button
                  type="button"
                  key={emp.id}
                  onMouseDown={(e) => { e.preventDefault(); selectEmployee(emp.id); }}
                  className={`w-full text-left px-3 py-2 text-sm ${i === highlightedIndex ? 'bg-[#081C3A] text-white' : emp.id === value ? 'bg-slate-100 text-slate-800' : 'text-slate-700 hover:bg-slate-50'}`}
                >
                  {emp.fullName} <span className={i === highlightedIndex ? 'text-slate-300' : 'text-slate-500'}>({emp.employeeNumber})</span>
                </button>
              ))}
              {matches.length > COMBOBOX_MAX_VISIBLE_RESULTS && (
                <p className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100">
                  Showing the first {COMBOBOX_MAX_VISIBLE_RESULTS} of {matches.length} matches. Keep typing to narrow further.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

type TabId = 'calendar' | 'off-pattern' | 'assign-dates' | 'reschedule';

const ASSIGNMENT_TYPE_OPTIONS = [
  { label: 'Day shift', value: 'day' },
  { label: 'Night shift', value: 'night' },
  { label: 'Off (dated exception)', value: 'off' },
];

const WEEKDAY_OPTIONS = WEEKDAY_LABELS.map((label, value) => ({ label, value: String(value) }));

// Stage C Step 6B: recurring Day/Night baseline options, for the
// extended Recurring Schedule tab's "Normal shift" selector.
const SHIFT_TYPE_OPTIONS = [
  { label: 'Day shift', value: 'day' },
  { label: 'Night shift', value: 'night' },
];

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
  const [shiftPatterns, setShiftPatterns] = useState<ShiftPatternRow[]>([]);
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
      const [emps, pats, shiftPats, assigns] = await Promise.all([
        fetchActiveEmployeesForRoster(),
        fetchActiveOffDayPatterns(),
        fetchActiveShiftPatterns(),
        shouldFetchAssignments
          ? fetchActiveDateAssignments(addDays(calendarFrom, -1), addDays(calendarTo, 1))
          : Promise.resolve([]),
      ]);
      setEmployees(emps);
      setPatterns(pats);
      setShiftPatterns(shiftPats);
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

  // Calendar's own employee filter -- unchanged behavior, still driven by
  // the page-level search above the tabs. The other three tabs each got
  // their own independent, tab-local search in Phase 2B.2C (below), so
  // that searching on one tab never changes what's selected or visible
  // on another, and selections never get silently cleared by a search
  // change on an unrelated tab.
  const filteredEmployees = useMemo(() => filterEmployeesForSearch(employees, employeeSearch), [employees, employeeSearch]);

  // --- Recurring Off Day: its own local search, decoupled from the page-level one above ---
  const [offPatternSearch, setOffPatternSearch] = useState('');
  const offPatternFilteredEmployees = useMemo(() => filterEmployeesForSearch(employees, offPatternSearch), [employees, offPatternSearch]);

  // --- Assign Dates: its own local search, decoupled from the page-level one above ---
  const [assignSearch, setAssignSearch] = useState('');
  const assignFilteredEmployees = useMemo(() => filterEmployeesForSearch(employees, assignSearch), [employees, assignSearch]);

  const calendarDates = useMemo(() => {
    if (!isCalendarRangeValid || calendarRangeTooLarge) return [];
    return expandDateRange(calendarFrom, calendarTo);
  }, [calendarFrom, calendarTo, isCalendarRangeValid, calendarRangeTooLarge]);

  const calendarPeriodHeading = useMemo(
    () => formatPeriodHeading(calendarViewMode, calendarFrom, calendarTo),
    [calendarViewMode, calendarFrom, calendarTo]
  );

  // --- Set recurring schedule form (Stage C Step 6B: Off day + Day/Night
  // baseline, saved together atomically or independently via the two
  // "Update..." checkboxes below) ---
  const [offPatternEmployeeIds, setOffPatternEmployeeIds] = useState<Set<string>>(new Set());
  const [offPatternUpdateOffDay, setOffPatternUpdateOffDay] = useState(true);
  const [offPatternWeekday, setOffPatternWeekday] = useState('0');
  const [offPatternUpdateShift, setOffPatternUpdateShift] = useState(true);
  const [offPatternShiftType, setOffPatternShiftType] = useState<'day' | 'night'>('day');
  const [offPatternEffectiveFrom, setOffPatternEffectiveFrom] = useState(defaults.today);
  const [offPatternReason, setOffPatternReason] = useState('');

  const handleSubmitRecurringPattern = useCallback(async () => {
    if (offPatternEmployeeIds.size === 0) {
      showNotification('Select at least one employee.', 'error');
      return;
    }
    if (!offPatternUpdateOffDay && !offPatternUpdateShift) {
      showNotification('Select at least one of weekly Off day or normal shift to update.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const result = await assignRecurringPattern(
        Array.from(offPatternEmployeeIds),
        {
          weekday: offPatternUpdateOffDay ? Number(offPatternWeekday) : undefined,
          shiftType: offPatternUpdateShift ? offPatternShiftType : undefined,
        },
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
        showNotification(humanizeRosterError(result.error || 'Could not save the recurring schedule.', employees), 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    offPatternEmployeeIds, offPatternUpdateOffDay, offPatternWeekday, offPatternUpdateShift, offPatternShiftType,
    offPatternEffectiveFrom, offPatternReason, employees, loadData,
  ]);

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
        showNotification(humanizeRosterError(result.error || 'Could not assign the selected dates.', employees), 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }, [assignEmployeeIds, assignDateFrom, assignDateTo, assignType, assignReason, employees, loadData]);

  // --- Stage C Step 13: Correct or Cancel a mistaken dated (special)
  // assignment for ONE employee over a date range -- a distinct mode
  // within this same tab from the bulk "assign new dates" form above.
  // "Cancel" reveals whatever the employee's underlying recurring
  // Off-day/shift pattern says for each date (Day, Night, Off, or
  // unassigned) by closing out the dated exception and writing NOTHING
  // in its place -- never forcing a specific value (see
  // roster_cancel_date_assignments' migration header for the full
  // reasoning). "Correct to Day/Night/Off" reuses the exact same
  // assignDates RPC the form above uses, scoped to one employee with a
  // before/after preview. A date with NO dated exception (its value
  // comes straight from the recurring pattern) is never touched by
  // either action -- changing a genuine recurring Off/working day
  // requires the Temporary/Permanent Off Day or Recurring Schedule tab
  // instead, exactly as this tab's existing amber warning already says.
  const [assignTabMode, setAssignTabMode] = useState<'new' | 'correct'>('new');
  const [correctEmployeeId, setCorrectEmployeeId] = useState('');
  const [correctDateFrom, setCorrectDateFrom] = useState(defaults.today);
  const [correctDateTo, setCorrectDateTo] = useState(defaults.today);
  const [correctAction, setCorrectAction] = useState<'cancel' | AssignmentType>('cancel');
  const [correctReason, setCorrectReason] = useState('');
  const [correctRangeAssignments, setCorrectRangeAssignments] = useState<DateAssignmentRow[]>([]);

  const correctSelectedEmployee = useMemo(
    () => employees.find((e) => e.id === correctEmployeeId) || null,
    [employees, correctEmployeeId]
  );

  const isCorrectRangeValid = isValidDateRange(correctDateFrom, correctDateTo);

  // Fetched independently of the Calendar tab's own visible range (the
  // same reasoning as Step 12E's rescheduleWeekAssignments) -- this tool
  // must never silently show stale or missing dated-exception data for
  // whatever range the administrator picks here.
  useEffect(() => {
    let cancelled = false;
    if (!correctEmployeeId || !isCorrectRangeValid) {
      setCorrectRangeAssignments([]);
      return;
    }
    fetchActiveDateAssignments(correctDateFrom, correctDateTo)
      .then((rows) => { if (!cancelled) setCorrectRangeAssignments(rows); })
      .catch(() => { if (!cancelled) setCorrectRangeAssignments([]); });
    return () => { cancelled = true; };
  }, [correctEmployeeId, correctDateFrom, correctDateTo, isCorrectRangeValid]);

  const correctSummary: DateAssignmentStatus[] = useMemo(() => {
    if (!correctEmployeeId || !isCorrectRangeValid) return [];
    return summarizeDateRangeAssignments(correctEmployeeId, correctDateFrom, correctDateTo, correctRangeAssignments, patterns, shiftPatterns);
  }, [correctEmployeeId, correctDateFrom, correctDateTo, isCorrectRangeValid, correctRangeAssignments, patterns, shiftPatterns]);

  const correctCancellableCount = useMemo(() => correctSummary.filter((d) => d.hasDatedException).length, [correctSummary]);

  // Per-date before/after preview, computed once and reused by both the
  // summary counts and the render -- never recomputed inline in JSX.
  const correctPreviewRows = useMemo(() => {
    return correctSummary.map((d) => {
      if (correctAction === 'cancel') {
        return { ...d, after: d.hasDatedException ? d.underlyingResolved : null, blocked: false };
      }
      const blocked = wouldOverrideRecurringOffDay(correctEmployeeId, d.date, correctAction, correctRangeAssignments, patterns, shiftPatterns);
      return { ...d, after: blocked ? null : correctAction, blocked };
    });
  }, [correctSummary, correctAction, correctEmployeeId, correctRangeAssignments, patterns, shiftPatterns]);

  const correctChangeableCount = useMemo(
    () => (correctAction === 'cancel' ? correctCancellableCount : correctPreviewRows.filter((r) => !r.blocked).length),
    [correctAction, correctCancellableCount, correctPreviewRows]
  );

  // Stage C Step 14: real STAGING finding (LUCIOUS LIGOMERA, SFG-S-469) --
  // cancelling a mistaken special Off across several dates can genuinely
  // leave no rest day in a rolling seven-day window (Malawi Employment
  // Act s.36(4)). The server (roster_cancel_date_assignments) already
  // hard-blocks this correctly with no override; this preview mirrors
  // that same check ADVISORY-only, so the Admin sees a plain, weekday-
  // phrased explanation and a concrete safe alternative BEFORE
  // submitting, instead of only a technical rejection afterward.
  const correctCancellationSafety: CancellationSafetyResult | null = useMemo(() => {
    if (correctAction !== 'cancel' || !correctEmployeeId || !isCorrectRangeValid || correctCancellableCount === 0) return null;
    return evaluateCancellationSafety(correctEmployeeId, correctDateFrom, correctDateTo, correctRangeAssignments, patterns, shiftPatterns);
  }, [correctAction, correctEmployeeId, isCorrectRangeValid, correctCancellableCount, correctDateFrom, correctDateTo, correctRangeAssignments, patterns, shiftPatterns]);

  const correctCancellationDescription = useMemo(() => {
    if (!correctCancellationSafety || !correctSelectedEmployee) return null;
    return describeCancellationSafety(correctSelectedEmployee.fullName, correctCancellationSafety);
  }, [correctCancellationSafety, correctSelectedEmployee]);

  const canSubmitCorrect =
    !!correctEmployeeId &&
    isCorrectRangeValid &&
    !!correctReason.trim() &&
    correctSummary.length > 0 &&
    correctChangeableCount > 0 &&
    (!correctCancellationSafety || correctCancellationSafety.safe);

  const handleSubmitCorrect = useCallback(async () => {
    if (!canSubmitCorrect) {
      showNotification('Select an employee, a valid date range, and a reason -- and make sure at least one date in range can actually be changed without an unresolved rest conflict.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const result = correctAction === 'cancel'
        ? await cancelDateAssignments([correctEmployeeId], correctDateFrom, correctDateTo, correctReason)
        : await assignDates([correctEmployeeId], correctDateFrom, correctDateTo, correctAction, correctReason);
      if (result.success) {
        showNotification(
          correctAction === 'cancel'
            ? `Cancelled ${result.assignedCount} special assignment(s).${result.alreadySetCount ? ` ${result.alreadySetCount} date(s) had nothing to cancel.` : ''} The employee's normal recurring schedule now applies for those dates.`
            : `Corrected ${result.assignedCount} date(s).${result.alreadySetCount ? ` ${result.alreadySetCount} already set.` : ''}`,
          'success'
        );
        setCorrectReason('');
        await loadData();
      } else {
        const rawMessage = result.error || 'Could not apply this correction.';
        const explanation = correctEmployeeId
          ? explainRollingRestConflict(rawMessage, correctEmployeeId, correctRangeAssignments, patterns, shiftPatterns)
          : null;
        showNotification(
          explanation
            ? `${humanizeRosterError(rawMessage, employees)} ${explanation.summary}`
            : humanizeRosterError(rawMessage, employees),
          'error'
        );
      }
    } finally {
      setSubmitting(false);
    }
  }, [canSubmitCorrect, correctAction, correctEmployeeId, correctDateFrom, correctDateTo, correctReason, correctRangeAssignments, patterns, shiftPatterns, employees, loadData]);

  // --- Stage C Step 12: Temporary / Permanent Off-day change, expressed
  // in the weekday vocabulary administrators actually think in ("Wednesday
  // Off -> Sunday Off for three weeks") instead of requiring two exact
  // calendar dates to be typed in. Safeguard computes every actual date
  // automatically.
  //
  // Stage C Step 12A CHANGE: the write path is now ONE atomic RPC call
  // (roster_apply_weekday_transition) covering every affected week (plus
  // the one "bridge" week/date the rolling-seven-day rest rule sometimes
  // requires -- see rosterSchedule.ts's buildTemporaryReschedulePlan and
  // buildPermanentWeekdayTransitionPlan headers for the full proof) --
  // never a per-week loop calling roster_reschedule_off_day, which risked
  // a partial, some-weeks-changed-others-not outcome on a mid-sequence
  // rejection. The bridge day, when one is needed, is always shown in the
  // preview and requires an explicit confirmation checkbox before
  // submission is enabled -- Safeguard never silently keeps an extra Off
  // day (or, equally, never silently removes one) without the
  // administrator seeing exactly which date and why.
  const [rescheduleEmployeeId, setRescheduleEmployeeId] = useState('');
  const [rescheduleWeekAnchor, setRescheduleWeekAnchor] = useState(defaults.today);
  const [rescheduleOriginalWeekday, setRescheduleOriginalWeekday] = useState('3');
  const [rescheduleNewWeekday, setRescheduleNewWeekday] = useState('0');
  const [rescheduleShift, setRescheduleShift] = useState<'day' | 'night'>('day');
  const [rescheduleDurationMode, setRescheduleDurationMode] = useState<'1' | '2' | '3' | 'custom'>('1');
  const [rescheduleCustomWeeks, setRescheduleCustomWeeks] = useState('4');
  const [rescheduleIsPermanent, setRescheduleIsPermanent] = useState(false);
  const [rescheduleReason, setRescheduleReason] = useState('');
  const [rescheduleBridgeAcknowledged, setRescheduleBridgeAcknowledged] = useState(false);
  // Stage C Step 12E: set only once the administrator has explicitly
  // picked which Off day to reschedule, for the (uncommon) case where a
  // week genuinely has more than one -- reset whenever the employee or
  // selected week changes, so a stale pick from a DIFFERENT week can
  // never silently carry over.
  const [rescheduleMultiOffChoiceMade, setRescheduleMultiOffChoiceMade] = useState(false);
  const [rescheduleWeekAssignments, setRescheduleWeekAssignments] = useState<DateAssignmentRow[]>([]);

  const rescheduleSelectedEmployee = useMemo(
    () => employees.find((e) => e.id === rescheduleEmployeeId) || null,
    [employees, rescheduleEmployeeId]
  );

  const MAX_TEMPORARY_RESCHEDULE_WEEKS = 52;
  const rescheduleDurationWeeks =
    rescheduleDurationMode === 'custom' ? Number(rescheduleCustomWeeks) || 0 : Number(rescheduleDurationMode);
  const rescheduleWeekStart = rescheduleWeekAnchor ? startOfWeek(rescheduleWeekAnchor) : '';
  const rescheduleOriginalWeekdayNum = Number(rescheduleOriginalWeekday);
  const rescheduleNewWeekdayNum = Number(rescheduleNewWeekday);
  const rescheduleSameWeekday = rescheduleOriginalWeekdayNum === rescheduleNewWeekdayNum;

  // Stage C Step 12E: the Reschedule tab's selected week is independent
  // of the Calendar tab's own visible range (an administrator can pick
  // ANY week here without first navigating the Calendar to it) -- the
  // Calendar-bound `dateAssignments` state can therefore be missing
  // dated exceptions for this exact week. Fetched separately, scoped
  // exactly to the selected week (+/-1 day, matching loadData's own
  // adjacency buffer), so "what is this employee's actual Off day this
  // week" is always answered from real, complete data -- never a silent
  // gap -- and stays consistent with what the Calendar tab shows for the
  // same week once navigated there (both ultimately call
  // resolveScheduleForDate/roster_resolve_schedule).
  useEffect(() => {
    let cancelled = false;
    if (!rescheduleEmployeeId || !rescheduleWeekStart) {
      setRescheduleWeekAssignments([]);
      return;
    }
    fetchActiveDateAssignments(addDays(rescheduleWeekStart, -1), addDays(rescheduleWeekStart, 7))
      .then((rows) => { if (!cancelled) setRescheduleWeekAssignments(rows); })
      .catch(() => { if (!cancelled) setRescheduleWeekAssignments([]); });
    return () => { cancelled = true; };
  }, [rescheduleEmployeeId, rescheduleWeekStart]);

  // Stage C Step 12E: what does this employee's schedule ACTUALLY
  // resolve to for the selected week -- using the exact same resolver
  // the Calendar tab uses (resolveScheduleForDate), never a guess
  // anchored to today's date. This replaced the old "auto-detect from
  // today's recurring pattern" effect, which was the real root cause of
  // a live STAGING usability report: the Reschedule tab defaulted to an
  // employee's recurring Wednesday Off even though a dated exception
  // made that week's actual Off day Friday (which the Calendar tab,
  // already using this same resolver, correctly showed) -- not a
  // resolver bug, a wrong question being asked client-side.
  const weekSummary: WeekScheduleSummary | null = useMemo(() => {
    if (!rescheduleEmployeeId || !rescheduleWeekStart) return null;
    return summarizeWeekSchedule(rescheduleEmployeeId, rescheduleWeekStart, rescheduleWeekAssignments, patterns, shiftPatterns);
  }, [rescheduleEmployeeId, rescheduleWeekStart, rescheduleWeekAssignments, patterns, shiftPatterns]);

  const rescheduleWeekOffDayText = useMemo(() => {
    if (!weekSummary || !rescheduleSelectedEmployee) return null;
    return describeWeekOffDays(rescheduleSelectedEmployee.fullName, weekSummary);
  }, [weekSummary, rescheduleSelectedEmployee]);

  // Auto-select the Original Off weekday ONLY when the week has exactly
  // one genuine Off day -- per confirmed policy, never invented when
  // there are zero, and never guessed when there is more than one (the
  // administrator must explicitly choose, see rescheduleMultiOffChoiceMade
  // below). Still freely overridable afterward, e.g. to correct a
  // data-entry mistake. The normal shift is detected from the same week,
  // not today, so it reflects what is actually true for the week being
  // rescheduled.
  useEffect(() => {
    setRescheduleMultiOffChoiceMade(false);
    if (!weekSummary || weekSummary.actualOffDays.length !== 1) return;
    setRescheduleOriginalWeekday(String(weekSummary.actualOffDays[0].weekdayJs));
  }, [weekSummary]);

  useEffect(() => {
    if (!rescheduleEmployeeId || !rescheduleWeekStart) return;
    const detectedShift = resolveActiveShiftType(rescheduleEmployeeId, rescheduleWeekStart, shiftPatterns);
    if (detectedShift !== null) setRescheduleShift(detectedShift);
  }, [rescheduleEmployeeId, rescheduleWeekStart, shiftPatterns]);

  // Advisory preview only (one entry per affected week in Temporary mode,
  // a single bridge-aware summary for Permanent mode) -- see
  // buildRescheduleOffDayPreview's own header. The database independently
  // re-verifies everything, including the rolling seven-day rest rule,
  // which this preview deliberately does not replicate -- EXCEPT the
  // bridge-day calculation itself (Stage C Step 12A), which IS mirrored
  // here exactly (see rosterSchedule.ts's bridgeWeekIndex /
  // buildPermanentWeekdayTransitionPlan headers for the proof), purely
  // so the administrator sees the additional Off day in advance and can
  // explicitly confirm it -- the server independently recomputes and
  // applies the same bridge, never trusting this preview's result. Uses
  // rescheduleWeekAssignments (Step 12E), not the Calendar-bound
  // dateAssignments, so this preview is correct regardless of what week
  // the Calendar tab currently happens to be showing.
  const reschedulePlan: TemporaryRescheduleWeekPlan[] = useMemo(() => {
    if (!rescheduleEmployeeId || !rescheduleWeekStart || rescheduleSameWeekday || rescheduleIsPermanent) return [];
    if (!rescheduleDurationWeeks || rescheduleDurationWeeks < 1) return [];
    return buildTemporaryReschedulePlan(
      rescheduleEmployeeId, rescheduleWeekStart, rescheduleOriginalWeekdayNum, rescheduleNewWeekdayNum,
      rescheduleDurationWeeks, rescheduleShift, rescheduleWeekAssignments, patterns, shiftPatterns
    );
  }, [
    rescheduleEmployeeId, rescheduleWeekStart, rescheduleSameWeekday, rescheduleIsPermanent, rescheduleDurationWeeks,
    rescheduleOriginalWeekdayNum, rescheduleNewWeekdayNum, rescheduleShift, rescheduleWeekAssignments, patterns, shiftPatterns,
  ]);

  const permanentPlan: PermanentWeekdayTransitionPlan | null = useMemo(() => {
    if (!rescheduleEmployeeId || !rescheduleWeekStart || rescheduleSameWeekday || !rescheduleIsPermanent) return null;
    return buildPermanentWeekdayTransitionPlan(
      rescheduleEmployeeId, rescheduleWeekStart, rescheduleOriginalWeekdayNum, rescheduleNewWeekdayNum,
      rescheduleWeekAssignments, patterns, shiftPatterns
    );
  }, [
    rescheduleEmployeeId, rescheduleWeekStart, rescheduleSameWeekday, rescheduleIsPermanent,
    rescheduleOriginalWeekdayNum, rescheduleNewWeekdayNum, rescheduleWeekAssignments, patterns, shiftPatterns,
  ]);

  // The single date (if any) that must stay an additional Off day to
  // bridge the transition -- unified across both modes so one
  // confirmation checkbox covers either case.
  const rescheduleBridgeDate: string | null = rescheduleIsPermanent
    ? permanentPlan?.bridgeDate ?? null
    : reschedulePlan.find((w) => w.isBridgeWeek)?.originalDate ?? null;

  // A stale confirmation from a DIFFERENT plan (e.g. after changing the
  // employee or weekdays) must never silently carry over.
  useEffect(() => {
    setRescheduleBridgeAcknowledged(false);
  }, [rescheduleBridgeDate]);

  const canSubmitReschedule =
    !!rescheduleEmployeeId &&
    !!rescheduleWeekStart &&
    !rescheduleSameWeekday &&
    !!rescheduleReason.trim() &&
    rescheduleDurationWeeks >= 1 &&
    rescheduleDurationWeeks <= MAX_TEMPORARY_RESCHEDULE_WEEKS &&
    (rescheduleIsPermanent ? !!permanentPlan : reschedulePlan.length > 0) &&
    (rescheduleIsPermanent || reschedulePlan.every((w) => !w.preview.blockingReason)) &&
    (!rescheduleBridgeDate || rescheduleBridgeAcknowledged) &&
    (!weekSummary || weekSummary.actualOffDays.length <= 1 || rescheduleMultiOffChoiceMade);

  const handleSubmitReschedule = useCallback(async () => {
    if (!canSubmitReschedule) {
      showNotification('Complete all required fields, resolve every issue shown in the preview, and confirm any additional Off day before submitting.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const result = await applyWeekdayTransition(
        rescheduleEmployeeId,
        rescheduleIsPermanent ? 'permanent' : 'temporary',
        rescheduleOriginalWeekdayNum,
        rescheduleNewWeekdayNum,
        rescheduleShift,
        rescheduleWeekStart,
        rescheduleIsPermanent ? 1 : rescheduleDurationWeeks,
        rescheduleReason
      );
      if (result.success) {
        const bridgeNote = result.bridgeDate
          ? ` ${WEEKDAY_LABELS[rescheduleOriginalWeekdayNum]} ${result.bridgeDate} was kept as an additional Off day to preserve the mandatory rolling seven-day rest requirement during the transition.`
          : '';
        const message = rescheduleIsPermanent
          ? `Permanent Off-day change saved: ${WEEKDAY_LABELS[rescheduleNewWeekdayNum]} is now the recurring Off day from ${rescheduleWeekStart}.${bridgeNote}`
          : `Rescheduled ${result.weeksApplied ?? rescheduleDurationWeeks} week(s) successfully. The Off day automatically returns to normal afterward -- no further action needed.${bridgeNote}`;
        showNotification(message, 'success');
        setRescheduleReason('');
        setRescheduleBridgeAcknowledged(false);
        await loadData();
      } else {
        const rawMessage = result.error || 'Could not apply this weekday transition.';
        const explanation = explainRollingRestConflict(rawMessage, rescheduleEmployeeId, dateAssignments, patterns, shiftPatterns);
        const humanized = humanizeRosterError(rawMessage, employees);
        const fullMessage = explanation
          ? `${humanized} ${explanation.summary}`
          : humanized;
        showNotification(fullMessage, 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmitReschedule, rescheduleEmployeeId, rescheduleIsPermanent, rescheduleOriginalWeekdayNum, rescheduleNewWeekdayNum,
    rescheduleShift, rescheduleWeekStart, rescheduleDurationWeeks, rescheduleReason, dateAssignments, patterns, shiftPatterns,
    employees, loadData,
  ]);

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
          { id: 'off-pattern', label: 'Recurring Schedule', icon: UsersIcon },
          { id: 'assign-dates', label: 'Assign Dates', icon: CalendarDays },
          { id: 'reschedule', label: 'Temporary / Permanent Off Day', icon: AlertTriangle },
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
            <>
              <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                "Off" alone is the employee's <strong>normal recurring</strong> weekly Off day. "Off (special)" is a one-off dated
                exception made in Assign Dates / Correct-Cancel -- it never changes the recurring pattern, which resumes once the
                exception is cancelled. "Unassigned" means no schedule has been set for that date at all -- it is never shown as
                Day or Off. Approved Leave and Sick Leave are tracked separately in the Attendance module and are intentionally
                not duplicated on this roster calendar, to avoid two different places disagreeing about an employee's status.
              </p>
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
                        const resolved = resolveScheduleForDate(emp.id, d, dateAssignments, patterns, shiftPatterns);
                        const color = scheduleBadgeColor(resolved);
                        // Stage C Step 6B/14: a dated row for this exact
                        // (employee, date) means the Calendar is showing an
                        // explicit, one-off exception, not a recurring-rule
                        // result. Labeled in text ("(special)"), not only a
                        // dot, so Normal recurring Off and Special dated Off
                        // are never visually indistinguishable at a glance.
                        const isExplicitException = dateAssignments.some(
                          (a) => a.employeeId === emp.id && a.assignmentDate === d && a.isActive
                        );
                        return (
                          <TD key={d}>
                            <span title={isExplicitException ? 'One-off dated exception -- the recurring pattern resumes once this is cancelled' : 'From the normal recurring pattern'}>
                              <Badge color={color}>
                                {resolved}{isExplicitException ? ' (special)' : ''}
                              </Badge>
                            </span>
                          </TD>
                        );
                      })}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </>
          )}
          {isCalendarRangeValid && !calendarRangeTooLarge && filteredEmployees.length > 100 && (
            <p className="text-xs text-slate-500">Showing the first 100 of {filteredEmployees.length} matching employees. Narrow your search to see the rest.</p>
          )}
        </div>
      ) : activeTab === 'off-pattern' ? (
        <Card className="p-5 space-y-4">
          <div>
            <p className="text-sm text-slate-600">
              Set an employee's normal recurring shift and/or weekly Off day once -- the schedule repeats automatically every
              week from the effective date <strong>until changed</strong>, with no need to re-assign it. This is also how to make
              a <strong>permanent</strong> weekday change (e.g. moving the Off day from Wednesday to Sunday for good) -- the
              Temporary / Permanent Off Day tab offers the identical permanent action in weekday-swap language, for convenience.
              For a time-limited change that should revert automatically, use that tab's Temporary option instead. An explicit
              dated assignment (Assign Dates tab) always overrides this for that one date only.
            </p>
          </div>
          <Input icon={Search} placeholder="Search employee by name or number..." value={offPatternSearch} onChange={(e) => setOffPatternSearch(e.target.value)} />
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{offPatternFilteredEmployees.length} of {employees.length} employee(s) shown</span>
            <span className="font-medium text-slate-700">{offPatternEmployeeIds.size} selected</span>
          </div>
          {offPatternFilteredEmployees.length === 0 ? (
            <EmptyState icon={UsersIcon} title="No employees match your search" description="Adjust the search above. Any employees already selected remain selected." />
          ) : (
            <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
              {offPatternFilteredEmployees.map((emp) => (
                <label key={emp.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <input type="checkbox" checked={offPatternEmployeeIds.has(emp.id)} onChange={() => toggleInSet(offPatternEmployeeIds, setOffPatternEmployeeIds, emp.id)} />
                  {emp.fullName} <span className="text-xs text-slate-500">{emp.employeeNumber}</span>
                </label>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <input type="checkbox" checked={offPatternUpdateShift} onChange={(e) => setOffPatternUpdateShift(e.target.checked)} />
                Normal shift
              </label>
              <Select
                value={offPatternShiftType}
                onChange={(e) => setOffPatternShiftType(e.target.value as 'day' | 'night')}
                options={SHIFT_TYPE_OPTIONS}
                disabled={!offPatternUpdateShift}
              />
            </div>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <input type="checkbox" checked={offPatternUpdateOffDay} onChange={(e) => setOffPatternUpdateOffDay(e.target.checked)} />
                Weekly Off
              </label>
              <Select
                value={offPatternWeekday}
                onChange={(e) => setOffPatternWeekday(e.target.value)}
                options={WEEKDAY_OPTIONS}
                disabled={!offPatternUpdateOffDay}
              />
            </div>
          </div>
          <Input label="Effective from" type="date" value={offPatternEffectiveFrom} onChange={(e) => setOffPatternEffectiveFrom(e.target.value)} />
          <p className="text-xs text-slate-500">Duration: Until changed -- this schedule repeats every week indefinitely, with no end date, until a new pattern replaces it.</p>
          <Input label="Reason (required only if this changes an existing pattern)" value={offPatternReason} onChange={(e) => setOffPatternReason(e.target.value)} placeholder="e.g. Operations requested change, see email 10/8" />
          <Button onClick={handleSubmitRecurringPattern} disabled={submitting || offPatternEmployeeIds.size === 0 || (!offPatternUpdateOffDay && !offPatternUpdateShift)}>
            {submitting ? 'Saving...' : `Save Recurring Pattern for ${offPatternEmployeeIds.size} Employee(s)`}
          </Button>
        </Card>
      ) : activeTab === 'assign-dates' ? (
        <Card className="p-5 space-y-4">
          <p className="text-sm text-slate-600">Assign Day, Night, or a dated Off exception across a date range for one or more employees.</p>
          <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
            Use this tab only for genuinely <strong>exceptional, one-off dated</strong> shifts -- a single public holiday, a one-time
            special assignment, a specific day that needs correcting. It is <strong>not</strong> for normal repeating weekly schedules
            (use the <strong>Recurring Schedule</strong> tab) or for moving an Off day, temporarily or permanently
            (use the <strong>Temporary / Permanent Off Day</strong> tab) -- those tabs compute the right dates automatically and keep
            the rolling seven-day rest rule and historical schedules intact in ways a plain dated assignment does not.
          </p>
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            A working assignment cannot be placed on a date an employee is already scheduled Off -- this is always blocked, with no override.
            To work a normally-Off date, use the <strong>Temporary / Permanent Off Day</strong> tab, which moves the Off day and assigns the vacated date atomically.
          </p>

          <div className="flex items-center gap-4 rounded-lg border border-slate-200 p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="radio" name="assign-dates-mode" checked={assignTabMode === 'new'} onChange={() => setAssignTabMode('new')} />
              Assign New Dates
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="radio" name="assign-dates-mode" checked={assignTabMode === 'correct'} onChange={() => setAssignTabMode('correct')} />
              Correct / Cancel Special Assignment
            </label>
          </div>

          {assignTabMode === 'new' ? (
            <>
              <Input icon={Search} placeholder="Search employee by name or number..." value={assignSearch} onChange={(e) => setAssignSearch(e.target.value)} />
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{assignFilteredEmployees.length} of {employees.length} employee(s) shown</span>
                <span className="font-medium text-slate-700">{assignEmployeeIds.size} selected</span>
              </div>
              {assignFilteredEmployees.length === 0 ? (
                <EmptyState icon={UsersIcon} title="No employees match your search" description="Adjust the search above. Any employees already selected remain selected." />
              ) : (
                <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                  {assignFilteredEmployees.map((emp) => (
                    <label key={emp.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <input type="checkbox" checked={assignEmployeeIds.has(emp.id)} onChange={() => toggleInSet(assignEmployeeIds, setAssignEmployeeIds, emp.id)} />
                      {emp.fullName} <span className="text-xs text-slate-500">{emp.employeeNumber}</span>
                    </label>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Input label="From" type="date" value={assignDateFrom} onChange={(e) => setAssignDateFrom(e.target.value)} />
                <Input label="To" type="date" value={assignDateTo} onChange={(e) => setAssignDateTo(e.target.value)} />
                <Select label="Assignment" value={assignType} onChange={(e) => setAssignType(e.target.value as AssignmentType)} options={ASSIGNMENT_TYPE_OPTIONS} />
              </div>
              <Input label="Reason (required for a change to an existing assignment)" value={assignReason} onChange={(e) => setAssignReason(e.target.value)} />
              <Button onClick={handleSubmitAssignDates} disabled={submitting || assignEmployeeIds.size === 0}>
                {submitting ? 'Saving...' : `Assign ${assignType} to ${assignEmployeeIds.size} Employee(s)`}
              </Button>
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                Undo or fix a mistaken one-off Day, Night, or Off assignment for <strong>one employee</strong> -- e.g. a special Off
                accidentally applied across a whole week. <strong>Cancel</strong> restores the employee's normal recurring schedule for
                each affected date (never forcing Day -- it reveals whatever that date's real underlying pattern says). This only ever
                changes <strong>roster</strong> scheduling -- it never touches attendance records, approved Leave or Sick Leave, and
                never changes payroll.
              </p>

              <EmployeeSingleSelect employees={employees} value={correctEmployeeId} onChange={setCorrectEmployeeId} />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Input label="From" type="date" value={correctDateFrom} onChange={(e) => setCorrectDateFrom(e.target.value)} />
                <Input label="To" type="date" value={correctDateTo} onChange={(e) => setCorrectDateTo(e.target.value)} />
              </div>
              {!isCorrectRangeValid && (
                <p className="text-xs text-red-600">The To date must be on or after the From date.</p>
              )}

              {correctSelectedEmployee && correctSummary.length > 0 && (
                <Card className="p-4 space-y-2 bg-slate-50 border border-slate-200">
                  <p className="text-sm font-semibold text-slate-800">
                    {correctSelectedEmployee.fullName}'s schedule, {correctDateFrom} to {correctDateTo}
                  </p>
                  <div className="space-y-1.5 max-h-56 overflow-y-auto">
                    {correctSummary.map((d) => (
                      <div key={d.date} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
                        <span>{formatFriendlyWeekdayDate(d.date)}</span>
                        <div className="flex items-center gap-2">
                          <Badge color={scheduleBadgeColor(d.resolved)}>{d.resolved}</Badge>
                          <span className="text-xs text-slate-500">{d.hasDatedException ? 'Special (dated)' : 'Recurring'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500">
                    {correctCancellableCount} of {correctSummary.length} date(s) have a special dated assignment that can be corrected or
                    cancelled here. Dates marked "Recurring" are the employee's normal weekly pattern -- protected here; use
                    Temporary / Permanent Off Day or Recurring Schedule to change those instead.
                  </p>
                </Card>
              )}

              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-slate-700">Action</label>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 text-sm text-slate-700">
                    <input type="radio" name="correct-action" checked={correctAction === 'cancel'} onChange={() => setCorrectAction('cancel')} />
                    Cancel (restore normal recurring schedule)
                  </label>
                  {(['day', 'night', 'off'] as const).map((t) => (
                    <label key={t} className="flex items-center gap-1.5 text-sm text-slate-700">
                      <input type="radio" name="correct-action" checked={correctAction === t} onChange={() => setCorrectAction(t)} />
                      Correct to {t}
                    </label>
                  ))}
                </div>
              </div>

              {correctSelectedEmployee && correctPreviewRows.length > 0 && (
                <Card className="p-4 space-y-2 bg-blue-50 border border-blue-200">
                  <p className="text-sm font-semibold text-blue-900">Preview</p>
                  <div className="space-y-1.5 max-h-56 overflow-y-auto">
                    {correctPreviewRows.map((row) => {
                      if (correctAction === 'cancel' && !row.hasDatedException) {
                        return (
                          <div key={row.date} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500">
                            <span>{formatFriendlyWeekdayDate(row.date)}</span>
                            <span>No special assignment -- protected, nothing to cancel</span>
                          </div>
                        );
                      }
                      return (
                        <div key={row.date} className={`flex items-center justify-between rounded-lg border px-3 py-1.5 text-sm ${row.blocked ? 'bg-red-50 border-red-200' : 'bg-white border-blue-200'}`}>
                          <span>{formatFriendlyWeekdayDate(row.date)}</span>
                          <div className="flex items-center gap-2">
                            <Badge color={scheduleBadgeColor(row.resolved)}>{row.resolved}</Badge>
                            <span>→</span>
                            {row.blocked || row.after === null ? (
                              <span className="text-xs text-red-700 flex items-center gap-1"><AlertTriangle size={12} /> blocked -- already Off</span>
                            ) : (
                              <Badge color={scheduleBadgeColor(row.after)}>{row.after}</Badge>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}

              {correctCancellationDescription && (
                <Card className="p-4 space-y-2 bg-red-50 border border-red-200">
                  <p className="text-sm font-semibold text-red-800 flex items-center gap-1.5"><AlertTriangle size={14} /> This would leave no rest day</p>
                  <p className="text-sm text-red-700">{correctCancellationDescription.primary}</p>
                  {correctCancellationDescription.suggestion && (
                    <p className="text-sm text-red-700">{correctCancellationDescription.suggestion}</p>
                  )}
                </Card>
              )}

              <Input
                label="Correction reason (required)"
                value={correctReason}
                onChange={(e) => setCorrectReason(e.target.value)}
                placeholder="e.g. Special Off was applied by mistake"
                required
              />
              <Button onClick={handleSubmitCorrect} disabled={submitting || !canSubmitCorrect}>
                {submitting
                  ? 'Saving...'
                  : correctAction === 'cancel'
                    ? `Cancel ${correctChangeableCount} Special Assignment(s)`
                    : `Correct to ${correctAction} (${correctChangeableCount} date(s))`}
              </Button>
            </div>
          )}
        </Card>
      ) : (
        <Card className="p-5 space-y-4">
          <p className="text-sm text-slate-600">
            Change an employee's weekly Off day by <strong>weekday</strong>, not by calculating calendar dates yourself --
            e.g. "Wednesday Off → Sunday Off for three weeks." Safeguard works out every actual date automatically. Choose{' '}
            <strong>Temporary</strong> for a time-limited change that reverts to the normal Off day by itself once the
            duration ends (no further action needed), or <strong>Permanent</strong> to change the recurring pattern itself
            from the selected week onward (equivalent to the Recurring Schedule tab's Off-day half, offered here too for
            convenience). Historical schedules before the effective date are never silently modified either way.
          </p>

          <EmployeeSingleSelect employees={employees} value={rescheduleEmployeeId} onChange={setRescheduleEmployeeId} />

          <div className="flex items-center gap-4 rounded-lg border border-slate-200 p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="radio" name="reschedule-mode" checked={!rescheduleIsPermanent} onChange={() => setRescheduleIsPermanent(false)} />
              Temporary
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="radio" name="reschedule-mode" checked={rescheduleIsPermanent} onChange={() => setRescheduleIsPermanent(true)} />
              Permanent
            </label>
          </div>

          <Input
            label="Week containing (pick any date in the week the change should start)"
            type="date"
            value={rescheduleWeekAnchor}
            onChange={(e) => setRescheduleWeekAnchor(e.target.value)}
            required
          />
          {rescheduleWeekStart && (
            <p className="text-xs text-slate-500">
              That falls in the week of <strong>{rescheduleWeekStart}</strong> (Monday) to <strong>{addDays(rescheduleWeekStart, 6)}</strong> (Sunday).
            </p>
          )}

          {rescheduleSelectedEmployee && weekSummary && rescheduleWeekOffDayText && (
            <Card className="p-3 space-y-2 bg-blue-50 border border-blue-200">
              <p className="text-sm text-blue-900">{rescheduleWeekOffDayText.primary}</p>
              {rescheduleWeekOffDayText.secondary && (
                <p className="text-xs text-blue-800">{rescheduleWeekOffDayText.secondary}</p>
              )}
              {weekSummary.actualOffDays.length > 1 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-blue-900">Choose which Off day to reschedule:</p>
                  <div className="flex flex-wrap gap-2">
                    {weekSummary.actualOffDays.map((off) => (
                      <button
                        key={off.date}
                        type="button"
                        onClick={() => {
                          setRescheduleOriginalWeekday(String(off.weekdayJs));
                          setRescheduleMultiOffChoiceMade(true);
                        }}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                          rescheduleMultiOffChoiceMade && rescheduleOriginalWeekdayNum === off.weekdayJs
                            ? 'bg-blue-600 border-blue-600 text-white'
                            : 'bg-white border-blue-300 text-blue-900'
                        }`}
                      >
                        {formatFriendlyWeekdayDate(off.date)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Select
              label="Original Off weekday (required)"
              value={rescheduleOriginalWeekday}
              onChange={(e) => setRescheduleOriginalWeekday(e.target.value)}
              options={WEEKDAY_OPTIONS}
            />
            <Select
              label="New Off weekday (required)"
              value={rescheduleNewWeekday}
              onChange={(e) => setRescheduleNewWeekday(e.target.value)}
              options={WEEKDAY_OPTIONS}
            />
          </div>
          {rescheduleSameWeekday && (
            <p className="text-xs text-red-600">The original and new Off weekday must be different.</p>
          )}

          <Select
            label="Normal shift on the vacated weekday (required)"
            value={rescheduleShift}
            onChange={(e) => setRescheduleShift(e.target.value as 'day' | 'night')}
            options={[{ label: 'Day shift', value: 'day' }, { label: 'Night shift', value: 'night' }]}
          />

          {!rescheduleIsPermanent && (
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">Duration</label>
              <div className="flex flex-wrap items-center gap-3">
                {(['1', '2', '3'] as const).map((n) => (
                  <label key={n} className="flex items-center gap-1.5 text-sm text-slate-700">
                    <input type="radio" name="reschedule-duration" checked={rescheduleDurationMode === n} onChange={() => setRescheduleDurationMode(n)} />
                    {n} week{n === '1' ? '' : 's'}
                  </label>
                ))}
                <label className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input type="radio" name="reschedule-duration" checked={rescheduleDurationMode === 'custom'} onChange={() => setRescheduleDurationMode('custom')} />
                  Custom:
                  <input
                    type="number"
                    min={1}
                    max={MAX_TEMPORARY_RESCHEDULE_WEEKS}
                    value={rescheduleCustomWeeks}
                    disabled={rescheduleDurationMode !== 'custom'}
                    onChange={(e) => setRescheduleCustomWeeks(e.target.value)}
                    className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-sm disabled:opacity-50"
                  />
                  week(s)
                </label>
              </div>
              <p className="text-xs text-slate-500">
                After {rescheduleDurationWeeks || '?'} week{rescheduleDurationWeeks === 1 ? '' : 's'}, {rescheduleOriginalWeekday !== '' ? WEEKDAY_LABELS[rescheduleOriginalWeekdayNum] : 'the original weekday'} automatically becomes the normal Off day again -- nothing further to do.
              </p>
            </div>
          )}

          <Input
            label="Reason (required)"
            value={rescheduleReason}
            onChange={(e) => setRescheduleReason(e.target.value)}
            placeholder={rescheduleIsPermanent ? 'e.g. Site reassignment, permanent schedule change' : 'e.g. Operations requested swap for these weeks'}
            required
          />

          {rescheduleSelectedEmployee && (rescheduleIsPermanent ? !!permanentPlan : reschedulePlan.length > 0) && (
            <Card className="p-4 space-y-3 bg-slate-50 border border-slate-200">
              <p className="text-sm font-semibold text-slate-800">
                Preview for {rescheduleSelectedEmployee.fullName} <span className="text-slate-500 font-normal">({rescheduleSelectedEmployee.employeeNumber})</span>
              </p>
              {rescheduleIsPermanent && permanentPlan ? (
                <div className="space-y-2">
                  <p className="text-sm text-slate-700">
                    From <strong>{rescheduleWeekStart}</strong> onward, <strong>{WEEKDAY_LABELS[rescheduleNewWeekdayNum]}</strong> becomes the recurring
                    Off day (replacing {WEEKDAY_LABELS[rescheduleOriginalWeekdayNum]}), every week, until changed again. This never rewrites any date before {rescheduleWeekStart}.
                  </p>
                  {permanentPlan.bridgeDate && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 flex items-start gap-2">
                      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                      <p>
                        To keep at least one rest day in every rolling seven-day window during the transition, <strong>{WEEKDAY_LABELS[rescheduleOriginalWeekdayNum]} {permanentPlan.bridgeDate}</strong> will
                        <strong> also</strong> remain an Off day -- a one-time addition for this single date only, even though it falls on or after the effective date. No other date is affected.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {reschedulePlan.map((week) => (
                    <div
                      key={week.weekStart}
                      className={`rounded-lg border p-3 text-sm ${
                        week.preview.blockingReason ? 'bg-red-50 border-red-200' : week.isBridgeWeek ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200'
                      }`}
                    >
                      <p className="font-medium text-slate-700">Week of {week.weekStart} – {week.weekEnd}</p>
                      {week.isBridgeWeek ? (
                        <div className="mt-1 space-y-1">
                          <p>
                            {week.originalDate} stays <Badge color="gold">off</Badge> (not converted to {rescheduleShift}) -- an additional rest day needed to protect the
                            rolling seven-day rule during this transition.
                          </p>
                          <p>{week.newOffDate} (was <Badge color={scheduleBadgeColor(week.preview.replacementResolved)}>{week.preview.replacementResolved}</Badge>) → <Badge color="gold">off</Badge></p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-3 mt-1">
                          <p>{week.originalDate} (was <Badge color={scheduleBadgeColor(week.preview.originalResolved)}>{week.preview.originalResolved}</Badge>) → <Badge color={scheduleBadgeColor(rescheduleShift)}>{rescheduleShift}</Badge></p>
                          <p>{week.newOffDate} (was <Badge color={scheduleBadgeColor(week.preview.replacementResolved)}>{week.preview.replacementResolved}</Badge>) → <Badge color="gold">off</Badge></p>
                        </div>
                      )}
                      {week.preview.blockingReason && (
                        <p className="text-xs text-red-700 mt-1.5 flex items-start gap-1.5"><AlertTriangle size={13} className="mt-0.5 flex-shrink-0" /> {week.preview.blockingReason}</p>
                      )}
                    </div>
                  ))}
                  <p className="text-xs text-slate-500">
                    This preview is advisory. The database independently re-verifies every rule, including the rolling seven-day rest
                    window across the preceding and following weeks, and applies every week atomically -- all weeks succeed together, or none change.
                  </p>
                </div>
              )}
              {rescheduleBridgeDate && (
                <label className="flex items-start gap-2 text-sm text-slate-800 rounded-lg border border-blue-200 bg-white p-3">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={rescheduleBridgeAcknowledged}
                    onChange={(e) => setRescheduleBridgeAcknowledged(e.target.checked)}
                  />
                  I understand and approve keeping {WEEKDAY_LABELS[rescheduleOriginalWeekdayNum]} {rescheduleBridgeDate} as an additional Off day to maintain the mandatory rest requirement.
                </label>
              )}
            </Card>
          )}

          <Button onClick={handleSubmitReschedule} disabled={submitting || !canSubmitReschedule}>
            {submitting ? 'Saving...' : rescheduleIsPermanent ? 'Save Permanent Off-Day Change' : `Reschedule ${reschedulePlan.length || ''} Week(s)`}
          </Button>
        </Card>
      )}
    </div>
  );
}
