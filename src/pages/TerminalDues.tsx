import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Calculator, Search, CheckCircle, Wallet, RotateCcw, Eye, Edit2, Save, ChevronDown, ClipboardList, Banknote, History, AlertTriangle, TrendingUp } from '../utils/icons';
import { Card, Button, Badge, PageHeader, THead, TBody, TR, TH, TD, Modal, Tabs, EmptyState } from '../components/ui';
import { TerminalDuesCalculatorTab, TerminalDuesSubmittedTab } from './TerminalDuesCalculator';
import { TerminalDuesAllocationsTab } from './TerminalDuesAllocations';
import { TerminalDuesPaymentHistoryTab } from './TerminalDuesPaymentHistory';
import { EntitlementRevisionPanel } from './TerminalDuesRevision';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { hasExplicitPermission, PERMISSIONS } from '../utils/permissions';
import { getVisibleTerminalDueActions, shouldShowReturnedForCorrectionBanner, TerminalDueStatus } from '../utils/terminalDueRowActions';
import { showNotification } from '../utils/clickHandlers';
import { logAudit } from '../utils/auditLogger';
import { Pagination } from '../components/Pagination';
import { getDefaultPageSize } from '../utils/uiSettings';
import { calculateTerminalDues as calculateTerminalDuesPure } from '../utils/terminalDuesCalculations';
import { fetchInEmployeeIdBatches, dedupeById } from '../utils/employeeBatchFetch';
import { formatAuditTimestamp, formatAuditValue } from '../utils/terminalDuesAudit';
import { buildOpenDueStatusMap, getOpenDueLabel, isOpenDueUniqueViolation, DUPLICATE_OPEN_DUE_MESSAGE } from '../utils/terminalDuesDuplicates';
import { getErrorMessage } from '../utils/errorHandler';
import { UserProfile } from '../utils/currentProfile';
import {
  computeEntitlementFinancials,
  summarizeTerminalDuesOverview,
  matchesOverviewFilter,
  OverviewFilter,
  OverviewAllocation,
  EntitlementFinancials,
} from '../utils/terminalDuesOverview';

interface Employee {
  id: string;
  employeeNumber: string;
  fullName: string;
  position: string;
  department: string;
  basicSalary: number;
  hire_date: string;
  region_id: string;
  phone: string;
  email: string;
  status: string;
  is_deleted?: boolean;
  uniform_deduction?: number | null;
}

// Raw `employees` row shape (query below is `select('*')`) -- only the
// columns this file actually reads. No generated Supabase types exist in
// this project yet (see AUDIT_REPORT.md's "Supabase generated types"
// section).
interface EmployeeRow {
  id: string;
  employee_number: string | null;
  full_name: string | null;
  position: string | null;
  department: string | null;
  basic_salary: number | null;
  hire_date: string | null;
  region_id: string | null;
  phone: string | null;
  email: string | null;
  status: string | null;
  is_deleted: boolean | null;
  uniform_deduction: number | null;
}

interface TerminalDue {
  id: string;
  // Nullable since Phase 1.6: exactly one of employee_id/historical_employee_id
  // is set (enforced by a DB CHECK) -- a historical former employee has no
  // `employees` row and is referenced via historical_employee_id instead.
  employee_id: string | null;
  historical_employee_id: string | null;
  employee_name: string;
  employee_number: string;
  position: string;
  date_joined: string;
  date_left: string;
  reason_for_termination: string;
  period_months: number;
  basic_salary: number;
  gratuity: number;
  annual_leave: number;
  uniform_refund: number;
  other_benefits: number;
  subtotal: number;
  deductions: number;
  total_payable: number;
  status: 'pending' | 'approved' | 'paid';
  termination_type: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  paid_by: string | null;
  paid_at: string | null;
  payment_date: string | null;
  payment_method: string | null;
  payment_reference: string | null;
  payment_notes: string | null;
  // Populated only while a Pending row is CURRENTLY awaiting correction
  // (set by return_terminal_due_for_correction(), cleared by
  // approve_terminal_due() on re-approval -- 20260907000000). All four are
  // NULL for an ordinary Pending record that was never returned.
  // returned_by_name is a server-resolved snapshot, not a live profiles
  // join -- HR cannot read the returning Admin's own profiles row under
  // profiles' own RLS (non-admin, self-only SELECT), so the name is
  // captured once at return time by the SECURITY DEFINER RPC instead.
  returned_by: string | null;
  returned_by_name: string | null;
  returned_at: string | null;
  return_reason: string | null;
}

const terminationReasons = [
  'Habitual Absenteeism',
  'Attempted Theft',
  'Gross Misconduct',
  'Breach of Trust',
  'Insubordination',
  'Negligence of Duty',
  'Redundancy',
  'Resignation',
  'Retirement',
  'Medical Grounds',
  'End of Contract'
];

const terminationTypes = [
  { value: 'disciplinary', label: 'Disciplinary Hearing' },
  { value: 'redundancy', label: 'Redundancy / Retrenchment' },
  { value: 'resignation', label: 'Resignation' },
  { value: 'retirement', label: 'Retirement' },
  { value: 'medical', label: 'Medical Grounds' },
  { value: 'end_of_contract', label: 'End of Contract' }
];

// Fresh, blank form state for a new calculation. Deductions default to 0 --
// not a guessed amount -- since whether (and how much) to deduct is specific
// to each case's circumstances, not something every termination shares.
const getInitialFormData = () => ({
  employee_id: '',
  date_left: new Date().toISOString().split('T')[0],
  reason: '',
  termination_type: 'disciplinary',
  deductions: 0,
  uniform_refund: 0,
  other_benefits: 0
});

export function TerminalDuesPage() {
  // ===== ALL HOOKS AT TOP LEVEL =====
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [calculations, setCalculations] = useState<TerminalDue[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCalculateModal, setShowCalculateModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState<TerminalDue | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingCalculation, setEditingCalculation] = useState<TerminalDue | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [filterStatus, setFilterStatus] = useState<OverviewFilter>('all');

  // ===== MANAGEMENT FINANCIAL OVERVIEW (Records tab) =====
  // Read-only allocation-ledger rows for every loaded entitlement, used
  // ONLY to derive display figures (actually paid / reserved / remaining /
  // available) -- see src/utils/terminalDuesOverview.ts for the exact,
  // authoritative formulas (same principles as TerminalDuesAllocations.tsx
  // and TerminalDuesPaymentHistoryTab, and the server-side balance check in
  // 20261103000000_terminal_dues_allocation_balance_processed_fix.sql).
  // Fetched for ALL entitlements (not just approved) so a legacy 'paid'
  // row's ledger-conflict check (see hasLedgerConflict) can see allocation
  // rows it should never have. A fetch failure is tracked separately so
  // the summary cards show an explicit error state, never a silent zero.
  const [overviewAllocations, setOverviewAllocations] = useState<OverviewAllocation[]>([]);
  const [overviewAllocationsLoading, setOverviewAllocationsLoading] = useState(false);
  const [overviewAllocationsError, setOverviewAllocationsError] = useState<string | null>(null);
  // Permission-driven action gating. HR Manager: create/edit a Pending
  // calculation, never approve/pay. Functional Admin: approve a Pending
  // calculation (and return an Approved one for correction), never
  // create/edit/pay. Accountant: record payment for an Approved
  // calculation only, never create/edit/approve. ALL FOUR of
  // canCreateTerminalDue/canEditTerminalDue/canApproveTerminalDue/
  // canPayTerminalDue deliberately use hasExplicitPermission() (see
  // permissions.ts), NOT canAccess()/hasPermission() -- every one of
  // create/edit/approve/pay must come from an explicit
  // terminal_dues.create/.edit/.approve/.pay grant (or true super admin),
  // never a legacy role_level bypass or the usual is_business_admin()
  // "Admin gets everything" shortcut (separation-of-duties migration,
  // 20260905000000). Real staging testing caught canCreateTerminalDue/
  // canEditTerminalDue still using the broad canAccess()/hasPermission()
  // path here, which let a functional Admin see Edit "for free" via
  // hasPermission()'s business-admin shortcut despite the database
  // boundary already denying it. All four default to false (fail-closed):
  // never true before fetchUserProfile() actually resolves.
  const [canCreateTerminalDue, setCanCreateTerminalDue] = useState(false);
  const [canEditTerminalDue, setCanEditTerminalDue] = useState(false);
  const [canApproveTerminalDue, setCanApproveTerminalDue] = useState(false);
  const [canPayTerminalDue, setCanPayTerminalDue] = useState(false);

  // Terminal Dues Modernization -- Phase 1/1.5: Calculator/Submitted/Leave
  // tabs, fully additive alongside the existing Records view below (which
  // is preserved unchanged as the default tab). "Submitted" shows
  // calculations promoted into the existing approval workflow via their
  // linked terminal_dues row's own live status -- never a self-reported
  // "Settled" state.
  const [activeTab, setActiveTab] = useState<'records' | 'calculator' | 'submitted' | 'allocations' | 'history' | 'leave'>('records');
  
  // ===== PAGINATION STATES =====
  const [duesPage, setDuesPage] = useState(1);
  const [duesItemsPerPage, setDuesItemsPerPage] = useState(20);
  useEffect(() => { getDefaultPageSize().then(setDuesItemsPerPage); }, []);

  // Searchable employee selector states
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [showEmployeeDropdown, setShowEmployeeDropdown] = useState(false);
  const [filteredEmployees, setFilteredEmployees] = useState<Employee[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  // Form data
  const [formData, setFormData] = useState(getInitialFormData);

  // Preview calculation state
  const [previewCalculation, setPreviewCalculation] = useState<TerminalDue | null>(null);

  // In-flight guard for saveCalculation() -- closes the same-session
  // double-click race that (alongside the missing DB constraint) let HR
  // create two open Terminal Dues for one employee in real staging
  // testing. This is a UX backstop only; the database's partial unique
  // index (idx_terminal_dues_one_open_per_employee) is the real authority.
  const [isSavingCalculation, setIsSavingCalculation] = useState(false);

  // ===== MEMOIZED VALUES =====
  const isSuperAdmin = useMemo(() => userProfile?.is_super_admin, [userProfile]);
  const userRegion = useMemo(() => userProfile?.regions, [userProfile]);

  // employee_id -> its open (pending/approved) status, from the currently
  // loaded terminal_dues rows. Drives the employee-selector disabling
  // below and the pre-flight duplicate check in saveCalculation() -- a
  // Paid-only employee is absent from this map and remains selectable.
  const openDueByEmployeeId = useMemo(() => buildOpenDueStatusMap(calculations), [calculations]);

  const displayedCalculations = useMemo(() => {
    let result = calculations;

    if (filterStatus !== 'all') {
      result = result.filter(c => {
        const financials = financialsByEntitlement.get(c.id);
        // While the allocation ledger is still loading/failed, a financial
        // filter (anything but 'all') has nothing reliable to test against
        // -- hide the row rather than guess, instead of matching it on an
        // undefined/zero financial state.
        if (!financials) return false;
        return matchesOverviewFilter(filterStatus, { id: c.id, status: c.status, total_payable: c.total_payable }, financials);
      });
    }

    if (search) {
      const searchLower = search.toLowerCase();
      result = result.filter(c => {
        const name = (c.employee_name || '').toLowerCase();
        const number = (c.employee_number || '').toLowerCase();
        return name.includes(searchLower) || number.includes(searchLower);
      });
    }
    
    return result;
  }, [calculations, filterStatus, search]);

  // ===== PAGINATED DUES =====
  const paginatedDues = useMemo(() => {
    const startIndex = (duesPage - 1) * duesItemsPerPage;
    const endIndex = Math.min(startIndex + duesItemsPerPage, displayedCalculations.length);
    return displayedCalculations.slice(startIndex, endIndex);
  }, [displayedCalculations, duesPage, duesItemsPerPage]);

  // ===== RESET PAGE WHEN SEARCH OR FILTER CHANGES =====
  useEffect(() => {
    setDuesPage(1);
  }, [search, filterStatus]);

  // ===== CALLBACKS =====
  const fetchUserProfile = useCallback(async () => {
    const profile = await getCurrentProfile();
    setUserProfile(profile);
    setCanCreateTerminalDue(await hasExplicitPermission(PERMISSIONS.TERMINAL_DUES_CREATE));
    setCanEditTerminalDue(await hasExplicitPermission(PERMISSIONS.TERMINAL_DUES_EDIT));
    setCanApproveTerminalDue(await hasExplicitPermission(PERMISSIONS.TERMINAL_DUES_APPROVE));
    setCanPayTerminalDue(await hasExplicitPermission(PERMISSIONS.TERMINAL_DUES_PAY));
  }, []);

  const fetchEmployees = useCallback(async () => {
    try {
      // CRITICAL: Exclude deleted employees
      // employees_general: non-sensitive employee read surface (Design B2) --
      // confirmed no Terminal Dues calculation references any guard column.
      let query = supabase
        .from('employees_general')
        .select('*')
        .eq('status', 'Active')
        .eq('is_deleted', false);

      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        query = query.eq('region_id', userProfile.region_id);
      }

      const { data, error } = await query.order('full_name');
      if (error) throw error;
      
      const mappedEmployees = (data || []).map((emp: EmployeeRow) => ({
        id: emp.id,
        employeeNumber: emp.employee_number || '',
        fullName: emp.full_name || '',
        position: emp.position || '',
        department: emp.department || '',
        basicSalary: emp.basic_salary || 0,
        hire_date: emp.hire_date || new Date().toISOString().split('T')[0],
        region_id: emp.region_id || '',
        phone: emp.phone || '',
        email: emp.email || '',
        status: emp.status || 'Active',
        is_deleted: emp.is_deleted || false,
        uniform_deduction: emp.uniform_deduction
      }));
      
      setEmployees(mappedEmployees);
    } catch (err) {
      console.error('Error fetching employees:', err);
      showNotification('Failed to load employees', 'error');
    }
  }, [userProfile]);

  const fetchCalculations = useCallback(async () => {
    setLoading(true);
    try {
      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        const { data: regionEmployees } = await supabase
          .from('employees')
          .select('id')
          .eq('region_id', userProfile.region_id)
          .eq('is_deleted', false);
        const employeeIds = regionEmployees?.map(e => e.id) || [];

        // Historical-employee-linked rows are tenant-wide, not region-scoped
        // (same policy as historical_employees/terminal_due_calculations
        // themselves) -- fetched separately because `.in('employee_id', ids)`
        // below would otherwise silently exclude every one of them: a NULL
        // employee_id never matches an `IN` list, so a regional,
        // non-super-admin user would see zero historical entitlements with
        // no error at all. Tenant isolation for this query is already
        // enforced by terminal_dues' own (unchanged) SELECT RLS policy.
        const { data: historicalRows, error: historicalError } = await supabase
          .from('terminal_dues')
          .select('*')
          .not('historical_employee_id', 'is', null);
        if (historicalError) throw historicalError;

        // A region with zero active employees must still show any
        // historical-employee entitlements (they are not region-scoped) --
        // never fall through to an unfiltered, cross-region query for the
        // existing-employee side, but don't drop historical rows either.
        if (employeeIds.length === 0) {
          const deduped = dedupeById(historicalRows || []);
          deduped.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
          setCalculations(deduped);
          setLoading(false);
          return;
        }

        // Large regions can hold far more employees than fit in one PostgREST
        // URL's `.in('employee_id', [...])` filter -- batch the id list instead
        // of building a single unbounded request (see employeeBatchFetch.ts).
        const rows = await fetchInEmployeeIdBatches<TerminalDue>(
          employeeIds,
          (batch, from, to, withCount) =>
            supabase
              .from('terminal_dues')
              .select('*', withCount ? { count: 'exact' } : undefined)
              .in('employee_id', batch)
              .range(from, to)
        );
        const deduped = dedupeById([...rows, ...(historicalRows || [])]);
        deduped.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
        setCalculations(deduped);
        return;
      }

      const { data, error } = await supabase
        .from('terminal_dues')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;

      setCalculations(data || []);
    } catch (err) {
      console.error('Error fetching calculations:', err);
      showNotification('Failed to load calculations', 'error');
    } finally {
      setLoading(false);
    }
  }, [userProfile]);

  const fetchOverviewAllocations = useCallback(async (entitlementIds: string[]) => {
    if (entitlementIds.length === 0) {
      setOverviewAllocations([]);
      setOverviewAllocationsError(null);
      return;
    }
    setOverviewAllocationsLoading(true);
    setOverviewAllocationsError(null);
    try {
      const rows = await fetchInEmployeeIdBatches<OverviewAllocation>(
        entitlementIds,
        (batch, from, to, withCount) =>
          supabase
            .from('terminal_due_allocations')
            .select('terminal_due_id, status, proposed_amount, last_decided_amount', withCount ? { count: 'exact' } : undefined)
            .in('terminal_due_id', batch)
            .range(from, to)
      );
      setOverviewAllocations(rows);
    } catch (err) {
      console.error('Error loading Terminal Dues allocation ledger for financial overview:', err);
      setOverviewAllocationsError(getErrorMessage(err));
      setOverviewAllocations([]);
    } finally {
      setOverviewAllocationsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverviewAllocations(calculations.map(c => c.id));
  }, [calculations, fetchOverviewAllocations]);

  // Per-entitlement financials (actually paid / reserved / remaining /
  // available), keyed by terminal_dues.id -- undefined only while the
  // allocation ledger fetch above is still loading or has failed, so
  // consumers can distinguish "not computed yet" from a genuine zero.
  const financialsByEntitlement = useMemo(() => {
    const map = new Map<string, EntitlementFinancials>();
    if (overviewAllocationsError) return map;
    const allocationsByEntitlement = new Map<string, OverviewAllocation[]>();
    for (const a of overviewAllocations) {
      const list = allocationsByEntitlement.get(a.terminal_due_id) || [];
      list.push(a);
      allocationsByEntitlement.set(a.terminal_due_id, list);
    }
    for (const c of calculations) {
      map.set(c.id, computeEntitlementFinancials(
        { id: c.id, status: c.status, total_payable: c.total_payable },
        allocationsByEntitlement.get(c.id) || []
      ));
    }
    return map;
  }, [calculations, overviewAllocations, overviewAllocationsError]);

  const overviewSummary = useMemo(() => {
    if (overviewAllocationsError) return null;
    return summarizeTerminalDuesOverview(
      calculations.map(c => ({ id: c.id, status: c.status, total_payable: c.total_payable })),
      overviewAllocations
    );
  }, [calculations, overviewAllocations, overviewAllocationsError]);

  // ===== INITIALIZATION =====
  useEffect(() => {
    const init = async () => {
      await fetchUserProfile();
    };
    init();
  }, [fetchUserProfile]);

  useEffect(() => {
    if (userProfile) {
      fetchEmployees();
      fetchCalculations();
    }
  }, [userProfile, fetchEmployees, fetchCalculations]);

  // ===== SEARCHABLE EMPLOYEE DROPDOWN =====
  useEffect(() => {
    if (employeeSearch.trim() === '') {
      setFilteredEmployees([]);
      return;
    }
    
    const searchLower = employeeSearch.toLowerCase().trim();
    
    const filtered = employees.filter(emp => {
      const fullName = (emp?.fullName || '').toLowerCase();
      const employeeNumber = (emp?.employeeNumber || '').toLowerCase();
      const position = (emp?.position || '').toLowerCase();
      
      return fullName.includes(searchLower) ||
             employeeNumber.includes(searchLower) ||
             position.includes(searchLower);
    });
    
    setFilteredEmployees(filtered.slice(0, 20));
  }, [employeeSearch, employees]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowEmployeeDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ===== SELECT EMPLOYEE =====
  const selectEmployee = useCallback((employee: Employee) => {
    setSelectedEmployee(employee);
    setFormData(prev => ({
      ...prev,
      employee_id: employee.id,
      uniform_refund: employee.uniform_deduction ?? 0
    }));
    setEmployeeSearch(employee.fullName || '');
    setShowEmployeeDropdown(false);
    setPreviewCalculation(null);
  }, []);

  // ===== CALCULATE TERMINAL DUES =====
  const calculateTerminalDues = useCallback(() => {
    if (!selectedEmployee) {
      showNotification('Please select an employee', 'error');
      return null;
    }

    const result = calculateTerminalDuesPure({
      hireDate: selectedEmployee.hire_date,
      dateLeft: formData.date_left,
      basicSalary: selectedEmployee.basicSalary,
      uniformRefund: formData.uniform_refund,
      otherBenefits: formData.other_benefits,
      deductions: formData.deductions,
    });

    if (!result) {
      showNotification('Date Left must be after the employee\'s Date Joined', 'error');
      return null;
    }

    const calculation: TerminalDue = {
      id: '',
      employee_id: selectedEmployee.id,
      historical_employee_id: null,
      employee_name: selectedEmployee.fullName || 'Unknown',
      employee_number: selectedEmployee.employeeNumber || 'N/A',
      position: selectedEmployee.position || 'N/A',
      date_joined: selectedEmployee.hire_date,
      date_left: formData.date_left,
      reason_for_termination: formData.reason,
      period_months: result.periodMonths,
      basic_salary: result.basicSalary,
      gratuity: result.gratuity,
      annual_leave: result.annualLeave,
      uniform_refund: result.uniformRefund,
      other_benefits: result.otherBenefits,
      subtotal: result.subtotal,
      deductions: result.deductions,
      total_payable: result.totalPayable,
      status: 'pending',
      termination_type: formData.termination_type,
      created_at: new Date().toISOString(),
      approved_by: null,
      approved_at: null,
      paid_by: null,
      paid_at: null,
      payment_date: null,
      payment_method: null,
      payment_reference: null,
      payment_notes: null,
      returned_by: null,
      returned_by_name: null,
      returned_at: null,
      return_reason: null
    };

    setPreviewCalculation(calculation);
    return calculation;
  }, [selectedEmployee, formData]);

  // ===== SAVE CALCULATION =====
  const saveCalculation = useCallback(async () => {
    if (!selectedEmployee) {
      showNotification('Please select an employee', 'error');
      return;
    }

    // Defensive, non-authoritative pre-check -- the database's partial
    // unique index (idx_terminal_dues_one_open_per_employee) is what
    // actually prevents a duplicate open due; this only avoids a round
    // trip for the common case (e.g. stale `calculations` from before a
    // refresh) and always has a race window, which is why the 23505
    // handling below exists regardless of this check.
    if (openDueByEmployeeId.has(selectedEmployee.id)) {
      showNotification(DUPLICATE_OPEN_DUE_MESSAGE, 'error');
      return;
    }

    const calculation = calculateTerminalDues();
    if (!calculation) return;

    // `id` is destructured out only to exclude it from the insert payload below.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, ...calculationToSave } = calculation;

    setIsSavingCalculation(true);
    try {
      const { data, error } = await supabase
        .from('terminal_dues')
        .insert([calculationToSave])
        .select();

      if (error) {
        if (isOpenDueUniqueViolation(error)) {
          showNotification(DUPLICATE_OPEN_DUE_MESSAGE, 'error');
        } else {
          showNotification('Error saving calculation: ' + getErrorMessage(error), 'error');
        }
        console.error('Error:', error);
      } else {
        await logAudit({
          action: 'CREATE',
          entity_type: 'terminal_due',
          entity_id: data?.[0]?.id || 'new',
          new_data: {
            employee_name: calculation.employee_name,
            employee_number: calculation.employee_number,
            position: calculation.position,
            total_payable: calculation.total_payable,
            gratuity: calculation.gratuity,
            annual_leave: calculation.annual_leave,
            uniform_refund: calculation.uniform_refund,
            deductions: calculation.deductions,
            termination_type: calculation.termination_type,
            reason: calculation.reason_for_termination,
            period_months: calculation.period_months
          },
          region_id: userProfile?.region_id
        });

        showNotification('Terminal dues calculated successfully', 'success');
        setPreviewCalculation(null);
        setShowCalculateModal(false);
        setEmployeeSearch('');
        setSelectedEmployee(null);
        setFormData(getInitialFormData());
        await fetchCalculations();
      }
    } finally {
      setIsSavingCalculation(false);
    }
  }, [selectedEmployee, calculateTerminalDues, userProfile, fetchCalculations, openDueByEmployeeId]);

  // ===== APPROVE (Pending -> Approved) =====
  // Status transitions go through narrow SECURITY DEFINER RPCs, never a
  // direct client UPDATE -- RLS itself now rejects any client attempt to
  // change `status` on this table (see migration 20260905000000). The RPC
  // performs its own audit_logs insert, so no separate logAudit() call is
  // needed here.
  const approveTerminalDue = useCallback(async (id: string) => {
    const { error } = await supabase.rpc('approve_terminal_due', { p_terminal_due_id: id });
    if (error) {
      showNotification('Error approving terminal due: ' + error.message, 'error');
      return;
    }
    showNotification('Terminal due approved', 'success');
    await fetchCalculations();
  }, [fetchCalculations]);

  // ===== RECORD PAYMENT (Approved -> Paid) =====
  const [showPaymentModal, setShowPaymentModal] = useState<TerminalDue | null>(null);
  const [paymentForm, setPaymentForm] = useState({
    payment_date: new Date().toISOString().split('T')[0],
    payment_method: '',
    payment_reference: '',
    payment_notes: ''
  });

  const openPaymentModal = useCallback((calc: TerminalDue) => {
    setPaymentForm({
      payment_date: new Date().toISOString().split('T')[0],
      payment_method: '',
      payment_reference: '',
      payment_notes: ''
    });
    setShowPaymentModal(calc);
  }, []);

  const submitPayment = useCallback(async () => {
    if (!showPaymentModal) return;
    if (!paymentForm.payment_method.trim() || !paymentForm.payment_reference.trim()) {
      showNotification('Payment method and reference are required', 'error');
      return;
    }

    const { error } = await supabase.rpc('record_terminal_due_payment', {
      p_terminal_due_id: showPaymentModal.id,
      p_payment_date: paymentForm.payment_date,
      p_payment_method: paymentForm.payment_method.trim(),
      p_payment_reference: paymentForm.payment_reference.trim(),
      p_notes: paymentForm.payment_notes.trim() || null
    });

    if (error) {
      showNotification('Error recording payment: ' + error.message, 'error');
      return;
    }
    showNotification('Payment recorded', 'success');
    setShowPaymentModal(null);
    await fetchCalculations();
  }, [showPaymentModal, paymentForm, fetchCalculations]);

  // ===== RETURN FOR CORRECTION (Approved -> Pending) =====
  const [showReturnModal, setShowReturnModal] = useState<TerminalDue | null>(null);
  const [returnReason, setReturnReason] = useState('');

  const openReturnModal = useCallback((calc: TerminalDue) => {
    setReturnReason('');
    setShowReturnModal(calc);
  }, []);

  const submitReturn = useCallback(async () => {
    if (!showReturnModal) return;
    if (!returnReason.trim()) {
      showNotification('A reason is required to return for correction', 'error');
      return;
    }

    const { error } = await supabase.rpc('return_terminal_due_for_correction', {
      p_terminal_due_id: showReturnModal.id,
      p_reason: returnReason.trim()
    });

    if (error) {
      showNotification('Error returning for correction: ' + error.message, 'error');
      return;
    }
    showNotification('Returned to Pending for correction', 'success');
    setShowReturnModal(null);
    setReturnReason('');
    await fetchCalculations();
  }, [showReturnModal, returnReason, fetchCalculations]);

  // ===== UPDATE CALCULATION =====
  const updateCalculation = useCallback(async () => {
    if (!editingCalculation) return;

    const existingCalc = calculations.find(c => c.id === editingCalculation.id);
    
    const subtotal = editingCalculation.gratuity + editingCalculation.annual_leave + 
                     editingCalculation.uniform_refund + editingCalculation.other_benefits;
    const totalPayable = subtotal - editingCalculation.deductions;

    // Deliberately does NOT send `status` -- RLS now requires the row to
    // stay 'pending' across a direct client UPDATE (see migration
    // 20260905000000), so this edit path only ever touches a Pending
    // calculation's financial fields, never its status.
    const { error } = await supabase
      .from('terminal_dues')
      .update({
        deductions: editingCalculation.deductions,
        uniform_refund: editingCalculation.uniform_refund,
        other_benefits: editingCalculation.other_benefits,
        reason_for_termination: editingCalculation.reason_for_termination,
        termination_type: editingCalculation.termination_type,
        subtotal: subtotal,
        total_payable: totalPayable,
        updated_at: new Date().toISOString()
      })
      .eq('id', editingCalculation.id);

    if (error) {
      showNotification('Error updating: ' + error.message, 'error');
    } else {
      await logAudit({
        action: 'UPDATE',
        entity_type: 'terminal_due',
        entity_id: editingCalculation.id,
        old_data: {
          employee_name: existingCalc?.employee_name || editingCalculation.employee_name,
          employee_number: existingCalc?.employee_number || editingCalculation.employee_number,
          deductions: existingCalc?.deductions || 0,
          uniform_refund: existingCalc?.uniform_refund || 0,
          other_benefits: existingCalc?.other_benefits || 0,
          total_payable: existingCalc?.total_payable || 0,
          status: existingCalc?.status || 'pending',
          reason: existingCalc?.reason_for_termination || '',
          termination_type: existingCalc?.termination_type || ''
        },
        new_data: {
          employee_name: editingCalculation.employee_name,
          employee_number: editingCalculation.employee_number,
          deductions: editingCalculation.deductions,
          uniform_refund: editingCalculation.uniform_refund,
          other_benefits: editingCalculation.other_benefits,
          total_payable: totalPayable,
          status: editingCalculation.status,
          reason: editingCalculation.reason_for_termination,
          termination_type: editingCalculation.termination_type
        },
        region_id: userProfile?.region_id
      });

      showNotification('Calculation updated successfully', 'success');
      setShowEditModal(false);
      setEditingCalculation(null);
      fetchCalculations();
    }
  }, [editingCalculation, calculations, userProfile, fetchCalculations]);

  // ===== VIEW DETAIL =====
  const handleViewDetail = useCallback(async (calc: TerminalDue) => {
    setShowDetailModal(calc);
    
    await logAudit({
      action: 'VIEW',
      entity_type: 'terminal_due',
      entity_id: calc.id,
      new_data: {
        employee_name: calc.employee_name,
        employee_number: calc.employee_number,
        total_payable: calc.total_payable,
        status: calc.status
      },
      region_id: userProfile?.region_id
    });
  }, [userProfile]);

  // ===== GET STATUS COLOR =====
  const getStatusColor = useCallback((status: string) => {
    switch (status) {
      case 'approved': return 'green';
      case 'paid': return 'blue';
      case 'pending': return 'yellow';
      default: return 'gray';
    }
  }, []);

  // Settlement badge for the financial overview table/detail view --
  // derived from EntitlementFinancials.settlementStatus (see
  // src/utils/terminalDuesOverview.ts), never from the raw
  // terminal_dues.status alone: an 'approved' entitlement can be
  // not-yet-processed, partially processed, or fully settled via the
  // ledger while its own status column never changes from 'approved'.
  const getSettlementBadgeColor = useCallback((financials: EntitlementFinancials | undefined): 'gray' | 'yellow' | 'blue' | 'green' => {
    if (!financials) return 'gray';
    switch (financials.settlementStatus) {
      case 'pending_approval': return 'yellow';
      case 'not_yet_processed': return 'gray';
      case 'partially_processed': return 'blue';
      case 'fully_settled': return 'green';
    }
  }, []);

  const getSettlementBadgeLabel = useCallback((financials: EntitlementFinancials | undefined): string => {
    if (!financials) return 'Loading...';
    switch (financials.settlementStatus) {
      case 'pending_approval': return 'Pending Approval';
      case 'not_yet_processed': return 'Not Yet Processed';
      case 'partially_processed': return 'Partially Processed';
      case 'fully_settled': return 'Fully Settled';
    }
  }, []);

  // ===== RENDER =====
  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin"></div></div>;
  }

  const totalPages = Math.ceil(displayedCalculations.length / duesItemsPerPage);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Terminal Dues Calculator"
        subtitle="Calculate and manage employee termination benefits"
        actions={
          canCreateTerminalDue ? (
            <Button variant="secondary" onClick={() => setShowCalculateModal(true)}>
              <Calculator size={16} className="mr-1" /> New Calculation
            </Button>
          ) : undefined
        }
      />

      <Tabs
        tabs={[
          { id: 'records', label: 'Records', icon: Wallet },
          { id: 'calculator', label: 'Calculator', icon: Calculator },
          { id: 'submitted', label: 'Submitted', icon: CheckCircle },
          { id: 'allocations', label: 'Allocations', icon: Banknote },
          { id: 'history', label: 'Payment History', icon: History },
          { id: 'leave', label: 'Leave', icon: ClipboardList },
        ]}
        active={activeTab}
        onChange={id => setActiveTab(id as typeof activeTab)}
      />

      {activeTab === 'calculator' && (
        <TerminalDuesCalculatorTab
          employees={employees.map(e => ({
            id: e.id,
            employeeNumber: e.employeeNumber,
            fullName: e.fullName,
            position: e.position,
            basicSalary: e.basicSalary,
            hire_date: e.hire_date,
            region_id: e.region_id,
            uniform_deduction: e.uniform_deduction,
          }))}
          canCreate={canCreateTerminalDue}
          canEdit={canEditTerminalDue}
        />
      )}

      {activeTab === 'submitted' && <TerminalDuesSubmittedTab canEdit={canEditTerminalDue} />}

      {activeTab === 'allocations' && (
        <TerminalDuesAllocationsTab
          approvedEntitlements={calculations
            .filter(c => c.status === 'approved')
            .map(c => ({
              id: c.id,
              employee_id: c.employee_id,
              historical_employee_id: c.historical_employee_id,
              employee_name: c.employee_name,
              employee_number: c.employee_number,
              total_payable: c.total_payable,
              status: c.status,
            }))}
          canPropose={canCreateTerminalDue || canEditTerminalDue}
          canApprove={canApproveTerminalDue}
        />
      )}

      {activeTab === 'history' && (
        <TerminalDuesPaymentHistoryTab
          approvedEntitlements={calculations
            .filter(c => c.status === 'approved')
            .map(c => ({
              id: c.id,
              employee_id: c.employee_id,
              historical_employee_id: c.historical_employee_id,
              employee_name: c.employee_name,
              employee_number: c.employee_number,
              date_joined: c.date_joined,
              date_left: c.date_left,
              reason_for_termination: c.reason_for_termination,
              gratuity: c.gratuity,
              annual_leave: c.annual_leave,
              uniform_refund: c.uniform_refund,
              other_benefits: c.other_benefits,
              deductions: c.deductions,
              subtotal: c.subtotal,
              total_payable: c.total_payable,
              approved_at: c.approved_at,
              status: c.status,
            }))}
          canView={canCreateTerminalDue || canEditTerminalDue || canApproveTerminalDue || canPayTerminalDue}
        />
      )}

      {activeTab === 'leave' && (
        <EmptyState
          icon={ClipboardList}
          title="Leave -- coming in a future phase"
          description="This tab is a placeholder reserved for upcoming leave-management functionality. No leave functionality exists here yet."
        />
      )}

      {activeTab === 'records' && (
      <>
      {!isSuperAdmin && userRegion && (
        <Card className="p-3 bg-gradient-to-r from-[#081C3A]/5 to-transparent border-[#081C3A]/20">
          <p className="text-sm text-slate-600">
            Managing terminal dues for <strong className="text-[#081C3A]">{userRegion.name}</strong> region
          </p>
        </Card>
      )}

      {/* Management Financial Overview -- summary cards A-E. Every figure
          here is derived from the same authoritative sources the rest of
          the Terminal Dues UI uses (terminal_dues.total_payable/status and
          terminal_due_allocations) via src/utils/terminalDuesOverview.ts;
          nothing here is a new calculation. On an allocation-ledger fetch
          failure, cards B-E show an explicit error state rather than a
          silent zero -- see overviewAllocationsError below. */}
      {overviewAllocationsError ? (
        <Card className="p-4 bg-red-50 border-red-200">
          <div className="flex items-start gap-2 text-sm text-red-700">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium">Could not load the payment allocation ledger -- financial figures below are incomplete.</p>
              <p className="text-xs mt-1">{overviewAllocationsError}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => fetchOverviewAllocations(calculations.map(c => c.id))}>
                Retry
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <Card className="p-4">
            <p className="text-xs text-slate-500">Total Confirmed Entitlements</p>
            <p className="text-lg font-bold text-slate-800 mt-1">
              {overviewSummary ? formatKwacha(overviewSummary.confirmedEntitlementTotal) : '...'}
            </p>
            <p className="text-xs text-slate-400 mt-1">
              {overviewSummary ? `${overviewSummary.confirmedEntitlementCount} ${overviewSummary.confirmedEntitlementCount === 1 ? 'employee' : 'employees'}` : 'Loading...'}
              {overviewSummary && overviewSummary.pendingApprovalCount > 0 && (
                <> &middot; {overviewSummary.pendingApprovalCount} more awaiting approval, not included</>
              )}
            </p>
          </Card>
          <Card className="p-4 bg-emerald-50 border-emerald-200">
            <p className="text-xs text-emerald-700">Total Actually Paid</p>
            <p className="text-lg font-bold text-emerald-800 mt-1">
              {overviewSummary ? formatKwacha(overviewSummary.actuallyPaidTotal) : '...'}
            </p>
            <p className="text-xs text-emerald-600 mt-1">Processed via Payroll or confirmed legacy payment only</p>
          </Card>
          <Card className="p-4 bg-red-50 border-red-200">
            <p className="text-xs text-red-700">Remaining Liability</p>
            <p className="text-lg font-bold text-red-800 mt-1">
              {overviewSummary ? formatKwacha(overviewSummary.remainingLiabilityTotal) : '...'}
            </p>
            <p className="text-xs text-red-600 mt-1">
              {overviewSummary && overviewSummary.ledgerConflictCount > 0
                ? `${overviewSummary.ledgerConflictCount} record(s) need reconciliation -- see warnings below`
                : 'Confirmed entitlements minus verified payments'}
            </p>
          </Card>
          <Card className="p-4 bg-amber-50 border-amber-200">
            <p className="text-xs text-amber-700">Approved for Payroll (Reserved -- Not Paid)</p>
            <p className="text-lg font-bold text-amber-800 mt-1">
              {overviewSummary ? formatKwacha(overviewSummary.approvedForPayrollTotal) : '...'}
            </p>
            <p className="text-xs text-amber-600 mt-1">Approved allocations awaiting Process Payroll</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-slate-500 flex items-center gap-1"><TrendingUp size={12} /> Settlement Progress</p>
            <p className="text-lg font-bold text-[#081C3A] mt-1">
              {overviewSummary ? `${overviewSummary.settlementProgressPct.toFixed(0)}%` : '...'}
            </p>
            <div className="w-full h-1.5 bg-slate-100 rounded-full mt-2 overflow-hidden">
              <div
                className="h-full bg-[#081C3A] rounded-full"
                style={{ width: `${overviewSummary ? overviewSummary.settlementProgressPct : 0}%` }}
              />
            </div>
          </Card>
        </div>
      )}

      {/* Interactive status filters (Step 3) -- real financial state, not
          passive counters. There is no "Rejected" pill: terminal_dues has
          no rejected status (the closest real transition, Return for
          Correction, sends an approved row back to Pending, which the
          Pending Approval filter + the existing returned-for-correction
          banner in the detail view already surface). */}
      <Card className="p-4">
        {overviewAllocationsLoading && (
          <p className="text-xs text-slate-400 mb-2">Loading payment allocation ledger...</p>
        )}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {([
            ['all', 'All Records'],
            ['pending_approval', 'Pending Approval'],
            ['outstanding', 'Outstanding'],
            ['fully_settled', 'Fully Settled'],
          ] as [OverviewFilter, string][]).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilterStatus(value)}
              className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
                filterStatus === value
                  ? 'bg-[#081C3A] text-white border-[#081C3A]'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="relative md:col-span-2">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              id="searchDues"
              name="searchDues"
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name or employee #..."
              className="w-full pl-10 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>
          <Button variant="outline" onClick={() => {
            setSearch('');
            setFilterStatus('all');
            setDuesPage(1);
          }} className="text-sm">
            Clear Filters
          </Button>
        </div>
      </Card>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <THead>
              <TR hover={false}>
                <TH>Employee</TH>
                <TH className="text-right">Total Entitlement</TH>
                <TH className="text-right">Actually Paid</TH>
                <TH className="text-right">Reserved for Payroll</TH>
                <TH className="text-right">Remaining Balance</TH>
                <TH>Status</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {paginatedDues.length === 0 ? (
                <TR>
                  <TD colSpan={7} className="text-center py-8 text-slate-500">
                    <Calculator size={32} className="mx-auto mb-2 text-slate-300" />
                    {calculations.length === 0 ? 'No terminal due calculations found' : 'No matching calculations found'}
                  </TD>
                </TR>
              ) : (
                paginatedDues.map((calc) => {
                  const rowActions = getVisibleTerminalDueActions(calc.status as TerminalDueStatus, {
                    canCreate: canCreateTerminalDue,
                    canEdit: canEditTerminalDue,
                    canApprove: canApproveTerminalDue,
                    canPay: canPayTerminalDue,
                  });
                  const financials = financialsByEntitlement.get(calc.id);
                  const isPending = calc.status === 'pending';
                  return (
                  <TR key={calc.id} className="hover:bg-slate-50">
                    <TD>
                      <div>
                        <p className="font-medium text-slate-800 flex items-center gap-1.5">
                          {calc.employee_name}
                          {calc.historical_employee_id && <Badge color="gray">Historical</Badge>}
                        </p>
                        <p className="text-xs text-slate-500">{calc.employee_number}</p>
                      </div>
                    </TD>
                    <TD className="text-right font-semibold text-slate-800">
                      {formatKwacha(calc.total_payable)}
                    </TD>
                    <TD className="text-right text-emerald-700">
                      {isPending || !financials ? '--' : formatKwacha(financials.actuallyPaid)}
                    </TD>
                    <TD className="text-right text-amber-700">
                      {isPending || !financials ? '--' : formatKwacha(financials.approvedUnprocessed)}
                    </TD>
                    <TD className="text-right font-semibold text-red-700">
                      {isPending || !financials ? '--' : formatKwacha(financials.remainingLiability)}
                    </TD>
                    <TD>
                      <div className="flex flex-col gap-1">
                        <Badge color={getSettlementBadgeColor(financials)}>
                          {getSettlementBadgeLabel(financials)}
                        </Badge>
                        {financials?.hasLedgerConflict && (
                          <span className="text-xs text-red-600 flex items-center gap-1" title="This legacy-paid record also has payment allocation ledger rows -- needs Admin reconciliation.">
                            <AlertTriangle size={12} /> Needs reconciliation
                          </span>
                        )}
                      </div>
                    </TD>
                    <TD className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => handleViewDetail(calc)}
                          className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-600"
                          title="View Details"
                        >
                          <Eye size={14} />
                        </button>
                        {rowActions.showEdit && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCalculation(calc);
                              setShowEditModal(true);
                            }}
                            className="w-7 h-7 rounded-lg hover:bg-slate-100 text-amber-600"
                            title="Edit"
                          >
                            <Edit2 size={14} />
                          </button>
                        )}
                        {rowActions.showApprove && (
                          <button
                            type="button"
                            onClick={() => approveTerminalDue(calc.id)}
                            className="w-7 h-7 rounded-lg hover:bg-emerald-100 text-emerald-600"
                            title="Approve"
                          >
                            <CheckCircle size={14} />
                          </button>
                        )}
                        {rowActions.showReturnForCorrection && (
                          <button
                            type="button"
                            onClick={() => openReturnModal(calc)}
                            className="w-7 h-7 rounded-lg hover:bg-amber-100 text-amber-600"
                            title="Return for Correction"
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                        {rowActions.showRecordPayment && (
                          <button
                            type="button"
                            onClick={() => openPaymentModal(calc)}
                            className="w-7 h-7 rounded-lg hover:bg-blue-100 text-blue-600"
                            title="Record Payment"
                          >
                            <Wallet size={14} />
                          </button>
                        )}
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
        currentPage={duesPage}
        totalPages={totalPages}
        totalItems={displayedCalculations.length}
        itemsPerPage={duesItemsPerPage}
        onPageChange={setDuesPage}
        onItemsPerPageChange={setDuesItemsPerPage}
      />

      {/* Calculate Modal with Searchable Employee Selector */}
      <Modal open={showCalculateModal} onClose={() => {
        setShowCalculateModal(false);
        setPreviewCalculation(null);
        setEmployeeSearch('');
        setSelectedEmployee(null);
        setShowEmployeeDropdown(false);
        setFormData(getInitialFormData());
      }} title="Calculate Terminal Dues" size="lg">
        <div className="space-y-4">
          {/* Searchable Employee Selector */}
          <div>
            <label htmlFor="employeeSearch" className="block text-sm font-medium text-slate-700 mb-1">
              Search Employee <span className="text-red-500">*</span>
            </label>
            <div className="relative" ref={dropdownRef}>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  id="employeeSearch"
                  name="employeeSearch"
                  ref={inputRef}
                  type="text"
                  value={employeeSearch}
                  onChange={(e) => {
                    setEmployeeSearch(e.target.value);
                    setShowEmployeeDropdown(true);
                    if (e.target.value === '') {
                      setSelectedEmployee(null);
                      setFormData({ ...formData, employee_id: '' });
                    }
                  }}
                  onFocus={() => {
                    if (employeeSearch.trim() !== '') {
                      setShowEmployeeDropdown(true);
                    }
                  }}
                  placeholder="Type employee name, ID or position..."
                  className="w-full pl-10 pr-10 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] focus:border-transparent"
                />
                <ChevronDown 
                  size={16} 
                  className={`absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-transform ${showEmployeeDropdown ? 'rotate-180' : ''}`}
                />
              </div>
              
              {/* Dropdown results */}
              {showEmployeeDropdown && employeeSearch.trim() !== '' && (
                <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                  {filteredEmployees.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-slate-500 text-center">
                      No active employees found matching "{employeeSearch}"
                    </div>
                  ) : (
                    filteredEmployees.map((emp) => {
                      const openLabel = getOpenDueLabel(openDueByEmployeeId.get(emp.id));
                      return (
                        <button
                          key={emp.id}
                          type="button"
                          disabled={!!openLabel}
                          onClick={() => selectEmployee(emp)}
                          title={openLabel ?? undefined}
                          className={`w-full text-left px-4 py-2.5 border-b border-slate-100 last:border-0 transition-colors flex items-center gap-3 ${
                            openLabel ? 'opacity-50 cursor-not-allowed bg-slate-50' : 'hover:bg-slate-50'
                          }`}
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
                          {openLabel ? (
                            <div className="text-xs font-medium text-amber-700">
                              {openLabel}
                            </div>
                          ) : (
                            <div className="text-xs font-medium text-[#D4A017]">
                              {formatKwacha(emp.basicSalary || 0)}
                            </div>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
            {selectedEmployee && (
              <div className="mt-2 p-2 bg-emerald-50 border border-emerald-200 rounded-lg text-sm flex items-center gap-2">
                <CheckCircle size={16} className="text-emerald-600" />
                <span className="text-emerald-700">Selected: <strong>{selectedEmployee.fullName || 'Unknown'}</strong> ({selectedEmployee.employeeNumber || 'N/A'})</span>
              </div>
            )}
          </div>

          {selectedEmployee && (
            <div className="p-3 bg-slate-50 rounded-lg text-sm grid grid-cols-2 gap-2">
              <div><strong>Employee:</strong> {selectedEmployee.fullName || 'Unknown'}</div>
              <div><strong>Employee #:</strong> {selectedEmployee.employeeNumber || 'N/A'}</div>
              <div><strong>Position:</strong> {selectedEmployee.position || 'N/A'}</div>
              <div><strong>Basic Salary:</strong> {formatKwacha(selectedEmployee.basicSalary ?? 150000)}</div>
              <div className="col-span-2"><strong>Date Joined:</strong> {new Date(selectedEmployee.hire_date).toLocaleDateString()}</div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Date Left</label>
              <input
                id="dateLeft"
                name="dateLeft"
                type="date"
                value={formData.date_left}
                onChange={(e) => {
                  setFormData({ ...formData, date_left: e.target.value });
                  setPreviewCalculation(null);
                }}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Termination Type</label>
              <select
                id="terminationType"
                name="terminationType"
                value={formData.termination_type}
                onChange={(e) => {
                  setFormData({ ...formData, termination_type: e.target.value });
                  setPreviewCalculation(null);
                }}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              >
                {terminationTypes.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Reason for Termination</label>
              <select
                id="terminationReason"
                name="terminationReason"
                value={formData.reason}
                onChange={(e) => {
                  setFormData({ ...formData, reason: e.target.value });
                  setPreviewCalculation(null);
                }}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              >
                <option value="">-- Select Reason --</option>
                {terminationReasons.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Deductions (MK)</label>
              <input
                id="deductions"
                name="deductions"
                type="number"
                value={formData.deductions}
                onChange={(e) => {
                  setFormData({ ...formData, deductions: parseFloat(e.target.value) || 0 });
                  setPreviewCalculation(null);
                }}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Uniform Refund (MK)</label>
              <input
                id="uniformRefund"
                name="uniformRefund"
                type="number"
                value={formData.uniform_refund}
                onChange={(e) => {
                  setFormData({ ...formData, uniform_refund: parseFloat(e.target.value) || 0 });
                  setPreviewCalculation(null);
                }}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>
          </div>

          {/* Preview Section */}
          {selectedEmployee && (
            <div className="border-t pt-4">
              <Button 
                variant="outline" 
                onClick={() => calculateTerminalDues()}
                className="w-full mb-4"
              >
                <Calculator size={14} className="mr-1" /> Preview Calculation
              </Button>

              {previewCalculation && (
                <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                  <h4 className="font-semibold text-slate-800 mb-3">Calculation Preview</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between border-b pb-2">
                      <span className="text-slate-600">Period</span>
                      <span className="font-medium">{previewCalculation.period_months} months</span>
                    </div>
                    <div className="flex justify-between border-b pb-2">
                      <span className="text-slate-600">Pension Arrears (Gratuity)</span>
                      <span className="font-medium">{formatKwacha(previewCalculation.gratuity)}</span>
                    </div>
                    <div className="flex justify-between border-b pb-2">
                      <span className="text-slate-600">Annual Leave</span>
                      <span className="font-medium">{formatKwacha(previewCalculation.annual_leave)}</span>
                    </div>
                    <div className="flex justify-between border-b pb-2">
                      <span className="text-slate-600">Uniform Refund</span>
                      <span className="font-medium">{formatKwacha(previewCalculation.uniform_refund)}</span>
                    </div>
                    {previewCalculation.other_benefits > 0 && (
                      <div className="flex justify-between border-b pb-2">
                        <span className="text-slate-600">Other Benefits</span>
                        <span className="font-medium">{formatKwacha(previewCalculation.other_benefits)}</span>
                      </div>
                    )}
                    <div className="flex justify-between border-b pb-2 font-semibold">
                      <span>Subtotal</span>
                      <span>{formatKwacha(previewCalculation.subtotal)}</span>
                    </div>
                    <div className="flex justify-between border-b pb-2 text-red-600">
                      <span>Deductions</span>
                      <span>-{formatKwacha(previewCalculation.deductions)}</span>
                    </div>
                    <div className="flex justify-between pt-2 font-bold text-lg text-[#D4A017]">
                      <span>Total Payable</span>
                      <span>{formatKwacha(previewCalculation.total_payable)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" onClick={() => {
              setShowCalculateModal(false);
              setPreviewCalculation(null);
              setEmployeeSearch('');
              setSelectedEmployee(null);
              setFormData(getInitialFormData());
            }}>Cancel</Button>
            <Button variant="secondary" onClick={saveCalculation} disabled={!selectedEmployee || isSavingCalculation}>
              <Save size={14} className="mr-1" /> {isSavingCalculation ? 'Saving...' : 'Save Calculation'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal open={!!showDetailModal} onClose={() => setShowDetailModal(null)} title="Terminal Dues Details" size="lg">
        {showDetailModal && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-slate-500">Employee</p>
                <p className="font-semibold flex items-center gap-1.5">
                  {showDetailModal.employee_name}
                  {showDetailModal.historical_employee_id && <Badge color="gray">Historical</Badge>}
                </p>
              </div>
              <div><p className="text-slate-500">Employee #</p><p className="font-semibold">{showDetailModal.employee_number}</p></div>
              <div><p className="text-slate-500">Position</p><p className="font-semibold">{showDetailModal.position}</p></div>
              <div><p className="text-slate-500">Status</p><Badge color={getStatusColor(showDetailModal.status)}>{showDetailModal.status.toUpperCase()}</Badge></div>
            </div>

            <div className="border-t pt-4">
              <h4 className="font-semibold text-slate-800 mb-3">Breakdown</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between border-b pb-2">
                  <span className="text-slate-600">Period</span>
                  <span className="font-medium">{showDetailModal.period_months} months</span>
                </div>
                <div className="flex justify-between border-b pb-2">
                  <span className="text-slate-600">Pension Arrears (Gratuity)</span>
                  <span className="font-medium">{formatKwacha(showDetailModal.gratuity)}</span>
                </div>
                <div className="flex justify-between border-b pb-2">
                  <span className="text-slate-600">Annual Leave</span>
                  <span className="font-medium">{formatKwacha(showDetailModal.annual_leave)}</span>
                </div>
                <div className="flex justify-between border-b pb-2">
                  <span className="text-slate-600">Uniform Refund</span>
                  <span className="font-medium">{formatKwacha(showDetailModal.uniform_refund)}</span>
                </div>
                {showDetailModal.other_benefits > 0 && (
                  <div className="flex justify-between border-b pb-2">
                    <span className="text-slate-600">Other Benefits</span>
                    <span className="font-medium">{formatKwacha(showDetailModal.other_benefits)}</span>
                  </div>
                )}
                <div className="flex justify-between border-b pb-2 font-semibold">
                  <span>Subtotal</span>
                  <span>{formatKwacha(showDetailModal.subtotal)}</span>
                </div>
                <div className="flex justify-between border-b pb-2 text-red-600">
                  <span>Deductions</span>
                  <span>-{formatKwacha(showDetailModal.deductions)}</span>
                </div>
                <div className="flex justify-between pt-2 font-bold text-lg text-[#D4A017]">
                  <span>Total Payable</span>
                  <span>{formatKwacha(showDetailModal.total_payable)}</span>
                </div>
              </div>
            </div>

            {/* Financial overview (Step 5) -- processed payments, reserved
                allocations and the resulting balance, for THIS one
                entitlement. Same figures/formulas as the Records table and
                the Allocations/Payment History tabs; nothing here is
                recomputed differently. */}
            {showDetailModal.status !== 'pending' && (() => {
              const financials = financialsByEntitlement.get(showDetailModal.id);
              return (
                <div className="border-t pt-4">
                  <h4 className="font-semibold text-slate-800 mb-3">Financial Overview</h4>
                  {!financials ? (
                    <p className="text-xs text-slate-400">
                      {overviewAllocationsError ? `Could not load payment allocation data: ${overviewAllocationsError}` : 'Loading...'}
                    </p>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <p className="text-slate-500 text-xs">Actually Paid</p>
                          <p className="font-semibold text-emerald-700">{formatKwacha(financials.actuallyPaid)}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Approved, Reserved for Payroll</p>
                          <p className="font-semibold text-amber-700">{formatKwacha(financials.approvedUnprocessed)}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Remaining Liability</p>
                          <p className="font-semibold text-red-700">{formatKwacha(financials.remainingLiability)}</p>
                        </div>
                        <div>
                          <p className="text-slate-500 text-xs">Available for Future Allocation</p>
                          <p className="font-semibold text-slate-800">{formatKwacha(financials.availableForFutureAllocation)}</p>
                        </div>
                      </div>
                      <div className="mt-3">
                        <Badge color={getSettlementBadgeColor(financials)}>{getSettlementBadgeLabel(financials)}</Badge>
                      </div>
                      {financials.isLegacyPaid && (
                        <p className="text-xs text-slate-400 mt-2">
                          Recorded as a single legacy payment (see Approval &amp; Payment below) -- this entitlement was never processed through the monthly allocation ledger.
                        </p>
                      )}
                      {financials.hasLedgerConflict && (
                        <div className="mt-2 rounded-lg border border-red-300 bg-red-50 p-2 text-xs text-red-700 flex items-start gap-1.5">
                          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                          <span>This record is marked as paid via a legacy direct payment, but it ALSO has payment allocation ledger rows. This should not normally happen -- an Admin should investigate before relying on either figure alone.</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            <div className="border-t pt-4">
              <p className="text-xs text-slate-500">Reason: {showDetailModal.reason_for_termination}</p>
              <p className="text-xs text-slate-500">Type: {showDetailModal.termination_type?.replace('_', ' ') || 'N/A'}</p>
              <p className="text-xs text-slate-500">Date Left: {new Date(showDetailModal.date_left).toLocaleDateString()}</p>
            </div>

            {/* Only while a Pending row is CURRENTLY awaiting correction --
                return_reason is cleared on re-approval (approve_terminal_due(),
                20260907000000), so an ordinary Pending record that was never
                returned (return_reason NULL) never shows this, matching
                required behavior exactly. */}
            {shouldShowReturnedForCorrectionBanner(showDetailModal.status, showDetailModal.return_reason) && (
              <div className="border-t pt-4">
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-1">
                  <p className="text-sm font-semibold text-amber-800">RETURNED FOR CORRECTION</p>
                  <p className="text-xs text-amber-700"><span className="font-medium">Reason:</span> {showDetailModal.return_reason}</p>
                  <p className="text-xs text-amber-700"><span className="font-medium">Returned by:</span> {showDetailModal.returned_by_name || 'Unknown'}</p>
                  <p className="text-xs text-amber-700"><span className="font-medium">Returned on:</span> {formatAuditTimestamp(showDetailModal.returned_at)}</p>
                </div>
              </div>
            )}

            {(showDetailModal.status === 'approved' || showDetailModal.status === 'paid') && (
              <div className="border-t pt-4 space-y-1">
                <h4 className="font-semibold text-slate-800 mb-2 text-sm">Approval &amp; Payment</h4>
                <p className="text-xs text-slate-500">Approved: {formatAuditTimestamp(showDetailModal.approved_at)}</p>
                {showDetailModal.status === 'paid' && (
                  <>
                    <p className="text-xs text-slate-500">Paid: {formatAuditTimestamp(showDetailModal.paid_at)}</p>
                    <p className="text-xs text-slate-500">Payment Date: {formatAuditValue(showDetailModal.payment_date)}</p>
                    <p className="text-xs text-slate-500">Payment Method: {formatAuditValue(showDetailModal.payment_method)}</p>
                    <p className="text-xs text-slate-500">Payment Reference: {formatAuditValue(showDetailModal.payment_reference)}</p>
                    {showDetailModal.payment_notes && (
                      <p className="text-xs text-slate-500">Notes: {showDetailModal.payment_notes}</p>
                    )}
                  </>
                )}
              </div>
            )}

            {showDetailModal.status === 'approved' && (canCreateTerminalDue || canEditTerminalDue || canApproveTerminalDue) && (
              <EntitlementRevisionPanel
                terminalDue={{
                  id: showDetailModal.id,
                  status: showDetailModal.status,
                  total_payable: showDetailModal.total_payable,
                  date_joined: showDetailModal.date_joined,
                  date_left: showDetailModal.date_left,
                  basic_salary: showDetailModal.basic_salary,
                }}
                canPropose={canCreateTerminalDue || canEditTerminalDue}
                canApprove={canApproveTerminalDue}
              />
            )}

            <div className="flex justify-end gap-2 pt-4 border-t">
              {showDetailModal.status === 'pending' && canApproveTerminalDue && (
                <Button variant="secondary" onClick={() => { approveTerminalDue(showDetailModal.id); setShowDetailModal(null); }}>
                  <CheckCircle size={14} className="mr-1" /> Approve
                </Button>
              )}
              {showDetailModal.status === 'approved' && canApproveTerminalDue && (
                <Button variant="secondary" onClick={() => { openReturnModal(showDetailModal); setShowDetailModal(null); }}>
                  <RotateCcw size={14} className="mr-1" /> Return for Correction
                </Button>
              )}
              {showDetailModal.status === 'approved' && canPayTerminalDue && (
                <Button variant="secondary" onClick={() => { openPaymentModal(showDetailModal); setShowDetailModal(null); }}>
                  <Wallet size={14} className="mr-1" /> Record Payment
                </Button>
              )}
              <Button variant="outline" onClick={() => setShowDetailModal(null)}>Close</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Edit Modal */}
      <Modal open={showEditModal} onClose={() => { setShowEditModal(false); setEditingCalculation(null); }} title="Edit Terminal Dues" size="lg">
        {editingCalculation && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-slate-500">Employee</p><p className="font-semibold">{editingCalculation.employee_name}</p></div>
              <div><p className="text-slate-500">Employee #</p><p className="font-semibold">{editingCalculation.employee_number}</p></div>
              <div><p className="text-slate-500">Position</p><p className="font-semibold">{editingCalculation.position}</p></div>
              <div><p className="text-slate-500">Status</p><Badge color={getStatusColor(editingCalculation.status)}>{editingCalculation.status.toUpperCase()}</Badge></div>
            </div>

            <div className="border-t pt-4">
              <h4 className="font-semibold text-slate-800 mb-3">Edit Breakdown</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Deductions (MK)</label>
                  <input
                    id="editDeductions"
                    name="editDeductions"
                    type="number"
                    value={editingCalculation.deductions}
                    onChange={(e) => setEditingCalculation({ ...editingCalculation, deductions: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Uniform Refund (MK)</label>
                  <input
                    id="editUniformRefund"
                    name="editUniformRefund"
                    type="number"
                    value={editingCalculation.uniform_refund}
                    onChange={(e) => setEditingCalculation({ ...editingCalculation, uniform_refund: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Other Benefits (MK)</label>
                  <input
                    id="editOtherBenefits"
                    name="editOtherBenefits"
                    type="number"
                    value={editingCalculation.other_benefits}
                    onChange={(e) => setEditingCalculation({ ...editingCalculation, other_benefits: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Reason for Termination</label>
                  <select
                    id="editReason"
                    name="editReason"
                    value={editingCalculation.reason_for_termination}
                    onChange={(e) => setEditingCalculation({ ...editingCalculation, reason_for_termination: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                  >
                    {terminationReasons.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Termination Type</label>
                  <select
                    id="editTerminationType"
                    name="editTerminationType"
                    value={editingCalculation.termination_type}
                    onChange={(e) => setEditingCalculation({ ...editingCalculation, termination_type: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                  >
                    {terminationTypes.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button variant="outline" onClick={() => { setShowEditModal(false); setEditingCalculation(null); }}>Cancel</Button>
              <Button variant="secondary" onClick={updateCalculation}>
                <Save size={14} className="mr-1" /> Save Changes
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Record Payment Modal -- Accountant only, Approved rows only. Never
          a one-click "mark Paid": payment evidence (method + reference) is
          mandatory, enforced both here and server-side by
          record_terminal_due_payment(). */}
      <Modal open={!!showPaymentModal} onClose={() => setShowPaymentModal(null)} title="Record Payment">
        {showPaymentModal && (
          <div className="space-y-4">
            <div className="text-sm">
              <p className="text-slate-500">Employee</p>
              <p className="font-semibold">{showPaymentModal.employee_name} ({showPaymentModal.employee_number})</p>
              <p className="text-slate-500 mt-2">Amount</p>
              <p className="font-bold text-lg text-[#D4A017]">{formatKwacha(showPaymentModal.total_payable)}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Payment Date *</label>
              <input
                id="paymentDate"
                name="paymentDate"
                type="date"
                value={paymentForm.payment_date}
                onChange={(e) => setPaymentForm({ ...paymentForm, payment_date: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Payment Method *</label>
              <input
                id="paymentMethod"
                name="paymentMethod"
                type="text"
                placeholder="e.g. Bank Transfer, Cash, Mobile Money"
                value={paymentForm.payment_method}
                onChange={(e) => setPaymentForm({ ...paymentForm, payment_method: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Payment Reference *</label>
              <input
                id="paymentReference"
                name="paymentReference"
                type="text"
                placeholder="Receipt / voucher / transaction reference number"
                value={paymentForm.payment_reference}
                onChange={(e) => setPaymentForm({ ...paymentForm, payment_reference: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
              <textarea
                id="paymentNotes"
                name="paymentNotes"
                rows={2}
                value={paymentForm.payment_notes}
                onChange={(e) => setPaymentForm({ ...paymentForm, payment_notes: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button variant="outline" onClick={() => setShowPaymentModal(null)}>Cancel</Button>
              <Button variant="secondary" onClick={submitPayment}>
                <Wallet size={14} className="mr-1" /> Record Payment
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Return for Correction Modal -- Admin only, Approved rows only. A
          mandatory, nonblank reason is required both here and server-side
          by return_terminal_due_for_correction() -- an approved amount is
          never silently changed; it goes back to Pending for HR to
          recalculate. */}
      <Modal open={!!showReturnModal} onClose={() => setShowReturnModal(null)} title="Return for Correction">
        {showReturnModal && (
          <div className="space-y-4">
            <div className="text-sm">
              <p className="text-slate-500">Employee</p>
              <p className="font-semibold">{showReturnModal.employee_name} ({showReturnModal.employee_number})</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Reason *</label>
              <textarea
                id="returnReason"
                name="returnReason"
                rows={3}
                placeholder="Why is this calculation being returned to Pending?"
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            </div>
            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button variant="outline" onClick={() => setShowReturnModal(null)}>Cancel</Button>
              <Button variant="secondary" onClick={submitReturn}>
                <RotateCcw size={14} className="mr-1" /> Return for Correction
              </Button>
            </div>
          </div>
        )}
      </Modal>
      </>
      )}
    </div>
  );
}

export default TerminalDuesPage;