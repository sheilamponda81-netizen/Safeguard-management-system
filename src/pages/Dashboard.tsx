import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
  Users, Wallet, UserMinus, ClipboardList, CheckCircle2, TrendingUp, 
  ArrowRight, Bell, ShieldCheck, Calendar, Shield, MapPin, 
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

// ===== PERFORMANCE: Lazy load charts with dynamic import =====
const COLORS = ['#081C3A', '#D4A017', '#3B82F6', '#10B981', '#EF4444', '#8B5CF6', '#F59E0B', '#64748B', '#06B6D4'];

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
  const [employees, setEmployees] = useState<any[]>([]);
  const [applicantsCount, setApplicantsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState('');
  const [userInitials, setUserInitials] = useState('');
  const [greeting, setGreeting] = useState('Good morning');
  const [userProfile, setUserProfile] = useState<any>(null);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [systemMonth, setSystemMonth] = useState('');
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  
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
  const [dataReady, setDataReady] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);

  // ===== MEMOIZED PENDING TASKS =====
  const pendingTasks = useMemo(() => [
    { title: 'Approve Payroll', due: 'Today', priority: 'high', icon: Wallet },
    { title: 'Review Job Applications', due: 'Tomorrow', priority: 'medium', icon: ClipboardList },
    { title: 'Process Leave Requests', due: '2 days', priority: 'medium', icon: Calendar },
    { title: 'Renew Expiring Licenses', due: 'This Week', priority: 'high', icon: Shield }
  ], []);

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
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const profile = await getCurrentProfile();
        setUserProfile(profile);
        const name = profile?.full_name || user.email?.split('@')[0] || 'User';
        setUserName(name);
        const initials = name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();
        setUserInitials(initials || 'U');
      }
    };
    getUserInfo();
    setGreeting(getTimeBasedGreeting());
    
    const interval = setInterval(() => {
      setGreeting(getTimeBasedGreeting());
    }, 60000);
    
    return () => clearInterval(interval);
  }, [getTimeBasedGreeting]);

  useEffect(() => {
    if (userProfile && selectedMonth) {
      fetchDashboardData();
    }
  }, [userProfile, selectedMonth]);

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

  const refreshData = useCallback(async () => {
    setRefreshing(true);
    chartsLoadedRef.current = false;
    setChartModules(null);
    await fetchDashboardData();
    showNotification('Dashboard updated', 'success');
    setRefreshing(false);
  }, []);

  // ===== OPTIMIZED: Fetch dashboard data with parallel queries =====
  const fetchDashboardData = useCallback(async () => {
    setLoading(true);
    setInitialLoad(true);
    
    try {
      // ===== CRITICAL: Exclude deleted employees =====
      let employeesQuery = supabase
        .from('employees')
        .select('*')
        .eq('is_deleted', false);
      
      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        employeesQuery = employeesQuery.eq('region_id', userProfile.region_id);
      }
      
      const [employeesRes, applicantsRes, shortlistedRes, interviewedRes] = await Promise.all([
        employeesQuery,
        supabase.from('applicants').select('id', { count: 'exact', head: false }).eq('interview_status', 'Pending'),
        supabase.from('applicants').select('id', { count: 'exact', head: false }).eq('interview_status', 'Shortlisted'),
        supabase.from('applicants').select('id', { count: 'exact', head: false }).eq('interview_status', 'Interviewed')
      ]);

      const employeesData = employeesRes.data || [];
      setEmployees(employeesData);
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
      
      const totalPayroll = employeesData.reduce((sum: number, e: any) => sum + (e.basic_salary || 0), 0);
      
      const onLeave = employeesData.filter((e: any) => e.status === 'On Leave').length;
      
      // ===== ACCURATE ATTENDANCE RATE =====
      let attendanceRate = 0;
      if (employeesData.length > 0) {
        const monthStart = `${selectedMonth}-01`;
        const lastDay = new Date(parseInt(selectedMonth.split('-')[0]), parseInt(selectedMonth.split('-')[1]), 0).getDate();
        const monthEnd = `${selectedMonth}-${String(lastDay).padStart(2, '0')}`;
        
        let attendanceQuery = supabase
          .from('attendance')
          .select('status')
          .gte('date', monthStart)
          .lte('date', monthEnd);
        
        if (employeeIds.length > 0) {
          attendanceQuery = attendanceQuery.in('employee_id', employeeIds);
        }
        
        const { data: attendanceRecords } = await attendanceQuery;
        
        if (attendanceRecords && attendanceRecords.length > 0) {
          let presentCount = 0;
          let totalRecords = 0;
          attendanceRecords.forEach(record => {
            if (record.status !== '-') {
              totalRecords++;
              if (record.status === 'P') presentCount++;
            }
          });
          attendanceRate = totalRecords > 0 ? Math.round((presentCount / totalRecords) * 100) : 0;
        }
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
        pendingRecruitment: applicantsRes.count || 0,
        shortlistedRecruitment: shortlistedRes.count || 0,
        interviewedRecruitment: interviewedRes.count || 0,
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
      
      // ===== RECENT HIRES (non-deleted, active employees) =====
      setRecent(employeesData.slice(0, 6));
      
      // ===== GROWTH DATA — real cumulative headcount per month, starting from
      // the system's actual start month (June 2026), not a fabricated
      // multi-year history the system never existed for. =====
      const chartMonths = getChartMonths(selectedMonth);
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

      const growth = chartMonths.map(month => {
        const [year, monthNum] = month.split('-').map(Number);
        const monthName = monthNames[monthNum - 1];
        const lastDay = new Date(year, monthNum, 0).getDate();
        const monthEnd = `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const count = employeesData.filter((e: any) => e.hire_date && e.hire_date <= monthEnd).length;
        return { month: `${monthName} ${year}`, employees: count };
      });
      setGrowthData(growth);

      // ===== PAYROLL HISTORY — real net pay totals per month from the
      // `payroll` table. A month with no processed payroll run shows 0,
      // never a fabricated estimate. =====
      let payrollQuery = supabase.from('payroll').select('month, net_pay, employee_id, approval_status');
      if (employeeIds.length > 0) {
        payrollQuery = payrollQuery.in('employee_id', employeeIds);
      }
      const { data: allPayrollRecords } = await payrollQuery;

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

      const historyData = chartMonths.map(month => {
        const [year, monthNum] = month.split('-').map(Number);
        const monthName = monthNames[monthNum - 1];
        return {
          month: `${monthName} ${year}`,
          amount: payrollTotalsByMonthKey.get(month) || 0
        };
      });
      setPayrollHistory(historyData);

      // ===== ATTENDANCE DATA - Starting from June 2026 =====
      // Single query spanning the whole 6-month window, grouped by month
      // client-side, instead of one sequential await per month.
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

      let allAttendanceRecords: { date: string; status: string }[] = [];
      if (monthRanges.length > 0 && employeeIds.length > 0) {
        const { data: records } = await supabase
          .from('attendance')
          .select('date, status')
          .gte('date', monthRanges[0].startDate)
          .lte('date', monthRanges[monthRanges.length - 1].endDate)
          .in('employee_id', employeeIds);
        allAttendanceRecords = records || [];
      }

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
    } finally {
      setLoading(false);
    }
  }, [selectedMonth, userProfile]);

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
              {isSuperAdmin 
                ? `Real-time overview of all ${stats.total} active employees across all regions.`
                : `Real-time overview of ${stats.total} active employees in ${userRegion?.name || 'your'} region.`}
              {stats.activeGuards} security personnel deployed across {stats.sitesCount} sites.
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
          <Badge color={selectedMonth > systemMonth ? 'blue' : 'amber'}>
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
        <StatCard title="Monthly Payroll" value={stats.totalPayroll > 0 ? formatKwacha(stats.totalPayroll) : 'MK 0'} icon={Wallet} accent="gold" sub={`Period: ${monthLabel}`} />
        <StatCard title="On Leave" value={String(stats.onLeave)} icon={UserMinus} accent="red" sub="Currently on leave" />
        <StatCard title="Pending Recruitment" value={String(stats.pendingRecruitment)} icon={ClipboardList} accent="blue" sub={`${stats.shortlistedRecruitment} shortlisted, ${stats.interviewedRecruitment} interviewed`} />
      </div>

      {/* Security Personnel Dashboard */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Active Guards" value={String(stats.activeGuards)} icon={Shield} accent="green" sub="On duty now" />
        <StatCard title="Sites Covered" value={String(stats.sitesCount)} icon={MapPin} accent="navy" sub={`${stats.sitesCount} locations`} />
        <StatCard title="Supervisors on Duty" value={String(stats.supervisorsOnDuty)} icon={ShieldCheck} accent="blue" sub="Active monitoring" />
        <StatCard title="Attendance Rate" value={`${stats.attendanceRate}%`} icon={CheckCircle2} accent="gold" sub={`${monthLabel}`} />
      </div>

      {/* Company & Resident Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard title="Companies" value={String(stats.companiesCount)} icon={Building2} accent="blue" sub="Active clients" />
        <StatCard title="Residents" value={String(stats.residentsCount)} icon={Home} accent="green" sub="Residential clients" />
      </div>

      {/* Quick status */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${payrollStatusLabel === 'Approved' ? 'bg-emerald-100 text-emerald-600' : payrollStatusLabel === 'Pending Approval' ? 'bg-[#FFF1CC] text-[#D4A017]' : 'bg-slate-100 text-slate-500'}`}><CheckCircle2 size={20} /></div>
          <div><p className="text-xs text-slate-500">Payroll Status</p><p className="font-semibold text-slate-800 text-sm">{payrollStatusLabel}</p></div>
        </Card>
        <Card className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600"><TrendingUp size={20} /></div>
          <div><p className="text-xs text-slate-500">Attendance Rate</p><p className="font-semibold text-slate-800 text-sm">{stats.attendanceRate}%</p></div>
        </Card>
        <Card className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#FFF1CC] flex items-center justify-center text-[#D4A017]"><ShieldCheck size={20} /></div>
          <div><p className="text-xs text-slate-500">On Duty Guards</p><p className="font-semibold text-slate-800 text-sm">{stats.activeGuards}</p></div>
        </Card>
        <Card className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center text-emerald-600"><Bell size={20} /></div>
          <div><p className="text-xs text-slate-500">System Status</p><p className="font-semibold text-slate-800 text-sm">Online</p></div>
        </Card>
      </div>

      {/* Charts row 1 - Lazy loaded */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div><h3 className="font-semibold text-slate-800">Monthly Payroll Trend</h3><p className="text-xs text-slate-500">Last 6 months payroll expenditure</p></div>
            <Badge color="gold">{monthLabel}</Badge>
          </div>
          <div className="h-64">
            {renderPayrollChart}
          </div>
        </Card>

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
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div><h3 className="font-semibold text-slate-800">Attendance Trend</h3><p className="text-xs text-slate-500">Workforce attendance percentage</p></div>
            <Badge color="green">{stats.attendanceRate}% ({monthLabel})</Badge>
          </div>
          <div className="h-56">
            {renderAttendanceChart}
          </div>
        </Card>

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
            <Button variant="outline" className="text-xs py-1.5">View all <ArrowRight size={14} /></Button>
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
            <h3 className="font-semibold text-slate-800">Pending Tasks</h3><span className="text-xs text-slate-500">4 items</span>
          </div>
          <div className="p-3 space-y-2">
            {pendingTasks.map((t, i) => {
              const Icon = t.icon;
              const priorityClass = t.priority === 'high' ? 'bg-red-100 text-red-600' : t.priority === 'medium' ? 'bg-[#FFF1CC] text-[#D4A017]' : 'bg-slate-100 text-slate-600';
              return (
                <div key={i} className="p-3 rounded-lg hover:bg-slate-50 cursor-pointer">
                  <div className="flex items-start gap-3">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${priorityClass}`}>
                      <Icon size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800">{t.title}</p>
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