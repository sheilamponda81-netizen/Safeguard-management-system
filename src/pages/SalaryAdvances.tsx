import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Wallet, Search, CheckCircle, XCircle, Eye, ChevronDown, Lock, Ban, Pencil } from '../utils/icons';
import { Card, Button, Badge, PageHeader, THead, TBody, TR, TH, TD, Modal } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { getCurrentProfile, UserProfile } from '../utils/currentProfile';
import { showNotification } from '../utils/clickHandlers';
import { logAudit } from '../utils/auditLogger';
import { Pagination } from '../components/Pagination';
import { getDefaultPageSize } from '../utils/uiSettings';
import { getSystemCurrentMonth, getMonthLabel } from '../utils/currentMonth';
import { getErrorMessage } from '../utils/errorHandler';
import {
  calculateAdvanceSchedule,
  AdvanceScheduleValidationError,
  RepaymentMethod,
} from '../utils/salaryAdvanceCalculations';

// Business rule: an employee may have at most this many simultaneously
// 'pending'/'active' salary advances -- enforced authoritatively,
// concurrency-safely, server-side by create_salary_advance() (see
// supabase/migrations/20260813000000_salary_advances_schema.sql). This
// constant drives only the UI's own preview/disable behavior so it never
// silently drifts from the number in the sentence "Maximum of two active
// salary advances reached."
const MAX_OPEN_ADVANCES_PER_EMPLOYEE = 2;

// Raw `employees` row shape this page's own query selects -- mirrors
// TerminalDues.tsx's Employee/EmployeeRow split, since Salary Advances
// deliberately reuses that page's employee-search UX rather than
// inventing a new pattern.
interface EmployeeRow {
  id: string;
  employee_number: string | null;
  full_name: string | null;
  position: string | null;
  department: string | null;
  basic_salary: number | null;
  hire_date: string | null;
  region_id: string | null;
  workstation: string | null;
  status: string | null;
  is_deleted: boolean | null;
  regions: { name: string } | null;
}

interface Employee {
  id: string;
  employeeNumber: string;
  fullName: string;
  position: string;
  department: string;
  basicSalary: number;
  hireDate: string;
  regionName: string;
  workstation: string;
}

interface SalaryAdvanceRow {
  id: string;
  employee_id: string;
  application_date: string;
  advance_amount: number;
  repayment_method: RepaymentMethod;
  configured_monthly_deduction: number;
  repayment_period_months: number;
  final_deduction_amount: number;
  expected_payoff_month: string;
  deduction_start_month: string;
  reason: string | null;
  status: 'pending' | 'active' | 'paid' | 'rejected' | 'cancelled';
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

interface DeductionLedgerRow {
  salary_advance_id: string;
  deduction_amount: number;
}

// The ONE current combined repayment plan for an employee -- corrected
// from an earlier draft that summed each advance's own independently-
// configured rate. See supabase/migrations/20260813000000_salary_advances_schema.sql's
// "COMBINED PLAN" design and salary_advance_repayment_plans table.
interface CombinedPlanRow {
  employee_id: string;
  repayment_method: RepaymentMethod;
  combined_monthly_deduction: number;
  repayment_period_months: number;
  deduction_start_month: string;
  expected_payoff_month: string;
  changed_by: string | null;
  changed_at: string;
}

interface PlanChangeRow {
  id: string;
  changed_at: string;
  changed_by: string | null;
  previous_repayment_method: RepaymentMethod;
  previous_monthly_deduction: number;
  previous_repayment_period_months: number;
  previous_deduction_start_month: string;
  new_repayment_method: RepaymentMethod;
  new_monthly_deduction: number;
  new_repayment_period_months: number;
  new_deduction_start_month: string;
  total_outstanding_at_change: number;
  reason: string | null;
}

const getInitialEditPlanForm = () => ({
  repayment_method: 'monthly_amount' as RepaymentMethod,
  monthly_deduction: 0,
  repayment_period_months: 0,
  deduction_start_month: '',
  reason: '',
});

const getInitialApproveForm = () => ({
  repayment_method: 'monthly_amount' as RepaymentMethod,
  monthly_deduction: 0,
  repayment_period_months: 0,
  deduction_start_month: '',
  reason: '',
});

const getInitialFormData = () => ({
  employee_id: '',
  application_date: new Date().toISOString().split('T')[0],
  advance_amount: 0,
  repayment_method: 'monthly_amount' as RepaymentMethod,
  monthly_deduction: 0,
  repayment_period_months: 0,
  deduction_start_month: '',
  reason: '',
});

export function SalaryAdvancesPage() {
  // ===== ALL HOOKS AT TOP LEVEL -- no conditional hook calls anywhere in
  // this component, no hooks after an early return (see App error #310 /
  // Rules of Hooks fix documented in Recruitment.tsx for the exact class
  // of bug this must never reintroduce). =====
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [advances, setAdvances] = useState<SalaryAdvanceRow[]>([]);
  const [deductionLedger, setDeductionLedger] = useState<DeductionLedgerRow[]>([]);
  const [combinedPlans, setCombinedPlans] = useState<CombinedPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState<SalaryAdvanceRow | null>(null);
  const [systemMonth, setSystemMonth] = useState('');

  const [advancesPage, setAdvancesPage] = useState(1);
  const [advancesItemsPerPage, setAdvancesItemsPerPage] = useState(20);
  useEffect(() => { getDefaultPageSize().then(setAdvancesItemsPerPage); }, []);

  // Searchable employee selector state -- mirrors TerminalDues.tsx exactly.
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [showEmployeeDropdown, setShowEmployeeDropdown] = useState(false);
  const [filteredEmployees, setFilteredEmployees] = useState<Employee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [formData, setFormData] = useState(getInitialFormData);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // ===== Edit / Adjust Repayment Plan -- EMPLOYEE-scoped (the combined
  // plan is one-per-employee, not one-per-advance), so this stores the
  // target employee's id rather than a specific advance row. =====
  const [showEditPlanEmployeeId, setShowEditPlanEmployeeId] = useState<string | null>(null);
  const [editPlanForm, setEditPlanForm] = useState(getInitialEditPlanForm);
  const [editPlanError, setEditPlanError] = useState<string | null>(null);

  // ===== Approve (pending -> active) -- the ONLY path to activating an
  // advance; a plain status UPDATE can never do this (see
  // approve_salary_advance() in the schema migration). Advance-scoped
  // (not employee-scoped) since it targets one specific pending
  // application, but its confirmation UI reads the employee's combined
  // state to decide whether new combined terms must be REQUIRED. =====
  const [showApproveModal, setShowApproveModal] = useState<SalaryAdvanceRow | null>(null);
  const [approveForm, setApproveForm] = useState(getInitialApproveForm);
  const [approveError, setApproveError] = useState<string | null>(null);

  // ===== Plan-change audit history, fetched on demand when the Detail
  // modal opens for a specific advance -- keeps the initial page load
  // lightweight rather than fetching every employee's history up front. =====
  const [planChangeHistory, setPlanChangeHistory] = useState<PlanChangeRow[]>([]);

  // ===== MEMOIZED VALUES =====
  const isSuperAdmin = useMemo(() => userProfile?.is_super_admin ?? false, [userProfile]);
  const roleLevel = useMemo(() => userProfile?.role_level ?? 4, [userProfile]);
  const canManage = useMemo(() => isSuperAdmin || roleLevel <= 2, [isSuperAdmin, roleLevel]);
  const userRegion = useMemo(() => userProfile?.regions, [userProfile]);

  const employeesById = useMemo(() => {
    const map = new Map<string, Employee>();
    employees.forEach(e => map.set(e.id, e));
    return map;
  }, [employees]);

  // Outstanding balance is ALWAYS derived (advance_amount - SUM of this
  // advance's own ledger rows), never read from a separately-stored
  // mutable number -- matches the ledger-backed design in
  // supabase/migrations/20260813000000_salary_advances_schema.sql.
  const repaidByAdvance = useMemo(() => {
    const map = new Map<string, number>();
    deductionLedger.forEach(d => {
      map.set(d.salary_advance_id, (map.get(d.salary_advance_id) || 0) + d.deduction_amount);
    });
    return map;
  }, [deductionLedger]);

  const getRepaidAmount = useCallback((advanceId: string) => repaidByAdvance.get(advanceId) || 0, [repaidByAdvance]);
  const getOutstandingBalance = useCallback((advance: SalaryAdvanceRow) => {
    return Math.max(0, advance.advance_amount - getRepaidAmount(advance.id));
  }, [getRepaidAmount]);

  // How many deductions have actually posted for each advance -- used to
  // show "remaining expected period" (repayment_period_months minus what's
  // already been deducted) rather than the static original period.
  const deductionCountByAdvance = useMemo(() => {
    const map = new Map<string, number>();
    deductionLedger.forEach(d => {
      map.set(d.salary_advance_id, (map.get(d.salary_advance_id) || 0) + 1);
    });
    return map;
  }, [deductionLedger]);

  const getRemainingPeriodMonths = useCallback((advance: SalaryAdvanceRow) => {
    return Math.max(0, advance.repayment_period_months - (deductionCountByAdvance.get(advance.id) || 0));
  }, [deductionCountByAdvance]);

  // Per-employee "Advance #1" / "Advance #2" sequence, oldest application
  // first -- a historical advance keeps its number even after it's paid,
  // so the labeling stays stable as new advances are added later.
  const advanceSequenceByEmployee = useMemo(() => {
    const map = new Map<string, number>();
    const byEmployee = new Map<string, SalaryAdvanceRow[]>();
    advances.forEach(a => {
      const list = byEmployee.get(a.employee_id) || [];
      list.push(a);
      byEmployee.set(a.employee_id, list);
    });
    byEmployee.forEach((list) => {
      const sorted = [...list].sort((a, b) =>
        a.application_date.localeCompare(b.application_date) || a.created_at.localeCompare(b.created_at)
      );
      sorted.forEach((a, idx) => map.set(a.id, idx + 1));
    });
    return map;
  }, [advances]);

  // This employee's ONE current combined repayment plan, if any --
  // corrected from an earlier draft that derived a "pooled" figure by
  // summing each advance's own independently-configured rate. The
  // combined_monthly_deduction here is the single figure management set
  // (via create_salary_advance() for the first advance, or
  // adjust_combined_repayment_plan() thereafter) -- never auto-doubled
  // when a second advance is added.
  const plansByEmployee = useMemo(() => {
    const map = new Map<string, CombinedPlanRow>();
    combinedPlans.forEach(p => map.set(p.employee_id, p));
    return map;
  }, [combinedPlans]);

  // This employee's OPEN (pending/active) advances, split explicitly into
  // PENDING (a mere request, not active debt -- never mixed into
  // outstanding balance or the combined plan) and ACTIVE (real,
  // payroll-deducted debt). "Open slots" still counts both toward the
  // max-2 limit; every other figure here keeps the two firmly separate,
  // per the correction that pending applications must never be counted
  // as if they were approved debt.
  const getEmployeeAdvanceSummary = useCallback((employeeId: string) => {
    const openAdvances = advances.filter(a => a.employee_id === employeeId && (a.status === 'pending' || a.status === 'active'));
    const activeAdvances = openAdvances.filter(a => a.status === 'active');
    const pendingAdvances = openAdvances.filter(a => a.status === 'pending');
    const activeOutstanding = activeAdvances.reduce((sum, a) => sum + getOutstandingBalance(a), 0);
    // A pending application has never been deducted from, so its full
    // requested amount IS its outstanding request -- getOutstandingBalance
    // would also return advance_amount for it, but summing advance_amount
    // directly keeps the intent explicit: this is a REQUEST total, not a
    // derived-balance total.
    const pendingRequested = pendingAdvances.reduce((sum, a) => sum + a.advance_amount, 0);
    const plan = plansByEmployee.get(employeeId) || null;
    return {
      openCount: openAdvances.length,
      activeCount: activeAdvances.length,
      pendingCount: pendingAdvances.length,
      activeOutstanding,
      pendingRequested,
      currentMonthlyDeduction: plan?.combined_monthly_deduction || 0,
      expectedPayoffMonth: plan?.expected_payoff_month || null,
      plan,
    };
  }, [advances, getOutstandingBalance, plansByEmployee]);

  // Live preview of the repayment schedule -- uses the EXACT same
  // calculateAdvanceSchedule() the payroll RPC's own logic is modeled on,
  // so this preview can never disagree with what payroll will actually
  // deduct (see src/utils/salaryAdvanceCalculations.ts's own header).
  const previewSchedule = useMemo(() => {
    if (!formData.advance_amount || !formData.deduction_start_month) return null;
    try {
      setScheduleError(null);
      return calculateAdvanceSchedule({
        advanceAmount: formData.advance_amount,
        repaymentMethod: formData.repayment_method,
        monthlyDeduction: formData.repayment_method === 'monthly_amount' ? formData.monthly_deduction : undefined,
        repaymentPeriodMonths: formData.repayment_method === 'repayment_period' ? formData.repayment_period_months : undefined,
        deductionStartMonth: formData.deduction_start_month,
      });
    } catch (err) {
      return null;
    }
  }, [formData.advance_amount, formData.repayment_method, formData.monthly_deduction, formData.repayment_period_months, formData.deduction_start_month]);

  const selectedEmployeeSummary = useMemo(() => {
    if (!selectedEmployee) return null;
    return getEmployeeAdvanceSummary(selectedEmployee.id);
  }, [selectedEmployee, getEmployeeAdvanceSummary]);

  const displayedAdvances = useMemo(() => {
    let result = advances;
    if (filterStatus !== 'all') {
      result = result.filter(a => a.status === filterStatus);
    }
    if (search) {
      const searchLower = search.toLowerCase();
      result = result.filter(a => {
        const emp = employeesById.get(a.employee_id);
        const name = (emp?.fullName || '').toLowerCase();
        const number = (emp?.employeeNumber || '').toLowerCase();
        return name.includes(searchLower) || number.includes(searchLower);
      });
    }
    return result;
  }, [advances, filterStatus, search, employeesById]);

  const paginatedAdvances = useMemo(() => {
    const startIndex = (advancesPage - 1) * advancesItemsPerPage;
    const endIndex = Math.min(startIndex + advancesItemsPerPage, displayedAdvances.length);
    return displayedAdvances.slice(startIndex, endIndex);
  }, [displayedAdvances, advancesPage, advancesItemsPerPage]);

  useEffect(() => {
    setAdvancesPage(1);
  }, [search, filterStatus]);

  // ===== CALLBACKS =====
  const fetchUserProfile = useCallback(async () => {
    const profile = await getCurrentProfile();
    setUserProfile(profile);
  }, []);

  const fetchEmployees = useCallback(async () => {
    try {
      let query = supabase
        .from('employees')
        .select('id, employee_number, full_name, position, department, basic_salary, hire_date, region_id, workstation, status, is_deleted, regions(name)')
        .eq('status', 'Active')
        .eq('is_deleted', false);

      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        query = query.eq('region_id', userProfile.region_id);
      }

      const { data, error } = await query.order('full_name');
      if (error) throw error;

      const mapped = ((data || []) as unknown as EmployeeRow[]).map((emp): Employee => ({
        id: emp.id,
        employeeNumber: emp.employee_number || '',
        fullName: emp.full_name || '',
        position: emp.position || '',
        department: emp.department || '',
        basicSalary: emp.basic_salary || 0,
        hireDate: emp.hire_date || '',
        regionName: emp.regions?.name || '',
        workstation: emp.workstation || '',
      }));

      setEmployees(mapped);
    } catch (err) {
      console.error('Error fetching employees:', err);
      showNotification('Failed to load employees', 'error');
    }
  }, [userProfile]);

  const fetchAdvances = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase.from('salary_advances').select('*').order('created_at', { ascending: false });
      let employeeScope: string[] | null = null;

      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        const { data: regionEmployees } = await supabase
          .from('employees')
          .select('id')
          .eq('region_id', userProfile.region_id)
          .eq('is_deleted', false);
        const employeeIds = regionEmployees?.map(e => e.id) || [];
        employeeScope = employeeIds;
        if (employeeIds.length === 0) {
          setAdvances([]);
          setDeductionLedger([]);
          setCombinedPlans([]);
          setLoading(false);
          return;
        }
        query = query.in('employee_id', employeeIds);
      }

      const { data, error } = await query;
      if (error) throw error;
      const rows = data || [];
      setAdvances(rows);

      const advanceIds = rows.map(a => a.id);
      if (advanceIds.length > 0) {
        const { data: ledgerData, error: ledgerError } = await supabase
          .from('salary_advance_deductions')
          .select('salary_advance_id, deduction_amount')
          .in('salary_advance_id', advanceIds);
        if (ledgerError) throw ledgerError;
        setDeductionLedger(ledgerData || []);
      } else {
        setDeductionLedger([]);
      }

      // Each employee's ONE current combined repayment plan -- scoped the
      // same way as `advances` above (region-restricted for a non-super-admin).
      let plansQuery = supabase.from('salary_advance_repayment_plans').select('*');
      if (employeeScope) {
        plansQuery = plansQuery.in('employee_id', employeeScope);
      }
      const { data: plansData, error: plansError } = await plansQuery;
      if (plansError) throw plansError;
      setCombinedPlans(plansData || []);
    } catch (err) {
      console.error('Error fetching salary advances:', err);
      showNotification('Failed to load salary advances', 'error');
    } finally {
      setLoading(false);
    }
  }, [userProfile]);

  // ===== INITIALIZATION =====
  useEffect(() => {
    const init = async () => {
      await fetchUserProfile();
      const month = await getSystemCurrentMonth();
      setSystemMonth(month);
      setFormData(prev => ({ ...prev, deduction_start_month: month }));
    };
    init();
  }, [fetchUserProfile]);

  useEffect(() => {
    if (userProfile) {
      fetchEmployees();
      fetchAdvances();
    }
  }, [userProfile, fetchEmployees, fetchAdvances]);

  // ===== SEARCHABLE EMPLOYEE DROPDOWN =====
  useEffect(() => {
    if (employeeSearch.trim() === '') {
      setFilteredEmployees([]);
      return;
    }
    const searchLower = employeeSearch.toLowerCase().trim();
    const filtered = employees.filter(emp => {
      const fullName = (emp.fullName || '').toLowerCase();
      const employeeNumber = (emp.employeeNumber || '').toLowerCase();
      return fullName.includes(searchLower) || employeeNumber.includes(searchLower);
    });
    setFilteredEmployees(filtered.slice(0, 20));
  }, [employeeSearch, employees]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowEmployeeDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectEmployee = useCallback((employee: Employee) => {
    setSelectedEmployee(employee);
    setFormData(prev => ({ ...prev, employee_id: employee.id }));
    setEmployeeSearch(employee.fullName || '');
    setShowEmployeeDropdown(false);
  }, []);

  const resetForm = useCallback(() => {
    setShowApplyModal(false);
    setSelectedEmployee(null);
    setEmployeeSearch('');
    setScheduleError(null);
    setFormData({ ...getInitialFormData(), deduction_start_month: systemMonth });
  }, [systemMonth]);

  // ===== SUBMIT APPLICATION =====
  const submitApplication = useCallback(async () => {
    if (!selectedEmployee) {
      showNotification('Please select an employee', 'error');
      return;
    }
    if (!formData.advance_amount || formData.advance_amount <= 0) {
      showNotification('Advance amount must be greater than zero', 'error');
      return;
    }
    if ((selectedEmployeeSummary?.openCount ?? 0) >= MAX_OPEN_ADVANCES_PER_EMPLOYEE) {
      showNotification('Maximum of two active salary advances reached.', 'error');
      return;
    }

    let schedule;
    try {
      schedule = calculateAdvanceSchedule({
        advanceAmount: formData.advance_amount,
        repaymentMethod: formData.repayment_method,
        monthlyDeduction: formData.repayment_method === 'monthly_amount' ? formData.monthly_deduction : undefined,
        repaymentPeriodMonths: formData.repayment_method === 'repayment_period' ? formData.repayment_period_months : undefined,
        deductionStartMonth: formData.deduction_start_month,
      });
    } catch (err) {
      const message = err instanceof AdvanceScheduleValidationError ? err.message : getErrorMessage(err);
      showNotification(message, 'error');
      return;
    }

    // Creation is RPC-only (see create_salary_advance() in
    // 20260813000000_salary_advances_schema.sql) -- a direct
    // .from('salary_advances').insert() is rejected by RLS unconditionally
    // (no INSERT policy exists), because only the RPC can take the
    // employee-scoped advisory lock the max-2-open-advances count check
    // needs to be concurrency-safe.
    const { data, error } = await supabase.rpc('create_salary_advance', {
      p_employee_id: selectedEmployee.id,
      p_application_date: formData.application_date,
      p_advance_amount: schedule.advanceAmount,
      p_repayment_method: schedule.repaymentMethod,
      p_configured_monthly_deduction: schedule.configuredMonthlyDeduction,
      p_repayment_period_months: schedule.repaymentPeriodMonths,
      p_final_deduction_amount: schedule.finalDeductionAmount,
      p_expected_payoff_month: schedule.expectedPayoffMonth,
      p_deduction_start_month: formData.deduction_start_month,
      p_reason: formData.reason || null,
    });

    if (error) {
      // The RPC's own RAISE EXCEPTION messages (e.g. "maximum of 2 open
      // salary advances") are already specific and user-facing -- shown
      // verbatim, same trust boundary as processPayrollBatch()'s handling
      // of process_payroll_batch()'s own exception text.
      showNotification(error.message, 'error');
      return;
    }

    const newId = (data as { id?: string } | null)?.id || 'new';

    await logAudit({
      action: 'CREATE',
      entity_type: 'salary_advance',
      entity_id: newId,
      new_data: {
        employee_name: selectedEmployee.fullName,
        employee_number: selectedEmployee.employeeNumber,
        advance_amount: schedule.advanceAmount,
        repayment_method: schedule.repaymentMethod,
        configured_monthly_deduction: schedule.configuredMonthlyDeduction,
        repayment_period_months: schedule.repaymentPeriodMonths,
        deduction_start_month: formData.deduction_start_month,
      },
      region_id: userProfile?.region_id,
    });

    showNotification('Salary advance application submitted', 'success');
    resetForm();
    await fetchAdvances();
  }, [selectedEmployee, formData, selectedEmployeeSummary, userProfile, resetForm, fetchAdvances]);

  // ===== REJECT / CANCEL (pending only) -- a direct status UPDATE, still
  // allowed by RLS/the guard trigger because neither transition touches
  // the combined plan. Approving (pending -> active) is deliberately NOT
  // here -- see approve_salary_advance()/submitApproval() below, the only
  // path to activation. Cancelling an ACTIVE advance is no longer
  // possible at all (removed -- see the guard trigger's own comment for
  // why "an active unpaid advance simply vanishing" was corrected out). =====
  const updateAdvanceStatus = useCallback(async (advance: SalaryAdvanceRow, status: 'rejected' | 'cancelled') => {
    const { error } = await supabase.from('salary_advances').update({ status, updated_at: new Date().toISOString() }).eq('id', advance.id);
    if (error) {
      showNotification('Error updating status: ' + error.message, 'error');
      return;
    }

    const emp = employeesById.get(advance.employee_id);
    await logAudit({
      action: 'UPDATE',
      entity_type: 'salary_advance',
      entity_id: advance.id,
      old_data: { status: advance.status },
      new_data: { status, employee_name: emp?.fullName, employee_number: emp?.employeeNumber },
      region_id: userProfile?.region_id,
    });

    showNotification(`Salary advance ${status}`, 'success');
    await fetchAdvances();
  }, [userProfile, employeesById, fetchAdvances]);

  // ===== APPROVE (pending -> active) -- the ONLY path to activation, via
  // approve_salary_advance(). If the employee has zero active advances,
  // this simply confirms the advance's own applied-for terms (still
  // editable at approval time). If the employee already has an active
  // advance, the RPC REQUIRES an explicit new combined method/amount-or-
  // period -- the UI mirrors that by leaving those fields blank/zero
  // rather than pre-filling a value that would let the user click through
  // without deciding. =====
  const openApproveModal = useCallback((advance: SalaryAdvanceRow) => {
    setApproveError(null);
    const summary = getEmployeeAdvanceSummary(advance.employee_id);
    if (summary.activeCount === 0) {
      setApproveForm({
        repayment_method: advance.repayment_method,
        monthly_deduction: advance.configured_monthly_deduction,
        repayment_period_months: advance.repayment_period_months,
        deduction_start_month: advance.deduction_start_month,
        reason: '',
      });
    } else {
      setApproveForm({
        repayment_method: 'monthly_amount',
        monthly_deduction: 0,
        repayment_period_months: 0,
        deduction_start_month: advance.deduction_start_month,
        reason: '',
      });
    }
    setShowApproveModal(advance);
  }, [getEmployeeAdvanceSummary]);

  const closeApproveModal = useCallback(() => {
    setShowApproveModal(null);
    setApproveError(null);
    setApproveForm(getInitialApproveForm());
  }, []);

  const approveSummary = useMemo(() => {
    if (!showApproveModal) return null;
    return getEmployeeAdvanceSummary(showApproveModal.employee_id);
  }, [showApproveModal, getEmployeeAdvanceSummary]);

  // The new COMBINED outstanding this approval would create -- the
  // employee's current active outstanding plus this advance's own full
  // amount (it hasn't been deducted from at all yet). Exactly what
  // approve_salary_advance() itself computes server-side.
  const approveNewCombinedOutstanding = useMemo(() => {
    if (!showApproveModal || !approveSummary) return 0;
    return approveSummary.activeOutstanding + showApproveModal.advance_amount;
  }, [showApproveModal, approveSummary]);

  // Preview only -- reuses calculateAdvanceSchedule() against the NEW
  // combined outstanding, same recompute-from-outstanding formula
  // approve_salary_advance() applies server-side. Requires the
  // method-specific field to actually be filled in (not just truthy-zero)
  // so a second-advance approval can't be confirmed without the REQUIRED
  // new combined terms.
  const approvePreview = useMemo(() => {
    if (!showApproveModal || !approveForm.deduction_start_month || approveNewCombinedOutstanding <= 0) return null;
    if (approveForm.repayment_method === 'monthly_amount' && !approveForm.monthly_deduction) return null;
    if (approveForm.repayment_method === 'repayment_period' && !approveForm.repayment_period_months) return null;
    try {
      return calculateAdvanceSchedule({
        advanceAmount: approveNewCombinedOutstanding,
        repaymentMethod: approveForm.repayment_method,
        monthlyDeduction: approveForm.repayment_method === 'monthly_amount' ? approveForm.monthly_deduction : undefined,
        repaymentPeriodMonths: approveForm.repayment_method === 'repayment_period' ? approveForm.repayment_period_months : undefined,
        deductionStartMonth: approveForm.deduction_start_month,
      });
    } catch {
      return null;
    }
  }, [showApproveModal, approveForm, approveNewCombinedOutstanding]);

  const submitApproval = useCallback(async () => {
    if (!showApproveModal) return;
    setApproveError(null);

    const { data, error } = await supabase.rpc('approve_salary_advance', {
      p_salary_advance_id: showApproveModal.id,
      p_new_repayment_method: approveForm.repayment_method,
      p_new_monthly_deduction: approveForm.repayment_method === 'monthly_amount' ? (approveForm.monthly_deduction || null) : null,
      p_new_repayment_period_months: approveForm.repayment_method === 'repayment_period' ? (approveForm.repayment_period_months || null) : null,
      p_new_deduction_start_month: approveForm.deduction_start_month || null,
      p_reason: approveForm.reason || null,
    });

    if (error) {
      // The RPC's own RAISE EXCEPTION text (e.g. "a new combined monthly
      // deduction amount must be provided") is already specific and safe
      // to show verbatim.
      setApproveError(error.message);
      return;
    }

    const emp = employeesById.get(showApproveModal.employee_id);
    await logAudit({
      action: 'UPDATE',
      entity_type: 'salary_advance',
      entity_id: showApproveModal.id,
      old_data: { status: 'pending' },
      new_data: {
        status: 'active',
        employee_name: emp?.fullName,
        employee_number: emp?.employeeNumber,
        response: data,
      },
      region_id: userProfile?.region_id,
    });

    showNotification('Salary advance approved', 'success');
    closeApproveModal();
    await fetchAdvances();
  }, [showApproveModal, approveForm, employeesById, userProfile, closeApproveModal, fetchAdvances]);

  // ===== EDIT / ADJUST REPAYMENT PLAN -- EMPLOYEE-scoped (see
  // CombinedPlanRow's own header comment for why the plan itself is
  // one-per-employee, not one-per-advance). =====
  const openEditPlanModal = useCallback((employeeId: string) => {
    setEditPlanError(null);
    const plan = plansByEmployee.get(employeeId);
    setEditPlanForm({
      repayment_method: plan?.repayment_method || 'monthly_amount',
      monthly_deduction: plan?.combined_monthly_deduction || 0,
      repayment_period_months: plan?.repayment_period_months || 0,
      deduction_start_month: plan?.deduction_start_month || systemMonth,
      reason: '',
    });
    setShowEditPlanEmployeeId(employeeId);
  }, [plansByEmployee, systemMonth]);

  const closeEditPlanModal = useCallback(() => {
    setShowEditPlanEmployeeId(null);
    setEditPlanError(null);
    setEditPlanForm(getInitialEditPlanForm());
  }, []);

  // Preview only -- reuses calculateAdvanceSchedule() against the
  // employee's current DERIVED TOTAL outstanding balance (across every
  // open advance, never any single advance's own original amount), the
  // exact same recompute-from-remaining-balance formula
  // adjust_combined_repayment_plan() applies server-side, so this preview
  // can never disagree with what the RPC actually saves.
  const editPlanSummary = useMemo(() => {
    if (!showEditPlanEmployeeId) return null;
    return getEmployeeAdvanceSummary(showEditPlanEmployeeId);
  }, [showEditPlanEmployeeId, getEmployeeAdvanceSummary]);

  const editPlanPreview = useMemo(() => {
    if (!showEditPlanEmployeeId || !editPlanForm.deduction_start_month || !editPlanSummary) return null;
    if (editPlanSummary.activeOutstanding <= 0) return null;
    try {
      return calculateAdvanceSchedule({
        advanceAmount: editPlanSummary.activeOutstanding,
        repaymentMethod: editPlanForm.repayment_method,
        monthlyDeduction: editPlanForm.repayment_method === 'monthly_amount' ? editPlanForm.monthly_deduction : undefined,
        repaymentPeriodMonths: editPlanForm.repayment_method === 'repayment_period' ? editPlanForm.repayment_period_months : undefined,
        deductionStartMonth: editPlanForm.deduction_start_month,
      });
    } catch {
      return null;
    }
  }, [showEditPlanEmployeeId, editPlanForm, editPlanSummary]);

  const submitPlanAdjustment = useCallback(async () => {
    if (!showEditPlanEmployeeId) return;
    setEditPlanError(null);

    const { data, error } = await supabase.rpc('adjust_combined_repayment_plan', {
      p_employee_id: showEditPlanEmployeeId,
      p_new_repayment_method: editPlanForm.repayment_method,
      p_new_deduction_start_month: editPlanForm.deduction_start_month,
      p_new_monthly_deduction: editPlanForm.repayment_method === 'monthly_amount' ? editPlanForm.monthly_deduction : null,
      p_new_repayment_period_months: editPlanForm.repayment_method === 'repayment_period' ? editPlanForm.repayment_period_months : null,
      p_reason: editPlanForm.reason || null,
    });

    if (error) {
      // Same as create_salary_advance() -- the RPC's own RAISE EXCEPTION
      // text (e.g. "cannot be earlier than the month after the last
      // already-posted deduction") is already specific and safe to show.
      setEditPlanError(error.message);
      return;
    }

    const emp = employeesById.get(showEditPlanEmployeeId);
    const previousPlan = plansByEmployee.get(showEditPlanEmployeeId);
    await logAudit({
      action: 'UPDATE',
      entity_type: 'salary_advance_combined_plan',
      entity_id: showEditPlanEmployeeId,
      old_data: previousPlan ? {
        repayment_method: previousPlan.repayment_method,
        combined_monthly_deduction: previousPlan.combined_monthly_deduction,
        repayment_period_months: previousPlan.repayment_period_months,
        deduction_start_month: previousPlan.deduction_start_month,
      } : undefined,
      new_data: {
        ...editPlanForm,
        employee_name: emp?.fullName,
        employee_number: emp?.employeeNumber,
        response: data,
      },
      region_id: userProfile?.region_id,
    });

    showNotification('Combined repayment plan updated', 'success');
    closeEditPlanModal();
    await fetchAdvances();
  }, [showEditPlanEmployeeId, editPlanForm, employeesById, plansByEmployee, userProfile, closeEditPlanModal, fetchAdvances]);

  // ===== PLAN-CHANGE AUDIT HISTORY (fetched on demand for the Detail
  // modal) -- employee-scoped, since the combined plan itself is
  // employee-scoped, not advance-scoped. =====
  useEffect(() => {
    if (!showDetailModal) {
      setPlanChangeHistory([]);
      return;
    }
    let cancelled = false;
    supabase
      .from('salary_advance_repayment_plan_changes')
      .select('*')
      .eq('employee_id', showDetailModal.employee_id)
      .order('changed_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Error fetching plan change history:', error);
          return;
        }
        setPlanChangeHistory(data || []);
      });
    return () => { cancelled = true; };
  }, [showDetailModal]);

  // ===== STATUS BADGE COLOR =====
  const getStatusColor = useCallback((status: string) => {
    switch (status) {
      case 'active': return 'blue';
      case 'paid': return 'green';
      case 'pending': return 'yellow';
      case 'rejected': return 'red';
      case 'cancelled': return 'gray';
      default: return 'gray';
    }
  }, []);

  // ===== RENDER =====
  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin"></div></div>;
  }

  if (!canManage) {
    return (
      <div className="text-center py-12">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
          <Lock size={32} className="text-red-500" />
        </div>
        <h2 className="text-xl font-semibold text-slate-800 mb-2">Access Denied</h2>
        <p className="text-slate-500">You do not have permission to manage salary advances.</p>
        <p className="text-slate-400 text-sm mt-2">Please contact your administrator.</p>
      </div>
    );
  }

  const totalPages = Math.ceil(displayedAdvances.length / advancesItemsPerPage);
  // Deliberately sums ACTIVE advances only -- a pending application is a
  // request, not active debt, and must never be mixed into this figure.
  const totalActiveOutstanding = advances.reduce((sum, a) => sum + (a.status === 'active' ? getOutstandingBalance(a) : 0), 0);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Salary Advances"
        subtitle="Employee salary advances / loans, repaid automatically via payroll"
        actions={
          <Button variant="secondary" onClick={() => setShowApplyModal(true)}>
            <Wallet size={16} className="mr-1" /> New Advance
          </Button>
        }
      />

      {!isSuperAdmin && userRegion && (
        <Card className="p-3 bg-gradient-to-r from-[#081C3A]/5 to-transparent border-[#081C3A]/20">
          <p className="text-sm text-slate-600">
            Managing salary advances for <strong className="text-[#081C3A]">{userRegion.name}</strong> region
          </p>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3 text-center">
          <p className="text-xs text-slate-500">Total Applications</p>
          <p className="text-xl font-bold text-slate-800">{advances.length}</p>
        </Card>
        <Card className="p-3 text-center bg-yellow-50">
          <p className="text-xs text-yellow-600">Pending Approval</p>
          <p className="text-xl font-bold text-yellow-700">{advances.filter(a => a.status === 'pending').length}</p>
        </Card>
        <Card className="p-3 text-center bg-blue-50">
          <p className="text-xs text-blue-600">Active</p>
          <p className="text-xl font-bold text-blue-700">{advances.filter(a => a.status === 'active').length}</p>
        </Card>
        <Card className="p-3 text-center bg-[#FFF1CC]">
          <p className="text-xs text-[#D4A017]">Total Active Outstanding</p>
          <p className="text-sm font-bold text-[#D4A017]">{formatKwacha(totalActiveOutstanding)}</p>
        </Card>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              id="searchAdvances"
              name="searchAdvances"
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name or employee #..."
              className="w-full pl-10 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>
          <select
            id="filterAdvanceStatus"
            name="filterAdvanceStatus"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="active">Active</option>
            <option value="paid">Paid</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <Button variant="outline" onClick={() => { setSearch(''); setFilterStatus('all'); }} className="text-sm">
            Clear Filters
          </Button>
        </div>
      </Card>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <THead>
              <TR hover={false}>
                <TH>Employee</TH>
                <TH>Advance #</TH>
                <TH>Employee #</TH>
                <TH>Application Date</TH>
                <TH className="text-right">Original Amount</TH>
                <TH className="text-right">Monthly Deduction</TH>
                <TH>Remaining Period</TH>
                <TH className="text-right">Amount Repaid</TH>
                <TH className="text-right">Outstanding</TH>
                <TH>Status</TH>
                <TH>Expected Payoff</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {paginatedAdvances.length === 0 ? (
                <TR>
                  <TD colSpan={12} className="text-center py-8 text-slate-500">
                    <Wallet size={32} className="mx-auto mb-2 text-slate-300" />
                    {advances.length === 0 ? 'No salary advance applications found' : 'No matching applications found'}
                  </TD>
                </TR>
              ) : (
                paginatedAdvances.map((advance) => {
                  const emp = employeesById.get(advance.employee_id);
                  const repaid = getRepaidAmount(advance.id);
                  const outstanding = getOutstandingBalance(advance);
                  // Editing the combined plan only makes sense once one
                  // actually exists for this employee (adjust_combined_repayment_plan()
                  // raises otherwise) -- NOT simply whenever this row happens
                  // to be pending/active, since a still-pending FIRST advance
                  // has no plan yet at all.
                  const canEditPlan = plansByEmployee.has(advance.employee_id);
                  return (
                    <TR key={advance.id} className="hover:bg-slate-50">
                      <TD>
                        <p className="font-medium text-slate-800">{emp?.fullName || 'Unknown'}</p>
                      </TD>
                      <TD className="text-xs">#{advanceSequenceByEmployee.get(advance.id) || 1}</TD>
                      <TD className="text-xs">{emp?.employeeNumber || 'N/A'}</TD>
                      <TD className="text-xs">{new Date(advance.application_date).toLocaleDateString()}</TD>
                      <TD className="text-right font-mono">{formatKwacha(advance.advance_amount)}</TD>
                      <TD className="text-right font-mono">{formatKwacha(advance.configured_monthly_deduction)}</TD>
                      <TD className="text-xs">{getRemainingPeriodMonths(advance)} of {advance.repayment_period_months} month{advance.repayment_period_months !== 1 ? 's' : ''}</TD>
                      <TD className="text-right font-mono text-emerald-700">{formatKwacha(repaid)}</TD>
                      <TD className="text-right font-mono font-semibold text-[#D4A017]">{formatKwacha(outstanding)}</TD>
                      <TD>
                        <Badge color={getStatusColor(advance.status)}>{advance.status.toUpperCase()}</Badge>
                      </TD>
                      <TD className="text-xs">{getMonthLabel(advance.expected_payoff_month)}</TD>
                      <TD className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setShowDetailModal(advance)}
                            className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-600"
                            title="View details"
                          >
                            <Eye size={14} />
                          </button>
                          {canEditPlan && (
                            <button
                              type="button"
                              onClick={() => openEditPlanModal(advance.employee_id)}
                              className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-600"
                              title="Edit / Adjust Combined Repayment Plan"
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                          {advance.status === 'pending' && (
                            <>
                              <button
                                type="button"
                                onClick={() => openApproveModal(advance)}
                                className="w-7 h-7 rounded-lg hover:bg-emerald-100 text-emerald-600"
                                title="Approve"
                              >
                                <CheckCircle size={14} />
                              </button>
                              <button
                                type="button"
                                onClick={() => updateAdvanceStatus(advance, 'rejected')}
                                className="w-7 h-7 rounded-lg hover:bg-red-100 text-red-600"
                                title="Reject"
                              >
                                <XCircle size={14} />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (window.confirm('Cancel this pending application? It will not be approved.')) {
                                    updateAdvanceStatus(advance, 'cancelled');
                                  }
                                }}
                                className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-500"
                                title="Cancel"
                              >
                                <Ban size={14} />
                              </button>
                            </>
                          )}
                          {/* An ACTIVE, unpaid advance has no cancel action --
                              removed deliberately (see the schema migration's
                              guard-trigger comment): there is no business-approved
                              debt write-off process. Its only path forward is
                              'active' -> 'paid', automatically, at zero balance. */}
                        </div>
                      </TD>
                    </TR>
                  );
                })
              )}
            </TBody>
          </table>
        </div>
      </div>

      <Pagination
        currentPage={advancesPage}
        totalPages={totalPages}
        totalItems={displayedAdvances.length}
        itemsPerPage={advancesItemsPerPage}
        onPageChange={setAdvancesPage}
        onItemsPerPageChange={setAdvancesItemsPerPage}
      />

      {/* Apply Modal */}
      <Modal open={showApplyModal} onClose={resetForm} title="New Salary Advance" size="lg">
        <div className="space-y-4">
          <div>
            <label htmlFor="advanceEmployeeSearch" className="block text-sm font-medium text-slate-700 mb-1">
              Search Employee <span className="text-red-500">*</span>
            </label>
            <div className="relative" ref={dropdownRef}>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  id="advanceEmployeeSearch"
                  name="advanceEmployeeSearch"
                  type="text"
                  value={employeeSearch}
                  onChange={(e) => {
                    setEmployeeSearch(e.target.value);
                    setShowEmployeeDropdown(true);
                    if (e.target.value === '') {
                      setSelectedEmployee(null);
                      setFormData(prev => ({ ...prev, employee_id: '' }));
                    }
                  }}
                  onFocus={() => { if (employeeSearch.trim() !== '') setShowEmployeeDropdown(true); }}
                  placeholder="Type employee name or number..."
                  className="w-full pl-10 pr-10 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] focus:border-transparent"
                />
                <ChevronDown size={16} className={`absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-transform ${showEmployeeDropdown ? 'rotate-180' : ''}`} />
              </div>
              {showEmployeeDropdown && employeeSearch.trim() !== '' && (
                <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                  {filteredEmployees.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-slate-500 text-center">No active employees found matching "{employeeSearch}"</div>
                  ) : (
                    filteredEmployees.map((emp) => (
                      <button
                        key={emp.id}
                        type="button"
                        onClick={() => selectEmployee(emp)}
                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors flex items-center gap-3"
                      >
                        <div className="w-8 h-8 rounded-full bg-[#081C3A] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                          {((emp.fullName || 'U').split(' ').map(n => n[0]).join('').slice(0, 2)).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 truncate">{emp.fullName || 'Unknown'}</p>
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <span>{emp.employeeNumber || 'N/A'}</span>
                            <span className="w-1 h-1 rounded-full bg-slate-300" />
                            <span>{emp.position || 'N/A'}</span>
                          </div>
                        </div>
                        <div className="text-xs font-medium text-[#D4A017]">{formatKwacha(emp.basicSalary || 0)}</div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {selectedEmployee && (
            <div className="p-3 bg-slate-50 rounded-lg text-sm grid grid-cols-2 gap-2">
              <div><strong>Employee:</strong> {selectedEmployee.fullName}</div>
              <div><strong>Employee #:</strong> {selectedEmployee.employeeNumber}</div>
              <div><strong>Department:</strong> {selectedEmployee.department || 'N/A'}</div>
              <div><strong>Position:</strong> {selectedEmployee.position || 'N/A'}</div>
              <div><strong>Basic Salary:</strong> {formatKwacha(selectedEmployee.basicSalary)}</div>
              <div><strong>Employment Date:</strong> {selectedEmployee.hireDate ? new Date(selectedEmployee.hireDate).toLocaleDateString() : 'N/A'}</div>
              {selectedEmployee.regionName && <div><strong>Region:</strong> {selectedEmployee.regionName}</div>}
              {selectedEmployee.workstation && <div><strong>Station:</strong> {selectedEmployee.workstation}</div>}
            </div>
          )}

          {selectedEmployee && selectedEmployeeSummary && (
            <div className={`p-3 rounded-lg text-sm border ${selectedEmployeeSummary.openCount >= MAX_OPEN_ADVANCES_PER_EMPLOYEE ? 'bg-red-50 border-red-200' : 'bg-blue-50 border-blue-100'}`}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div>
                  <p className="text-xs text-slate-500">Open Slots</p>
                  <p className="font-semibold">{selectedEmployeeSummary.openCount} / {MAX_OPEN_ADVANCES_PER_EMPLOYEE}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Active Outstanding</p>
                  <p className="font-semibold">{formatKwacha(selectedEmployeeSummary.activeOutstanding)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Pending Requested{selectedEmployeeSummary.pendingCount > 0 ? ` (${selectedEmployeeSummary.pendingCount})` : ''}</p>
                  <p className="font-semibold">{formatKwacha(selectedEmployeeSummary.pendingRequested)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Current Monthly Deduction</p>
                  <p className="font-semibold">{formatKwacha(selectedEmployeeSummary.currentMonthlyDeduction)}</p>
                </div>
              </div>
              {selectedEmployeeSummary.openCount >= MAX_OPEN_ADVANCES_PER_EMPLOYEE && (
                <p className="text-red-600 text-xs font-medium mt-2">Maximum of two active salary advances reached.</p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Application Date</label>
              <input
                id="applicationDate"
                name="applicationDate"
                type="date"
                value={formData.application_date}
                onChange={(e) => setFormData({ ...formData, application_date: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Deduction Start Month</label>
              <input
                id="deductionStartMonth"
                name="deductionStartMonth"
                type="month"
                value={formData.deduction_start_month}
                onChange={(e) => setFormData({ ...formData, deduction_start_month: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Advance Amount (MK) <span className="text-red-500">*</span></label>
              <input
                id="advanceAmount"
                name="advanceAmount"
                type="number"
                min="0"
                value={formData.advance_amount || ''}
                onChange={(e) => setFormData({ ...formData, advance_amount: parseFloat(e.target.value) || 0 })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Repayment Method</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, repayment_method: 'monthly_amount' })}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border ${formData.repayment_method === 'monthly_amount' ? 'bg-[#081C3A] text-white border-[#081C3A]' : 'border-slate-200 text-slate-600'}`}
                >
                  Fixed Monthly Amount
                </button>
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, repayment_method: 'repayment_period' })}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border ${formData.repayment_method === 'repayment_period' ? 'bg-[#081C3A] text-white border-[#081C3A]' : 'border-slate-200 text-slate-600'}`}
                >
                  Repayment Period
                </button>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                {formData.repayment_method === 'monthly_amount'
                  ? 'You set the monthly deduction -- the number of months is calculated automatically.'
                  : 'You set the number of months -- the monthly deduction is calculated automatically.'}
              </p>
            </div>

            {formData.repayment_method === 'monthly_amount' ? (
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Monthly Deduction (MK) <span className="text-red-500">*</span></label>
                <input
                  id="monthlyDeduction"
                  name="monthlyDeduction"
                  type="number"
                  min="0"
                  value={formData.monthly_deduction || ''}
                  onChange={(e) => setFormData({ ...formData, monthly_deduction: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                />
              </div>
            ) : (
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Repayment Period (months) <span className="text-red-500">*</span></label>
                <input
                  id="repaymentPeriodMonths"
                  name="repaymentPeriodMonths"
                  type="number"
                  min="1"
                  step="1"
                  value={formData.repayment_period_months || ''}
                  onChange={(e) => setFormData({ ...formData, repayment_period_months: parseInt(e.target.value, 10) || 0 })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                />
              </div>
            )}

            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Reason / Notes (optional)</label>
              <textarea
                id="advanceReason"
                name="advanceReason"
                rows={2}
                value={formData.reason}
                onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>
          </div>

          {/* Live schedule preview -- same calculation the payroll RPC uses */}
          {previewSchedule && (
            <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
              <h4 className="font-semibold text-slate-800 mb-3">Repayment Schedule Preview</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between border-b pb-2">
                  <span className="text-slate-600">Number of Deductions</span>
                  <span className="font-medium">{previewSchedule.repaymentPeriodMonths} month{previewSchedule.repaymentPeriodMonths !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex justify-between border-b pb-2">
                  <span className="text-slate-600">Regular Monthly Deduction</span>
                  <span className="font-medium">{formatKwacha(previewSchedule.configuredMonthlyDeduction)}</span>
                </div>
                <div className="flex justify-between border-b pb-2">
                  <span className="text-slate-600">Final Deduction</span>
                  <span className="font-medium">{formatKwacha(previewSchedule.finalDeductionAmount)}</span>
                </div>
                <div className="flex justify-between pt-2 font-bold text-[#D4A017]">
                  <span>Expected Payoff Month</span>
                  <span>{getMonthLabel(previewSchedule.expectedPayoffMonth)}</span>
                </div>
              </div>
            </div>
          )}
          {scheduleError && (
            <p className="text-sm text-red-600">{scheduleError}</p>
          )}

          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" onClick={resetForm}>Cancel</Button>
            <Button
              variant="secondary"
              onClick={submitApplication}
              disabled={!selectedEmployee || !previewSchedule || (selectedEmployeeSummary?.openCount ?? 0) >= MAX_OPEN_ADVANCES_PER_EMPLOYEE}
            >
              Submit Application
            </Button>
          </div>
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal open={!!showDetailModal} onClose={() => setShowDetailModal(null)} title="Salary Advance Details" size="lg">
        {showDetailModal && (() => {
          const emp = employeesById.get(showDetailModal.employee_id);
          const repaid = getRepaidAmount(showDetailModal.id);
          const outstanding = getOutstandingBalance(showDetailModal);
          const summary = getEmployeeAdvanceSummary(showDetailModal.employee_id);
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><p className="text-slate-500">Employee</p><p className="font-semibold">{emp?.fullName || 'Unknown'}</p></div>
                <div><p className="text-slate-500">Employee #</p><p className="font-semibold">{emp?.employeeNumber || 'N/A'}</p></div>
                <div><p className="text-slate-500">Status</p><Badge color={getStatusColor(showDetailModal.status)}>{showDetailModal.status.toUpperCase()}</Badge></div>
                <div><p className="text-slate-500">Application Date</p><p className="font-semibold">{new Date(showDetailModal.application_date).toLocaleDateString()}</p></div>
              </div>
              <div className="border-t pt-4">
                <h4 className="font-semibold text-slate-800 mb-1">Advance #{advanceSequenceByEmployee.get(showDetailModal.id) || 1} -- As Originally Applied For</h4>
                <p className="text-xs text-slate-400 mb-3">
                  These figures are immutable financial history. Ongoing payroll deductions follow the
                  employee's current combined plan below, not necessarily this advance's own original terms.
                </p>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between border-b pb-2"><span className="text-slate-600">Advance Amount</span><span className="font-medium">{formatKwacha(showDetailModal.advance_amount)}</span></div>
                  <div className="flex justify-between border-b pb-2"><span className="text-slate-600">Monthly Deduction</span><span className="font-medium">{formatKwacha(showDetailModal.configured_monthly_deduction)}</span></div>
                  <div className="flex justify-between border-b pb-2"><span className="text-slate-600">Final Deduction</span><span className="font-medium">{formatKwacha(showDetailModal.final_deduction_amount)}</span></div>
                  <div className="flex justify-between border-b pb-2"><span className="text-slate-600">Repayment Period</span><span className="font-medium">{showDetailModal.repayment_period_months} months</span></div>
                  <div className="flex justify-between border-b pb-2"><span className="text-slate-600">Deduction Start Month</span><span className="font-medium">{getMonthLabel(showDetailModal.deduction_start_month)}</span></div>
                  <div className="flex justify-between border-b pb-2"><span className="text-slate-600">Expected Payoff Month</span><span className="font-medium">{getMonthLabel(showDetailModal.expected_payoff_month)}</span></div>
                  <div className="flex justify-between border-b pb-2 text-emerald-700"><span>Amount Repaid</span><span>{formatKwacha(repaid)}</span></div>
                  <div className="flex justify-between pt-2 font-bold text-lg text-[#D4A017]"><span>Outstanding Balance</span><span>{formatKwacha(outstanding)}</span></div>
                </div>
              </div>
              {(showDetailModal.status === 'pending' || showDetailModal.status === 'active') && (
                <div className="border-t pt-4">
                  <h4 className="font-semibold text-slate-800 mb-3">Employee Summary -- Active Debt vs Pending Requests</h4>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><p className="text-slate-500">Open Slots</p><p className="font-semibold">{summary.openCount} / {MAX_OPEN_ADVANCES_PER_EMPLOYEE}</p></div>
                    <div><p className="text-slate-500">Active Outstanding</p><p className="font-semibold">{formatKwacha(summary.activeOutstanding)}</p></div>
                    <div><p className="text-slate-500">Pending Requested{summary.pendingCount > 0 ? ` (${summary.pendingCount})` : ''}</p><p className="font-semibold">{formatKwacha(summary.pendingRequested)}</p></div>
                    <div><p className="text-slate-500">Current Combined Monthly Deduction</p><p className="font-semibold">{formatKwacha(summary.currentMonthlyDeduction)}</p></div>
                    <div className="col-span-2"><p className="text-slate-500">Expected Payoff</p><p className="font-semibold">{summary.expectedPayoffMonth ? getMonthLabel(summary.expectedPayoffMonth) : 'N/A'}</p></div>
                  </div>
                </div>
              )}
              {showDetailModal.reason && (
                <div className="border-t pt-4">
                  <p className="text-xs text-slate-500">Reason: {showDetailModal.reason}</p>
                </div>
              )}
              {planChangeHistory.length > 0 && (
                <div className="border-t pt-4">
                  <h4 className="font-semibold text-slate-800 mb-3">Combined Repayment Plan Change History</h4>
                  <div className="space-y-2 text-xs">
                    {planChangeHistory.map((change) => (
                      <div key={change.id} className="p-2 bg-slate-50 rounded-lg">
                        <p className="text-slate-500">{new Date(change.changed_at).toLocaleString()}</p>
                        <p>
                          Monthly deduction {formatKwacha(change.previous_monthly_deduction)} &rarr; {formatKwacha(change.new_monthly_deduction)},
                          {' '}period {change.previous_repayment_period_months} &rarr; {change.new_repayment_period_months} month(s),
                          {' '}start {getMonthLabel(change.previous_deduction_start_month)} &rarr; {getMonthLabel(change.new_deduction_start_month)}
                        </p>
                        <p className="text-slate-500 mt-1">Total outstanding at change: {formatKwacha(change.total_outstanding_at_change)}</p>
                        {change.reason && <p className="text-slate-500 mt-1">Reason: {change.reason}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-4 border-t">
                {plansByEmployee.has(showDetailModal.employee_id) && (
                  <Button variant="outline" onClick={() => { openEditPlanModal(showDetailModal.employee_id); setShowDetailModal(null); }}>
                    <Pencil size={14} className="mr-1" /> Edit / Adjust Combined Plan
                  </Button>
                )}
                {showDetailModal.status === 'pending' && (
                  <>
                    <Button variant="secondary" onClick={() => { openApproveModal(showDetailModal); setShowDetailModal(null); }}>
                      <CheckCircle size={14} className="mr-1" /> Approve
                    </Button>
                    <Button variant="danger" onClick={() => { updateAdvanceStatus(showDetailModal, 'rejected'); setShowDetailModal(null); }}>
                      <XCircle size={14} className="mr-1" /> Reject
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (window.confirm('Cancel this pending application? It will not be approved.')) {
                          updateAdvanceStatus(showDetailModal, 'cancelled');
                          setShowDetailModal(null);
                        }
                      }}
                    >
                      <Ban size={14} className="mr-1" /> Cancel
                    </Button>
                  </>
                )}
                <Button variant="outline" onClick={() => setShowDetailModal(null)}>Close</Button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Approve Modal -- the ONLY path to pending -> active, via
          approve_salary_advance(). Shape depends on whether this employee
          already has an active advance: if not, this is a simple
          confirmation of the advance's own applied-for terms; if so, a
          NEW combined method/amount-or-period is REQUIRED before Confirm
          becomes enabled (approvePreview stays null until a value is
          entered -- see its own memo). */}
      <Modal open={!!showApproveModal} onClose={closeApproveModal} title="Approve Salary Advance" size="lg">
        {showApproveModal && approveSummary && (() => {
          const emp = employeesById.get(showApproveModal.employee_id);
          const isSecondOrLater = approveSummary.activeCount > 0;
          return (
            <div className="space-y-4">
              <div className="p-3 bg-slate-50 rounded-lg text-sm grid grid-cols-2 gap-2">
                <div><strong>Employee:</strong> {emp?.fullName || 'Unknown'}</div>
                <div><strong>This Application:</strong> {formatKwacha(showApproveModal.advance_amount)}</div>
              </div>

              {isSecondOrLater ? (
                <>
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm grid grid-cols-3 gap-2">
                    <div>
                      <p className="text-xs text-amber-700">Existing Active Outstanding</p>
                      <p className="font-semibold">{formatKwacha(approveSummary.activeOutstanding)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-amber-700">This Advance</p>
                      <p className="font-semibold">{formatKwacha(showApproveModal.advance_amount)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-amber-700">New Combined Outstanding</p>
                      <p className="font-semibold">{formatKwacha(approveNewCombinedOutstanding)}</p>
                    </div>
                  </div>
                  <p className="text-xs text-amber-700 font-medium">
                    This employee already has an active advance. A NEW combined repayment method and monthly
                    amount or period is REQUIRED to approve this second advance -- the old plan cannot be left
                    unchanged.
                  </p>
                </>
              ) : (
                <p className="text-xs text-slate-500">
                  This is the employee's first active advance -- approving it establishes their combined
                  repayment plan from the terms below (pre-filled from the application, still editable).
                </p>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Repayment Method {isSecondOrLater && <span className="text-red-500">*</span>}
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setApproveForm({ ...approveForm, repayment_method: 'monthly_amount' })}
                      className={`flex-1 px-3 py-2 text-sm rounded-lg border ${approveForm.repayment_method === 'monthly_amount' ? 'bg-[#081C3A] text-white border-[#081C3A]' : 'border-slate-200 text-slate-600'}`}
                    >
                      Monthly Amount
                    </button>
                    <button
                      type="button"
                      onClick={() => setApproveForm({ ...approveForm, repayment_method: 'repayment_period' })}
                      className={`flex-1 px-3 py-2 text-sm rounded-lg border ${approveForm.repayment_method === 'repayment_period' ? 'bg-[#081C3A] text-white border-[#081C3A]' : 'border-slate-200 text-slate-600'}`}
                    >
                      Number of Months
                    </button>
                  </div>
                </div>

                {approveForm.repayment_method === 'monthly_amount' ? (
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Combined Monthly Deduction (MK) {isSecondOrLater && <span className="text-red-500">*</span>}
                    </label>
                    <input
                      id="approveMonthlyDeduction"
                      name="approveMonthlyDeduction"
                      type="number"
                      min="0"
                      value={approveForm.monthly_deduction || ''}
                      onChange={(e) => setApproveForm({ ...approveForm, monthly_deduction: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                    />
                  </div>
                ) : (
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Combined Repayment Period (months) {isSecondOrLater && <span className="text-red-500">*</span>}
                    </label>
                    <input
                      id="approveRepaymentPeriod"
                      name="approveRepaymentPeriod"
                      type="number"
                      min="1"
                      step="1"
                      value={approveForm.repayment_period_months || ''}
                      onChange={(e) => setApproveForm({ ...approveForm, repayment_period_months: parseInt(e.target.value, 10) || 0 })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                    />
                  </div>
                )}

                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Deduction Start Month</label>
                  <input
                    id="approveStartMonth"
                    name="approveStartMonth"
                    type="month"
                    value={approveForm.deduction_start_month}
                    onChange={(e) => setApproveForm({ ...approveForm, deduction_start_month: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Notes (optional)</label>
                  <textarea
                    id="approveReason"
                    name="approveReason"
                    rows={2}
                    value={approveForm.reason}
                    onChange={(e) => setApproveForm({ ...approveForm, reason: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                  />
                </div>
              </div>

              {approvePreview && (
                <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                  <h4 className="font-semibold text-slate-800 mb-3">Combined Repayment Plan Preview</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between border-b pb-2">
                      <span className="text-slate-600">Combined Monthly Deduction</span>
                      <span className="font-medium">{formatKwacha(approvePreview.configuredMonthlyDeduction)}</span>
                    </div>
                    <div className="flex justify-between border-b pb-2">
                      <span className="text-slate-600">Number of Months</span>
                      <span className="font-medium">{approvePreview.repaymentPeriodMonths} month{approvePreview.repaymentPeriodMonths !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="flex justify-between border-b pb-2">
                      <span className="text-slate-600">Final Deduction</span>
                      <span className="font-medium">{formatKwacha(approvePreview.finalDeductionAmount)}</span>
                    </div>
                    <div className="flex justify-between pt-2 font-bold text-[#D4A017]">
                      <span>Expected Payoff Month</span>
                      <span>{getMonthLabel(approvePreview.expectedPayoffMonth)}</span>
                    </div>
                  </div>
                </div>
              )}
              {approveError && (
                <p className="text-sm text-red-600">{approveError}</p>
              )}

              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button variant="outline" onClick={closeApproveModal}>Cancel</Button>
                <Button variant="secondary" onClick={submitApproval} disabled={!approvePreview}>
                  Confirm Approval
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Edit / Adjust Combined Repayment Plan Modal -- EMPLOYEE-scoped */}
      <Modal open={!!showEditPlanEmployeeId} onClose={closeEditPlanModal} title="Edit / Adjust Combined Repayment Plan" size="lg">
        {showEditPlanEmployeeId && editPlanSummary && (() => {
          const emp = employeesById.get(showEditPlanEmployeeId);
          // Only ACTIVE advances participate in the combined plan --
          // a pending application (if this employee also has one) is
          // deliberately excluded here, same as the RPC's own computation.
          const activeForEmployee = advances.filter(a => a.employee_id === showEditPlanEmployeeId && a.status === 'active');
          return (
            <div className="space-y-4">
              <div className="p-3 bg-slate-50 rounded-lg text-sm grid grid-cols-2 gap-2">
                <div><strong>Employee:</strong> {emp?.fullName || 'Unknown'}</div>
                <div><strong>Open Slots:</strong> {editPlanSummary.openCount} / {MAX_OPEN_ADVANCES_PER_EMPLOYEE}</div>
                <div><strong>Active Outstanding:</strong> {formatKwacha(editPlanSummary.activeOutstanding)}</div>
                <div><strong>Pending Requested:</strong> {formatKwacha(editPlanSummary.pendingRequested)}</div>
              </div>

              {activeForEmployee.length > 1 && (
                <div className="text-xs text-slate-500">
                  <p className="font-medium mb-1">Active advances (oldest funded first):</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {[...activeForEmployee]
                      .sort((a, b) => a.application_date.localeCompare(b.application_date) || a.created_at.localeCompare(b.created_at))
                      .map((a) => (
                        <li key={a.id}>
                          Advance #{advanceSequenceByEmployee.get(a.id) || 1}: {formatKwacha(getOutstandingBalance(a))} remaining
                        </li>
                      ))}
                  </ul>
                </div>
              )}

              <p className="text-xs text-slate-500">
                This sets the ONE combined monthly deduction for this employee's total outstanding balance
                above -- it can never change any individual advance's original amount or amounts already
                deducted, and it can never move the start month earlier than the next month payroll hasn't
                processed yet.
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Repayment Method</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setEditPlanForm({ ...editPlanForm, repayment_method: 'monthly_amount' })}
                      className={`flex-1 px-3 py-2 text-sm rounded-lg border ${editPlanForm.repayment_method === 'monthly_amount' ? 'bg-[#081C3A] text-white border-[#081C3A]' : 'border-slate-200 text-slate-600'}`}
                    >
                      Fixed Monthly Amount
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditPlanForm({ ...editPlanForm, repayment_method: 'repayment_period' })}
                      className={`flex-1 px-3 py-2 text-sm rounded-lg border ${editPlanForm.repayment_method === 'repayment_period' ? 'bg-[#081C3A] text-white border-[#081C3A]' : 'border-slate-200 text-slate-600'}`}
                    >
                      Repayment Period
                    </button>
                  </div>
                </div>

                {editPlanForm.repayment_method === 'monthly_amount' ? (
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-1">New Monthly Deduction (MK) <span className="text-red-500">*</span></label>
                    <input
                      id="editPlanMonthlyDeduction"
                      name="editPlanMonthlyDeduction"
                      type="number"
                      min="0"
                      value={editPlanForm.monthly_deduction || ''}
                      onChange={(e) => setEditPlanForm({ ...editPlanForm, monthly_deduction: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                    />
                  </div>
                ) : (
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-1">New Repayment Period (months) <span className="text-red-500">*</span></label>
                    <input
                      id="editPlanRepaymentPeriod"
                      name="editPlanRepaymentPeriod"
                      type="number"
                      min="1"
                      step="1"
                      value={editPlanForm.repayment_period_months || ''}
                      onChange={(e) => setEditPlanForm({ ...editPlanForm, repayment_period_months: parseInt(e.target.value, 10) || 0 })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                    />
                  </div>
                )}

                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">New Deduction Start Month</label>
                  <input
                    id="editPlanStartMonth"
                    name="editPlanStartMonth"
                    type="month"
                    value={editPlanForm.deduction_start_month}
                    onChange={(e) => setEditPlanForm({ ...editPlanForm, deduction_start_month: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Reason for Change (optional)</label>
                  <textarea
                    id="editPlanReason"
                    name="editPlanReason"
                    rows={2}
                    value={editPlanForm.reason}
                    onChange={(e) => setEditPlanForm({ ...editPlanForm, reason: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                  />
                </div>
              </div>

              {editPlanPreview && (
                <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                  <h4 className="font-semibold text-slate-800 mb-3">New Schedule Preview</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between border-b pb-2">
                      <span className="text-slate-600">Remaining Deductions</span>
                      <span className="font-medium">{editPlanPreview.repaymentPeriodMonths} month{editPlanPreview.repaymentPeriodMonths !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="flex justify-between border-b pb-2">
                      <span className="text-slate-600">Regular Monthly Deduction</span>
                      <span className="font-medium">{formatKwacha(editPlanPreview.configuredMonthlyDeduction)}</span>
                    </div>
                    <div className="flex justify-between border-b pb-2">
                      <span className="text-slate-600">Final Deduction</span>
                      <span className="font-medium">{formatKwacha(editPlanPreview.finalDeductionAmount)}</span>
                    </div>
                    <div className="flex justify-between pt-2 font-bold text-[#D4A017]">
                      <span>New Expected Payoff Month</span>
                      <span>{getMonthLabel(editPlanPreview.expectedPayoffMonth)}</span>
                    </div>
                  </div>
                </div>
              )}
              {editPlanError && (
                <p className="text-sm text-red-600">{editPlanError}</p>
              )}

              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button variant="outline" onClick={closeEditPlanModal}>Cancel</Button>
                <Button variant="secondary" onClick={submitPlanAdjustment} disabled={!editPlanPreview}>
                  Save New Plan
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}

export default SalaryAdvancesPage;
