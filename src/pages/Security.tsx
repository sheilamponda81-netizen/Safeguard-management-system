import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
  Search, Shield, MapPin, Download, Edit2, Trash2, UserPlus, X, 
  ChevronLeft, ChevronRight, Calendar, Lock, AlertCircle, RefreshCw,
  Eye, CheckCircle, XCircle, Clock, User, Briefcase, Building2,
  Shirt, Footprints, HardHat, ClipboardList, Filter, ChevronDown
} from '../utils/icons';
import { Card, Button, Badge, THead, TBody, TR, TH, TD, Modal, PageHeader, Input } from '../components/ui';
import { supabase } from '../lib/supabase';
import { showNotification } from '../utils/clickHandlers';
import { logAudit } from '../utils/auditLogger';
import { Pagination } from '../components/Pagination';

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

interface Employee {
  id: string;
  full_name: string;
  employee_number: string;
  position: string;
  phone: string;
  company: string;
  workstation: string;
  status: string;
  region_id: string;
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
  const [userProfile, setUserProfile] = useState<any>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filterShift, setFilterShift] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterUniform, setFilterUniform] = useState('all');
  const [initialFetchDone, setInitialFetchDone] = useState(false);

  // ===== PAGINATION =====
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);

  // ===== REFS =====
  const isMounted = useRef(true);
  const fetchInProgress = useRef(false);

  // ===== SITES, SHIFTS, SUPERVISORS =====
  const sitesList = [
    'Reserve Bank of Malawi', 'Illovo Sugar HQ', 'NBS Bank Towers', 'Standard Bank Plaza',
    'Old Mutual Centre', 'Mzuzu Coffee Estates', 'Castel Brewery', 'Sunbird Capital Hotel'
  ];
  
  const shiftsList = ['Morning (06-14)', 'Afternoon (14-22)', 'Night (22-06)', '24hr Rotation'];
  const supervisorsList = ['William Banda', 'Agnes Phiri', 'John Mwanza', 'Felix Soko'];
  
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
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('*, regions(*)')
          .eq('id', user.id)
          .single();
        if (error) throw error;
        return profile;
      }
      return null;
    } catch (err) {
      console.error('Error fetching user profile:', err);
      return null;
    }
  }, []);

  // ===== FETCH SECURITY DATA =====
  const fetchSecurityData = useCallback(async () => {
    if (fetchInProgress.current) {
      console.log('Fetch already in progress, skipping...');
      return;
    }
    
    fetchInProgress.current = true;
    setLoading(true);
    setFetchError(null);
    
    try {
      let profile = userProfile;
      if (!profile) {
        profile = await fetchUserProfile();
        if (profile) {
          setUserProfile(profile);
        } else {
          setFetchError('Unable to load user profile');
          setLoading(false);
          fetchInProgress.current = false;
          return;
        }
      }
      
      console.log('Fetching security data for region:', profile?.region_id);
      
      let query = supabase
        .from('employees')
        .select('*')
        .or('position.ilike.%guard%,position.ilike.%security%,position.ilike.%officer%,position.ilike.%patrol%,position.ilike.%supervisor%');
      
      if (!profile?.is_super_admin && profile?.region_id) {
        query = query.eq('region_id', profile.region_id);
      }
      
      const { data, error } = await query.order('full_name');
      
      if (error) {
        console.error('Error fetching security data:', error);
        setFetchError('Database error: ' + error.message);
        setSecurityData([]);
        setLoading(false);
        fetchInProgress.current = false;
        return;
      }
      
      console.log('Security data fetched:', data?.length || 0, 'records');
      
      if (!data || data.length === 0) {
        setSecurityData([]);
        setLoading(false);
        fetchInProgress.current = false;
        setInitialFetchDone(true);
        return;
      }
      
      const enhancedData = data.map((emp: any, i: number) => ({
        id: emp.id,
        full_name: emp.full_name || '',
        employee_number: emp.employee_number || '',
        position: emp.position || 'Security Guard',
        status: emp.status || 'Active',
        phone: emp.phone || '',
        region_id: emp.region_id || '',
        company: emp.company || '',
        workstation: emp.workstation || '',
        shift: emp.shift || shiftsList[i % shiftsList.length],
        supervisor: emp.supervisor || supervisorsList[i % supervisorsList.length],
        uniform_status: emp.uniform_status || 'Pending',
        uniform_condition: emp.uniform_condition || 'Good',
        shoes_status: emp.shoes_status || 'Good',
        guardId: emp.guardId || `G-${String(100 + i).slice(1)}`,
        licenseStatus: emp.license_status || 'Valid',
        license_expiry: emp.license_expiry || '',
        emergency_contact: emp.next_of_kin_name || '',
        emergency_phone: emp.next_of_kin_phone || '',
        created_at: emp.created_at || new Date().toISOString()
      }));
      
      if (isMounted.current) {
        setSecurityData(enhancedData);
        setInitialFetchDone(true);
      }
    } catch (err: any) {
      console.error('Error in fetchSecurityData:', err);
      if (isMounted.current) {
        setFetchError('Failed to load security personnel: ' + (err.message || 'Unknown error'));
        setSecurityData([]);
      }
    } finally {
      if (isMounted.current) {
        setLoading(false);
      }
      fetchInProgress.current = false;
    }
  }, [userProfile, fetchUserProfile, shiftsList, supervisorsList]);

  // ===== INITIALIZATION - Run once on mount =====
  useEffect(() => {
    if (!initialFetchDone && !fetchInProgress.current) {
      fetchSecurityData();
    }
    
    return () => {
      isMounted.current = false;
    };
  }, []);

  // ===== REFRESH - Manual refresh function =====
  const refreshData = useCallback(() => {
    if (!fetchInProgress.current) {
      setInitialFetchDone(false);
      fetchSecurityData();
    }
  }, [fetchSecurityData]);

  // ===== ADD GUARD =====
  const handleAddGuard = useCallback(async (newGuard: any) => {
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
            guardId: newGuard.guardId || `G-${Math.floor(Math.random() * 1000)}`,
            status: newGuard.status || 'Active'
          })
          .eq('id', newGuard.employee_id);

        if (error) throw error;

        // Fetch the updated employee data
        const { data: updatedEmployee, error: fetchError } = await supabase
          .from('employees')
          .select('*')
          .eq('id', newGuard.employee_id)
          .single();

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
            guardId: updatedEmployee.guardId || `G-${Math.floor(Math.random() * 1000)}`,
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
        const { data, error } = await supabase
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
            guardId: newGuard.guardId || `G-${Math.floor(Math.random() * 1000)}`,
            hire_date: new Date().toISOString().split('T')[0],
            department: 'Operations'
          }])
          .select();

        if (error) throw error;

        if (data && data[0]) {
          const newEmployee = data[0];
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
            guardId: newEmployee.guardId || `G-${Math.floor(Math.random() * 1000)}`,
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
    } catch (err: any) {
      console.error('Error adding guard:', err);
      showNotification('Failed to add guard: ' + err.message, 'error');
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

  // ===== SAVE EDIT =====
  const saveEdit = useCallback(async () => {
    if (!editingItem) return;
    
    try {
      const oldData = securityData.find(item => item.id === editingItem.id);
      
      const { error } = await supabase
        .from('employees')
        .update({
          full_name: editingItem.full_name,
          position: editingItem.position,
          phone: editingItem.phone,
          status: editingItem.status,
          company: editingItem.company,
          workstation: editingItem.workstation,
          shift: editingItem.shift,
          supervisor: editingItem.supervisor,
          uniform_status: editingItem.uniform_status,
          uniform_condition: editingItem.uniform_condition,
          shoes_status: editingItem.shoes_status,
          license_status: editingItem.licenseStatus,
          license_expiry: editingItem.license_expiry,
          next_of_kin_name: editingItem.emergency_contact,
          next_of_kin_phone: editingItem.emergency_phone,
          guardId: editingItem.guardId
        })
        .eq('id', editingItem.id);

      if (error) throw error;
      
      setSecurityData(prev => prev.map(item => item.id === editingItem.id ? editingItem : item));
      showNotification(`${editingItem.full_name} updated successfully`, 'success');
      setShowEditModal(false);
      
      await logAudit({
        action: 'UPDATE',
        entity_type: 'security_guard',
        entity_id: editingItem.id,
        old_data: oldData,
        new_data: editingItem,
        region_id: userProfile?.region_id
      });
      
      setEditingItem(null);
    } catch (err: any) {
      console.error('Error updating guard:', err);
      showNotification('Failed to update guard: ' + err.message, 'error');
    }
  }, [editingItem, securityData, userProfile]);

  // ===== DELETE GUARD =====
  const handleDelete = useCallback(async (item: SecurityPersonnel) => {
    if (confirm(`Are you sure you want to remove ${item.full_name} from security personnel?`)) {
      try {
        const oldData = { ...item };
        
        const { error } = await supabase
          .from('employees')
          .delete()
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
      } catch (err: any) {
        console.error('Error deleting guard:', err);
        showNotification('Failed to delete guard: ' + err.message, 'error');
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
    ].map(row => row.join(',')).join('\n');
    
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
  if (loading && !initialFetchDone) {
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
            <Button variant="secondary" onClick={() => setShowAddModal(true)}><UserPlus size={16} /> Add Guard</Button>
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
              value={search} 
              onChange={e => setSearch(e.target.value)} 
              placeholder="Search guards..." 
              className="w-full pl-10 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            />
          </div>
          <select
            value={filterShift}
            onChange={e => setFilterShift(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
          >
            <option value="all">All Shifts</option>
            {shiftsList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
          >
            <option value="all">All Status</option>
            {guardStatusList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
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
            There are no security personnel records available. Click "Add Guard" to create your first record.
          </p>
          <Button variant="secondary" className="mt-4" onClick={() => setShowAddModal(true)}>
            <UserPlus size={16} className="mr-1" /> Add Guard
          </Button>
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
                            onClick={() => handleView(emp)} 
                            className="w-7 h-7 rounded-lg hover:bg-slate-100 text-blue-600 flex items-center justify-center"
                            title="View Details"
                          >
                            <Eye size={14} />
                          </button>
                          <button 
                            onClick={() => handleEdit(emp)} 
                            className="w-7 h-7 rounded-lg hover:bg-slate-100 text-amber-600 flex items-center justify-center"
                            title="Edit"
                          >
                            <Edit2 size={14} />
                          </button>
                          <button 
                            onClick={() => handleDelete(emp)} 
                            className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center"
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
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
          sitesList={sitesList}
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
            sitesList={sitesList}
            shiftsList={shiftsList}
            supervisorsList={supervisorsList}
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

// ===== IMPROVED ADD GUARD FORM WITH SEARCHABLE EMPLOYEE SELECTOR =====
function AddGuardForm({ onAdd, onCancel, sitesList, shiftsList, supervisorsList, uniformStatusList, uniformConditionList, shoesStatusList, licenseStatusList, guardStatusList, userRegion, isSuperAdmin }: any) {
  const [formData, setFormData] = useState({
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
    guardId: `G-${Math.floor(Math.random() * 1000)}`,
    is_existing_employee: false
  });

  const [employeeSearch, setEmployeeSearch] = useState('');
  const [showEmployeeDropdown, setShowEmployeeDropdown] = useState(false);
  const [filteredEmployees, setFilteredEmployees] = useState<any[]>([]);
  const [allEmployees, setAllEmployees] = useState<any[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedEmployee, setSelectedEmployee] = useState<any>(null);

  // Fetch all employees for search
  useEffect(() => {
    const fetchEmployees = async () => {
      setLoadingEmployees(true);
      try {
        const { data, error } = await supabase
          .from('employees')
          .select('id, full_name, employee_number, position, phone, company, workstation, status, region_id')
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

  // Filter employees based on search
  useEffect(() => {
    if (employeeSearch.trim() === '') {
      setFilteredEmployees([]);
      return;
    }
    
    const searchLower = employeeSearch.toLowerCase().trim();
    const filtered = allEmployees.filter((emp: any) => {
      const fullName = (emp.full_name || '').toLowerCase();
      const employeeNumber = (emp.employee_number || '').toLowerCase();
      const position = (emp.position || '').toLowerCase();
      
      return fullName.includes(searchLower) ||
             employeeNumber.includes(searchLower) ||
             position.includes(searchLower);
    });
    
    setFilteredEmployees(filtered.slice(0, 15));
  }, [employeeSearch, allEmployees]);

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

  // Select employee from dropdown - auto-fill form
  const selectEmployee = (employee: any) => {
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

  const updateForm = (field: string, value: any) => {
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
        <label className="block text-sm font-medium text-slate-700 mb-1.5">
          Search Employee <span className="text-xs text-slate-400">(Type to search existing employees)</span>
        </label>
        <div className="relative" ref={dropdownRef}>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
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
                onClick={clearSelectedEmployee}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X size={16} />
              </button>
            )}
            <ChevronDown 
              size={16} 
              className={`absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-transform ${showEmployeeDropdown ? 'rotate-180' : ''}`}
            />
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
                filteredEmployees.map((emp: any) => (
                  <button
                    key={emp.id}
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
        <Input 
          label="Full Name *" 
          value={formData.full_name} 
          onChange={(e: any) => updateForm('full_name', e.target.value)} 
          required 
          disabled={!!selectedEmployee}
          className={selectedEmployee ? 'bg-slate-50' : ''}
        />
        <Input 
          label="Employee Number" 
          value={formData.employee_number} 
          onChange={(e: any) => updateForm('employee_number', e.target.value)} 
          disabled={!!selectedEmployee}
          className={selectedEmployee ? 'bg-slate-50' : ''}
        />
        <Input 
          label="Guard ID" 
          value={formData.guardId} 
          onChange={(e: any) => updateForm('guardId', e.target.value)} 
        />
        <Input 
          label="Phone" 
          value={formData.phone} 
          onChange={(e: any) => updateForm('phone', e.target.value)} 
          disabled={!!selectedEmployee}
          className={selectedEmployee ? 'bg-slate-50' : ''}
        />
        
        <select 
          className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
          value={formData.position} 
          onChange={(e: any) => updateForm('position', e.target.value)}
          disabled={!!selectedEmployee}
        >
          <option>Security Guard</option>
          <option>Senior Security Officer</option>
          <option>Patrol Officer</option>
          <option>Supervisor</option>
          <option>K9 Handler</option>
        </select>
        
        <select 
          className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
          value={formData.status} 
          onChange={(e: any) => updateForm('status', e.target.value)}
        >
          {guardStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input 
          label="Company" 
          value={formData.company} 
          onChange={(e: any) => updateForm('company', e.target.value)} 
          disabled={!!selectedEmployee}
          className={selectedEmployee ? 'bg-slate-50' : ''}
        />
        <Input 
          label="Workstation / Site" 
          value={formData.workstation} 
          onChange={(e: any) => updateForm('workstation', e.target.value)} 
          disabled={!!selectedEmployee}
          className={selectedEmployee ? 'bg-slate-50' : ''}
        />
        <select 
          className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
          value={formData.shift} 
          onChange={(e: any) => updateForm('shift', e.target.value)}
        >
          {shiftsList.map((s: string) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select 
          className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
          value={formData.supervisor} 
          onChange={(e: any) => updateForm('supervisor', e.target.value)}
        >
          {supervisorsList.map((s: string) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Uniform & Equipment Section */}
      <div className="border-t pt-4">
        <h4 className="font-semibold text-slate-800 mb-3 text-sm flex items-center gap-2">
          <Shirt size={16} className="text-[#D4A017]" /> Uniform & Equipment
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.uniform_status} 
            onChange={(e: any) => updateForm('uniform_status', e.target.value)}
          >
            {uniformStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.uniform_condition} 
            onChange={(e: any) => updateForm('uniform_condition', e.target.value)}
          >
            {uniformConditionList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.shoes_status} 
            onChange={(e: any) => updateForm('shoes_status', e.target.value)}
          >
            {shoesStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.licenseStatus} 
            onChange={(e: any) => updateForm('licenseStatus', e.target.value)}
          >
            {licenseStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="mt-4">
          <Input 
            label="License Expiry Date" 
            type="date"
            value={formData.license_expiry} 
            onChange={(e: any) => updateForm('license_expiry', e.target.value)} 
          />
        </div>
      </div>

      {/* Emergency Contact */}
      <div className="border-t pt-4">
        <h4 className="font-semibold text-slate-800 mb-3 text-sm flex items-center gap-2">
          <User size={16} className="text-[#D4A017]" /> Emergency Contact
        </h4>
        <div className="grid grid-cols-2 gap-4">
          <Input 
            label="Contact Name" 
            value={formData.emergency_contact} 
            onChange={(e: any) => updateForm('emergency_contact', e.target.value)} 
          />
          <Input 
            label="Contact Phone" 
            value={formData.emergency_phone} 
            onChange={(e: any) => updateForm('emergency_phone', e.target.value)} 
          />
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
function EditGuardForm({ guard, onSave, onCancel, sitesList, shiftsList, supervisorsList, uniformStatusList, uniformConditionList, shoesStatusList, licenseStatusList, guardStatusList }: any) {
  const [formData, setFormData] = useState(guard);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Input 
          label="Full Name *" 
          value={formData.full_name} 
          onChange={(e: any) => setFormData({...formData, full_name: e.target.value})} 
          required 
        />
        <Input 
          label="Employee Number" 
          value={formData.employee_number} 
          onChange={(e: any) => setFormData({...formData, employee_number: e.target.value})} 
        />
        <Input 
          label="Guard ID" 
          value={formData.guardId} 
          onChange={(e: any) => setFormData({...formData, guardId: e.target.value})} 
        />
        <Input 
          label="Phone" 
          value={formData.phone} 
          onChange={(e: any) => setFormData({...formData, phone: e.target.value})} 
        />
        
        <select 
          className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
          value={formData.position} 
          onChange={(e: any) => setFormData({...formData, position: e.target.value})}
        >
          <option>Security Guard</option>
          <option>Senior Security Officer</option>
          <option>Patrol Officer</option>
          <option>Supervisor</option>
          <option>K9 Handler</option>
        </select>
        
        <select 
          className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
          value={formData.status} 
          onChange={(e: any) => setFormData({...formData, status: e.target.value})}
        >
          {guardStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input 
          label="Company" 
          value={formData.company} 
          onChange={(e: any) => setFormData({...formData, company: e.target.value})} 
        />
        <Input 
          label="Workstation / Site" 
          value={formData.workstation} 
          onChange={(e: any) => setFormData({...formData, workstation: e.target.value})} 
        />
        <select 
          className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
          value={formData.shift} 
          onChange={(e: any) => setFormData({...formData, shift: e.target.value})}
        >
          {shiftsList.map((s: string) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select 
          className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
          value={formData.supervisor} 
          onChange={(e: any) => setFormData({...formData, supervisor: e.target.value})}
        >
          {supervisorsList.map((s: string) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="border-t pt-4">
        <h4 className="font-semibold text-slate-800 mb-3 text-sm flex items-center gap-2">
          <Shirt size={16} className="text-[#D4A017]" /> Uniform & Equipment
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.uniform_status} 
            onChange={(e: any) => setFormData({...formData, uniform_status: e.target.value})}
          >
            {uniformStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.uniform_condition} 
            onChange={(e: any) => setFormData({...formData, uniform_condition: e.target.value})}
          >
            {uniformConditionList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.shoes_status} 
            onChange={(e: any) => setFormData({...formData, shoes_status: e.target.value})}
          >
            {shoesStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select 
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
            value={formData.licenseStatus} 
            onChange={(e: any) => setFormData({...formData, licenseStatus: e.target.value})}
          >
            {licenseStatusList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="mt-4">
          <Input 
            label="License Expiry Date" 
            type="date"
            value={formData.license_expiry} 
            onChange={(e: any) => setFormData({...formData, license_expiry: e.target.value})} 
          />
        </div>
      </div>

      <div className="border-t pt-4">
        <h4 className="font-semibold text-slate-800 mb-3 text-sm flex items-center gap-2">
          <User size={16} className="text-[#D4A017]" /> Emergency Contact
        </h4>
        <div className="grid grid-cols-2 gap-4">
          <Input 
            label="Contact Name" 
            value={formData.emergency_contact} 
            onChange={(e: any) => setFormData({...formData, emergency_contact: e.target.value})} 
          />
          <Input 
            label="Contact Phone" 
            value={formData.emergency_phone} 
            onChange={(e: any) => setFormData({...formData, emergency_phone: e.target.value})} 
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-4 border-t">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button variant="secondary" onClick={onSave}>
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
        {guard.license_expiry && (
          <p className="text-xs text-slate-500 mt-2">License Expiry: {new Date(guard.license_expiry).toLocaleDateString()}</p>
        )}
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