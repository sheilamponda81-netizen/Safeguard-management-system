import { useState, useMemo, useEffect, useCallback } from 'react';
import { Search, Plus, Eye, Edit2, Trash2, Filter, Download, UserPlus, User, Phone, MapPin, Heart, ChevronLeft, ChevronRight, Archive, RotateCcw, Calendar, Clock, AlertCircle, Building2, Home, Loader2 } from 'lucide-react';
import { Card, Button, Badge, THead, TBody, TR, TH, TD, Modal, PageHeader, Tabs } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { showNotification } from '../utils/clickHandlers';
import { sanitizeInput } from '../utils/securityHeaders';
import { logAudit } from '../utils/auditLogger';
import { getEmployeeAuditData, getChanges } from '../utils/auditHelpers';
import { Pagination } from '../components/Pagination';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

interface Employee {
  id: string;
  employeeNumber: string;
  fullName: string;
  gender: string;
  age: number;
  phone: string;
  position: string;
  department: string;
  basicSalary: number;
  status: string;
  email: string;
  dateHired: string;
  dob?: string;
  nationalId?: string;
  address?: string;
  qualification?: string;
  contractType?: string;
  payPoint?: string;
  region_id?: string;
  company?: string;
  workstation?: string;
  pay_point?: string;
  account_number?: string;
  uniform_deduction?: number;
  next_of_kin_name?: string;
  next_of_kin_relationship?: string;
  next_of_kin_phone?: string;
  next_of_kin_address?: string;
  is_deleted?: boolean;
  deleted_at?: string;
  deleted_reason?: string;
  deleted_by?: string;
  deleted_by_name?: string;
  created_at?: string;
  assignment_type?: string;
  resident_name?: string;
  resident_contact?: string;
  company_id?: string;
}

const departmentOptions = [
  'Operations (Guards, K9, Supervisors)',
  'Finance',
  'Logistics',
  'Administration',
  'Building',
  'Marketing',
  'Technical'
];

const relationshipOptions = [
  'Spouse',
  'Parent',
  'Child',
  'Sibling',
  'Relative',
  'Friend',
  'Other'
];

// ===== IMPROVED: Smart Text Normalization =====
const normalizeText = (value: string): string => {
  if (!value) return '';
  
  // Step 1: Remove multiple spaces and trim
  let normalized = value.trim().replace(/\s+/g, ' ');
  
  // Step 2: Convert to uppercase
  normalized = normalized.toUpperCase();
  
  // Step 3: Remove special characters (keep letters, numbers, spaces, and hyphens)
  normalized = normalized.replace(/[^A-Z0-9\s-]/g, '');
  
  // Step 4: Remove extra spaces again
  normalized = normalized.replace(/\s+/g, ' ');
  
  return normalized;
};

const formatText = (value: string) => {
  return value
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^A-Z0-9\s]/g, '');
};

const calculateAge = (dob: string): number => {
  if (!dob) return 0;
  const birthDate = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
};

// ===== Shared Add/Edit employee form validation =====
// Every textbox on the form is mandatory -- this is the single place that
// list lives, so the Add and Edit forms (which duplicate the same fields)
// never drift out of sync on what's required. Returns the label of the first
// missing/invalid field so the caller can show a notification naming it, or
// null when the form is valid.
const REQUIRED_EMPLOYEE_FIELDS: { key: string; label: string }[] = [
  { key: 'fullName', label: 'Full Name' },
  { key: 'dob', label: 'Date of Birth' },
  { key: 'gender', label: 'Gender' },
  { key: 'nationalId', label: 'National ID' },
  { key: 'phone', label: 'Phone Number' },
  { key: 'address', label: 'Residential Address' },
  { key: 'position', label: 'Position' },
  { key: 'department', label: 'Department' },
  { key: 'qualification', label: 'Qualification' },
  { key: 'dateHired', label: 'Date Hired' },
  { key: 'contractType', label: 'Contract Type' },
  { key: 'pay_point', label: 'Pay Point' },
  { key: 'account_number', label: 'Bank Account / Mobile Money Number' },
  { key: 'next_of_kin_name', label: 'Next of Kin Full Name' },
  { key: 'next_of_kin_relationship', label: 'Next of Kin Relationship' },
  { key: 'next_of_kin_phone', label: 'Next of Kin Phone Number' },
  { key: 'next_of_kin_address', label: 'Next of Kin Address' },
];

const validateEmployeeForm = (form: any, isSuperAdmin?: boolean): string | null => {
  if (!form.employeeNumber || String(form.employeeNumber).trim() === '') {
    return 'Employee Number (select a Region first so it can be generated)';
  }

  for (const { key, label } of REQUIRED_EMPLOYEE_FIELDS) {
    if (!form[key] || String(form[key]).trim() === '') {
      return label;
    }
  }

  if (isSuperAdmin && !form.region_id) return 'Region';
  if (form.assignment_type === 'company' && !form.company) return 'Company Name';
  if (form.assignment_type === 'resident') {
    if (!form.resident_name) return 'Resident Name';
    if (!form.resident_contact) return 'Resident Contact';
  }

  if (String(form.nationalId).trim().length !== 8) {
    return 'National ID (must be exactly 8 characters)';
  }
  if (String(form.phone).trim().length !== 10) {
    return 'Phone Number (must be exactly 10 digits)';
  }
  if (String(form.next_of_kin_phone).trim().length !== 10) {
    return 'Next of Kin Phone Number (must be exactly 10 digits)';
  }

  return null;
};

export function EmployeesPage() {
  // ===== ALL HOOKS AT TOP LEVEL =====
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [regions, setRegions] = useState<any[]>([]);
  const [filterRegionId, setFilterRegionId] = useState<string>('');
  const [filterCompany, setFilterCompany] = useState<string>('');
  const [filterWorkstation, setFilterWorkstation] = useState<string>('');
  const [filterPayPoint, setFilterPayPoint] = useState<string>('');
  // Debounced so typing doesn't refetch the whole employees table per keystroke.
  const debouncedFilterCompany = useDebouncedValue(filterCompany, 300);
  const debouncedFilterWorkstation = useDebouncedValue(filterWorkstation, 300);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [userLoading, setUserLoading] = useState(true);
  const [showDeletedModal, setShowDeletedModal] = useState(false);
  const [selectedDeletedEmployee, setSelectedDeletedEmployee] = useState<Employee | null>(null);
  
  // ===== PAGINATION =====
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);

  // ===== MEMOIZED VALUES =====
  const isSuperAdmin = useMemo(() => userProfile?.is_super_admin, [userProfile]);
  const userRegion = useMemo(() => regions.find(r => r.id === userProfile?.region_id), [regions, userProfile]);

  // Separate active and deleted employees - ONLY ACTIVE EMPLOYEES (is_deleted = false or null)
  const activeEmployees = useMemo(() => employees.filter(e => !e.is_deleted), [employees]);
  const deletedEmployees = useMemo(() => employees.filter(e => e.is_deleted === true), [employees]);

  const filtered = useMemo(() => {
    // When statusFilter is 'deleted', show ONLY deleted employees
    if (statusFilter === 'deleted') {
      return deletedEmployees.filter(e => {
        const matchesSearch = e.fullName.toLowerCase().includes(search.toLowerCase()) || 
                             e.employeeNumber.toLowerCase().includes(search.toLowerCase()) || 
                             e.position.toLowerCase().includes(search.toLowerCase());
        return matchesSearch;
      });
    }
    
    // Otherwise show ONLY active employees with optional status filter
    let data = activeEmployees;
    
    return data.filter(e => {
      const matchesSearch = e.fullName.toLowerCase().includes(search.toLowerCase()) || 
                           e.employeeNumber.toLowerCase().includes(search.toLowerCase()) || 
                           e.position.toLowerCase().includes(search.toLowerCase());
      
      let matchesFilter = true;
      if (statusFilter !== 'all') {
        matchesFilter = e.status === statusFilter;
      }
      
      return matchesSearch && matchesFilter;
    });
  }, [activeEmployees, deletedEmployees, search, statusFilter]);

  const totalPages = useMemo(() => Math.ceil(filtered.length / itemsPerPage), [filtered, itemsPerPage]);
  
  const currentItems = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, filtered.length);
    return filtered.slice(startIndex, endIndex);
  }, [filtered, currentPage, itemsPerPage]);

  // ===== CALLBACKS =====
  const fetchRegions = useCallback(async () => {
    const { data } = await supabase.from('regions').select('*');
    setRegions(data || []);
  }, []);

  const fetchUserProfile = useCallback(async () => {
    const profile = await getCurrentProfile();
    setUserProfile(profile);
    setUserLoading(false);
  }, []);

  const fetchEmployees = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase.from('employees').select('*');
      
      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        query = query.eq('region_id', userProfile.region_id);
      }
      
      if (filterRegionId && userProfile?.is_super_admin) {
        query = query.eq('region_id', filterRegionId);
      }
      if (debouncedFilterCompany) query = query.ilike('company', `%${debouncedFilterCompany}%`);
      if (debouncedFilterWorkstation) query = query.ilike('workstation', `%${debouncedFilterWorkstation}%`);
      if (filterPayPoint) query = query.eq('pay_point', filterPayPoint);
      
      const { data, error } = await query.order('full_name');
      if (error) throw error;
      
      const mappedEmployees = (data || []).map((emp: any) => ({
        id: emp.id,
        employeeNumber: emp.employee_number,
        fullName: emp.full_name,
        gender: emp.gender || '',
        age: emp.age || 0,
        phone: emp.phone || '',
        position: emp.position,
        department: emp.department || 'Operations',
        basicSalary: emp.basic_salary,
        status: emp.status || 'Active',
        email: emp.email || '',
        dateHired: emp.hire_date || new Date().toISOString().split('T')[0],
        dob: emp.dob && emp.dob !== '' ? emp.dob : null,
        nationalId: emp.national_id,
        address: emp.address,
        qualification: emp.qualification,
        contractType: emp.contract_type || 'Permanent',
        payPoint: emp.pay_point,
        region_id: emp.region_id,
        company: emp.company,
        workstation: emp.workstation,
        pay_point: emp.pay_point,
        account_number: emp.account_number,
        uniform_deduction: emp.uniform_deduction || 0,
        next_of_kin_name: emp.next_of_kin_name || '',
        next_of_kin_relationship: emp.next_of_kin_relationship || '',
        next_of_kin_phone: emp.next_of_kin_phone || '',
        next_of_kin_address: emp.next_of_kin_address || '',
        is_deleted: emp.is_deleted || false,
        deleted_at: emp.deleted_at || null,
        deleted_reason: emp.deleted_reason || null,
        deleted_by: emp.deleted_by || null,
        created_at: emp.created_at || null,
        assignment_type: emp.assignment_type || 'company',
        resident_name: emp.resident_name || '',
        resident_contact: emp.resident_contact || '',
        company_id: emp.company_id || null,
      }));
      setEmployees(mappedEmployees);
    } catch (err: any) {
      console.error('Error fetching employees:', err);
      showNotification('Failed to load employees', 'error');
    } finally {
      setLoading(false);
    }
  }, [userProfile, filterRegionId, debouncedFilterCompany, debouncedFilterWorkstation, filterPayPoint]);

  // ===== CHECK DUPLICATES =====
  // National ID, phone, and bank account/mobile money number are the three
  // "must never collide" fields across the whole employee base (soon to be
  // ~2000 records) -- checked against active (non-deleted) employees only, so
  // a soft-deleted record's old details never blocks reusing them.
  const checkDuplicates = useCallback(async (nationalId: string, phone: string, accountNumber: string, employeeId?: string) => {
    let nationalIdExists = false;
    let phoneExists = false;
    let accountExists = false;

    if (nationalId) {
      let query = supabase
        .from('employees')
        .select('id')
        .eq('national_id', nationalId)
        .eq('is_deleted', false);

      if (employeeId) {
        query = query.neq('id', employeeId);
      }

      const { data: nationalIdData } = await query;
      nationalIdExists = !!(nationalIdData && nationalIdData.length > 0);
    }

    if (phone) {
      let query = supabase
        .from('employees')
        .select('id')
        .eq('phone', phone)
        .eq('is_deleted', false);

      if (employeeId) {
        query = query.neq('id', employeeId);
      }

      const { data: phoneData } = await query;
      phoneExists = !!(phoneData && phoneData.length > 0);
    }

    if (accountNumber) {
      let query = supabase
        .from('employees')
        .select('id')
        .eq('account_number', accountNumber)
        .eq('is_deleted', false);

      if (employeeId) {
        query = query.neq('id', employeeId);
      }

      const { data: accountData } = await query;
      accountExists = !!(accountData && accountData.length > 0);
    }

    return { nationalIdExists, phoneExists, accountExists };
  }, []);

  // ===== ADD EMPLOYEE =====
  const addEmployee = useCallback(async (emp: any) => {
    const safeEmp = {
      ...emp,
      fullName: sanitizeInput(emp.fullName),
      position: sanitizeInput(emp.position),
      department: sanitizeInput(emp.department),
      address: sanitizeInput(emp.address),
      qualification: sanitizeInput(emp.qualification),
      company: sanitizeInput(emp.company),
      workstation: sanitizeInput(emp.workstation),
      nationalId: sanitizeInput(emp.nationalId),
      phone: sanitizeInput(emp.phone),
      resident_name: sanitizeInput(emp.resident_name || ''),
      resident_contact: sanitizeInput(emp.resident_contact || ''),
      next_of_kin_name: sanitizeInput(emp.next_of_kin_name),
      next_of_kin_relationship: sanitizeInput(emp.next_of_kin_relationship),
      next_of_kin_phone: sanitizeInput(emp.next_of_kin_phone),
      next_of_kin_address: sanitizeInput(emp.next_of_kin_address),
    };
    
    let assignedRegionId = safeEmp.region_id;
    if (!userProfile?.is_super_admin) {
      assignedRegionId = userProfile?.region_id;
    }
    
    if (userProfile?.is_super_admin && !assignedRegionId) {
      showNotification('Please select a region', 'error');
      return;
    }
    
    const { data: existing } = await supabase
      .from('employees')
      .select('employee_number')
      .eq('employee_number', safeEmp.employeeNumber)
      .single();
    
    if (existing) {
      showNotification(`Employee number ${safeEmp.employeeNumber} already exists!`, 'error');
      return;
    }
    
    const { nationalIdExists, phoneExists, accountExists } = await checkDuplicates(safeEmp.nationalId, safeEmp.phone, safeEmp.account_number);

    if (nationalIdExists) {
      showNotification(`National ID ${safeEmp.nationalId} is already in use by another employee!`, 'error');
      return;
    }

    if (phoneExists) {
      showNotification(`Phone number ${safeEmp.phone} is already in use by another employee!`, 'error');
      return;
    }

    if (accountExists) {
      showNotification(`Account number ${safeEmp.account_number} is already in use by another employee!`, 'error');
      return;
    }

    // Format company and workstation based on assignment type
    const formattedCompany = safeEmp.assignment_type === 'company' && safeEmp.company ? formatText(safeEmp.company) : null;
    const formattedWorkstation = safeEmp.workstation ? formatText(safeEmp.workstation) : null;
    const formattedResidentName = safeEmp.assignment_type === 'resident' ? formatText(safeEmp.resident_name) : null;
    const formattedResidentContact = safeEmp.assignment_type === 'resident' ? sanitizeInput(safeEmp.resident_contact) : null;
    
    const uniformDeduction = parseInt(safeEmp.uniform_deduction) || 0;
    const calculatedAge = safeEmp.dob ? calculateAge(safeEmp.dob) : 0;
    
    const { data, error } = await supabase
      .from('employees')
      .insert([{
        employee_number: safeEmp.employeeNumber,
        full_name: safeEmp.fullName,
        gender: safeEmp.gender,
        age: calculatedAge,
        phone: safeEmp.phone,
        position: safeEmp.position,
        department: safeEmp.department,
        basic_salary: parseFloat(safeEmp.basicSalary),
        status: safeEmp.status || 'Active',
        email: safeEmp.email,
        hire_date: safeEmp.dateHired && safeEmp.dateHired !== '' ? safeEmp.dateHired : new Date().toISOString().split('T')[0],
        dob: safeEmp.dob && safeEmp.dob !== '' ? safeEmp.dob : null,
        national_id: safeEmp.nationalId,
        address: safeEmp.address,
        qualification: safeEmp.qualification,
        contract_type: safeEmp.contractType,
        region_id: assignedRegionId,
        company: formattedCompany,
        workstation: formattedWorkstation,
        pay_point: safeEmp.pay_point,
        account_number: safeEmp.account_number,
        uniform_deduction: uniformDeduction,
        next_of_kin_name: safeEmp.next_of_kin_name,
        next_of_kin_relationship: safeEmp.next_of_kin_relationship,
        next_of_kin_phone: safeEmp.next_of_kin_phone,
        next_of_kin_address: safeEmp.next_of_kin_address,
        is_deleted: false,
        deleted_at: null,
        deleted_reason: null,
        deleted_by: null,
        assignment_type: safeEmp.assignment_type || 'company',
        resident_name: formattedResidentName,
        resident_contact: formattedResidentContact,
        // company_id will be set by the trigger
      }])
      .select();
    
    if (error) {
      showNotification('Error adding employee: ' + error.message, 'error');
    } else if (data && data[0]) {
      const newEmployee = {
        id: data[0].id,
        employeeNumber: data[0].employee_number,
        fullName: data[0].full_name,
        gender: data[0].gender || '',
        age: data[0].age || 0,
        phone: data[0].phone || '',
        position: data[0].position,
        department: data[0].department,
        basicSalary: data[0].basic_salary,
        status: data[0].status,
        email: data[0].email || '',
        dateHired: data[0].hire_date || new Date().toISOString().split('T')[0],
        dob: data[0].dob,
        nationalId: data[0].national_id,
        address: data[0].address,
        qualification: data[0].qualification,
        contractType: data[0].contract_type,
        region_id: data[0].region_id,
        company: data[0].company,
        workstation: data[0].workstation,
        pay_point: data[0].pay_point,
        account_number: data[0].account_number,
        uniform_deduction: data[0].uniform_deduction || 0,
        next_of_kin_name: data[0].next_of_kin_name || '',
        next_of_kin_relationship: data[0].next_of_kin_relationship || '',
        next_of_kin_phone: data[0].next_of_kin_phone || '',
        next_of_kin_address: data[0].next_of_kin_address || '',
        is_deleted: data[0].is_deleted || false,
        deleted_at: data[0].deleted_at || null,
        deleted_reason: data[0].deleted_reason || null,
        deleted_by: data[0].deleted_by || null,
        created_at: data[0].created_at || null,
        assignment_type: data[0].assignment_type || 'company',
        resident_name: data[0].resident_name || '',
        resident_contact: data[0].resident_contact || '',
        company_id: data[0].company_id || null,
      };
      setEmployees([newEmployee, ...employees]);
      
      await logAudit({
        action: 'CREATE',
        entity_type: 'employee',
        entity_id: newEmployee.id,
        new_data: getEmployeeAuditData(newEmployee),
        region_id: assignedRegionId
      });
      
      showNotification(`${safeEmp.fullName} has been added`, 'success');
    }
    setShowAdd(false);
  }, [userProfile, employees, checkDuplicates]);

  // ===== UPDATE EMPLOYEE =====
  const updateEmployee = useCallback(async (emp: any) => {
    if (!editingEmployee) return;
    
    const oldEmployeeData = { ...editingEmployee };
    
    const safeEmp = {
      ...emp,
      fullName: sanitizeInput(emp.fullName),
      position: sanitizeInput(emp.position),
      department: sanitizeInput(emp.department),
      address: sanitizeInput(emp.address),
      qualification: sanitizeInput(emp.qualification),
      company: sanitizeInput(emp.company),
      workstation: sanitizeInput(emp.workstation),
      nationalId: sanitizeInput(emp.nationalId),
      phone: sanitizeInput(emp.phone),
      resident_name: sanitizeInput(emp.resident_name || ''),
      resident_contact: sanitizeInput(emp.resident_contact || ''),
      next_of_kin_name: sanitizeInput(emp.next_of_kin_name),
      next_of_kin_relationship: sanitizeInput(emp.next_of_kin_relationship),
      next_of_kin_phone: sanitizeInput(emp.next_of_kin_phone),
      next_of_kin_address: sanitizeInput(emp.next_of_kin_address),
    };
    
    const { nationalIdExists, phoneExists, accountExists } = await checkDuplicates(safeEmp.nationalId, safeEmp.phone, safeEmp.account_number, editingEmployee.id);

    if (nationalIdExists) {
      showNotification(`National ID ${safeEmp.nationalId} is already in use by another employee!`, 'error');
      return;
    }

    if (phoneExists) {
      showNotification(`Phone number ${safeEmp.phone} is already in use by another employee!`, 'error');
      return;
    }

    if (accountExists) {
      showNotification(`Account number ${safeEmp.account_number} is already in use by another employee!`, 'error');
      return;
    }

    const formattedCompany = safeEmp.assignment_type === 'company' && safeEmp.company ? formatText(safeEmp.company) : null;
    const formattedWorkstation = safeEmp.workstation ? formatText(safeEmp.workstation) : null;
    const formattedResidentName = safeEmp.assignment_type === 'resident' ? formatText(safeEmp.resident_name) : null;
    const formattedResidentContact = safeEmp.assignment_type === 'resident' ? sanitizeInput(safeEmp.resident_contact) : null;

    const uniformDeduction = parseInt(safeEmp.uniform_deduction) || 0;
    const calculatedAge = safeEmp.dob ? calculateAge(safeEmp.dob) : 0;

    const { data, error } = await supabase
      .from('employees')
      .update({
        employee_number: safeEmp.employeeNumber,
        full_name: safeEmp.fullName,
        gender: safeEmp.gender,
        age: calculatedAge,
        phone: safeEmp.phone,
        position: safeEmp.position,
        department: safeEmp.department,
        basic_salary: parseFloat(safeEmp.basicSalary),
        status: safeEmp.status,
        email: safeEmp.email,
        hire_date: safeEmp.dateHired && safeEmp.dateHired !== '' ? safeEmp.dateHired : null,
        dob: safeEmp.dob && safeEmp.dob !== '' ? safeEmp.dob : null,
        national_id: safeEmp.nationalId,
        address: safeEmp.address,
        qualification: safeEmp.qualification,
        contract_type: safeEmp.contractType,
        company: formattedCompany,
        workstation: formattedWorkstation,
        pay_point: safeEmp.pay_point,
        account_number: safeEmp.account_number,
        uniform_deduction: uniformDeduction,
        next_of_kin_name: safeEmp.next_of_kin_name,
        next_of_kin_relationship: safeEmp.next_of_kin_relationship,
        next_of_kin_phone: safeEmp.next_of_kin_phone,
        next_of_kin_address: safeEmp.next_of_kin_address,
        assignment_type: safeEmp.assignment_type || 'company',
        resident_name: formattedResidentName,
        resident_contact: formattedResidentContact,
        // company_id will be updated by trigger
      })
      .eq('id', editingEmployee.id)
      .select();
    
    if (error) {
      showNotification('Error updating employee: ' + error.message, 'error');
    } else if (data && data[0]) {
      const updatedEmployee = {
        ...editingEmployee,
        employeeNumber: data[0].employee_number,
        fullName: data[0].full_name,
        gender: data[0].gender || '',
        age: data[0].age || 0,
        phone: data[0].phone || '',
        position: data[0].position,
        department: data[0].department,
        basicSalary: data[0].basic_salary,
        status: data[0].status,
        email: data[0].email || '',
        dateHired: data[0].hire_date || new Date().toISOString().split('T')[0],
        dob: data[0].dob,
        nationalId: data[0].national_id,
        address: data[0].address,
        qualification: data[0].qualification,
        contractType: data[0].contract_type,
        company: data[0].company,
        workstation: data[0].workstation,
        pay_point: data[0].pay_point,
        account_number: data[0].account_number,
        uniform_deduction: data[0].uniform_deduction || 0,
        next_of_kin_name: data[0].next_of_kin_name || '',
        next_of_kin_relationship: data[0].next_of_kin_relationship || '',
        next_of_kin_phone: data[0].next_of_kin_phone || '',
        next_of_kin_address: data[0].next_of_kin_address || '',
        assignment_type: data[0].assignment_type || 'company',
        resident_name: data[0].resident_name || '',
        resident_contact: data[0].resident_contact || '',
        company_id: data[0].company_id || null,
      };
      setEmployees(employees.map(e => e.id === updatedEmployee.id ? updatedEmployee : e));
      
      const oldAuditData = getEmployeeAuditData(oldEmployeeData);
      const newAuditData = getEmployeeAuditData(updatedEmployee);
      const changes = getChanges(oldAuditData, newAuditData);
      
      await logAudit({
        action: 'UPDATE',
        entity_type: 'employee',
        entity_id: updatedEmployee.id,
        old_data: {
          ...oldAuditData,
          _changes: changes.changed
        },
        new_data: {
          ...newAuditData,
          _changes: changes.changed
        },
        region_id: updatedEmployee.region_id
      });
      
      showNotification(`${safeEmp.fullName} has been updated`, 'success');
    }
    setShowEdit(false);
    setEditingEmployee(null);
  }, [editingEmployee, employees, checkDuplicates]);

  // ===== DELETE EMPLOYEE =====
  const handleDelete = useCallback(async (employee: Employee) => {
    if (!userProfile?.is_super_admin && employee.region_id !== userProfile?.region_id) {
      showNotification('You cannot delete employees from other regions', 'error');
      return;
    }
    
    if (employee.is_deleted) {
      showNotification('This employee is already deleted.', 'error');
      return;
    }
    
    const reason = prompt(`Are you sure you want to delete ${employee.fullName}?\n\nPlease enter the reason for deletion (or click Cancel to abort):`);
    
    if (reason === null) {
      return;
    }
    
    if (reason.trim() === '') {
      showNotification('Please provide a reason for deletion', 'error');
      return;
    }
    
    const employeeData = { ...employee };
    const deletedBy = userProfile?.full_name || userProfile?.email || 'Unknown';
    
    const { error } = await supabase
      .from('employees')
      .update({
        status: 'Deleted',
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_reason: reason.trim(),
        deleted_by: userProfile?.id || null,
      })
      .eq('id', employee.id);
      
    if (error) {
      showNotification('Error deleting employee: ' + error.message, 'error');
    } else {
      const updatedEmployees = employees.map(e => {
        if (e.id === employee.id) {
          return {
            ...e,
            status: 'Deleted',
            is_deleted: true,
            deleted_at: new Date().toISOString(),
            deleted_reason: reason.trim(),
            deleted_by: userProfile?.id || null,
          };
        }
        return e;
      });
      setEmployees(updatedEmployees);
      
      await logAudit({
        action: 'DELETE',
        entity_type: 'employee',
        entity_id: employee.id,
        old_data: getEmployeeAuditData(employeeData),
        new_data: { 
          deleted_reason: reason.trim(), 
          deleted_at: new Date().toISOString(),
          deleted_by: deletedBy
        },
        region_id: employee.region_id
      });
      
      showNotification(`${employee.fullName} has been marked as deleted. Records preserved.`, 'success');
    }
  }, [userProfile, employees]);

  // ===== RESTORE EMPLOYEE =====
  const restoreEmployee = useCallback(async (employee: Employee) => {
    if (!userProfile?.is_super_admin && employee.region_id !== userProfile?.region_id) {
      showNotification('You cannot restore employees from other regions', 'error');
      return;
    }
    
    if (confirm(`Are you sure you want to restore ${employee.fullName}?`)) {
      const { error } = await supabase
        .from('employees')
        .update({
          status: 'Active',
          is_deleted: false,
          deleted_at: null,
          deleted_reason: null,
          deleted_by: null,
        })
        .eq('id', employee.id);
        
      if (error) {
        showNotification('Error restoring employee: ' + error.message, 'error');
      } else {
        const updatedEmployees = employees.map(e => {
          if (e.id === employee.id) {
            return {
              ...e,
              status: 'Active',
              is_deleted: false,
              deleted_at: null,
              deleted_reason: null,
              deleted_by: null,
            };
          }
          return e;
        });
        setEmployees(updatedEmployees);
        
        await logAudit({
          action: 'UPDATE',
          entity_type: 'employee',
          entity_id: employee.id,
          old_data: { is_deleted: true, status: 'Deleted', deleted_reason: employee.deleted_reason },
          new_data: { is_deleted: false, status: 'Active' },
          region_id: employee.region_id
        });
        
        setStatusFilter('all');
        showNotification(`${employee.fullName} has been restored`, 'success');
      }
    }
  }, [userProfile, employees]);

  // ===== EXPORT EMPLOYEES =====
  const handleExport = useCallback(() => {
    const csv = [
      ['Employee ID', 'Full Name', 'Company', 'Workstation', 'Account Number', 'Gender', 'Age', 'Phone', 'Position', 'Department', 'Basic Salary', 'Status', 'Pay Point', 'Uniform Deduction', 'Next of Kin', 'Relationship', 'NOK Phone', 'Deleted', 'Deleted Reason', 'Deleted Date', 'Assignment Type', 'Resident Name', 'Resident Contact'],
      ...filtered.map(e => [
        e.employeeNumber, e.fullName, e.company || '', e.workstation || '',
        e.account_number || '', e.gender, e.age, e.phone, e.position, e.department, e.basicSalary, e.status, e.pay_point || '',
        e.uniform_deduction || 0,
        e.next_of_kin_name || '',
        e.next_of_kin_relationship || '',
        e.next_of_kin_phone || '',
        e.is_deleted ? 'Yes' : 'No',
        e.is_deleted ? (e.deleted_reason || '') : '',
        e.is_deleted ? (e.deleted_at ? new Date(e.deleted_at).toLocaleDateString() : '') : '',
        e.assignment_type || 'company',
        e.resident_name || '',
        e.resident_contact || ''
      ])
    ].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `employees_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showNotification(`Exported ${filtered.length} employees`, 'success');
  }, [filtered]);

  const clearFilters = useCallback(() => {
    setFilterRegionId('');
    setFilterCompany('');
    setFilterWorkstation('');
    setFilterPayPoint('');
  }, []);

  const handleEdit = useCallback((employee: Employee) => {
    if (!userProfile?.is_super_admin && employee.region_id !== userProfile?.region_id) {
      showNotification('You cannot edit employees from other regions', 'error');
      return;
    }
    if (employee.is_deleted) {
      showNotification('Cannot edit deleted employees. Please restore first.', 'error');
      return;
    }
    setEditingEmployee(employee);
    setShowEdit(true);
  }, [userProfile]);

  // ===== VIEW DELETED EMPLOYEE DETAILS =====
  const handleViewDeleted = useCallback((employee: Employee) => {
    setSelectedDeletedEmployee(employee);
    setShowDeletedModal(true);
  }, []);

  // ===== PAGINATION =====
  const goToPage = useCallback((page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  }, [totalPages]);

  // ===== EFFECTS =====
  useEffect(() => {
    fetchUserProfile();
    fetchRegions();
  }, [fetchUserProfile, fetchRegions]);

  useEffect(() => {
    if (!userLoading && userProfile) {
      fetchEmployees();
    }
  }, [fetchEmployees, userLoading, userProfile]);

  // ===== RENDER =====
  if (userLoading || loading) return <div className="text-center py-8">Loading...</div>;
  if (selected) return <EmployeeProfile employee={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Employee Management"
        subtitle={isSuperAdmin ? "Complete database of all security personnel" : `${userRegion?.name || ''} - Security Personnel`}
        actions={
          <>
            <Button variant="outline" className="hidden md:inline-flex"><Filter size={16} /> Filter</Button>
            <Button variant="outline" className="hidden md:inline-flex" onClick={handleExport}><Download size={16} /> Export</Button>
            <Button variant="secondary" onClick={() => setShowAdd(true)}><Plus size={16} /> Add Employee</Button>
          </>
        }
      />

      {!isSuperAdmin && userRegion && (
        <Card className="p-3 bg-gradient-to-r from-[#081C3A]/5 to-transparent border-[#081C3A]/20">
          <p className="text-sm text-slate-600">
            Viewing employees in <strong className="text-[#081C3A]">{userRegion.name}</strong>
          </p>
        </Card>
      )}

      {isSuperAdmin && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Filter size={14} /> Advanced Filters
            </h4>
            {(filterRegionId || filterCompany || filterWorkstation || filterPayPoint) && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="text-xs">
                Clear all
              </Button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Region</label>
              <select
                value={filterRegionId}
                onChange={(e) => {
                  setFilterRegionId(e.target.value);
                  setFilterCompany('');
                  setFilterWorkstation('');
                }}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              >
                <option value="">All Regions</option>
                {regions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Company</label>
              <input
                type="text"
                value={filterCompany}
                onChange={(e) => setFilterCompany(e.target.value.toUpperCase())}
                placeholder="Type company name..."
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Workstation</label>
              <input
                type="text"
                value={filterWorkstation}
                onChange={(e) => setFilterWorkstation(e.target.value.toUpperCase())}
                placeholder="Type workstation..."
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Pay Point</label>
              <select
                value={filterPayPoint}
                onChange={(e) => setFilterPayPoint(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              >
                <option value="">All Pay Points</option>
                <option value="national_bank">National Bank of Malawi</option>
                <option value="standard_bank">Standard Bank</option>
                <option value="nbs_bank">NBS Bank</option>
                <option value="centenary_bank">Centenary Bank</option>
                <option value="fdh_bank">FDH Bank</option>
                <option value="first_capital_bank">First Capital Bank</option>
                <option value="airtel_money">Airtel Money</option>
                <option value="tnm_mpamba">TNM Mpamba</option>
              </select>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Active', n: activeEmployees.length },
          { label: 'Active', n: activeEmployees.filter(e => e.status === 'Active').length },
          { label: 'On Leave', n: activeEmployees.filter(e => e.status === 'On Leave').length },
          { label: <span className="flex items-center gap-1"><Archive size={14} /> Deleted</span>, n: deletedEmployees.length }
        ].map((s, i) => (
          <Card key={i} className="p-4">
            <p className="text-xs text-slate-500">{s.label}</p>
            <p className="text-2xl font-bold text-slate-800 mt-1">{s.n}</p>
          </Card>
        ))}
      </div>

      <Card className="p-4 flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, ID or position..."
            className="w-full pl-10 pr-3 py-2.5 text-sm border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-[#081C3A]"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {[
            { v: 'all', l: 'All Active' },
            { v: 'Active', l: 'Active' },
            { v: 'On Leave', l: 'On Leave' },
            { v: 'Suspended', l: 'Suspended' },
            { v: 'deleted', l: <span className="flex items-center gap-1"><Archive size={12} /> Deleted</span> }
          ].map(f => (
            <button
              key={f.v}
              onClick={() => {
                setStatusFilter(f.v);
                setCurrentPage(1);
              }}
              className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                statusFilter === f.v 
                  ? f.v === 'deleted'
                    ? 'bg-red-600 text-white'
                    : 'bg-[#081C3A] text-white'
                  : f.v === 'deleted' 
                    ? 'bg-red-50 text-red-600 hover:bg-red-100' 
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {f.l}
            </button>
          ))}
        </div>
      </Card>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <THead>
              <TR hover={false}>
                <TH>Employee</TH>
                <TH className="hidden lg:table-cell">Company/Resident</TH>
                <TH className="hidden xl:table-cell">Workstation</TH>
                <TH className="hidden md:table-cell">Phone</TH>
                <TH>Position</TH>
                <TH className="hidden lg:table-cell">Basic Salary</TH>
                <TH>Status</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {currentItems.map(emp => (
                <TR key={emp.id} onClick={() => !emp.is_deleted && setSelected(emp)}>
                  <TD>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-[#081C3A] flex items-center justify-center text-white text-xs font-bold shrink-0">
                        {emp.fullName.split(' ').map(n => n[0]).join('').slice(0, 2)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-800">{emp.fullName}</p>
                        <p className="text-xs text-slate-500">{emp.employeeNumber}</p>
                      </div>
                    </div>
                  </TD>
                  <TD className="hidden lg:table-cell">
                    {emp.assignment_type === 'resident' ? (
                      <div className="flex flex-col">
                        <span className="flex items-center gap-1 text-xs">
                          <Home size={12} className="text-emerald-600" />
                          <span className="font-medium">{emp.resident_name || '-'}</span>
                        </span>
                        {emp.resident_contact && (
                          <span className="text-[10px] text-slate-400">Contact: {emp.resident_contact}</span>
                        )}
                        <Badge color="green" className="text-[8px]">Resident</Badge>
                      </div>
                    ) : (
                      <div className="flex flex-col">
                        <span className="flex items-center gap-1 text-xs">
                          <Building2 size={12} className="text-blue-600" />
                          <span className="font-medium">{emp.company || '-'}</span>
                        </span>
                        <Badge color="blue" className="text-[8px]">Company</Badge>
                      </div>
                    )}
                  </TD>
                  <TD className="hidden xl:table-cell">{emp.workstation || '-'}</TD>
                  <TD className="hidden md:table-cell">{emp.phone || '-'}</TD>
                  <TD>{emp.position}</TD>
                  <TD className="hidden lg:table-cell font-medium">{formatKwacha(emp.basicSalary)}</TD>
                  <TD>
                    {emp.is_deleted ? (
                      <Badge color="red">🗑️ Deleted</Badge>
                    ) : (
                      <Badge color={emp.status === 'Active' ? 'green' : emp.status === 'On Leave' ? 'yellow' : 'red'}>
                        {emp.status}
                      </Badge>
                    )}
                  </TD>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      {emp.is_deleted ? (
                        <>
                          <button 
                            onClick={() => handleViewDeleted(emp)} 
                            className="w-8 h-8 rounded-lg hover:bg-slate-100 text-blue-600 flex items-center justify-center"
                            title="View Deleted Details"
                          >
                            <Eye size={14} />
                          </button>
                          <button 
                            onClick={() => restoreEmployee(emp)} 
                            className="w-8 h-8 rounded-lg hover:bg-emerald-50 text-emerald-600 flex items-center justify-center"
                            title="Restore Employee"
                          >
                            <RotateCcw size={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => setSelected(emp)} className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-600 flex items-center justify-center"><Eye size={14} /></button>
                          <button onClick={() => handleEdit(emp)} className="w-8 h-8 rounded-lg hover:bg-slate-100 text-amber-600 flex items-center justify-center"><Edit2 size={14} /></button>
                          <button onClick={() => handleDelete(emp)} className="w-8 h-8 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center"><Trash2 size={14} /></button>
                        </>
                      )}
                    </div>
                  </td>
                </TR>
              ))}
            </TBody>
          </table>
        </div>
        
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={filtered.length}
          itemsPerPage={itemsPerPage}
          onPageChange={goToPage}
          onItemsPerPageChange={(items) => {
            setItemsPerPage(items);
            setCurrentPage(1);
          }}
        />
      </div>

      {/* Deleted Employee Details Modal */}
      <Modal
        open={showDeletedModal}
        onClose={() => { setShowDeletedModal(false); setSelectedDeletedEmployee(null); }}
        title="Deleted Employee Details"
        size="lg"
      >
        {selectedDeletedEmployee && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-red-100 flex items-center justify-center text-red-600 text-xl font-bold">
                {selectedDeletedEmployee.fullName?.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
              </div>
              <div>
                <h3 className="text-xl font-bold text-slate-800">{selectedDeletedEmployee.fullName}</h3>
                <p className="text-sm text-slate-500">{selectedDeletedEmployee.position} · {selectedDeletedEmployee.employeeNumber}</p>
                <Badge color="red">🗑️ Deleted</Badge>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="p-3 bg-red-50 rounded-lg border border-red-200">
                <p className="text-xs text-red-600 font-semibold flex items-center gap-1">
                  <AlertCircle size={14} /> Deletion Reason
                </p>
                <p className="font-medium text-slate-800 mt-1">{selectedDeletedEmployee.deleted_reason || 'No reason provided'}</p>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                <p className="text-xs text-slate-500 font-semibold flex items-center gap-1">
                  <Calendar size={14} /> Deleted On
                </p>
                <p className="font-medium text-slate-800 mt-1">
                  {selectedDeletedEmployee.deleted_at ? new Date(selectedDeletedEmployee.deleted_at).toLocaleString() : 'Unknown'}
                </p>
              </div>
            </div>

            <div className="border-t pt-4">
              <h4 className="font-semibold text-slate-800 mb-3 text-sm">Employee Information</h4>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><p className="text-slate-500 text-xs">Phone</p><p className="font-medium">{selectedDeletedEmployee.phone || 'N/A'}</p></div>
                <div><p className="text-slate-500 text-xs">Email</p><p className="font-medium">{selectedDeletedEmployee.email || 'N/A'}</p></div>
                <div><p className="text-slate-500 text-xs">Department</p><p className="font-medium">{selectedDeletedEmployee.department || 'N/A'}</p></div>
                <div><p className="text-slate-500 text-xs">Basic Salary</p><p className="font-medium">{formatKwacha(selectedDeletedEmployee.basicSalary)}</p></div>
                <div><p className="text-slate-500 text-xs">Date Hired</p><p className="font-medium">{selectedDeletedEmployee.dateHired ? new Date(selectedDeletedEmployee.dateHired).toLocaleDateString() : 'N/A'}</p></div>
                <div><p className="text-slate-500 text-xs">Company/Resident</p><p className="font-medium">
                  {selectedDeletedEmployee.assignment_type === 'resident' ? (
                    <span>{selectedDeletedEmployee.resident_name || 'N/A'} (Resident)</span>
                  ) : (
                    <span>{selectedDeletedEmployee.company || 'N/A'} (Company)</span>
                  )}
                </p></div>
              </div>
            </div>

            {selectedDeletedEmployee.deleted_by && (
              <div className="border-t pt-4">
                <h4 className="font-semibold text-slate-800 mb-3 text-sm">Deletion Record</h4>
                <div className="p-3 bg-slate-50 rounded-lg text-sm">
                  <p><span className="text-slate-500">Deleted by:</span> <span className="font-medium">{selectedDeletedEmployee.deleted_by}</span></p>
                  <p className="mt-1"><span className="text-slate-500">Employee ID:</span> <span className="font-medium">{selectedDeletedEmployee.employeeNumber}</span></p>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button variant="outline" onClick={() => { setShowDeletedModal(false); setSelectedDeletedEmployee(null); }}>
                Close
              </Button>
              <Button variant="secondary" onClick={() => {
                restoreEmployee(selectedDeletedEmployee);
                setShowDeletedModal(false);
                setSelectedDeletedEmployee(null);
              }}>
                <RotateCcw size={14} className="mr-1" /> Restore Employee
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add New Employee" size="xl">
        <AddEmployeeForm 
          onSubmit={addEmployee} 
          onCancel={() => setShowAdd(false)} 
          departments={departmentOptions} 
          regions={regions}
          userRegionId={userProfile?.region_id}
          isSuperAdmin={isSuperAdmin}
          userRegionName={userRegion?.name}
          relationshipOptions={relationshipOptions}
        />
      </Modal>

      <Modal open={showEdit} onClose={() => { setShowEdit(false); setEditingEmployee(null); }} title="Edit Employee" size="xl">
        {editingEmployee && (
          <EditEmployeeForm 
            employee={editingEmployee}
            onSubmit={updateEmployee} 
            onCancel={() => { setShowEdit(false); setEditingEmployee(null); }} 
            departments={departmentOptions} 
            regions={regions}
            isSuperAdmin={isSuperAdmin}
            relationshipOptions={relationshipOptions}
          />
        )}
      </Modal>
    </div>
  );
}

// ===== AddEmployeeForm =====
function AddEmployeeForm({
  onSubmit,
  onCancel,
  departments,
  regions,
  userRegionId,
  isSuperAdmin,
  userRegionName,
  relationshipOptions,
}: {
  onSubmit: (e: any) => void;
  onCancel: () => void;
  departments: string[];
  regions: any[];
  userRegionId?: string;
  isSuperAdmin?: boolean;
  userRegionName?: string;
  relationshipOptions: string[];
}) {
  const [form, setForm] = useState<any>({
    employeeNumber: "",
    fullName: "",
    dob: "",
    gender: "Male",
    nationalId: "",
    phone: "",
    address: "",
    position: "Security Guard",
    department: departments[0],
    qualification: "standard 8",
    dateHired: new Date().toISOString().slice(0, 10),
    basicSalary: 550000,
    contractType: "Permanent",
    status: "Active",
    email: "",
    region_id: userRegionId || "",
    assignment_type: "company",
    company: "",
    workstation: "",
    resident_name: "",
    resident_contact: "",
    pay_point: "",
    account_number: "",
    uniform_deduction: 10000,
    next_of_kin_name: "",
    next_of_kin_relationship: "",
    next_of_kin_phone: "",
    next_of_kin_address: "",
  });

  const [positions, setPositions] = useState<any[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showResidentFields, setShowResidentFields] = useState(false);
  const [companySuggestions, setCompanySuggestions] = useState<string[]>([]);
  const [showCompanySuggestions, setShowCompanySuggestions] = useState(false);
  const [residentSuggestions, setResidentSuggestions] = useState<string[]>([]);
  const [showResidentSuggestions, setShowResidentSuggestions] = useState(false);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  
  // ===== NEW: Loading state for submit button =====
  const [isSubmitting, setIsSubmitting] = useState(false);

  const update = (k: string, v: any) => {
    setForm((prev: any) => ({ ...prev, [k]: v }));
  };

  const formatNumberWithCommas = (value: number) => {
    return value.toLocaleString();
  };

  const handleSalaryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value.replace(/[^\d]/g, "");
    const numericValue = parseInt(rawValue) || 0;
    update("basicSalary", numericValue);
  };

  const handleUniformDeductionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value.replace(/[^\d]/g, "");
    const numericValue = parseInt(rawValue) || 0;
    update("uniform_deduction", numericValue);
  };

  // ===== FETCH COMPANY SUGGESTIONS =====
  const fetchCompanySuggestions = useCallback(async (input: string) => {
    if (!input || input.length < 2) {
      setCompanySuggestions([]);
      return;
    }
    
    setSuggestionLoading(true);
    try {
      const normalized = normalizeText(input);
      const { data } = await supabase
        .from('companies')
        .select('name, normalized_name')
        .ilike('normalized_name', `%${normalized}%`)
        .eq('type', 'company')
        .limit(5);
      
      setCompanySuggestions(data?.map(c => c.name) || []);
      setShowCompanySuggestions(true);
    } catch (err) {
      console.error('Error fetching company suggestions:', err);
    } finally {
      setSuggestionLoading(false);
    }
  }, []);

  // ===== FETCH RESIDENT SUGGESTIONS =====
  const fetchResidentSuggestions = useCallback(async (input: string) => {
    if (!input || input.length < 2) {
      setResidentSuggestions([]);
      return;
    }
    
    setSuggestionLoading(true);
    try {
      const normalized = normalizeText(input);
      const { data } = await supabase
        .from('employees')
        .select('resident_name')
        .eq('assignment_type', 'resident')
        .ilike('resident_name', `%${normalized}%`)
        .limit(5);
      
      const uniqueNames = [...new Set(data?.map(e => e.resident_name).filter(Boolean) || [])];
      setResidentSuggestions(uniqueNames);
      setShowResidentSuggestions(true);
    } catch (err) {
      console.error('Error fetching resident suggestions:', err);
    } finally {
      setSuggestionLoading(false);
    }
  }, []);

  // Handle assignment type change
  const handleAssignmentTypeChange = (type: string) => {
    update("assignment_type", type);
    setShowResidentFields(type === 'resident');
    if (type === 'company') {
      update("resident_name", "");
      update("resident_contact", "");
      setShowResidentSuggestions(false);
    } else {
      update("company", "");
      setShowCompanySuggestions(false);
    }
  };

  const generateEmployeeNumber = async (regionId: string) => {
    if (!regionId || isGenerating) return;

    setIsGenerating(true);
    try {
      const region = regions.find((r) => r.id === regionId);
      if (!region) return;

      // Region letter comes from the region's own `code` (set in Settings ->
      // Regions) if there is one, otherwise falls back to the first letter
      // of the region's name -- so "Northern Region" still gets "N" even if
      // nobody has set an explicit one-letter code yet.
      const regionLetter = (region.code?.trim() || region.name?.trim() || "X").charAt(0).toUpperCase();
      const prefix = `SFG-${regionLetter}-`;

      const { data } = await supabase
        .from("employees")
        .select("employee_number")
        .ilike("employee_number", `${prefix}%`)
        .order("employee_number", { ascending: false })
        .limit(1);

      let nextNumber = 1;
      if (data && data.length > 0) {
        const match = data[0].employee_number.match(/\d+$/);
        if (match) {
          const lastNumber = parseInt(match[0]);
          nextNumber = lastNumber + 1;
        }
      }

      const formattedNumber = `${prefix}${nextNumber.toString().padStart(3, "0")}`;
      setTimeout(() => {
        update("employeeNumber", formattedNumber);
      }, 10);
    } catch (err) {
      console.error("Error generating employee number:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const { data } = await supabase
          .from("positions")
          .select("name")
          .eq("is_active", true)
          .order("name");
        if (data && data.length > 0) {
          setPositions(data);
        } else {
          setPositions([
            { name: "Security Guard" },
            { name: "Senior Security Officer" },
            { name: "Supervisor" },
            { name: "Manager" },
            { name: "Staff" },
            { name: "HR" },
          ]);
        }
      } catch (err) {
        console.error("Error fetching positions:", err);
        setPositions([
          { name: "Security Guard" },
          { name: "Senior Security Officer" },
          { name: "Supervisor" },
          { name: "Manager" },
          { name: "Staff" },
          { name: "HR" },
        ]);
      }
    };
    fetchPositions();
  }, []);

  // ===== UPDATED SUBMIT FUNCTION =====
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Prevent multiple submissions
    if (isSubmitting) return;
    
    // Validation -- every field on this form is mandatory; validateEmployeeForm
    // returns the label of the first missing/invalid one so the notification
    // tells the admin exactly which box to fill in.
    const missingField = validateEmployeeForm(form, isSuperAdmin);
    if (missingField) {
      showNotification(`Please fill in: ${missingField}`, "error");
      return;
    }

    // Set submitting state
    setIsSubmitting(true);
    
    try {
      // Call the parent onSubmit
      await onSubmit(form);
    } catch (error) {
      console.error('Error submitting form:', error);
      showNotification("An error occurred while adding the employee", "error");
    } finally {
      // Reset submitting state after a delay to prevent rapid clicks
      setTimeout(() => {
        setIsSubmitting(false);
      }, 2000);
    }
  };

  // ===== FIELD HELPER =====
  const field = (
    k: string,
    label: string,
    type = "text",
    required = false,
    options?: { label: string; value: string }[],
    maxLength?: number,
  ) => {
    const fieldKey = `field-${k}`;

    return (
      <div key={fieldKey}>
        <label className="block text-sm font-medium text-slate-700 mb-1.5">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
        {options ? (
          <select
            value={form[k] || ""}
            onChange={(e) => update(k, e.target.value)}
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] bg-white"
            disabled={isSubmitting}
          >
            <option value="">Select {label}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : type === "salary" ? (
          <input
            type="text"
            value={formatNumberWithCommas(form[k] || 0)}
            onChange={handleSalaryChange}
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] text-right"
            required={required}
            disabled={isSubmitting}
          />
        ) : (
          <input
            type={type}
            value={form[k] || ""}
            onChange={(e) => update(k, e.target.value)}
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            required={required}
            maxLength={maxLength}
            disabled={isSubmitting}
          />
        )}
      </div>
    );
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="p-4 rounded-lg bg-[#E8EDF5] text-sm text-slate-700 flex items-start gap-3">
        <UserPlus size={18} className="text-[#081C3A] shrink-0 mt-0.5" />
        <div>
          <strong>Employment Form</strong>
          <br />
          Complete all required fields. Employee will be added to active records.
          {!isSuperAdmin && userRegionName && (
            <span className="block mt-1 text-xs text-[#D4A017]">
              Will be assigned to: {userRegionName}
            </span>
          )}
        </div>
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Personal Information</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Employee Number</label>
            <input
              type="text"
              value={form.employeeNumber}
              disabled
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-slate-50 font-mono"
            />
            <p className="text-xs text-slate-400 mt-1">Auto-generated after selecting region</p>
          </div>
          {field("fullName", "Full Name", "text", true)}
          {field("dob", "Date of Birth", "date", true)}
          {field("gender", "Gender", "text", true, [
            { label: "Male", value: "Male" },
            { label: "Female", value: "Female" },
          ])}
          {field("nationalId", "National ID", "text", true, undefined, 8)}
          {field("phone", "Phone Number", "tel", true, undefined, 10)}
        </div>
        <div className="mt-4">{field("address", "Residential Address", "text", true)}</div>
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Employment Information</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {field(
            "position",
            "Position",
            "text",
            true,
            positions.map((p) => ({ label: p.name, value: p.name })),
          )}
          {field(
            "department",
            "Department",
            "text",
            true,
            departments.map((d) => ({ label: d, value: d })),
          )}
          {field("qualification", "Qualification", "text", true)}
          {field("dateHired", "Date Hired", "date", true)}
          {field("contractType", "Contract Type", "text", true, [
            { label: "Permanent", value: "Permanent" },
            { label: "Contract", value: "Contract" },
            { label: "Part-time", value: "Part-time" },
          ])}
          {field("status", "Status", "text", false, [
            { label: "Active", value: "Active" },
            { label: "On Leave", value: "On Leave" },
            { label: "Suspended", value: "Suspended" },
          ])}
        </div>
      </div>

      {/* ===== COMPANY & LOCATION ===== */}
      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Company & Location</h4>
        <p className="text-xs text-slate-500 mb-3">Select the type of assignment and provide the details</p>
        
        {/* Assignment Type Toggle */}
        <div className="flex gap-3 mb-4">
          <button
            type="button"
            onClick={() => handleAssignmentTypeChange('company')}
            disabled={isSubmitting}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              form.assignment_type === 'company'
                ? 'bg-[#081C3A] text-white shadow-md'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            } ${isSubmitting ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <Building2 size={16} />
            Company
          </button>
          <button
            type="button"
            onClick={() => handleAssignmentTypeChange('resident')}
            disabled={isSubmitting}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              form.assignment_type === 'resident'
                ? 'bg-[#081C3A] text-white shadow-md'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            } ${isSubmitting ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <Home size={16} />
            Resident
          </button>
        </div>

        {/* Company Fields with Autocomplete */}
        {form.assignment_type === 'company' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Company Name <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={form.company || ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    update("company", val);
                    fetchCompanySuggestions(val);
                    setShowCompanySuggestions(true);
                  }}
                  onFocus={() => {
                    if (form.company && form.company.length >= 2) {
                      setShowCompanySuggestions(true);
                    }
                  }}
                  onBlur={() => {
                    setTimeout(() => setShowCompanySuggestions(false), 200);
                  }}
                  disabled={isSubmitting}
                  placeholder="Type company name... (e.g., MASM, AHL)"
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                />
                {showCompanySuggestions && companySuggestions.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                    {companySuggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => {
                          update("company", suggestion);
                          setShowCompanySuggestions(false);
                        }}
                        disabled={isSubmitting}
                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors text-sm flex items-center gap-2"
                      >
                        <Building2 size={14} className="text-slate-400" />
                        <span>{suggestion}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-1">
                <span className="text-emerald-600">✓</span> Auto-suggestions from existing companies
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Workstation / Site
              </label>
              <input
                type="text"
                value={form.workstation || ""}
                onChange={(e) => {
                  let val = e.target.value.toUpperCase().trim();
                  val = val.replace(/[^A-Z0-9\s]/g, "");
                  val = val.replace(/\s+/g, " ");
                  update("workstation", val);
                }}
                disabled={isSubmitting}
                placeholder="e.g., CLINIC, MAIN OFFICE, GATE 1"
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] uppercase"
              />
              <p className="text-xs text-slate-400 mt-1">Auto-formatted to UPPERCASE. No symbols allowed.</p>
            </div>
          </div>
        )}

        {/* Resident Fields with Autocomplete */}
        {form.assignment_type === 'resident' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Resident Name <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={form.resident_name || ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    update("resident_name", val);
                    fetchResidentSuggestions(val);
                    setShowResidentSuggestions(true);
                  }}
                  onFocus={() => {
                    if (form.resident_name && form.resident_name.length >= 2) {
                      setShowResidentSuggestions(true);
                    }
                  }}
                  onBlur={() => {
                    setTimeout(() => setShowResidentSuggestions(false), 200);
                  }}
                  disabled={isSubmitting}
                  placeholder="e.g., MR PHIRI, MRS KAMANGA"
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
                />
                {showResidentSuggestions && residentSuggestions.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                    {residentSuggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => {
                          update("resident_name", suggestion);
                          setShowResidentSuggestions(false);
                        }}
                        disabled={isSubmitting}
                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors text-sm flex items-center gap-2"
                      >
                        <Home size={14} className="text-slate-400" />
                        <span>{suggestion}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-1">
                <span className="text-emerald-600">✓</span> Auto-suggestions from existing residents
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Resident Contact
              </label>
              <input
                type="text"
                value={form.resident_contact || ""}
                onChange={(e) => {
                  let val = e.target.value.trim();
                  val = val.replace(/[^0-9+\s]/g, "");
                  update("resident_contact", val);
                }}
                disabled={isSubmitting}
                placeholder="e.g., 0888123456"
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
              <p className="text-xs text-slate-400 mt-1">Phone number for the resident (numbers only)</p>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Workstation / Site
              </label>
              <input
                type="text"
                value={form.workstation || ""}
                onChange={(e) => {
                  let val = e.target.value.toUpperCase().trim();
                  val = val.replace(/[^A-Z0-9\s]/g, "");
                  val = val.replace(/\s+/g, " ");
                  update("workstation", val);
                }}
                disabled={isSubmitting}
                placeholder="e.g., HOUSE NUMBER, AREA, LOCATION"
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] uppercase"
              />
              <p className="text-xs text-slate-400 mt-1">Auto-formatted to UPPERCASE. No symbols allowed.</p>
            </div>
          </div>
        )}
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Compensation & Payment</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Basic Salary (MK)</label>
            <input
              type="text"
              value={formatNumberWithCommas(form.basicSalary || 0)}
              onChange={handleSalaryChange}
              disabled={isSubmitting}
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] text-right"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Pay Point <span className="text-red-500">*</span></label>
            <select
              value={form.pay_point || ""}
              onChange={(e) => update("pay_point", e.target.value)}
              disabled={isSubmitting}
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] bg-white"
            >
              <option value="">Select Pay Point</option>
              <option value="national_bank">National Bank of Malawi</option>
              <option value="standard_bank">Standard Bank</option>
              <option value="nbs_bank">NBS Bank</option>
              <option value="centenary_bank">Centenary Bank</option>
              <option value="fdh_bank">FDH Bank</option>
              <option value="first_capital_bank">First Capital Bank</option>
              <option value="airtel_money">Airtel Money</option>
              <option value="tnm_mpamba">TNM Mpamba</option>
            </select>
          </div>
        </div>
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Uniform & Benefits</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Uniform Deduction (MK)
              <span className="text-xs text-slate-500 ml-2">(Default: 10,000)</span>
            </label>
            <input
              type="text"
              value={formatNumberWithCommas(form.uniform_deduction || 0)}
              onChange={handleUniformDeductionChange}
              disabled={isSubmitting}
              placeholder="10,000"
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] text-right"
            />
            <p className="text-xs text-slate-400 mt-1">This amount will be deducted from monthly income and refunded in terminal dues</p>
          </div>
          <div className="flex items-end">
            <div className="p-3 bg-amber-50 rounded-lg border border-amber-200 w-full">
              <p className="text-xs text-amber-700">
                <strong>Note:</strong> Uniform deduction is optional. Enter 0 if no deduction applies.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Next of Kin Section */}
      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Next of Kin</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Full Name <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={form.next_of_kin_name || ""}
              onChange={(e) => update("next_of_kin_name", e.target.value)}
              disabled={isSubmitting}
              placeholder="Enter next of kin full name"
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Relationship <span className="text-red-500">*</span></label>
            <select
              value={form.next_of_kin_relationship || ""}
              onChange={(e) => update("next_of_kin_relationship", e.target.value)}
              disabled={isSubmitting}
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] bg-white"
            >
              <option value="">Select Relationship</option>
              {relationshipOptions.map((rel) => (
                <option key={rel} value={rel}>
                  {rel}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Phone Number <span className="text-red-500">*</span></label>
            <input
              type="tel"
              value={form.next_of_kin_phone || ""}
              onChange={(e) => update("next_of_kin_phone", e.target.value)}
              disabled={isSubmitting}
              maxLength={10}
              placeholder="Enter next of kin phone number"
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Address <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={form.next_of_kin_address || ""}
              onChange={(e) => update("next_of_kin_address", e.target.value)}
              disabled={isSubmitting}
              placeholder="Enter next of kin address"
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>
        </div>
        <p className="text-xs text-slate-400 mt-2">
          <Heart size={12} className="inline mr-1 text-red-500" />
          Emergency contact information for the employee
        </p>
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Bank Account</h4>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Bank Account / Mobile Money Number <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={form.account_number || ""}
              onChange={(e) => update("account_number", e.target.value)}
              disabled={isSubmitting}
              placeholder="e.g., 5063532125021 or 0888123456"
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
            <p className="text-xs text-slate-400 mt-1">Bank account number for salary payments</p>
          </div>
        </div>
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Region</h4>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Region <span className="text-red-500">*</span>
            </label>
            {isSuperAdmin ? (
              <select
                value={form.region_id || ""}
                onChange={(e) => {
                  const selectedId = e.target.value;
                  setForm((prev: any) => ({ ...prev, region_id: selectedId }));
                  if (selectedId) {
                    generateEmployeeNumber(selectedId);
                  } else {
                    setForm((prev: any) => ({ ...prev, employeeNumber: "" }));
                  }
                }}
                disabled={isSubmitting}
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] bg-white"
              >
                <option value="">-- Please select a region --</option>
                {regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={userRegionName || ""}
                disabled
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-slate-50"
              />
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
        <button 
          type="button" 
          onClick={onCancel} 
          disabled={isSubmitting}
          className="px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button 
          type="submit" 
          disabled={isSubmitting}
          className={`px-5 py-2 rounded-lg bg-[#D4A017] text-white text-sm font-semibold hover:bg-[#e8b82e] transition-all flex items-center gap-2 ${
            isSubmitting ? 'opacity-70 cursor-not-allowed' : ''
          }`}
        >
          {isSubmitting ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Adding Employee...
            </>
          ) : (
            <>
              <UserPlus size={16} />
              Hire Employee
            </>
          )}
        </button>
      </div>
    </form>
  );
}

// ===== EditEmployeeForm =====
function EditEmployeeForm({ employee, onSubmit, onCancel, departments, regions, isSuperAdmin, relationshipOptions }: { 
  employee: Employee;
  onSubmit: (e: any) => void; 
  onCancel: () => void; 
  departments: string[]; 
  regions: any[];
  isSuperAdmin?: boolean;
  relationshipOptions: string[];
}) {
  const [form, setForm] = useState<any>({
    employeeNumber: employee.employeeNumber,
    fullName: employee.fullName,
    dob: employee.dob || '',
    gender: employee.gender || 'Male',
    nationalId: employee.nationalId || '',
    phone: employee.phone || '',
    address: employee.address || '',
    position: employee.position,
    department: employee.department,
    qualification: employee.qualification || '',
    dateHired: employee.dateHired,
    basicSalary: employee.basicSalary,
    contractType: employee.contractType || 'Permanent',
    status: employee.status,
    email: employee.email || '',
    region_id: employee.region_id || '',
    assignment_type: employee.assignment_type || 'company',
    company: employee.company || '',
    workstation: employee.workstation || '',
    resident_name: employee.resident_name || '',
    resident_contact: employee.resident_contact || '',
    pay_point: employee.pay_point || '',
    account_number: employee.account_number || '',
    uniform_deduction: employee.uniform_deduction || 0,
    next_of_kin_name: employee.next_of_kin_name || '',
    next_of_kin_relationship: employee.next_of_kin_relationship || '',
    next_of_kin_phone: employee.next_of_kin_phone || '',
    next_of_kin_address: employee.next_of_kin_address || '',
  });
  
  const [positions, setPositions] = useState<any[]>([]);
  const [showResidentFields, setShowResidentFields] = useState(form.assignment_type === 'resident');
  const [companySuggestions, setCompanySuggestions] = useState<string[]>([]);
  const [showCompanySuggestions, setShowCompanySuggestions] = useState(false);
  const [residentSuggestions, setResidentSuggestions] = useState<string[]>([]);
  const [showResidentSuggestions, setShowResidentSuggestions] = useState(false);
  
  // ===== NEW: Loading state for edit submit button =====
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const update = (k: string, v: any) => {
    setForm({ ...form, [k]: v });
  };

  const formatNumberWithCommas = (value: string) => {
    const cleanValue = value.replace(/[^\d]/g, '');
    if (!cleanValue) return '0';
    return parseInt(cleanValue).toLocaleString();
  };

  const handleSalaryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value.replace(/[^\d]/g, '');
    const numericValue = parseInt(rawValue) || 0;
    update('basicSalary', numericValue);
  };

  const handleUniformDeductionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value.replace(/[^\d]/g, '');
    const numericValue = parseInt(rawValue) || 0;
    update('uniform_deduction', numericValue);
  };

  const handleAssignmentTypeChange = (type: string) => {
    update("assignment_type", type);
    setShowResidentFields(type === 'resident');
    if (type === 'company') {
      update("resident_name", "");
      update("resident_contact", "");
      setShowResidentSuggestions(false);
    } else {
      update("company", "");
      setShowCompanySuggestions(false);
    }
  };

  // ===== FETCH COMPANY SUGGESTIONS =====
  const fetchCompanySuggestionsEdit = useCallback(async (input: string) => {
    if (!input || input.length < 2) {
      setCompanySuggestions([]);
      return;
    }
    
    try {
      const normalized = normalizeText(input);
      const { data } = await supabase
        .from('companies')
        .select('name, normalized_name')
        .ilike('normalized_name', `%${normalized}%`)
        .eq('type', 'company')
        .limit(5);
      
      setCompanySuggestions(data?.map(c => c.name) || []);
      setShowCompanySuggestions(true);
    } catch (err) {
      console.error('Error fetching company suggestions:', err);
    }
  }, []);

  // ===== FETCH RESIDENT SUGGESTIONS =====
  const fetchResidentSuggestionsEdit = useCallback(async (input: string) => {
    if (!input || input.length < 2) {
      setResidentSuggestions([]);
      return;
    }
    
    try {
      const normalized = normalizeText(input);
      const { data } = await supabase
        .from('employees')
        .select('resident_name')
        .eq('assignment_type', 'resident')
        .ilike('resident_name', `%${normalized}%`)
        .limit(5);
      
      const uniqueNames = [...new Set(data?.map(e => e.resident_name).filter(Boolean) || [])];
      setResidentSuggestions(uniqueNames);
      setShowResidentSuggestions(true);
    } catch (err) {
      console.error('Error fetching resident suggestions:', err);
    }
  }, []);

  useEffect(() => {
    const fetchPositions = async () => {
      const { data } = await supabase
        .from('positions')
        .select('name')
        .eq('is_active', true)
        .order('name');
      setPositions(data || []);
    };
    fetchPositions();
  }, []);

  // ===== UPDATED SUBMIT FUNCTION =====
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Prevent multiple submissions
    if (isSubmitting) return;
    
    // Validation -- every field on this form is mandatory; validateEmployeeForm
    // returns the label of the first missing/invalid one so the notification
    // tells the admin exactly which box to fill in.
    const missingField = validateEmployeeForm(form, isSuperAdmin);
    if (missingField) {
      showNotification(`Please fill in: ${missingField}`, 'error');
      return;
    }

    // Set submitting state
    setIsSubmitting(true);

    try {
      // Call the parent onSubmit
      await onSubmit(form);
    } catch (error) {
      console.error('Error submitting form:', error);
      showNotification('An error occurred while updating the employee', 'error');
    } finally {
      // Reset submitting state after a delay
      setTimeout(() => {
        setIsSubmitting(false);
      }, 2000);
    }
  };

  // ===== FIELD HELPER =====
  const field = (k: string, label: string, type = 'text', required = false, options?: { label: string; value: string }[], maxLength?: number) => {
    const fieldId = `edit-field-${k}`;

    return (
      <div key={fieldId}>
        <label className="block text-sm font-medium text-slate-700 mb-1.5">{label}{required && <span className="text-red-500 ml-1">*</span>}</label>
        {options ? (
          <select
            value={form[k] || ''}
            onChange={e => update(k, e.target.value)}
            disabled={isSubmitting}
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] bg-white disabled:opacity-50"
          >
            <option value="">Select {label}</option>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <input
            type={type}
            value={form[k] || ''}
            onChange={e => update(k, e.target.value)}
            disabled={isSubmitting}
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] disabled:opacity-50"
            required={required}
            maxLength={maxLength}
          />
        )}
      </div>
    );
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="p-4 rounded-lg bg-[#E8EDF5] text-sm text-slate-700 flex items-start gap-3">
        <UserPlus size={18} className="text-[#081C3A] shrink-0 mt-0.5" />
        <div>
          <strong>Edit Employee</strong><br />
          Update employee information below.
        </div>
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Personal Information</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Employee Number</label>
            <input 
              type="text" 
              value={form.employeeNumber || ''} 
              disabled
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-slate-50 font-mono"
            />
          </div>
          {field('fullName', 'Full Name', 'text', true)}
          {field('dob', 'Date of Birth', 'date', true)}
          {field('gender', 'Gender', 'text', true, [
            { label: 'Male', value: 'Male' }, { label: 'Female', value: 'Female' }
          ])}
          {field('nationalId', 'National ID', 'text', true, undefined, 8)}
          {field('phone', 'Phone Number', 'tel', true, undefined, 10)}
        </div>
        <div className="mt-4">{field('address', 'Residential Address', 'text', true)}</div>
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Employment Information</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {field('position', 'Position', 'text', true, positions.map(p => ({ label: p.name, value: p.name })))}
          {field('department', 'Department', 'text', true, departments.map(d => ({ label: d, value: d })))}
          {field('qualification', 'Qualification', 'text', true)}
          {field('dateHired', 'Date Hired', 'date', true)}
          {field('contractType', 'Contract Type', 'text', true, [
            { label: 'Permanent', value: 'Permanent' }, 
            { label: 'Contract', value: 'Contract' }, 
            { label: 'Part-time', value: 'Part-time' }
          ])}
          {field('status', 'Status', 'text', false, [
            { label: 'Active', value: 'Active' }, 
            { label: 'On Leave', value: 'On Leave' }, 
            { label: 'Suspended', value: 'Suspended' }
          ])}
        </div>
      </div>

      {/* ===== COMPANY & LOCATION ===== */}
      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Company & Location</h4>
        <p className="text-xs text-slate-500 mb-3">Select the type of assignment and provide the details</p>
        
        {/* Assignment Type Toggle */}
        <div className="flex gap-3 mb-4">
          <button
            type="button"
            onClick={() => handleAssignmentTypeChange('company')}
            disabled={isSubmitting}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              form.assignment_type === 'company'
                ? 'bg-[#081C3A] text-white shadow-md'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            } ${isSubmitting ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <Building2 size={16} />
            Company
          </button>
          <button
            type="button"
            onClick={() => handleAssignmentTypeChange('resident')}
            disabled={isSubmitting}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              form.assignment_type === 'resident'
                ? 'bg-[#081C3A] text-white shadow-md'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            } ${isSubmitting ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <Home size={16} />
            Resident
          </button>
        </div>

        {/* Company Fields with Autocomplete */}
        {form.assignment_type === 'company' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Company Name <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={form.company || ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    update("company", val);
                    fetchCompanySuggestionsEdit(val);
                    setShowCompanySuggestions(true);
                  }}
                  onFocus={() => {
                    if (form.company && form.company.length >= 2) {
                      setShowCompanySuggestions(true);
                    }
                  }}
                  onBlur={() => {
                    setTimeout(() => setShowCompanySuggestions(false), 200);
                  }}
                  disabled={isSubmitting}
                  placeholder="Type company name... (e.g., MASM, AHL)"
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] disabled:opacity-50"
                />
                {showCompanySuggestions && companySuggestions.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                    {companySuggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => {
                          update("company", suggestion);
                          setShowCompanySuggestions(false);
                        }}
                        disabled={isSubmitting}
                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors text-sm flex items-center gap-2"
                      >
                        <Building2 size={14} className="text-slate-400" />
                        <span>{suggestion}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-1">
                <span className="text-emerald-600">✓</span> Auto-suggestions from existing companies
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Workstation / Site
              </label>
              <input
                type="text"
                value={form.workstation || ""}
                onChange={(e) => {
                  let val = e.target.value.toUpperCase().trim();
                  val = val.replace(/[^A-Z0-9\s]/g, "");
                  val = val.replace(/\s+/g, " ");
                  update("workstation", val);
                }}
                disabled={isSubmitting}
                placeholder="e.g., CLINIC, MAIN OFFICE, GATE 1"
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] uppercase disabled:opacity-50"
              />
              <p className="text-xs text-slate-400 mt-1">Auto-formatted to UPPERCASE. No symbols allowed.</p>
            </div>
          </div>
        )}

        {/* Resident Fields with Autocomplete */}
        {form.assignment_type === 'resident' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Resident Name <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={form.resident_name || ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    update("resident_name", val);
                    fetchResidentSuggestionsEdit(val);
                    setShowResidentSuggestions(true);
                  }}
                  onFocus={() => {
                    if (form.resident_name && form.resident_name.length >= 2) {
                      setShowResidentSuggestions(true);
                    }
                  }}
                  onBlur={() => {
                    setTimeout(() => setShowResidentSuggestions(false), 200);
                  }}
                  disabled={isSubmitting}
                  placeholder="e.g., MR PHIRI, MRS KAMANGA"
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] disabled:opacity-50"
                />
                {showResidentSuggestions && residentSuggestions.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                    {residentSuggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => {
                          update("resident_name", suggestion);
                          setShowResidentSuggestions(false);
                        }}
                        disabled={isSubmitting}
                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors text-sm flex items-center gap-2"
                      >
                        <Home size={14} className="text-slate-400" />
                        <span>{suggestion}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-1">
                <span className="text-emerald-600">✓</span> Auto-suggestions from existing residents
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Resident Contact
              </label>
              <input
                type="text"
                value={form.resident_contact || ""}
                onChange={(e) => {
                  let val = e.target.value.trim();
                  val = val.replace(/[^0-9+\s]/g, "");
                  update("resident_contact", val);
                }}
                disabled={isSubmitting}
                placeholder="e.g., 0888123456"
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] disabled:opacity-50"
              />
              <p className="text-xs text-slate-400 mt-1">Phone number for the resident (numbers only)</p>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Workstation / Site
              </label>
              <input
                type="text"
                value={form.workstation || ""}
                onChange={(e) => {
                  let val = e.target.value.toUpperCase().trim();
                  val = val.replace(/[^A-Z0-9\s]/g, "");
                  val = val.replace(/\s+/g, " ");
                  update("workstation", val);
                }}
                disabled={isSubmitting}
                placeholder="e.g., HOUSE NUMBER, AREA, LOCATION"
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] uppercase disabled:opacity-50"
              />
              <p className="text-xs text-slate-400 mt-1">Auto-formatted to UPPERCASE. No symbols allowed.</p>
            </div>
          </div>
        )}
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Compensation & Payment</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Basic Salary (MK)</label>
            <input 
              type="text" 
              value={formatNumberWithCommas(String(form.basicSalary || '0'))} 
              onChange={handleSalaryChange}
              disabled={isSubmitting}
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] text-right disabled:opacity-50" 
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Pay Point <span className="text-red-500">*</span></label>
            <select
              value={form.pay_point || ''}
              onChange={e => update('pay_point', e.target.value)} 
              disabled={isSubmitting}
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] bg-white disabled:opacity-50"
            >
              <option value="">Select Pay Point</option>
              <option value="national_bank">National Bank of Malawi</option>
              <option value="standard_bank">Standard Bank</option>
              <option value="nbs_bank">NBS Bank</option>
              <option value="centenary_bank">Centenary Bank</option>
              <option value="fdh_bank">FDH Bank</option>
              <option value="first_capital_bank">First Capital Bank</option>
              <option value="airtel_money">Airtel Money</option>
              <option value="tnm_mpamba">TNM Mpamba</option>
            </select>
          </div>
        </div>
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Uniform & Benefits</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Uniform Deduction (MK)
              <span className="text-xs text-slate-500 ml-2">(Default: 10,000)</span>
            </label>
            <input
              type="text"
              value={formatNumberWithCommas(String(form.uniform_deduction || '0'))}
              onChange={handleUniformDeductionChange}
              disabled={isSubmitting}
              placeholder="10,000"
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] text-right disabled:opacity-50"
            />
            <p className="text-xs text-slate-400 mt-1">This amount will be deducted from monthly income and refunded in terminal dues</p>
          </div>
          <div className="flex items-end">
            <div className="p-3 bg-amber-50 rounded-lg border border-amber-200 w-full">
              <p className="text-xs text-amber-700">
                <strong>Note:</strong> Uniform deduction is optional. Enter 0 if no deduction applies.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Next of Kin Section */}
      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Next of Kin</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Full Name <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={form.next_of_kin_name || ""}
              onChange={(e) => update("next_of_kin_name", e.target.value)}
              disabled={isSubmitting}
              placeholder="Enter next of kin full name"
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Relationship <span className="text-red-500">*</span></label>
            <select
              value={form.next_of_kin_relationship || ""}
              onChange={(e) => update("next_of_kin_relationship", e.target.value)}
              disabled={isSubmitting}
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] bg-white disabled:opacity-50"
            >
              <option value="">Select Relationship</option>
              {relationshipOptions.map((rel) => (
                <option key={rel} value={rel}>
                  {rel}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Phone Number <span className="text-red-500">*</span></label>
            <input
              type="tel"
              value={form.next_of_kin_phone || ""}
              onChange={(e) => update("next_of_kin_phone", e.target.value)}
              disabled={isSubmitting}
              maxLength={10}
              placeholder="Enter next of kin phone number"
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Address <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={form.next_of_kin_address || ""}
              onChange={(e) => update("next_of_kin_address", e.target.value)}
              disabled={isSubmitting}
              placeholder="Enter next of kin address"
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] disabled:opacity-50"
            />
          </div>
        </div>
        <p className="text-xs text-slate-400 mt-2">
          <Heart size={12} className="inline mr-1 text-red-500" />
          Emergency contact information for the employee
        </p>
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Bank Account</h4>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Bank Account / Mobile Money Number <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={form.account_number || ''}
              onChange={e => update('account_number', e.target.value)}
              disabled={isSubmitting}
              placeholder="e.g., 5063532125021 or 0888123456"
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] disabled:opacity-50" 
            />
            <p className="text-xs text-slate-400 mt-1">Bank account number for salary payments</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
        <button 
          type="button" 
          onClick={onCancel} 
          disabled={isSubmitting}
          className="px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button 
          type="submit" 
          disabled={isSubmitting}
          className={`px-5 py-2 rounded-lg bg-[#D4A017] text-white text-sm font-semibold hover:bg-[#e8b82e] transition-all flex items-center gap-2 ${
            isSubmitting ? 'opacity-70 cursor-not-allowed' : ''
          }`}
        >
          {isSubmitting ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Updating...
            </>
          ) : (
            <>
              <UserPlus size={16} />
              Update Employee
            </>
          )}
        </button>
      </div>
    </form>
  );
}

// ===== EmployeeProfile =====
function EmployeeProfile({ employee, onBack }: { employee: Employee; onBack: () => void }) {
  const [tab, setTab] = useState('profile');
  
  const tabs = [
    { id: 'profile', label: 'Overview' }, { id: 'payroll', label: 'Payroll' },
    { id: 'attendance', label: 'Attendance' }, { id: 'documents', label: 'Documents' }
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <button onClick={onBack} className="text-sm text-slate-600 hover:text-[#081C3A] flex items-center gap-2">← Back to Employees</button>

      <Card className="p-6 bg-gradient-to-br from-[#081C3A] to-[#1a2f5c] text-white border-0">
        <div className="flex flex-col md:flex-row gap-6 items-start">
          <div className="w-24 h-24 rounded-2xl bg-[#D4A017] flex items-center justify-center text-white text-3xl font-bold shadow-xl shrink-0">
            {employee.fullName.split(' ').map(n => n[0]).join('').slice(0, 2)}
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <h2 className="text-2xl font-bold">{employee.fullName}</h2>
              {employee.is_deleted ? (
                <Badge color="red">🗑️ Deleted</Badge>
              ) : (
                <Badge color={employee.status === 'Active' ? 'green' : 'yellow'}>{employee.status}</Badge>
              )}
              <Badge color="gold">{employee.contractType || 'Permanent'}</Badge>
            </div>
            <p className="text-white/70 mb-4">{employee.position} · {employee.department} · {employee.employeeNumber}</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div><p className="text-xs text-white/60">Phone</p><p className="text-sm">{employee.phone || '-'}</p></div>
              <div><p className="text-xs text-white/60">Email</p><p className="text-sm truncate">{employee.email || '-'}</p></div>
              <div><p className="text-xs text-white/60">Account</p><p className="text-sm font-mono text-xs">{employee.account_number || '-'}</p></div>
              <div><p className="text-xs text-white/60">Basic Salary</p><p className="text-sm font-semibold">{formatKwacha(employee.basicSalary)}</p></div>
            </div>
          </div>
        </div>
      </Card>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'profile' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-6">
            <h3 className="font-semibold text-slate-800 mb-4">Personal Information</h3>
            <div className="space-y-3 text-sm">
              {[
                ['Full Name', employee.fullName], ['Gender', employee.gender], ['Age', String(employee.age)],
                ['Date of Birth', employee.dob || '-'], ['National ID', employee.nationalId || '-'], ['Phone', employee.phone || '-'],
                ['Address', employee.address || '-'], ['Email', employee.email || '-']
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-slate-100 pb-2">
                  <span className="text-slate-500">{k}</span><span className="font-medium text-slate-800">{v}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6">
            <h3 className="font-semibold text-slate-800 mb-4">Employment Information</h3>
            <div className="space-y-3 text-sm">
              {[
                ['Position', employee.position], ['Department', employee.department], ['Qualification', employee.qualification || '-'],
                ['Date Hired', employee.dateHired], ['Contract Type', employee.contractType || 'Permanent'],
                ['Assignment Type', employee.assignment_type === 'resident' ? 'Resident' : 'Company'],
                ['Company/Resident', employee.assignment_type === 'resident' ? employee.resident_name || '-' : employee.company || '-'],
                ['Resident Contact', employee.resident_contact || '-'],
                ['Workstation', employee.workstation || '-'],
                ['Pay Point', employee.pay_point || '-'], ['Bank Account', employee.account_number || '-'],
                ['Uniform Deduction', formatKwacha(employee.uniform_deduction || 0)],
                ['Next of Kin', employee.next_of_kin_name || 'Not provided'],
                ['Relationship', employee.next_of_kin_relationship || 'Not provided'],
                ['NOK Phone', employee.next_of_kin_phone || 'Not provided'],
                ['NOK Address', employee.next_of_kin_address || 'Not provided'],
                ['Status', employee.status]
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-slate-100 pb-2">
                  <span className="text-slate-500">{k}</span><span className="font-medium text-slate-800">{v}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6">
            <h3 className="font-semibold text-slate-800 mb-4">Payroll Information</h3>
            <div className="space-y-3 text-sm">
              {[
                ['Basic Salary', formatKwacha(employee.basicSalary)],
                ['Uniform Deduction', formatKwacha(employee.uniform_deduction || 0)],
                ['Allowances (10%)', formatKwacha(Math.round(employee.basicSalary * 0.1))],
                ['Overtime (5%)', formatKwacha(Math.round(employee.basicSalary * 0.05))],
                ['Gross Pay', formatKwacha(Math.round(employee.basicSalary * 1.15))],
                ['PAYE (30%)', formatKwacha(Math.round(employee.basicSalary * 1.15 * 0.3))],
                ['Pension (5%)', formatKwacha(Math.round(employee.basicSalary * 1.15 * 0.05))],
                ['Net Pay (before uniform)', formatKwacha(Math.round(employee.basicSalary * 1.15 * 0.65))],
                ['Net Pay (after uniform)', formatKwacha(Math.round(employee.basicSalary * 1.15 * 0.65 - (employee.uniform_deduction || 0)))]
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-slate-100 pb-2">
                  <span className="text-slate-500">{k}</span><span className="font-medium text-slate-800">{v}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab === 'payroll' && (
        <Card className="p-6">
          <h3 className="font-semibold text-slate-800 mb-4">Payroll History</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {['July 2025', 'August 2025', 'September 2025', 'October 2025', 'November 2025'].map(period => (
              <div key={period} className="p-4 rounded-lg border border-slate-100 hover:border-[#081C3A] transition-colors">
                <p className="text-xs text-slate-500">{period}</p>
                <p className="text-lg font-bold text-slate-800 mt-1">{formatKwacha(Math.round(employee.basicSalary * 1.15 * 0.65 - (employee.uniform_deduction || 0)))}</p>
                <p className="text-xs text-slate-500 mt-1">Net Pay (after uniform)</p>
                <Button variant="outline" className="mt-3 text-xs w-full py-1.5">View Payslip</Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === 'attendance' && (
        <Card className="p-6">
          <h3 className="font-semibold text-slate-800 mb-4">Recent Attendance — November 2025</h3>
          <div className="grid grid-cols-7 md:grid-cols-15 gap-1.5">
            {Array.from({ length: 30 }, (_, i) => {
              const r = (i * 17) % 10;
              let s = 'P', c = 'bg-emerald-500';
              if (r > 8) { s = 'A'; c = 'bg-red-400'; }
              else if (r > 7) { s = 'L'; c = 'bg-yellow-400'; }
              else if (r > 6) { s = 'LV'; c = 'bg-blue-400'; }
              return (
                <div key={i} className="flex flex-col items-center">
                  <div className={`w-full aspect-square rounded flex items-center justify-center text-white text-xs font-semibold ${c}`}>{s}</div>
                  <span className="text-[10px] text-slate-500 mt-1">{i + 1}</span>
                </div>
              );
            })}
          </div>
          <div className="flex gap-4 mt-6 text-xs flex-wrap">
            <span className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-emerald-500" /> Present</span>
            <span className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-red-400" /> Absent</span>
            <span className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-yellow-400" /> Late</span>
            <span className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-blue-400" /> Leave</span>
          </div>
        </Card>
      )}

      {tab === 'documents' && (
        <Card className="p-6">
          <h3 className="font-semibold text-slate-800 mb-4">Employee Documents</h3>
          <div className="space-y-2">
            {['Contract Agreement.pdf', 'Certified ID Copy.pdf', 'Qualification Certificate.pdf', 'Security License.pdf', 'Medical Report.pdf'].map((f, i) => (
              <div key={i} className="flex items-center justify-between p-3 rounded-lg hover:bg-slate-50 border border-slate-100">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded bg-red-50 text-red-600 flex items-center justify-center font-bold text-xs">PDF</div>
                  <span className="text-sm text-slate-800">{f}</span>
                </div>
                <Button variant="outline" className="text-xs py-1.5">Download</Button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

export default EmployeesPage;