import { useState, useEffect } from 'react';
import { Plus, Trash2, Edit2, CheckCircle, Percent, CreditCard, Calendar } from 'lucide-react';
import { Card, Button, Badge, PageHeader, Modal, Tabs, Input } from '../components/ui';
import { formatKwacha } from '../data';
import { UserManagement } from '../components/UserManagement';
import { supabase } from '../lib/supabase';
// ===== Import audit logger =====
import { logAudit } from '../utils/auditLogger';
// ===== IMPORT MonthSettings =====
import { MonthSettings } from '../components/MonthSettings';
import { getSystemCurrentMonth, getMonthLabel } from '../utils/currentMonth';
import { getPayrollRates, setPayrollRates } from '../utils/payrollSettings';
import { getCompanySettings, setCompanySettings, DEFAULT_COMPANY_INFO } from '../utils/companySettings';
import { showNotification } from '../utils/clickHandlers';

/* ----------------- SETTINGS ----------------- */
export function SettingsPage() {
  const [tab, setTab] = useState('company');
  const [saving, setSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [roles, setRoles] = useState<any[]>([]);
  const [loadingRoles, setLoadingRoles] = useState(true);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState<any>(null);
  const [roleForm, setRoleForm] = useState({
    name: '',
    color: 'blue',
    perms: ['', '', '']
  });
  
  // Positions state
  const [positions, setPositions] = useState<any[]>([]);
  const [showPositionModal, setShowPositionModal] = useState(false);
  const [editingPosition, setEditingPosition] = useState<any>(null);
  const [positionForm, setPositionForm] = useState({
    name: '',
    category: 'security',
    default_salary: 150000,
    is_active: true,
    requires_uniform: true
  });

  // Regions state
  const [regions, setRegions] = useState<any[]>([]);
  const [showRegionModal, setShowRegionModal] = useState(false);
  const [editingRegion, setEditingRegion] = useState<any>(null);
  const [regionForm, setRegionForm] = useState({ name: '', code: '' });
  
  // Month settings state
  const [currentMonth, setCurrentMonth] = useState<string>('');

  const colorOptions = [
    { value: 'navy', label: 'Navy Blue', class: 'bg-[#081C3A]' },
    { value: 'blue', label: 'Blue', class: 'bg-blue-500' },
    { value: 'gold', label: 'Gold', class: 'bg-[#D4A017]' },
    { value: 'green', label: 'Green', class: 'bg-green-500' },
    { value: 'red', label: 'Red', class: 'bg-red-500' },
    { value: 'purple', label: 'Purple', class: 'bg-purple-500' }
  ];

  const categoryOptions = [
    { value: 'security', label: 'Security' },
    { value: 'admin', label: 'Administration' },
    { value: 'management', label: 'Management' },
    { value: 'support', label: 'Support' }
  ];

  const [companyForm, setCompanyForm] = useState(DEFAULT_COMPANY_INFO);

  const [taxForm, setTaxForm] = useState({
    taxRate: '30',
    taxFreeThreshold: '50000',
    taxAuthority: 'Malawi Revenue Authority',
    filingFrequency: 'Monthly'
  });

  const [pensionForm, setPensionForm] = useState({
    employeeContribution: '5',
    employerContribution: '5',
    pensionFund: 'NBS Pension Fund',
    remittanceCycle: 'Monthly'
  });

  const [payrollForm, setPayrollForm] = useState({
    defaultPayDate: 'Last working day',
    currency: 'Malawi Kwacha (MK)',
    workingDays: '22',
    payPeriod: 'November 2025'
  });

  // Attendance/payroll deduction rates -- the actual working "System" settings
  // (see handleSaveDeductionRates below): these feed real calculations in
  // Attendance.tsx, payrollCalculations.ts, and Payslips.tsx, unlike the old
  // System tab's 6 toggles, which never persisted anywhere and didn't gate
  // any real feature (no email/SMS sending, attendance sync, or 2FA exists
  // in this app to turn on or off).
  const [deductionRatesForm, setDeductionRatesForm] = useState({
    uniformDeduction: '10000',
    absentDeduction: '4200',
    lateDeduction: '4200',
    lectureDeduction: '3000',
    lectureFullMonthDeduction: '15000',
    appearanceDeduction: '2000',
  });

  const tabs = [
    { id: 'company', label: 'Company' },
    { id: 'tax', label: 'Tax Settings' },
    { id: 'pension', label: 'Pension' },
    { id: 'payroll', label: 'Payroll' },
    { id: 'month', label: 'Month Settings' },  // <-- ADDED THIS TAB
    { id: 'positions', label: 'Positions' },
    { id: 'regions', label: 'Regions' },
    { id: 'users', label: 'User Management' },
    { id: 'roles', label: 'User Roles' },
    { id: 'system', label: 'System' }
  ];

  // Load current month
  useEffect(() => {
    const loadCurrentMonth = async () => {
      const month = await getSystemCurrentMonth();
      setCurrentMonth(month);
    };
    loadCurrentMonth();
  }, []);

 // ===== UPDATED: loadPositions with proper select =====
const loadPositions = async () => {
  try {
    const { data, error } = await supabase
      .from('positions')
      .select('*')
      .order('name');
    if (error) throw error;
    setPositions(data || []);
  } catch (error) {
    console.error('Error loading positions:', error);
  }
};

  // ===== UPDATED: handleSavePosition with proper tenant handling =====
const handleSavePosition = async () => {
  const trimmedName = positionForm.name.trim();
  if (!trimmedName) {
    showNotification('Please enter a position name', 'error');
    return;
  }

  // The table's UNIQUE (tenant_id, name) constraint doesn't care whether an
  // existing row with the same name is active or inactive -- a position
  // that was toggled off (rather than deleted) still occupies that name.
  // Checking the already-loaded list first gives a clear, specific error
  // immediately instead of a raw Postgres "duplicate key" message, and
  // covers the common case of not noticing the name already exists further
  // down the (often long) positions table.
  const duplicate = positions.find(
    (p) => p.id !== editingPosition?.id && p.name.trim().toLowerCase() === trimmedName.toLowerCase()
  );
  if (duplicate) {
    showNotification(
      `A position named "${duplicate.name}" already exists${duplicate.is_active ? '' : ' (currently inactive)'}. Edit it instead, or use a different name.`,
      'error'
    );
    return;
  }

  try {
    if (editingPosition) {
      const { error } = await supabase
        .from('positions')
        .update({
          name: trimmedName,
          category: positionForm.category,
          default_salary: positionForm.default_salary,
          is_active: positionForm.is_active,
          requires_uniform: positionForm.requires_uniform,
          updated_at: new Date().toISOString()
          // Remove tenant_id from update
        })
        .eq('id', editingPosition.id);
      if (error) throw error;

      // Audit log for update
      await logAudit({
        action: 'UPDATE',
        entity_type: 'positions',
        entity_id: editingPosition.id,
        old_data: {
          name: editingPosition.name,
          category: editingPosition.category,
          default_salary: editingPosition.default_salary,
          is_active: editingPosition.is_active,
          requires_uniform: editingPosition.requires_uniform
        },
        new_data: { ...positionForm, name: trimmedName }
      });

      showNotification('Position updated successfully', 'success');
    } else {
      // ===== FIX: Don't include tenant_id in insert =====
      const { data, error } = await supabase
        .from('positions')
        .insert([{
          name: trimmedName,
          category: positionForm.category,
          default_salary: positionForm.default_salary,
          is_active: positionForm.is_active,
          requires_uniform: positionForm.requires_uniform
          // tenant_id is omitted - let it default to NULL
        }])
        .select();
      if (error) throw error;

      // Audit log for create
      await logAudit({
        action: 'CREATE',
        entity_type: 'positions',
        entity_id: data?.[0]?.id || 'new',
        new_data: { ...positionForm, name: trimmedName }
      });

      showNotification('Position added successfully', 'success');
    }

    await loadPositions();
    setShowPositionModal(false);
    setEditingPosition(null);
    setPositionForm({ name: '', category: 'security', default_salary: 150000, is_active: true, requires_uniform: true });
  } catch (error: any) {
    console.error('Error saving position:', error);
    // Fallback for the same duplicate-name case if another admin added it
    // concurrently, after this page's own positions list was last loaded.
    const message = error.code === '23505'
      ? `A position named "${trimmedName}" already exists.`
      : `Failed to save position: ${error.message || 'Unknown error'}`;
    showNotification(message, 'error');
  }
};

  // ===== UPDATED: handleDeletePosition =====
const handleDeletePosition = async (position: any) => {
  if (confirm(`Are you sure you want to delete "${position.name}"? This may affect existing employees.`)) {
    try {
      const { error } = await supabase
        .from('positions')
        .delete()
        .eq('id', position.id);
      if (error) throw error;
      
      // Audit log for delete
      await logAudit({
        action: 'DELETE',
        entity_type: 'positions',
        entity_id: position.id,
        old_data: {
          name: position.name,
          category: position.category,
          default_salary: position.default_salary,
          is_active: position.is_active
        }
      });
      
      await loadPositions();
      showNotification('Position deleted successfully', 'success');
    } catch (error: any) {
      console.error('Error deleting position:', error);
      showNotification(`Failed to delete position: ${error.message || 'Unknown error'}`, 'error');
    }
  }
};

  // Edit position
  const handleEditPosition = (position: any) => {
    setEditingPosition(position);
    setPositionForm({
      name: position.name,
      category: position.category,
      default_salary: position.default_salary,
      is_active: position.is_active,
      requires_uniform: position.requires_uniform !== false
    });
    setShowPositionModal(true);
  };

  // Load regions from Supabase
  const loadRegions = async () => {
    try {
      const { data, error } = await supabase
        .from('regions')
        .select('*')
        .order('name');
      if (error) throw error;
      setRegions(data || []);
    } catch (error) {
      console.error('Error loading regions:', error);
    }
  };

  const handleSaveRegion = async () => {
    const trimmedName = regionForm.name.trim();
    if (!trimmedName) {
      showNotification('Please enter a region name', 'error');
      return;
    }

    // The table's UNIQUE (tenant_id, code) constraint is on code, not name --
    // two regions can share a name but not a code. Check it up front, same as
    // handleSavePosition does for position names, for a clear error instead
    // of a raw duplicate-key message.
    const trimmedCode = regionForm.code.trim();
    if (trimmedCode) {
      const duplicate = regions.find(
        (r) => r.id !== editingRegion?.id && (r.code || '').trim().toLowerCase() === trimmedCode.toLowerCase()
      );
      if (duplicate) {
        showNotification(`A region named "${duplicate.name}" already uses code "${duplicate.code}". Use a different code.`, 'error');
        return;
      }
    }

    try {
      if (editingRegion) {
        const { error } = await supabase
          .from('regions')
          .update({
            name: trimmedName,
            code: trimmedCode || null,
          })
          .eq('id', editingRegion.id);
        if (error) throw error;

        await logAudit({
          action: 'UPDATE',
          entity_type: 'regions',
          entity_id: editingRegion.id,
          old_data: { name: editingRegion.name, code: editingRegion.code },
          new_data: { name: trimmedName, code: trimmedCode }
        });

        showNotification('Region updated successfully', 'success');
      } else {
        // tenant_id is omitted on insert -- it defaults to the current user's
        // own tenant, same pattern as handleSavePosition above.
        const { data, error } = await supabase
          .from('regions')
          .insert([{
            name: trimmedName,
            code: trimmedCode || null,
          }])
          .select();
        if (error) throw error;

        await logAudit({
          action: 'CREATE',
          entity_type: 'regions',
          entity_id: data?.[0]?.id || 'new',
          new_data: { name: trimmedName, code: trimmedCode }
        });

        showNotification('Region added successfully', 'success');
      }

      await loadRegions();
      setShowRegionModal(false);
      setEditingRegion(null);
      setRegionForm({ name: '', code: '' });
    } catch (error: any) {
      console.error('Error saving region:', error);
      const message = error.code === '23505'
        ? `A region with code "${trimmedCode}" already exists.`
        : `Failed to save region: ${error.message || 'Unknown error'}`;
      showNotification(message, 'error');
    }
  };

  const handleDeleteRegion = async (region: any) => {
    if (confirm(`Are you sure you want to delete "${region.name}"? Employees and users assigned to this region will become unassigned, not deleted.`)) {
      try {
        const { error } = await supabase
          .from('regions')
          .delete()
          .eq('id', region.id);
        if (error) throw error;

        await logAudit({
          action: 'DELETE',
          entity_type: 'regions',
          entity_id: region.id,
          old_data: { name: region.name, code: region.code }
        });

        await loadRegions();
        showNotification('Region deleted successfully', 'success');
      } catch (error: any) {
        console.error('Error deleting region:', error);
        showNotification(`Failed to delete region: ${error.message || 'Unknown error'}`, 'error');
      }
    }
  };

  const handleEditRegion = (region: any) => {
    setEditingRegion(region);
    setRegionForm({ name: region.name, code: region.code || '' });
    setShowRegionModal(true);
  };

  // Load roles from Supabase
  const loadRoles = async () => {
    setLoadingRoles(true);
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select('*')
        .order('name');
      
      if (error) throw error;
      setRoles(data || []);
    } catch (error) {
      console.error('Error loading roles:', error);
    } finally {
      setLoadingRoles(false);
    }
  };

  // ===== Save Company: shared via system_settings (companySettings.ts), so
  // every admin's browser -- and Payslips.tsx's PDF template -- see the same
  // company info an admin actually set here, instead of each having its own
  // disconnected copy. =====
  const handleSaveCompany = async () => {
    setSaving(true);
    try {
      const oldData = await getCompanySettings();

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await setCompanySettings(companyForm, user.id);
      }

      await logAudit({
        action: 'UPDATE',
        entity_type: 'company_settings',
        old_data: oldData,
        new_data: companyForm
      });

      setSaving(false);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (error) {
      console.error('Error saving company settings:', error);
      setSaving(false);
    }
  };

  // ===== UPDATED: Save Tax with audit logging =====
  const handleSaveTax = async () => {
    setSaving(true);
    try {
      const oldData = JSON.parse(localStorage.getItem('taxSettings') || '{}');
      localStorage.setItem('taxSettings', JSON.stringify(taxForm));

      // Persist the rate Payroll.tsx actually uses, shared across every admin's
      // browser via system_settings (localStorage above is per-browser only and
      // was previously the only place this was saved -- Payroll never read it).
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const currentRates = await getPayrollRates();
        await setPayrollRates(
          {
            ...currentRates,
            payeRate: (parseFloat(taxForm.taxRate) || 0) / 100,
            payeThreshold: parseFloat(taxForm.taxFreeThreshold) || 0,
          },
          user.id
        );
      }

      // Audit log
      await logAudit({
        action: 'UPDATE',
        entity_type: 'tax_settings',
        old_data: Object.keys(oldData).length > 0 ? oldData : null,
        new_data: taxForm
      });

      setTimeout(() => {
        setSaving(false);
        setShowSuccess(true);
        setTimeout(() => setShowSuccess(false), 3000);
      }, 500);
    } catch (error) {
      console.error('Error saving tax settings:', error);
      setSaving(false);
    }
  };

  // ===== UPDATED: Save Pension with audit logging =====
  const handleSavePension = async () => {
    setSaving(true);
    try {
      const oldData = JSON.parse(localStorage.getItem('pensionSettings') || '{}');
      localStorage.setItem('pensionSettings', JSON.stringify(pensionForm));

      // Only the employee contribution % is ever deducted from an employee's own
      // pay (see Payroll.tsx) -- employerContribution is the company's own
      // bookkeeping figure and isn't subtracted from anyone's net pay.
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const currentRates = await getPayrollRates();
        await setPayrollRates(
          {
            ...currentRates,
            pensionEmployeeRate: (parseFloat(pensionForm.employeeContribution) || 0) / 100,
          },
          user.id
        );
      }

      // Audit log
      await logAudit({
        action: 'UPDATE',
        entity_type: 'pension_settings',
        old_data: Object.keys(oldData).length > 0 ? oldData : null,
        new_data: pensionForm
      });
      
      setTimeout(() => {
        setSaving(false);
        setShowSuccess(true);
        setTimeout(() => setShowSuccess(false), 3000);
      }, 500);
    } catch (error) {
      console.error('Error saving pension settings:', error);
      setSaving(false);
    }
  };

  // ===== UPDATED: Save Payroll with audit logging =====
  const handleSavePayroll = async () => {
    setSaving(true);
    try {
      const oldData = JSON.parse(localStorage.getItem('payrollSettings') || '{}');
      localStorage.setItem('payrollSettings', JSON.stringify(payrollForm));
      
      // Audit log
      await logAudit({
        action: 'UPDATE',
        entity_type: 'payroll_settings',
        old_data: Object.keys(oldData).length > 0 ? oldData : null,
        new_data: payrollForm
      });
      
      setTimeout(() => {
        setSaving(false);
        setShowSuccess(true);
        setTimeout(() => setShowSuccess(false), 3000);
      }, 500);
    } catch (error) {
      console.error('Error saving payroll settings:', error);
      setSaving(false);
    }
  };

  // Each tab's Cancel button discards edits by reloading that tab's own data
  // from where it's actually saved -- these used to all funnel through one
  // handleCancel() that only ever reloaded companyForm, so clicking Cancel
  // on Tax/Pension/Payroll silently did nothing to that tab's own fields.
  const handleCancelCompany = () => {
    getCompanySettings().then(setCompanyForm);
  };

  const handleCancelTax = () => {
    getPayrollRates().then(rates => {
      setTaxForm(prev => ({ ...prev, taxRate: String(rates.payeRate * 100), taxFreeThreshold: String(rates.payeThreshold) }));
    });
  };

  const handleCancelPension = () => {
    getPayrollRates().then(rates => {
      setPensionForm(prev => ({ ...prev, employeeContribution: String(rates.pensionEmployeeRate * 100) }));
    });
  };

  const handleCancelPayroll = () => {
    const savedPayroll = localStorage.getItem('payrollSettings');
    setPayrollForm(prev => savedPayroll ? { ...prev, ...JSON.parse(savedPayroll) } : prev);
  };

  // ===== Save deduction rates: the System tab's real, working settings =====
  // These feed real calculations in Attendance.tsx, payrollCalculations.ts,
  // and Payslips.tsx (see payrollSettings.ts) -- unlike the 6 toggles this
  // tab used to show, which weren't even persisted (plain React state, reset
  // on every page load) and didn't gate any real feature.
  const handleSaveDeductionRates = async () => {
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not signed in');

      const currentRates = await getPayrollRates();
      const oldData = {
        uniformDeduction: currentRates.uniformDeduction,
        absentDeduction: currentRates.absentDeduction,
        lateDeduction: currentRates.lateDeduction,
        lectureDeduction: currentRates.lectureDeduction,
        lectureFullMonthDeduction: currentRates.lectureFullMonthDeduction,
        appearanceDeduction: currentRates.appearanceDeduction,
      };
      const newData = {
        uniformDeduction: parseFloat(deductionRatesForm.uniformDeduction) || 0,
        absentDeduction: parseFloat(deductionRatesForm.absentDeduction) || 0,
        lateDeduction: parseFloat(deductionRatesForm.lateDeduction) || 0,
        lectureDeduction: parseFloat(deductionRatesForm.lectureDeduction) || 0,
        lectureFullMonthDeduction: parseFloat(deductionRatesForm.lectureFullMonthDeduction) || 0,
        appearanceDeduction: parseFloat(deductionRatesForm.appearanceDeduction) || 0,
      };

      await setPayrollRates({ ...currentRates, ...newData }, user.id);

      await logAudit({
        action: 'UPDATE',
        entity_type: 'system_settings',
        old_data: oldData,
        new_data: newData
      });

      setSaving(false);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (error) {
      console.error('Error saving deduction rates:', error);
      setSaving(false);
      showNotification('Failed to save deduction rates', 'error');
    }
  };

  const handleCancelDeductionRates = () => {
    getPayrollRates().then(rates => {
      setDeductionRatesForm({
        uniformDeduction: String(rates.uniformDeduction),
        absentDeduction: String(rates.absentDeduction),
        lateDeduction: String(rates.lateDeduction),
        lectureDeduction: String(rates.lectureDeduction),
        lectureFullMonthDeduction: String(rates.lectureFullMonthDeduction),
        appearanceDeduction: String(rates.appearanceDeduction),
      });
    });
  };

  // Role Functions
  const handleNewRole = () => {
    setEditingRole(null);
    setRoleForm({ name: '', color: 'blue', perms: ['', '', ''] });
    setShowRoleModal(true);
  };

  const handleEditRole = (role: any) => {
    setEditingRole(role);
    setRoleForm({
      name: role.name,
      color: role.color,
      perms: [...role.perms, '', '', ''].slice(0, 3)
    });
    setShowRoleModal(true);
  };

  // ===== UPDATED: Delete role with audit logging =====
  const handleDeleteRole = async (roleId: number, roleName: string) => {
    if (confirm(`Are you sure you want to delete "${roleName}"?`)) {
      try {
        const { data: roleData } = await supabase
          .from('user_roles')
          .select('*')
          .eq('id', roleId)
          .single();
          
        const { error } = await supabase.from('user_roles').delete().eq('id', roleId);
        if (error) throw error;
        
        // Audit log
        await logAudit({
          action: 'DELETE',
          entity_type: 'user_roles',
          entity_id: String(roleId),
          old_data: roleData
        });
        
        await loadRoles();
        showNotification('Role deleted successfully', 'success');
      } catch (error) {
        console.error('Error deleting role:', error);
        showNotification('Failed to delete role', 'error');
      }
    }
  };

  // ===== UPDATED: Save role with audit logging =====
  const handleSaveRole = async () => {
    const trimmedName = roleForm.name.trim();
    if (!trimmedName) {
      showNotification('Please enter a role name', 'error');
      return;
    }

    const newRole = {
      name: trimmedName,
      users: editingRole ? editingRole.users : 0,
      color: roleForm.color,
      perms: roleForm.perms.filter(p => p.trim() !== '')
    };

    try {
      if (editingRole) {
        const oldData = {...editingRole};
        const { error } = await supabase
          .from('user_roles')
          .update(newRole)
          .eq('id', editingRole.id);
        if (error) throw error;

        // Audit log for update
        await logAudit({
          action: 'UPDATE',
          entity_type: 'user_roles',
          entity_id: String(editingRole.id),
          old_data: oldData,
          new_data: newRole
        });

        showNotification('Role updated successfully', 'success');
      } else {
        const { data, error } = await supabase.from('user_roles').insert([newRole]).select();
        if (error) throw error;

        // Audit log for create
        await logAudit({
          action: 'CREATE',
          entity_type: 'user_roles',
          entity_id: data?.[0]?.id ? String(data[0].id) : 'new',
          new_data: newRole
        });

        showNotification('Role created successfully', 'success');
      }

      await loadRoles();
      setShowRoleModal(false);
    } catch (error) {
      console.error('Error saving role:', error);
      showNotification('Failed to save role', 'error');
    }
  };

  useEffect(() => {
    const savedTax = localStorage.getItem('taxSettings');
    if (savedTax) setTaxForm(JSON.parse(savedTax));
    const savedPension = localStorage.getItem('pensionSettings');
    if (savedPension) setPensionForm(JSON.parse(savedPension));
    const savedPayroll = localStorage.getItem('payrollSettings');
    if (savedPayroll) setPayrollForm(prev => ({ ...prev, ...JSON.parse(savedPayroll) }));

    // system_settings is the shared source of truth Payroll.tsx (and now
    // Attendance.tsx/Payslips.tsx) actually read -- load it last so it wins
    // over any stale/different localStorage value cached in this browser.
    getPayrollRates().then(rates => {
      setTaxForm(prev => ({ ...prev, taxRate: String(rates.payeRate * 100), taxFreeThreshold: String(rates.payeThreshold) }));
      setPensionForm(prev => ({ ...prev, employeeContribution: String(rates.pensionEmployeeRate * 100) }));
      setDeductionRatesForm({
        uniformDeduction: String(rates.uniformDeduction),
        absentDeduction: String(rates.absentDeduction),
        lateDeduction: String(rates.lateDeduction),
        lectureDeduction: String(rates.lectureDeduction),
        lectureFullMonthDeduction: String(rates.lectureFullMonthDeduction),
        appearanceDeduction: String(rates.appearanceDeduction),
      });
    });

    // Company info is shared (system_settings) too -- see companySettings.ts.
    getCompanySettings().then(setCompanyForm);

    loadRoles();
    loadPositions();
    loadRegions();
  }, []);

  const RoleModal = () => (
    <Modal open={showRoleModal} onClose={() => setShowRoleModal(false)} title={editingRole ? 'Edit Role' : 'Create New Role'} size="lg">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Role Name *</label>
          <input
            type="text"
            value={roleForm.name}
            onChange={(e) => setRoleForm(prev => ({ ...prev, name: e.target.value }))}
            placeholder="e.g., Regional Manager, Team Lead"
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          />
        </div>
        
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Role Color</label>
          <div className="flex gap-2 flex-wrap">
            {colorOptions.map(color => (
              <button
                key={color.value}
                type="button"
                onClick={() => setRoleForm(prev => ({ ...prev, color: color.value }))}
                className={`w-10 h-10 rounded-lg ${color.class} ${roleForm.color === color.value ? 'ring-2 ring-offset-2 ring-[#081C3A]' : ''}`}
                title={color.label}
              />
            ))}
          </div>
          <p className="text-xs text-slate-400 mt-1">Navy=Admin, Blue=Manager, Gold=Finance, Green=Supervisor, Red=Executive, Purple=Special</p>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Permissions</label>
          <div className="space-y-2">
            {[0, 1, 2].map((idx) => (
              <input
                key={idx}
                type="text"
                value={roleForm.perms[idx] || ''}
                onChange={(e) => {
                  const newPerms = [...roleForm.perms];
                  newPerms[idx] = e.target.value;
                  setRoleForm(prev => ({ ...prev, perms: newPerms }));
                }}
                placeholder={`Permission ${idx + 1}`}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
              />
            ))}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <Button variant="outline" onClick={() => setShowRoleModal(false)}>Cancel</Button>
        <Button variant="secondary" onClick={handleSaveRole}>
          <CheckCircle size={14} className="mr-1" /> {editingRole ? 'Update Role' : 'Create Role'}
        </Button>
      </div>
    </Modal>
  );

  // Position Modal
  const PositionModal = () => (
    <Modal open={showPositionModal} onClose={() => setShowPositionModal(false)} title={editingPosition ? 'Edit Position' : 'New Position'} size="md">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Position Name *</label>
          <input
            type="text"
            value={positionForm.name}
            onChange={(e) => setPositionForm({...positionForm, name: e.target.value})}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            placeholder="e.g., Regional Manager, Security Guard"
          />
        </div>
        
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Category</label>
          <select
            value={positionForm.category}
            onChange={(e) => setPositionForm({...positionForm, category: e.target.value})}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          >
            {categoryOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
          <p className="text-xs text-slate-400 mt-1">Categorizes the position for reporting purposes</p>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Default Salary (MK)</label>
          <input
            type="number"
            value={positionForm.default_salary}
            onChange={(e) => setPositionForm({...positionForm, default_salary: parseInt(e.target.value) || 0})}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          />
        </div>
        
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={positionForm.is_active}
            onChange={(e) => setPositionForm({...positionForm, is_active: e.target.checked})}
            className="w-4 h-4 rounded border-slate-300"
          />
          <label className="text-sm text-slate-700">Active (visible in employee form)</label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={positionForm.requires_uniform}
            onChange={(e) => setPositionForm({...positionForm, requires_uniform: e.target.checked})}
            className="w-4 h-4 rounded border-slate-300"
          />
          <label className="text-sm text-slate-700">Requires Uniform (uniform deduction applies to this position)</label>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <Button variant="outline" onClick={() => setShowPositionModal(false)}>Cancel</Button>
        <Button variant="secondary" onClick={handleSavePosition}>
          <CheckCircle size={14} className="mr-1" /> {editingPosition ? 'Update Position' : 'Create Position'}
        </Button>
      </div>
    </Modal>
  );

  // Region Modal
  const RegionModal = () => (
    <Modal open={showRegionModal} onClose={() => setShowRegionModal(false)} title={editingRegion ? 'Edit Region' : 'New Region'} size="md">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Region Name *</label>
          <input
            type="text"
            value={regionForm.name}
            onChange={(e) => setRegionForm({...regionForm, name: e.target.value})}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            placeholder="e.g., Northern Region"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Code (optional)</label>
          <input
            type="text"
            value={regionForm.code}
            onChange={(e) => setRegionForm({...regionForm, code: e.target.value})}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            placeholder="e.g., N"
          />
          <p className="text-xs text-slate-400 mt-1">
            The first letter is used as this region's prefix in auto-generated employee numbers (e.g. "N" for Northern gives SFG-N-001). Leave blank to use the first letter of the region name instead.
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <Button variant="outline" onClick={() => setShowRegionModal(false)}>Cancel</Button>
        <Button variant="secondary" onClick={handleSaveRegion}>
          <CheckCircle size={14} className="mr-1" /> {editingRegion ? 'Update Region' : 'Create Region'}
        </Button>
      </div>
    </Modal>
  );

  if (loadingRoles) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin"></div></div>;
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader title="System Settings" subtitle="Configure company preferences and policies" />
      
      {showSuccess && (
        <div className="fixed top-4 right-4 z-50 bg-emerald-500 text-white px-4 py-2 rounded-lg shadow-lg text-sm animate-fade-in">
          Settings saved successfully!
        </div>
      )}
      
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      
      {tab === 'company' && (
        <Card className="p-6">
          <h3 className="font-semibold text-slate-800 mb-4">Company Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input label="Company Name" value={companyForm.companyName} onChange={(e: any) => setCompanyForm({...companyForm, companyName: e.target.value})} />
            <Input label="Company Registration" value={companyForm.registration} onChange={(e: any) => setCompanyForm({...companyForm, registration: e.target.value})} />
            <Input label="Address" value={companyForm.address} onChange={(e: any) => setCompanyForm({...companyForm, address: e.target.value})} />
            <Input label="Phone" value={companyForm.phone} onChange={(e: any) => setCompanyForm({...companyForm, phone: e.target.value})} />
            <Input label="Email" value={companyForm.email} onChange={(e: any) => setCompanyForm({...companyForm, email: e.target.value})} />
            <Input label="Website" value={companyForm.website} onChange={(e: any) => setCompanyForm({...companyForm, website: e.target.value})} />
            <Input label="Tax ID (TPIN)" value={companyForm.taxId} onChange={(e: any) => setCompanyForm({...companyForm, taxId: e.target.value})} />
            <Input label="Pension Registration" value={companyForm.pensionReg} onChange={(e: any) => setCompanyForm({...companyForm, pensionReg: e.target.value})} />
          </div>
          <div className="flex items-center justify-end gap-2 mt-6">
            <Button variant="outline" onClick={handleCancelCompany}>Cancel</Button>
            <Button variant="secondary" onClick={handleSaveCompany} disabled={saving}>
              {saving ? 'Saving...' : <><CheckCircle size={14} className="mr-1" /> Save Changes</>}
            </Button>
          </div>
        </Card>
      )}
      
      {tab === 'tax' && (
        <Card className="p-6">
          <h3 className="font-semibold text-slate-800 mb-4">Tax Settings (PAYE)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input label="PAYE Tax Rate (%)" value={taxForm.taxRate} onChange={(e: any) => setTaxForm({...taxForm, taxRate: e.target.value})} />
            <Input label="Tax Free Threshold (MK)" value={taxForm.taxFreeThreshold} onChange={(e: any) => setTaxForm({...taxForm, taxFreeThreshold: e.target.value})} />
            <Input label="Tax Authority" value={taxForm.taxAuthority} onChange={(e: any) => setTaxForm({...taxForm, taxAuthority: e.target.value})} />
            <Input label="Filing Frequency" value={taxForm.filingFrequency} onChange={(e: any) => setTaxForm({...taxForm, filingFrequency: e.target.value})} />
          </div>
          <div className="mt-6 p-4 rounded-lg bg-[#FFF9E5] text-sm">
            <Percent size={16} className="inline mr-2 text-[#D4A017]" />
            Current policy: Flat {taxForm.taxRate}% PAYE on gross income above MK {parseInt(taxForm.taxFreeThreshold).toLocaleString()} threshold.
          </div>
          <div className="flex items-center justify-end gap-2 mt-6">
            <Button variant="outline" onClick={handleCancelTax}>Cancel</Button>
            <Button variant="secondary" onClick={handleSaveTax} disabled={saving}>
              {saving ? 'Saving...' : <><CheckCircle size={14} className="mr-1" /> Save Changes</>}
            </Button>
          </div>
        </Card>
      )}
      
      {tab === 'pension' && (
        <Card className="p-6">
          <h3 className="font-semibold text-slate-800 mb-4">Pension Contribution Settings</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input label="Employee Contribution (%)" value={pensionForm.employeeContribution} onChange={(e: any) => setPensionForm({...pensionForm, employeeContribution: e.target.value})} />
            <Input label="Employer Contribution (%)" value={pensionForm.employerContribution} onChange={(e: any) => setPensionForm({...pensionForm, employerContribution: e.target.value})} />
            <Input label="Pension Fund" value={pensionForm.pensionFund} onChange={(e: any) => setPensionForm({...pensionForm, pensionFund: e.target.value})} />
            <Input label="Remittance Cycle" value={pensionForm.remittanceCycle} onChange={(e: any) => setPensionForm({...pensionForm, remittanceCycle: e.target.value})} />
          </div>
          <div className="flex items-center justify-end gap-2 mt-6">
            <Button variant="outline" onClick={handleCancelPension}>Cancel</Button>
            <Button variant="secondary" onClick={handleSavePension} disabled={saving}>
              {saving ? 'Saving...' : <><CheckCircle size={14} className="mr-1" /> Save Changes</>}
            </Button>
          </div>
        </Card>
      )}
      
      {tab === 'payroll' && (
        <Card className="p-6">
          <h3 className="font-semibold text-slate-800 mb-4">Payroll Configuration</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input label="Default Pay Date" value={payrollForm.defaultPayDate} onChange={(e: any) => setPayrollForm({...payrollForm, defaultPayDate: e.target.value})} />
            <Input label="Payroll Currency" value={payrollForm.currency} onChange={(e: any) => setPayrollForm({...payrollForm, currency: e.target.value})} />
            <Input label="Working Days" value={payrollForm.workingDays} onChange={(e: any) => setPayrollForm({...payrollForm, workingDays: e.target.value})} />
            <Input label="Pay Period" value={payrollForm.payPeriod} onChange={(e: any) => setPayrollForm({...payrollForm, payPeriod: e.target.value})} />
          </div>
          <div className="mt-6 p-4 rounded-lg bg-[#E8EDF5] text-sm flex items-start gap-3">
            <CreditCard size={18} className="text-[#081C3A] shrink-0 mt-0.5" />
            <div><strong>Bank Integration:</strong> National Bank of Malawi · NBS Bank · FDH Bank</div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6">
            <Button variant="outline" onClick={handleCancelPayroll}>Cancel</Button>
            <Button variant="secondary" onClick={handleSavePayroll} disabled={saving}>
              {saving ? 'Saving...' : <><CheckCircle size={14} className="mr-1" /> Save Changes</>}
            </Button>
          </div>
        </Card>
      )}
      
      {/* ===== MONTH SETTINGS TAB ===== */}
      {tab === 'month' && (
        <Card className="p-6">
          <h3 className="font-semibold text-slate-800 mb-2">Current Month Settings</h3>
          <p className="text-sm text-slate-600 mb-6">
            Set the current payroll month. This will be the default month shown across the system 
            (Payroll, Payments, Reports, and other modules).
          </p>
          
          <div className="p-4 bg-[#E8EDF5] rounded-lg mb-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600">Currently Active Month</p>
                <p className="text-xl font-bold text-[#081C3A]">
                  {currentMonth ? getMonthLabel(currentMonth) : 'Loading...'}
                </p>
              </div>
              <div className="w-10 h-10 rounded-lg bg-[#081C3A] text-[#D4A017] flex items-center justify-center">
                <Calendar size={20} />
              </div>
            </div>
          </div>
          
          <MonthSettings />
        </Card>
      )}
      
      {/* Positions Tab */}
      {tab === 'positions' && (
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-slate-800">Job Positions</h3>
              <p className="text-xs text-slate-500">Manage job titles and positions available for employees</p>
            </div>
            <Button variant="secondary" onClick={() => {
              setEditingPosition(null);
              setPositionForm({ name: '', category: 'security', default_salary: 150000, is_active: true, requires_uniform: true });
              setShowPositionModal(true);
            }}>
              <Plus size={14} className="mr-1" /> New Position
            </Button>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-2 text-left">Position Name</th>
                  <th className="px-4 py-2 text-left">Category</th>
                  <th className="px-4 py-2 text-right">Default Salary</th>
                  <th className="px-4 py-2 text-center">Uniform</th>
                  <th className="px-4 py-2 text-center">Status</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-slate-500">
                      No positions found. Click "New Position" to add one.
                    </td>
                  </tr>
                ) : (
                  positions.map((pos) => (
                    <tr key={pos.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2 font-medium">{pos.name}</td>
                      <td className="px-4 py-2">
                        <Badge color={
                          pos.category === 'security' ? 'blue' :
                          pos.category === 'admin' ? 'navy' :
                          pos.category === 'management' ? 'gold' : 'gray'
                        }>
                          {pos.category}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {formatKwacha(pos.default_salary)}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Badge color={pos.requires_uniform !== false ? 'blue' : 'gray'}>
                          {pos.requires_uniform !== false ? 'Yes' : 'No'}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Badge color={pos.is_active ? 'green' : 'gray'}>
                          {pos.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleEditPosition(pos)}
                            className="w-7 h-7 rounded-lg hover:bg-slate-100 text-amber-600"
                            title="Edit Position"
                          >
                            <Edit2 size={14} />
                          </button>
                          <button
                            onClick={() => handleDeletePosition(pos)}
                            className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500"
                            title="Delete Position"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Regions Tab */}
      {tab === 'regions' && (
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-slate-800">Regions</h3>
              <p className="text-xs text-slate-500">Manage the regions employees and users can be assigned to</p>
            </div>
            <Button variant="secondary" onClick={() => {
              setEditingRegion(null);
              setRegionForm({ name: '', code: '' });
              setShowRegionModal(true);
            }}>
              <Plus size={14} className="mr-1" /> New Region
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-2 text-left">Region Name</th>
                  <th className="px-4 py-2 text-left">Code</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {regions.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-center py-8 text-slate-500">
                      No regions found. Click "New Region" to add one.
                    </td>
                  </tr>
                ) : (
                  regions.map((region) => (
                    <tr key={region.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2 font-medium">{region.name}</td>
                      <td className="px-4 py-2">{region.code || '-'}</td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleEditRegion(region)}
                            className="w-7 h-7 rounded-lg hover:bg-slate-100 text-amber-600"
                            title="Edit Region"
                          >
                            <Edit2 size={14} />
                          </button>
                          <button
                            onClick={() => handleDeleteRegion(region)}
                            className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500"
                            title="Delete Region"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'users' && <UserManagement />}
      
      {tab === 'roles' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-slate-800">User Roles & Permissions</h3>
              <p className="text-xs text-slate-500">Manage access control and system privileges</p>
            </div>
            <Button variant="secondary" onClick={handleNewRole}><Plus size={14} /> New Role</Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {roles.map((r, i) => (
              <Card key={i} className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h4 className="font-bold text-slate-800">{r.name}</h4>
                    <p className="text-xs text-slate-500">{r.users} active users</p>
                  </div>
                  <Badge color={r.color as any}>{r.name === 'Administrator' ? 'Admin' : 'Standard'}</Badge>
                </div>
                <ul className="text-xs text-slate-600 space-y-1.5 mb-4">
                  {r.perms.map((p: string, j: number) => <li key={j} className="flex items-start gap-2"><CheckCircle size={12} className="text-emerald-600 shrink-0 mt-0.5" />{p}</li>)}
                </ul>
                <div className="flex gap-2 pt-3 border-t border-slate-100">
                  <Button variant="outline" className="text-xs py-1.5 flex-1" onClick={() => handleEditRole(r)}>
                    <Edit2 size={12} /> Edit
                  </Button>
                  <Button variant="ghost" className="text-xs py-1.5 text-red-600" onClick={() => handleDeleteRole(r.id, r.name)}>
                    <Trash2 size={12} /> Delete
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
      
      {tab === 'system' && (
        <Card className="p-6">
          <h3 className="font-semibold text-slate-800 mb-1">Payroll & Attendance Deduction Rates</h3>
          <p className="text-xs text-slate-500 mb-4">
            These rates apply automatically wherever deductions are calculated -- Attendance, Payroll, Payments, and Payslips all use these same figures.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Uniform Deduction (MK/month)"
              value={deductionRatesForm.uniformDeduction}
              onChange={(e: any) => setDeductionRatesForm({ ...deductionRatesForm, uniformDeduction: e.target.value })}
            />
            <Input
              label="Absent Day Deduction (MK/day)"
              value={deductionRatesForm.absentDeduction}
              onChange={(e: any) => setDeductionRatesForm({ ...deductionRatesForm, absentDeduction: e.target.value })}
            />
            <Input
              label="Late Day Deduction (MK/day)"
              value={deductionRatesForm.lateDeduction}
              onChange={(e: any) => setDeductionRatesForm({ ...deductionRatesForm, lateDeduction: e.target.value })}
            />
            <Input
              label="Missed Lecture Deduction (MK)"
              value={deductionRatesForm.lectureDeduction}
              onChange={(e: any) => setDeductionRatesForm({ ...deductionRatesForm, lectureDeduction: e.target.value })}
            />
            <Input
              label="Full-Month Lecture Deduction (MK)"
              value={deductionRatesForm.lectureFullMonthDeduction}
              onChange={(e: any) => setDeductionRatesForm({ ...deductionRatesForm, lectureFullMonthDeduction: e.target.value })}
            />
            <Input
              label="Appearance/Grooming Deduction (MK)"
              value={deductionRatesForm.appearanceDeduction}
              onChange={(e: any) => setDeductionRatesForm({ ...deductionRatesForm, appearanceDeduction: e.target.value })}
            />
          </div>
          <div className="flex items-center justify-end gap-2 mt-6">
            <Button variant="outline" onClick={handleCancelDeductionRates}>Cancel</Button>
            <Button variant="secondary" onClick={handleSaveDeductionRates} disabled={saving}>
              {saving ? 'Saving...' : <><CheckCircle size={14} className="mr-1" /> Save Changes</>}
            </Button>
          </div>
        </Card>
      )}
      
      {/* Rendered via direct call, not <RoleModal /> etc. -- these are defined
          as closures inside this component (not hoisted to module scope) so
          they can capture all the enclosing form state directly. Invoking
          them as JSX elements (<RoleModal />) would make React treat the
          function's fresh identity on every render as a brand-new component
          type and remount the whole modal (including the <input>s) on every
          keystroke, losing focus after each character. Calling them as plain
          functions inlines their returned JSX directly into this tree, so
          reconciliation is based on the stable Modal/input types inside them
          instead. */}
      {RoleModal()}
      {PositionModal()}
      {RegionModal()}
    </div>
  );
}

export default SettingsPage;