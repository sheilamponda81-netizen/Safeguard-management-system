import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Search, Plus, Eye, Edit2, Trash2, Filter, Download, UserPlus, Heart, Archive, RotateCcw, Calendar, AlertCircle, Building2, Home, Loader2 } from 'lucide-react';
import { Card, Button, Badge, THead, TBody, TR, TH, TD, Modal, PageHeader, Tabs } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { canAccess, canActOnRegion, canChooseAnyRegion as resolveCanChooseAnyRegion, PERMISSIONS } from '../utils/permissions';
import { showNotification } from '../utils/clickHandlers';
import { sanitizeInput } from '../utils/securityHeaders';
import { logAudit } from '../utils/auditLogger';
import { getEmployeeAuditData, getChanges } from '../utils/auditHelpers';
import { Pagination } from '../components/Pagination';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { getDefaultPageSize } from '../utils/uiSettings';
import { toCsvRow } from '../utils/csvExport';
import { generateEmployeeNumberServerSide, shouldGenerateEmployeeNumber } from '../utils/employeeNumberGeneration';
import { UserProfile, UserProfileRegion } from '../utils/currentProfile';
import { getErrorMessage } from '../utils/errorHandler';
import { checkEmployeeIdentifierConflicts, formatIdentifierConflictMessage, identifierColumnFromUniqueViolation } from '../utils/employeeConflicts';
import { validateEmployeeForm, resolveEmployeeFormRegionId, resolveEmployeeUpdateRegionId } from '../utils/employeeFormValidation';
import { fetchAllPages } from '../utils/employeeBatchFetch';

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
  dob?: string | null;
  nationalId?: string | null;
  address?: string | null;
  qualification?: string | null;
  contractType?: string | null;
  payPoint?: string | null;
  region_id?: string | null;
  company?: string | null;
  workstation?: string | null;
  pay_point?: string | null;
  account_number?: string | null;
  uniform_deduction?: number;
  next_of_kin_name?: string;
  next_of_kin_relationship?: string;
  next_of_kin_phone?: string;
  next_of_kin_address?: string;
  is_deleted?: boolean;
  deleted_at?: string | null;
  deleted_reason?: string | null;
  deleted_by?: string | null;
  deleted_by_name?: string;
  created_at?: string | null;
  assignment_type?: string;
  resident_name?: string;
  resident_contact?: string;
  company_id?: string | null;
}

// Shape of AddEmployeeForm/EditEmployeeForm's own form state -- every field
// is always initialized (see each form's useState below), so unlike
// `Employee` (which models a persisted row, where several fields are
// legitimately optional) none of these are optional here.
interface EmployeeFormData {
  employeeNumber: string;
  fullName: string;
  dob: string;
  gender: string;
  nationalId: string;
  phone: string;
  address: string;
  position: string;
  department: string;
  qualification: string;
  dateHired: string;
  basicSalary: number;
  contractType: string;
  status: string;
  email: string;
  region_id: string;
  assignment_type: string;
  company: string;
  workstation: string;
  resident_name: string;
  resident_contact: string;
  pay_point: string;
  account_number: string;
  uniform_deduction: number;
  next_of_kin_name: string;
  next_of_kin_relationship: string;
  next_of_kin_phone: string;
  next_of_kin_address: string;
}

// Raw `employees` row shape -- only the columns this file actually reads
// (query below is `select('*')`). No generated Supabase types exist in
// this project yet (see AUDIT_REPORT.md's "Supabase generated types"
// section).
interface EmployeeRow {
  id: string;
  employee_number: string;
  full_name: string;
  gender: string | null;
  age: number | null;
  phone: string | null;
  position: string;
  department: string | null;
  basic_salary: number;
  status: string | null;
  email: string | null;
  hire_date: string | null;
  dob: string | null;
  national_id: string | null;
  address: string | null;
  qualification: string | null;
  contract_type: string | null;
  pay_point: string | null;
  region_id: string | null;
  company: string | null;
  workstation: string | null;
  account_number: string | null;
  uniform_deduction: number | null;
  next_of_kin_name: string | null;
  next_of_kin_relationship: string | null;
  next_of_kin_phone: string | null;
  next_of_kin_address: string | null;
  is_deleted: boolean | null;
  deleted_at: string | null;
  deleted_reason: string | null;
  deleted_by: string | null;
  created_at: string | null;
  assignment_type: string | null;
  resident_name: string | null;
  resident_contact: string | null;
  company_id: string | null;
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

// ===== Explicit Day / Month / Year date picker =====
// Native <input type="date"> displays its segment order (DD/MM/YYYY vs
// MM/DD/YYYY) according to the browser/OS locale -- invisible to us and
// inconsistent across devices, so an admin expecting DD/MM/YYYY can end up
// typing what they mean as the day into a segment the browser treats as the
// month, producing an out-of-range value like "20" where a month belongs.
// Three explicit Day/Month/Year selects remove the ambiguity entirely: the
// month is always chosen by name, so it can never be misread as a day.
const DATE_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const parseISODateParts = (iso?: string) => {
  if (!iso) return { day: '', month: '', year: '' };
  const [year, month, day] = iso.split('-');
  return { day: day || '', month: month || '', year: year || '' };
};

const daysInMonth = (month: string, year: string): number => {
  if (!month) return 31;
  const y = year ? parseInt(year, 10) : new Date().getFullYear();
  return new Date(y, parseInt(month, 10), 0).getDate();
};

function DateFieldDMY({ value, onChange, required, disabled }: {
  value: string;
  onChange: (isoDate: string) => void;
  required?: boolean;
  disabled?: boolean;
}) {
  // Day/Month/Year are tracked locally rather than derived purely from
  // `value`: picking just one of the three (e.g. Month, before Day/Year are
  // also set) doesn't compose into a complete ISO date yet, so onChange gets
  // called with '' -- if that '' round-tripped straight back into `value`
  // and this component re-derived its parts from it, the just-picked Month
  // would immediately reset back to blank on the very next render, making
  // every dropdown appear to do nothing until all three happened to be
  // filled in a single render pass. Local state lets a partial pick stay
  // visible while the other two are still being chosen.
  const initial = parseISODateParts(value);
  const [day, setDay] = useState(initial.day);
  const [month, setMonth] = useState(initial.month);
  const [year, setYear] = useState(initial.year);

  // Re-sync if `value` changes from outside this component (e.g. a fresh
  // employee is loaded into the Edit form, or the Add form is reset).
  useEffect(() => {
    const parts = parseISODateParts(value);
    setDay(parts.day);
    setMonth(parts.month);
    setYear(parts.year);
  }, [value]);

  const dayOptions = Array.from({ length: daysInMonth(month, year) }, (_, i) => String(i + 1).padStart(2, '0'));
  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 90 }, (_, i) => String(currentYear - i));

  const emit = (nextDay: string, nextMonth: string, nextYear: string) => {
    setDay(nextDay);
    setMonth(nextMonth);
    setYear(nextYear);
    onChange(nextDay && nextMonth && nextYear ? `${nextYear}-${nextMonth}-${nextDay}` : '');
  };

  const selectClass = "px-2 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] bg-white disabled:opacity-50";

  return (
    <div className="grid grid-cols-3 gap-2">
      <select aria-label="Day" value={day} onChange={(e) => emit(e.target.value, month, year)} required={required} disabled={disabled} className={selectClass}>
        <option value="">Day</option>
        {dayOptions.map(d => <option key={d} value={d}>{d}</option>)}
      </select>
      <select
        aria-label="Month"
        value={month}
        onChange={(e) => {
          const nextMonth = e.target.value;
          const maxDay = daysInMonth(nextMonth, year);
          const clampedDay = day && parseInt(day, 10) > maxDay ? String(maxDay).padStart(2, '0') : day;
          emit(clampedDay, nextMonth, year);
        }}
        required={required}
        disabled={disabled}
        className={selectClass}
      >
        <option value="">Month</option>
        {DATE_MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
      </select>
      <select
        aria-label="Year"
        value={year}
        onChange={(e) => {
          const nextYear = e.target.value;
          const maxDay = daysInMonth(month, nextYear);
          const clampedDay = day && parseInt(day, 10) > maxDay ? String(maxDay).padStart(2, '0') : day;
          emit(clampedDay, month, nextYear);
        }}
        required={required}
        disabled={disabled}
        className={selectClass}
      >
        <option value="">Year</option>
        {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  );
}

// Shared Add/Edit employee form validation -- extracted to
// src/utils/employeeFormValidation.ts (HOTFIX, STAGING blocker 2) so it's
// unit-testable without importing this whole page component; see that
// file for the full behavior/history comment.

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
  const [regions, setRegions] = useState<UserProfileRegion[]>([]);
  const [filterRegionId, setFilterRegionId] = useState<string>('');
  const [filterCompany, setFilterCompany] = useState<string>('');
  const [filterWorkstation, setFilterWorkstation] = useState<string>('');
  const [filterPayPoint, setFilterPayPoint] = useState<string>('');
  // Debounced so typing doesn't refetch the whole employees table per keystroke.
  const debouncedFilterCompany = useDebouncedValue(filterCompany, 300);
  const debouncedFilterWorkstation = useDebouncedValue(filterWorkstation, 300);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [userLoading, setUserLoading] = useState(true);
  // Permission-driven action gating (correction round 2, item 6) --
  // legacy accounts (role_level set) keep unrestricted create/edit/delete,
  // exactly as before this rollout (no legacy account was ever gated
  // here). A new functional-role account is gated: HR Manager gets all
  // three (employees.create/edit/delete); Accountant/Operations Manager
  // (employees.view only) get none -- Employees becomes read-only for
  // them, matching "Accountant on Employees: no Add, no Edit, no Delete".
  const [canCreateEmployee, setCanCreateEmployee] = useState(true);
  const [canEditEmployee, setCanEditEmployee] = useState(true);
  const [canDeleteEmployee, setCanDeleteEmployee] = useState(true);
  const [showDeletedModal, setShowDeletedModal] = useState(false);
  const [selectedDeletedEmployee, setSelectedDeletedEmployee] = useState<Employee | null>(null);
  
  // ===== PAGINATION =====
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);
  useEffect(() => { getDefaultPageSize().then(setItemsPerPage); }, []);

  // ===== MEMOIZED VALUES =====
  const isSuperAdmin = useMemo(() => userProfile?.is_super_admin, [userProfile]);
  // HOTFIX: employees RLS already grants a Business Admin (role='admin' or
  // role_level=1) tenant-wide region access the same way it does for a
  // Super Admin (current_user_role_level() <= 2 OR employees.* permission
  // -- is_super_admin plays no special role in that policy at all). The Add
  // Employee form's region field used to gate on isSuperAdmin alone, which
  // left a Business Admin with no region_id of their own (the normal case)
  // stuck with a blank, locked field and no way to create an employee. Uses
  // the shared canChooseAnyRegion() helper (src/utils/permissions.ts) that
  // Attendance's region-edit gate also uses, so this doesn't duplicate a
  // second, possibly-drifting definition of "who may act across regions".
  const canChooseAnyRegion = useMemo(() => resolveCanChooseAnyRegion(userProfile), [userProfile]);
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
    const data = activeEmployees;
    
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
    const isLegacy = (profile?.role_level ?? null) !== null;
    setCanCreateEmployee(await canAccess(isLegacy, PERMISSIONS.EMPLOYEES_CREATE));
    setCanEditEmployee(await canAccess(isLegacy, PERMISSIONS.EMPLOYEES_EDIT));
    setCanDeleteEmployee(await canAccess(isLegacy, PERMISSIONS.EMPLOYEES_DELETE));
    setUserLoading(false);
  }, []);

  const fetchEmployees = useCallback(async () => {
    setLoading(true);
    try {
      // employees_general: non-sensitive employee read surface (Design B2) --
      // confirmed the Employees module never references any guard/security-
      // only column.
      //
      // PRODUCTION HOTFIX (employee visibility): this used to be a single
      // unpaginated `.select('*')` request. PostgREST/Supabase applies a
      // server-side max-rows cap to any request that doesn't explicitly
      // page with `.range()` -- with the tenant's employee population now
      // past that cap, the single request was silently truncated to the
      // first page (in `full_name` order), so employees sorting after the
      // cutoff never reached `employees` state at all. Both the summary
      // counts and the search box (which filter this in-memory array, not
      // the database -- see the `filtered`/`activeEmployees` useMemo above)
      // silently excluded those employees with no error. Paging with
      // `fetchAllPages()` (src/utils/employeeBatchFetch.ts -- the same
      // anti-truncation core `fetchInEmployeeIdBatches` already uses
      // elsewhere in this codebase) until the complete matching set is
      // fetched fixes this without changing any filtering, search, or RLS
      // behavior.
      const allRows = await fetchAllPages<EmployeeRow>((rangeFrom, rangeTo, withExactCount) => {
        let q = withExactCount
          ? supabase.from('employees_general').select('*', { count: 'exact' })
          : supabase.from('employees_general').select('*');

        if (!userProfile?.is_super_admin && userProfile?.region_id) {
          q = q.eq('region_id', userProfile.region_id);
        }
        if (filterRegionId && userProfile?.is_super_admin) {
          q = q.eq('region_id', filterRegionId);
        }
        if (debouncedFilterCompany) q = q.ilike('company', `%${debouncedFilterCompany}%`);
        if (debouncedFilterWorkstation) q = q.ilike('workstation', `%${debouncedFilterWorkstation}%`);
        if (filterPayPoint) q = q.eq('pay_point', filterPayPoint);

        // `id` is an explicit tiebreaker alongside the existing `full_name`
        // sort: `.range()` pagination over a non-unique sort key can skip
        // or repeat rows across page boundaries whenever two employees
        // share the same full_name.
        return q.order('full_name').order('id').range(rangeFrom, rangeTo);
      });

      const mappedEmployees = allRows.map((emp: EmployeeRow) => ({
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
    } catch (err) {
      console.error('Error fetching employees:', err);
      showNotification('Failed to load employees', 'error');
    } finally {
      setLoading(false);
    }
  }, [userProfile, filterRegionId, debouncedFilterCompany, debouncedFilterWorkstation, filterPayPoint]);

  // Same region-prefix + last-number-plus-one logic AddEmployeeForm uses to
  // show a live preview after picking a region -- extracted here so
  // addEmployee can call it again, with a fresh read, whenever the number it
  // was handed collides with one someone else just took.
  const getNextEmployeeNumberForRegion = useCallback(async (regionId: string): Promise<string> => {
    const region = regions.find((r) => r.id === regionId) || {};
    return generateEmployeeNumberServerSide(regionId, region);
  }, [regions]);

  // ===== ADD EMPLOYEE =====
  const addEmployee = useCallback(async (emp: EmployeeFormData) => {
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
    
    let assignedRegionId: string | null | undefined = safeEmp.region_id;
    if (!userProfile?.is_super_admin) {
      assignedRegionId = userProfile?.region_id;
    }
    
    if (userProfile?.is_super_admin && !assignedRegionId) {
      showNotification('Please select a region', 'error');
      return;
    }

    const identifierConflicts = await checkEmployeeIdentifierConflicts({
      nationalId: safeEmp.nationalId,
      phone: safeEmp.phone,
      accountNumber: safeEmp.account_number,
    });

    if (identifierConflicts.length > 0) {
      showNotification(formatIdentifierConflictMessage(identifierConflicts), 'error');
      return;
    }

    // Format company and workstation based on assignment type
    const formattedCompany = safeEmp.assignment_type === 'company' && safeEmp.company ? formatText(safeEmp.company) : null;
    const formattedWorkstation = safeEmp.workstation ? formatText(safeEmp.workstation) : null;
    const formattedResidentName = safeEmp.assignment_type === 'resident' ? formatText(safeEmp.resident_name) : null;
    const formattedResidentContact = safeEmp.assignment_type === 'resident' ? sanitizeInput(safeEmp.resident_contact) : null;
    
    const uniformDeduction = safeEmp.uniform_deduction || 0;
    const calculatedAge = safeEmp.dob ? calculateAge(safeEmp.dob) : 0;

    const buildInsertRow = (employeeNumber: string) => ({
      employee_number: employeeNumber,
      full_name: safeEmp.fullName,
      gender: safeEmp.gender,
      age: calculatedAge,
      phone: safeEmp.phone,
      position: safeEmp.position,
      department: safeEmp.department,
      basic_salary: safeEmp.basicSalary,
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
    });

    // The employee number is generated client-side (region prefix + last
    // number + 1) the moment a region is picked, then the admin spends time
    // filling out the rest of the form -- plenty of time for someone else
    // (another admin, another tab, or the same admin adding several people
    // back to back) to take that same "next" number first. Rather than
    // surfacing that race as an error the user can't act on, retry with a
    // freshly generated number a few times. A dropped network connection
    // (fetch throws instead of returning {error}) is retried too, since
    // adding several employees in a row makes a transient blip more likely
    // to land mid-request.
    let employeeNumberToUse = safeEmp.employeeNumber;
    // Narrowed RETURNING -- just `id`, not the full row (no `RETURNING *`
    // against the base table). The complete row the UI needs is fetched
    // separately from `employees_general` once the insert succeeds.
    let insertedId: string | null = null;
    let error: { message: string; code?: string; isNetworkError?: boolean } | null = null;
    const MAX_INSERT_ATTEMPTS = 5;

    for (let attempt = 1; attempt <= MAX_INSERT_ATTEMPTS; attempt++) {
      error = null;
      try {
        const result = await supabase
          .from('employees')
          .insert([buildInsertRow(employeeNumberToUse)])
          .select('id')
          .single();
        insertedId = result.data?.id ?? null;
        error = result.error;
      } catch (networkErr) {
        error = { message: getErrorMessage(networkErr), isNetworkError: true };
      }

      if (!error) break;

      const isNumberCollision = error.code === '23505' && /employee_number/i.test(error.message || '');
      const isLastAttempt = attempt === MAX_INSERT_ATTEMPTS;

      if (isNumberCollision && !isLastAttempt) {
        employeeNumberToUse = await getNextEmployeeNumberForRegion(assignedRegionId ?? '');
        continue;
      }

      if (error.isNetworkError && !isLastAttempt) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }

      break;
    }

    if (error) {
      // Leave the modal open on failure -- closing it here would discard
      // everything the admin just typed, forcing them to redo the whole
      // form after a failure that (thanks to the retries above) is now
      // rarely their fault to begin with.
      let message = error.isNetworkError
        ? 'Network error while adding employee. Please check your connection and try again.'
        : 'Error adding employee: ' + getErrorMessage(error);

      // Defensive, forward-compatible handling for a genuine DB-level
      // unique violation on national_id/phone/account_number -- see
      // identifierColumnFromUniqueViolation()'s own comment for why this is
      // currently unreachable in production (no such constraint exists yet,
      // confirmed against the schema) but must not silently fall back to
      // the raw Postgres message if a constraint is ever added.
      if (!error.isNetworkError && error.code === '23505') {
        const column = identifierColumnFromUniqueViolation(error);
        if (column) {
          const conflicts = await checkEmployeeIdentifierConflicts({
            nationalId: column === 'national_id' ? safeEmp.nationalId : null,
            phone: column === 'phone' ? safeEmp.phone : null,
            accountNumber: column === 'account_number' ? safeEmp.account_number : null,
          });
          if (conflicts.length > 0) {
            message = formatIdentifierConflictMessage(conflicts);
          }
        } else if (/employee_number/i.test(error.message || '')) {
          // Every retry above (getNextEmployeeNumberForRegion()) already
          // re-generates a fresh number from generate_employee_number()'s
          // own row-locked counter -- reaching here means all attempts
          // still collided (a genuine, narrow concurrency edge case, or a
          // counter/data problem an Admin needs to look at), not something
          // typing the form again will fix on its own. Name the real cause
          // instead of the fully generic "record already exists".
          message = 'Employee number is already assigned. Please retry, or contact your Administrator if this keeps happening.';
        }
      }

      showNotification(message, 'error');
      return;
    } else if (insertedId) {
      // Fetch the complete non-sensitive row through employees_general --
      // the base-table insert above only returned `id` (no `RETURNING *`).
      const { data: fullRow, error: fetchError } = await supabase
        .from('employees_general')
        .select('*')
        .eq('id', insertedId)
        .single();

      if (fetchError || !fullRow) {
        showNotification('Employee added, but failed to load the new record: ' + getErrorMessage(fetchError), 'error');
        return;
      }

      const newEmployee = {
        id: fullRow.id,
        employeeNumber: fullRow.employee_number,
        fullName: fullRow.full_name,
        gender: fullRow.gender || '',
        age: fullRow.age || 0,
        phone: fullRow.phone || '',
        position: fullRow.position,
        department: fullRow.department || 'Operations',
        basicSalary: fullRow.basic_salary,
        status: fullRow.status || 'Active',
        email: fullRow.email || '',
        dateHired: fullRow.hire_date || new Date().toISOString().split('T')[0],
        dob: fullRow.dob,
        nationalId: fullRow.national_id,
        address: fullRow.address,
        qualification: fullRow.qualification,
        contractType: fullRow.contract_type,
        region_id: fullRow.region_id,
        company: fullRow.company,
        workstation: fullRow.workstation,
        pay_point: fullRow.pay_point,
        account_number: fullRow.account_number,
        uniform_deduction: fullRow.uniform_deduction || 0,
        next_of_kin_name: fullRow.next_of_kin_name || '',
        next_of_kin_relationship: fullRow.next_of_kin_relationship || '',
        next_of_kin_phone: fullRow.next_of_kin_phone || '',
        next_of_kin_address: fullRow.next_of_kin_address || '',
        is_deleted: fullRow.is_deleted || false,
        deleted_at: fullRow.deleted_at || null,
        deleted_reason: fullRow.deleted_reason || null,
        deleted_by: fullRow.deleted_by || null,
        created_at: fullRow.created_at || null,
        assignment_type: fullRow.assignment_type || 'company',
        resident_name: fullRow.resident_name || '',
        resident_contact: fullRow.resident_contact || '',
        company_id: fullRow.company_id || null,
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
  }, [userProfile, employees, getNextEmployeeNumberForRegion]);

  // ===== UPDATE EMPLOYEE =====
  const updateEmployee = useCallback(async (emp: EmployeeFormData) => {
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
    
    // editingEmployee.id is excluded so the employee's own unchanged
    // National ID/Phone/Account Number is never reported as a conflict
    // with itself.
    const identifierConflicts = await checkEmployeeIdentifierConflicts({
      nationalId: safeEmp.nationalId,
      phone: safeEmp.phone,
      accountNumber: safeEmp.account_number,
    }, editingEmployee.id);

    if (identifierConflicts.length > 0) {
      showNotification(formatIdentifierConflictMessage(identifierConflicts), 'error');
      return;
    }

    const formattedCompany = safeEmp.assignment_type === 'company' && safeEmp.company ? formatText(safeEmp.company) : null;
    const formattedWorkstation = safeEmp.workstation ? formatText(safeEmp.workstation) : null;
    const formattedResidentName = safeEmp.assignment_type === 'resident' ? formatText(safeEmp.resident_name) : null;
    const formattedResidentContact = safeEmp.assignment_type === 'resident' ? sanitizeInput(safeEmp.resident_contact) : null;

    const uniformDeduction = safeEmp.uniform_deduction || 0;
    const calculatedAge = safeEmp.dob ? calculateAge(safeEmp.dob) : 0;

    // Narrowed RETURNING -- just `id`, not the full row (no `RETURNING *`
    // against the base table). The complete row the UI needs is fetched
    // separately from `employees_general` once the update succeeds.
    const { data: updateResult, error } = await supabase
      .from('employees')
      .update({
        employee_number: safeEmp.employeeNumber,
        full_name: safeEmp.fullName,
        gender: safeEmp.gender,
        age: calculatedAge,
        phone: safeEmp.phone,
        position: safeEmp.position,
        department: safeEmp.department,
        basic_salary: safeEmp.basicSalary,
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
        // HOTFIX: region_id was missing from this payload entirely -- the
        // Edit form now lets a Business Admin/Super Admin reassign region
        // (EditEmployeeForm's new Region field), but without this the
        // selection was silently discarded on submit, never reaching the
        // database. See resolveEmployeeUpdateRegionId() for why it's not
        // just `safeEmp.region_id`.
        region_id: resolveEmployeeUpdateRegionId(safeEmp.region_id),
        // company_id will be updated by trigger
      })
      .eq('id', editingEmployee.id)
      .select('id');

    if (error) {
      // Leave the modal open on failure so the admin's edits aren't discarded.
      let message = 'Error updating employee: ' + getErrorMessage(error);

      // Defensive, forward-compatible handling -- see the matching comment
      // in addEmployee() and identifierColumnFromUniqueViolation() for why
      // this cannot fire for national_id/phone/account_number today (no
      // DB-level unique constraint exists on them yet).
      if (error.code === '23505') {
        const column = identifierColumnFromUniqueViolation(error);
        if (column) {
          const conflicts = await checkEmployeeIdentifierConflicts({
            nationalId: column === 'national_id' ? safeEmp.nationalId : null,
            phone: column === 'phone' ? safeEmp.phone : null,
            accountNumber: column === 'account_number' ? safeEmp.account_number : null,
          }, editingEmployee.id);
          if (conflicts.length > 0) {
            message = formatIdentifierConflictMessage(conflicts);
          }
        }
      }

      showNotification(message, 'error');
      return;
    } else if (updateResult && updateResult[0]) {
      // Fetch the complete non-sensitive row through employees_general --
      // the base-table update above only returned `id` (no `RETURNING *`).
      const { data: fullRow, error: fetchError } = await supabase
        .from('employees_general')
        .select('*')
        .eq('id', updateResult[0].id)
        .single();

      if (fetchError || !fullRow) {
        showNotification('Employee updated, but failed to reload the record: ' + getErrorMessage(fetchError), 'error');
        return;
      }

      const updatedEmployee = {
        ...editingEmployee,
        employeeNumber: fullRow.employee_number,
        fullName: fullRow.full_name,
        gender: fullRow.gender || '',
        age: fullRow.age || 0,
        phone: fullRow.phone || '',
        position: fullRow.position,
        department: fullRow.department || 'Operations',
        basicSalary: fullRow.basic_salary,
        status: fullRow.status || 'Active',
        email: fullRow.email || '',
        dateHired: fullRow.hire_date || new Date().toISOString().split('T')[0],
        dob: fullRow.dob,
        nationalId: fullRow.national_id,
        address: fullRow.address,
        qualification: fullRow.qualification,
        contractType: fullRow.contract_type,
        // HOTFIX: previously missing from this refresh -- after a
        // successful region reassignment, the in-memory employees list (and
        // the region_id this function then hands to logAudit() below) would
        // otherwise keep showing the OLD region until a full page reload,
        // even though the database write itself succeeded.
        region_id: fullRow.region_id,
        company: fullRow.company,
        workstation: fullRow.workstation,
        pay_point: fullRow.pay_point,
        account_number: fullRow.account_number,
        uniform_deduction: fullRow.uniform_deduction || 0,
        next_of_kin_name: fullRow.next_of_kin_name || '',
        next_of_kin_relationship: fullRow.next_of_kin_relationship || '',
        next_of_kin_phone: fullRow.next_of_kin_phone || '',
        next_of_kin_address: fullRow.next_of_kin_address || '',
        assignment_type: fullRow.assignment_type || 'company',
        resident_name: fullRow.resident_name || '',
        resident_contact: fullRow.resident_contact || '',
        company_id: fullRow.company_id || null,
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
  }, [editingEmployee, employees]);

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
    ].map(toCsvRow).join('\n');
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
    // HOTFIX: employees UPDATE RLS already grants a Business Admin
    // (role='admin' or role_level=1) tenant-wide region access via
    // region_allowed()'s is_business_admin() bypass, the same as it does
    // for is_super_admin() -- this gate used to exempt Super Admin only,
    // blocking a Business Admin with region_id=NULL (the confirmed
    // STAGING persona) from editing any employee outside their own (null)
    // region. canActOnRegion() reuses the same canChooseAnyRegion() helper
    // the Attendance edit gate and Add Employee region field already use.
    if (!canActOnRegion(userProfile, employee.region_id)) {
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
            {canCreateEmployee && (
              <Button variant="secondary" onClick={() => setShowAdd(true)}><Plus size={16} /> Add Employee</Button>
            )}
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
                <TH className="hidden lg:table-cell">Workstation</TH>
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
                  <TD className="hidden lg:table-cell">{emp.workstation || '-'}</TD>
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
                          {canEditEmployee && (
                            <button
                              onClick={() => restoreEmployee(emp)}
                              className="w-8 h-8 rounded-lg hover:bg-emerald-50 text-emerald-600 flex items-center justify-center"
                              title="Restore Employee"
                            >
                              <RotateCcw size={14} />
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button onClick={() => setSelected(emp)} className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-600 flex items-center justify-center"><Eye size={14} /></button>
                          {canEditEmployee && (
                            <button onClick={() => handleEdit(emp)} className="w-8 h-8 rounded-lg hover:bg-slate-100 text-amber-600 flex items-center justify-center"><Edit2 size={14} /></button>
                          )}
                          {canDeleteEmployee && (
                            <button onClick={() => handleDelete(emp)} className="w-8 h-8 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center"><Trash2 size={14} /></button>
                          )}
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
          canChooseAnyRegion={canChooseAnyRegion}
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
            canChooseAnyRegion={canChooseAnyRegion}
            regions={regions}
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
  canChooseAnyRegion,
  userRegionName,
  relationshipOptions,
}: {
  onSubmit: (e: EmployeeFormData) => void;
  onCancel: () => void;
  departments: string[];
  regions: UserProfileRegion[];
  userRegionId?: string | null;
  canChooseAnyRegion?: boolean;
  userRegionName?: string;
  relationshipOptions: string[];
}) {
  const [form, setForm] = useState<EmployeeFormData>({
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

  const [positions, setPositions] = useState<{ name: string }[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  // Tracks which region_id the employee number was last generated (or is
  // being generated) for, so the auto-generation effect below can tell "a
  // NEW region just became current, generate for it" apart from "form
  // re-rendered for an unrelated reason, region_id is unchanged, don't
  // regenerate" -- a plain "regenerate whenever employeeNumber is blank"
  // check can't make that distinction (employeeNumber starts blank too).
  const lastGeneratedForRegion = useRef<string | null>(null);
  const [companySuggestions, setCompanySuggestions] = useState<string[]>([]);
  const [showCompanySuggestions, setShowCompanySuggestions] = useState(false);
  const [residentSuggestions, setResidentSuggestions] = useState<string[]>([]);
  const [showResidentSuggestions, setShowResidentSuggestions] = useState(false);

  // ===== NEW: Loading state for submit button =====
  const [isSubmitting, setIsSubmitting] = useState(false);

  const update = <K extends keyof EmployeeFormData>(k: K, v: EmployeeFormData[K]) => {
    setForm((prev) => ({ ...prev, [k]: v }));
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
  const fetchResidentSuggestions = useCallback(async (input: string) => {
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

  // Handle assignment type change
  const handleAssignmentTypeChange = (type: string) => {
    update("assignment_type", type);
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
      if (!region) {
        console.error("Error generating employee number: region", regionId, "not found in the loaded regions list");
        showNotification("Could not generate Employee Number: region not found. Please try again.", "error");
        return;
      }

      const formattedNumber = await generateEmployeeNumberServerSide(regionId, region);
      setTimeout(() => {
        update("employeeNumber", formattedNumber);
      }, 10);
    } catch (err) {
      // Leaves form.employeeNumber blank -- validateEmployeeForm() already
      // refuses to submit with a blank Employee Number, so this never
      // results in an employee being created with a blank or guessed
      // number; this notification just makes the failure visible instead
      // of only reaching the browser console.
      console.error("Error generating employee number:", err);
      showNotification("Failed to generate Employee Number. Please try again.", "error");
    } finally {
      setIsGenerating(false);
    }
  };

  // ===== AUTO-GENERATE EMPLOYEE NUMBER WHENEVER THE FORM'S REGION
  // RESOLVES TO A NEW VALUE -- covers BOTH ways a region reaches this
  // form: a non-super-admin's region is preset directly into useState's
  // initial value (see `region_id: userRegionId || ""` above) and the
  // region field then renders as a locked, disabled <input> with no
  // onChange of its own -- so a handler living only inside the region
  // <select>'s onChange (the old approach) could never fire for that
  // case, leaving Employee Number permanently blank and the form
  // permanently unsubmittable. A super admin's own region <select> still
  // works too: its onChange sets form.region_id, which is exactly this
  // effect's dependency, so ONE code path now generates for both cases
  // instead of two.
  //
  // `lastGeneratedForRegion` (not "is employeeNumber blank") is the guard
  // against double-generating: employeeNumber is legitimately blank both
  // before the FIRST generation for a region AND right after a super
  // admin switches to a DIFFERENT region (see the onChange handler below,
  // which clears it) -- a blank-check alone can't tell "never generated
  // yet" apart from "already generated, still on the same region" once a
  // super admin has switched back and forth. Comparing against the exact
  // region_id last generated for makes a genuine region change always
  // regenerate, while a re-render that leaves region_id untouched never
  // does.
  useEffect(() => {
    const regionId = form.region_id;
    if (!shouldGenerateEmployeeNumber(regionId, lastGeneratedForRegion.current)) return;
    lastGeneratedForRegion.current = regionId;
    generateEmployeeNumber(regionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.region_id]);

  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const { data, error } = await supabase
          .from("positions")
          .select("name")
          .eq("is_active", true)
          .order("name");
        if (error) throw error;
        setPositions(data || []);
      } catch (err) {
        console.error("Error fetching positions:", err);
        showNotification("Failed to load positions from Settings", "error");
        setPositions([]);
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
    const missingField = validateEmployeeForm(form, canChooseAnyRegion);
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
  // Only ever called with the string-valued fields -- basicSalary/
  // uniform_deduction have their own dedicated inputs (handleSalaryChange/
  // handleUniformDeductionChange below) and never go through this helper.
  const field = (
    k: Exclude<keyof EmployeeFormData, 'basicSalary' | 'uniform_deduction'>,
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
        ) : type === "date" ? (
          <DateFieldDMY
            value={form[k] || ""}
            onChange={(iso) => update(k, iso)}
            required={required}
            disabled={isSubmitting}
          />
        ) : (
          <input
            type={type}
            value={form[k] || ""}
            onChange={(e) => update(k, type === "text" ? e.target.value.toUpperCase() : e.target.value)}
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
          {!canChooseAnyRegion && userRegionName && (
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
              value={isGenerating ? '' : form.employeeNumber}
              placeholder={isGenerating ? 'Generating employee number...' : ''}
              disabled
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-slate-50 font-mono placeholder:font-sans placeholder:italic placeholder:text-slate-400"
            />
            <p className="text-xs text-slate-400 mt-1">
              {isGenerating
                ? 'Generating employee number...'
                : 'System-generated for the assigned region -- not editable'}
            </p>
          </div>
          {field("fullName", "Full Name", "text", true)}
          {field("dob", "Date of Birth", "date", true)}
          {field("gender", "Gender", "text", true, [
            { label: "Male", value: "Male" },
            { label: "Female", value: "Female" },
          ])}
          {field("nationalId", "National ID", "text", false, undefined, 8)}
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
            (positions.some((p) => p.name === form.position) || !form.position
              ? positions
              : [{ name: form.position }, ...positions]
            ).map((p) => ({ label: p.name, value: p.name })),
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
                    const val = e.target.value.toUpperCase();
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
                    const val = e.target.value.toUpperCase();
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
              onChange={(e) => update("next_of_kin_name", e.target.value.toUpperCase())}
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
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Address</label>
            <input
              type="text"
              value={form.next_of_kin_address || ""}
              onChange={(e) => update("next_of_kin_address", e.target.value.toUpperCase())}
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
            {canChooseAnyRegion ? (
              <select
                value={form.region_id || ""}
                onChange={(e) => {
                  const selectedId = e.target.value;
                  // Clears employeeNumber unconditionally (not just when
                  // cleared to "") and resets the generation-tracking ref
                  // so the auto-generation effect above always treats this
                  // as a fresh region and regenerates -- the effect itself
                  // (triggered by this same region_id change) is now the
                  // ONLY place that calls generateEmployeeNumber, so there
                  // is no risk of it firing twice for one selection.
                  setForm((prev) => ({ ...prev, region_id: selectedId, employeeNumber: "" }));
                  lastGeneratedForRegion.current = null;
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
          disabled={isSubmitting || isGenerating}
          className={`px-5 py-2 rounded-lg bg-[#D4A017] text-white text-sm font-semibold hover:bg-[#e8b82e] transition-all flex items-center gap-2 ${
            (isSubmitting || isGenerating) ? 'opacity-70 cursor-not-allowed' : ''
          }`}
        >
          {isSubmitting ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Adding Employee...
            </>
          ) : isGenerating ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Generating Employee Number...
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
function EditEmployeeForm({ employee, onSubmit, onCancel, departments, canChooseAnyRegion, regions, relationshipOptions }: {
  employee: Employee;
  onSubmit: (e: EmployeeFormData) => void;
  onCancel: () => void;
  departments: string[];
  canChooseAnyRegion?: boolean;
  regions: UserProfileRegion[];
  relationshipOptions: string[];
}) {
  const [form, setForm] = useState<EmployeeFormData>({
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
    region_id: resolveEmployeeFormRegionId(employee.region_id),
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
  
  const [positions, setPositions] = useState<{ name: string }[]>([]);
  const [companySuggestions, setCompanySuggestions] = useState<string[]>([]);
  const [showCompanySuggestions, setShowCompanySuggestions] = useState(false);
  const [residentSuggestions, setResidentSuggestions] = useState<string[]>([]);
  const [showResidentSuggestions, setShowResidentSuggestions] = useState(false);

  // ===== NEW: Loading state for edit submit button =====
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Must use the functional updater (prev => ...), not `{ ...form, [k]: v }`.
  // handleAssignmentTypeChange below calls update() twice in a row (once for
  // assignment_type, once to clear company/resident_name) -- with the plain
  // `{ ...form }` spread, both calls read the same stale `form` from this
  // render, so the second call's spread silently discards the first call's
  // change instead of building on it. That's why switching Company <-> Resident
  // looked like it did nothing: the assignment_type update was overwritten by
  // the very next line clearing the other field.
  const update = <K extends keyof EmployeeFormData>(k: K, v: EmployeeFormData[K]) => {
    setForm((prev) => ({ ...prev, [k]: v }));
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
      try {
        const { data, error } = await supabase
          .from('positions')
          .select('name')
          .eq('is_active', true)
          .order('name');
        if (error) throw error;
        setPositions(data || []);
      } catch (err) {
        console.error('Error fetching positions:', err);
        showNotification('Failed to load positions from Settings', 'error');
        setPositions([]);
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
    // tells the admin exactly which box to fill in. HOTFIX: Region is now a
    // real field here too (see the render gate below) -- canChooseAnyRegion
    // (Super Admin OR Business Admin) governs its requiredness the same way
    // it already does in AddEmployeeForm.
    const missingField = validateEmployeeForm(form, canChooseAnyRegion);
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
  // Only ever called with the string-valued fields -- basicSalary/
  // uniform_deduction have their own dedicated inputs (handleSalaryChange/
  // handleUniformDeductionChange above) and never go through this helper.
  const field = (k: Exclude<keyof EmployeeFormData, 'basicSalary' | 'uniform_deduction'>, label: string, type = 'text', required = false, options?: { label: string; value: string }[], maxLength?: number) => {
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
        ) : type === 'date' ? (
          <DateFieldDMY
            value={form[k] || ''}
            onChange={(iso) => update(k, iso)}
            required={required}
            disabled={isSubmitting}
          />
        ) : (
          <input
            type={type}
            value={form[k] || ''}
            onChange={e => update(k, type === 'text' ? e.target.value.toUpperCase() : e.target.value)}
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
          {field('nationalId', 'National ID', 'text', false, undefined, 8)}
          {field('phone', 'Phone Number', 'tel', true, undefined, 10)}
        </div>
        <div className="mt-4">{field('address', 'Residential Address', 'text', true)}</div>
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Employment Information</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {field('position', 'Position', 'text', true,
            (positions.some(p => p.name === form.position) || !form.position
              ? positions
              : [{ name: form.position }, ...positions]
            ).map(p => ({ label: p.name, value: p.name }))
          )}
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
            { label: 'Suspended', value: 'Suspended' },
            // Only shown when the employee is currently Exited, so the
            // dropdown displays their real status instead of looking
            // blank -- not offered as a free pick for anyone else.
            // Terminal Dues' Exits tab (finalize/cancel) is the only way
            // to actually move status into or out of 'Exited'; a direct
            // save attempting that here is rejected by the database
            // (guard_employee_exited_status_transition).
            ...(employee.status === 'Exited' ? [{ label: 'Exited', value: 'Exited' }] : []),
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
                    const val = e.target.value.toUpperCase();
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
                    const val = e.target.value.toUpperCase();
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
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Region</h4>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Region <span className="text-red-500">*</span>
            </label>
            {/* HOTFIX: employees UPDATE RLS already grants a Business Admin
                (role='admin' or role_level=1) tenant-wide region access via
                region_allowed()'s is_business_admin() bypass, same as Super
                Admin -- this Edit form previously had no Region field at
                all, so a Business Admin could never reassign an employee's
                region even though the database already permits it.
                canChooseAnyRegion mirrors AddEmployeeForm's identical gate;
                a genuinely region-scoped caller (canChooseAnyRegion=false)
                only ever reaches this form for an employee already in their
                own region (handleEdit's canActOnRegion() check above this
                component enforces that), so the locked display below is
                never actually cross-region for them -- it just preserves
                the existing "cannot reassign" restriction. */}
            {canChooseAnyRegion ? (
              <select
                value={form.region_id || ""}
                onChange={(e) => update('region_id', e.target.value)}
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
                value={regions.find((r) => r.id === form.region_id)?.name || ""}
                disabled
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-slate-50"
              />
            )}
          </div>
        </div>
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
              onChange={(e) => update("next_of_kin_name", e.target.value.toUpperCase())}
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
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Address</label>
            <input
              type="text"
              value={form.next_of_kin_address || ""}
              onChange={(e) => update("next_of_kin_address", e.target.value.toUpperCase())}
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