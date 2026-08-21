import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Wallet, Calculator, Check, FileText, CheckCircle2, ChevronRight, Save, TrendingUp, Users, DollarSign, AlertCircle, Shield, Lock, Calendar, ChevronLeft, ChevronRight as ChevronRightIcon, UserCheck, Clock, XCircle } from 'lucide-react';
import { Card, Button, Badge, PageHeader, THead, TBody, TR, TH, TD, Modal } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { getAvailableMonthsFromSystem, getSystemCurrentMonth, getMonthLabel, getNextMonth, getPreviousMonth } from '../utils/currentMonth';
import { EmptyState } from '../components/EmptyState';
import { CopyFromPreviousModal } from '../components/CopyFromPreviousModal';
import { sanitizeInput } from '../utils/securityHeaders';
import { logAudit } from '../utils/auditLogger';
import { showNotification } from '../utils/clickHandlers';
import { Pagination } from '../components/Pagination';
import { getPayrollRates, PayrollRates, DEFAULT_RATES } from '../utils/payrollSettings';
import { calculateLivePayroll } from '../utils/payrollCalculations';
import { getDefaultPageSize } from '../utils/uiSettings';
import { fetchInEmployeeIdBatches, dedupeById } from '../utils/employeeBatchFetch';

interface Employee {
  id: string;
  employee_number: string;
  full_name: string;
  position: string;
  department: string;
  basic_salary: number;
  status: string;
  is_deleted?: boolean;
  uniform_deduction?: number;
}

interface AttendanceCount {
  absentDays: number;
  lateDays: number;
}

interface PayrollRecord {
  id: string;
  employee_id: string;
  month: string;
  basic_salary: number;
  allowances: number;
  overtime: number;
  bonus: number;
  gross_pay: number;
  paye: number;
  pension: number;
  uniform_deduction: number;
  net_pay: number;
  processed_at: string;
  approval_status?: string;
  approved_by?: string;
  approved_at?: string;
  approval_notes?: string;
}

interface EmployeeDeduction {
  id: string;
  employee_id: string;
  month: string;
  absent_days: number;
  late_days: number;
  absent_deduction: number;
  late_deduction: number;
  lecture_missed: number;
  lecture_deduction: number;
  appearance_deduction: number;
  total_deductions: number;
}

export function PayrollPage() {
  // ===== ALL HOOKS AT TOP LEVEL =====
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [payrollRecords, setPayrollRecords] = useState<PayrollRecord[]>([]);
  const [employeeDeductions, setEmployeeDeductions] = useState<EmployeeDeduction[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [systemMonth, setSystemMonth] = useState('');
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processed, setProcessed] = useState(false);
  const [editingValues, setEditingValues] = useState<Record<string, Partial<PayrollRecord>>>({});
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [copySourceMonths, setCopySourceMonths] = useState<string[]>([]);
  const [processedMonths, setProcessedMonths] = useState<string[]>([]);
  const [processingStatus, setProcessingStatus] = useState('');
  const [canProcessPayroll, setCanProcessPayroll] = useState(false);
  const [canEditPayroll, setCanEditPayroll] = useState(false);
  const [canViewPayroll, setCanViewPayroll] = useState(false);
  const [canApprovePayroll, setCanApprovePayroll] = useState(false);
  const [approvalNotes, setApprovalNotes] = useState('');
  const [approvalStatus, setApprovalStatus] = useState<'approved' | 'rejected' | null>(null);
  const [isApproved, setIsApproved] = useState(false);
  const [approverName, setApproverName] = useState('');
  // Live attendance-derived absent/late counts for the selected month, keyed by
  // employee_id -- payroll deductions now always reflect real attendance directly,
  // with no separate manual "save deductions" step required.
  const [attendanceCounts, setAttendanceCounts] = useState<Map<string, AttendanceCount>>(new Map());
  // Position name -> whether that position's employees should get the uniform
  // deduction at all (Settings -> Positions -> "Requires Uniform").
  const [positionsRequiringUniform, setPositionsRequiringUniform] = useState<Map<string, boolean>>(new Map());
  const [payrollRates, setPayrollRatesState] = useState<PayrollRates>(DEFAULT_RATES);

  // ===== PAGINATION STATES =====
  const [payrollPage, setPayrollPage] = useState(1);
  const [payrollItemsPerPage, setPayrollItemsPerPage] = useState(20);
  useEffect(() => { getDefaultPageSize().then(setPayrollItemsPerPage); }, []);

  // ===== MEMOIZED VALUES =====
  const isCurrentMonth = useMemo(() => selectedMonth === systemMonth, [selectedMonth, systemMonth]);
  const isFutureMonthSelected = useMemo(() => selectedMonth > systemMonth, [selectedMonth, systemMonth]);
  const isMonthProcessed = useMemo(() => processedMonths.includes(selectedMonth), [processedMonths, selectedMonth]);

  const isMonthApproved = useMemo(() => {
    if (payrollRecords.length === 0) return false;
    return payrollRecords.every(record => record.approval_status === 'approved');
  }, [payrollRecords]);

  const isPendingApproval = useMemo(() => {
    if (payrollRecords.length === 0) return false;
    return !isMonthApproved && payrollRecords.some(record => record.approval_status !== 'approved');
  }, [payrollRecords, isMonthApproved]);

  // ===== FILTER EMPLOYEES =====
  const filteredEmployees = useMemo(() => {
    const safeSearch = sanitizeInput(search).toLowerCase();
    return employees.filter(e => 
      e.full_name?.toLowerCase().includes(safeSearch) ||
      e.employee_number?.toLowerCase().includes(safeSearch)
    );
  }, [employees, search]);

  // ===== PAGINATED EMPLOYEES =====
  const paginatedEmployees = useMemo(() => {
    const startIndex = (payrollPage - 1) * payrollItemsPerPage;
    const endIndex = Math.min(startIndex + payrollItemsPerPage, filteredEmployees.length);
    return filteredEmployees.slice(startIndex, endIndex);
  }, [filteredEmployees, payrollPage, payrollItemsPerPage]);

  // ===== RESET PAGE WHEN SEARCH CHANGES =====
  useEffect(() => {
    setPayrollPage(1);
  }, [search]);

  // ===== FETCH APPROVER NAME =====
  useEffect(() => {
    if (isApproved && payrollRecords.length > 0 && payrollRecords[0]?.approved_by) {
      const fetchApproverName = async () => {
        try {
          const { data, error } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', payrollRecords[0].approved_by)
            .maybeSingle();
          
          if (error) throw error;
          setApproverName(data?.full_name || payrollRecords[0].approved_by.slice(0, 8) + '...');
        } catch (err) {
          console.error('Error fetching approver name:', err);
          setApproverName(payrollRecords[0].approved_by.slice(0, 8) + '...');
        }
      };
      fetchApproverName();
    } else {
      setApproverName('');
    }
  }, [isApproved, payrollRecords]);

  // ===== FETCH USER PROFILE =====
  const fetchUserProfile = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('*, regions(*)')
        .eq('id', user.id)
        .maybeSingle();
      setUserProfile(profile);
      
      const isSuperAdmin = profile?.is_super_admin || false;
      const roleLevel = profile?.role_level || 4;
      
      setCanProcessPayroll(isSuperAdmin || roleLevel === 1);
      setCanEditPayroll(isSuperAdmin || roleLevel <= 2);
      setCanViewPayroll(isSuperAdmin || roleLevel <= 3);
      setCanApprovePayroll(isSuperAdmin || roleLevel === 1);
    }
  }, []);

  // ===== FETCH PROCESSED MONTHS =====
  const fetchProcessedMonths = useCallback(async () => {
    try {
      // payroll has no region_id column of its own -- for a non-super-admin,
      // scope through their region's employee ids first, otherwise the
      // "processed" (✅) badges in the month picker would reflect other
      // regions' processing status, not this admin's own region.
      let employeeIds: string[] | null = null;
      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        const { data: regionEmployees, error: empError } = await supabase
          .from('employees')
          .select('id')
          .eq('region_id', userProfile.region_id)
          .eq('is_deleted', false);
        if (empError) throw empError;
        employeeIds = (regionEmployees || []).map(e => e.id);
        if (employeeIds.length === 0) {
          setProcessedMonths([]);
          return;
        }
      }

      // `employeeIds` (region-scoped) can be as large as `employees` (all-
      // tenant) elsewhere in this file -- same oversized-IN-list risk, so it
      // goes through the same batched helper. A super admin (employeeIds ===
      // null, no region scoping needed) keeps the original single, unfiltered
      // query.
      let months: string[];
      if (employeeIds) {
        const rows = await fetchInEmployeeIdBatches<{ month: string }>(
          employeeIds,
          (batch, from, to, withCount) =>
            supabase
              .from('payroll')
              .select('month', withCount ? { count: 'exact' } : undefined)
              .in('employee_id', batch)
              .range(from, to)
        );
        months = rows.map(r => r.month);
      } else {
        const { data, error } = await supabase.from('payroll').select('month');
        if (error) throw error;
        months = (data || []).map(r => r.month);
      }

      const uniqueMonths = [...new Set(months)].sort().reverse();
      setProcessedMonths(uniqueMonths);
    } catch (err) {
      console.error('Error fetching processed months:', err);
    }
  }, [userProfile]);

  // ===== FETCH DATA =====
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      let employeesQuery = supabase
        .from('employees')
        .select('id, employee_number, full_name, position, department, basic_salary, status, is_deleted, uniform_deduction, region_id')
        .eq('is_deleted', false)
        .eq('status', 'Active');

      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        employeesQuery = employeesQuery.eq('region_id', userProfile.region_id);
      }

      const { data: employeesData, error: empError } = await employeesQuery;
      if (empError) throw empError;
      setEmployees(employeesData || []);

      // payroll/employee_deductions/attendance have no region_id column of
      // their own, so region scoping for a non-super-admin has to go through
      // this (already region-scoped) employee id list -- otherwise a regional
      // payroll manager would see, and could overwrite, every other region's
      // payroll too.
      const employeeIds = (employeesData || []).map(e => e.id);

      // ===== Live attendance-derived absent/late counts for this month =====
      const [yearStr, monthStr] = selectedMonth.split('-');
      const year = parseInt(yearStr, 10);
      const monthNum = parseInt(monthStr, 10);
      const monthStart = `${selectedMonth}-01`;
      const lastDay = new Date(year, monthNum, 0).getDate();
      const monthEnd = `${selectedMonth}-${String(lastDay).padStart(2, '0')}`;

      // PERFORMANCE CORRECTION: these four reads (payroll records, employee
      // deductions, attendance counts, positions) don't depend on each
      // other's results -- only on `employeeIds`/`selectedMonth`, already
      // known at this point -- so they're fetched concurrently via
      // Promise.all instead of one after another, roughly halving Payroll's
      // load-time critical path. Each one is still internally batched (see
      // src/utils/employeeBatchFetch.ts) for the same oversized employee_id
      // IN-list reason as before; only the sequencing between them changed.
      // The positions fetch keeps its own internal try/catch (see below) so
      // it resolves rather than rejects on failure, exactly as before --
      // safe to run inside the same Promise.all. If any of the other three
      // genuinely fails, Promise.all rejects before any state is set, so no
      // partial/stale data is ever displayed -- same fail-fast guarantee as
      // the previous sequential version, just evaluated together instead of
      // one at a time.
      const [payrollDataRaw, deductionsDataRaw, attendanceCountRows, positionsRequiringUniformMap] = await Promise.all([
        fetchInEmployeeIdBatches<PayrollRecord>(
          employeeIds,
          (batch, from, to, withCount) =>
            supabase
              .from('payroll')
              .select('*', withCount ? { count: 'exact' } : undefined)
              .eq('month', selectedMonth)
              .in('employee_id', batch)
              .range(from, to)
        ),
        fetchInEmployeeIdBatches<EmployeeDeduction>(
          employeeIds,
          (batch, from, to, withCount) =>
            supabase
              .from('employee_deductions')
              .select('*', withCount ? { count: 'exact' } : undefined)
              .eq('month', selectedMonth)
              .in('employee_id', batch)
              .range(from, to)
        ),
        fetchInEmployeeIdBatches<{ employee_id: string; status: string }>(
          employeeIds,
          (batch, from, to, withCount) =>
            supabase
              .from('attendance')
              .select('employee_id, status', withCount ? { count: 'exact' } : undefined)
              .gte('date', monthStart)
              .lte('date', monthEnd)
              .in('employee_id', batch)
              .range(from, to)
        ),
        // ===== Positions (for the "Requires Uniform" gate) =====
        // Isolated from the rest of this fetch: `requires_uniform` was added
        // by supabase/migrations/20260728000000_position_uniform_flag.sql,
        // which may not yet be applied to every environment this code runs
        // against. If that migration isn't present, PostgREST rejects the
        // whole query (unknown column) -- letting that throw here would take
        // down the entire Payroll page over one optional gate. On failure,
        // fall back to "every position requires a uniform" (the migration's
        // own DEFAULT true), matching pre-migration behavior exactly instead
        // of losing the rest of the page.
        (async () => {
          try {
            const { data: positionsData, error: positionsError } = await supabase
              .from('positions')
              .select('name, requires_uniform');
            if (positionsError) throw positionsError;
            return new Map((positionsData || []).map(p => [p.name, p.requires_uniform !== false]));
          } catch (positionsErr) {
            console.error('Error fetching position uniform flags (falling back to "all positions require uniform"):', positionsErr);
            return new Map<string, boolean>();
          }
        })(),
      ]);

      const payrollData = dedupeById(payrollDataRaw);
      setPayrollRecords(payrollData);

      if (payrollData.length > 0) {
        const allApproved = payrollData.every(r => r.approval_status === 'approved');
        setIsApproved(allApproved);
      } else {
        setIsApproved(false);
      }

      const deductionsData = dedupeById(deductionsDataRaw);
      setEmployeeDeductions(deductionsData);

      const counts = new Map<string, AttendanceCount>();
      attendanceCountRows.forEach(record => {
        const existing = counts.get(record.employee_id) || { absentDays: 0, lateDays: 0 };
        if (record.status === 'A') existing.absentDays += 1;
        if (record.status === 'L') existing.lateDays += 1;
        counts.set(record.employee_id, existing);
      });
      setAttendanceCounts(counts);

      setPositionsRequiringUniform(positionsRequiringUniformMap);

      setHasData((payrollData?.length || 0) > 0);

    } catch (err: any) {
      console.error('Error fetching data:', err);
      showNotification('Failed to load payroll data: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [selectedMonth, userProfile]);

  // ===== Shared payroll rates (PAYE rate/threshold, pension rate) from Settings =====
  useEffect(() => {
    getPayrollRates().then(setPayrollRatesState);
  }, []);

  // ===== LOOKUP INDEXES =====
  // With ~2000 employees, a linear .find() over payrollRecords/
  // employeeDeductions per employee (called from totals, from every render
  // of every table row, and from calculatePayroll for each employee during
  // processing) turns into millions of comparisons. Built once per fetch.
  const payrollByEmployee = useMemo(() => {
    const map = new Map<string, PayrollRecord>();
    payrollRecords.forEach(r => map.set(r.employee_id, r));
    return map;
  }, [payrollRecords]);

  const deductionsByEmployee = useMemo(() => {
    const map = new Map<string, EmployeeDeduction>();
    employeeDeductions.forEach(d => map.set(d.employee_id, d));
    return map;
  }, [employeeDeductions]);

  const employeesById = useMemo(() => {
    const map = new Map<string, Employee>();
    employees.forEach(e => map.set(e.id, e));
    return map;
  }, [employees]);

  // ===== GET EMPLOYEE DATA =====
  const getPayrollForEmployee = useCallback((employeeId: string): PayrollRecord | null => {
    return payrollByEmployee.get(employeeId) || null;
  }, [payrollByEmployee]);

  const getEmployeeDeduction = useCallback((employeeId: string): EmployeeDeduction | null => {
    return deductionsByEmployee.get(employeeId) || null;
  }, [deductionsByEmployee]);

  // ===== CALCULATE PAYROLL =====
  const calculatePayroll = useCallback((employee: Employee, customValues?: Partial<PayrollRecord>): PayrollRecord => {
    const basicSalary = customValues?.basic_salary ?? employee.basic_salary;
    const allowances = customValues?.allowances ?? 0;
    const overtime = customValues?.overtime ?? 0;
    const bonus = customValues?.bonus ?? 0;

    // Delegates to the shared calculateLivePayroll utility so Payroll and
    // Payments never diverge on what an unprocessed/unapproved month's numbers
    // should be -- Payments uses the exact same function for its live estimate.
    const deduction = getEmployeeDeduction(employee.id);
    const live = calculateLivePayroll({
      basicSalary,
      allowances,
      overtime,
      bonus,
      position: employee.position,
      employeeUniformDeduction: employee.uniform_deduction,
      positionsRequiringUniform,
      payrollRates,
      attendance: attendanceCounts.get(employee.id),
      lectureDeduction: deduction?.lecture_deduction,
      appearanceDeduction: deduction?.appearance_deduction,
    });

    const paye = customValues?.paye ?? live.paye;
    const pension = customValues?.pension ?? live.pension;
    const netPay = live.grossPay - paye - pension - live.uniformDeduction;

    return {
      id: '',
      employee_id: employee.id,
      month: selectedMonth,
      basic_salary: basicSalary,
      allowances,
      overtime,
      bonus,
      gross_pay: live.grossPay,
      paye,
      pension,
      uniform_deduction: live.uniformDeduction,
      net_pay: netPay,
      processed_at: new Date().toISOString(),
      approval_status: 'pending',
      approved_by: null,
      approved_at: null,
      approval_notes: null
    };
  }, [selectedMonth, getEmployeeDeduction, attendanceCounts, positionsRequiringUniform, payrollRates]);

  const getDisplayPayroll = useCallback((employee: Employee): PayrollRecord => {
    const existing = getPayrollForEmployee(employee.id);
    if (existing) return existing;
    const edited = editingValues[employee.id];
    return calculatePayroll(employee, edited);
  }, [getPayrollForEmployee, editingValues, calculatePayroll]);

  // ===== GET TOTALS =====
  const totals = useMemo(() => {
    let gross = 0, net = 0, paye = 0, pension = 0, uniformDeductions = 0;
    employees.forEach(emp => {
      const p = getDisplayPayroll(emp);
      gross += p.gross_pay;
      net += p.net_pay;
      paye += p.paye;
      pension += p.pension;
      uniformDeductions += p.uniform_deduction || 0;
    });
    return { gross, net, paye, pension, uniformDeductions };
  }, [employees, getDisplayPayroll]);

  const employeesWithDeductions = useMemo(() => {
    // Uses the same uniform_deduction total calculatePayroll actually produces
    // (position eligibility + live attendance + lecture/appearance), rather than
    // re-deriving it separately here and risking the two disagreeing.
    return employees.filter(emp => getDisplayPayroll(emp).uniform_deduction > 0);
  }, [employees, getDisplayPayroll]);

  // ===== UPDATE FIELD =====
  const updateField = useCallback((employeeId: string, field: keyof PayrollRecord, value: number) => {
    if (!canEditPayroll) {
      showNotification('You do not have permission to edit payroll values', 'error');
      return;
    }
    if (isApproved) {
      showNotification('Cannot edit approved payroll. Please unapprove first.', 'error');
      return;
    }
    const safeValue = Math.max(0, Number(value) || 0);
    setEditingValues(prev => ({
      ...prev,
      [employeeId]: { ...prev[employeeId], [field]: safeValue }
    }));
  }, [canEditPayroll, isApproved]);

  // ===== INITIALIZATION =====
  // Runs once on mount only -- fetchProcessedMonths depends on userProfile
  // (see its own useCallback deps above), and fetchUserProfile sets a fresh
  // userProfile object every time it runs. Listing fetchProcessedMonths in
  // this effect's own deps used to mean: userProfile changes -> new
  // fetchProcessedMonths identity -> this effect re-runs -> calls
  // fetchUserProfile() again -> sets a new userProfile -> repeat forever.
  // That infinite loop is what made the page look like it kept reloading.
  // The effect below (watching selectedMonth/userProfile) already fetches
  // processed months once those are actually set, so this doesn't need its
  // own call to fetchProcessedMonths either.
  useEffect(() => {
    const init = async () => {
      const month = await getSystemCurrentMonth();
      setSystemMonth(month);
      setSelectedMonth(month);

      const months = getAvailableMonthsFromSystem(month);
      setAvailableMonths(months);

      const pastMonths = months.filter(m => m < month);
      setCopySourceMonths(pastMonths);

      await fetchUserProfile();
    };
    init();
  }, []);

  useEffect(() => {
    if (userProfile && selectedMonth) {
      fetchData();
      fetchProcessedMonths();
    }
  }, [selectedMonth, userProfile, fetchData, fetchProcessedMonths]);

  // ===== MONTH NAVIGATION =====
  const goToPreviousMonth = useCallback(async () => {
    const prevMonth = getPreviousMonth(selectedMonth);
    if (prevMonth && availableMonths.includes(prevMonth)) {
      setSelectedMonth(prevMonth);
      setPayrollPage(1);
    }
  }, [selectedMonth, availableMonths]);

  const goToNextMonth = useCallback(async () => {
    const nextMonth = getNextMonth(selectedMonth);
    if (nextMonth && availableMonths.includes(nextMonth)) {
      setSelectedMonth(nextMonth);
      setPayrollPage(1);
    }
  }, [selectedMonth, availableMonths]);

  const goToCurrentMonth = useCallback(async () => {
    if (systemMonth && systemMonth !== selectedMonth) {
      setSelectedMonth(systemMonth);
      setPayrollPage(1);
    }
  }, [systemMonth, selectedMonth]);

  const handleMonthSelect = useCallback(async (month: string) => {
    if (month !== selectedMonth) {
      setSelectedMonth(month);
      setPayrollPage(1);
    }
  }, [selectedMonth]);

  // ===== COPY FROM PREVIOUS MONTH =====
  const copyFromPreviousMonth = useCallback(async (sourceMonth: string) => {
    if (!canProcessPayroll) {
      showNotification('You do not have permission to copy payroll data.', 'error');
      return;
    }
    
    setProcessingStatus('Copying data from ' + getMonthLabel(sourceMonth) + '...');

    try {
      const employeeIds = employees.map(e => e.id);
      if (employeeIds.length === 0) {
        showNotification('No employees found to copy payroll for.', 'error');
        return;
      }

      // Scoped to this admin's own employee set (their region, or the whole
      // company for a super admin) -- the payroll table has no region_id
      // column of its own, so an unscoped delete/read here would touch (or
      // silently overwrite) every other region's payroll too.
      const { error: deleteError } = await supabase
        .from('payroll')
        .delete()
        .eq('month', selectedMonth)
        .in('employee_id', employeeIds);

      if (deleteError) {
        console.error('Error deleting existing data:', deleteError);
      }

      // Same oversized-IN-list risk/fix as the main fetchData payroll query.
      let sourceData: PayrollRecord[];
      try {
        const sourceDataRaw = await fetchInEmployeeIdBatches<PayrollRecord>(
          employeeIds,
          (batch, from, to, withCount) =>
            supabase
              .from('payroll')
              .select('*', withCount ? { count: 'exact' } : undefined)
              .eq('month', sourceMonth)
              .in('employee_id', batch)
              .range(from, to)
        );
        sourceData = dedupeById(sourceDataRaw);
      } catch (sourceError: any) {
        console.error('Error fetching source data:', sourceError);
        showNotification('Failed to fetch source data: ' + sourceError.message, 'error');
        return;
      }

      if (!sourceData || sourceData.length === 0) {
        showNotification('No data found in the selected source month.', 'error');
        return;
      }

      // Carry forward only the manually-entered pay components (basic
      // salary override, allowances, overtime, bonus) -- everything else
      // (PAYE, pension, uniform/attendance deductions) is recalculated fresh
      // for the target month via calculatePayroll using the currently
      // configured rates and the target month's own attendance. Blindly
      // copying last month's gross/paye/pension/uniform_deduction would
      // silently carry forward a stale PAYE rate if it changed since, and
      // attendance-based deductions in particular are inherently specific
      // to the month they happened in -- an employee absent 3 days last
      // month didn't necessarily miss any days this month.
      const employeesByIdForCopy = new Map(employees.map(e => [e.id, e]));
      const newRecords = sourceData
        .map(record => {
          const employee = employeesByIdForCopy.get(record.employee_id);
          if (!employee) return null;
          const payroll = calculatePayroll(employee, {
            basic_salary: record.basic_salary,
            allowances: record.allowances || 0,
            overtime: record.overtime || 0,
            bonus: record.bonus || 0,
          });
          return {
            employee_id: employee.id,
            month: selectedMonth,
            basic_salary: payroll.basic_salary,
            allowances: payroll.allowances,
            overtime: payroll.overtime,
            bonus: payroll.bonus,
            gross_pay: payroll.gross_pay,
            paye: payroll.paye,
            pension: payroll.pension,
            uniform_deduction: payroll.uniform_deduction,
            net_pay: payroll.net_pay,
            processed_at: new Date().toISOString(),
            approval_status: 'pending',
            approved_by: null,
            approved_at: null,
            approval_notes: null
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (newRecords.length === 0) {
        showNotification('None of the source month\'s employees are still active.', 'error');
        return;
      }

      const { data: inserted, error: insertError } = await supabase
        .from('payroll')
        .insert(newRecords)
        .select();

      if (insertError) {
        console.error('Error inserting records:', insertError);
        showNotification('Failed to copy data: ' + insertError.message, 'error');
        return;
      }
      
      await logAudit({
        action: 'CREATE',
        entity_type: 'payroll',
        new_data: {
          sourceMonth: sourceMonth,
          targetMonth: selectedMonth,
          recordsCopied: inserted?.length || 0
        },
        region_id: userProfile?.region_id
      });
      
      await fetchData();
      await fetchProcessedMonths();
      setHasData(true);
      setIsApproved(false);
      setShowCopyModal(false);
      showNotification(`Payroll data copied from ${getMonthLabel(sourceMonth)} to ${getMonthLabel(selectedMonth)}. ${inserted?.length || 0} records copied.`, 'success');
    } catch (err: any) {
      console.error('Error copying data:', err);
      showNotification('Failed to copy data: ' + err.message, 'error');
    } finally {
      setProcessingStatus('');
    }
  }, [canProcessPayroll, selectedMonth, userProfile, employees, calculatePayroll, fetchData, fetchProcessedMonths]);

  // ===== APPROVE PAYROLL =====
  const approvePayroll = useCallback(async (status: 'approved' | 'rejected') => {
    if (!canApprovePayroll) {
      showNotification('You do not have permission to approve payroll. Only managers and admins can approve.', 'error');
      return;
    }

    if (payrollRecords.length === 0) {
      showNotification('No payroll records to approve. Please process payroll first.', 'error');
      return;
    }

    if (status === 'rejected' && !approvalNotes.trim()) {
      showNotification('Please provide a reason for rejection.', 'error');
      return;
    }

    setProcessing(true);
    setProcessingStatus(status === 'approved' ? 'Approving payroll...' : 'Rejecting payroll...');

    try {
      const updateData = {
        approval_status: status,
        approved_by: userProfile?.id || null,
        approved_at: new Date().toISOString(),
        approval_notes: approvalNotes || null,
        updated_at: new Date().toISOString()
      };

      // Update only the payroll records this admin can actually see (their
      // own region, or the whole company for a super admin) -- payrollRecords
      // is already scoped that way by fetchData. An unscoped update-by-month
      // here would also approve/reject every OTHER region's payroll for this
      // month, since the payroll table has no region_id column of its own.
      const { error } = await supabase
        .from('payroll')
        .update(updateData)
        .eq('month', selectedMonth)
        .in('employee_id', payrollRecords.map(r => r.employee_id));

      if (error) throw error;

      await logAudit({
        action: status === 'approved' ? 'APPROVE' : 'REJECT',
        entity_type: 'payroll',
        new_data: {
          month: selectedMonth,
          status: status,
          notes: approvalNotes,
          recordsCount: payrollRecords.length,
          approved_by: userProfile?.full_name || userProfile?.email
        },
        region_id: userProfile?.region_id
      });

      if (status === 'approved') {
        setIsApproved(true);
        showNotification(`✅ Payroll for ${getMonthLabel(selectedMonth)} has been approved!`, 'success');
      } else {
        setIsApproved(false);
        showNotification(`❌ Payroll for ${getMonthLabel(selectedMonth)} has been rejected. Please review and reprocess.`, 'error');
      }

      setShowApprovalModal(false);
      setApprovalNotes('');
      setApprovalStatus(null);
      await fetchData();
      await fetchProcessedMonths();

    } catch (err: any) {
      console.error('Error approving payroll:', err);
      showNotification('Failed to approve payroll: ' + err.message, 'error');
    } finally {
      setProcessing(false);
      setProcessingStatus('');
    }
  }, [canApprovePayroll, payrollRecords, selectedMonth, userProfile, approvalNotes, fetchData, fetchProcessedMonths]);

  // ===== PROCESS PAYROLL =====
  const processPayroll = useCallback(async () => {
    if (!isCurrentMonth) {
      if (isFutureMonthSelected) {
        showNotification('Cannot process payroll for future months. Please wait until the month arrives.', 'error');
      } else {
        showNotification('Cannot process payroll for past months. Please switch to the current month.', 'error');
      }
      return;
    }

    if (!canProcessPayroll) {
      showNotification('You do not have permission to process payroll. Only Super Admins can process payroll.', 'error');
      return;
    }
    
    setProcessing(true);
    setProcessingStatus('Preparing payroll data...');
    
    try {
      const payrollToSave = [];
      let totalGross = 0;
      let totalNet = 0;
      let totalDeductions = 0;
      
      setProcessingStatus(`Calculating payroll for ${employees.length} employees...`);
      
      for (const employee of employees) {
        const edited = editingValues[employee.id];

        // calculatePayroll computes uniform/attendance deductions itself (rates,
        // per-position uniform eligibility, and live attendance counts) -- it
        // never reads a uniform_deduction override from customValues, so there's
        // no need to (and no correct way to) pre-compute it here.
        const payroll = calculatePayroll(employee, edited);

        totalGross += payroll.gross_pay;
        totalNet += payroll.net_pay;
        totalDeductions += (payroll.paye + payroll.pension + payroll.uniform_deduction);
        
        payrollToSave.push({
          employee_id: employee.id,
          month: selectedMonth,
          basic_salary: payroll.basic_salary,
          allowances: payroll.allowances,
          overtime: payroll.overtime,
          bonus: payroll.bonus,
          gross_pay: payroll.gross_pay,
          paye: payroll.paye,
          pension: payroll.pension,
          uniform_deduction: payroll.uniform_deduction,
          net_pay: payroll.net_pay,
          processed_at: new Date().toISOString(),
          approval_status: 'pending',
          approved_by: null,
          approved_at: null,
          approval_notes: null
        });
      }
      
      setProcessingStatus('Clearing existing data...');
      // Scoped to exactly the employees being (re)processed in this run --
      // for a non-super-admin that's their own region only. An unscoped
      // delete-by-month here would also wipe every OTHER region's payroll
      // for this month, since the payroll table has no region_id column of
      // its own to protect it.
      const { error: deleteError } = await supabase
        .from('payroll')
        .delete()
        .eq('month', selectedMonth)
        .in('employee_id', employees.map(e => e.id));

      if (deleteError) {
        console.error('Error deleting existing records:', deleteError);
      }
      
      setProcessingStatus(`Saving ${payrollToSave.length} records...`);
      const { data: insertedData, error: insertError } = await supabase
        .from('payroll')
        .insert(payrollToSave)
        .select();
      
      if (insertError) {
        console.error('❌ Error inserting records:', insertError);
        showNotification('Failed to save payroll: ' + insertError.message, 'error');
        setProcessing(false);
        setProcessingStatus('');
        return;
      }
      
      await logAudit({
        action: 'CREATE',
        entity_type: 'payroll',
        new_data: {
          month: selectedMonth,
          employeeCount: employees.length,
          totalGross: totalGross,
          totalNet: totalNet,
          totalDeductions: totalDeductions,
          recordsSaved: insertedData?.length || 0,
          status: 'pending_approval'
        },
        region_id: userProfile?.region_id
      });
      
      await fetchData();
      await fetchProcessedMonths();
      
      setProcessed(true);
      setShowConfirmModal(false);
      setEditingValues({});
      setIsApproved(false);
      
      setTimeout(() => setProcessed(false), 5000);
      
      showNotification(`Payroll for ${getMonthLabel(selectedMonth)} processed successfully! ${insertedData?.length || 0} employees processed. The payroll is now pending approval by a manager or admin.`, 'success');
      
    } catch (err: any) {
      console.error('❌ Error processing payroll:', err);
      showNotification('Failed to process payroll: ' + err.message, 'error');
    } finally {
      setProcessing(false);
      setProcessingStatus('');
    }
  }, [isCurrentMonth, isFutureMonthSelected, canProcessPayroll, employees, editingValues, calculatePayroll, selectedMonth, userProfile, fetchData, fetchProcessedMonths]);

  // ===== RENDER =====
  if (!canViewPayroll && !loading) {
    return (
      <div className="text-center py-12">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
          <Lock size={32} className="text-red-500" />
        </div>
        <h2 className="text-xl font-semibold text-slate-800 mb-2">Access Denied</h2>
        <p className="text-slate-500">You do not have permission to view payroll information.</p>
        <p className="text-slate-400 text-sm mt-2">Please contact your administrator.</p>
      </div>
    );
  }

  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin"></div></div>;
  }

  const totalPages = Math.ceil(filteredEmployees.length / payrollItemsPerPage);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Payroll Management"
        subtitle={`${getMonthLabel(selectedMonth)} Payroll Run · ${isCurrentMonth ? 'Current Month' : isFutureMonthSelected ? 'Future Month (View Only)' : 'Past Month (View Only)'}${isMonthProcessed ? ' ✅ Processed' : ''}${isApproved ? ' ✅ Approved' : ''}${isPendingApproval ? ' ⏳ Pending Approval' : ''}`}
        actions={
          <div className="flex gap-2 items-center">
            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2 py-1">
              <button
                onClick={goToPreviousMonth}
                className="p-1.5 rounded hover:bg-slate-100 disabled:opacity-50"
                disabled={loading || !availableMonths.includes(getPreviousMonth(selectedMonth))}
                title="Previous Month"
              >
                <ChevronLeft size={16} />
              </button>
              
            <select
  value={selectedMonth}
  onChange={(e) => handleMonthSelect(e.target.value)}
  className="bg-transparent border-none text-sm font-medium text-slate-700 focus:ring-0 py-1 min-w-[140px] text-center cursor-pointer"
>
  {availableMonths.map((month, index) => (
    <option key={`month-${month}-${index}`} value={month}>
      {getMonthLabel(month)} {month === systemMonth ? '●' : ''} {processedMonths.includes(month) ? '✅' : ''}
    </option>
  ))}
</select>
              
              <button
                onClick={goToNextMonth}
                className="p-1.5 rounded hover:bg-slate-100 disabled:opacity-50"
                disabled={loading || !availableMonths.includes(getNextMonth(selectedMonth))}
                title="Next Month"
              >
                <ChevronRightIcon size={16} />
              </button>
            </div>

            {!isCurrentMonth && (
              <button
                onClick={goToCurrentMonth}
                className="text-xs text-[#D4A017] hover:underline px-2 py-1"
              >
                Jump to Current
              </button>
            )}

            {canApprovePayroll && isMonthProcessed && !isApproved && isCurrentMonth && (
              <Button 
                variant="secondary" 
                onClick={() => {
                  setApprovalStatus(null);
                  setApprovalNotes('');
                  setShowApprovalModal(true);
                }}
                disabled={processing || payrollRecords.length === 0}
              >
                <UserCheck size={16} className="mr-1" />
                Review & Approve
              </Button>
            )}

            {isApproved && (
              <Badge color="green" className="text-sm px-3 py-1">
                <CheckCircle2 size={14} className="mr-1" /> Approved
              </Badge>
            )}

            {isPendingApproval && !isApproved && (
              <Badge color="yellow" className="text-sm px-3 py-1">
                <Clock size={14} className="mr-1" /> Pending Approval
              </Badge>
            )}

            {canProcessPayroll && isCurrentMonth && (
              <Button 
                variant={isMonthProcessed ? "outline" : "secondary"} 
                onClick={() => setShowConfirmModal(true)}
                disabled={processing || isApproved}
              >
                {processing ? (
                  <span className="flex items-center gap-2">
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Processing...
                  </span>
                ) : (
                  <>
                    <Check size={16} /> 
                    {isMonthProcessed ? 'Reprocess Payroll' : 'Process Payroll'}
                  </>
                )}
              </Button>
            )}
            {canProcessPayroll && !isCurrentMonth && (
              <Button variant="outline" disabled className="opacity-50 cursor-not-allowed">
                <Lock size={16} className="mr-1" /> {isFutureMonthSelected ? 'Future Month' : 'Past Month'}
              </Button>
            )}
            {!canProcessPayroll && (
              <Button variant="outline" disabled className="opacity-50 cursor-not-allowed">
                <Lock size={16} className="mr-1" /> Read Only
              </Button>
            )}
          </div>
        }
      />

      {processing && processingStatus && (
        <Card className="p-4 bg-blue-50 border-blue-200 border">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-[#D4A017] border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-slate-700">{processingStatus}</span>
          </div>
        </Card>
      )}

      {/* ===== UPDATED: Approval Banner with Approver Name ===== */}
      {isApproved && (
        <Card className="p-4 bg-emerald-50 border-emerald-200 border">
          <div className="flex items-start gap-3">
            <CheckCircle2 size={20} className="text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-emerald-800">✅ Payroll Approved</p>
              <p className="text-sm text-emerald-700">
                This payroll has been approved and is ready for payment processing.
                {payrollRecords[0]?.approved_by && (
                  <span className="block text-xs text-emerald-600 mt-1">
                    Approved by: {approverName || payrollRecords[0]?.approved_by} at {payrollRecords[0]?.approved_at ? new Date(payrollRecords[0].approved_at).toLocaleString() : ''}
                  </span>
                )}
                {payrollRecords[0]?.approval_notes && (
                  <span className="block text-xs text-emerald-600 mt-1">
                    Notes: {payrollRecords[0].approval_notes}
                  </span>
                )}
              </p>
            </div>
          </div>
        </Card>
      )}

      {isPendingApproval && !isApproved && (
        <Card className="p-4 bg-yellow-50 border-yellow-200 border">
          <div className="flex items-start gap-3">
            <Clock size={20} className="text-yellow-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-yellow-800">⏳ Pending Approval</p>
              <p className="text-sm text-yellow-700">
                This payroll has been processed and is waiting for manager/admin approval.
                {canApprovePayroll && (
                  <button 
                    onClick={() => {
                      setApprovalStatus(null);
                      setApprovalNotes('');
                      setShowApprovalModal(true);
                    }}
                    className="ml-2 text-[#D4A017] hover:underline font-medium"
                  >
                    Review & Approve Now
                  </button>
                )}
              </p>
            </div>
          </div>
        </Card>
      )}

      {!isCurrentMonth && (
        <Card className={`p-3 border ${isFutureMonthSelected ? 'bg-blue-50 border-blue-200' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex items-start gap-3">
            {isFutureMonthSelected ? (
              <Calendar size={18} className="text-blue-600 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
            )}
            <div>
              <p className={`text-sm font-medium ${isFutureMonthSelected ? 'text-blue-800' : 'text-amber-800'}`}>
                {isFutureMonthSelected ? 'Future Month - View Only' : 'Past Month - View Only'}
              </p>
              <p className={`text-sm ${isFutureMonthSelected ? 'text-blue-700' : 'text-amber-700'}`}>
                {isFutureMonthSelected 
                  ? 'You are viewing a future month. Payroll can only be processed for the current month.' 
                  : 'You are viewing a past month. Payroll can only be processed for the current month.'}
                {!isCurrentMonth && (
                  <button 
                    onClick={goToCurrentMonth}
                    className="ml-2 text-[#D4A017] hover:underline font-medium"
                  >
                    Switch to {getMonthLabel(systemMonth)}
                  </button>
                )}
              </p>
            </div>
          </div>
        </Card>
      )}

      {processedMonths.length > 0 && (
        <Card className="p-3 bg-emerald-50 border-emerald-200 border">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-sm font-medium text-emerald-700 flex items-center gap-2">
              <CheckCircle2 size={16} /> Processed Months:
            </span>
            {processedMonths.slice(0, 6).map((month, index) => (
              <Badge key={`processed-${month}-${index}`} color="green" className="text-xs">
                {getMonthLabel(month)}
              </Badge>
            ))}
            {processedMonths.length > 6 && (
              <span className="text-xs text-slate-500">+{processedMonths.length - 6} more</span>
            )}
          </div>
        </Card>
      )}

      {!canProcessPayroll && isCurrentMonth && (
        <Card className="p-3 bg-amber-50 border-amber-200 border">
          <div className="flex items-start gap-3">
            <Shield size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800">View Only Mode</p>
              <p className="text-sm text-amber-700">
                You are viewing payroll in read-only mode. Only Super Admins can process payroll.
              </p>
            </div>
          </div>
        </Card>
      )}

      {employeesWithDeductions.length > 0 && (
        <Card className="p-4 bg-red-50 border-red-200 border">
          <div className="flex items-start gap-3">
            <AlertCircle size={20} className="text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-800">
                Attendance & Uniform Deductions Applied
              </p>
              <p className="text-sm text-red-700">
                {employeesWithDeductions.length} employee(s) have uniform and/or attendance deductions for this month. 
                These will be automatically included in the payroll calculation.
              </p>
              <div className="mt-2 text-xs text-red-600 space-y-1">
                <p>• Uniform Deduction: Default MK 10,000 per employee (adjustable in employee profile)</p>
                <p>• Absenteeism: MK 4,200 per absent day</p>
                <p>• Late Arrival: MK 4,200 per late day</p>
              </div>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="p-5 bg-gradient-to-br from-[#081C3A] to-[#1a2f5c] text-white">
          <p className="text-xs text-white/70">Total Employees</p>
          <p className="text-2xl font-bold mt-1">{employees.length}</p>
          <p className="text-xs text-[#D4A017] mt-2">Active Staff</p>
        </Card>
        <Card className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-slate-500">Gross Pay</p>
              <p className="text-xl font-bold text-slate-800 mt-1">{formatKwacha(totals.gross)}</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-[#E8EDF5] text-[#081C3A] flex items-center justify-center">
              <Wallet size={18} />
            </div>
          </div>
        </Card>
        <Card className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-slate-500">Total Deductions</p>
              <p className="text-xl font-bold text-slate-800 mt-1">{formatKwacha(totals.paye + totals.pension + totals.uniformDeductions)}</p>
              <p className="text-xs text-slate-500 mt-1">PAYE: {formatKwacha(totals.paye)}</p>
              <p className="text-xs text-slate-500 mt-1">Pension: {formatKwacha(totals.pension)}</p>
              <p className="text-xs text-red-500 mt-1">Uniform/Attendance: {formatKwacha(totals.uniformDeductions)}</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-red-100 text-red-600 flex items-center justify-center">
              <Calculator size={18} />
            </div>
          </div>
        </Card>
        <Card className="p-5 bg-gradient-to-br from-[#FFF9E5] to-[#FFF1CC] border-[#D4A017]/30">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-[#8B6F0F]">Net Pay</p>
              <p className="text-2xl font-bold text-[#081C3A] mt-1">{formatKwacha(totals.net)}</p>
              <p className="text-xs text-[#8B6F0F] mt-1">Total Disbursement</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-[#081C3A] text-[#D4A017] flex items-center justify-center">
              <ChevronRight size={18} />
            </div>
          </div>
        </Card>
        <Card className="p-5 bg-red-50 border-red-200">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-red-600">Uniform/Attendance</p>
              <p className="text-xl font-bold text-red-600 mt-1">{formatKwacha(totals.uniformDeductions)}</p>
              <p className="text-xs text-red-500 mt-1">{employeesWithDeductions.length} employees</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-red-200 text-red-700 flex items-center justify-center">
              <AlertCircle size={18} />
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-5">
          <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <Calculator size={16} className="text-[#D4A017]" /> Gross Pay Formula
          </h3>
          <p className="text-sm text-slate-600">= Basic Salary + Allowances + Overtime + Bonus</p>
        </Card>
        <Card className="p-5">
          <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <Calculator size={16} className="text-[#D4A017]" /> Net Pay Formula
          </h3>
          {/* Rates come from live payrollRates (Settings), not hardcoded --
              a stale "PAYE (30%)" label here would contradict whatever an
              admin has actually configured. */}
          <p className="text-sm text-slate-600">
            = Gross Pay - PAYE ({(payrollRates.payeRate * 100).toFixed(0)}% above {formatKwacha(payrollRates.payeThreshold)}) - Pension ({(payrollRates.pensionEmployeeRate * 100).toFixed(0)}%) - Uniform Deduction - Attendance Deductions
          </p>
          <p className="text-xs text-slate-500 mt-2">Attendance Deductions: Absent (MK4,200/day) + Late (MK4,200/day) + Lecture + Appearance</p>
        </Card>
      </div>

      <Card className="p-4 flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input 
            id="searchPayroll"
            name="searchPayroll"
            type="text"
            value={search} 
            onChange={e => setSearch(sanitizeInput(e.target.value))} 
            placeholder="Search employees..." 
            className="w-full pl-10 pr-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
          />
        </div>
        <div className="text-sm text-slate-500">{filteredEmployees.length} employees</div>
        {!canEditPayroll && (
          <Badge color="gray" className="text-xs">🔒 Read Only</Badge>
        )}
        {!isCurrentMonth && (
          <Badge color={isFutureMonthSelected ? 'blue' : 'amber'} className="text-xs">
            {isFutureMonthSelected ? '🔮 Future' : '📅 Past'}
          </Badge>
        )}
        {isMonthProcessed && (
          <Badge color="green" className="text-xs">✅ Processed</Badge>
        )}
        {isApproved && (
          <Badge color="green" className="text-xs">✅ Approved</Badge>
        )}
      </Card>

      {!hasData && (
        <EmptyState
          title="No Payroll Records"
          message={`No payroll data found for ${getMonthLabel(selectedMonth)}.`}
          actionLabel={copySourceMonths.length > 0 ? "Copy from Previous Month" : ""}
          onAction={() => {
            if (copySourceMonths.length === 0) {
              showNotification('No previous months available to copy from.', 'error');
              return;
            }
            setShowCopyModal(true);
          }}
        />
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <THead>
              <TR hover={false}>
                <TH>Employee</TH>
                <TH>Position</TH>
                <TH className="text-right">Basic</TH>
                <TH className="text-right">Allowances</TH>
                <TH className="text-right">Overtime</TH>
                <TH className="text-right">Bonus</TH>
                <TH className="text-right bg-emerald-50/50">Gross</TH>
                <TH className="text-right bg-red-50/50">Uniform/Att</TH>
                <TH className="text-right bg-slate-100">Net Pay</TH>
              </TR>
            </THead>
            <TBody>
              {paginatedEmployees.map(emp => {
                const p = getDisplayPayroll(emp);
                const deduction = getEmployeeDeduction(emp.id);
                const attendance = attendanceCounts.get(emp.id);
                const positionRequiresUniform = positionsRequiringUniform.get(emp.position) ?? true;
                const uniformAmount = positionRequiresUniform ? (emp.uniform_deduction ?? payrollRates.uniformDeduction) : 0;
                const hasUniform = uniformAmount > 0;
                const hasAnyDeduction = p.uniform_deduction > 0;
                const existingRecord = payrollByEmployee.get(emp.id);
                const isEditable = canEditPayroll && !existingRecord && isCurrentMonth && !isMonthProcessed && !isApproved;

                return (
                  <TR key={emp.id}>
                    <TD>
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-[#081C3A] text-white text-xs font-bold flex items-center justify-center">
                          {emp.full_name?.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-slate-800">{emp.full_name}</p>
                          <p className="text-xs text-slate-500">{emp.employee_number}</p>
                          {hasAnyDeduction && (
                            <Badge color="red" className="text-[10px] mt-0.5">Deductions</Badge>
                          )}
                          {!isEditable && existingRecord && (
                            <Badge color="gray" className="text-[10px] mt-0.5">Processed</Badge>
                          )}
                          {isApproved && (
                            <Badge color="green" className="text-[10px] mt-0.5">✅ Approved</Badge>
                          )}
                        </div>
                      </div>
                    </TD>
                    <TD className="text-xs">{emp.position}</TD>
                    <TD className="text-right">
                      {isEditable ? (
                        <input 
                          id={`basic-${emp.id}`}
                          name={`basic-${emp.id}`}
                          type="number" 
                          value={p.basic_salary} 
                          onChange={e => updateField(emp.id, 'basic_salary', Number(e.target.value))} 
                          className="w-24 text-right text-xs border border-slate-200 rounded px-1 py-0.5 focus:ring-1 focus:ring-[#081C3A]" 
                        />
                      ) : (
                        <span className="font-mono">{formatKwacha(p.basic_salary)}</span>
                      )}
                    </TD>
                    <TD className="text-right">
                      {isEditable ? (
                        <input 
                          id={`allowances-${emp.id}`}
                          name={`allowances-${emp.id}`}
                          type="number" 
                          value={p.allowances} 
                          onChange={e => updateField(emp.id, 'allowances', Number(e.target.value))} 
                          className="w-20 text-right text-xs border border-slate-200 rounded px-1 py-0.5 focus:ring-1 focus:ring-[#081C3A]" 
                        />
                      ) : (
                        <span className="font-mono">{formatKwacha(p.allowances)}</span>
                      )}
                    </TD>
                    <TD className="text-right">
                      {isEditable ? (
                        <input 
                          id={`overtime-${emp.id}`}
                          name={`overtime-${emp.id}`}
                          type="number" 
                          value={p.overtime} 
                          onChange={e => updateField(emp.id, 'overtime', Number(e.target.value))} 
                          className="w-20 text-right text-xs border border-slate-200 rounded px-1 py-0.5 focus:ring-1 focus:ring-[#081C3A]" 
                        />
                      ) : (
                        <span className="font-mono">{formatKwacha(p.overtime)}</span>
                      )}
                    </TD>
                    <TD className="text-right">
                      {isEditable ? (
                        <input 
                          id={`bonus-${emp.id}`}
                          name={`bonus-${emp.id}`}
                          type="number" 
                          value={p.bonus} 
                          onChange={e => updateField(emp.id, 'bonus', Number(e.target.value))} 
                          className="w-20 text-right text-xs border border-slate-200 rounded px-1 py-0.5 focus:ring-1 focus:ring-[#081C3A]" 
                        />
                      ) : (
                        <span className="font-mono">{formatKwacha(p.bonus)}</span>
                      )}
                    </TD>
                    <TD className="text-right font-mono font-semibold text-emerald-700 bg-emerald-50/50">
                      {formatKwacha(p.gross_pay)}
                    </TD>
                    <TD className={`text-right font-mono font-semibold ${hasAnyDeduction ? 'text-red-600' : 'text-slate-500'} bg-red-50/50`}>
                      {formatKwacha(p.uniform_deduction || 0)}
                      {hasAnyDeduction && (
                        <div className="text-[10px] text-red-400 space-y-0.5">
                          {hasUniform && <div>Uniform: MK{uniformAmount}</div>}
                          {(attendance?.absentDays || 0) > 0 && <div>Absent: {attendance!.absentDays} × MK4,200</div>}
                          {(attendance?.lateDays || 0) > 0 && <div>Late: {attendance!.lateDays} × MK4,200</div>}
                          {(deduction?.lecture_deduction || 0) > 0 && <div>Lecture: MK{deduction!.lecture_deduction}</div>}
                          {(deduction?.appearance_deduction || 0) > 0 && <div>Appearance: MK{deduction!.appearance_deduction}</div>}
                        </div>
                      )}
                    </TD>
                    <TD className="text-right font-mono font-bold text-[#081C3A] bg-slate-100">
                      {formatKwacha(p.net_pay)}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </table>
        </div>
      </div>

      <Pagination
        currentPage={payrollPage}
        totalPages={totalPages}
        totalItems={filteredEmployees.length}
        itemsPerPage={payrollItemsPerPage}
        onPageChange={setPayrollPage}
        onItemsPerPageChange={setPayrollItemsPerPage}
      />

      {/* Process Payroll Modal - Positioned at top */}
      <Modal 
        open={showConfirmModal} 
        onClose={() => setShowConfirmModal(false)} 
        title={`${isMonthProcessed ? 'Reprocess' : 'Process'} Payroll — ${getMonthLabel(selectedMonth)}`} 
        size="lg"
        className="mt-4"
      >
        <div className="space-y-4">
          <div className={`p-4 rounded-lg text-sm flex items-start gap-3 ${isMonthProcessed ? 'bg-amber-50' : 'bg-[#E8EDF5]'}`}>
            <CheckCircle2 size={18} className={`shrink-0 mt-0.5 ${isMonthProcessed ? 'text-amber-600' : 'text-[#081C3A]'}`} />
            <div>
              <strong>{isMonthProcessed ? '⚠️ Warning: Reprocessing' : 'Confirmation:'}</strong> 
              {isMonthProcessed 
                ? ` You are about to reprocess payroll for ${getMonthLabel(selectedMonth)}. This will overwrite all existing payroll data for this month.`
                : ` You are about to process payroll for ${employees.length} employees for the period ${getMonthLabel(selectedMonth)}.`
              }
              {!isMonthProcessed && (
                <p className="mt-2 text-sm text-amber-600">
                  ⚠️ After processing, the payroll will be pending approval by a manager or admin.
                </p>
              )}
            </div>
          </div>
          
          {employeesWithDeductions.length > 0 && (
            <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm">
              <p className="font-semibold text-red-800 flex items-center gap-2">
                <AlertCircle size={16} />
                Uniform & Attendance Deductions Applied
              </p>
              <p className="text-red-700 mt-1">
                {employeesWithDeductions.length} employees have uniform and/or attendance deductions totaling {formatKwacha(totals.uniformDeductions)}
              </p>
              <div className="mt-2 max-h-32 overflow-y-auto">
                {employeesWithDeductions.slice(0, 5).map(emp => {
                  const totalDed = getDisplayPayroll(emp).uniform_deduction;
                  return (
                    <div key={emp.id} className="flex justify-between text-xs py-1 border-b border-red-100 last:border-0">
                      <span>{emp.full_name}</span>
                      <span className="font-medium text-red-600">{formatKwacha(totalDed)}</span>
                    </div>
                  );
                })}
                {employeesWithDeductions.length > 5 && (
                  <p className="text-xs text-red-500 mt-1">...and {employeesWithDeductions.length - 5} more</p>
                )}
              </div>
              <div className="mt-2 text-xs text-red-600 border-t border-red-200 pt-2">
                <p>• Uniform Deduction: MK 10,000 per employee (default, adjustable)</p>
                <p>• Absenteeism: MK 4,200 per absent day</p>
                <p>• Late Arrival: MK 4,200 per late day</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div className="p-3 rounded-lg border border-slate-100">
              <p className="text-slate-500 text-xs">Gross Pay</p>
              <p className="font-bold text-slate-800 mt-1">{formatKwacha(totals.gross)}</p>
            </div>
            <div className="p-3 rounded-lg border border-slate-100">
              <p className="text-slate-500 text-xs">Uniform/Att</p>
              <p className="font-bold text-red-600 mt-1">{formatKwacha(totals.uniformDeductions)}</p>
            </div>
            <div className="p-3 rounded-lg border border-slate-100">
              <p className="text-slate-500 text-xs">Total Deductions</p>
              <p className="font-bold text-slate-800 mt-1">{formatKwacha(totals.paye + totals.pension + totals.uniformDeductions)}</p>
            </div>
            <div className="p-3 rounded-lg border border-slate-100 bg-[#FFF9E5]">
              <p className="text-slate-500 text-xs">Net Pay</p>
              <p className="font-bold text-[#081C3A] mt-1">{formatKwacha(totals.net)}</p>
            </div>
          </div>
          
          <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-100">
            <Button variant="outline" onClick={() => setShowConfirmModal(false)}>Cancel</Button>
            <Button variant="secondary" onClick={processPayroll} disabled={processing}>
              <Save size={14} /> 
              {processing ? 'Processing...' : isMonthProcessed ? 'Reprocess Payroll' : 'Process & Save Payroll'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Approval Modal - Positioned at top */}
      <Modal 
        open={showApprovalModal} 
        onClose={() => { setShowApprovalModal(false); setApprovalNotes(''); }} 
        title="Review & Approve Payroll" 
        size="lg"
        className="mt-4"
      >
        <div className="space-y-4">
          <div className="p-4 rounded-lg bg-[#E8EDF5] text-sm">
            <p className="font-semibold text-slate-800">Payroll Summary</p>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <div>
                <p className="text-xs text-slate-500">Month</p>
                <p className="font-medium">{getMonthLabel(selectedMonth)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Employees</p>
                <p className="font-medium">{payrollRecords.length}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Total Gross Pay</p>
                <p className="font-medium text-emerald-700">{formatKwacha(totals.gross)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Total Net Pay</p>
                <p className="font-medium text-[#081C3A]">{formatKwacha(totals.net)}</p>
              </div>
            </div>
          </div>

          <div className="max-h-60 overflow-y-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">Employee</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-slate-500">Gross Pay</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-slate-500">Deductions</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-slate-500">Net Pay</th>
                </tr>
              </thead>
              <tbody>
                {payrollRecords.slice(0, 10).map(record => {
                  const emp = employeesById.get(record.employee_id);
                  return (
                    <tr key={record.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-xs">{emp?.full_name || 'Unknown'}</td>
                      <td className="px-3 py-2 text-right text-xs">{formatKwacha(record.gross_pay)}</td>
                      <td className="px-3 py-2 text-right text-xs text-red-600">
                        {formatKwacha(record.paye + record.pension + record.uniform_deduction)}
                      </td>
                      <td className="px-3 py-2 text-right text-xs font-semibold">{formatKwacha(record.net_pay)}</td>
                    </tr>
                  );
                })}
                {payrollRecords.length > 10 && (
                  <tr className="border-t border-slate-100">
                    <td colSpan={4} className="px-3 py-2 text-center text-xs text-slate-500">
                      ... and {payrollRecords.length - 10} more employees
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div>
            <label htmlFor="approvalNotes" className="block text-sm font-medium text-slate-700 mb-1">
              Approval Notes (Required for rejection)
            </label>
            <textarea
              id="approvalNotes"
              name="approvalNotes"
              value={approvalNotes}
              onChange={(e) => setApprovalNotes(e.target.value)}
              placeholder="Add any notes about this approval..."
              rows={3}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-100">
            <Button variant="outline" onClick={() => { setShowApprovalModal(false); setApprovalNotes(''); }}>
              Cancel
            </Button>
            <Button 
              variant="danger" 
              onClick={() => approvePayroll('rejected')} 
              disabled={processing}
            >
              <XCircle size={14} className="mr-1" /> Reject
            </Button>
            <Button 
              variant="secondary" 
              onClick={() => approvePayroll('approved')} 
              disabled={processing}
            >
              <CheckCircle2 size={14} className="mr-1" /> Approve Payroll
            </Button>
          </div>
        </div>
      </Modal>

      {processed && (
        <div className="fixed bottom-4 right-4 z-50 p-4 rounded-xl bg-emerald-600 text-white shadow-2xl animate-fade-in max-w-sm">
          <div className="flex items-start gap-3">
            <CheckCircle2 size={22} />
            <div>
              <p className="font-semibold">Payroll Processed</p>
              <p className="text-sm opacity-90">{employees.length} payroll records saved for {getMonthLabel(selectedMonth)}</p>
              {totals.uniformDeductions > 0 && (
                <p className="text-sm opacity-80 mt-1">Including {formatKwacha(totals.uniformDeductions)} in deductions</p>
              )}
              <p className="text-sm opacity-80 mt-1">⏳ Pending approval by manager/admin</p>
            </div>
            <button onClick={() => setProcessed(false)} className="ml-4 text-white/80 hover:text-white">✕</button>
          </div>
        </div>
      )}

      <CopyFromPreviousModal 
        open={showCopyModal} 
        onClose={() => setShowCopyModal(false)} 
        onConfirm={copyFromPreviousMonth} 
        currentMonth={selectedMonth} 
        availableMonths={copySourceMonths}
      />
    </div>
  );
}

export default PayrollPage;