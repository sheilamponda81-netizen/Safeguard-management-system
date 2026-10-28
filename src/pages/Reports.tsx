import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FileDown, FileSpreadsheet, Users, DollarSign, Calendar, UserCheck, Building2, MapPin, PieChart, ChevronLeft, ChevronRight, Home, RefreshCw } from '../utils/icons';
import { Card, Button, Badge, PageHeader, THead, TBody, TR, TH, TD } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { getAvailableMonthsFromSystem, getSystemCurrentMonth, getMonthLabel, getNextMonth, getPreviousMonth } from '../utils/currentMonth';
import { EmptyState } from '../components/EmptyState';
import { sanitizeInput } from '../utils/securityHeaders';
import { logAudit } from '../utils/auditLogger';
import { showNotification } from '../utils/clickHandlers';
import { getPayrollRatesStrict, PayrollRates, DEFAULT_RATES } from '../utils/payrollSettings';
import { AttendanceCount } from '../utils/payrollCalculations';
import { toCsvRow } from '../utils/csvExport';
import { canAccess, PERMISSIONS } from '../utils/permissions';
import { PAYABLE_EMPLOYEE_STATUSES } from '../utils/employeeStatus';
import { computeEstimatedNetPay, fetchSalaryAdvanceDeductionByEmployee, fetchRefundByEmployee } from '../utils/livePayrollEstimate';
import { reconcileMonthlyPayroll, ReconciliationEmployee, StoredPayrollRow, LiveEstimateInputs } from '../utils/payrollReconciliation';

type ReportType = 'employee' | 'payroll' | 'attendance' | 'recruitment' | 'department' | 'company' | 'workstation';

// 'payroll' is financial. 'recruitment' is its OWN category, deliberately
// NOT grouped with the other operational tabs -- Operations Manager has
// reports.operational.view but is explicitly denied Recruitment
// everywhere else in the app (no recruitment.view), so the Recruitment
// report must not become a side door into a module Operations Manager
// cannot otherwise reach. Every remaining tab (employee/company/
// workstation/attendance/department) is operational.
export const FINANCIAL_REPORT_IDS: ReportType[] = ['payroll'];
export const RECRUITMENT_REPORT_IDS: ReportType[] = ['recruitment'];

interface Employee {
  id: string;
  employee_number: string;
  full_name: string;
  position: string;
  department: string;
  basic_salary: number;
  status: string;
  region_id?: string;
  company?: string;
  workstation?: string;
  is_deleted?: boolean;
  assignment_type?: string;
  resident_name?: string;
  resident_contact?: string;
  company_id?: string;
  uniform_deduction?: number;
}

interface PayrollRecord {
  id: string;
  employee_id: string;
  month: string;
  gross_pay: number;
  paye: number;
  pension: number;
  net_pay: number;
  approval_status: string;
}

interface Applicant {
  id: string;
  name: string;
  position: string;
  qualification: string;
  interview_status: string;
  application_date: string;
}

interface CompanyStats {
  id: string;
  name: string;
  normalized_name: string;
  type: string;
  totalEmployees: number;
  activeEmployees: number;
  totalPayroll: number;
  workstations: WorkstationStats[];
}

interface WorkstationStats {
  name: string;
  employeeCount: number;
  activeCount: number;
  payrollTotal: number;
}

// Accumulator shape used while building company stats -- workstations are
// keyed by name here for O(1) lookup per employee, then converted to the
// CompanyStats[] array shape (WorkstationStats[]) once accumulation is done.
interface CompanyStatsAccumulator extends Omit<CompanyStats, 'workstations'> {
  workstations: Record<string, WorkstationStats>;
}

export function ReportsPage() {
  // ===== ALL HOOKS AT TOP LEVEL =====
  const [activeReport, setActiveReport] = useState<ReportType>('company');
  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [payrollRecords, setPayrollRecords] = useState<PayrollRecord[]>([]);
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [systemMonth, setSystemMonth] = useState('');
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [hasData, setHasData] = useState(true);
  const [userProfile, setUserProfile] = useState<any>(null);
  // Financial (payroll) vs operational (everything else) report access --
  // legacy accounts (role_level set) keep their existing unrestricted
  // access to every tab, unchanged. A new functional-role account is
  // gated: Accountant gets both financial and operational (view + export),
  // Operations Manager gets operational VIEW ONLY (no export, no
  // financial), HR Manager gets neither (denied Reports entirely -- never
  // reaches this page per Sidebar/App.tsx's NAV_PERMISSIONS, which has no
  // 'reports' entry for recruitment.view).
  const [canViewFinancial, setCanViewFinancial] = useState(true);
  const [canExportFinancial, setCanExportFinancial] = useState(true);
  // Recruitment is its OWN category, deliberately NOT part of
  // "operational" -- Operations Manager has reports.operational.view but
  // is explicitly denied Recruitment everywhere else in the app (no
  // recruitment.view), so the Recruitment report must not become a side
  // door into a module Operations Manager cannot otherwise reach. Only
  // Accountant (of the 3 non-admin functional roles) is seeded with
  // reports.recruitment.view/export -- see 20260817000006.
  const [canViewRecruitment, setCanViewRecruitment] = useState(true);
  const [canExportRecruitment, setCanExportRecruitment] = useState(true);
  const [canViewOperational, setCanViewOperational] = useState(true);
  const [canExportOperational, setCanExportOperational] = useState(true);
  // Same shared rates/gates Payroll.tsx and Payments.tsx use, so a report for
  // an unprocessed month shows the same live-calculated figures those pages
  // show -- not a naive "basic salary as net pay" guess.
  const [payrollRates, setPayrollRates] = useState<PayrollRates>(DEFAULT_RATES);
  const [positionsRequiringUniform, setPositionsRequiringUniform] = useState<Map<string, boolean>>(new Map());
  // Absent/late day counts per employee for this month, used by
  // calculateLivePayroll's deduction math.
  const [attendanceCountsByEmployee, setAttendanceCountsByEmployee] = useState<Map<string, AttendanceCount>>(new Map());
  // Real present/total-recorded-day counts per employee for this month, used
  // for the Attendance Report and Department Report's attendance rate --
  // never a fabricated random percentage.
  const [attendanceRateByEmployee, setAttendanceRateByEmployee] = useState<Map<string, { present: number; total: number }>>(new Map());
  const [deductionsByEmployee, setDeductionsByEmployee] = useState<Map<string, { lecture_deduction?: number; appearance_deduction?: number }>>(new Map());
  // THIS month's pooled salary-advance deduction per employee (missing
  // entry = no active advance) -- see livePayrollEstimate.ts's own header.
  // Only applied to getEmployeeFigures' live-calculation fallback below,
  // never to an already-processed payroll row's own stored net_pay.
  const [salaryAdvanceByEmployee, setSalaryAdvanceByEmployee] = useState<Map<string, number>>(new Map());
  // Refund-persistence hotfix (2026-11): this month's saved, active
  // payroll_refund_drafts amount per employee (missing entry = no saved
  // draft) -- see fetchRefundByEmployee()'s own header. Same source
  // Payroll.tsx's own preview reads, applied only to the live-estimate
  // fallback below, never to an already-processed stored net_pay.
  const [refundByEmployee, setRefundByEmployee] = useState<Map<string, number>>(new Map());
  // Financial-reliability patch: true when the most recent fetch failed
  // partway through (attendance/rates/positions/salary-advances) -- the
  // "Total Payroll" card must show an explicit Unavailable/Retry state
  // instead of silently continuing to display a PREVIOUS, now-stale
  // total with no indication anything went wrong.
  const [financialDataUnavailable, setFinancialDataUnavailable] = useState(false);
  const [financialDataLoading, setFinancialDataLoading] = useState(false);
  // Monotonically increasing per-fetch token -- a slower, in-flight
  // request for an earlier selectedMonth must never overwrite the report
  // with its now-stale result after the user has already moved on to a
  // different month.
  const fetchRequestTokenRef = useRef(0);

  // ===== MEMOIZED VALUES =====
  const isCurrentMonth = useMemo(() => selectedMonth === systemMonth, [selectedMonth, systemMonth]);
  const isSuperAdmin = useMemo(() => userProfile?.is_super_admin, [userProfile]);
  const userRegion = useMemo(() => userProfile?.regions, [userProfile]);

  // Filter out deleted AND non-payable employees for all calculations.
  // Every consumer of this list below (department/company/workstation
  // breakdowns, payrollSummary) sums getEmployeeFigures(emp).net_pay, the
  // same payroll-dollar figure Payroll.tsx computes -- so this must use
  // the SAME payable-employee whitelist Payroll.tsx's own roster query
  // does (Active + On Leave only), not merely "not soft-deleted". Without
  // this, a non-deleted-but-non-payable employee (e.g. 'Terminated'/
  // 'Suspended' via Security.tsx's status dropdown, which never touches
  // is_deleted) would be counted here and silently excluded there,
  // producing a population mismatch against Payroll.tsx's own total.
  const activeEmployees = useMemo(() => {
    return employees.filter(emp => !emp.is_deleted && PAYABLE_EMPLOYEE_STATUSES.includes(emp.status as typeof PAYABLE_EMPLOYEE_STATUSES[number]));
  }, [employees]);

  // O(1) lookup instead of a repeated linear .find() over payrollRecords in
  // every report's aggregation below (was O(employees x payrollRecords) in
  // up to four separate places).
  const payrollByEmployee = useMemo(() => {
    const map = new Map<string, PayrollRecord>();
    payrollRecords.forEach(r => map.set(r.employee_id, r));
    return map;
  }, [payrollRecords]);

  // Real payroll figures for an employee: the actual processed record if one
  // exists for this month, otherwise the same live calculation Payroll.tsx
  // and Payments.tsx use -- never a raw "basic salary as net pay" guess.
  const getEmployeeFigures = useCallback((emp: Employee) => {
    const payroll = payrollByEmployee.get(emp.id);
    if (payroll) {
      // Already-processed row: payroll.net_pay was computed server-side by
      // process_payroll_batch(), which already subtracted that run's own
      // salary-advance deduction once -- do NOT subtract
      // salaryAdvanceByEmployee here too, or it would be double-counted.
      return { gross_pay: payroll.gross_pay, paye: payroll.paye, pension: payroll.pension, net_pay: payroll.net_pay };
    }
    const deduction = deductionsByEmployee.get(emp.id);
    // Unprocessed month: the same "Estimated Net Payroll" contract
    // Dashboard.tsx's estimateMonthlyPayrollTotal() calls -- one formula,
    // not an independently recreated one -- so this matches Payroll.tsx's
    // own preview net-pay figure for the same employee/month, salary
    // advance included exactly once.
    return computeEstimatedNetPay({
      basicSalary: emp.basic_salary || 0,
      position: emp.position,
      employeeUniformDeduction: emp.uniform_deduction,
      positionsRequiringUniform,
      payrollRates,
      attendance: attendanceCountsByEmployee.get(emp.id),
      lectureDeduction: deduction?.lecture_deduction,
      appearanceDeduction: deduction?.appearance_deduction,
      salaryAdvanceDeduction: salaryAdvanceByEmployee.get(emp.id),
      refund: refundByEmployee.get(emp.id),
    });
  }, [payrollByEmployee, deductionsByEmployee, positionsRequiringUniform, payrollRates, attendanceCountsByEmployee, salaryAdvanceByEmployee, refundByEmployee]);

  // Real attendance rate for an employee this month -- 0% (not a random
  // percentage) when no attendance has been recorded yet.
  const getEmployeeAttendanceRate = useCallback((emp: Employee) => {
    const stats = attendanceRateByEmployee.get(emp.id);
    if (!stats || stats.total === 0) return 0;
    return (stats.present / stats.total) * 100;
  }, [attendanceRateByEmployee]);

  // ===== COMPUTED DATA =====
  const departmentData = useMemo(() => {
    const deptMap: Record<string, { count: number; totalPayroll: number; present: number; total: number }> = {};
    activeEmployees.forEach(emp => {
      const deptName = emp.department || 'Other';
      if (!deptMap[deptName]) {
        deptMap[deptName] = { count: 0, totalPayroll: 0, present: 0, total: 0 };
      }
      deptMap[deptName].count++;
      deptMap[deptName].totalPayroll += getEmployeeFigures(emp).net_pay;
      const stats = attendanceRateByEmployee.get(emp.id);
      if (stats) {
        deptMap[deptName].present += stats.present;
        deptMap[deptName].total += stats.total;
      }
    });
    return Object.entries(deptMap).map(([name, data]) => ({
      name,
      employees: data.count,
      totalPayroll: data.totalPayroll,
      average: data.totalPayroll / data.count,
      attendance: (data.total > 0 ? (data.present / data.total) * 100 : 0).toFixed(1)
    }));
  }, [activeEmployees, getEmployeeFigures, attendanceRateByEmployee]);

  // ===== COMPANY DATA - Using companies table and assignment_type =====
  const companyData = useMemo(() => {
    const companyMap: Record<string, CompanyStatsAccumulator> = {};
    
    activeEmployees.forEach(emp => {
      // Determine the entity name based on assignment type
      let entityName: string;
      let entityType: string;
      let entityId: string;
      
      if (emp.assignment_type === 'resident' && emp.resident_name) {
        entityName = sanitizeInput(emp.resident_name);
        entityType = 'resident';
        entityId = `resident-${emp.resident_name}`;
      } else if (emp.company) {
        entityName = sanitizeInput(emp.company);
        entityType = 'company';
        entityId = emp.company_id || `company-${emp.company}`;
      } else {
        // Skip employees with no company or resident assignment
        return;
      }
      
      if (!companyMap[entityId]) {
        companyMap[entityId] = {
          id: entityId,
          name: entityName,
          normalized_name: entityName.toUpperCase(),
          type: entityType,
          totalEmployees: 0,
          activeEmployees: 0,
          totalPayroll: 0,
          workstations: {}
        };
      }
      
      companyMap[entityId].totalEmployees++;
      if (emp.status === 'Active') {
        companyMap[entityId].activeEmployees++;
      }

      const netPay = getEmployeeFigures(emp).net_pay;
      companyMap[entityId].totalPayroll += netPay;

      const workstationName = emp.workstation ? sanitizeInput(emp.workstation) : 'No Site';
      if (!companyMap[entityId].workstations[workstationName]) {
        companyMap[entityId].workstations[workstationName] = {
          name: workstationName,
          employeeCount: 0,
          activeCount: 0,
          payrollTotal: 0
        };
      }
      companyMap[entityId].workstations[workstationName].employeeCount++;
      if (emp.status === 'Active') {
        companyMap[entityId].workstations[workstationName].activeCount++;
      }
      companyMap[entityId].workstations[workstationName].payrollTotal += netPay;
    });

    return Object.values(companyMap).map(company => ({
      ...company,
      workstations: Object.values(company.workstations)
    }));
  }, [activeEmployees, getEmployeeFigures]);

  // ===== WORKSTATION DATA =====
  const workstationData = useMemo(() => {
    const workstationMap: Record<string, { count: number; activeCount: number; payrollTotal: number; entities: Record<string, { name: string; type: string; count: number }> }> = {};
    
    activeEmployees.forEach(emp => {
      const workstationName = emp.workstation ? sanitizeInput(emp.workstation) : 'No Site';
      
      // Determine the entity name based on assignment type
      let entityName: string;
      let entityType: string;
      let entityKey: string;
      
      if (emp.assignment_type === 'resident' && emp.resident_name) {
        entityName = sanitizeInput(emp.resident_name);
        entityType = 'resident';
        entityKey = `resident-${entityName}`;
      } else if (emp.company) {
        entityName = sanitizeInput(emp.company);
        entityType = 'company';
        entityKey = `company-${entityName}`;
      } else {
        return;
      }
      
      if (!workstationMap[workstationName]) {
        workstationMap[workstationName] = {
          count: 0,
          activeCount: 0,
          payrollTotal: 0,
          entities: {}
        };
      }
      
      workstationMap[workstationName].count++;
      if (emp.status === 'Active') {
        workstationMap[workstationName].activeCount++;
      }

      workstationMap[workstationName].payrollTotal += getEmployeeFigures(emp).net_pay;

      if (!workstationMap[workstationName].entities[entityKey]) {
        workstationMap[workstationName].entities[entityKey] = {
          name: entityName,
          type: entityType,
          count: 0
        };
      }
      workstationMap[workstationName].entities[entityKey].count++;
    });
    
    return Object.entries(workstationMap).map(([name, data]) => ({
      name,
      totalEmployees: data.count,
      activeEmployees: data.activeCount,
      totalPayroll: data.payrollTotal,
      entities: data.entities
    })).sort((a, b) => b.totalEmployees - a.totalEmployees);
  }, [activeEmployees, getEmployeeFigures]);

  // THE "Total Payroll" card's figure -- via reconcileMonthlyPayroll()
  // (payrollReconciliation.ts), the SAME shared reconciliation
  // Dashboard.tsx's "Monthly Payroll" card uses, rather than this
  // screen's own independently-filtered reduction. Fixes two real
  // defects the previous activeEmployees.reduce(getEmployeeFigures)
  // version had: (1) for a HISTORICAL month, it filtered stored payroll
  // rows by each employee's CURRENT status/is_deleted, retroactively
  // dropping a legitimate stored row for anyone since terminated/
  // deleted; (2) it never distinguished "every employee could be
  // estimated" from "some required financial input failed to load",
  // which this function's `unavailable` flag now makes explicit.
  const payrollReconciliation = useMemo(() => {
    const isHistoricalMonth = selectedMonth < systemMonth;
    const storedPayrollRows: StoredPayrollRow[] = payrollRecords.map(r => ({
      employee_id: r.employee_id,
      gross_pay: r.gross_pay,
      paye: r.paye,
      pension: r.pension,
      net_pay: r.net_pay,
      approval_status: r.approval_status,
    }));
    const currentPayableEmployees: ReconciliationEmployee[] = activeEmployees.map(e => ({
      id: e.id,
      basic_salary: e.basic_salary,
      position: e.position,
      uniform_deduction: e.uniform_deduction,
    }));
    // Unlike Dashboard.tsx, Reports.tsx's fetchData() always fetches
    // attendance/rates/positions/salary-advances unconditionally (no
    // skip-when-fully-processed optimization) -- so `liveEstimateInputs`
    // is always passed here; whether the MOST RECENT fetch actually
    // succeeded is tracked separately by `financialDataUnavailable`
    // (set in fetchData()'s own catch block), which the "Total Payroll"
    // card checks FIRST, before ever reading this reconciliation's own
    // totals/state -- a failed fetchData() call never updates these
    // source state values at all, so they would otherwise look like
    // stale-but-structurally-present data rather than "unavailable".
    const liveEstimateInputs: LiveEstimateInputs = {
      attendanceByEmployeeId: attendanceCountsByEmployee,
      positionsRequiringUniform,
      payrollRates,
      salaryAdvanceByEmployeeId: salaryAdvanceByEmployee,
      deductionsByEmployeeId: deductionsByEmployee,
      refundByEmployeeId: refundByEmployee,
    };
    return reconcileMonthlyPayroll(isHistoricalMonth, currentPayableEmployees, storedPayrollRows, liveEstimateInputs);
  }, [selectedMonth, systemMonth, payrollRecords, activeEmployees, attendanceCountsByEmployee, positionsRequiringUniform, payrollRates, salaryAdvanceByEmployee, deductionsByEmployee, refundByEmployee]);

  const payrollSummary = useMemo(() => ({
    totalGross: payrollReconciliation.totals.gross_pay,
    totalNet: payrollReconciliation.totals.net_pay,
    totalPAYE: payrollReconciliation.totals.paye,
    totalPension: payrollReconciliation.totals.pension,
  }), [payrollReconciliation]);

  const totalCompanies = useMemo(() => companyData.length, [companyData]);
  const totalWorkstations = useMemo(() => workstationData.length, [workstationData]);

  // ===== CALLBACKS =====
  const fetchUserProfile = useCallback(async () => {
    const profile = await getCurrentProfile();
    setUserProfile(profile);

    const isLegacy = (profile?.role_level ?? null) !== null;
    setCanViewFinancial(await canAccess(isLegacy, PERMISSIONS.REPORTS_FINANCIAL_VIEW));
    setCanExportFinancial(await canAccess(isLegacy, PERMISSIONS.REPORTS_FINANCIAL_EXPORT));
    setCanViewRecruitment(await canAccess(isLegacy, PERMISSIONS.REPORTS_RECRUITMENT_VIEW));
    setCanExportRecruitment(await canAccess(isLegacy, PERMISSIONS.REPORTS_RECRUITMENT_EXPORT));
    setCanViewOperational(await canAccess(isLegacy, PERMISSIONS.REPORTS_OPERATIONAL_VIEW));
    setCanExportOperational(await canAccess(isLegacy, PERMISSIONS.REPORTS_OPERATIONAL_EXPORT));
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    // Never leave a PREVIOUS month's (or a failed fetch's) total visible
    // under a newly selected month/request -- the Total Payroll card
    // renders its own loading state until this fetch's own result passes
    // the race-guard token check below.
    setFinancialDataLoading(true);
    setFinancialDataUnavailable(false);
    const fetchRequestToken = ++fetchRequestTokenRef.current;
    try {
      // CRITICAL: Exclude deleted employees
      // employees_general: non-sensitive employee read surface (Design B2) --
      // confirmed no report tab references any guard/security-only column.
      let employeesQuery = supabase
        .from('employees_general')
        .select('*')
        .eq('is_deleted', false);
      
      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        employeesQuery = employeesQuery.eq('region_id', userProfile.region_id);
      }
      
      const { data: employeesData, error: empError } = await employeesQuery;
      if (empError) throw empError;
      setEmployees(employeesData || []);
      
      let payrollQuery = supabase.from('payroll').select('*').eq('month', selectedMonth);
      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        const employeeIds = (employeesData || []).map(e => e.id);
        if (employeeIds.length > 0) {
          payrollQuery = payrollQuery.in('employee_id', employeeIds);
        }
      }
      
      const { data: payrollData, error: payError } = await payrollQuery;
      if (payError) throw payError;
      setPayrollRecords(payrollData || []);

      // ===== Real payroll rates, uniform eligibility, attendance, and
      // lecture/appearance deductions -- so any employee without a processed
      // payroll record this month still gets an accurate live-calculated
      // figure (same formula as Payroll.tsx/Payments.tsx), not a naive
      // "basic salary as net pay" guess, and attendance rates are real
      // instead of random. =====
      // Fail-closed (payroll-settings patch): getPayrollRatesStrict() never
      // silently substitutes DEFAULT_RATES on a fetch error or a corrupted
      // configured value -- unwrapped to throw here so a failure propagates
      // to this function's own outer catch (financialDataUnavailable),
      // exactly like the attendance/positions/salary-advance fetches.
      const [rates, { data: positionsData }] = await Promise.all([
        getPayrollRatesStrict().then(result => {
          if (result.status === 'unavailable') throw new Error(result.reason);
          return result.rates;
        }),
        supabase.from('positions').select('name, requires_uniform'),
      ]);
      setPayrollRates(rates);
      setPositionsRequiringUniform(
        new Map((positionsData || []).map(p => [p.name, p.requires_uniform !== false]))
      );

      const employeeIds = (employeesData || []).map(e => e.id);

      const deductionCounts = new Map<string, AttendanceCount>();
      const rateStats = new Map<string, { present: number; total: number }>();
      if (employeeIds.length > 0) {
        // Report-scoped RPC (see 20260817000006) -- gated by
        // reports.operational.view, NOT attendance.view, so this cannot be
        // used to browse the live Attendance module/grid; it only returns
        // employee_id/status for the region-allowed subset of the
        // requested employee ids and month.
        const { data: attendanceData } = await supabase
          .rpc('get_report_attendance_summary', { p_employee_ids: employeeIds, p_month: selectedMonth });

        // No generated Supabase types exist in this project -- cast
        // explicitly to the shape get_report_attendance_summary() actually
        // returns, matching the pattern used for get_applicant_dashboard_counts().
        ((attendanceData || []) as { employee_id: string; status: string }[]).forEach(record => {
          const dc = deductionCounts.get(record.employee_id) || { absentDays: 0, lateDays: 0 };
          if (record.status === 'A') dc.absentDays += 1;
          if (record.status === 'L') dc.lateDays += 1;
          deductionCounts.set(record.employee_id, dc);

          if (record.status !== '-') {
            const rs = rateStats.get(record.employee_id) || { present: 0, total: 0 };
            rs.total += 1;
            if (record.status === 'P') rs.present += 1;
            rateStats.set(record.employee_id, rs);
          }
        });
      }
      setAttendanceCountsByEmployee(deductionCounts);
      setAttendanceRateByEmployee(rateStats);

      const { data: deductionsData } = await supabase
        .from('employee_deductions')
        .select('employee_id, lecture_deduction, appearance_deduction')
        .eq('month', selectedMonth);
      setDeductionsByEmployee(new Map((deductionsData || []).map(d => [d.employee_id, d])));

      // Same pooled-allocation formula Payroll.tsx's own preview uses
      // (fetchSalaryAdvanceDeductionByEmployee mirrors its fetch and calls
      // the same calculatePooledAllocation()) -- so an unprocessed month's
      // net-pay figure here matches Payroll.tsx's own preview exactly, not
      // merely approximately. Only matters for getEmployeeFigures' live-
      // calculation fallback below; an employee with an already-processed
      // payroll row this month is unaffected (that row's own net_pay is
      // already salary-advance-inclusive, computed server-side).
      //
      // FAIL-CLOSED (financial-reliability patch): deliberately NO
      // try/catch here -- a failure now propagates to this function's
      // outer catch, exactly like the attendance/positions/rates fetches
      // above already do, instead of silently substituting an empty map.
      // Omitting a real salary-advance deduction does not UNDERSTATE net
      // pay -- it OVERSTATES it, which is exactly the "plausible but
      // incorrect total" this patch exists to prevent. See
      // payrollReconciliation.ts's own header for the shared contract.
      setSalaryAdvanceByEmployee(await fetchSalaryAdvanceDeductionByEmployee(employeeIds, selectedMonth));
      setRefundByEmployee(await fetchRefundByEmployee(employeeIds, selectedMonth));

      // Report-scoped RPC (see 20260817000006) -- gated by
      // reports.recruitment.view, NOT recruitment.view, so this cannot be
      // used to browse the live Recruitment pipeline; it returns only the
      // 6 columns this report actually renders, region-scoped server-side.
      const { data: applicantsData, error: appError } = await supabase
        .rpc('get_report_recruitment_data');
      if (appError) throw appError;
      setApplicants(applicantsData || []);

      // Check data exists for payroll
      if (activeReport === 'payroll') {
        setHasData((payrollData?.length || 0) > 0);
      } else if (activeReport === 'employee') {
        setHasData((employeesData?.length || 0) > 0);
      } else if (activeReport === 'recruitment') {
        setHasData((applicantsData?.length || 0) > 0);
      } else {
        setHasData(true);
      }

      if (fetchRequestToken === fetchRequestTokenRef.current) {
        setFinancialDataLoading(false);
        setFinancialDataUnavailable(false);
      }
    } catch (err: any) {
      console.error('Error fetching data:', err);
      // Financial-reliability patch: previously silent -- any failure in
      // this function (attendance/positions/rates/salary-advances/payroll
      // rows) now surfaces as an explicit Unavailable state on the Total
      // Payroll card instead of leaving a stale, previously-fetched total
      // on screen with no indication anything went wrong.
      if (fetchRequestToken === fetchRequestTokenRef.current) {
        setFinancialDataUnavailable(true);
        setFinancialDataLoading(false);
      }
    } finally {
      setLoading(false);
    }
  }, [userProfile, selectedMonth, activeReport]);

  // ===== INITIALIZATION =====
  useEffect(() => {
    const init = async () => {
      const month = await getSystemCurrentMonth();
      setSystemMonth(month);
      setSelectedMonth(month);
      
      const months = getAvailableMonthsFromSystem(month);
      setAvailableMonths(months);
      
      await fetchUserProfile();
    };
    init();
  }, [fetchUserProfile]);

  useEffect(() => {
    if (userProfile && selectedMonth) {
      fetchData();
    }
  }, [selectedMonth, activeReport, userProfile, fetchData]);

  // ===== MONTH NAVIGATION =====
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
    }
  }, [selectedMonth, availableMonths]);

  const goToCurrentMonth = useCallback(() => {
    if (systemMonth && systemMonth !== selectedMonth) {
      setSelectedMonth(systemMonth);
    }
  }, [systemMonth, selectedMonth]);

  const handleMonthSelect = useCallback((month: string) => {
    if (month !== selectedMonth) {
      setSelectedMonth(month);
    }
  }, [selectedMonth]);

  const handleReportTabChange = useCallback(async (tabId: ReportType) => {
    const oldReport = activeReport;
    setActiveReport(tabId);
    
    await logAudit({
      action: 'VIEW',
      entity_type: 'report_view',
      old_data: { report_type: oldReport },
      new_data: { report_type: tabId, month: selectedMonth },
      region_id: userProfile?.region_id
    });
  }, [activeReport, selectedMonth, userProfile]);

  // ===== GET CURRENT REPORT DATA =====
  const currentData = useMemo(() => {
    switch(activeReport) {
      case 'employee':
        return {
          title: 'Employee Report',
          headers: ['Name', 'Employee ID', 'Company/Resident', 'Type', 'Workstation', 'Position', 'Department', 'Status', 'Salary'],
          rows: activeEmployees.map(emp => {
            let entityName = '-';
            let entityType = '-';
            if (emp.assignment_type === 'resident' && emp.resident_name) {
              entityName = sanitizeInput(emp.resident_name);
              entityType = 'Resident';
            } else if (emp.company) {
              entityName = sanitizeInput(emp.company);
              entityType = 'Company';
            }
            return [
              sanitizeInput(emp.full_name),
              sanitizeInput(emp.employee_number),
              entityName,
              entityType,
              sanitizeInput(emp.workstation || '-'),
              sanitizeInput(emp.position),
              sanitizeInput(emp.department || '-'),
              sanitizeInput(emp.status),
              formatKwacha(emp.basic_salary || 0)
            ];
          })
        };
      case 'payroll':
        return {
          title: 'Payroll Report',
          headers: ['Name', 'Position', 'Department', 'Company/Resident', 'Gross Pay', 'PAYE', 'Pension', 'Net Pay'],
          rows: activeEmployees.map(emp => {
            const figures = getEmployeeFigures(emp);
            let entityName = '-';
            if (emp.assignment_type === 'resident' && emp.resident_name) {
              entityName = sanitizeInput(emp.resident_name);
            } else if (emp.company) {
              entityName = sanitizeInput(emp.company);
            }
            return [
              sanitizeInput(emp.full_name),
              sanitizeInput(emp.position),
              sanitizeInput(emp.department || '-'),
              entityName,
              formatKwacha(figures.gross_pay),
              formatKwacha(figures.paye),
              formatKwacha(figures.pension),
              formatKwacha(figures.net_pay)
            ];
          })
        };
      case 'attendance':
        return {
          title: 'Attendance Report',
          headers: ['Name', 'Position', 'Department', 'Company/Resident', 'Attendance Rate', 'Status'],
          rows: activeEmployees.map(emp => {
            let entityName = '-';
            if (emp.assignment_type === 'resident' && emp.resident_name) {
              entityName = sanitizeInput(emp.resident_name);
            } else if (emp.company) {
              entityName = sanitizeInput(emp.company);
            }
            return [
              sanitizeInput(emp.full_name),
              sanitizeInput(emp.position),
              sanitizeInput(emp.department || '-'),
              entityName,
              `${getEmployeeAttendanceRate(emp).toFixed(1)}%`,
              sanitizeInput(emp.status)
            ];
          })
        };
      case 'recruitment':
        return {
          title: 'Recruitment Report',
          headers: ['Applicant Name', 'Position', 'Qualification', 'Status', 'Application Date'],
          rows: applicants.map(app => [
            sanitizeInput(app.name),
            sanitizeInput(app.position),
            sanitizeInput(app.qualification || '-'),
            sanitizeInput(app.interview_status),
            sanitizeInput(app.application_date)
          ])
        };
      case 'company':
        // Total Payroll is PAYROLL data (money) baked into what is
        // otherwise an operational report -- a caller without
        // reports.financial.view (e.g. Operations Manager) must not see it
        // here either, or this "operational" tab becomes a side door into
        // the denied Payroll report.
        return canViewFinancial ? {
          title: 'Company & Resident Report',
          headers: ['Name', 'Type', 'Total Employees', 'Active', 'Total Payroll', 'Workstations/Sites'],
          rows: companyData.map(company => [
            sanitizeInput(company.name),
            company.type === 'resident' ? '🏠 Resident' : '🏢 Company',
            company.totalEmployees,
            company.activeEmployees,
            formatKwacha(company.totalPayroll),
            company.workstations.map(w => `${sanitizeInput(w.name)}: ${w.employeeCount}`).join(' | ')
          ])
        } : {
          title: 'Company & Resident Report',
          headers: ['Name', 'Type', 'Total Employees', 'Active', 'Workstations/Sites'],
          rows: companyData.map(company => [
            sanitizeInput(company.name),
            company.type === 'resident' ? '🏠 Resident' : '🏢 Company',
            company.totalEmployees,
            company.activeEmployees,
            company.workstations.map(w => `${sanitizeInput(w.name)}: ${w.employeeCount}`).join(' | ')
          ])
        };
      case 'workstation':
        return canViewFinancial ? {
          title: 'Workstation Analysis Report',
          headers: ['Workstation/Site', 'Total Employees', 'Active', 'Total Payroll', 'Companies/Residents'],
          rows: workstationData.map(ws => [
            sanitizeInput(ws.name),
            ws.totalEmployees,
            ws.activeEmployees,
            formatKwacha(ws.totalPayroll),
            Object.values(ws.entities).map(entity =>
              `${entity.type === 'resident' ? '🏠' : '🏢'} ${sanitizeInput(entity.name)}: ${entity.count}`
            ).join(' | ')
          ])
        } : {
          title: 'Workstation Analysis Report',
          headers: ['Workstation/Site', 'Total Employees', 'Active', 'Companies/Residents'],
          rows: workstationData.map(ws => [
            sanitizeInput(ws.name),
            ws.totalEmployees,
            ws.activeEmployees,
            Object.values(ws.entities).map(entity =>
              `${entity.type === 'resident' ? '🏠' : '🏢'} ${sanitizeInput(entity.name)}: ${entity.count}`
            ).join(' | ')
          ])
        };
      default:
        return canViewFinancial ? {
          title: 'Department Report',
          headers: ['Department', 'Employees', 'Total Payroll', 'Average Salary', 'Attendance'],
          rows: departmentData.map(dept => [
            sanitizeInput(dept.name),
            `${dept.employees} employees`,
            formatKwacha(dept.totalPayroll),
            formatKwacha(dept.average),
            `${dept.attendance}%`
          ])
        } : {
          title: 'Department Report',
          headers: ['Department', 'Employees', 'Attendance'],
          rows: departmentData.map(dept => [
            sanitizeInput(dept.name),
            `${dept.employees} employees`,
            `${dept.attendance}%`
          ])
        };
    }
  }, [activeReport, activeEmployees, applicants, companyData, workstationData, departmentData, getEmployeeFigures, getEmployeeAttendanceRate, canViewFinancial]);

  // ===== EXPORT REPORT =====
  const exportReport = useCallback(async () => {
    // Financial-reliability patch: never embed a withheld/unavailable
    // payroll total into a downloaded file -- a CSV, unlike the on-screen
    // card, has no "Retry" button and could be shared/archived as if it
    // were a real figure.
    const reportUsesFinancialSummary = activeReport === 'payroll' || activeReport === 'department' || activeReport === 'company' || activeReport === 'workstation';
    if (reportUsesFinancialSummary && financialDataUnavailable) {
      showNotification('Cannot export: required financial data is currently unavailable. Retry the report first.', 'error');
      return;
    }

    const reportData = currentData;
    const reportType = activeReport;
    const recordCount = reportData.rows.length;

    let csvContent = `${reportData.title}\nGenerated: ${new Date().toLocaleString()}\n\n${reportData.headers.join(',')}\n`;
    reportData.rows.forEach(row => {
      csvContent += toCsvRow(row) + '\n';
    });
    if (activeReport === 'payroll') {
      csvContent += `\n\nSUMMARY\nTotal Gross Pay,${formatKwacha(payrollSummary.totalGross)}\nTotal Net Pay,${formatKwacha(payrollSummary.totalNet)}\n`;
    }
    // Total Payroll summary lines are financial data -- omitted for a
    // caller without reports.financial.view, same reasoning as the column
    // redaction in `currentData` above.
    if (activeReport === 'department') {
      csvContent += canViewFinancial
        ? `\n\nSUMMARY\nTotal Departments,${departmentData.length}\nTotal Employees,${activeEmployees.length}\nTotal Payroll,${formatKwacha(payrollSummary.totalNet)}\n`
        : `\n\nSUMMARY\nTotal Departments,${departmentData.length}\nTotal Employees,${activeEmployees.length}\n`;
    }
    if (activeReport === 'company') {
      csvContent += canViewFinancial
        ? `\n\nSUMMARY\nTotal Companies/Residents,${companyData.length}\nTotal Employees,${activeEmployees.length}\nTotal Payroll,${formatKwacha(payrollSummary.totalNet)}\n`
        : `\n\nSUMMARY\nTotal Companies/Residents,${companyData.length}\nTotal Employees,${activeEmployees.length}\n`;
    }
    if (activeReport === 'workstation') {
      csvContent += canViewFinancial
        ? `\n\nSUMMARY\nTotal Workstations/Sites,${workstationData.length}\nTotal Employees,${activeEmployees.length}\nTotal Payroll,${formatKwacha(payrollSummary.totalNet)}\n`
        : `\n\nSUMMARY\nTotal Workstations/Sites,${workstationData.length}\nTotal Employees,${activeEmployees.length}\n`;
    }
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeReport}_report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    await logAudit({
      action: 'EXPORT',
      entity_type: 'report_export',
      new_data: {
        report_type: reportType,
        report_title: reportData.title,
        record_count: recordCount,
        month: selectedMonth,
        region: userProfile?.region_id || null
      },
      region_id: userProfile?.region_id
    });
    
    showNotification(`${activeReport.toUpperCase()} Report exported!`, 'success');
  }, [currentData, activeReport, selectedMonth, userProfile, payrollSummary, departmentData, activeEmployees, companyData, workstationData, canViewFinancial, financialDataUnavailable]);

  // ===== REPORT TABS =====
  const reportTabs = useMemo(() => [
    { id: 'employee', label: 'Employees', icon: Users },
    { id: 'company', label: 'Companies & Residents', icon: Building2 },
    { id: 'workstation', label: 'Workstations', icon: MapPin },
    { id: 'payroll', label: 'Payroll', icon: DollarSign },
    { id: 'attendance', label: 'Attendance', icon: Calendar },
    { id: 'recruitment', label: 'Recruitment', icon: UserCheck },
    { id: 'department', label: 'Departments', icon: PieChart }
  ].filter((tab) => {
    if (FINANCIAL_REPORT_IDS.includes(tab.id as ReportType)) return canViewFinancial;
    if (RECRUITMENT_REPORT_IDS.includes(tab.id as ReportType)) return canViewRecruitment;
    return canViewOperational;
  }), [canViewFinancial, canViewRecruitment, canViewOperational]);

  const isActiveReportFinancial = FINANCIAL_REPORT_IDS.includes(activeReport);
  const isActiveReportRecruitment = RECRUITMENT_REPORT_IDS.includes(activeReport);
  const canExportActiveReport = isActiveReportFinancial
    ? canExportFinancial
    : isActiveReportRecruitment
    ? canExportRecruitment
    : canExportOperational;

  // ===== RENDER =====
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Reports & Analytics"
        subtitle={`${getMonthLabel(selectedMonth)} Reports ${isCurrentMonth ? '● Current' : ''}`}
        actions={
          <div className="flex gap-2">
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
                  <option key={`${month}-${index}`} value={month}>
                    {getMonthLabel(month)} {month === systemMonth ? '●' : ''}
                  </option>
                ))}
              </select>
              
              <button
                onClick={goToNextMonth}
                className="p-1.5 rounded hover:bg-slate-100 disabled:opacity-50"
                disabled={loading || !availableMonths.includes(getNextMonth(selectedMonth))}
                title="Next Month"
              >
                <ChevronRight size={16} />
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

            {canExportActiveReport && (
              <>
                <Button variant="outline" onClick={exportReport}>
                  <FileDown size={14} className="mr-1" /> Export
                </Button>
                <Button variant="secondary" onClick={exportReport}>
                  <FileSpreadsheet size={14} className="mr-1" /> CSV
                </Button>
              </>
            )}
          </div>
        }
      />

      {!isSuperAdmin && userRegion && (
        <Card className="p-3 bg-gradient-to-r from-[#081C3A]/5 to-transparent border-[#081C3A]/20">
          <p className="text-sm text-slate-600">
            Viewing reports for <strong className="text-[#081C3A]">{userRegion.name}</strong> region only
          </p>
        </Card>
      )}

      {/* Month Status Banner */}
      {!isCurrentMonth && (
        <Card className={`p-3 border ${selectedMonth > systemMonth ? 'bg-blue-50 border-blue-200' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex items-start gap-3">
            <Calendar size={18} className={`shrink-0 mt-0.5 ${selectedMonth > systemMonth ? 'text-blue-600' : 'text-amber-600'}`} />
            <div>
              <p className={`text-sm font-medium ${selectedMonth > systemMonth ? 'text-blue-800' : 'text-amber-800'}`}>
                {selectedMonth > systemMonth ? 'Viewing Future Month' : 'Viewing Past Month'}
              </p>
              <p className={`text-sm ${selectedMonth > systemMonth ? 'text-blue-700' : 'text-amber-700'}`}>
                Showing reports for {getMonthLabel(selectedMonth)}.
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

      {/* Summary Stats for Company/Workstation view */}
      {(activeReport === 'company' || activeReport === 'workstation') && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-slate-500">Total Companies/Residents</p>
                <p className="text-2xl font-bold text-slate-800 mt-1">{totalCompanies}</p>
                <p className="text-xs text-slate-500 mt-1">Active entities</p>
              </div>
              <div className="w-10 h-10 rounded-lg bg-[#E8EDF5] text-[#081C3A] flex items-center justify-center">
                <Building2 size={18} />
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-slate-500">Total Workstations</p>
                <p className="text-2xl font-bold text-slate-800 mt-1">{totalWorkstations}</p>
                <p className="text-xs text-slate-500 mt-1">Deployment sites</p>
              </div>
              <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
                <MapPin size={18} />
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-slate-500">Total Employees</p>
                <p className="text-2xl font-bold text-slate-800 mt-1">{activeEmployees.length}</p>
                <p className="text-xs text-slate-500 mt-1">Across all entities</p>
              </div>
              <div className="w-10 h-10 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
                <Users size={18} />
              </div>
            </div>
          </Card>
          <Card className={`p-4 ${financialDataUnavailable ? 'border border-amber-200 bg-amber-50' : ''}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-slate-500">Total Payroll</p>
                {/* payrollSummary.totalNet now comes from
                    reconcileMonthlyPayroll() (the SAME shared
                    reconciliation Dashboard.tsx's "Monthly Payroll" card
                    uses) over the same activeEmployees population as the
                    "Total Employees" card above and every CSV export
                    below -- not an independent reduction that merely
                    happens to agree. financialDataLoading/Unavailable
                    (financial-reliability patch) take priority over the
                    number itself: never show a stale or incomplete total
                    with no indication anything went wrong. */}
                {financialDataLoading ? (
                  <p className="text-xl font-bold text-slate-400 mt-1">Loading…</p>
                ) : financialDataUnavailable ? (
                  <>
                    <p className="text-xl font-bold text-amber-700 mt-1">Unavailable</p>
                    <Button size="sm" variant="outline" className="mt-1" onClick={fetchData}>
                      <RefreshCw size={14} className="mr-1" /> Retry
                    </Button>
                  </>
                ) : (
                  <p className="text-xl font-bold text-slate-800 mt-1">{formatKwacha(payrollSummary.totalNet)}</p>
                )}
                <p className="text-xs text-slate-500 mt-1">
                  {financialDataUnavailable
                    ? 'Could not load required financial data -- figure withheld rather than shown incomplete.'
                    : payrollReconciliation.state === 'partial'
                      ? 'Provisional -- partially processed, not final'
                      : 'Monthly expenditure, net pay'}
                </p>
              </div>
              <div className="w-10 h-10 rounded-lg bg-[#FFF1CC] text-[#D4A017] flex items-center justify-center">
                <DollarSign size={18} />
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Company Breakdown Cards */}
      {activeReport === 'company' && companyData.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {companyData.slice(0, 6).map(company => (
            <Card key={company.id} className="p-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-[#081C3A] text-white flex items-center justify-center">
                    {company.type === 'resident' ? <Home size={14} /> : <Building2 size={14} />}
                  </div>
                  <h4 className="font-bold text-slate-800">{company.name}</h4>
                </div>
                <Badge color={company.type === 'resident' ? 'green' : 'blue'}>
                  {company.type === 'resident' ? 'Resident' : 'Company'}
                </Badge>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">Total Employees:</span>
                  <span className="font-semibold">{company.totalEmployees}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Active:</span>
                  <span className="font-semibold">{company.activeEmployees}/{company.totalEmployees}</span>
                </div>
                {canViewFinancial && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Monthly Payroll:</span>
                    <span className="font-semibold text-[#D4A017]">{formatKwacha(company.totalPayroll)}</span>
                  </div>
                )}
                <div className="border-t pt-2 mt-2">
                  <p className="text-xs text-slate-500 mb-2">Workstations/Sites:</p>
                  <div className="space-y-1">
                    {company.workstations.slice(0, 3).map(ws => (
                      <div key={ws.name} className="flex justify-between text-xs">
                        <span className="text-slate-600">{ws.name}:</span>
                        <span className="font-medium">{ws.employeeCount} guards</span>
                      </div>
                    ))}
                    {company.workstations.length > 3 && (
                      <p className="text-xs text-slate-400">+{company.workstations.length - 3} more locations</p>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Top Workstations Cards */}
      {activeReport === 'workstation' && workstationData.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {workstationData.slice(0, 6).map(ws => (
            <Card key={ws.name} className="p-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
                    <MapPin size={14} />
                  </div>
                  <h4 className="font-bold text-slate-800">{ws.name}</h4>
                </div>
                <Badge color="blue">{ws.totalEmployees} Guards</Badge>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">Active Employees:</span>
                  <span className="font-semibold">{ws.activeEmployees}/{ws.totalEmployees}</span>
                </div>
                {canViewFinancial && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Monthly Payroll:</span>
                    <span className="font-semibold text-[#D4A017]">{formatKwacha(ws.totalPayroll)}</span>
                  </div>
                )}
                <div className="border-t pt-2 mt-2">
                  <p className="text-xs text-slate-500 mb-2">Companies/Residents at this site:</p>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(ws.entities).map(([key, entity]) => (
                      <Badge key={key} color={entity.type === 'resident' ? 'green' : 'gray'} className="text-xs">
                        {entity.type === 'resident' ? '🏠' : '🏢'} {entity.name}: {entity.count}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {reportTabs.map(tab => {
          const Icon = tab.icon;
          const isActive = activeReport === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => handleReportTabChange(tab.id as ReportType)}
              className={`flex items-center gap-2 px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                isActive
                  ? 'border-[#D4A017] text-[#081C3A]'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {!hasData && activeReport === 'payroll' ? (
        <EmptyState
          title="No Payroll Data"
          message={`No payroll records found for ${getMonthLabel(selectedMonth)}. Please process payroll for this month first.`}
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="p-4 border-b border-slate-100 bg-slate-50/50">
            <h3 className="font-semibold text-slate-800">{currentData.title} — {getMonthLabel(selectedMonth)}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <THead>
                <TR hover={false}>
                  {currentData.headers.map((header, idx) => (
                    <TH key={idx}>{header}</TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {currentData.rows.slice(0, 50).map((row, idx) => (
                  <TR key={idx}>
                    {row.map((cell, cellIdx) => (
                      <TD key={cellIdx} className={cellIdx === 0 ? 'font-medium' : ''}>
                        {cell}
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </table>
          </div>
          {currentData.rows.length === 0 && (
            <div className="text-center py-8 text-slate-500">No data available for this report</div>
          )}
        </Card>
      )}
    </div>
  );
}

export default ReportsPage;