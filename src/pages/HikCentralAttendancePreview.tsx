// HikCentral Attendance MVP -- Phase 2A: read-only Attendance Preview.
//
// Shows OBSERVED fingerprint scans, grouped by employee and Africa/Blantyre
// calendar date, for already-confirmed Person Mappings only. This page
// NEVER writes anything -- there is no approve/apply/confirm action
// anywhere on it, and it computes no Present/Absent/Late/hours-worked/
// deduction value. See hikcentralAttendancePreview.ts's header for the
// full scope rationale (no shift/schedule data exists anywhere in this
// codebase to compute those from yet).
//
// Every time shown here is explicitly labeled an OBSERVED SCAN, never a
// "check-in" or "check-out" -- the real HikCentral export's own
// `Attendance Type` column is "Undefined" for every row in STAGING, so
// punch direction cannot be read from the data at all (confirmed by the
// design audit that preceded this phase).
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Eye, Search, AlertTriangle, Users as UsersIcon, RefreshCw, Clock, MapPin, CalendarDays,
} from '../utils/icons';
import { Card, Button, Badge, PageHeader, EmptyState, Input, Select, StatCard } from '../components/ui';
import { hasPermission, PERMISSIONS } from '../utils/permissions';
import {
  buildEmployeeDayScanGroups, blantyreDateRangeToUtcBounds, splitByActiveMapping,
  EmployeeDayScanGroup, ReviewFlag,
} from '../utils/hikcentralAttendancePreview';
import { fetchActiveHikCentralPersonMappings, fetchAllEmployeesById } from '../utils/hikcentralPersonMappingService';
import { fetchIdentifiedEventsInRange, fetchAnonymousCountInRange } from '../utils/hikcentralAttendancePreviewService';

// Hard cap on the selectable range span, so this page can never be used to
// request "all time" in one shot as the underlying data grows over months/
// years of future imports -- the date-range filter (required anyway for
// the UI) is the primary bounding mechanism; this is the backstop.
const MAX_RANGE_DAYS = 92;
// Defensive render cap -- narrowing the date range is always the right
// fix if this is ever hit, never a reason to raise this number instead.
const MAX_RENDERED_GROUPS = 500;

const REVIEW_FLAG_LABELS: Record<ReviewFlag, string> = {
  single_scan: 'Single scan',
  three_or_more_scans: '3+ scans (ambiguous)',
  multiple_sites: 'Multiple sites same day',
  potential_overnight: 'Potential overnight',
  duplicate_timestamp: 'Duplicate timestamp',
};

const REVIEW_FLAG_COLORS: Record<ReviewFlag, 'gray' | 'gold' | 'orange' | 'purple' | 'red'> = {
  single_scan: 'gray',
  three_or_more_scans: 'orange',
  multiple_sites: 'purple',
  potential_overnight: 'gold',
  duplicate_timestamp: 'red',
};

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 13 * 24 * 60 * 60 * 1000);
  return { from: toDateInputValue(from), to: toDateInputValue(to) };
}

function daySpan(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

export default function HikCentralAttendancePreviewPage() {
  const [canView, setCanView] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);

  const defaults = useMemo(defaultDateRange, []);
  const [fromDate, setFromDate] = useState(defaults.from);
  const [toDate, setToDate] = useState(defaults.to);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [siteFilter, setSiteFilter] = useState('');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [groups, setGroups] = useState<EmployeeDayScanGroup[]>([]);
  const [identifiedUnmappedCount, setIdentifiedUnmappedCount] = useState(0);
  const [anonymousCount, setAnonymousCount] = useState(0);

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
      const { fromUtcIso, toUtcIsoExclusive } = blantyreDateRangeToUtcBounds(fromDate, toDate);
      const [identifiedEvents, anonCount, mappings, employeesById] = await Promise.all([
        fetchIdentifiedEventsInRange(fromUtcIso, toUtcIsoExclusive),
        fetchAnonymousCountInRange(fromUtcIso, toUtcIsoExclusive),
        fetchActiveHikCentralPersonMappings(),
        fetchAllEmployeesById(),
      ]);
      const personNoToEmployeeId = new Map(mappings.map((m) => [m.hikcentralPersonNo, m.employeeId]));
      const { mapped, identifiedUnmappedCount: unmappedCount } = splitByActiveMapping(identifiedEvents, personNoToEmployeeId);
      setGroups(buildEmployeeDayScanGroups(mapped, employeesById));
      setIdentifiedUnmappedCount(unmappedCount);
      setAnonymousCount(anonCount);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the Attendance Preview.');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, rangeInvalid, rangeTooWide]);

  useEffect(() => {
    if (permissionsLoaded && canView) loadData();
  }, [permissionsLoaded, canView, loadData]);

  const siteOptions = useMemo(() => {
    const sites = new Set<string>();
    for (const g of groups) for (const ap of g.accessPoints) sites.add(ap);
    return Array.from(sites).sort();
  }, [groups]);

  const filteredGroups = useMemo(() => {
    const q = employeeSearch.trim().toLowerCase();
    return groups.filter((g) => {
      if (siteFilter && !g.accessPoints.includes(siteFilter)) return false;
      if (q === '') return true;
      const name = g.employee?.fullName?.toLowerCase() ?? '';
      const num = g.employee?.employeeNumber?.toLowerCase() ?? '';
      return name.includes(q) || num.includes(q);
    });
  }, [groups, employeeSearch, siteFilter]);

  const visibleGroups = filteredGroups.slice(0, MAX_RENDERED_GROUPS);
  const truncated = filteredGroups.length > MAX_RENDERED_GROUPS;

  const counts = useMemo(() => {
    const byCategory = { single_scan: 0, two_scans: 0, three_or_more_scans: 0 };
    let overnight = 0;
    for (const g of groups) {
      byCategory[g.scanCountCategory]++;
      if (g.reviewFlags.includes('potential_overnight')) overnight++;
    }
    return { ...byCategory, overnight, total: groups.length };
  }, [groups]);

  if (!permissionsLoaded) {
    return <div className="p-8 text-center text-slate-400">Loading...</div>;
  }

  if (!canView) {
    return (
      <div className="space-y-6">
        <PageHeader title="HikCentral Attendance Preview" subtitle="Read-only preview of observed fingerprint scans." />
        <Card className="p-6 bg-amber-50 border-amber-200 border">
          <p className="text-sm text-amber-800">You do not have permission to view the HikCentral Attendance Preview.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="HikCentral Attendance Preview"
        subtitle="Observed fingerprint scans grouped by employee and day -- NOT confirmed check-in/check-out times, and NOT official attendance. Nothing on this page writes any data."
        actions={<Button variant="outline" onClick={loadData}><RefreshCw size={14} /> Refresh</Button>}
      />

      <Card className="p-4 bg-blue-50 border-blue-200 border">
        <div className="flex items-start gap-3">
          <Eye size={18} className="text-blue-600 shrink-0 mt-0.5" />
          <p className="text-sm text-blue-800">
            Every time below is an <strong>observed scan</strong> only. Two scans in a day are shown as "Two scans" --
            this is never treated as a confirmed complete shift. No Present/Absent/Late status, hours-worked, or
            deduction is calculated anywhere on this page.
          </p>
        </div>
      </Card>

      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Input label="From (Blantyre date)" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <Input label="To (Blantyre date)" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          <Input label="Search employee" icon={Search} placeholder="Name or employee number..." value={employeeSearch} onChange={(e) => setEmployeeSearch(e.target.value)} />
          <Select
            label="Site / access point"
            value={siteFilter}
            onChange={(e) => setSiteFilter(e.target.value)}
            options={[{ label: 'All sites', value: '' }, ...siteOptions.map((s) => ({ label: s, value: s }))]}
          />
        </div>
        {rangeInvalid && <p className="text-xs text-red-600 mt-2">The "From" date must not be after the "To" date.</p>}
        {!rangeInvalid && rangeTooWide && (
          <p className="text-xs text-red-600 mt-2">
            That range spans more than {MAX_RANGE_DAYS} days. Please narrow it -- this preview deliberately never fetches an unbounded history.
          </p>
        )}
      </Card>

      {loadError && (
        <Card className="p-4 bg-red-50 border-red-200 border">
          <p className="text-sm text-red-700">{loadError}</p>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard title="Employee-day groups" value={counts.total.toLocaleString()} icon={CalendarDays} accent="navy" />
        <StatCard title="Single scan" value={counts.single_scan.toLocaleString()} icon={AlertTriangle} accent="gold" />
        <StatCard title="Two scans" value={counts.two_scans.toLocaleString()} icon={Clock} accent="green" />
        <StatCard title="3+ scans" value={counts.three_or_more_scans.toLocaleString()} icon={AlertTriangle} accent="red" />
        <StatCard title="Potential overnight" value={counts.overnight.toLocaleString()} icon={Clock} accent="blue" />
      </div>

      <Card className="p-4 bg-slate-50 border-slate-200 border">
        <p className="text-sm text-slate-600 flex items-center gap-2">
          <UsersIcon size={16} className="text-slate-400" />
          In this date range: {identifiedUnmappedCount.toLocaleString()} identified-but-unmapped event(s) and{' '}
          {anonymousCount.toLocaleString()} anonymous event(s) -- shown for context only, excluded from every group below.
        </p>
      </Card>

      {loading ? (
        <div className="p-8 text-center text-slate-400">Loading scans...</div>
      ) : visibleGroups.length === 0 ? (
        <EmptyState icon={Eye} title="No observed scans" description="No mapped employee has an observed scan in this date range matching the current filters." />
      ) : (
        <div className="space-y-3">
          {truncated && (
            <Card className="p-3 bg-amber-50 border-amber-200 border">
              <p className="text-xs text-amber-800">
                Showing the first {MAX_RENDERED_GROUPS.toLocaleString()} of {filteredGroups.length.toLocaleString()} matching groups. Narrow the date range or filters to see the rest.
              </p>
            </Card>
          )}
          {visibleGroups.map((g, idx) => {
            const prevDate = idx > 0 ? visibleGroups[idx - 1].localDate : null;
            return (
              <div key={`${g.employeeId}|${g.localDate}`}>
                {g.localDate !== prevDate && (
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-5 mb-2">{g.localDate}</p>
                )}
                <Card className="p-4">
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-800">{g.employee?.fullName ?? '(employee no longer visible)'}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{g.employee?.employeeNumber ?? '—'} &middot; {g.employee?.workstation || '—'}</p>
                      <p className="text-xs text-slate-500 mt-1 flex items-center gap-1">
                        <MapPin size={12} /> {g.accessPoints.join(', ') || '—'}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5 md:justify-end">
                      {g.reviewFlags.map((flag) => (
                        <Badge key={flag} color={REVIEW_FLAG_COLORS[flag]}>{REVIEW_FLAG_LABELS[flag]}</Badge>
                      ))}
                      {g.reviewFlags.length === 0 && <Badge color="green">Two scans (not a confirmed shift)</Badge>}
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-slate-600">
                    <span>{g.scanCount} observed scan{g.scanCount === 1 ? '' : 's'}</span>
                    <span>Earliest: {g.scans[0].localTime}</span>
                    <span>Latest: {g.scans[g.scans.length - 1].localTime}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {g.scans.map((s, i) => (
                      <span key={i} className="inline-flex items-center gap-1 text-xs font-mono bg-slate-50 border border-slate-200 rounded px-2 py-1 text-slate-600">
                        <Clock size={11} /> {s.localTime}{s.accessPoint ? ` · ${s.accessPoint}` : ''}
                      </span>
                    ))}
                  </div>
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
