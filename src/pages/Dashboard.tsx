import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
  Users, Wallet, UserMinus, ClipboardList, CheckCircle2, TrendingUp,
  Bell, ShieldCheck, Shield, MapPin,
  ChevronLeft, ChevronRight, RefreshCw, AlertCircle, Building2, Home
} from '../utils/icons';
import { Card, StatCard, Button, Badge, Table, THead, TBody, TR, TH, TD } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import {
  getSystemCurrentMonth,
  getMonthLabel,
  getNextMonth,
  getPreviousMonth,
  getAvailableMonthsFromSystem,
  getChartMonths,
  normalizeMonthKey
} from '../utils/currentMonth';
import { showNotification } from '../utils/clickHandlers';
import { getErrorMessage } from '../utils/errorHandler';
import { resolveDashboardPermissions, buildPendingTasks, PendingTask } from '../utils/dashboardPermissions';
import { countHeadcountAsOf, countPendingPayrollMonths } from '../utils/dashboardMetrics';
import { fetchInEmployeeIdBatches } from '../utils/employeeBatchFetch';

// ===== PERFORMANCE: Lazy load charts with dynamic import =====
const COLORS = ['#081C3A', '#D4A017', '#3B82F6', '#10B981', '#EF4444', '#8B5CF6', '#F59E0B', '#64748B', '#06B6D4'];

// Shape of get_applicant_dashboard_counts()'s single-row return (see
// supabase/migrations/20260804000002_applicant_dashboard_counts_rpc.sql) --
// 3 aggregate integers only, never applicant row data.
interface ApplicantDashboardCounts {
  pending_count: number;
  shortlisted_count: number;
  interviewed_count: number;
}

// ===== COMPONENT: Chart loading placeholder =====
const ChartLoader = () => (
  <div className="h-full flex items-center justify-center min-h-[150px]">
    <div className="text-center">
      <div className="w-8 h-8 border-3 border-[#D4A017] border-t-transparent rounded-full animate-spin mx-auto mb-2" />
      <p className="text-xs text-slate-400">Loading chart...</p>
    </div>
  </div>
);

// ===== COMPONENT: Chart error fallback =====
const ChartErrorFallback = () => (
  <div className="h-full flex items-center justify-center min-h-[150px]">
    <div className="text-center">
      <AlertCircle size={24} className="text-slate-400 mx-auto mb-2" />
      <p className="text-xs text-slate-400">Chart unavailable</p>
    </div>
  </div>
);

export function Dashboard() {
  // ===== ALL HOOKS AT TOP LEVEL =====
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState('');
  const [greeting, setGreeting] = useState('Good morning');
  const [userProfile, setUserProfile] = useState<any>(null);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [systemMonth, setSystemMonth] = useState('');
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  // ===== PERMISSION-AWARE DASHBOARD SECTIONS =====
  // Fail-closed by design: every flag starts false, and stays false unless
  // permission resolution actually succeeds and grants it. `permissionsResolved`
  // gates the FIRST dashboard fetch entirely (see the effect below) so no
  // module's data is ever requested before its own flag is known -- not
  // "requested but safely returns empty," genuinely never requested.
  // Legacy accounts (role_level set) see EXACTLY what they always have --
  // payroll/attendance SELECT has been "legacy-open" (any role_level) on
  // these two tables since before this rollout, so canAccess(true, ...)
  // short-circuits true for every legacy role, unchanged. A NEW
  // functional-role account is gated: Payroll data needs payroll.view
  // (Admin/Accountant only); Attendance needs attendance.view (Admin/
  // Operations Manager only); Recruitment counts need recruitment.view
  // (Admin/HR Manager only) -- these flags now control BOTH whether the
  // stat card is shown AND whether the underlying fetch/RPC call is made
  // at all.
  const [canViewPayroll, setCanViewPayroll] = useState(false);
  const [canViewAttendance, setCanViewAttendance] = useState(false);
  const [canViewRecruitment, setCanViewRecruitment] = useState(false);
  const [canViewSecurity, setCanViewSecurity] = useState(false);
  // Separate from canViewPayroll -- Payroll.tsx's own approve action is
  // gated by payroll.approve (legacy: role_level === 1), a strictly
  // narrower permission than payroll.view. The "Approve Payroll" pending
  // task must follow the SAME gate as the real action it links to, not
  // "can this caller merely see payroll at all" (an Accountant with only
  // view access, if that combination existed, must never see a task
  // implying they can approve something they can't act on).
  const [canApprovePayroll, setCanApprovePayroll] = useState(false);
  const [permissionsResolved, setPermissionsResolved] = useState(false);
  
  // ===== PERFORMANCE: Track chart loading state =====
  const [chartModules, setChartModules] = useState<any>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState(false);
  const chartsLoadedRef = useRef(false);
  
  // ===== PERFORMANCE: Data state with progressive loading =====
  const [stats, setStats] = useState({
    total: 0,
    activeGuards: 0,
    supervisorsOnDuty: 0,
    sitesCount: 0,
    companiesCount: 0,
    residentsCount: 0,
    expiringLicenses: 0,
    totalPayroll: 0,
    onLeave: 0,
    pendingRecruitment: 0,
    shortlistedRecruitment: 0,
    interviewedRecruitment: 0,
    attendanceRate: 0,
    notifications: 0
  });
  const [payrollHistory, setPayrollHistory] = useState<any[]>([]);
  const [attendanceData, setAttendanceData] = useState<any[]>([]);
  const [pieData, setPieData] = useState<any[]>([]);
  const [recent, setRecent] = useState<any[]>([]);
  const [growthData, setGrowthData] = useState<any[]>([]);
  const [payrollStatusLabel, setPayrollStatusLabel] = useState('Not Processed');
  // Real count of the selected month's processed-but-not-yet-approved
  // payroll rows, in the caller's own authorized scope -- feeds the
  // "Approve Payroll" pending task's visibility/count. 0 by default (fail-
  // closed): never set except from the actual payroll fetch below.
  const [pendingPayrollApprovalCount, setPendingPayrollApprovalCount] = useState(0);
  const [dataReady, setDataReady] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  // Real connectivity/data-fetch signal for the "Data Status" card --
  // replaces a previously hardcoded "Online". True only when the LAST
  // fetchDashboardData() call actually threw; reset to false at the start
  // of every attempt so a stale error never survives a successful retry.
  const [dashboardFetchError, setDashboardFetchError] = useState(false);

  // ===== MEMOIZED PENDING TASKS =====
  // Filtering itself lives in buildPendingTasks() (dashboardPermissions.ts),
  // gated on the same permission flags already used to gate this page's
  // own data fetches/cards, not a hardcoded role check -- extracted so
  // it's independently unit-testable. Icons stay here (React components
  // don't belong in a permissions-utility module).
  const pendingTasks = useMemo(
    () => buildPendingTasks({
      canApprovePayroll,
      pendingPayrollApprovalCount,
      canViewRecruitment,
      pendingRecruitmentCount: stats.pendingRecruitment,
      canViewSecurity,
      expiringLicensesCount: stats.expiringLicenses,
    }),
    [canApprovePayroll, pendingPayrollApprovalCount, canViewRecruitment, stats.pendingRecruitment, canViewSecurity, stats.expiringLicenses]
  );
  const pendingTaskIcons: Record<PendingTask['key'], typeof Wallet> = {
    'approve-payroll': Wallet,
    'review-applications': ClipboardList,
    'renew-licenses': Shield,
  };

  // ===== PERFORMANCE: Lazy load charts after data is ready =====
  const loadCharts = useCallback(async () => {
    if (chartsLoadedRef.current || chartLoading) return;
    
    setChartLoading(true);
    setChartError(false);
    
    try {
      const modules = await Promise.race([
        import('recharts'),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Chart loading timeout')), 8000)
        )
      ]) as any;
      
      setChartModules({
        LineChart: modules.LineChart,
        Line: modules.Line,
        BarChart: modules.BarChart,
        Bar: modules.Bar,
        PieChart: modules.PieChart,
        Pie: modules.Pie,
        Cell: modules.Cell,
        ResponsiveContainer: modules.ResponsiveContainer,
        XAxis: modules.XAxis,
        YAxis: modules.YAxis,
        Tooltip: modules.Tooltip,
        CartesianGrid: modules.CartesianGrid,
      });
      
      chartsLoadedRef.current = true;
    } catch (err) {
      console.error('Failed to load charts:', err);
      setChartError(true);
    } finally {
      setChartLoading(false);
    }
  }, [chartLoading]);

  // ===== CALLBACKS =====
  const getTimeBasedGreeting = useCallback(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  // Initialize with system month
  useEffect(() => {
    const init = async () => {
      const month = await getSystemCurrentMonth();
      setSystemMonth(month);
      setSelectedMonth(month);
      const months = getAvailableMonthsFromSystem(month);
      setAvailableMonths(months);
    };
    init();
  }, []);

  useEffect(() => {
    const getUserInfo = async () => {
      // Reset to the fail-closed state at the start of every resolution
      // pass (not just on first mount) -- if this effect is ever re-run
      // for a new user/profile context, stale flags from a PREVIOUS
      // caller must never remain visible while the new caller's real
      // permissions are still being resolved.
      setPermissionsResolved(false);
      setCanViewPayroll(false);
      setCanViewAttendance(false);
      setCanViewRecruitment(false);
      setCanApprovePayroll(false);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const profile = await getCurrentProfile();
          setUserProfile(profile);
          const name = profile?.full_name || user.email?.split('@')[0] || 'User';
          setUserName(name);

          // resolveDashboardPermissions() already fails closed internally
          // (an error there returns all-false, never throws) -- so
          // whatever it returns is always safe to apply directly.
          const permissions = await resolveDashboardPermissions(profile);
          setCanViewPayroll(permissions.canViewPayroll);
          setCanViewAttendance(permissions.canViewAttendance);
          setCanViewRecruitment(permissions.canViewRecruitment);
          setCanViewSecurity(permissions.canViewSecurity);
          setCanApprovePayroll(permissions.canApprovePayroll);
        }
      } finally {
        setPermissionsResolved(true);
      }
    };
    getUserInfo();
    setGreeting(getTimeBasedGreeting());
    
    const interval = setInterval(() => {
      setGreeting(getTimeBasedGreeting());
    }, 60000);
    
    return () => clearInterval(interval);
  }, [getTimeBasedGreeting]);

  // ===== PERFORMANCE: Load charts after data is ready =====
  useEffect(() => {
    if (dataReady && !chartsLoadedRef.current && !chartLoading && !chartError) {
      if ('requestIdleCallback' in window) {
        (window as any).requestIdleCallback(() => {
          loadCharts();
        }, { timeout: 5000 });
      } else {
        setTimeout(loadCharts, 1500);
      }
    }
  }, [dataReady, loadCharts, chartLoading, chartError]);

  // ===== Month Navigation =====
  const goToPreviousMonth = useCallback(() => {
    const prevMonth = getPreviousMonth(selectedMonth);
    if (prevMonth && availableMonths.includes(prevMonth)) {
      setSelectedMonth(prevMonth);
    }
  }, [selectedMonth, availableMonths]);

  const goToNextMonth = useCallback(() => {
    const nextMonth = getNextMonth(selectedMonth);
    if (nextMonth && availableMonths.includes(nextMonth)) {
      setSelectedMonth(nextMonth);
    } else {
      showNotification('Cannot go beyond available months.', 'error');
    }
  }, [selectedMonth, availableMonths]);

  const goToCurrentMonth = useCallback(() => {
    if (systemMonth && systemMonth !== selectedMonth) {
      setSelectedMonth(systemMonth);
      showNotification(`Switched to ${getMonthLabel(systemMonth)}`, 'success');
    }
  }, [systemMonth, selectedMonth]);

  const handleMonthSelect = useCallback((month: string) => {
    if (month !== selectedMonth) {
      setSelectedMonth(month);
    }
  }, [selectedMonth]);

  // ===== OPTIMIZED: Fetch dashboard data with parallel queries =====
  const fetchDashboardData = useCallback(async () => {
    setLoading(true);
    setInitialLoad(true);
    setDashboardFetchError(false);
    
    try {
      // ===== CRITICAL: Exclude deleted employees =====
      // Reads from `employees_general` (20260817000005), not `employees`
      // directly -- same row-level tenant/region access, but guard-
      // specific columns (license_status, etc.) are NULLed for a caller
      // without security_personnel.view, so an Accountant session never
      // receives raw guard data in this fetch even though it isn't
      // rendered today.
      // `.order('created_at', ...)` matters beyond cosmetics: "Recent Active
      // Employees" below is `employeesData.slice(0, 6)` -- without an
      // explicit order, that's whatever arbitrary order Postgres/PostgREST
      // happens to return (not guaranteed stable, and never "newest
      // first"), so the widget's own "Latest additions to your workforce"
      // subtitle was not actually true before this.
      let employeesQuery = supabase
        .from('employees_general')
        .select('*')
        .eq('is_deleted', false)
        .order('created_at', { ascending: false });
      
      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        employeesQuery = employeesQuery.eq('region_id', userProfile.region_id);
      }
      
      const employeesRes = await employeesQuery;

      // ===== Employee Growth history source -- deliberately a SEPARATE,
      // unfiltered-by-is_deleted fetch, not derived from `employeesData`
      // above =====
      // `employeesData` (is_deleted=false) answers "who is employed
      // TODAY" -- it cannot answer "who was employed as of the end of
      // June" for anyone who has since left: a hire from June, soft-
      // deleted in August, is invisible to that query entirely, so a
      // growth chart built from it would silently UNDERcount every past
      // month by however many people have left since. This fetch includes
      // soft-deleted rows too (same tenant/region scope as the RLS/query
      // above -- is_deleted is an application-level filter here, not an
      // RLS restriction, confirmed by reading employees_general's own
      // definition), using each row's own `deleted_at` to know exactly
      // when they left, so a past month's count can correctly include
      // someone who has since departed. Only `hire_date`/`deleted_at`/
      // `region_id` are selected -- this never exposes anything beyond
      // what the growth chart itself needs.
      let growthHistoryQuery = supabase
        .from('employees_general')
        .select('hire_date, deleted_at, region_id');
      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        growthHistoryQuery = growthHistoryQuery.eq('region_id', userProfile.region_id);
      }
      const growthHistoryRes = await growthHistoryQuery;
      const growthHistoryEmployees = growthHistoryRes.data || [];

      // Applicant counts come from a counts-only RPC, not a direct
      // `applicants` SELECT -- Supervisor/Staff (role_level 3/4) are
      // still meant to see these numbers on the Dashboard, but as of
      // this migration are no longer permitted to SELECT full applicant
      // rows directly (see 20260803000000_role_level_rls_hardening.sql
      // and 20260804000002_applicant_dashboard_counts_rpc.sql). The RPC
      // is SECURITY DEFINER and does its own tenant scoping server-side,
      // so it works identically regardless of the caller's role_level --
      // but it is only ever CALLED when canViewRecruitment is already
      // known true. A caller without recruitment.view must not merely
      // receive a safe zero response; the request itself must never be
      // made (permission-aware fetching, not just permission-aware data).
      let applicantCounts: ApplicantDashboardCounts | null = null;
      if (canViewRecruitment) {
        const { data, error } = await supabase.rpc('get_applicant_dashboard_counts').single();
        if (error) {
          // Fails closed to zero rather than throwing -- an errored RPC
          // call (e.g. a transient network issue) should degrade the
          // recruitment stat tile, not the whole Dashboard, and must
          // never fall back to a direct `applicants` row query (that
          // would defeat the point of this change).
          console.error('Error fetching applicant dashboard counts:', error);
        } else {
          // No generated Supabase types exist in this project (see
          // AUDIT_REPORT.md), so `.rpc(...)` has nothing to infer the
          // return shape from -- cast explicitly to the 3-integer shape
          // get_applicant_dashboard_counts() actually returns, matching
          // the pattern already used for process_payroll_batch()'s result.
          applicantCounts = data as ApplicantDashboardCounts | null;
        }
      }

      const employeesData = employeesRes.data || [];
      const employeeIds = employeesData.map((e: any) => e.id);

      // ===== ACCURATE STATS CALCULATIONS =====
      const activeGuards = employeesData.filter((e: any) => 
        (e.position?.toLowerCase().includes('guard') || 
         e.position?.toLowerCase().includes('security') ||
         e.position?.toLowerCase().includes('officer') ||
         e.position?.toLowerCase().includes('patrol')) && 
        e.status === 'Active'
      ).length;
      
      const supervisorsOnDuty = employeesData.filter((e: any) => 
        (e.position?.toLowerCase().includes('supervisor') || 
         e.position?.toLowerCase().includes('manager') ||
         e.position?.toLowerCase().includes('lead')) && 
        e.status === 'Active'
      ).length;
      
      const uniqueSites = [...new Set(employeesData.map((e: any) => e.workstation).filter(Boolean))];
      
      // ===== COUNT COMPANIES AND RESIDENTS =====
      const companies = new Set<string>();
      const residents = new Set<string>();
      
      employeesData.forEach((e: any) => {
        if (e.assignment_type === 'resident' && e.resident_name) {
          residents.add(e.resident_name);
        } else if (e.company) {
          companies.add(e.company);
        }
      });
      
      const expiringLicenses = employeesData.filter((e: any) => 
        e.license_status === 'Expiring' || e.license_status === 'Expired'
      ).length;
      
      // "Monthly Payroll" is set further below, inside the canViewPayroll
      // block, from the real processed `payroll` rows for the selected
      // month -- not here. It used to be `sum(basic_salary)` across the
      // active roster: a contracted-base-salary total that never reflected
      // actual net disbursement (no PAYE/pension/uniform/attendance/salary-
      // advance deductions applied), silently diverging from what the
      // Monthly Payroll Trend chart below it calls the same real figure.
      const totalPayroll = 0;

      const onLeave = employeesData.filter((e: any) => e.status === 'On Leave').length;
      
      // ===== ATTENDANCE — fetched ONCE for the full 6-month chart window,
      // then BOTH the current-month attendance rate AND the 6-month chart
      // are derived from that single dataset client-side. =====
      // PERFORMANCE CORRECTION: the previous version fetched this same
      // `attendance` table twice per Dashboard load -- once scoped to just
      // the selected month (for `attendanceRate` below), and again for the
      // full 6-month chart window a few lines further down. `chartMonths`'s
      // own last entry IS the selected month (getChartMonths ends at
      // whatever month is passed in), so the 6-month fetch's result already
      // contains every row the 1-month fetch would have returned -- the
      // second fetch was pure duplicated network/DB work. Moved the
      // `chartMonths`/`monthRanges` computation up here (it doesn't depend
      // on anything computed below) so the single merged fetch can use the
      // full 6-month range up front.
      //
      // Only fetched for a caller who can actually see Attendance
      // (Admin/Operations Manager, or any legacy account -- attendance
      // SELECT has been legacy-open since before this rollout) -- an
      // Accountant/HR Manager session never issues this request at all;
      // gating the fetch itself (not just hiding the result afterward)
      // means a caller without attendance.view never triggers this query.
      const chartMonths = getChartMonths(selectedMonth);
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthRanges = chartMonths.map(month => {
        const [year, monthNum] = month.split('-').map(Number);
        const monthName = monthNames[monthNum - 1];
        const lastDay = new Date(year, monthNum, 0).getDate();
        return {
          label: `${monthName} ${year}`,
          startDate: `${year}-${String(monthNum).padStart(2, '0')}-01`,
          endDate: `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
        };
      });
      const monthStart = `${selectedMonth}-01`;
      const monthEndLastDay = new Date(parseInt(selectedMonth.split('-')[0]), parseInt(selectedMonth.split('-')[1]), 0).getDate();
      const monthEnd = `${selectedMonth}-${String(monthEndLastDay).padStart(2, '0')}`;

      // Batched: `employeeIds` is the full loaded employee population, which
      // produced an oversized employee_id IN-list request URL in production
      // (confirmed 400 Bad Request on this exact query shape -- select
      // date/status over a date range, employee_id IN). Only aggregate
      // stats/chart data are needed from this, so batching + client-side
      // aggregation is the minimal fix -- no row `id` is selected, so no
      // dedup step applies (see src/utils/employeeBatchFetch.ts).
      let allAttendanceRecords: { date: string; status: string }[] = [];
      if (monthRanges.length > 0 && employeeIds.length > 0 && canViewAttendance) {
        allAttendanceRecords = await fetchInEmployeeIdBatches<{ date: string; status: string }>(
          employeeIds,
          (batch, from, to, withCount) =>
            supabase
              .from('attendance')
              .select('date, status', withCount ? { count: 'exact' } : undefined)
              .gte('date', monthRanges[0].startDate)
              .lte('date', monthRanges[monthRanges.length - 1].endDate)
              .in('employee_id', batch)
              .range(from, to)
        );
      }

      // ===== ACCURATE ATTENDANCE RATE ===== derived from the merged fetch
      // above by filtering to just the selected month's own date bounds
      // (identical to what the old dedicated 1-month query would have
      // returned, since it's a strict subset of the 6-month range fetched).
      let attendanceRate = 0;
      if (allAttendanceRecords.length > 0) {
        let presentCount = 0;
        let totalRecords = 0;
        allAttendanceRecords.forEach(record => {
          if (record.date >= monthStart && record.date <= monthEnd && record.status !== '-') {
            totalRecords++;
            if (record.status === 'P') presentCount++;
          }
        });
        attendanceRate = totalRecords > 0 ? Math.round((presentCount / totalRecords) * 100) : 0;
      }

      setStats({
        total: employeesData.length,
        activeGuards,
        supervisorsOnDuty,
        sitesCount: uniqueSites.length,
        companiesCount: companies.size,
        residentsCount: residents.size,
        expiringLicenses,
        totalPayroll,
        onLeave,
        pendingRecruitment: applicantCounts?.pending_count ?? 0,
        shortlistedRecruitment: applicantCounts?.shortlisted_count ?? 0,
        interviewedRecruitment: applicantCounts?.interviewed_count ?? 0,
        attendanceRate,
        notifications: 0
      });
      
      // ===== DEPARTMENT DISTRIBUTION =====
      const deptCount: Record<string, number> = {};
      employeesData.forEach((emp: any) => {
        if (emp.department) {
          deptCount[emp.department] = (deptCount[emp.department] || 0) + 1;
        }
      });
      setPieData(Object.entries(deptCount).map(([name, value]) => ({ name, value })));
      
      // ===== RECENT ACTIVE EMPLOYEES =====
      // `employeesData` is already non-deleted (is_deleted=false) and
      // ordered created_at DESC (see employeesQuery above), but that alone
      // doesn't guarantee status='Active' -- an employee currently On
      // Leave is non-deleted too, and this widget's own title claims
      // "Active" specifically (the same meaning "Active Guards"/"Active
      // Supervisors" use elsewhere on this page: status === 'Active').
      // Filtering (not re-querying) preserves the created_at DESC order
      // already applied server-side.
      setRecent(employeesData.filter((e: any) => e.status === 'Active').slice(0, 6));
      
      // ===== GROWTH DATA — real headcount AS OF THE END OF each month,
      // starting from the system's actual start month (June 2026), not a
      // fabricated multi-year history the system never existed for. =====
      // Uses `growthHistoryEmployees` (includes soft-deleted rows), NOT
      // `employeesData` (is_deleted=false only) -- a person hired in June
      // and terminated in August is still part of June's and July's real
      // headcount, and `employeesData` alone cannot see them at all once
      // they've left. A month counts someone if they had already been
      // hired by monthEnd AND (they haven't left yet, OR they left after
      // monthEnd) -- i.e. real headcount at that point in time, not
      // "hired ever" and not "currently employed today".
      // (`chartMonths`/`monthNames`/`monthRanges` were computed earlier,
      // alongside the merged attendance fetch, and are reused here.)
      const growth = chartMonths.map(month => {
        const [year, monthNum] = month.split('-').map(Number);
        const monthName = monthNames[monthNum - 1];
        const lastDay = new Date(year, monthNum, 0).getDate();
        const monthEnd = `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const count = countHeadcountAsOf(growthHistoryEmployees, monthEnd);
        return { month: `${monthName} ${year}`, employees: count };
      });
      setGrowthData(growth);

      // ===== PAYROLL HISTORY — real net pay totals per month from the
      // `payroll` table. A month with no processed payroll run shows 0,
      // never a fabricated estimate. Only fetched for a caller who can
      // actually see Payroll (Admin/Accountant, or any legacy account --
      // payroll SELECT has been legacy-open since before this rollout) --
      // an HR Manager/Operations Manager session never issues this
      // request at all -- gating the fetch itself, not just the result.
      // Batched: same oversized employee_id IN-list problem, confirmed 400
      // Bad Request on this exact query shape (select month/net_pay/
      // employee_id/approval_status, employee_id IN). No row `id` is
      // selected, so no dedup step applies.
      if (canViewPayroll) {
        const allPayrollRecords = await fetchInEmployeeIdBatches<{
          month: string;
          net_pay: number;
          employee_id: string;
          approval_status: string;
        }>(
          employeeIds,
          (batch, from, to, withCount) =>
            supabase
              .from('payroll')
              .select('month, net_pay, employee_id, approval_status', withCount ? { count: 'exact' } : undefined)
              .in('employee_id', batch)
              .range(from, to)
        );

        const payrollTotalsByMonthKey = new Map<string, number>();
        (allPayrollRecords || []).forEach((r: any) => {
          const key = normalizeMonthKey(r.month);
          if (!key) return;
          payrollTotalsByMonthKey.set(key, (payrollTotalsByMonthKey.get(key) || 0) + (r.net_pay || 0));
        });

        // Real payroll status for the selected month, not a hardcoded "Ready".
        const selectedMonthKey = normalizeMonthKey(selectedMonth);
        const selectedMonthPayrollRecords = (allPayrollRecords || []).filter(
          (r: any) => normalizeMonthKey(r.month) === selectedMonthKey
        );
        setPayrollStatusLabel(
          selectedMonthPayrollRecords.length === 0
            ? 'Not Processed'
            : selectedMonthPayrollRecords.every((r: any) => r.approval_status === 'approved')
              ? 'Approved'
              : 'Pending Approval'
        );

        // "Monthly Payroll" stat card -- the real processed net-pay total
        // for the selected month, matching exactly what the Monthly
        // Payroll Trend chart below calls the same figure (both read from
        // `payrollTotalsByMonthKey`, built from the same fetch). Patches
        // the earlier setStats() call rather than being computed there,
        // since this needs data only available after this (permission-
        // gated) payroll fetch completes.
        setStats(prev => ({ ...prev, totalPayroll: payrollTotalsByMonthKey.get(selectedMonthKey || '') || 0 }));

        // Real count of DISTINCT payroll MONTHS/RUNS awaiting approval, in
        // the caller's own authorized scope (employeeIds already reflects
        // tenant/region scoping) -- feeds the "Approve Payroll" pending
        // task below. Deliberately NOT a count of pending employee rows:
        // one payroll run for July with 469 employee rows still pending
        // is ONE thing to approve ("Payroll Awaiting Approval — 1"), not
        // 469 -- counting rows would wildly overstate the actual workload
        // and misrepresent what "Approve Payroll" even means (Payroll.tsx
        // approves a month's run, not individual employee rows one at a
        // time). Scans ALL months in allPayrollRecords, not just the
        // selected month, since a run from an earlier month can still be
        // awaiting approval regardless of which month is currently
        // selected on this dashboard.
        setPendingPayrollApprovalCount(countPendingPayrollMonths(allPayrollRecords || [], normalizeMonthKey));

        const historyData = chartMonths.map(month => {
          const [year, monthNum] = month.split('-').map(Number);
          const monthName = monthNames[monthNum - 1];
          return {
            month: `${monthName} ${year}`,
            amount: payrollTotalsByMonthKey.get(month) || 0
          };
        });
        setPayrollHistory(historyData);
      } else {
        // Fail-closed: a caller who loses canViewPayroll (e.g. a
        // mid-session role change) must never keep showing a stale
        // "Approve Payroll" count from a previous fetch that had access.
        setPendingPayrollApprovalCount(0);
      }

      // ===== ATTENDANCE DATA - Starting from June 2026 =====
      // Reuses `allAttendanceRecords`, already fetched once (in full, for
      // this same 6-month window, gated by canViewAttendance) alongside the
      // attendance-rate calculation above -- no second attendance fetch here.
      const attendanceDataTemp = monthRanges.map(({ label, startDate, endDate }) => {
        let present = 0;
        let total = 0;
        allAttendanceRecords.forEach(r => {
          if (r.date >= startDate && r.date <= endDate && r.status !== '-') {
            total++;
            if (r.status === 'P') present++;
          }
        });
        const rate = total > 0 ? Math.round((present / total) * 100) : 0;
        return { month: label, rate };
      });
      setAttendanceData(attendanceDataTemp);
      
      setDataReady(true);
      setInitialLoad(false);
      
    } catch (err: any) {
      console.error('Error fetching data:', err);
      setInitialLoad(false);
      setDashboardFetchError(true);
      showNotification('Failed to load dashboard data: ' + getErrorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [selectedMonth, userProfile, canViewPayroll, canViewAttendance, canViewRecruitment]);

  useEffect(() => {
    // permissionsResolved is required here, not just userProfile/selectedMonth
    // -- otherwise the first fetch could run while canViewPayroll/
    // canViewAttendance/canViewRecruitment still hold their fail-closed
    // defaults, which happen to be false-negative-safe but would still
    // mean the fetch ran before permissions were actually known.
    if (userProfile && selectedMonth && permissionsResolved) {
      fetchDashboardData();
    }
  }, [userProfile, selectedMonth, permissionsResolved, fetchDashboardData]);

  const refreshData = useCallback(async () => {
    setRefreshing(true);
    chartsLoadedRef.current = false;
    setChartModules(null);
    await fetchDashboardData();
    showNotification('Dashboard updated', 'success');
    setRefreshing(false);
  }, [fetchDashboardData]);

  const isSuperAdmin = userProfile?.is_super_admin;
  const userRegion = userProfile?.regions;
  const isCurrentMonth = selectedMonth === systemMonth;
  const monthLabel = getMonthLabel(selectedMonth);

  // ===== PERFORMANCE: Render charts with lazy loading =====
  const renderChart = useCallback((ChartComponent: any, props: any) => {
    if (chartError) return <ChartErrorFallback />;
    if (!chartModules || chartLoading) return <ChartLoader />;
    
    const { ResponsiveContainer } = chartModules;
    
    try {
      return (
        <div className="h-full w-full" style={{ contain: 'layout paint', minHeight: '150px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <ChartComponent {...props} />
          </ResponsiveContainer>
        </div>
      );
    } catch (err) {
      console.error('Chart render error:', err);
      return <ChartErrorFallback />;
    }
  }, [chartModules, chartLoading, chartError]);

  // ===== Memoized chart renders =====
  const renderPayrollChart = useMemo(() => {
    if (!dataReady || payrollHistory.length === 0) {
      return <ChartLoader />;
    }
    
    const { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } = chartModules || {};
    if (!LineChart) return <ChartLoader />;
    
    const data = payrollHistory.map(d => ({ ...d, amount: d.amount / 1000000 }));
    
    return renderChart(LineChart, {
      data,
      margin: { top: 10, right: 20, left: 0, bottom: 10 },
      children: (
        <>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#64748B' }} axisLine={{ stroke: '#e2e8f0' }} tickLine={false} />
          <YAxis tick={{ fontSize: 12, fill: '#64748B' }} axisLine={false} tickLine={false} tickFormatter={(v: any) => `${v}M`} />
          <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '12px' }} formatter={(v: any) => [`MK ${v}M`, 'Payroll']} />
          <Line type="monotone" dataKey="amount" stroke="#D4A017" strokeWidth={3} dot={{ fill: '#D4A017', strokeWidth: 2, r: 4, stroke: '#fff' }} activeDot={{ r: 6, fill: '#081C3A' }} />
        </>
      )
    });
  }, [payrollHistory, dataReady, chartModules, renderChart]);

  const renderAttendanceChart = useMemo(() => {
    if (!dataReady || attendanceData.length === 0) {
      return <ChartLoader />;
    }
    
    const { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } = chartModules || {};
    if (!BarChart) return <ChartLoader />;
    
    return renderChart(BarChart, {
      data: attendanceData,
      margin: { top: 10, right: 20, left: 0, bottom: 10 },
      children: (
        <>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#64748B' }} axisLine={{ stroke: '#e2e8f0' }} tickLine={false} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 12, fill: '#64748B' }} axisLine={false} tickLine={false} tickFormatter={(v: any) => `${v}%`} />
          <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '12px' }} formatter={(v: any) => [`${v}%`, 'Attendance']} />
          <Bar dataKey="rate" fill="#081C3A" radius={[6, 6, 0, 0]} />
        </>
      )
    });
  }, [attendanceData, dataReady, chartModules, renderChart]);

  const renderPieChart = useMemo(() => {
    if (!dataReady || pieData.length === 0) {
      return <ChartLoader />;
    }
    
    const { PieChart, Pie, Cell, Tooltip } = chartModules || {};
    if (!PieChart) return <ChartLoader />;
    
    return renderChart(PieChart, {
      children: (
        <>
          <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={1}>
            {pieData.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
          </Pie>
          <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '12px' }} />
        </>
      )
    });
  }, [pieData, dataReady, chartModules, renderChart]);

  const renderGrowthChart = useMemo(() => {
    if (!dataReady || growthData.length === 0) {
      return <ChartLoader />;
    }
    
    const { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } = chartModules || {};
    if (!LineChart) return <ChartLoader />;
    
    return renderChart(LineChart, {
      data: growthData,
      margin: { top: 10, right: 20, left: 0, bottom: 10 },
      children: (
        <>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#64748B' }} axisLine={{ stroke: '#e2e8f0' }} tickLine={false} />
          <YAxis tick={{ fontSize: 12, fill: '#64748B' }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '12px' }} formatter={(v: any) => [`${v} employees`, 'Workforce']} />
          <Line type="monotone" dataKey="employees" stroke="#D4A017" strokeWidth={3} dot={{ fill: '#081C3A', strokeWidth: 2, r: 4, stroke: '#fff' }} />
        </>
      )
    });
  }, [growthData, dataReady, chartModules, renderChart]);

  // ===== Show loading state =====
  if (loading && initialLoad) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-500">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Hero greeting */}
      <Card className="p-6 bg-gradient-to-r from-[#081C3A] to-[#1a2f5c] text-white border-0">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <p className="text-[#D4A017] text-sm font-medium mb-1">{greeting}, {userName || 'User'}</p>
            <h2 className="text-2xl md:text-3xl font-bold mb-2">Welcome to Safeguard Control Center</h2>
            <p className="text-white/70 text-sm md:text-base max-w-2xl">
              {/* Not "real-time": this reflects the last load/refresh, not
                  an automatic live update -- see Refresh button below. */}
              {isSuperAdmin
                ? `Overview of all ${stats.total} active employees across all regions.`
                : `Overview of ${stats.total} active employees in ${userRegion?.name || 'your'} region.`}
              {stats.activeGuards} active security personnel across {stats.sitesCount} assigned sites.
            </p>
          </div>
          <div className="flex gap-3 flex-wrap">
            {/* Month Selector */}
            <div className="flex items-center gap-2 bg-white/10 rounded-lg px-2 py-1">
              <button
                onClick={goToPreviousMonth}
                className="p-1.5 rounded hover:bg-white/20 text-white disabled:opacity-50"
                disabled={loading || !availableMonths.includes(getPreviousMonth(selectedMonth))}
                title="Previous Month"
              >
                <ChevronLeft size={16} />
              </button>
              
              <select
                value={selectedMonth}
                onChange={(e) => handleMonthSelect(e.target.value)}
                className="bg-transparent border-none text-sm font-medium text-white focus:ring-0 py-1 min-w-[120px] text-center cursor-pointer"
              >
                {availableMonths.map((month) => (
                  <option key={month} value={month}>
                    {getMonthLabel(month)} {month === systemMonth ? '●' : ''}
                  </option>
                ))}
              </select>
              
              <button
                onClick={goToNextMonth}
                className="p-1.5 rounded hover:bg-white/20 text-white disabled:opacity-50"
                disabled={loading || !availableMonths.includes(getNextMonth(selectedMonth))}
                title="Next Month"
              >
                <ChevronRight size={16} />
              </button>
            </div>
            
            {!isCurrentMonth && (
              <button
                onClick={goToCurrentMonth}
                className="text-xs text-[#D4A017] hover:underline px-2 py-1 bg-white/10 rounded-lg"
              >
                Jump to Current
              </button>
            )}
            
            <Button 
              variant="secondary" 
              className="font-semibold"
              onClick={refreshData}
              disabled={refreshing}
            >
              <RefreshCw size={16} className={`mr-1 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      {/* Month indicator */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Showing data for <strong className="text-slate-700">{monthLabel}</strong>
          {isCurrentMonth ? ' (Current Month)' : ''}
        </p>
        {!isCurrentMonth && (
          <Badge color={selectedMonth > systemMonth ? 'blue' : 'yellow'}>
            {selectedMonth > systemMonth ? 'Future Month' : 'Past Month'}
          </Badge>
        )}
      </div>

      {/* Region indicator for non-admin */}
      {!isSuperAdmin && userRegion && (
        <Card className="p-3 bg-gradient-to-r from-[#081C3A]/5 to-transparent border-[#081C3A]/20">
          <p className="text-sm text-slate-600">
            Viewing dashboard for <strong className="text-[#081C3A]">{userRegion.name}</strong> region only
          </p>
        </Card>
      )}

      {/* Stats Cards - Load immediately, no chart dependencies */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Employees" value={String(stats.total)} icon={Users} accent="navy" sub={`${stats.activeGuards} Active Guards`} />
        {canViewPayroll && (
          // Agrees with the "Payroll Status" card below rather than
          // contradicting it: "MK 0" used to show even when NO payroll run
          // exists yet for the selected month (payrollStatusLabel would
          // simultaneously say "Not Processed" right next to it) --
          // indistinguishable from "we processed payroll and it totaled
          // zero". Reusing payrollStatusLabel here (no new state) means
          // the two can never disagree.
          <StatCard title="Monthly Payroll" value={payrollStatusLabel === 'Not Processed' ? 'Not Processed' : formatKwacha(stats.totalPayroll)} icon={Wallet} accent="gold" sub={`Period: ${monthLabel}`} />
        )}
        <StatCard title="On Leave" value={String(stats.onLeave)} icon={UserMinus} accent="red" sub="Currently on leave" />
        {canViewRecruitment && (
          <StatCard title="Pending Recruitment" value={String(stats.pendingRecruitment)} icon={ClipboardList} accent="blue" sub={`${stats.shortlistedRecruitment} shortlisted, ${stats.interviewedRecruitment} interviewed`} />
        )}
      </div>

      {/* Security Personnel Dashboard */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* "On duty now"/"Active monitoring" removed from these two cards --
            both counts come from position-keyword + status='Active' on the
            employee record (currently employed), not from any attendance/
            check-in/deployment signal, so neither can truthfully claim a
            live duty state. "Supervisors on Duty" renamed to "Active
            Supervisors" for the same reason -- "on duty" implies a real-
            time signal this measures don't provide. "Sites Covered" renamed
            to "Assigned Sites": the count is distinct `workstation` values
            on current employee records, not a live coverage/patrol signal. */}
        <StatCard title="Active Guards" value={String(stats.activeGuards)} icon={Shield} accent="green" sub="Currently employed" />
        <StatCard title="Assigned Sites" value={String(stats.sitesCount)} icon={MapPin} accent="navy" sub={`${stats.sitesCount} locations`} />
        <StatCard title="Active Supervisors" value={String(stats.supervisorsOnDuty)} icon={ShieldCheck} accent="blue" sub="Currently employed" />
        {canViewAttendance && (
          <StatCard title="Attendance Rate" value={`${stats.attendanceRate}%`} icon={CheckCircle2} accent="gold" sub={`${monthLabel}`} />
        )}
      </div>

      {/* Company & Resident Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard title="Companies" value={String(stats.companiesCount)} icon={Building2} accent="blue" sub="Active clients" />
        <StatCard title="Residents" value={String(stats.residentsCount)} icon={Home} accent="green" sub="Residential clients" />
      </div>

      {/* Quick status */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {canViewPayroll && (
          <Card className="p-4 flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${payrollStatusLabel === 'Approved' ? 'bg-emerald-100 text-emerald-600' : payrollStatusLabel === 'Pending Approval' ? 'bg-[#FFF1CC] text-[#D4A017]' : 'bg-slate-100 text-slate-500'}`}><CheckCircle2 size={20} /></div>
            <div><p className="text-xs text-slate-500">Payroll Status</p><p className="font-semibold text-slate-800 text-sm">{payrollStatusLabel}</p></div>
          </Card>
        )}
        {canViewAttendance && (
          <Card className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600"><TrendingUp size={20} /></div>
            <div><p className="text-xs text-slate-500">Attendance Rate</p><p className="font-semibold text-slate-800 text-sm">{stats.attendanceRate}%</p></div>
          </Card>
        )}
        {/* "On Duty Guards" removed -- it duplicated Active Guards' own
            number (stats.activeGuards) under a label implying a live
            duty/deployment signal the app doesn't actually measure
            (no attendance/check-in data feeds this count). Two cards
            showing the same number under different claimed meanings is
            worse than one accurate card. */}
        <Card className="p-4 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${dashboardFetchError ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-600'}`}><Bell size={20} /></div>
          <div>
            <p className="text-xs text-slate-500">Data Status</p>
            {/* Reflects whether the LAST Dashboard data fetch actually
                succeeded -- not a hardcoded "Online" -- see
                dashboardFetchError, set in fetchDashboardData()'s own
                catch block below. */}
            <p className={`font-semibold text-sm ${dashboardFetchError ? 'text-red-600' : 'text-slate-800'}`}>{dashboardFetchError ? 'Load Failed' : 'Up to Date'}</p>
          </div>
        </Card>
      </div>

      {/* Charts row 1 - Lazy loaded */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {canViewPayroll && (
          <Card className="p-5 lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <div><h3 className="font-semibold text-slate-800">Monthly Payroll Trend</h3><p className="text-xs text-slate-500">Last 6 months payroll expenditure</p></div>
              <Badge color="gold">{monthLabel}</Badge>
            </div>
            <div className="h-64">
              {renderPayrollChart}
            </div>
          </Card>
        )}

        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div><h3 className="font-semibold text-slate-800">Department Distribution</h3><p className="text-xs text-slate-500">Employees by department</p></div>
          </div>
          <div className="h-48">
            {renderPieChart}
          </div>
          <div className="grid grid-cols-2 gap-1 mt-2">
            {pieData.slice(0, 4).map((d, i) => (
              <div key={d.name} className="flex items-center gap-2 text-xs">
                <span className="w-2 h-2 rounded-full" style={{ background: COLORS[i] }} />
                <span className="text-slate-600 truncate">{d.name}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Charts row 2 - Lazy loaded */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {canViewAttendance && (
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div><h3 className="font-semibold text-slate-800">Attendance Trend</h3><p className="text-xs text-slate-500">Workforce attendance percentage</p></div>
              <Badge color="green">{stats.attendanceRate}% ({monthLabel})</Badge>
            </div>
            <div className="h-56">
              {renderAttendanceChart}
            </div>
          </Card>
        )}

        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div><h3 className="font-semibold text-slate-800">Employee Growth</h3><p className="text-xs text-slate-500">Workforce headcount since the system started (June 2026)</p></div>
            <Badge color="navy">{stats.total} Total</Badge>
          </div>
          <div className="h-56">
            {renderGrowthChart}
          </div>
        </Card>
      </div>

      {/* Employees + tasks */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 overflow-hidden">
          <div className="flex items-center justify-between p-5 border-b border-slate-100">
            <div><h3 className="font-semibold text-slate-800">Recent Active Employees</h3><p className="text-xs text-slate-500">Latest additions to your workforce</p></div>
            {/* "View all" removed -- it had no onClick handler at all (this
                app has no cross-page navigation prop threaded into page
                components today), so it was a decorative control that did
                nothing when clicked. Wiring it for real requires a small
                App.tsx-level change (passing a navigation callback into
                page components, which no page currently receives) -- a
                reasonable follow-up, not folded into this pass. */}
          </div>
          <Table className="border-0 rounded-none">
            <THead><TR hover={false}><TH>Name</TH><TH>Position</TH><TH>Department</TH><TH>Company/Resident</TH><TH>Status</TH></TR></THead>
            <TBody>
              {recent.map((emp: any) => {
                let entityName = '-';
                let entityIcon = null;
                if (emp.assignment_type === 'resident' && emp.resident_name) {
                  entityName = emp.resident_name;
                  entityIcon = '🏠';
                } else if (emp.company) {
                  entityName = emp.company;
                  entityIcon = '🏢';
                }
                return (
                  <TR key={emp.id}>
                    <TD>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-[#081C3A] flex items-center justify-center text-white text-xs font-bold">
                          {emp.full_name?.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-slate-800">{emp.full_name}</p>
                          <p className="text-xs text-slate-500">{emp.employee_number}</p>
                        </div>
                      </div>
                    </TD>
                    <TD>{emp.position}</TD>
                    <TD>{emp.department}</TD>
                    <TD>
                      {entityIcon && (
                        <span className="flex items-center gap-1 text-xs">
                          <span>{entityIcon}</span>
                          <span className="truncate max-w-[80px]">{entityName}</span>
                        </span>
                      )}
                    </TD>
                    <TD><Badge color={emp.status === 'Active' ? 'green' : emp.status === 'On Leave' ? 'yellow' : 'red'}>{emp.status}</Badge></TD>
                  </TR>
                );
              })}
              {recent.length === 0 && (
                <TR><TD colSpan={5} className="text-center py-4 text-slate-500">No active employees found</TD></TR>
              )}
            </TBody>
          </Table>
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between p-5 border-b border-slate-100">
            <h3 className="font-semibold text-slate-800">Pending Tasks</h3><span className="text-xs text-slate-500">{pendingTasks.length} items</span>
          </div>
          <div className="p-3 space-y-2">
            {pendingTasks.map((t, i) => {
              const Icon = pendingTaskIcons[t.key];
              const priorityClass = t.priority === 'high' ? 'bg-red-100 text-red-600' : t.priority === 'medium' ? 'bg-[#FFF1CC] text-[#D4A017]' : 'bg-slate-100 text-slate-600';
              return (
                <div key={i} className="p-3 rounded-lg hover:bg-slate-50 cursor-pointer">
                  <div className="flex items-start gap-3">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${priorityClass}`}>
                      <Icon size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800">{t.title} — {t.count}</p>
                      <p className="text-xs text-slate-500 mt-0.5">Due: {t.due}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default Dashboard;