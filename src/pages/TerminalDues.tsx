import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Calculator, Search, CheckCircle, Wallet, Eye, Edit2, Save, ChevronDown } from '../utils/icons';
import { Card, Button, Badge, PageHeader, THead, TBody, TR, TH, TD, Modal } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { canAccess, PERMISSIONS } from '../utils/permissions';
import { showNotification } from '../utils/clickHandlers';
import { logAudit } from '../utils/auditLogger';
import { Pagination } from '../components/Pagination';
import { getDefaultPageSize } from '../utils/uiSettings';
import { calculateTerminalDues as calculateTerminalDuesPure } from '../utils/terminalDuesCalculations';
import { UserProfile } from '../utils/currentProfile';

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
  employee_id: string;
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
  const [filterStatus, setFilterStatus] = useState('all');
  // Permission-driven action gating (correction round 2, item 6) --
  // legacy accounts keep unrestricted access, unchanged. HR Manager gets
  // all three (terminal_dues.create/edit/process); Accountant
  // (terminal_dues.view only) gets none -- read-only, matching "Accountant
  // on Terminal Dues: no Create, no Edit, no Process/status change".
  const [canCreateTerminalDue, setCanCreateTerminalDue] = useState(true);
  const [canEditTerminalDue, setCanEditTerminalDue] = useState(true);
  const [canProcessTerminalDue, setCanProcessTerminalDue] = useState(true);
  
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

  // ===== MEMOIZED VALUES =====
  const isSuperAdmin = useMemo(() => userProfile?.is_super_admin, [userProfile]);
  const userRegion = useMemo(() => userProfile?.regions, [userProfile]);

  const displayedCalculations = useMemo(() => {
    let result = calculations;
    
    if (filterStatus !== 'all') {
      result = result.filter(c => c.status === filterStatus);
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
    const isLegacy = (profile?.role_level ?? null) !== null;
    setCanCreateTerminalDue(await canAccess(isLegacy, PERMISSIONS.TERMINAL_DUES_CREATE));
    setCanEditTerminalDue(await canAccess(isLegacy, PERMISSIONS.TERMINAL_DUES_EDIT));
    setCanProcessTerminalDue(await canAccess(isLegacy, PERMISSIONS.TERMINAL_DUES_PROCESS));
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
      let query = supabase
        .from('terminal_dues')
        .select('*')
        .order('created_at', { ascending: false });

      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        const { data: regionEmployees } = await supabase
          .from('employees')
          .select('id')
          .eq('region_id', userProfile.region_id)
          .eq('is_deleted', false);
        const employeeIds = regionEmployees?.map(e => e.id) || [];
        // A region with zero active employees must return zero terminal-dues
        // records for a non-super-admin -- never fall through to an
        // unfiltered, cross-region query.
        if (employeeIds.length === 0) {
          setCalculations([]);
          setLoading(false);
          return;
        }
        query = query.in('employee_id', employeeIds);
      }

      const { data, error } = await query;
      if (error) throw error;
      
      setCalculations(data || []);
    } catch (err) {
      console.error('Error fetching calculations:', err);
      showNotification('Failed to load calculations', 'error');
    } finally {
      setLoading(false);
    }
  }, [userProfile]);

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
      created_at: new Date().toISOString()
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

    const calculation = calculateTerminalDues();
    if (!calculation) return;

    // `id` is destructured out only to exclude it from the insert payload below.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, ...calculationToSave } = calculation;

    const { data, error } = await supabase
      .from('terminal_dues')
      .insert([calculationToSave])
      .select();

    if (error) {
      showNotification('Error saving calculation: ' + error.message, 'error');
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
  }, [selectedEmployee, calculateTerminalDues, userProfile, fetchCalculations]);

  // ===== UPDATE STATUS =====
  const updateStatus = useCallback(async (id: string, status: string) => {
    const existingCalc = calculations.find(c => c.id === id);
    if (!existingCalc) {
      showNotification('Calculation not found', 'error');
      return;
    }

    const oldStatus = existingCalc.status;

    const { error } = await supabase
      .from('terminal_dues')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      showNotification('Error updating status', 'error');
    } else {
      await logAudit({
        action: 'UPDATE',
        entity_type: 'terminal_due',
        entity_id: id,
        old_data: {
          employee_name: existingCalc.employee_name,
          employee_number: existingCalc.employee_number,
          status: oldStatus,
          total_payable: existingCalc.total_payable
        },
        new_data: {
          employee_name: existingCalc.employee_name,
          employee_number: existingCalc.employee_number,
          status: status,
          total_payable: existingCalc.total_payable
        },
        region_id: userProfile?.region_id
      });

      showNotification(`Status updated to ${status}`, 'success');
      fetchCalculations();
    }
  }, [calculations, userProfile, fetchCalculations]);

  // ===== UPDATE CALCULATION =====
  const updateCalculation = useCallback(async () => {
    if (!editingCalculation) return;

    const existingCalc = calculations.find(c => c.id === editingCalculation.id);
    
    const subtotal = editingCalculation.gratuity + editingCalculation.annual_leave + 
                     editingCalculation.uniform_refund + editingCalculation.other_benefits;
    const totalPayable = subtotal - editingCalculation.deductions;

    const { error } = await supabase
      .from('terminal_dues')
      .update({
        deductions: editingCalculation.deductions,
        uniform_refund: editingCalculation.uniform_refund,
        other_benefits: editingCalculation.other_benefits,
        reason_for_termination: editingCalculation.reason_for_termination,
        termination_type: editingCalculation.termination_type,
        status: editingCalculation.status,
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

  const getTypeColor = useCallback((type: string) => {
    switch (type) {
      case 'disciplinary': return 'red';
      case 'redundancy': return 'orange';
      case 'resignation': return 'blue';
      case 'retirement': return 'gold';
      case 'medical': return 'purple';
      default: return 'gray';
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

      {!isSuperAdmin && userRegion && (
        <Card className="p-3 bg-gradient-to-r from-[#081C3A]/5 to-transparent border-[#081C3A]/20">
          <p className="text-sm text-slate-600">
            Managing terminal dues for <strong className="text-[#081C3A]">{userRegion.name}</strong> region
          </p>
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="p-3 text-center">
          <p className="text-xs text-slate-500">Total Calculations</p>
          <p className="text-xl font-bold text-slate-800">{calculations.length}</p>
        </Card>
        <Card className="p-3 text-center bg-yellow-50">
          <p className="text-xs text-yellow-600">Pending</p>
          <p className="text-xl font-bold text-yellow-700">
            {calculations.filter(c => c.status === 'pending').length}
          </p>
        </Card>
        <Card className="p-3 text-center bg-emerald-50">
          <p className="text-xs text-emerald-600">Approved</p>
          <p className="text-xl font-bold text-emerald-700">
            {calculations.filter(c => c.status === 'approved').length}
          </p>
        </Card>
        <Card className="p-3 text-center bg-blue-50">
          <p className="text-xs text-blue-600">Paid</p>
          <p className="text-xl font-bold text-blue-700">
            {calculations.filter(c => c.status === 'paid').length}
          </p>
        </Card>
        <Card className="p-3 text-center bg-[#FFF1CC]">
          <p className="text-xs text-[#D4A017]">Total Payable</p>
          <p className="text-sm font-bold text-[#D4A017]">
            {formatKwacha(calculations.reduce((sum, c) => sum + (c.total_payable || 0), 0))}
          </p>
        </Card>
      </div>

      {/* Search and Filter */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="relative">
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
          <select
            id="filterStatus"
            name="filterStatus"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="paid">Paid</option>
          </select>
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
                <TH>Position</TH>
                <TH>Date Left</TH>
                <TH className="text-right">Total Payable</TH>
                <TH>Status</TH>
                <TH>Type</TH>
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
                paginatedDues.map((calc) => (
                  <TR key={calc.id} className="hover:bg-slate-50">
                    <TD>
                      <div>
                        <p className="font-medium text-slate-800">{calc.employee_name}</p>
                        <p className="text-xs text-slate-500">{calc.employee_number}</p>
                      </div>
                    </TD>
                    <TD>{calc.position}</TD>
                    <TD>{new Date(calc.date_left).toLocaleDateString()}</TD>
                    <TD className="text-right font-semibold text-[#D4A017]">
                      {formatKwacha(calc.total_payable)}
                    </TD>
                    <TD>
                      <Badge color={getStatusColor(calc.status)}>
                        {calc.status.toUpperCase()}
                      </Badge>
                    </TD>
                    <TD>
                      <Badge color={getTypeColor(calc.termination_type)}>
                        {calc.termination_type?.replace('_', ' ') || 'N/A'}
                      </Badge>
                    </TD>
                    <TD className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => handleViewDetail(calc)}
                          className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-600"
                        >
                          <Eye size={14} />
                        </button>
                        {canEditTerminalDue && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCalculation(calc);
                              setShowEditModal(true);
                            }}
                            className="w-7 h-7 rounded-lg hover:bg-slate-100 text-amber-600"
                          >
                            <Edit2 size={14} />
                          </button>
                        )}
                        {canProcessTerminalDue && calc.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              onClick={() => updateStatus(calc.id, 'approved')}
                              className="w-7 h-7 rounded-lg hover:bg-emerald-100 text-emerald-600"
                            >
                              <CheckCircle size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => updateStatus(calc.id, 'paid')}
                              className="w-7 h-7 rounded-lg hover:bg-blue-100 text-blue-600"
                            >
                              <Wallet size={14} />
                            </button>
                          </>
                        )}
                        {canProcessTerminalDue && calc.status === 'approved' && (
                          <button
                            type="button"
                            onClick={() => updateStatus(calc.id, 'paid')}
                            className="w-7 h-7 rounded-lg hover:bg-blue-100 text-blue-600"
                          >
                            <Wallet size={14} />
                          </button>
                        )}
                      </div>
                    </TD>
                  </TR>
                ))
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
                        <div className="text-xs font-medium text-[#D4A017]">
                          {formatKwacha(emp.basicSalary || 0)}
                        </div>
                      </button>
                    ))
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
            <Button variant="secondary" onClick={saveCalculation} disabled={!selectedEmployee}>
              <Save size={14} className="mr-1" /> Save Calculation
            </Button>
          </div>
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal open={!!showDetailModal} onClose={() => setShowDetailModal(null)} title="Terminal Dues Details" size="lg">
        {showDetailModal && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-slate-500">Employee</p><p className="font-semibold">{showDetailModal.employee_name}</p></div>
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

            <div className="border-t pt-4">
              <p className="text-xs text-slate-500">Reason: {showDetailModal.reason_for_termination}</p>
              <p className="text-xs text-slate-500">Type: {showDetailModal.termination_type?.replace('_', ' ') || 'N/A'}</p>
              <p className="text-xs text-slate-500">Date Left: {new Date(showDetailModal.date_left).toLocaleDateString()}</p>
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              {showDetailModal.status === 'pending' && (
                <>
                  <Button variant="secondary" onClick={() => { updateStatus(showDetailModal.id, 'approved'); setShowDetailModal(null); }}>
                    <CheckCircle size={14} className="mr-1" /> Approve
                  </Button>
                  <Button variant="secondary" onClick={() => { updateStatus(showDetailModal.id, 'paid'); setShowDetailModal(null); }}>
                    <Wallet size={14} className="mr-1" /> Mark Paid
                  </Button>
                </>
              )}
              {showDetailModal.status === 'approved' && (
                <Button variant="secondary" onClick={() => { updateStatus(showDetailModal.id, 'paid'); setShowDetailModal(null); }}>
                  <Wallet size={14} className="mr-1" /> Mark Paid
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
              <div><p className="text-slate-500">Status</p>
                <select
                  id="editStatus"
                  name="editStatus"
                  value={editingCalculation.status}
                  onChange={(e) => setEditingCalculation({ ...editingCalculation, status: e.target.value as TerminalDue['status'] })}
                  className="w-full px-2 py-1 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                >
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="paid">Paid</option>
                </select>
              </div>
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
    </div>
  );
}

export default TerminalDuesPage;