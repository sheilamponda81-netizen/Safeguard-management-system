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
import { getPayrollRates, PayrollRates } from '../utils/payrollSettings';

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
  const [payrollRates, setPayrollRatesState] = useState<PayrollRates>({
    payeRate: 0.30,
    payeThreshold: 50000,
    pensionEmployeeRate: 0.05,
  });

  // ===== PAGINATION STATES =====
  const [payrollPage, setPayrollPage] = useState(1);
  const [payrollItemsPerPage, setPayrollItemsPerPage] = useState(20);

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
      const { data, error } = await supabase
        .from('payroll')
        .select('month')
        .order('month', { ascending: false });
      
      if (error) throw error;
      
      const uniqueMonths = [...new Set(data?.map(r => r.month) || [])];
      setProcessedMonths(uniqueMonths);
      
      console.log('📊 Processed months (deduplicated):', uniqueMonths);
    } catch (err) {
      console.error('Error fetching processed months:', err);
    }
  }, []);

  // ===== FETCH DATA =====
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data: employeesData, error: empError } = await supabase
        .from('employees')
        .select('id, employee_number, full_name, position, department, basic_salary, status, is_deleted, uniform_deduction')
        .eq('is_deleted', false)
        .eq('status', 'Active');

      if (empError) throw empError;
      setEmployees(employeesData || []);

      const { data: payrollData, error: payError } = await supabase
        .from('payroll')
        .select('*')
        .eq('month', selectedMonth);

      if (payError) throw payError;
      setPayrollRecords(payrollData || []);

      if (payrollData && payrollData.length > 0) {
        const allApproved = payrollData.every(r => r.approval_status === 'approved');
        setIsApproved(allApproved);
      } else {
        setIsApproved(false);
      }

      const { data: deductionsData, error: dedError } = await supabase
        .from('employee_deductions')
        .select('*')
        .eq('month', selectedMonth);

      if (dedError) throw dedError;
      setEmployeeDeductions(deductionsData || []);

      // ===== Live attendance-derived absent/late counts for this month =====
      const [yearStr, monthStr] = selectedMonth.split('-');
      const year = parseInt(yearStr, 10);
      const monthNum = parseInt(monthStr, 10);
      const monthStart = `${selectedMonth}-01`;
      const lastDay = new Date(year, monthNum, 0).getDate();
      const monthEnd = `${selectedMonth}-${String(lastDay).padStart(2, '0')}`;
      const employeeIds = (employeesData || []).map(e => e.id);

      const counts = new Map<string, AttendanceCount>();
      if (employeeIds.length > 0) {
        const { data: attendanceData, error: attendanceError } = await supabase
          .from('attendance')
          .select('employee_id, status')
          .gte('date', monthStart)
          .lte('date', monthEnd)
          .in('employee_id', employeeIds);

        if (attendanceError) throw attendanceError;

        (attendanceData || []).forEach(record => {
          const existing = counts.get(record.employee_id) || { absentDays: 0, lateDays: 0 };
          if (record.status === 'A') existing.absentDays += 1;
          if (record.status === 'L') existing.lateDays += 1;
          counts.set(record.employee_id, existing);
        });
      }
      setAttendanceCounts(counts);

      // ===== Positions (for the "Requires Uniform" gate) =====
      const { data: positionsData, error: positionsError } = await supabase
        .from('positions')
        .select('name, requires_uniform');
      if (positionsError) throw positionsError;
      setPositionsRequiringUniform(
        new Map((positionsData || []).map(p => [p.name, p.requires_uniform !== false]))
      );

      setHasData((payrollData?.length || 0) > 0);

    } catch (err: any) {
      console.error('Error fetching data:', err);
      showNotification('Failed to load payroll data: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [selectedMonth]);

  // ===== Shared payroll rates (PAYE rate/threshold, pension rate) from Settings =====
  useEffect(() => {
    getPayrollRates().then(setPayrollRatesState);
  }, []);

  // ===== GET EMPLOYEE DATA =====
  const getPayrollForEmployee = useCallback((employeeId: string): PayrollRecord | null => {
    return payrollRecords.find(p => p.employee_id === employeeId) || null;
  }, [payrollRecords]);

  const getEmployeeDeduction = useCallback((employeeId: string): EmployeeDeduction | null => {
    return employeeDeductions.find(d => d.employee_id === employeeId) || null;
  }, [employeeDeductions]);

  // ===== CALCULATE PAYROLL =====
  const calculatePayroll = useCallback((employee: Employee, customValues?: Partial<PayrollRecord>): PayrollRecord => {
    const basicSalary = customValues?.basic_salary ?? employee.basic_salary;
    // Allowances default to 0
    const allowances = customValues?.allowances ?? 0;
    // Overtime default to 0
    const overtime = customValues?.overtime ?? 0;
    const bonus = customValues?.bonus ?? 0;
    const grossPay = basicSalary + allowances + overtime + bonus;

    // PAYE/pension rates come from Settings (system_settings via getPayrollRates),
    // not hardcoded -- and PAYE applies only to gross pay above the threshold,
    // matching the policy Settings itself states.
    const paye = customValues?.paye ?? Math.round(Math.max(0, grossPay - payrollRates.payeThreshold) * payrollRates.payeRate);
    const pension = customValues?.pension ?? Math.round(grossPay * payrollRates.pensionEmployeeRate);

    // Uniform deduction only applies to positions marked "Requires Uniform" in
    // Settings -> Positions (defaults to true for positions with no explicit
    // setting yet). `?? 10000`, not `|| 10000`, so an employee whose deduction
    // was intentionally set to 0 isn't silently overridden back to 10000.
    const positionRequiresUniform = positionsRequiringUniform.get(employee.position) ?? true;
    const uniformDeductionValue = positionRequiresUniform ? (employee.uniform_deduction ?? 10000) : 0;

    // Absent/late deductions are now always derived live from the actual
    // attendance table for this month -- no separate "save deductions" step
    // is required for them to count. lecture/appearance deductions have no
    // attendance-grid equivalent and still come from employee_deductions.
    const deduction = getEmployeeDeduction(employee.id);
    const attendance = attendanceCounts.get(employee.id);
    const absentDays = attendance?.absentDays || 0;
    const lateDays = attendance?.lateDays || 0;
    const absentDeduction = absentDays * 4200;
    const lateDeduction = lateDays * 4200;
    const lectureDeduction = deduction?.lecture_deduction || 0;
    const appearanceDeduction = deduction?.appearance_deduction || 0;
    const totalAttendanceDeductions = absentDeduction + lateDeduction + lectureDeduction + appearanceDeduction;
    const totalUniformDeduction = uniformDeductionValue + totalAttendanceDeductions;

    const netPay = grossPay - paye - pension - totalUniformDeduction;

    return {
      id: '',
      employee_id: employee.id,
      month: selectedMonth,
      basic_salary: basicSalary,
      allowances,
      overtime,
      bonus,
      gross_pay: grossPay,
      paye,
      pension,
      uniform_deduction: totalUniformDeduction,
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
      await fetchProcessedMonths();
    };
    init();
  }, [fetchUserProfile, fetchProcessedMonths]);

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
      alert('You do not have permission to copy payroll data.');
      return;
    }
    
    setProcessingStatus('Copying data from ' + getMonthLabel(sourceMonth) + '...');
    
    try {
      const { error: deleteError } = await supabase
        .from('payroll')
        .delete()
        .eq('month', selectedMonth);
      
      if (deleteError) {
        console.error('Error deleting existing data:', deleteError);
      }
      
      const { data: sourceData, error: sourceError } = await supabase
        .from('payroll')
        .select('*')
        .eq('month', sourceMonth);
      
      if (sourceError) {
        console.error('Error fetching source data:', sourceError);
        alert('Failed to fetch source data: ' + sourceError.message);
        return;
      }
      
      if (!sourceData || sourceData.length === 0) {
        alert('No data found in the selected source month.');
        return;
      }
      
      const newRecords = sourceData.map(record => ({
        employee_id: record.employee_id,
        month: selectedMonth,
        basic_salary: record.basic_salary,
        allowances: record.allowances || 0,
        overtime: record.overtime || 0,
        bonus: record.bonus || 0,
        gross_pay: record.gross_pay,
        paye: record.paye || 0,
        pension: record.pension || 0,
        uniform_deduction: record.uniform_deduction || 0,
        net_pay: record.net_pay,
        processed_at: new Date().toISOString(),
        approval_status: 'pending',
        approved_by: null,
        approved_at: null,
        approval_notes: null
      }));
      
      const { data: inserted, error: insertError } = await supabase
        .from('payroll')
        .insert(newRecords)
        .select();
      
      if (insertError) {
        console.error('Error inserting records:', insertError);
        alert('Failed to copy data: ' + insertError.message);
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
      alert(`Payroll data copied from ${getMonthLabel(sourceMonth)} to ${getMonthLabel(selectedMonth)}. ${inserted?.length || 0} records copied.`);
    } catch (err: any) {
      console.error('Error copying data:', err);
      alert('Failed to copy data: ' + err.message);
    } finally {
      setProcessingStatus('');
    }
  }, [canProcessPayroll, selectedMonth, userProfile, fetchData, fetchProcessedMonths]);

  // ===== APPROVE PAYROLL =====
  const approvePayroll = useCallback(async (status: 'approved' | 'rejected') => {
    if (!canApprovePayroll) {
      alert('You do not have permission to approve payroll. Only managers and admins can approve.');
      return;
    }

    if (payrollRecords.length === 0) {
      alert('No payroll records to approve. Please process payroll first.');
      return;
    }

    if (status === 'rejected' && !approvalNotes.trim()) {
      alert('Please provide a reason for rejection.');
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

      // Update all payroll records for this month
      const { error } = await supabase
        .from('payroll')
        .update(updateData)
        .eq('month', selectedMonth);

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
      alert('Failed to approve payroll: ' + err.message);
    } finally {
      setProcessing(false);
      setProcessingStatus('');
    }
  }, [canApprovePayroll, payrollRecords, selectedMonth, userProfile, approvalNotes, fetchData, fetchProcessedMonths]);

  // ===== PROCESS PAYROLL =====
  const processPayroll = useCallback(async () => {
    if (!isCurrentMonth) {
      if (isFutureMonthSelected) {
        alert('Cannot process payroll for future months. Please wait until the month arrives.');
      } else {
        alert('Cannot process payroll for past months. Please switch to the current month.');
      }
      return;
    }

    if (!canProcessPayroll) {
      alert('You do not have permission to process payroll. Only Super Admins can process payroll.');
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
      const { error: deleteError } = await supabase
        .from('payroll')
        .delete()
        .eq('month', selectedMonth);
      
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
        alert('Failed to save payroll: ' + insertError.message);
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
      
      alert(`✅ Payroll for ${getMonthLabel(selectedMonth)} processed successfully! ${insertedData?.length || 0} employees processed.\n\n⚠️ The payroll is now pending approval by a manager or admin.`);
      
    } catch (err: any) {
      console.error('❌ Error processing payroll:', err);
      alert('Failed to process payroll: ' + err.message);
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
          <p className="text-sm text-slate-600">= Basic Salary + Allowances (0%) + Overtime (0%) + Bonus</p>
        </Card>
        <Card className="p-5">
          <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <Calculator size={16} className="text-[#D4A017]" /> Net Pay Formula
          </h3>
          <p className="text-sm text-slate-600">= Gross Pay - PAYE (30%) - Pension (5%) - Uniform Deduction - Attendance Deductions</p>
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
              alert('No previous months available to copy from.');
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
                const uniformAmount = positionRequiresUniform ? (emp.uniform_deduction ?? 10000) : 0;
                const hasUniform = uniformAmount > 0;
                const hasAnyDeduction = p.uniform_deduction > 0;
                const isEditable = canEditPayroll && !payrollRecords.find(r => r.employee_id === emp.id) && isCurrentMonth && !isMonthProcessed && !isApproved;
                
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
                          {!isEditable && payrollRecords.find(r => r.employee_id === emp.id) && (
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
                  const emp = employees.find(e => e.id === record.employee_id);
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