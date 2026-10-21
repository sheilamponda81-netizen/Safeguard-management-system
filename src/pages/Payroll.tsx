import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Wallet, Calculator, Check, CheckCircle2, ChevronRight, Save, AlertCircle, Shield, Lock, Calendar, ChevronLeft, ChevronRight as ChevronRightIcon, UserCheck, Clock, XCircle, FileText } from 'lucide-react';
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
import { calculateLivePayroll, getHistoricalSafeAbsentRate } from '../utils/payrollCalculations';
import { calculatePooledAllocation } from '../utils/salaryAdvanceCalculations';
import { processPayrollBatch, describeProcessPayrollBatchError } from '../utils/payrollProcessing';
import { getDefaultPageSize } from '../utils/uiSettings';
import { UserProfile } from '../utils/currentProfile';
import { getErrorMessage } from '../utils/errorHandler';
import {
  canProcessPayroll as canProcessPayrollFor,
  canEditPayroll as canEditPayrollFor,
  canViewPayroll as canViewPayrollFor,
  canApprovePayroll as canApprovePayrollFor,
  isPendingApproval as computeIsPendingApproval,
} from '../utils/payrollPermissions';
import { canAccess, hasExplicitPermission, PERMISSIONS } from '../utils/permissions';
import { fetchInEmployeeIdBatches, dedupeById } from '../utils/employeeBatchFetch';
import { approvePayrollRun } from '../utils/payrollApproval';
import { buildPayrollReportCsv } from '../utils/payrollExport';
import { AttendanceCount, deriveAttendanceCountsState, isPreviewBlocked, hasAnyBlockedPreview } from '../utils/payrollAttendanceCounts';
import { PAYABLE_EMPLOYEE_STATUSES } from '../utils/employeeStatus';
import {
  summarizeTerminalDuePayrollBatch,
  computeCombinedPayrollTotals,
  TerminalDueAllocationForSummary,
  TerminalDueEntitlementForSummary,
  TerminalDuePayrollSummary,
} from '../utils/terminalDuesPayrollIntegration';
import { buildTerminalDuePaymentsCsv, buildCombinedAccountsSummaryCsv, computeTerminalDueExportTotal, TerminalDueExportRecord } from '../utils/terminalDuesPayrollExport';

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
  region_id?: string | null;
  company?: string | null;
  workstation?: string | null;
}

interface PayrollRegion {
  id: string;
  name: string;
}

// AttendanceCount and deriveAttendanceCountsState (which decides the
// counts map + fail-closed attendanceCountsUnavailable flag from either
// the historical employee_deductions rows or the current/future
// get_payroll_attendance_counts() RPC result) live in
// src/utils/payrollAttendanceCounts.ts -- extracted so they're
// independently unit-testable; see that file's own header for details.

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
  // Populated authoritatively by process_payroll_batch() at processing
  // time (see supabase/migrations/20260813000001_payroll_salary_advance_integration.sql)
  // -- for an already-processed record this is simply read back from the
  // stored row. For a not-yet-processed preview, calculatePayroll below
  // computes the SAME projected figure client-side (using the identical
  // LEAST(configured, remaining) formula the RPC applies) purely for
  // display -- the RPC remains the sole authority for what actually gets
  // written.
  salary_advance_deduction: number;
  net_pay: number;
  processed_at: string;
  approval_status?: string;
  approved_by?: string | null;
  approved_at?: string | null;
  approval_notes?: string | null;
}

interface ActiveSalaryAdvance {
  id: string;
  remainingBalance: number;
  applicationDate: string;
  createdAt: string;
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
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [copySourceMonths, setCopySourceMonths] = useState<string[]>([]);
  // Region id -> name, for the Export Report's "Region" column and for
  // scoping a historical (already-processed) month's payroll rows to a
  // regular Admin's own region -- fetched once, same pattern as
  // Payments.tsx's own `regions` state.
  const [regions, setRegions] = useState<PayrollRegion[]>([]);
  const [processedMonths, setProcessedMonths] = useState<string[]>([]);
  const [processingStatus, setProcessingStatus] = useState('');
  const [canProcessPayroll, setCanProcessPayroll] = useState(false);
  const [canEditPayroll, setCanEditPayroll] = useState(false);
  const [canViewPayroll, setCanViewPayroll] = useState(false);
  const [canApprovePayroll, setCanApprovePayroll] = useState(false);
  const [approvalNotes, setApprovalNotes] = useState('');
  const [isApproved, setIsApproved] = useState(false);
  const [approverName, setApproverName] = useState('');
  // Live attendance-derived absent/late counts for the selected month, keyed by
  // employee_id -- payroll deductions now always reflect real attendance directly,
  // with no separate manual "save deductions" step required.
  const [attendanceCounts, setAttendanceCounts] = useState<Map<string, AttendanceCount>>(new Map());
  // Set true whenever the CURRENT/FUTURE-month live attendance-count RPC
  // (get_payroll_attendance_counts) fails for any reason -- fail-closed
  // guard: attendanceCounts is never trusted as "zero deductions" while
  // this is true. See the blocking banner in the render below and the
  // guard clauses in processPayroll()/copyFromPreviousMonth(). Always
  // false for a historical month, which never calls this RPC (its counts
  // come from the stored employee_deductions rows instead).
  const [attendanceCountsUnavailable, setAttendanceCountsUnavailable] = useState(false);
  // Position name -> whether that position's employees should get the uniform
  // deduction at all (Settings -> Positions -> "Requires Uniform").
  const [positionsRequiringUniform, setPositionsRequiringUniform] = useState<Map<string, boolean>>(new Map());
  // Employee id -> their OPEN (up to 2, per the max-2-open-advances
  // business rule) active salary advances' remaining balances BEFORE this
  // month's own deduction -- used only to PREVIEW the projected combined,
  // oldest-advance-first pooled deduction for a not-yet-processed employee
  // (see PayrollRecord's own doc comment and calculatePooledAllocation()).
  // Never written back; the actual applied amounts are always computed
  // and stored server-side by process_payroll_batch(), which applies the
  // identical pooled formula.
  const [salaryAdvanceByEmployee, setSalaryAdvanceByEmployee] = useState<Map<string, ActiveSalaryAdvance[]>>(new Map());
  // Employee id -> their ONE current combined_monthly_deduction from
  // salary_advance_repayment_plans -- the single pool figure
  // calculatePooledAllocation() allocates across the advances above.
  // Corrected from an earlier draft that summed each advance's own
  // independently-configured rate -- see 20260813000000's "COMBINED PLAN"
  // design. Absent (0) for an employee with no current plan.
  const [combinedPlanByEmployee, setCombinedPlanByEmployee] = useState<Map<string, number>>(new Map());
  const [payrollRates, setPayrollRatesState] = useState<PayrollRates>(DEFAULT_RATES);

  // ===== TERMINAL DUES PAYROLL INTEGRATION (Phase 3A) =====
  // `terminal_dues.approve` is a DELIBERATELY NARROW permission (see
  // hasExplicitPermission's own doc comment) -- a functional/business Admin
  // who can process ordinary payroll does NOT automatically gain authority
  // to process Terminal Dues payments merely by being Admin. This is
  // checked and gated completely independently of canProcessPayroll.
  const [canProcessTerminalDues, setCanProcessTerminalDues] = useState(false);
  const [terminalDuesSummary, setTerminalDuesSummary] = useState<TerminalDuePayrollSummary | null>(null);
  const [terminalDuesLoading, setTerminalDuesLoading] = useState(false);
  // Allocation ids the Admin has explicitly chosen to exclude from THIS
  // processing run (never auto-skipped) -- cleared whenever the modal is
  // reopened, since an exclusion decision belongs to one processing attempt.
  const [excludedAllocationIds, setExcludedAllocationIds] = useState<Set<string>>(new Set());
  const [exclusionReason, setExclusionReason] = useState('');

  // ===== PAGINATION STATES =====
  const [payrollPage, setPayrollPage] = useState(1);
  const [payrollItemsPerPage, setPayrollItemsPerPage] = useState(20);
  useEffect(() => { getDefaultPageSize().then(setPayrollItemsPerPage); }, []);

  // ===== MEMOIZED VALUES =====
  const isCurrentMonth = useMemo(() => selectedMonth === systemMonth, [selectedMonth, systemMonth]);
  const isFutureMonthSelected = useMemo(() => selectedMonth > systemMonth, [selectedMonth, systemMonth]);
  const isMonthProcessed = useMemo(() => processedMonths.includes(selectedMonth), [processedMonths, selectedMonth]);

  const isPendingApproval = useMemo(() => computeIsPendingApproval(payrollRecords), [payrollRecords]);

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
    const approvedBy = payrollRecords[0]?.approved_by;
    if (isApproved && approvedBy) {
      const fetchApproverName = async (approvedById: string) => {
        try {
          const { data, error } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', approvedById)
            .maybeSingle();

          if (error) throw error;
          setApproverName(data?.full_name || approvedById.slice(0, 8) + '...');
        } catch (err) {
          console.error('Error fetching approver name:', err);
          setApproverName(approvedById.slice(0, 8) + '...');
        }
      };
      fetchApproverName(approvedBy);
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
      const roleContext = { isSuperAdmin, roleLevel };

      // OR'd with has_permission() for the new functional roles -- a
      // legacy-only check would wall out an accountant (payroll.view/
      // process/approve, role_level = NULL by design) entirely. canEdit
      // maps to payroll.process (there is no separate "edit" permission in
      // the seeded matrix -- editing draft entries is part of processing).
      setCanProcessPayroll(await canAccess(canProcessPayrollFor(roleContext), PERMISSIONS.PAYROLL_PROCESS));
      setCanEditPayroll(await canAccess(canEditPayrollFor(roleContext), PERMISSIONS.PAYROLL_PROCESS));
      setCanViewPayroll(await canAccess(canViewPayrollFor(roleContext), PERMISSIONS.PAYROLL_VIEW));
      setCanApprovePayroll(await canAccess(canApprovePayrollFor(roleContext), PERMISSIONS.PAYROLL_APPROVE));

      // Deliberately hasExplicitPermission(), NOT canAccess() -- an Admin
      // must not gain Terminal Dues payment authority "for free" the way
      // canAccess()'s business-admin shortcut would otherwise grant it.
      setCanProcessTerminalDues(await hasExplicitPermission(PERMISSIONS.TERMINAL_DUES_APPROVE));
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
      // BROWSING an existing processed historical payroll run is a
      // fundamentally different operation from PREPARING/PREVIEWING a
      // current or future one, and must not share the same "start from
      // today's roster" semantics -- see the two branches below.
      const isHistoricalMonth = selectedMonth < systemMonth;

      let employeesData: Employee[];
      // Set only for a historical month, where the payroll rows
      // themselves (fetched below) are what determine `employeeIds` --
      // resolved into the same Promise.all as the current/future branch's
      // fresh payroll fetch, so both branches share one code path from
      // here on.
      let historicalPayrollPromise: Promise<PayrollRecord[]> | null = null;

      if (isHistoricalMonth) {
        // ===== A: BROWSING AN EXISTING PROCESSED HISTORICAL PAYROLL RUN =====
        // Must show exactly what was STORED for that payroll period --
        // never reconstructed from today's employee roster. If this
        // branch instead started from "today's Active, region-scoped
        // employees" (as branch B below correctly does for PREPARING a
        // new run), a legitimate stored payroll record for someone since
        // deactivated, soft-deleted, or moved to another region would
        // silently disappear from view the moment their CURRENT employee
        // record changed, even though the record itself is untouched in
        // the database. This entire branch is read-only -- no UPDATE/
        // INSERT/DELETE happens anywhere on this path -- so viewing a past
        // month can never reprocess, recalculate, or mutate it.
        const { data: rawHistoricalPayroll, error: payrollError } = await supabase
          .from('payroll')
          .select('*')
          .eq('month', selectedMonth);
        if (payrollError) throw payrollError;

        const allHistoricalPayroll = dedupeById(rawHistoricalPayroll || []);
        const historicalEmployeeIds = [...new Set(allHistoricalPayroll.map(r => r.employee_id))];

        // Employee DISPLAY fields (name, number, position, region, company,
        // workstation) as they exist TODAY -- fetched by id, with NO
        // Active/is_deleted/region filter, so a since-changed employee
        // record still has details to show next to their historical
        // payroll row. This never gates which payroll rows are shown; the
        // fetch above already determined that.
        const historicalEmployees = historicalEmployeeIds.length > 0
          ? await fetchInEmployeeIdBatches<Employee>(
              historicalEmployeeIds,
              (batch, from, to, withCount) =>
                supabase
                  .from('employees')
                  .select('id, employee_number, full_name, position, department, basic_salary, status, is_deleted, uniform_deduction, region_id, company, workstation', withCount ? { count: 'exact' } : undefined)
                  .in('id', batch)
                  .range(from, to)
            )
          : [];
        const historicalEmployeesById = new Map(historicalEmployees.map(e => [e.id, e]));

        // Region scoping for a non-super-admin: payroll has no region_id
        // column of its own, so -- same as branch B below -- this is
        // enforced through each employee's region_id. Necessarily their
        // CURRENT region, since this schema doesn't separately track an
        // employee's region at the time a past payroll run happened; a
        // regional Admin viewing history therefore sees "is this employee
        // in my region today", the same limitation branch B already has
        // for the current month.
        const authorizedPayroll = (!userProfile?.is_super_admin && userProfile?.region_id)
          ? allHistoricalPayroll.filter(r => historicalEmployeesById.get(r.employee_id)?.region_id === userProfile.region_id)
          : allHistoricalPayroll;

        const authorizedIds = new Set(authorizedPayroll.map(r => r.employee_id));
        employeesData = historicalEmployees.filter(e => authorizedIds.has(e.id));
        historicalPayrollPromise = Promise.resolve(authorizedPayroll);
      } else {
        // ===== B: PREPARING / PREVIEWING A CURRENT OR FUTURE PAYROLL RUN =====
        // Driven by today's live, region-scoped roster, since this is the
        // population payroll can actually be prepared/processed against --
        // there is no "stored snapshot" to browse yet for a month that
        // hasn't been (fully) processed. PAYABLE_EMPLOYEE_STATUSES
        // (Active + On Leave) is a deliberate WHITELIST, not a loosened
        // "any status" filter: an employee on APPROVED leave must still
        // receive their pay (business rule), but this must not silently
        // start including a future/other non-payable status (e.g.
        // "Suspended") the moment it's added to the employees table --
        // see src/utils/employeeStatus.ts.
        let employeesQuery = supabase
          .from('employees')
          .select('id, employee_number, full_name, position, department, basic_salary, status, is_deleted, uniform_deduction, region_id, company, workstation')
          .eq('is_deleted', false)
          .in('status', PAYABLE_EMPLOYEE_STATUSES);

        if (!userProfile?.is_super_admin && userProfile?.region_id) {
          employeesQuery = employeesQuery.eq('region_id', userProfile.region_id);
        }

        const { data: rosterData, error: empError } = await employeesQuery;
        if (empError) throw empError;
        employeesData = rosterData || [];
      }

      setEmployees(employeesData);

      // payroll/employee_deductions/attendance have no region_id column of
      // their own, so region scoping for a non-super-admin has to go through
      // this (already region-scoped) employee id list -- otherwise a regional
      // payroll manager would see, and could overwrite, every other region's
      // payroll too. For a historical month this is the set of employees who
      // actually have a stored payroll row for that month (branch A above),
      // not today's roster.
      const employeeIds = employeesData.map(e => e.id);

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
      // one at a time. For a historical month the "payroll records" leg is
      // already resolved (`historicalPayrollPromise`, from branch A above --
      // it's what determined `employeeIds` in the first place); for a
      // current/future month it's fetched fresh here, batched exactly as
      // before.
      //
      // The raw `attendance` table is NEVER read client-side, for either
      // branch (Finding A23/A24 -- see AUDIT_REPORT.md). For a historical
      // month, absent/late DAY COUNTS come from the stored
      // `employee_deductions.absent_days`/`late_days` rows (fetched
      // unconditionally just below, for both branches) -- the figure
      // `process_payroll_batch()` actually used when that payroll ran, not
      // "whatever attendance looks like today." For a current/future
      // month, they come from `get_payroll_attendance_counts()` (see
      // supabase/migrations/20260901000000_payroll_attendance_aggregate_rpc.sql),
      // a narrow SECURITY DEFINER RPC that returns only
      // {employee_id, absent_days, late_days} -- never a raw attendance
      // row -- gated by the same payroll.view/legacy-role_level rule as
      // the `payroll` table's own RLS, not by attendance.view. This is
      // what closes the gap the two approaches above both had: `attendance`
      // itself is RLS-gated on `current_user_role_level() IS NOT NULL OR
      // has_permission('attendance.view')`, which a functional-role
      // Accountant (role_level = NULL, no attendance.view grant in the
      // seeded matrix) fails -- previously RLS would silently return ZERO
      // rows (no error), so the live preview silently understated
      // attendance-derived deductions with nothing in the UI indicating
      // anything was wrong. The RPC leg below fails LOUD instead: any
      // error is captured (not swallowed) and surfaces as
      // `attendanceCountsUnavailable`, which blocks Process Payroll /
      // Copy From Previous Month and shows a blocking banner -- see the
      // guard clauses in processPayroll()/copyFromPreviousMonth() and the
      // render section below. A historical month never calls this RPC at
      // all (employeeIds there come from what's already stored).
      const [payrollDataRaw, deductionsDataRaw, attendanceRpcResult, positionsRequiringUniformMap] = await Promise.all([
        historicalPayrollPromise ?? fetchInEmployeeIdBatches<PayrollRecord>(
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
        // Isolated in its own try/catch, same pattern as the positions leg
        // below: a failure here must never reject the whole Promise.all
        // and take down payroll/deductions/positions loading too -- it's
        // captured as `failed: true` instead, so fetchData can render its
        // OWN dedicated fail-closed state (banner + disabled processing)
        // rather than a generic "failed to load payroll data" toast that
        // doesn't actually stop an Accountant from clicking Process
        // Payroll against silently-zeroed attendance data.
        (isHistoricalMonth || employeeIds.length === 0)
          ? Promise.resolve({ rows: [] as { employee_id: string; absent_days: number; late_days: number }[], failed: false })
          : (async () => {
              try {
                const { data, error } = await supabase.rpc('get_payroll_attendance_counts', {
                  p_employee_ids: employeeIds,
                  p_month: selectedMonth,
                });
                if (error) throw error;
                return { rows: (data || []) as { employee_id: string; absent_days: number; late_days: number }[], failed: false };
              } catch (attendanceRpcErr) {
                console.error('Error fetching payroll attendance totals:', attendanceRpcErr);
                return { rows: [] as { employee_id: string; absent_days: number; late_days: number }[], failed: true };
              }
            })(),
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

      // See deriveAttendanceCountsState's own header comment
      // (src/utils/payrollAttendanceCounts.ts) for the exact fail-closed
      // decision this makes -- extracted so it's independently
      // unit-testable without rendering this page.
      const attendanceState = deriveAttendanceCountsState(isHistoricalMonth, deductionsData, attendanceRpcResult);
      setAttendanceCounts(attendanceState.counts);
      setAttendanceCountsUnavailable(attendanceState.unavailable);

      setPositionsRequiringUniform(positionsRequiringUniformMap);

      // ===== Active salary advances + each employee's ONE combined
      // repayment plan (for the payroll preview only -- the actual
      // deduction is always computed/applied server-side by
      // process_payroll_batch(), see PayrollRecord's own doc comment).
      // An employee may have up to 2 simultaneously open advances (the
      // max-2-open-advances business rule), so this collects a LIST per
      // employee, not a single value; the combined monthly figure they
      // share comes from salary_advance_repayment_plans, NOT from summing
      // each advance's own originally-applied-for rate (corrected from an
      // earlier draft -- see 20260813000000's "COMBINED PLAN" design). =====
      const advanceMap = new Map<string, ActiveSalaryAdvance[]>();
      const planMap = new Map<string, number>();
      if (employeeIds.length > 0) {
        // Batched the same way payroll/employee_deductions above already
        // are: a plain `.in('employee_id', employeeIds)` here reintroduces
        // the exact oversized-request pattern that already broke production
        // once at ~500+ employees (see employeeBatchFetch.ts's own header).
        // `activeAdvancesRaw` genuinely can contain more than one row per
        // employee (max-2-open-advances business rule), so dedupeById is
        // real insurance here, not just convention-following, exactly like
        // `payrollData`/`deductionsData` above.
        const activeAdvancesRaw = await fetchInEmployeeIdBatches<{
          id: string; employee_id: string; advance_amount: number; application_date: string; created_at: string;
        }>(
          employeeIds,
          (batch, from, to, withCount) =>
            supabase
              .from('salary_advances')
              .select('id, employee_id, advance_amount, application_date, created_at', withCount ? { count: 'exact' } : undefined)
              .eq('status', 'active')
              .lte('deduction_start_month', selectedMonth)
              .in('employee_id', batch)
              .range(from, to)
        );
        const activeAdvances = dedupeById(activeAdvancesRaw);

        if (activeAdvances.length > 0) {
          const advanceIds = activeAdvances.map(a => a.id);
          // Batched on advance_id (disjoint across batches by construction,
          // same reasoning as employeeBatchFetch.ts's own note on why a
          // dedupe step isn't needed for a sum computed from disjoint
          // batches) -- advanceIds can also grow past a safe single-request
          // URL size for a large enough tenant, independent of employeeIds.
          const ledgerRows = await fetchInEmployeeIdBatches<{ salary_advance_id: string; deduction_amount: number }>(
            advanceIds,
            (batch, from, to, withCount) =>
              supabase
                .from('salary_advance_deductions')
                .select('salary_advance_id, deduction_amount', withCount ? { count: 'exact' } : undefined)
                .in('salary_advance_id', batch)
                .range(from, to)
          );

          const repaidByAdvance = new Map<string, number>();
          ledgerRows.forEach(row => {
            repaidByAdvance.set(row.salary_advance_id, (repaidByAdvance.get(row.salary_advance_id) || 0) + row.deduction_amount);
          });

          activeAdvances.forEach(advance => {
            const repaid = repaidByAdvance.get(advance.id) || 0;
            const entry: ActiveSalaryAdvance = {
              id: advance.id,
              remainingBalance: Math.max(0, advance.advance_amount - repaid),
              applicationDate: advance.application_date,
              createdAt: advance.created_at,
            };
            const existing = advanceMap.get(advance.employee_id) || [];
            existing.push(entry);
            advanceMap.set(advance.employee_id, existing);
          });

          // Batched on the (deduped, already-bounded-by-active-advances)
          // employee ids with an active advance -- a subset of employeeIds,
          // but still unbounded in principle for a large enough tenant.
          const plans = await fetchInEmployeeIdBatches<{ employee_id: string; combined_monthly_deduction: number }>(
            Array.from(advanceMap.keys()),
            (batch, from, to, withCount) =>
              supabase
                .from('salary_advance_repayment_plans')
                .select('employee_id, combined_monthly_deduction', withCount ? { count: 'exact' } : undefined)
                .in('employee_id', batch)
                .range(from, to)
          );
          plans.forEach(plan => {
            planMap.set(plan.employee_id, plan.combined_monthly_deduction);
          });
        }
      }
      setSalaryAdvanceByEmployee(advanceMap);
      setCombinedPlanByEmployee(planMap);

      setHasData((payrollData?.length || 0) > 0);

    } catch (err) {
      console.error('Error fetching data:', err);
      showNotification('Failed to load payroll data: ' + getErrorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [selectedMonth, systemMonth, userProfile]);

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
    const netPayBeforeAdvance = live.grossPay - paye - pension - live.uniformDeduction;

    // Preview only -- identical oldest-advance-first pooled allocation the
    // process_payroll_batch() RPC itself applies (see
    // 20260813000001_payroll_salary_advance_integration.sql and
    // calculatePooledAllocation()'s own header), computed here purely so
    // this page's own display matches what processing will actually do
    // for an employee with up to 2 simultaneously open advances. The RPC
    // recomputes this independently at processing time and is the only
    // thing that actually writes it.
    const openAdvances = salaryAdvanceByEmployee.get(employee.id) || [];
    const combinedMonthlyDeduction = combinedPlanByEmployee.get(employee.id) || 0;
    const salaryAdvanceDeduction = customValues?.salary_advance_deduction ?? calculatePooledAllocation(
      combinedMonthlyDeduction,
      openAdvances.map(a => ({
        id: a.id,
        remainingBalance: a.remainingBalance,
        applicationDate: a.applicationDate,
        createdAt: a.createdAt,
      }))
    ).total;
    const netPay = netPayBeforeAdvance - salaryAdvanceDeduction;

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
      salary_advance_deduction: salaryAdvanceDeduction,
      net_pay: netPay,
      processed_at: new Date().toISOString(),
      approval_status: 'pending',
      approved_by: null,
      approved_at: null,
      approval_notes: null
    };
  }, [selectedMonth, getEmployeeDeduction, attendanceCounts, positionsRequiringUniform, payrollRates, salaryAdvanceByEmployee, combinedPlanByEmployee]);

  const getDisplayPayroll = useCallback((employee: Employee): PayrollRecord => {
    const existing = getPayrollForEmployee(employee.id);
    if (existing) return existing;
    const edited = editingValues[employee.id];
    return calculatePayroll(employee, edited);
  }, [getPayrollForEmployee, editingValues, calculatePayroll]);

  // ===== GET TOTALS =====
  const totals = useMemo(() => {
    let gross = 0, net = 0, paye = 0, pension = 0, uniformDeductions = 0, salaryAdvanceDeductions = 0;
    employees.forEach(emp => {
      const p = getDisplayPayroll(emp);
      gross += p.gross_pay;
      net += p.net_pay;
      paye += p.paye;
      pension += p.pension;
      uniformDeductions += p.uniform_deduction || 0;
      salaryAdvanceDeductions += p.salary_advance_deduction || 0;
    });
    return { gross, net, paye, pension, uniformDeductions, salaryAdvanceDeductions };
  }, [employees, getDisplayPayroll]);

  const employeesWithDeductions = useMemo(() => {
    // Uses the same uniform_deduction total calculatePayroll actually produces
    // (position eligibility + live attendance + lecture/appearance), rather than
    // re-deriving it separately here and risking the two disagreeing.
    return employees.filter(emp => getDisplayPayroll(emp).uniform_deduction > 0);
  }, [employees, getDisplayPayroll]);

  // True only when at least one CURRENTLY DISPLAYED figure is actually a
  // live calculation built on a failed/unavailable attendance-count fetch
  // -- i.e. attendanceCountsUnavailable AND at least one employee has no
  // stored payroll row yet (getDisplayPayroll falls through to
  // calculatePayroll() for them, which silently treats a missing
  // attendanceCounts entry as zero). Deliberately false for an
  // already-fully-processed month even if attendanceCountsUnavailable
  // happens to be true (every displayed figure there comes from the
  // stored, already-authoritative payroll row, untouched by this fetch) --
  // and always false for a historical month, which never sets
  // attendanceCountsUnavailable at all. Gates the deduction/net-pay
  // DISPLAY only (see the render section below) -- it does not change
  // what getDisplayPayroll/calculatePayroll compute, so Process Payroll
  // (already disabled via attendanceCountsUnavailable directly) is
  // unaffected.
  const hasBlockedPreview = useMemo(
    () => hasAnyBlockedPreview(attendanceCountsUnavailable, employees.map(e => e.id), new Set(payrollByEmployee.keys())),
    [attendanceCountsUnavailable, employees, payrollByEmployee]
  );

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

      const { data: regionsData } = await supabase.from('regions').select('id, name');
      setRegions(regionsData || []);

      await fetchUserProfile();
    };
    init();
  }, [fetchUserProfile]);

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

    // Same fail-closed guard as processPayroll() -- calculatePayroll()
    // below is called per employee to compute the target month's uniform/
    // attendance deductions, which must never proceed on a known-missing
    // attendance-count fetch.
    if (attendanceCountsUnavailable) {
      showNotification('Unable to load attendance totals required for payroll. Please refresh and try again.', 'error');
      return;
    }

    setProcessingStatus('Copying data from ' + getMonthLabel(sourceMonth) + '...');

    try {
      const employeeIds = employees.map(e => e.id);
      if (employeeIds.length === 0) {
        showNotification('No employees found to copy payroll for.', 'error');
        return;
      }

      // The target month's existing rows are no longer deleted here up
      // front -- process_payroll_batch() (called below, once newRecords is
      // built) does the delete and insert atomically in one transaction,
      // scoped to exactly `employeeIds` as before. (A separate manual
      // pre-delete would race with that atomic RPC step and isn't needed.)
      //
      // Same oversized-IN-list risk/fix as the main fetchData payroll query
      // -- batched via employeeBatchFetch instead of one request built from
      // the entire employee population.
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
            // payroll.net_pay is the FINAL (post-advance) figure used for
            // display/totals throughout this page -- process_payroll_batch()
            // subtracts its OWN server-computed salary advance deduction
            // from whatever net_pay it receives, so the value sent here
            // must be added back to the PRE-advance figure or the RPC
            // would subtract the same deduction a second time.
            net_pay: payroll.net_pay + payroll.salary_advance_deduction,
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

      const result = await processPayrollBatch(selectedMonth, newRecords, {
        sourceMonth,
        targetMonth: selectedMonth,
      });

      if (!result.success) {
        console.error('Error copying data:', result.error);
        const message = result.error ? describeProcessPayrollBatchError(result.error, id => employeesById.get(id)?.full_name) : result.error;
        showNotification('Failed to copy data: ' + message, 'error');
        return;
      }

      await fetchData();
      await fetchProcessedMonths();
      setHasData(true);
      setIsApproved(false);
      setShowCopyModal(false);
      showNotification(`Payroll data copied from ${getMonthLabel(sourceMonth)} to ${getMonthLabel(selectedMonth)}. ${result.insertedCount ?? newRecords.length} records copied.`, 'success');
    } catch (err) {
      console.error('Error copying data:', err);
      showNotification('Failed to copy data: ' + getErrorMessage(err), 'error');
    } finally {
      setProcessingStatus('');
    }
  }, [canProcessPayroll, attendanceCountsUnavailable, selectedMonth, employees, employeesById, calculatePayroll, fetchData, fetchProcessedMonths]);

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
      // Sends exactly the payroll row ids already loaded into
      // payrollRecords (the on-screen snapshot) as an RPC body parameter,
      // instead of building `.in('employee_id', payrollRecords.map(...))`
      // as a URL filter -- that filter used to carry the full in-scope
      // employee id list into the request URL, which for a full month's
      // payroll run (hundreds of employees) produced a PostgREST request
      // large enough to be rejected outright with a bare 400 Bad Request.
      // See src/utils/payrollApproval.ts and
      // supabase/migrations/20260831000000_payroll_approval_rpc.sql for
      // the exact scope/authorization this RPC applies and why.
      const result = await approvePayrollRun({
        month: selectedMonth,
        status,
        notes: approvalNotes || null,
        payrollIds: payrollRecords.map(r => r.id),
      });

      if (!result.success) {
        const message = result.reason === 'rpc_error' ? 'Failed to approve payroll: ' + result.error : result.error!;
        showNotification(message, 'error');
        // 'scope_changed' means the RPC's own all-or-nothing check aborted
        // the whole update server-side (nothing was approved) because the
        // on-screen snapshot no longer matches reality -- refresh so the
        // UI reflects current data instead of silently showing stale
        // records the admin might retry against again.
        if (result.reason === 'scope_changed') {
          await fetchData();
          await fetchProcessedMonths();
        }
        return;
      }

      // logAudit() never throws (see src/utils/auditLogger.ts) -- a
      // failure to write the audit row is logged to the console but can
      // never be mistaken here for the payroll approval itself failing.
      await logAudit({
        action: status === 'approved' ? 'APPROVE' : 'REJECT',
        entity_type: 'payroll',
        new_data: {
          month: selectedMonth,
          status: status,
          notes: approvalNotes,
          recordsCount: result.updatedCount,
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
      await fetchData();
      await fetchProcessedMonths();

    } catch (err) {
      console.error('Error approving payroll:', err);
      showNotification('Failed to approve payroll: ' + getErrorMessage(err), 'error');
    } finally {
      setProcessing(false);
      setProcessingStatus('');
    }
  }, [canApprovePayroll, payrollRecords, selectedMonth, userProfile, approvalNotes, fetchData, fetchProcessedMonths]);

  // ===== EXPORT PAYROLL REPORT =====
  // Always exports whatever is CURRENTLY LOADED for `selectedMonth` --
  // the month actually being viewed, never silently the live current
  // month -- and only what fetchData() already fetched for this caller's
  // authorized tenant/region scope (see fetchData's branch A/B above), so
  // this can never leak another tenant's or another region's payroll.
  // Uses the stored `payrollRecords` directly (not a live/unprocessed
  // preview via getDisplayPayroll), since this is a report for the
  // Accountant/Managing Director -- only figures that were actually
  // processed and stored belong in it.
  const exportPayrollReport = useCallback(() => {
    const regionsById = new Map(regions.map(r => [r.id, r]));
    const csv = buildPayrollReportCsv(selectedMonth, payrollRecords, employeesById, regionsById, deductionsByEmployee);

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll_${selectedMonth}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    logAudit({
      action: 'EXPORT',
      entity_type: 'payroll',
      new_data: {
        month: selectedMonth,
        employeeCount: payrollRecords.length,
      },
      region_id: userProfile?.region_id,
    });

    showNotification('Payroll report exported!', 'success');
  }, [payrollRecords, employeesById, regions, deductionsByEmployee, selectedMonth, userProfile]);

  // ===== TERMINAL DUES SUMMARY (display-only; the RPC re-validates everything) =====
  // Mirrors, for the confirm modal only, the exact candidate set
  // process_terminal_due_allocations_batch() itself selects (approved
  // allocations for the active payroll month) plus already-carried-forward
  // rows for visibility -- never trusted as authority (see
  // terminalDuesPayrollIntegration.ts's header comment).
  const fetchTerminalDuesSummary = useCallback(async () => {
    if (!canProcessTerminalDues || !isCurrentMonth) {
      setTerminalDuesSummary(null);
      return;
    }
    setTerminalDuesLoading(true);
    try {
      const { data: allocRows, error: allocError } = await supabase
        .from('terminal_due_allocations')
        .select('id, terminal_due_id, status, proposed_amount, carried_forward_from_id')
        .eq('payroll_month', selectedMonth);
      if (allocError) throw allocError;

      const rows = allocRows || [];
      const dueIds = Array.from(new Set(rows.map(r => r.terminal_due_id)));

      if (dueIds.length === 0) {
        setTerminalDuesSummary({ eligibleCount: 0, eligibleTotal: 0, exceptions: [], carriedForwardCount: 0 });
        return;
      }

      const [dueRes, processedRes, revisionRes] = await Promise.all([
        supabase.from('terminal_dues').select('id, status, total_payable, employee_name, employee_number').in('id', dueIds),
        supabase.from('terminal_due_allocations').select('terminal_due_id, last_decided_amount, proposed_amount').eq('status', 'processed').in('terminal_due_id', dueIds),
        supabase.from('terminal_due_revisions').select('terminal_due_id').eq('status', 'pending').in('terminal_due_id', dueIds),
      ]);
      if (dueRes.error) throw dueRes.error;
      if (processedRes.error) throw processedRes.error;
      if (revisionRes.error) throw revisionRes.error;

      const processedByDue = new Map<string, number>();
      (processedRes.data || []).forEach((r: any) => {
        const amt = Number(r.last_decided_amount ?? r.proposed_amount);
        processedByDue.set(r.terminal_due_id, (processedByDue.get(r.terminal_due_id) || 0) + amt);
      });
      const pendingRevisionDueIds = new Set((revisionRes.data || []).map((r: any) => r.terminal_due_id));
      const dueById = new Map((dueRes.data || []).map((d: any) => [d.id, d]));

      const entitlementsById = new Map<string, TerminalDueEntitlementForSummary>();
      (dueRes.data || []).forEach((d: any) => {
        entitlementsById.set(d.id, {
          id: d.id,
          status: d.status,
          total_payable: Number(d.total_payable),
          has_pending_revision: pendingRevisionDueIds.has(d.id),
          already_processed_total: processedByDue.get(d.id) || 0,
        });
      });

      const summaryAllocations: TerminalDueAllocationForSummary[] = rows.map(r => {
        const due = dueById.get(r.terminal_due_id);
        return {
          id: r.id,
          terminal_due_id: r.terminal_due_id,
          status: r.status,
          proposed_amount: Number(r.proposed_amount),
          carried_forward_from_id: r.carried_forward_from_id,
          employee_name: due?.employee_name || 'Unknown',
          employee_number: due?.employee_number || null,
        };
      });

      setTerminalDuesSummary(summarizeTerminalDuePayrollBatch(summaryAllocations, entitlementsById));
    } catch (err) {
      console.error('Error loading Terminal Dues summary:', err);
      showNotification('Failed to load Terminal Dues summary: ' + getErrorMessage(err), 'error');
      setTerminalDuesSummary(null);
    } finally {
      setTerminalDuesLoading(false);
    }
  }, [canProcessTerminalDues, isCurrentMonth, selectedMonth]);

  // Load/refresh the Terminal Dues summary whenever the confirm modal opens
  // -- never on every keystroke/render, so this stays a small, bounded set
  // of queries (at most the 50-cap worth of allocations for one month).
  useEffect(() => {
    if (showConfirmModal) {
      setExcludedAllocationIds(new Set());
      setExclusionReason('');
      fetchTerminalDuesSummary();
    }
  }, [showConfirmModal, fetchTerminalDuesSummary]);

  const toggleExcludedAllocation = useCallback((allocationId: string) => {
    setExcludedAllocationIds(prev => {
      const next = new Set(prev);
      if (next.has(allocationId)) next.delete(allocationId);
      else next.add(allocationId);
      return next;
    });
  }, []);

  // ===== EXPORT TERMINAL DUES PAYMENTS (Accounts) =====
  // Only ever reads already-`processed` allocations for `selectedMonth` --
  // never calls the processing RPC -- so re-downloading this is always
  // safe and never reprocesses anything (Section 5/Section 3's immutable-
  // history requirement).
  const exportTerminalDuesReport = useCallback(async () => {
    try {
      const { data: processedRows, error: procError } = await supabase
        .from('terminal_due_allocations')
        .select('id, terminal_due_id, last_decided_amount, proposed_amount, processed_at, processing_reference')
        .eq('payroll_month', selectedMonth)
        .eq('status', 'processed');
      if (procError) throw procError;

      if (!processedRows || processedRows.length === 0) {
        showNotification('No processed Terminal Dues payments for this month yet.', 'error');
        return;
      }

      const dueIds = Array.from(new Set(processedRows.map(r => r.terminal_due_id)));
      const { data: dueRows, error: dueError } = await supabase
        .from('terminal_dues')
        .select('id, employee_id, employee_name, employee_number, historical_employee_id')
        .in('id', dueIds);
      if (dueError) throw dueError;
      const dueById = new Map((dueRows || []).map((d: any) => [d.id, d]));

      const employeeIds = dedupeById((dueRows || []).filter((d: any) => d.employee_id).map((d: any) => ({ id: d.employee_id })));
      let payDetailsByEmployee = new Map<string, { pay_point: string | null; account_number: string | null }>();
      if (employeeIds.length > 0) {
        const { data: empRows, error: empError } = await supabase
          .from('employees')
          .select('id, pay_point, account_number')
          .in('id', employeeIds.map(e => e.id));
        if (empError) throw empError;
        payDetailsByEmployee = new Map((empRows || []).map((e: any) => [e.id, e]));
      }

      const records: TerminalDueExportRecord[] = processedRows.map(r => {
        const due = dueById.get(r.terminal_due_id);
        const payDetails = due?.employee_id ? payDetailsByEmployee.get(due.employee_id) : undefined;
        return {
          employee_name: due?.employee_name || 'Unknown',
          employee_number: due?.employee_number || null,
          pay_point: payDetails?.pay_point || null,
          account_number: payDetails?.account_number || null,
          proposed_amount: Number(r.last_decided_amount ?? r.proposed_amount),
          processed_at: r.processed_at,
          processing_reference: r.processing_reference,
          is_historical: !!due?.historical_employee_id,
        };
      });

      const csv = buildTerminalDuePaymentsCsv(selectedMonth, records);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `terminal_dues_payments_${selectedMonth}_${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      const combinedCsv = buildCombinedAccountsSummaryCsv(selectedMonth, totals.net, computeTerminalDueExportTotal(records));
      const combinedBlob = new Blob([combinedCsv], { type: 'text/csv;charset=utf-8;' });
      const combinedUrl = URL.createObjectURL(combinedBlob);
      const combinedA = document.createElement('a');
      combinedA.href = combinedUrl;
      combinedA.download = `combined_accounts_summary_${selectedMonth}_${new Date().toISOString().split('T')[0]}.csv`;
      combinedA.click();
      URL.revokeObjectURL(combinedUrl);

      logAudit({
        action: 'EXPORT',
        entity_type: 'terminal_due_allocations',
        new_data: { month: selectedMonth, paymentCount: records.length },
        region_id: userProfile?.region_id,
      });

      showNotification('Terminal Dues payments exported!', 'success');
    } catch (err) {
      showNotification('Failed to export Terminal Dues payments: ' + getErrorMessage(err), 'error');
    }
  }, [selectedMonth, totals.net, userProfile]);

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

    // Fail-closed, defense in depth: the Process Payroll button is already
    // disabled while this is true (see the render section), but this
    // function must never proceed on its own even if somehow invoked
    // anyway -- calculatePayroll() below would otherwise silently treat
    // every employee's attendance as zero absent/late days.
    if (attendanceCountsUnavailable) {
      showNotification('Unable to load attendance totals required for payroll. Please refresh and try again.', 'error');
      return;
    }

    // Terminal Dues pre-checks run BEFORE ordinary payroll is touched, so a
    // blocked Terminal Dues run never leaves ordinary payroll processed
    // with Terminal Dues silently left half-wired. The RPC itself
    // re-validates everything server-side regardless (never rely on this
    // frontend check as authority) -- this only avoids a confusing partial
    // outcome and gives a clearer message than the server's own exception.
    const unresolvedTerminalDuesExceptions = canProcessTerminalDues
      ? (terminalDuesSummary?.exceptions || []).filter(e => !excludedAllocationIds.has(e.allocationId))
      : [];
    if (unresolvedTerminalDuesExceptions.length > 0) {
      showNotification(`${unresolvedTerminalDuesExceptions.length} Terminal Dues allocation(s) need to be resolved or explicitly excluded before processing. See the Terminal Dues summary above.`, 'error');
      return;
    }
    if (canProcessTerminalDues && excludedAllocationIds.size > 0 && !exclusionReason.trim()) {
      showNotification('A reason is required to exclude Terminal Dues allocations from this processing run.', 'error');
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
        totalDeductions += (payroll.paye + payroll.pension + payroll.uniform_deduction + payroll.salary_advance_deduction);

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
          // See the identical comment in copyFromPreviousMonth() above --
          // payroll.net_pay here is already post-advance; add the
          // deduction back so process_payroll_batch() (which subtracts
          // its own server-computed copy) doesn't subtract it twice.
          net_pay: payroll.net_pay + payroll.salary_advance_deduction,
          processed_at: new Date().toISOString(),
          approval_status: 'pending',
          approved_by: null,
          approved_at: null,
          approval_notes: null
        });
      }
      
      setProcessingStatus(`Saving ${payrollToSave.length} records...`);
      // Atomic, server-side: validates (role, approved-month protection),
      // deletes, and inserts all inside one transaction, serialized against
      // any concurrent processing attempt for the same tenant+month -- see
      // supabase/migrations/20260803000002_payroll_atomic_process_rpc.sql.
      // Replaces the previous separate client-side DELETE then INSERT,
      // which could leave a month's payroll fully deleted with nothing
      // re-inserted if the INSERT failed after the DELETE had already
      // succeeded (Finding A8).
      const result = await processPayrollBatch(selectedMonth, payrollToSave, {
        totalGross,
        totalNet,
        totalDeductions,
      });

      if (!result.success) {
        console.error('❌ Error processing payroll:', result.error);
        const message = result.error ? describeProcessPayrollBatchError(result.error, id => employeesById.get(id)?.full_name) : result.error;
        showNotification('Failed to save payroll: ' + message, 'error');
        setProcessing(false);
        setProcessingStatus('');
        return;
      }

      await fetchData();
      await fetchProcessedMonths();

      // ===== TERMINAL DUES PROCESSING (Phase 3A) =====
      // A SEPARATE, independently atomic RPC call, deliberately -- the
      // existing process_payroll_batch() RPC above is its own single
      // transaction and cannot safely be extended to cover Terminal Dues
      // (see 20261026000000_terminal_dues_payroll_processing.sql's header:
      // payroll.employee_id is NOT NULL, which structurally forbids the
      // historical-employee rows Terminal Dues must support, and there is
      // no net-pay coupling to justify entangling the two the way salary
      // advances were). Ordinary payroll above has already fully committed
      // by this point regardless of what happens next.
      let terminalDuesMessage = '';
      if (canProcessTerminalDues && ((terminalDuesSummary?.eligibleCount || 0) > 0 || excludedAllocationIds.size > 0)) {
        setProcessingStatus('Processing Terminal Dues payments...');
        const { data: tdResult, error: tdError } = await supabase.rpc('process_terminal_due_allocations_batch', {
          p_excluded_ids: Array.from(excludedAllocationIds),
          p_exclusion_reason: excludedAllocationIds.size > 0 ? exclusionReason.trim() : null,
        });
        if (tdError) {
          console.error('❌ Error processing Terminal Dues payments:', tdError);
          terminalDuesMessage = ` Terminal Dues processing FAILED: ${getErrorMessage(tdError)} -- ordinary payroll above was still processed successfully; resolve this and process Terminal Dues again.`;
        } else {
          const processedCount = tdResult?.processed_count ?? 0;
          const excludedCount = tdResult?.excluded_count ?? 0;
          if (processedCount > 0 || excludedCount > 0) {
            terminalDuesMessage = ` Terminal Dues: ${processedCount} payment(s) totaling ${formatKwacha(tdResult?.total_amount || 0)} processed${excludedCount > 0 ? `, ${excludedCount} excluded` : ''} (ref: ${tdResult?.batch_reference}).`;
          }
        }
        setTerminalDuesSummary(null);
        setExcludedAllocationIds(new Set());
        setExclusionReason('');
      }

      setProcessed(true);
      setShowConfirmModal(false);
      setEditingValues({});
      setIsApproved(false);

      setTimeout(() => setProcessed(false), 5000);

      showNotification(`Payroll for ${getMonthLabel(selectedMonth)} processed successfully! ${result.insertedCount ?? payrollToSave.length} employees processed. The payroll is now pending approval by a manager or admin.${terminalDuesMessage}`, 'success');

    } catch (err) {
      console.error('❌ Error processing payroll:', err);
      showNotification('Failed to process payroll: ' + getErrorMessage(err), 'error');
    } finally {
      setProcessing(false);
      setProcessingStatus('');
    }
  }, [isCurrentMonth, isFutureMonthSelected, canProcessPayroll, attendanceCountsUnavailable, employees, employeesById, editingValues, calculatePayroll, selectedMonth, fetchData, fetchProcessedMonths, canProcessTerminalDues, terminalDuesSummary, excludedAllocationIds, exclusionReason]);

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

            <Button
              variant="secondary"
              onClick={exportPayrollReport}
              disabled={payrollRecords.length === 0}
            >
              <FileText size={16} /> Export Report
            </Button>

            {canProcessTerminalDues && (
              <Button
                variant="outline"
                onClick={exportTerminalDuesReport}
              >
                <FileText size={16} /> Terminal Dues Payments
              </Button>
            )}

            {canApprovePayroll && isMonthProcessed && !isApproved && isCurrentMonth && (
              <Button 
                variant="secondary" 
                onClick={() => {
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
                disabled={processing || isApproved || attendanceCountsUnavailable}
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

      {attendanceCountsUnavailable && (
        <Card className="p-4 bg-red-50 border-red-300 border">
          <div className="flex items-start gap-3">
            <AlertCircle size={20} className="text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-red-800">
                Unable to load attendance totals required for payroll. Please refresh and try again.
              </p>
              <p className="text-sm text-red-700 mt-1">
                Processing and copy-forward are disabled until this loads successfully, so payroll is
                never calculated or saved with missing attendance data.
              </p>
              <button
                onClick={() => fetchData()}
                className="mt-2 text-sm font-medium text-red-800 hover:underline"
              >
                Retry
              </button>
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

      {/* Suppressed while hasBlockedPreview -- this list is itself built
          from the same live calculation that's currently unreliable, and
          the blocking banner above already explains why. */}
      {!hasBlockedPreview && employeesWithDeductions.length > 0 && (
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
                <p>• Absenteeism: {(isCurrentMonth || isFutureMonthSelected) ? `${formatKwacha(payrollRates.absentDeduction)} per absent day` : 'rate in effect when each employee\'s payroll was processed (see breakdown below)'}</p>
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
              {hasBlockedPreview ? (
                <>
                  <p className="text-xl font-bold text-slate-400 mt-1">—</p>
                  <p className="text-xs text-red-500 mt-1">Attendance totals unavailable</p>
                </>
              ) : (
                <>
                  <p className="text-xl font-bold text-slate-800 mt-1">{formatKwacha(totals.paye + totals.pension + totals.uniformDeductions + totals.salaryAdvanceDeductions)}</p>
                  <p className="text-xs text-slate-500 mt-1">PAYE: {formatKwacha(totals.paye)}</p>
                  <p className="text-xs text-slate-500 mt-1">Pension: {formatKwacha(totals.pension)}</p>
                  <p className="text-xs text-red-500 mt-1">Uniform/Attendance: {formatKwacha(totals.uniformDeductions)}</p>
                  {totals.salaryAdvanceDeductions > 0 && (
                    <p className="text-xs text-purple-600 mt-1">Salary Advances: {formatKwacha(totals.salaryAdvanceDeductions)}</p>
                  )}
                </>
              )}
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
              {hasBlockedPreview ? (
                <>
                  <p className="text-2xl font-bold text-slate-400 mt-1">—</p>
                  <p className="text-xs text-red-500 mt-1">Attendance totals unavailable</p>
                </>
              ) : (
                <>
                  <p className="text-2xl font-bold text-[#081C3A] mt-1">{formatKwacha(totals.net)}</p>
                  <p className="text-xs text-[#8B6F0F] mt-1">Total Disbursement</p>
                </>
              )}
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
              {hasBlockedPreview ? (
                <>
                  <p className="text-xl font-bold text-slate-400 mt-1">—</p>
                  <p className="text-xs text-red-500 mt-1">Attendance totals unavailable</p>
                </>
              ) : (
                <>
                  <p className="text-xl font-bold text-red-600 mt-1">{formatKwacha(totals.uniformDeductions)}</p>
                  <p className="text-xs text-red-500 mt-1">{employeesWithDeductions.length} employees</p>
                </>
              )}
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
            = Gross Pay - PAYE ({(payrollRates.payeRate * 100).toFixed(0)}% above {formatKwacha(payrollRates.payeThreshold)}) - Pension ({(payrollRates.pensionEmployeeRate * 100).toFixed(0)}%) - Uniform Deduction - Attendance Deductions - Salary Advance Deduction (if any)
          </p>
          <p className="text-xs text-slate-500 mt-2">Attendance Deductions: Absent ({formatKwacha(payrollRates.absentDeduction)}/day) + Late (MK4,200/day) + Lecture + Appearance</p>
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
          <Badge color={isFutureMonthSelected ? 'blue' : 'yellow'} className="text-xs">
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
            if (attendanceCountsUnavailable) {
              showNotification('Unable to load attendance totals required for payroll. Please refresh and try again.', 'error');
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
                const existingRecord = payrollByEmployee.get(emp.id);
                // This employee's own uniform/attendance and net-pay figures
                // are a live calculation built on attendanceCounts, and that
                // fetch failed -- never render them as if valid (see
                // hasBlockedPreview's own comment above). Never true for an
                // already-processed employee (existingRecord), whose figures
                // come from the stored, unaffected payroll row instead.
                const previewBlocked = isPreviewBlocked(attendanceCountsUnavailable, !!existingRecord);
                const hasAnyDeduction = !previewBlocked && p.uniform_deduction > 0;
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
                      {previewBlocked ? (
                        <span className="text-slate-400" title="Unable to load attendance totals for this employee">—</span>
                      ) : (
                        <>
                          {formatKwacha(p.uniform_deduction || 0)}
                          {hasAnyDeduction && (
                            <div className="text-[10px] text-red-400 space-y-0.5">
                              {hasUniform && <div>Uniform: MK{uniformAmount}</div>}
                              {(attendance?.absentDays || 0) > 0 && <div>Absent: {attendance!.absentDays} × {formatKwacha(getHistoricalSafeAbsentRate({ frozenAbsentDeduction: deduction?.absent_deduction, frozenAbsentDays: deduction?.absent_days, liveConfiguredRate: payrollRates.absentDeduction }))}</div>}
                              {(attendance?.lateDays || 0) > 0 && <div>Late: {attendance!.lateDays} × MK4,200</div>}
                              {(deduction?.lecture_deduction || 0) > 0 && <div>Lecture: MK{deduction!.lecture_deduction}</div>}
                              {(deduction?.appearance_deduction || 0) > 0 && <div>Appearance: MK{deduction!.appearance_deduction}</div>}
                            </div>
                          )}
                        </>
                      )}
                    </TD>
                    <TD className="text-right font-mono font-bold text-[#081C3A] bg-slate-100">
                      {previewBlocked
                        ? <span className="text-slate-400" title="Unable to load attendance totals for this employee">—</span>
                        : formatKwacha(p.net_pay)}
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
                <p>• Absenteeism: {formatKwacha(payrollRates.absentDeduction)} per absent day</p>
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

          {canProcessTerminalDues && (
            <div className="p-4 rounded-lg border border-slate-200 bg-slate-50 text-sm">
              <p className="font-semibold text-slate-700 flex items-center gap-2">
                <Wallet size={16} /> Terminal Dues -- {getMonthLabel(selectedMonth)}
              </p>
              {terminalDuesLoading ? (
                <p className="text-slate-400 mt-2">Loading Terminal Dues summary...</p>
              ) : !terminalDuesSummary || (terminalDuesSummary.eligibleCount === 0 && terminalDuesSummary.exceptions.length === 0) ? (
                <p className="text-slate-500 mt-2">No approved Terminal Dues allocations for this month.</p>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-3 mt-2">
                    <div>
                      <p className="text-slate-500 text-xs">Eligible Payments</p>
                      <p className="font-bold text-slate-800">{terminalDuesSummary.eligibleCount} ({formatKwacha(terminalDuesSummary.eligibleTotal)})</p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs">Carried Forward</p>
                      <p className="font-bold text-slate-800">{terminalDuesSummary.carriedForwardCount}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs">Combined Total Payable</p>
                      <p className="font-bold text-[#081C3A]">{formatKwacha(computeCombinedPayrollTotals(totals.net, terminalDuesSummary.eligibleTotal).combinedTotal)}</p>
                    </div>
                  </div>

                  {terminalDuesSummary.exceptions.length > 0 && (
                    <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-200">
                      <p className="font-semibold text-red-800 flex items-center gap-2 text-xs">
                        <AlertCircle size={14} /> {terminalDuesSummary.exceptions.length} allocation(s) need resolution before processing
                      </p>
                      <div className="mt-2 space-y-2">
                        {terminalDuesSummary.exceptions.map(exc => (
                          <div key={exc.allocationId} className="flex items-start justify-between gap-2 text-xs border-b border-red-100 last:border-0 pb-2 last:pb-0">
                            <div>
                              <p className="font-medium text-red-800">{exc.employeeName} {exc.employeeNumber ? `(${exc.employeeNumber})` : ''} -- {formatKwacha(exc.proposedAmount)}</p>
                              <p className="text-red-600 mt-0.5">{exc.message}</p>
                            </div>
                            <label className="flex items-center gap-1 whitespace-nowrap text-red-700">
                              <input
                                type="checkbox"
                                checked={excludedAllocationIds.has(exc.allocationId)}
                                onChange={() => toggleExcludedAllocation(exc.allocationId)}
                              />
                              Exclude
                            </label>
                          </div>
                        ))}
                      </div>
                      {excludedAllocationIds.size > 0 && (
                        <div className="mt-2">
                          <textarea
                            value={exclusionReason}
                            onChange={e => setExclusionReason(e.target.value)}
                            placeholder="Reason for excluding the selected allocation(s) -- required, recorded in the audit log"
                            rows={2}
                            className="w-full px-2 py-1.5 text-xs border border-red-200 rounded"
                          />
                        </div>
                      )}
                      <p className="text-xs text-red-500 mt-2">
                        Payroll cannot be processed while unresolved allocations remain -- either correct them in the Terminal Dues Allocations tab, or explicitly exclude them above with a reason. Excluded allocations are never auto-skipped and will need a fresh Admin decision later.
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-100">
            <Button variant="outline" onClick={() => setShowConfirmModal(false)}>Cancel</Button>
            <Button variant="secondary" onClick={processPayroll} disabled={processing || terminalDuesLoading}>
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