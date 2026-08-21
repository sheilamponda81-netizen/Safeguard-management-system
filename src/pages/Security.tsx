import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Search, Shield, Download, Edit2, Trash2, UserPlus, X,
  AlertCircle, RefreshCw,
  Eye, CheckCircle, User,
  Shirt, Save
} from '../utils/icons';
import { Card, Button, Badge, THead, TBody, TR, TH, TD, Modal, PageHeader } from '../components/ui';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { canAccess, PERMISSIONS } from '../utils/permissions';
import { showNotification } from '../utils/clickHandlers';
import { logAudit } from '../utils/auditLogger';
import { Pagination } from '../components/Pagination';
import { getDefaultPageSize } from '../utils/uiSettings';
import { toCsvRow } from '../utils/csvExport';
import { generateGuardId, generateGuardIdServerSide } from '../utils/guardIdGeneration';
import { UserProfile, UserProfileRegion } from '../utils/currentProfile';
import { getErrorMessage } from '../utils/errorHandler';

// Raw `employees` row shape -- only the columns this file actually reads
// (query below is `select('*')`). No generated Supabase types exist in
// this project yet (see AUDIT_REPORT.md's "Supabase generated types"
// section).
interface EmployeeRow {
  id: string;
  full_name: string | null;
  employee_number: string | null;
  position: string | null;
  status: string | null;
  phone: string | null;
  region_id: string | null;
  company: string | null;
  workstation: string | null;
  shift: string | null;
  supervisor: string | null;
  uniform_status: string | null;
  uniform_condition: string | null;
  shoes_status: string | null;
  guardId: string | null;
  license_status: string | null;
  license_expiry: string | null;
  next_of_kin_name: string | null;
  next_of_kin_phone: string | null;
  created_at: string | null;
}

// AddGuardForm/EditGuardForm's own form state -- every field is always
// initialized (see each form's useState), unlike a persisted
// SecurityPersonnel row where some fields may be absent.
interface GuardFormData {
  employee_id: string;
  full_name: string;
  employee_number: string;
  position: string;
  status: string;
  phone: string;
  company: string;
  workstation: string;
  shift: string;
  supervisor: string;
  uniform_status: string;
  uniform_condition: string;
  shoes_status: string;
  licenseStatus: string;
  license_expiry: string;
  emergency_contact: string;
  emergency_phone: string;
  guardId: string;
  is_existing_employee: boolean;
}

// Narrow row shapes for the employee-search / supervisor-search dropdowns
// (each query below selects only these columns, not `*`).
interface EmployeeSearchResult {
  id: string;
  full_name: string | null;
  employee_number: string | null;
  position: string | null;
  phone: string | null;
  company: string | null;
  workstation: string | null;
  status: string | null;
  region_id: string | null;
}

interface SupervisorSearchResult {
  id: string;
  full_name: string | null;
  employee_number: string | null;
  position: string | null;
}

interface SecurityPersonnel {
  id: string;
  full_name: string;
  employee_number: string;
  position: string;
  status: string;
  phone: string;
  region_id: string;
  company: string;
  workstation: string;
  shift: string;
  supervisor: string;
  uniform_status: string;
  uniform_condition: string;
  shoes_status: string;
  guardId: string;
  licenseStatus: string;
  license_expiry: string;
  emergency_contact: string;
  emergency_phone: string;
  created_at: string;
}


export function SecurityPage() {
  // ===== ALL HOOKS AT TOP LEVEL =====
  const [securityData, setSecurityData] = useState<SecurityPersonnel[]>([]);
  const [search, setSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showViewModal, setShowViewModal] = useState(false);
  const [editingItem, setEditingItem] = useState<SecurityPersonnel | null>(null);
  const [viewingItem, setViewingItem] = useState<SecurityPersonnel | null>(null);
  const [loading, setLoading] = useState(true);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  // Permission-driven action gating (correction round 2, item 6) -- legacy
  // accounts keep unrestricted access, unchanged. HR Manager gets all
  // three (security_personnel.create/edit/delete); Operations Manager
  // (security_personnel.view only) gets none -- read-only, matching
  // "Operations on Security: no Create/Edit/Delete". Accountant never
  // reaches this page at all (no security_personnel.* permission at all).
  const [canCreateGuard, setCanCreateGuard] = useState(true);
  const [canEditGuard, setCanEditGuard] = useState(true);
  const [canDeleteGuard, setCanDeleteGuard] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filterShift, setFilterShift] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterUniform, setFilterUniform] = useState('all');

  // ===== PAGINATION =====
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);
  useEffect(() => { getDefaultPageSize().then(setItemsPerPage); }, []);

  // ===== REFS =====
  const isMounted = useRef(true);
  const initialFetchDone = useRef(false);

  // ===== SITES, SHIFTS, SUPERVISORS =====
  // Static lists -- memoized so their reference stays stable across renders,
  // since the useCallback below (line ~409) lists them as dependencies.
  const shiftsList = useMemo(() => ['Morning (06-14)', 'Afternoon (14-22)', 'Night (22-06)', '24hr Rotation'], []);
  const supervisorsList = useMemo(() => ['William Banda', 'Agnes Phiri', 'John Mwanza', 'Felix Soko'], []);

  const uniformStatusList = ['Issued', 'Pending', 'Not Issued', 'Damaged'];
  const uniformConditionList = ['Good', 'Fair', 'Poor', 'Damaged'];
  const shoesStatusList = ['Good', 'Fair', 'Poor', 'Needs Replacement', 'Not Issued'];
  const licenseStatusList = ['Valid', 'Expiring', 'Expired', 'Not Issued'];
  const guardStatusList = ['Active', 'On Leave', 'Suspended', 'Terminated'];

  // ===== MEMOIZED VALUES =====
  const isSuperAdmin = useMemo(() => userProfile?.is_super_admin, [userProfile]);
  const userRegion = useMemo(() => userProfile?.regions, [userProfile]);

  const filtered = useMemo(() => {
    let data = securityData;
    
    if (search) {
      const s = search.toLowerCase();
      data = data.filter(e => 
        e.full_name?.toLowerCase().includes(s) || 
        e.position?.toLowerCase().includes(s) ||
        e.company?.toLowerCase().includes(s) ||
        e.workstation?.toLowerCase().includes(s) ||
        e.supervisor?.toLowerCase().includes(s) ||
        e.employee_number?.toLowerCase().includes(s)
      );
    }
    
    if (filterShift !== 'all') {
      data = data.filter(e => e.shift === filterShift);
    }
    
    if (filterStatus !== 'all') {
      data = data.filter(e => e.status === filterStatus);
    }
    
    if (filterUniform !== 'all') {
      data = data.filter(e => e.uniform_status === filterUniform);
    }
    
    return data;
  }, [securityData, search, filterShift, filterStatus, filterUniform]);

  // ===== PAGINATED DATA =====
  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, filtered.length);
    return filtered.slice(startIndex, endIndex);
  }, [filtered, currentPage, itemsPerPage]);

  // ===== STATS =====
  const stats = useMemo(() => ({
    total: securityData.length,
    active: securityData.filter(g => g.status === 'Active').length,
    onLeave: securityData.filter(g => g.status === 'On Leave').length,
    suspended: securityData.filter(g => g.status === 'Suspended').length,
    morning: securityData.filter(g => g.shift === 'Morning (06-14)').length,
    afternoon: securityData.filter(g => g.shift === 'Afternoon (14-22)').length,
    night: securityData.filter(g => g.shift === 'Night (22-06)').length,
    uniformIssued: securityData.filter(g => g.uniform_status === 'Issued').length,
    uniformPending: securityData.filter(g => g.uniform_status === 'Pending').length,
    licenseValid: securityData.filter(g => g.licenseStatus === 'Valid').length,
    licenseExpiring: securityData.filter(g => g.licenseStatus === 'Expiring').length,
    sites: [...new Set(securityData.map(g => g.workstation).filter(Boolean))].length
  }), [securityData]);

  // ===== FETCH USER PROFILE =====
  const fetchUserProfile = useCallback(async () => {
    try {
      return await getCurrentProfile();
    } catch (err) {
      console.error('Error fetching user profile:', err);
      return null;
    }
  }, []);

  // ===== FETCH SECURITY DATA =====
  const fetchSecurityData = useCallback(async () => {
    if (!isMounted.current) return;
    
    setLoading(true);
    setFetchError(null);
    
    try {
      let profile = userProfile;
      if (!profile) {
        profile = await fetchUserProfile();
        if (profile) {
          setUserProfile(profile);
          const isLegacy = (profile?.role_level ?? null) !== null;
          setCanCreateGuard(await canAccess(isLegacy, PERMISSIONS.SECURITY_PERSONNEL_CREATE));
          setCanEditGuard(await canAccess(isLegacy, PERMISSIONS.SECURITY_PERSONNEL_EDIT));
          setCanDeleteGuard(await canAccess(isLegacy, PERMISSIONS.SECURITY_PERSONNEL_DELETE));
        } else {
          setFetchError('Unable to load user profile');
          setLoading(false);
          return;
        }
      }

      console.log('Fetching security data for region:', profile?.region_id);

      // Build the query - exclude deleted employees
      // employees_security: narrow guard-data read surface (Design B2) --
      // this view already limits columns to what this page needs plus the
      // guard-only fields, gated by its own security_personnel.view
      // authorization predicate.
      let query = supabase
        .from('employees_security')
        .select('*')
        .eq('is_deleted', false);

      // Region filter for non-super admins
      if (!profile?.is_super_admin && profile?.region_id) {
        query = query.eq('region_id', profile.region_id);
      }

      // Membership in this page is driven by the same per-position
      // "Requires Uniform" flag (Settings -> Positions) that already
      // distinguishes guards/supervisors/handlers from senior/office staff
      // for payroll uniform deductions -- not a fragile substring match on
      // the position title, which would both miss real roles (e.g. "K9
      // Handler" contains none of "guard/security/officer/patrol/
      // supervisor") and wrongly include senior titles that happen to
      // contain one of those words (e.g. "Compliance Officer").
      const [{ data, error }, { data: positionsData }] = await Promise.all([
        query.order('full_name'),
        supabase.from('positions').select('name, requires_uniform'),
      ]);

      if (error) {
        console.error('Error fetching security data:', error);
        setFetchError('Database error: ' + getErrorMessage(error));
        setSecurityData([]);
        setLoading(false);
        return;
      }

      const positionsRequiringUniform = new Map(
        (positionsData || []).map(p => [p.name, p.requires_uniform !== false])
      );
      const securityEmployees = (data || []).filter(
        emp => positionsRequiringUniform.get(emp.position) ?? true
      );

      console.log('Security data fetched:', securityEmployees.length, 'records');

      if (securityEmployees.length === 0) {
        setSecurityData([]);
        setLoading(false);
        return;
      }

      const enhancedData = securityEmployees.map((emp: EmployeeRow) => ({
        id: emp.id,
        full_name: emp.full_name || '',
        employee_number: emp.employee_number || '',
        position: emp.position || 'Security Guard',
        status: emp.status || 'Active',
        phone: emp.phone || '',
        region_id: emp.region_id || '',
        company: emp.company || '',
        workstation: emp.workstation || '',
        shift: emp.shift || 'Not Assigned',
        supervisor: emp.supervisor || 'Not Assigned',
        uniform_status: emp.uniform_status || 'Pending',
        uniform_condition: emp.uniform_condition || 'Good',
        shoes_status: emp.shoes_status || 'Good',
        guardId: emp.guardId || '-',
        licenseStatus: emp.license_status || 'Valid',
        license_expiry: emp.license_expiry || '',
        emergency_contact: emp.next_of_kin_name || '',
        emergency_phone: emp.next_of_kin_phone || '',
        created_at: emp.created_at || new Date().toISOString()
      }));
      
      if (isMounted.current) {
        setSecurityData(enhancedData);
      }
    } catch (err) {
      console.error('Error in fetchSecurityData:', err);
      if (isMounted.current) {
        setFetchError('Failed to load security personnel: ' + getErrorMessage(err));
        setSecurityData([]);
      }
    } finally {
      if (isMounted.current) {
        setLoading(false);
      }
    }
  }, [userProfile, fetchUserProfile]);

  // ===== INITIALIZATION - Run once on mount =====
  useEffect(() => {
    isMounted.current = true;
    
    const init = async () => {
      if (!initialFetchDone.current) {
        await fetchSecurityData();
        initialFetchDone.current = true;
      }
    };
    
    init();
    
    return () => {
      isMounted.current = false;
    };
  }, [fetchSecurityData]);

  // ===== REFRESH - Manual refresh function =====
  const refreshData = useCallback(() => {
    initialFetchDone.current = false;
    fetchSecurityData();
  }, [fetchSecurityData]);

  // ===== ADD GUARD =====
  const handleAddGuard = useCallback(async (newGuard: GuardFormData) => {
    try {
      // Check if this is an existing employee or new
      if (newGuard.is_existing_employee && newGuard.employee_id) {
        // Update existing employee to add guard fields
        const { error } = await supabase
          .from('employees')
          .update({
            shift: newGuard.shift || shiftsList[0],
            supervisor: newGuard.supervisor || supervisorsList[0],
            uniform_status: newGuard.uniform_status || 'Pending',
            uniform_condition: newGuard.uniform_condition || 'Good',
            shoes_status: newGuard.shoes_status || 'Good',
            license_status: newGuard.licenseStatus || 'Valid',
            license_expiry: newGuard.license_expiry || '',
            guardId: newGuard.guardId || await generateGuardIdServerSide(),
            status: newGuard.status || 'Active'
          })
          .eq('id', newGuard.employee_id);

        if (error) throw error;

        // Fetch the updated employee data via employees_security (Design B2)
        const { data: updatedEmployee, error: fetchError } = await supabase
          .from('employees_security')
          .select('*')
          .eq('id', newGuard.employee_id)
          .maybeSingle();

        if (fetchError) throw fetchError;

        if (updatedEmployee) {
          const guard: SecurityPersonnel = {
            id: updatedEmployee.id,
            full_name: updatedEmployee.full_name || '',
            employee_number: updatedEmployee.employee_number || '',
            position: updatedEmployee.position || 'Security Guard',
            status: updatedEmployee.status || 'Active',
            phone: updatedEmployee.phone || '',
            region_id: updatedEmployee.region_id || '',
            company: updatedEmployee.company || '',
            workstation: updatedEmployee.workstation || '',
            shift: updatedEmployee.shift || shiftsList[0],
            supervisor: updatedEmployee.supervisor || supervisorsList[0],
            uniform_status: updatedEmployee.uniform_status || 'Pending',
            uniform_condition: updatedEmployee.uniform_condition || 'Good',
            shoes_status: updatedEmployee.shoes_status || 'Good',
            guardId: updatedEmployee.guardId || generateGuardId(),
            licenseStatus: updatedEmployee.license_status || 'Valid',
            license_expiry: updatedEmployee.license_expiry || '',
            emergency_contact: updatedEmployee.next_of_kin_name || '',
            emergency_phone: updatedEmployee.next_of_kin_phone || '',
            created_at: updatedEmployee.created_at || new Date().toISOString()
          };
          
          setSecurityData(prev => [guard, ...prev]);
          showNotification(`${newGuard.full_name} added as security guard`, 'success');
        }
      } else {
        // Create new employee as guard
        // Do not return guard columns directly from the raw employees
        // mutation -- narrow RETURNING to id only, then fetch the full
        // security row through employees_security (Design B2).
        const { data: insertData, error } = await supabase
          .from('employees')
          .insert([{
            full_name: newGuard.full_name,
            employee_number: newGuard.employee_number || `SG-${Math.floor(Math.random() * 10000)}`,
            position: newGuard.position || 'Security Guard',
            status: newGuard.status || 'Active',
            phone: newGuard.phone || '',
            region_id: userProfile?.region_id || null,
            company: newGuard.company || '',
            workstation: newGuard.workstation || '',
            shift: newGuard.shift || shiftsList[0],
            supervisor: newGuard.supervisor || supervisorsList[0],
            uniform_status: newGuard.uniform_status || 'Pending',
            uniform_condition: newGuard.uniform_condition || 'Good',
            shoes_status: newGuard.shoes_status || 'Good',
            license_status: newGuard.licenseStatus || 'Valid',
            license_expiry: newGuard.license_expiry || '',
            next_of_kin_name: newGuard.emergency_contact || '',
            next_of_kin_phone: newGuard.emergency_phone || '',
            guardId: newGuard.guardId || await generateGuardIdServerSide(),
            hire_date: new Date().toISOString().split('T')[0],
            department: 'Operations',
            is_deleted: false
          }])
          .select('id')
          .single();

        if (error) throw error;

        const { data: newEmployee, error: fetchNewError } = insertData
          ? await supabase
              .from('employees_security')
              .select('*')
              .eq('id', insertData.id)
              .maybeSingle()
          : { data: null, error: null };

        if (fetchNewError) throw fetchNewError;

        if (newEmployee) {
          const guard: SecurityPersonnel = {
            id: newEmployee.id,
            full_name: newEmployee.full_name,
            employee_number: newEmployee.employee_number,
            position: newEmployee.position,
            status: newEmployee.status || 'Active',
            phone: newEmployee.phone || '',
            region_id: newEmployee.region_id || '',
            company: newEmployee.company || '',
            workstation: newEmployee.workstation || '',
            shift: newEmployee.shift || shiftsList[0],
            supervisor: newEmployee.supervisor || supervisorsList[0],
            uniform_status: newEmployee.uniform_status || 'Pending',
            uniform_condition: newEmployee.uniform_condition || 'Good',
            shoes_status: newEmployee.shoes_status || 'Good',
            guardId: newEmployee.guardId || generateGuardId(),
            licenseStatus: newEmployee.license_status || 'Valid',
            license_expiry: newEmployee.license_expiry || '',
            emergency_contact: newEmployee.next_of_kin_name || '',
            emergency_phone: newEmployee.next_of_kin_phone || '',
            created_at: newEmployee.created_at || new Date().toISOString()
          };
          
          setSecurityData(prev => [guard, ...prev]);
          showNotification(`${newGuard.full_name} added to security personnel`, 'success');
        }
      }
      
      setShowAddModal(false);
      
      await logAudit({
        action: 'CREATE',
        entity_type: 'security_guard',
        entity_id: newGuard.employee_id || 'new',
        new_data: newGuard,
        region_id: userProfile?.region_id
      });
    } catch (err) {
      console.error('Error adding guard:', err);
      showNotification('Failed to add guard: ' + getErrorMessage(err), 'error');
    }
  }, [userProfile, shiftsList, supervisorsList]);

  // ===== VIEW GUARD =====
  const handleView = useCallback((item: SecurityPersonnel) => {
    setViewingItem(item);
    setShowViewModal(true);
    
    logAudit({
      action: 'VIEW',
      entity_type: 'security_guard',
      entity_id: item.id,
      new_data: {
        full_name: item.full_name,
        position: item.position,
        workstation: item.workstation
      },
      region_id: userProfile?.region_id
    });
  }, [userProfile]);

  // ===== EDIT GUARD =====
  const handleEdit = useCallback((item: SecurityPersonnel) => {
    setEditingItem(item);
    setShowEditModal(true);
  }, []);

  // ===== SAVE EDIT - UPDATED to sync with employees table =====
  // Takes the edited guard data as a parameter (from EditGuardForm's own
  // local `formData`) rather than reading `editingItem` -- `editingItem` is
  // only ever the *original*, pre-edit snapshot passed down as
  // EditGuardForm's `guard` prop, since that form's edits update its own
  // local state and never write back into `editingItem`. Reading
  // `editingItem` here (the previous behavior) meant every field an admin
  // changed in the Edit Guard form was silently discarded on Save -- the
  // update always re-saved the unmodified original data.
  const saveEdit = useCallback(async (updatedGuard: SecurityPersonnel) => {
    try {
      const oldData = securityData.find(item => item.id === updatedGuard.id);

      // Update all fields in the employees table - this will sync everywhere
      const { error } = await supabase
        .from('employees')
        .update({
          full_name: updatedGuard.full_name,
          employee_number: updatedGuard.employee_number,
          position: updatedGuard.position,
          phone: updatedGuard.phone,
          status: updatedGuard.status,
          company: updatedGuard.company,
          workstation: updatedGuard.workstation,
          shift: updatedGuard.shift,
          supervisor: updatedGuard.supervisor,
          uniform_status: updatedGuard.uniform_status,
          uniform_condition: updatedGuard.uniform_condition,
          shoes_status: updatedGuard.shoes_status,
          license_status: updatedGuard.licenseStatus,
          license_expiry: updatedGuard.license_expiry || null,
          next_of_kin_name: updatedGuard.emergency_contact,
          next_of_kin_phone: updatedGuard.emergency_phone,
          guardId: updatedGuard.guardId
        })
        .eq('id', updatedGuard.id);

      if (error) {
        console.error('Supabase update error:', error);
        showNotification('Failed to update guard: ' + getErrorMessage(error), 'error');
        return;
      }

      // Update local state
      setSecurityData(prev => prev.map(item => item.id === updatedGuard.id ? updatedGuard : item));
      showNotification(`${updatedGuard.full_name} updated successfully`, 'success');
      setShowEditModal(false);

      await logAudit({
        action: 'UPDATE',
        entity_type: 'security_guard',
        entity_id: updatedGuard.id,
        old_data: oldData,
        new_data: updatedGuard,
        region_id: userProfile?.region_id
      });

      setEditingItem(null);
    } catch (err) {
      console.error('Error updating guard:', err);
      showNotification('Failed to update guard: ' + getErrorMessage(err), 'error');
    }
  }, [securityData, userProfile]);

  // ===== DELETE GUARD =====
  const handleDelete = useCallback(async (item: SecurityPersonnel) => {
    if (confirm(`Are you sure you want to remove ${item.full_name} from security personnel?`)) {
      try {
        const oldData = { ...item };
        
        const { error } = await supabase
          .from('employees')
          .update({
            is_deleted: true,
            status: 'Deleted',
            deleted_at: new Date().toISOString(),
            deleted_reason: 'Removed from security personnel'
          })
          .eq('id', item.id);
          
        if (error) throw error;
        
        setSecurityData(prev => prev.filter(i => i.id !== item.id));
        showNotification(`${item.full_name} removed from security personnel`, 'success');
        
        await logAudit({
          action: 'DELETE',
          entity_type: 'security_guard',
          entity_id: item.id,
          old_data: oldData,
          region_id: userProfile?.region_id
        });
      } catch (err) {
        console.error('Error deleting guard:', err);
        showNotification('Failed to delete guard: ' + getErrorMessage(err), 'error');
      }
    }
  }, [userProfile]);

  // ===== EXPORT =====
  const handleExport = useCallback(async () => {
    if (filtered.length === 0) {
      showNotification('No security personnel to export', 'error');
      return;
    }
    
    const csv = [
      ['Guard ID', 'Full Name', 'Employee #', 'Position', 'Company', 'Workstation', 'Shift', 'Supervisor', 'Status', 'Phone', 'Uniform', 'Uniform Condition', 'Shoes', 'License', 'Emergency Contact', 'Emergency Phone'],
      ...filtered.map(g => [
        g.guardId,
        g.full_name,
        g.employee_number,
        g.position,
        g.company || '',
        g.workstation || '',
        g.shift || '',
        g.supervisor || '',
        g.status,
        g.phone || '',
        g.uniform_status || '',
        g.uniform_condition || '',
        g.shoes_status || '',
        g.licenseStatus || '',
        g.emergency_contact || '',
        g.emergency_phone || ''
      ])
    ].map(toCsvRow).join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `security_personnel_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showNotification(`Exported ${filtered.length} security personnel`, 'success');
    
    await logAudit({
      action: 'EXPORT',
      entity_type: 'security_guard',
      new_data: {
        export_type: 'security_personnel',
        count: filtered.length
      },
      region_id: userProfile?.region_id
    });
  }, [filtered, userProfile]);

  // ===== RESET FILTERS =====
  const resetFilters = useCallback(() => {
    setSearch('');
    setFilterShift('all');
    setFilterStatus('all');
    setFilterUniform('all');
    setCurrentPage(1);
  }, []);

  // ===== RENDER =====
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="w-12 h-12 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-slate-500">Loading security personnel...</p>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="text-center py-12">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
          <AlertCircle size={32} className="text-red-500" />
        </div>
        <h3 className="text-lg font-semibold text-slate-800 mb-2">Error Loading Security Personnel</h3>
        <p className="text-slate-500">{fetchError}</p>
        <Button variant="secondary" className="mt-4" onClick={refreshData}>
          <RefreshCw size={16} className="mr-1" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Security Personnel Management"
        subtitle={isSuperAdmin ? "Manage guards, supervisors, uniforms, and deployments" : `${userRegion?.name || ''} Region - Security Management`}
        actions={
          <>
            <Button variant="outline" onClick={handleExport}><Download size={16} /> Export</Button>
            {canCreateGuard && (
              <Button variant="secondary" onClick={() => setShowAddModal(true)}><UserPlus size={16} /> Add Guard</Button>
            )}
            <Button variant="outline" onClick={refreshData}><RefreshCw size={16} className="mr-1" /> Refresh</Button>
          </>
        }
      />

      {!isSuperAdmin && userRegion && (
        <Card className="p-3 bg-gradient-to-r from-[#081C3A]/5 to-transparent border-[#081C3A]/20">
          <p className="text-sm text-slate-600">
            Managing security personnel in <strong className="text-[#081C3A]">{userRegion.name}</strong> region
          </p>
        </Card>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Card className="p-3 text-center">
          <p className="text-xs text-slate-500">Total</p>
          <p className="text-xl font-bold text-slate-800">{stats.total}</p>
        </Card>
        <Card className="p-3 text-center bg-emerald-50">
          <p className="text-xs text-emerald-600">Active</p>
          <p className="text-xl font-bold text-emerald-700">{stats.active}</p>
        </Card>
        <Card className="p-3 text-center bg-yellow-50">
          <p className="text-xs text-yellow-600">On Leave</p>
          <p className="text-xl font-bold text-yellow-700">{stats.onLeave}</p>
        </Card>
        <Card className="p-3 text-center bg-red-50">
          <p className="text-xs text-red-600">Suspended</p>
          <p className="text-xl font-bold text-red-700">{stats.suspended}</p>
        </Card>
        <Card className="p-3 text-center bg-blue-50">
          <p className="text-xs text-blue-600">Uniform Issued</p>
          <p className="text-xl font-bold text-blue-700">{stats.uniformIssued}</p>
        </Card>
        <Card className="p-3 text-center bg-amber-50">
          <p className="text-xs text-amber-600">Licenses Valid</p>
          <p className="text-xl font-bold text-amber-700">{stats.licenseValid}</p>
        </Card>
      </div>

      {/* Shift Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-2 text-center bg-slate-50">
          <p className="text-xs text-slate-500">Morning</p>
          <p className="text-lg font-bold text-slate-800">{stats.morning}</p>
        </Card>
        <Card className="p-2 text-center bg-slate-50">
          <p className="text-xs text-slate-500">Afternoon</p>
          <p className="text-lg font-bold text-slate-800">{stats.afternoon}</p>
        </Card>
        <Card className="p-2 text-center bg-slate-50">
          <p className="text-xs text-slate-500">Night</p>
          <p className="text-lg font-bold text-slate-800">{stats.night}</p>
        </Card>
        <Card className="p-2 text-center bg-slate-50">
          <p className="text-xs text-slate-500">Sites</p>
          <p className="text-lg font-bold text-slate-800">{stats.sites}</p>
        </Card>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              id="searchSecurity"
              name="searchSecurity"
              type="text"
              value={search} 
              onChange={e => setSearch(e.target.value)} 
              placeholder="Search guards..." 
              className="w-full pl-10 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            />
          </div>
          <select
            id="filterShift"
            name="filterShift"
            value={filterShift}
            onChange={e => setFilterShift(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
          >
            <option value="all">All Shifts</option>
            {shiftsList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            id="filterStatus"
            name="filterStatus"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
          >
            <option value="all">All Status</option>
            {guardStatusList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            id="filterUniform"
            name="filterUniform"
            value={filterUniform}
            onChange={e => setFilterUniform(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
          >
            <option value="all">All Uniform</option>
            {uniformStatusList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button variant="outline" onClick={resetFilters} className="text-sm">
            <RefreshCw size={14} className="mr-1" /> Clear Filters
          </Button>
        </div>
      </Card>

      {/* Table */}
      {securityData.length === 0 ? (
        <Card className="p-12 text-center">
          <Shield size={48} className="mx-auto text-slate-300 mb-4" />
          <h3 className="text-lg font-semibold text-slate-800 mb-2">No Security Personnel Found</h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            {canCreateGuard
              ? 'There are no security personnel records available. Click "Add Guard" to create your first record.'
              : 'There are no security personnel records available.'}
          </p>
          {canCreateGuard && (
            <Button variant="secondary" className="mt-4" onClick={() => setShowAddModal(true)}>
              <UserPlus size={16} className="mr-1" /> Add Guard
            </Button>
          )}
        </Card>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <THead>
                  <TR hover={false}>
                    <TH>Guard</TH>
                    <TH>Guard ID</TH>
                    <TH className="hidden lg:table-cell">Company</TH>
                    <TH className="hidden md:table-cell">Workstation</TH>
                    <TH className="hidden md:table-cell">Shift</TH>
                    <TH className="hidden lg:table-cell">Uniform</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {paginatedData.map((emp) => (
                    <TR key={emp.id} className="hover:bg-slate-50">
                      <TD>
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-[#081C3A] text-white text-xs font-bold flex items-center justify-center">
                            <Shield size={14} />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-slate-800">{emp.full_name}</p>
                            <p className="text-xs text-slate-500">{emp.position}</p>
                          </div>
                        </div>
                      </TD>
                      <TD className="font-mono text-xs">{emp.guardId || emp.employee_number}</TD>
                      <TD className="hidden lg:table-cell text-xs">{emp.company || '-'}</TD>
                      <TD className="hidden md:table-cell text-xs">{emp.workstation || '-'}</TD>
                      <TD className="hidden md:table-cell text-xs">
                        <Badge color={
                          emp.shift?.includes('Morning') ? 'blue' :
                          emp.shift?.includes('Afternoon') ? 'gold' :
                          emp.shift?.includes('Night') ? 'navy' : 'gray'
                        }>
                          {emp.shift || '-'}
                        </Badge>
                      </TD>
                      <TD className="hidden lg:table-cell">
                        <Badge color={
                          emp.uniform_status === 'Issued' ? 'green' :
                          emp.uniform_status === 'Pending' ? 'yellow' :
                          emp.uniform_status === 'Damaged' ? 'red' : 'gray'
                        }>
                          {emp.uniform_status || 'N/A'}
                        </Badge>
                      </TD>
                      <TD>
                        <Badge color={
                          emp.status === 'Active' ? 'green' :
                          emp.status === 'On Leave' ? 'yellow' :
                          emp.status === 'Suspended' ? 'red' : 'gray'
                        }>
                          {emp.status}
                        </Badge>
                      </TD>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          <button 
                            type="button"
                            onClick={() => handleView(emp)} 
                            className="w-7 h-7 rounded-lg hover:bg-slate-100 text-blue-600 flex items-center justify-center"
                            title="View Details"
                          >
                            <Eye size={14} />
                          </button>
                          {canEditGuard && (
                            <button
                              type="button"
                              onClick={() => handleEdit(emp)}
                              className="w-7 h-7 rounded-lg hover:bg-slate-100 text-amber-600 flex items-center justify-center"
                              title="Edit"
                            >
                              <Edit2 size={14} />
                            </button>
                          )}
                          {canDeleteGuard && (
                            <button
                              type="button"
                              onClick={() => handleDelete(emp)}
                              className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center"
                              title="Delete"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </TR>
                  ))}
                </TBody>
              </table>
            </div>
          </div>

          <Pagination
            currentPage={currentPage}
            totalPages={Math.ceil(filtered.length / itemsPerPage)}
            totalItems={filtered.length}
            itemsPerPage={itemsPerPage}
            onPageChange={setCurrentPage}
            onItemsPerPageChange={setItemsPerPage}
          />
        </>
      )}

      {/* ===== ADD GUARD MODAL ===== */}
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add Security Guard" size="xl">
        <AddGuardForm 
          onAdd={handleAddGuard} 
          onCancel={() => setShowAddModal(false)}
          shiftsList={shiftsList}
          supervisorsList={supervisorsList}
          uniformStatusList={uniformStatusList}
          uniformConditionList={uniformConditionList}
          shoesStatusList={shoesStatusList}
          licenseStatusList={licenseStatusList}
          guardStatusList={guardStatusList}
          userRegion={userRegion}
          isSuperAdmin={isSuperAdmin}
        />
      </Modal>

      {/* ===== EDIT GUARD MODAL ===== */}
      <Modal open={showEditModal} onClose={() => { setShowEditModal(false); setEditingItem(null); }} title="Edit Security Guard" size="xl">
        {editingItem && (
          <EditGuardForm 
            guard={editingItem}
            onSave={saveEdit} 
            onCancel={() => { setShowEditModal(false); setEditingItem(null); }}
            shiftsList={shiftsList}
            uniformStatusList={uniformStatusList}
            uniformConditionList={uniformConditionList}
            shoesStatusList={shoesStatusList}
            licenseStatusList={licenseStatusList}
            guardStatusList={guardStatusList}
          />
        )}
      </Modal>

      {/* ===== VIEW GUARD MODAL ===== */}
      <Modal open={showViewModal} onClose={() => { setShowViewModal(false); setViewingItem(null); }} title="Guard Details" size="lg">
        {viewingItem && <ViewGuard guard={viewingItem} onClose={() => { setShowViewModal(false); setViewingItem(null); }} />}
      </Modal>
    </div>
  );
}

// ===== ADD GUARD FORM =====
function AddGuardForm({ onAdd, onCancel, shiftsList, supervisorsList, uniformStatusList, uniformConditionList, shoesStatusList, licenseStatusList, guardStatusList, userRegion, isSuperAdmin }: {
  onAdd: (guard: GuardFormData) => void;
  onCancel: () => void;
  shiftsList: string[];
  supervisorsList: string[];
  uniformStatusList: string[];
  uniformConditionList: string[];
  shoesStatusList: string[];
  licenseStatusList: string[];
  guardStatusList: string[];
  userRegion?: UserProfileRegion | null;
  isSuperAdmin?: boolean;
}) {
  const [formData, setFormData] = useState<GuardFormData>({
    employee_id: '',
    full_name: '',
    employee_number: '',
    position: 'Security Guard',
    status: 'Active',
    phone: '',
    company: '',
    workstation: '',
    shift: shiftsList[0],
    supervisor: supervisorsList[0],
    uniform_status: 'Pending',
    uniform_condition: 'Good',
    shoes_status: 'Good',
    licenseStatus: 'Valid',
    license_expiry: '',
    emergency_contact: '',
    emergency_phone: '',
    guardId: '',
    is_existing_employee: false
  });

  const [employeeSearch, setEmployeeSearch] = useState('');
  const [showEmployeeDropdown, setShowEmployeeDropdown] = useState(false);
  const [filteredEmployees, setFilteredEmployees] = useState<EmployeeSearchResult[]>([]);
  const [allEmployees, setAllEmployees] = useState<EmployeeSearchResult[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeSearchResult | null>(null);
  const [supervisorSearch, setSupervisorSearch] = useState('');
  const [filteredSupervisors, setFilteredSupervisors] = useState<SupervisorSearchResult[]>([]);
  const [showSupervisorDropdown, setShowSupervisorDropdown] = useState(false);
  const supervisorDropdownRef = useRef<HTMLDivElement>(null);
  const [allSupervisors, setAllSupervisors] = useState<SupervisorSearchResult[]>([]);
  const [positionOptions, setPositionOptions] = useState<string[]>([]);

  // Fetch all employees for search (excluding deleted)
  useEffect(() => {
    const fetchEmployees = async () => {
      setLoadingEmployees(true);
      try {
        const { data, error } = await supabase
          .from('employees')
          .select('id, full_name, employee_number, position, phone, company, workstation, status, region_id')
          .eq('is_deleted', false)
          .order('full_name');

        if (error) throw error;
        setAllEmployees(data || []);
      } catch (err) {
        console.error('Error fetching employees:', err);
      } finally {
        setLoadingEmployees(false);
      }
    };
    fetchEmployees();
  }, []);

  // ===== FETCH POSITIONS (only the ones eligible for this page -- same
  // "Requires Uniform" flag the security personnel list itself filters by,
  // so a position selected here can never disappear from the list after
  // saving) =====
  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const { data, error } = await supabase
          .from('positions')
          .select('name, requires_uniform')
          .eq('is_active', true)
          .order('name');
        if (error) throw error;
        const eligible = (data || [])
          .filter(p => p.requires_uniform !== false)
          .map(p => p.name);
        setPositionOptions(eligible.length > 0 ? eligible : ['Security Guard', 'Patrol Officer', 'Supervisor', 'K9 Handler']);
      } catch (err) {
        console.error('Error fetching positions:', err);
        setPositionOptions(['Security Guard', 'Patrol Officer', 'Supervisor', 'K9 Handler']);
      }
    };
    fetchPositions();
  }, []);

  // ===== FETCH SUPERVISORS (only employees with supervisor positions) =====
  useEffect(() => {
    const fetchSupervisors = async () => {
      try {
        const { data, error } = await supabase
          .from('employees')
          .select('id, full_name, employee_number, position')
          .eq('is_deleted', false)
          .or('position.ilike.%supervisor%,position.ilike.%manager%,position.ilike.%lead%')
          .order('full_name');
        
        if (error) throw error;
        setAllSupervisors(data || []);
      } catch (err) {
        console.error('Error fetching supervisors:', err);
      }
    };
    fetchSupervisors();
  }, []);

  // Filter supervisors based on search
  useEffect(() => {
    if (supervisorSearch.trim() === '') {
      setFilteredSupervisors(allSupervisors);
      return;
    }
    
    const searchLower = supervisorSearch.toLowerCase().trim();
    const filtered = allSupervisors.filter((sup: SupervisorSearchResult) => {
      const fullName = (sup.full_name || '').toLowerCase();
      const employeeNumber = (sup.employee_number || '').toLowerCase();
      const position = (sup.position || '').toLowerCase();
      
      return fullName.includes(searchLower) ||
             employeeNumber.includes(searchLower) ||
             position.includes(searchLower);
    });
    
    setFilteredSupervisors(filtered.slice(0, 15));
  }, [supervisorSearch, allSupervisors]);

  // Filter employees based on search
  useEffect(() => {
    if (employeeSearch.trim() === '') {
      setFilteredEmployees([]);
      return;
    }
    
    const searchLower = employeeSearch.toLowerCase().trim();
    const filtered = allEmployees.filter((emp: EmployeeSearchResult) => {
      const fullName = (emp.full_name || '').toLowerCase();
      const employeeNumber = (emp.employee_number || '').toLowerCase();
      const position = (emp.position || '').toLowerCase();
      
      return fullName.includes(searchLower) ||
             employeeNumber.includes(searchLower) ||
             position.includes(searchLower);
    });
    
    setFilteredEmployees(filtered.slice(0, 15));
  }, [employeeSearch, allEmployees]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowEmployeeDropdown(false);
      }
      if (supervisorDropdownRef.current && !supervisorDropdownRef.current.contains(event.target as Node)) {
        setShowSupervisorDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ===== GENERATE GUARD ID =====
  // Reserves a real, database-generated guard ID as soon as the form
  // opens (generateGuardIdServerSide() falls back to the old client-side
  // random generator if the RPC isn't available yet -- see
  // guardIdGeneration.ts -- so this never blocks the form from working).
  useEffect(() => {
    if (!formData.guardId) {
      generateGuardIdServerSide().then((guardId) => {
        setFormData((prev) => (prev.guardId ? prev : { ...prev, guardId }));
      });
    }
  }, [formData.guardId]);

  // Select employee from dropdown - auto-fill form
  const selectEmployee = (employee: EmployeeSearchResult) => {
    setSelectedEmployee(employee);
    setFormData({
      ...formData,
      employee_id: employee.id,
      full_name: employee.full_name || '',
      employee_number: employee.employee_number || '',
      position: employee.position || 'Security Guard',
      phone: employee.phone || '',
      company: employee.company || '',
      workstation: employee.workstation || '',
      is_existing_employee: true,
      status: employee.status || 'Active'
    });
    setEmployeeSearch(employee.full_name || '');
    setShowEmployeeDropdown(false);
  };

  // Clear selected employee
  const clearSelectedEmployee = () => {
    setSelectedEmployee(null);
    setEmployeeSearch('');
    setFormData({
      ...formData,
      employee_id: '',
      full_name: '',
      employee_number: '',
      position: 'Security Guard',
      phone: '',
      company: '',
      workstation: '',
      is_existing_employee: false,
      status: 'Active'
    });
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  // Select supervisor from dropdown
  const selectSupervisor = (supervisor: SupervisorSearchResult) => {
    setFormData(prev => ({ ...prev, supervisor: supervisor.full_name || '' }));
    setSupervisorSearch(supervisor.full_name || '');
    setShowSupervisorDropdown(false);
  };

  // Clear selected supervisor
  const clearSupervisor = () => {
    setSupervisorSearch('');
    setFormData(prev => ({ ...prev, supervisor: supervisorsList[0] }));
    setShowSupervisorDropdown(false);
  };

  const updateForm = <K extends keyof GuardFormData>(field: K, value: GuardFormData[K]) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="space-y-4">
      {!isSuperAdmin && userRegion && (
        <div className="p-3 rounded-lg bg-[#E8EDF5] text-sm text-slate-700">
          Adding guard to <strong>{userRegion.name}</strong> region
        </div>
      )}
      
      {/* Searchable Employee Selector */}
      <div>
        <label htmlFor="employeeSearch" className="block text-sm font-medium text-slate-700 mb-1.5">
          Search Employee <span className="text-xs text-slate-400">(Type to search existing employees)</span>
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
                  clearSelectedEmployee();
                }
              }}
              onFocus={() => {
                if (employeeSearch.trim() !== '') {
                  setShowEmployeeDropdown(true);
                }
              }}
              placeholder="Search by name, employee #, or position..."
              className="w-full pl-10 pr-10 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] focus:border-transparent"
            />
            {selectedEmployee && (
              <button
                type="button"
                onClick={clearSelectedEmployee}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X size={16} />
              </button>
            )}
          </div>
          
          {/* Dropdown results */}
          {showEmployeeDropdown && employeeSearch.trim() !== '' && (
            <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
              {loadingEmployees ? (
                <div className="px-4 py-3 text-sm text-slate-500 text-center">
                  <div className="w-5 h-5 border-2 border-[#D4A017] border-t-transparent rounded-full animate-spin mx-auto mb-1" />
                  Loading employees...
                </div>
              ) : filteredEmployees.length === 0 ? (
                <div className="px-4 py-3 text-sm text-slate-500 text-center">
                  No employees found matching "{employeeSearch}"
                  <button
                    type="button"
                    onClick={() => {
                      setShowEmployeeDropdown(false);
                      setFormData({
                        ...formData,
                        full_name: employeeSearch,
                        is_existing_employee: false
                      });
                    }}
                    className="block mt-2 text-[#D4A017] hover:underline text-xs"
                  >
                    Add "{employeeSearch}" as new guard
                  </button>
                </div>
              ) : (
                filteredEmployees.map((emp: EmployeeSearchResult) => (
                  <button
                    key={emp.id}
                    type="button"
                    onClick={() => selectEmployee(emp)}
                    className="w-full text-left px-4 py-2.5 hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors flex items-center gap-3"
                  >
                    <div className="w-8 h-8 rounded-full bg-[#081C3A] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                      {((emp.full_name || 'U').split(' ').map((n: string) => n[0]).join('').slice(0, 2)).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{emp.full_name || 'Unknown'}</p>
                      <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                        <span>{emp.employee_number || 'N/A'}</span>
                        <span className="w-1 h-1 rounded-full bg-slate-300" />
                        <span>{emp.position || 'N/A'}</span>
                        {emp.company && (
                          <>
                            <span className="w-1 h-1 rounded-full bg-slate-300" />
                            <span>{emp.company}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-slate-400">
                      {emp.workstation || 'No site'}
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
            <span className="text-emerald-700">
              Selected: <strong>{selectedEmployee.full_name}</strong> 
              ({selectedEmployee.employee_number}) - {selectedEmployee.position}
            </span>
          </div>
        )}
        {!selectedEmployee && employeeSearch && (
          <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-sm flex items-center gap-2">
            <AlertCircle size={16} className="text-amber-600" />
            <span className="text-amber-700">
              Creating new guard: <strong>{employeeSearch}</strong>
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Full Name *</label>
          <input 
            type="text"
            value={formData.full_name} 
            onChange={(e) => updateForm('full_name', e.target.value)} 
            required 
            disabled={!!selectedEmployee}
            className={`w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] ${selectedEmployee ? 'bg-slate-50' : ''}`}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Employee Number</label>
          <input 
            type="text"
            value={formData.employee_number} 
            onChange={(e) => updateForm('employee_number', e.target.value)} 
            disabled={!!selectedEmployee}
            className={`w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] ${selectedEmployee ? 'bg-slate-50' : ''}`}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Guard ID</label>
          <input 
            type="text"
            value={formData.guardId} 
            onChange={(e) => updateForm('guardId', e.target.value)} 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            placeholder="Auto-generated"
          />
          <p className="text-xs text-slate-400 mt-1">Auto-generated if left empty</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Phone</label>
          <input 
            type="text"
            value={formData.phone} 
            onChange={(e) => updateForm('phone', e.target.value)} 
            disabled={!!selectedEmployee}
            className={`w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] ${selectedEmployee ? 'bg-slate-50' : ''}`}
          />
        </div>
        
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Position</label>
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.position} 
            onChange={(e) => updateForm('position', e.target.value)}
            disabled={!!selectedEmployee}
          >
            {(positionOptions.includes(formData.position) ? positionOptions : [formData.position, ...positionOptions]).map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Status</label>
          <select
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            value={formData.status} 
            onChange={(e) => updateForm('status', e.target.value)}
          >
            {guardStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Company</label>
          <input 
            type="text"
            value={formData.company} 
            onChange={(e) => updateForm('company', e.target.value)} 
            disabled={!!selectedEmployee}
            className={`w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] ${selectedEmployee ? 'bg-slate-50' : ''}`}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Workstation / Site</label>
          <input 
            type="text"
            value={formData.workstation} 
            onChange={(e) => updateForm('workstation', e.target.value)} 
            disabled={!!selectedEmployee}
            className={`w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] ${selectedEmployee ? 'bg-slate-50' : ''}`}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Shift</label>
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.shift} 
            onChange={(e) => updateForm('shift', e.target.value)}
          >
            {shiftsList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Supervisor</label>
          <div className="relative" ref={supervisorDropdownRef}>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={supervisorSearch}
                onChange={(e) => {
                  setSupervisorSearch(e.target.value);
                  setShowSupervisorDropdown(true);
                  if (e.target.value === '') {
                    setFormData(prev => ({ ...prev, supervisor: '' }));
                  }
                }}
                onFocus={() => {
                  if (supervisorSearch.trim() !== '' || allSupervisors.length > 0) {
                    setShowSupervisorDropdown(true);
                  }
                }}
                placeholder="Search supervisors..."
                className="w-full pl-10 pr-10 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] focus:border-transparent"
              />
              {supervisorSearch && (
                <button
                  type="button"
                  onClick={clearSupervisor}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X size={16} />
                </button>
              )}
            </div>
            
            {/* Supervisor dropdown results */}
            {showSupervisorDropdown && (
              <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                {filteredSupervisors.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-slate-500 text-center">
                    No supervisors found matching "{supervisorSearch}"
                    <button
                      type="button"
                      onClick={() => {
                        setShowSupervisorDropdown(false);
                        setFormData(prev => ({ ...prev, supervisor: supervisorSearch }));
                      }}
                      className="block mt-2 text-[#D4A017] hover:underline text-xs"
                    >
                      Add "{supervisorSearch}" as supervisor
                    </button>
                  </div>
                ) : (
                  filteredSupervisors.map((sup: SupervisorSearchResult) => (
                    <button
                      key={sup.id}
                      type="button"
                      onClick={() => selectSupervisor(sup)}
                      className="w-full text-left px-4 py-2.5 hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors flex items-center gap-3"
                    >
                      <div className="w-8 h-8 rounded-full bg-[#D4A017] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                        {((sup.full_name || 'S').split(' ').map((n: string) => n[0]).join('').slice(0, 2)).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{sup.full_name || 'Unknown'}</p>
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <span>{sup.employee_number || 'N/A'}</span>
                          <span className="w-1 h-1 rounded-full bg-slate-300" />
                          <span>{sup.position || 'N/A'}</span>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {formData.supervisor && !supervisorSearch && (
            <div className="mt-1 p-1.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs flex items-center gap-2">
              <CheckCircle size={14} className="text-emerald-600" />
              <span className="text-emerald-700">Selected: <strong>{formData.supervisor}</strong></span>
            </div>
          )}
        </div>
      </div>

      {/* Uniform & Equipment Section */}
      <div className="border-t pt-4">
        <h4 className="font-semibold text-slate-800 mb-3 text-sm flex items-center gap-2">
          <Shirt size={16} className="text-[#D4A017]" /> Uniform & Equipment
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Uniform Status</label>
            <select 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
              value={formData.uniform_status} 
              onChange={(e) => updateForm('uniform_status', e.target.value)}
            >
              {uniformStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Uniform Condition</label>
            <select 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
              value={formData.uniform_condition} 
              onChange={(e) => updateForm('uniform_condition', e.target.value)}
            >
              {uniformConditionList.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Shoes Status</label>
            <select 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
              value={formData.shoes_status} 
              onChange={(e) => updateForm('shoes_status', e.target.value)}
            >
              {shoesStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">License Status</label>
            <select 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
              value={formData.licenseStatus} 
              onChange={(e) => updateForm('licenseStatus', e.target.value)}
            >
              {licenseStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        {/* ===== REMOVED: License Expiry Date field ===== */}
      </div>

      {/* Emergency Contact */}
      <div className="border-t pt-4">
        <h4 className="font-semibold text-slate-800 mb-3 text-sm flex items-center gap-2">
          <User size={16} className="text-[#D4A017]" /> Emergency Contact
        </h4>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Contact Name</label>
            <input 
              type="text"
              value={formData.emergency_contact} 
              onChange={(e) => updateForm('emergency_contact', e.target.value)} 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Contact Phone</label>
            <input 
              type="text"
              value={formData.emergency_phone} 
              onChange={(e) => updateForm('emergency_phone', e.target.value)} 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-4 border-t">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button variant="secondary" onClick={() => onAdd(formData)} disabled={!formData.full_name}>
          <UserPlus size={14} className="mr-1" /> {selectedEmployee ? 'Add as Guard' : 'Add Guard'}
        </Button>
      </div>
    </div>
  );
}

// ===== EDIT GUARD FORM =====
function EditGuardForm({ guard, onSave, onCancel, shiftsList, uniformStatusList, uniformConditionList, shoesStatusList, licenseStatusList, guardStatusList }: {
  guard: SecurityPersonnel;
  onSave: (guard: SecurityPersonnel) => void;
  onCancel: () => void;
  shiftsList: string[];
  uniformStatusList: string[];
  uniformConditionList: string[];
  shoesStatusList: string[];
  licenseStatusList: string[];
  guardStatusList: string[];
}) {
  const [formData, setFormData] = useState<SecurityPersonnel>(guard);
  const [supervisorSearch, setSupervisorSearch] = useState(guard.supervisor || '');
  const [filteredSupervisors, setFilteredSupervisors] = useState<SupervisorSearchResult[]>([]);
  const [allSupervisors, setAllSupervisors] = useState<SupervisorSearchResult[]>([]);
  const [showSupervisorDropdown, setShowSupervisorDropdown] = useState(false);
  const supervisorDropdownRef = useRef<HTMLDivElement>(null);
  const [positionOptions, setPositionOptions] = useState<string[]>([]);

  // Fetch supervisors
  useEffect(() => {
    const fetchSupervisors = async () => {
      try {
        const { data, error } = await supabase
          .from('employees')
          .select('id, full_name, employee_number, position')
          .eq('is_deleted', false)
          .or('position.ilike.%supervisor%,position.ilike.%manager%,position.ilike.%lead%')
          .order('full_name');

        if (error) throw error;
        setAllSupervisors(data || []);
      } catch (err) {
        console.error('Error fetching supervisors:', err);
      }
    };
    fetchSupervisors();
  }, []);

  // Fetch positions eligible for this page (same "Requires Uniform" flag the
  // security personnel list itself filters by, so a position selected here
  // can never disappear from the list after saving)
  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const { data, error } = await supabase
          .from('positions')
          .select('name, requires_uniform')
          .eq('is_active', true)
          .order('name');
        if (error) throw error;
        const eligible = (data || [])
          .filter(p => p.requires_uniform !== false)
          .map(p => p.name);
        setPositionOptions(eligible.length > 0 ? eligible : ['Security Guard', 'Patrol Officer', 'Supervisor', 'K9 Handler']);
      } catch (err) {
        console.error('Error fetching positions:', err);
        setPositionOptions(['Security Guard', 'Patrol Officer', 'Supervisor', 'K9 Handler']);
      }
    };
    fetchPositions();
  }, []);

  // Filter supervisors based on search
  useEffect(() => {
    if (supervisorSearch.trim() === '') {
      setFilteredSupervisors(allSupervisors);
      return;
    }
    
    const searchLower = supervisorSearch.toLowerCase().trim();
    const filtered = allSupervisors.filter((sup: SupervisorSearchResult) => {
      const fullName = (sup.full_name || '').toLowerCase();
      const employeeNumber = (sup.employee_number || '').toLowerCase();
      const position = (sup.position || '').toLowerCase();
      
      return fullName.includes(searchLower) ||
             employeeNumber.includes(searchLower) ||
             position.includes(searchLower);
    });
    
    setFilteredSupervisors(filtered.slice(0, 15));
  }, [supervisorSearch, allSupervisors]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (supervisorDropdownRef.current && !supervisorDropdownRef.current.contains(event.target as Node)) {
        setShowSupervisorDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Select supervisor from dropdown
  const selectSupervisor = (supervisor: SupervisorSearchResult) => {
    setFormData({ ...formData, supervisor: supervisor.full_name || '' });
    setSupervisorSearch(supervisor.full_name || '');
    setShowSupervisorDropdown(false);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Full Name *</label>
          <input 
            type="text"
            value={formData.full_name} 
            onChange={(e) => setFormData({...formData, full_name: e.target.value})} 
            required 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Employee Number</label>
          <input 
            type="text"
            value={formData.employee_number} 
            onChange={(e) => setFormData({...formData, employee_number: e.target.value})} 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Guard ID</label>
          <input 
            type="text"
            value={formData.guardId} 
            onChange={(e) => setFormData({...formData, guardId: e.target.value})} 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Phone</label>
          <input 
            type="text"
            value={formData.phone} 
            onChange={(e) => setFormData({...formData, phone: e.target.value})} 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          />
        </div>
        
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Position</label>
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.position}
            onChange={(e) => setFormData({...formData, position: e.target.value})}
          >
            {(positionOptions.includes(formData.position) ? positionOptions : [formData.position, ...positionOptions]).map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Status</label>
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.status} 
            onChange={(e) => setFormData({...formData, status: e.target.value})}
          >
            {guardStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Company</label>
          <input 
            type="text"
            value={formData.company} 
            onChange={(e) => setFormData({...formData, company: e.target.value})} 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Workstation / Site</label>
          <input 
            type="text"
            value={formData.workstation} 
            onChange={(e) => setFormData({...formData, workstation: e.target.value})} 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Shift</label>
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.shift} 
            onChange={(e) => setFormData({...formData, shift: e.target.value})}
          >
            {shiftsList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Supervisor</label>
          <div className="relative" ref={supervisorDropdownRef}>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={supervisorSearch}
                onChange={(e) => {
                  setSupervisorSearch(e.target.value);
                  setShowSupervisorDropdown(true);
                  if (e.target.value === '') {
                    setFormData({ ...formData, supervisor: '' });
                  }
                }}
                onFocus={() => {
                  if (supervisorSearch.trim() !== '' || allSupervisors.length > 0) {
                    setShowSupervisorDropdown(true);
                  }
                }}
                placeholder="Search supervisors..."
                className="w-full pl-10 pr-10 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A] focus:border-transparent"
              />
            </div>
            
            {/* Supervisor dropdown results */}
            {showSupervisorDropdown && (
              <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                {filteredSupervisors.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-slate-500 text-center">
                    No supervisors found matching "{supervisorSearch}"
                    <button
                      type="button"
                      onClick={() => {
                        setShowSupervisorDropdown(false);
                        setFormData({ ...formData, supervisor: supervisorSearch });
                      }}
                      className="block mt-2 text-[#D4A017] hover:underline text-xs"
                    >
                      Add "{supervisorSearch}" as supervisor
                    </button>
                  </div>
                ) : (
                  filteredSupervisors.map((sup: SupervisorSearchResult) => (
                    <button
                      key={sup.id}
                      type="button"
                      onClick={() => selectSupervisor(sup)}
                      className="w-full text-left px-4 py-2.5 hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors flex items-center gap-3"
                    >
                      <div className="w-8 h-8 rounded-full bg-[#D4A017] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                        {((sup.full_name || 'S').split(' ').map((n: string) => n[0]).join('').slice(0, 2)).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{sup.full_name || 'Unknown'}</p>
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <span>{sup.employee_number || 'N/A'}</span>
                          <span className="w-1 h-1 rounded-full bg-slate-300" />
                          <span>{sup.position || 'N/A'}</span>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {formData.supervisor && !supervisorSearch && (
            <div className="mt-1 p-1.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs flex items-center gap-2">
              <CheckCircle size={14} className="text-emerald-600" />
              <span className="text-emerald-700">Selected: <strong>{formData.supervisor}</strong></span>
            </div>
          )}
        </div>
      </div>

      <div className="border-t pt-4">
        <h4 className="font-semibold text-slate-800 mb-3 text-sm flex items-center gap-2">
          <Shirt size={16} className="text-[#D4A017]" /> Uniform & Equipment
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Uniform Status</label>
            <select 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
              value={formData.uniform_status} 
              onChange={(e) => setFormData({...formData, uniform_status: e.target.value})}
            >
              {uniformStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Uniform Condition</label>
            <select 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
              value={formData.uniform_condition} 
              onChange={(e) => setFormData({...formData, uniform_condition: e.target.value})}
            >
              {uniformConditionList.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Shoes Status</label>
            <select 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
              value={formData.shoes_status} 
              onChange={(e) => setFormData({...formData, shoes_status: e.target.value})}
            >
              {shoesStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">License Status</label>
            <select 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
              value={formData.licenseStatus} 
              onChange={(e) => setFormData({...formData, licenseStatus: e.target.value})}
            >
              {licenseStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        {/* ===== REMOVED: License Expiry Date field ===== */}
      </div>

      <div className="border-t pt-4">
        <h4 className="font-semibold text-slate-800 mb-3 text-sm flex items-center gap-2">
          <User size={16} className="text-[#D4A017]" /> Emergency Contact
        </h4>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Contact Name</label>
            <input 
              type="text"
              value={formData.emergency_contact} 
              onChange={(e) => setFormData({...formData, emergency_contact: e.target.value})} 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Contact Phone</label>
            <input 
              type="text"
              value={formData.emergency_phone} 
              onChange={(e) => setFormData({...formData, emergency_phone: e.target.value})} 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-4 border-t">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button variant="secondary" onClick={() => onSave(formData)}>
          <Save size={14} className="mr-1" /> Save Changes
        </Button>
      </div>
    </div>
  );
}

// ===== VIEW GUARD =====
function ViewGuard({ guard, onClose }: { guard: SecurityPersonnel; onClose: () => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-[#081C3A] flex items-center justify-center text-white text-xl font-bold">
          {guard.full_name?.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
        </div>
        <div>
          <h3 className="text-xl font-bold text-slate-800">{guard.full_name}</h3>
          <p className="text-sm text-slate-500">{guard.position} · {guard.employee_number}</p>
          <div className="flex flex-wrap gap-2 mt-1">
            <Badge color={guard.status === 'Active' ? 'green' : guard.status === 'On Leave' ? 'yellow' : 'red'}>
              {guard.status}
            </Badge>
            <Badge color="navy">{guard.shift}</Badge>
            <Badge color="gold">{guard.guardId}</Badge>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div><p className="text-slate-500 text-xs">Phone</p><p className="font-medium">{guard.phone || 'N/A'}</p></div>
        <div><p className="text-slate-500 text-xs">Company</p><p className="font-medium">{guard.company || 'N/A'}</p></div>
        <div><p className="text-slate-500 text-xs">Workstation</p><p className="font-medium">{guard.workstation || 'N/A'}</p></div>
        <div><p className="text-slate-500 text-xs">Supervisor</p><p className="font-medium">{guard.supervisor || 'N/A'}</p></div>
      </div>

      <div className="border-t pt-4">
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Uniform & Equipment</h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div className="p-3 rounded-lg bg-slate-50">
            <p className="text-slate-500 text-xs">Uniform Status</p>
            <p className="font-medium">
              <Badge color={guard.uniform_status === 'Issued' ? 'green' : guard.uniform_status === 'Pending' ? 'yellow' : 'red'}>
                {guard.uniform_status || 'N/A'}
              </Badge>
            </p>
          </div>
          <div className="p-3 rounded-lg bg-slate-50">
            <p className="text-slate-500 text-xs">Uniform Condition</p>
            <p className="font-medium">{guard.uniform_condition || 'N/A'}</p>
          </div>
          <div className="p-3 rounded-lg bg-slate-50">
            <p className="text-slate-500 text-xs">Shoes Status</p>
            <p className="font-medium">{guard.shoes_status || 'N/A'}</p>
          </div>
          <div className="p-3 rounded-lg bg-slate-50">
            <p className="text-slate-500 text-xs">License</p>
            <p className="font-medium">
              <Badge color={guard.licenseStatus === 'Valid' ? 'green' : guard.licenseStatus === 'Expiring' ? 'yellow' : 'red'}>
                {guard.licenseStatus || 'N/A'}
              </Badge>
            </p>
          </div>
        </div>
      </div>

      <div className="border-t pt-4">
        <h4 className="font-semibold text-slate-800 mb-3 text-sm">Emergency Contact</h4>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><p className="text-slate-500 text-xs">Name</p><p className="font-medium">{guard.emergency_contact || 'N/A'}</p></div>
          <div><p className="text-slate-500 text-xs">Phone</p><p className="font-medium">{guard.emergency_phone || 'N/A'}</p></div>
        </div>
      </div>

      <div className="flex justify-end pt-4 border-t">
        <Button variant="outline" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

export default SecurityPage;