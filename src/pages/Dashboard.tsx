import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Users, Wallet, UserMinus, ClipboardList, CheckCircle2, TrendingUp,
  Bell, ShieldCheck, Shield, MapPin, Banknote,
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
import { countRegisteredAsOf, countPendingPayrollMonths } from '../utils/dashboardMetrics';
import { getPayrollRates } from '../utils/payrollSettings';
import { AttendanceCount } from '../utils/payrollCalculations';
import { PAYABLE_EMPLOYEE_STATUSES } from '../utils/employeeStatus';
import { fetchSalaryAdvanceDeductionByEmployee } from '../utils/livePayrollEstimate';
import { reconcileMonthlyPayroll, MonthProcessingState, ReconciliationEmployee, StoredPayrollRow } from '../utils/payrollReconciliation';
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
  // Terminal Dues approve/pay tasks: gated the same narrow way
  // TerminalDues.tsx itself gates its Approve/Record Payment actions --
  // see resolveDashboardPermissions() (dashboardPermissions.ts).
  const [canApproveTerminalDues, setCanApproveTerminalDues] = useState(false);
  const [canPayTerminalDues, setCanPayTerminalDues] = useState(false);
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
  // Financial-reliability patch (Defect 1/2): the per-employee
  // reconciliation state (see reconcileMonthlyPayroll()) for the
  // selected month -- 'unprocessed' | 'partial' | 'fully_processed'.
  // 'partial' means some payable employees are stored, some are still
  // estimated -- the card must label this "Provisional", never present
  // it as final approved payroll expenditure.
  const [monthlyPayrollState, setMonthlyPayrollState] = useState<MonthProcessingState>('unprocessed');
  // true when at least one employee needed a live estimate (attendance/
  // payroll-rates/positions/salary-advance data) and that data could not
  // be fetched -- the card MUST render an explicit "Unavailable" state
  // instead of any dollar figure when this is true (see
  // payrollReconciliation.ts's own header: a total that silently omits
  // whichever employees could not be estimated is exactly the
  // "plausible but incorrect" figure this exists to prevent).
  const [payrollEstimateUnavailable, setPayrollEstimateUnavailable] = useState(false);
  // true while the payroll card's own data is being (re)fetched for the
  // currently selected month -- used to blank/dim the card instead of
  // leaving a PREVIOUS month's total visible under a newly selected month
  // while the new month's figure is still in flight.
  const [payrollCardLoading, setPayrollCardLoading] = useState(false);
  // Monotonically increasing per-fetch token: a slow, in-flight request
  // for an earlier `selectedMonth` must never overwrite the card with its
  // (now stale) result after the user has already moved on to a
  // different month -- see the guard at the top/bottom of the payroll
  // reconciliation block below.
  const payrollRequestTokenRef = useRef(0);
  // Real count of the selected month's processed-but-not-yet-approved
  // payroll rows, in the caller's own authorized scope -- feeds the
  // "Approve Payroll" pending task's visibility/count. 0 by default (fail-
  // closed): never set except from the actual payroll fetch below.
  const [pendingPayrollApprovalCount, setPendingPayrollApprovalCount] = useState(0);
  // Real counts of authorized terminal_dues rows by status -- a plain
  // head-count query (no rows fetched), never an employee_id IN-list
  // batch: terminal_dues's own SELECT RLS already restricts to the
  // caller's tenant/region/permission (20260817000002 PART 5), so no
  // client-side re-filtering is needed just to count. 0 by default
  // (fail-closed): never set except from the actual count fetch below.
  const [pendingTerminalDuesApprovalCount, setPendingTerminalDuesApprovalCount] = useState(0);
  const [approvedTerminalDuesPaymentCount, setApprovedTerminalDuesPaymentCount] = useState(0);
  const [dataReady, setDataReady] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  // Real connectivity/data-fetch signal for the "Data Load" card --
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
      canApproveTerminalDues,
      pendingTerminalDuesApprovalCount,
      canPayTerminalDues,
      approvedTerminalDuesPaymentCount,
    }),
    [
      canApprovePayroll, pendingPayrollApprovalCount, canViewRecruitment, stats.pendingRecruitment,
      canViewSecurity, stats.expiringLicenses,
      canApproveTerminalDues, pendingTerminalDuesApprovalCount, canPayTerminalDues, approvedTerminalDuesPaymentCount,
    ]
  );
  const pendingTaskIcons: Record<PendingTask['key'], typeof Wallet> = {
    'approve-payroll': Wallet,
    'review-applications': ClipboardList,
    'renew-licenses': Shield,
    'approve-terminal-dues': CheckCircle2,
    'pay-terminal-dues': Banknote,
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
      setCanApproveTerminalDues(false);
      setCanPayTerminalDues(false);
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
          setCanApproveTerminalDues(permissions.canApproveTerminalDues);
          setCanPayTerminalDues(permissions.canPayTerminalDues);
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
    // Financial-reliability patch: a new fetch (including one triggered by
    // changing `selectedMonth`) must immediately stop presenting whatever
    // payroll figure was on screen for the PREVIOUS month/request -- the
    // card renders its own loading state (never a stale total) until this
    // fetch's own payroll block (further below) resolves and passes its
    // own race-guard token check.
    setPayrollCardLoading(true);
    setPayrollEstimateUnavailable(false);
    const payrollRequestToken = ++payrollRequestTokenRef.current;

    try {
      // ===== CRITICAL: Exclude deleted employees =====
      // Reads from `employees_general` (20260817000008), not `employees`
      // directly -- same row-level tenant/region access. As of
      // 20260817000008, `employees_general` no longer carries the 8 guard/
      // security-only columns at all (they were NULLed for an unprivileged
      // caller in the earlier 20260817000005 shape; now they are entirely
      // absent from this view for EVERY caller, privileged or not) -- any
      // guard-only field (e.g. license_status, used below for the expiring-
      // licenses count) must be read from `employees_security` instead,
      // gated by `canViewSecurity`, exactly like the applicant-counts RPC
      // below is gated by `canViewRecruitment`.
      // Ordered by `hire_date` DESC, not `created_at` DESC: "Recent Active
      // Employees" below (`employeesData.slice(0, 6)`) is captioned "Latest
      // additions to your workforce" -- that is a claim about hire_date
      // (when someone joined the workforce), not created_at (when the row
      // was entered into Safeguard). The Add Employee form's Date Hired
      // field is a free date picker defaulting to today but editable to
      // any past date (see Employees.tsx's dateHired field), so a
      // backfilled/historical hire entered today would wrongly show as the
      // "latest addition" under created_at ordering even though they
      // joined the workforce months ago. `nullsFirst: false` keeps a row
      // with no hire_date at all from wrongly sorting to the very top.
      let employeesQuery = supabase
        .from('employees_general')
        .select('*')
        .eq('is_deleted', false)
        .order('hire_date', { ascending: false, nullsFirst: false });
      
      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        employeesQuery = employeesQuery.eq('region_id', userProfile.region_id);
      }
      
      const employeesRes = await employeesQuery;

      // ===== Employee Growth history source -- deliberately a SEPARATE,
      // unfiltered-by-is_deleted fetch, not derived from `employeesData`
      // above =====
      // This chart cannot show real historical ACTIVE headcount, only
      // cumulative REGISTRATIONS -- confirmed by tracing every path that
      // ends someone's employment: `employees.status` is free TEXT with no
      // CHECK constraint and no schema column recording when it changed
      // (no termination_date/status_changed_at anywhere), and Security.tsx
      // exposes its own guardStatusList = ['Active','On Leave','Suspended',
      // 'Terminated'] whose Edit Guard save path does
      // `.update({ status: updatedGuard.status, ... })` with NO is_deleted/
      // deleted_at touched at all -- so an employee can be genuinely
      // terminated (status='Terminated') while deleted_at stays NULL
      // forever, invisible to any deleted_at-based "did they leave"
      // filter. Employees.tsx's own soft-delete (is_deleted/deleted_at) is
      // a second, independent departure path with no guarantee the first
      // one was also used. With no schema-provable timestamp covering
      // every departure route, subtracting departures at all would silently
      // under-report some past months and not others -- worse than not
      // attempting it. So this deliberately counts hire_date registrations
      // only, forever, once hired: a number the schema can actually prove.
      // Same tenant/region scope as the query above (is_deleted is an
      // application-level filter here, not an RLS restriction, confirmed
      // by reading employees_general's own definition) -- soft-deleted
      // rows are deliberately included too, since they were still real
      // registrations. Only `hire_date`/`region_id` are selected.
      let growthHistoryQuery = supabase
        .from('employees_general')
        .select('hire_date, region_id');
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

      // `license_status` is one of the 8 guard/security-only fields Step 18
      // (20260817000008) removed from `employees_general` entirely -- it is
      // only ever present in `employees_security`, which applies its own
      // server-side WHERE-clause authorization (legacy-account bypass, or
      // super-admin/business-admin bypass, or `security_personnel.view`).
      // `canViewSecurity` is the exact client-side mirror of that same rule
      // (see resolveDashboardPermissions()/canAccess()), so gating this
      // fetch on it reproduces the identical authorization outcome the view
      // itself would enforce -- and, per the same permission-aware-fetching
      // pattern used above for `get_applicant_dashboard_counts()`, a caller
      // without security_personnel.view never even issues this request.
      let licenseStatusRows: { license_status: string | null }[] = [];
      if (canViewSecurity) {
        let licenseQuery = supabase
          .from('employees_security')
          .select('license_status')
          .eq('is_deleted', false);
        if (!userProfile?.is_super_admin && userProfile?.region_id) {
          licenseQuery = licenseQuery.eq('region_id', userProfile.region_id);
        }
        const licenseRes = await licenseQuery;
        if (licenseRes.error) {
          // Fails closed to zero, matching the applicant-counts RPC pattern
          // above -- a transient error must degrade this one stat, not the
          // whole Dashboard, and must never fall back to reading guard
          // fields off `employees_general` (they no longer exist there).
          console.error('Error fetching employee license statuses:', licenseRes.error);
        } else {
          licenseStatusRows = licenseRes.data || [];
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
      
      const expiringLicenses = licenseStatusRows.filter((e) =>
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
      // ordered hire_date DESC (see employeesQuery above), but that alone
      // doesn't guarantee status='Active' -- an employee currently On
      // Leave is non-deleted too, and this widget's own title claims
      // "Active" specifically (the same meaning "Active Guards"/"Active
      // Supervisors" use elsewhere on this page: status === 'Active').
      // Filtering (not re-querying) preserves the hire_date DESC order
      // already applied server-side.
      setRecent(employeesData.filter((e: any) => e.status === 'Active').slice(0, 6));

      // ===== GROWTH DATA — cumulative employees REGISTERED as of the end
      // of each month, starting from the system's actual start month (June
      // 2026), not a fabricated multi-year history the system never
      // existed for. NOT active headcount -- see growthHistoryQuery's own
      // comment above for why the schema cannot prove that (no timestamp
      // covers every departure path, so departures are never subtracted).
      // Uses `growthHistoryEmployees` (includes soft-deleted rows -- they
      // were still real registrations), not `employeesData` (is_deleted=
      // false only, which would silently drop anyone since deleted from
      // every past month's count too, understating history).
      // (`chartMonths`/`monthNames`/`monthRanges` were computed earlier,
      // alongside the merged attendance fetch, and are reused here.)
      const growth = chartMonths.map(month => {
        const [year, monthNum] = month.split('-').map(Number);
        const monthName = monthNames[monthNum - 1];
        const lastDay = new Date(year, monthNum, 0).getDate();
        const monthEnd = `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const count = countRegisteredAsOf(growthHistoryEmployees, monthEnd);
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
          gross_pay: number;
          paye: number;
          pension: number;
          employee_id: string;
          approval_status: string;
        }>(
          employeeIds,
          (batch, from, to, withCount) =>
            supabase
              .from('payroll')
              .select('month, net_pay, gross_pay, paye, pension, employee_id, approval_status', withCount ? { count: 'exact' } : undefined)
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

        // "Monthly Payroll" stat card -- per-employee reconciliation via
        // reconcileMonthlyPayroll() (payrollReconciliation.ts), mirroring
        // Payroll.tsx's own fetchData() exactly: isHistoricalMonth =
        // selectedMonth < systemMonth decides whether population comes
        // from stored `payroll` rows alone (any employee's CURRENT status
        // never retroactively excludes a historical row) or from today's
        // payable roster UNION anyone already stored this month, with
        // each employee using their stored row if one exists, otherwise a
        // live estimate. Replaces the previous all-or-nothing "zero stored
        // rows -> estimate everyone, one-or-more -> sum stored rows only"
        // split, which silently OMITTED every payable employee without a
        // row during a partially-processed month (Defect 2).
        const isHistoricalMonth = selectedMonth < systemMonth;
        const storedPayrollRowsForMonth: StoredPayrollRow[] = selectedMonthPayrollRecords.map((r: any) => ({
          employee_id: r.employee_id,
          gross_pay: r.gross_pay || 0,
          paye: r.paye || 0,
          pension: r.pension || 0,
          net_pay: r.net_pay || 0,
          approval_status: r.approval_status,
        }));
        // Same payable-employee whitelist Payroll.tsx's own branch-B roster
        // query uses (Active + On Leave only) -- `employeesData` here is
        // only filtered by is_deleted=false at the SQL level, which would
        // otherwise also feed in a non-deleted-but-non-payable employee
        // (e.g. 'Terminated'/'Suspended') for a forward-looking estimate.
        // This population is used ONLY as the live-estimate candidate set
        // (and, for a current/future month, unioned with anyone already
        // stored) -- never to filter a historical month's stored rows,
        // which is exactly the retroactive-exclusion bug this patch fixes.
        const currentPayableEmployees: ReconciliationEmployee[] = employeesData
          .filter((e: any) => PAYABLE_EMPLOYEE_STATUSES.includes(e.status))
          .map((e: any) => ({ id: e.id, basic_salary: e.basic_salary, position: e.position, uniform_deduction: e.uniform_deduction }));

        const storedIds = new Set(storedPayrollRowsForMonth.map(r => r.employee_id));
        const needsLiveEstimate = !isHistoricalMonth && currentPayableEmployees.some(e => !storedIds.has(e.id));

        let liveEstimateInputs: Parameters<typeof reconcileMonthlyPayroll>[3];
        if (!needsLiveEstimate) {
          // Either a historical month (never estimated) or every payable
          // employee already has a stored row -- no estimate needed at
          // all, so this fetch is skipped entirely, exactly preserving the
          // "an already-processed month never pays this cost" property.
          liveEstimateInputs = undefined;
        } else {
          try {
            // FAIL-CLOSED (Defect 1): a SINGLE Promise.all with NO
            // per-input catch -- unlike the previous version, a failure in
            // ANY of these four required inputs must abort the WHOLE
            // estimate rather than silently substituting an empty/default
            // map for just that one input. Silently treating a failed
            // salary-advance (or attendance, or rates, or uniform-
            // eligibility) fetch as "zero" does not UNDERESTIMATE net pay
            // -- omitting a real deduction OVERSTATES it, which is exactly
            // the "plausible but incorrect total" this patch exists to
            // prevent. See payrollReconciliation.ts's own header for the
            // full contract.
            const [payrollRates, positionsRequiringUniformMap, attendanceRpcRows, salaryAdvanceByEmployeeId] = await Promise.all([
              getPayrollRates(),
              (async () => {
                const { data, error } = await supabase.from('positions').select('name, requires_uniform');
                if (error) throw error;
                return new Map((data || []).map((p: any) => [p.name, p.requires_uniform !== false]));
              })(),
              employeeIds.length === 0
                ? Promise.resolve([] as { employee_id: string; absent_days: number; late_days: number }[])
                : (async () => {
                    const { data, error } = await supabase.rpc('get_payroll_attendance_counts', {
                      p_employee_ids: employeeIds,
                      p_month: selectedMonth,
                    });
                    if (error) throw error;
                    return (data || []) as { employee_id: string; absent_days: number; late_days: number }[];
                  })(),
              // Same pooled-allocation formula Payroll.tsx's own preview
              // uses (fetchSalaryAdvanceDeductionByEmployee mirrors its
              // fetch and calls the same calculatePooledAllocation()) --
              // see livePayrollEstimate.ts's own header. A failure here
              // now propagates (no .catch()) so it aborts this ENTIRE
              // Promise.all, exactly like the other three required inputs.
              fetchSalaryAdvanceDeductionByEmployee(employeeIds, selectedMonth),
            ]);
            const attendanceByEmployeeId = new Map<string, AttendanceCount>(
              attendanceRpcRows.map(r => [r.employee_id, { absentDays: r.absent_days, lateDays: r.late_days }])
            );
            liveEstimateInputs = { attendanceByEmployeeId, positionsRequiringUniform: positionsRequiringUniformMap, payrollRates, salaryAdvanceByEmployeeId };
          } catch (estimateErr) {
            console.error('Error fetching required inputs for the payroll estimate -- reconciliation will report unavailable:', estimateErr);
            liveEstimateInputs = undefined; // reconcileMonthlyPayroll() below sets unavailable:true for the affected employees
          }
        }

        const reconciliation = reconcileMonthlyPayroll(isHistoricalMonth, currentPayableEmployees, storedPayrollRowsForMonth, liveEstimateInputs);

        // RACE GUARD: a slower request for an EARLIER selectedMonth must
        // never overwrite the card with its now-stale result after the
        // user has already moved on to viewing a different month -- the
        // newer request's own (already-applied, or still in-flight) state
        // wins instead. Silently discard, nothing else to do.
        if (payrollRequestToken === payrollRequestTokenRef.current) {
          setMonthlyPayrollState(reconciliation.state);
          setPayrollEstimateUnavailable(reconciliation.unavailable);
          setPayrollCardLoading(false);
          setStats(prev => ({ ...prev, totalPayroll: reconciliation.unavailable ? 0 : reconciliation.totals.net_pay }));
        }

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
        setMonthlyPayrollState('unprocessed');
        setPayrollEstimateUnavailable(false);
        setPayrollCardLoading(false);
      }

      // ===== TERMINAL DUES — real counts feeding the "Terminal Dues
      // Awaiting Approval"/"Terminal Dues Awaiting Payment" pending tasks.
      // Deliberately a head-count query (count: 'exact', head: true, no
      // rows returned) against `terminal_dues` directly -- NOT an
      // employee_id IN-list batch like the payroll fetch above. Unlike
      // `payroll`, terminal_dues's own SELECT RLS already restricts rows
      // to the caller's tenant + region_allowed() + permission
      // (20260817000002 PART 5), so a plain filtered count is already
      // fully authorized server-side; re-deriving the same scope via a
      // client-side employee_id list here would just reintroduce the
      // oversized `.in(...)` request this rollout already removed
      // elsewhere. Each query only runs for a caller who actually holds
      // the matching explicit permission -- an HR Manager (view/create/
      // edit only, no terminal_dues.approve/.pay row) issues neither.
      if (canApproveTerminalDues) {
        const { count, error: pendingTdError } = await supabase
          .from('terminal_dues')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending');
        if (pendingTdError) throw pendingTdError;
        setPendingTerminalDuesApprovalCount(count || 0);
      } else {
        setPendingTerminalDuesApprovalCount(0);
      }
      if (canPayTerminalDues) {
        const { count, error: approvedTdError } = await supabase
          .from('terminal_dues')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'approved');
        if (approvedTdError) throw approvedTdError;
        setApprovedTerminalDuesPaymentCount(count || 0);
      } else {
        setApprovedTerminalDuesPaymentCount(0);
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
      // Guards against the payroll card getting stuck on "Loading…"
      // forever if something EARLIER in this function throws before the
      // payroll reconciliation block above ever runs/clears it itself --
      // but still respects the race-guard token, so THIS (possibly stale)
      // invocation's cleanup can never clear the loading flag out from
      // under a NEWER, still-in-flight request for a different month.
      if (payrollRequestToken === payrollRequestTokenRef.current) {
        setPayrollCardLoading(false);
      }
    }
  }, [selectedMonth, userProfile, canViewPayroll, canViewAttendance, canViewRecruitment, canViewSecurity, canApproveTerminalDues, canPayTerminalDues]);

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
          <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '12px' }} formatter={(v: any) => [`${v} employees`, 'Registered']} />
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
          payrollCardLoading ? (
            // A new fetch (e.g. the user just changed months) is in
            // flight -- never show the PREVIOUS month's total while this
            // one is still loading (Defect 1, requirement 9).
            <StatCard title="Monthly Payroll" value="Loading…" icon={Wallet} accent="gold" sub={`${monthLabel}`} />
          ) : payrollEstimateUnavailable ? (
            // Required financial inputs (attendance/payroll rates/uniform
            // eligibility/salary advances) could not be fetched -- never
            // display a total computed from incomplete data (Defect 1).
            // Not a StatCard: needs a Retry action, which StatCard's props
            // don't support and this patch does not extend that shared
            // component for.
            <Card className="p-5 border border-amber-200 bg-amber-50">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-slate-500 font-medium">Monthly Payroll</p>
                  <p className="text-2xl md:text-3xl font-bold text-amber-700 mt-2 tracking-tight">Unavailable</p>
                  <p className="text-xs text-slate-600 mt-1">Could not load required financial data for {monthLabel} -- figure withheld rather than shown incomplete.</p>
                  <Button size="sm" variant="outline" className="mt-3" onClick={refreshData} disabled={refreshing}>
                    <RefreshCw size={14} className={`mr-1 ${refreshing ? 'animate-spin' : ''}`} /> Retry
                  </Button>
                </div>
                <div className="w-11 h-11 rounded-lg flex items-center justify-center bg-amber-100 text-amber-600"><Wallet size={22} /></div>
              </div>
            </Card>
          ) : (
            // `monthlyPayrollState` agrees with the "Payroll Status" card
            // below (both ultimately derive from the same stored-rows
            // fetch) without conflating "processed" with "approved" --
            // 'partial' is explicitly labeled Provisional, never presented
            // as final approved payroll expenditure (Defect 2).
            <StatCard
              title={monthlyPayrollState === 'unprocessed' ? 'Projected Payroll' : monthlyPayrollState === 'partial' ? 'Provisional Payroll' : 'Monthly Payroll'}
              value={formatKwacha(stats.totalPayroll)}
              icon={Wallet}
              accent="gold"
              sub={
                monthlyPayrollState === 'unprocessed'
                  ? `Estimated net pay • ${monthLabel} • Not processed yet`
                  : monthlyPayrollState === 'partial'
                    ? `Provisional • ${monthLabel} • partially processed, not final`
                    : `Period: ${monthLabel}`
              }
            />
          )
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
            <p className="text-xs text-slate-500">Data Load</p>
            {/* Reflects whether the LAST Dashboard data fetch actually
                succeeded -- not a hardcoded "Online", and deliberately NOT
                worded as "Up to Date": this proves the fetch completed
                without error, not that the data is fresh (nothing on this
                page measures freshness/staleness). See dashboardFetchError,
                set in fetchDashboardData()'s own catch block below. */}
            <p className={`font-semibold text-sm ${dashboardFetchError ? 'text-red-600' : 'text-slate-800'}`}>{dashboardFetchError ? 'Load Failed' : 'Successful'}</p>
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
            <div><h3 className="font-semibold text-slate-800">Cumulative Employees Registered</h3><p className="text-xs text-slate-500">Total employees added since the system started (June 2026) -- not a live active-headcount figure</p></div>
            <Badge color="navy">{stats.total} Currently Active</Badge>
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