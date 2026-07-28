import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Download, DollarSign, CheckCircle, XCircle, Clock, Banknote, Smartphone, CreditCard, Edit2, Save, X, Filter, Building2, MapPin, Wallet, RefreshCw, AlertCircle, Undo, Repeat, ChevronLeft, ChevronRight, Calendar, Lock } from '../utils/icons';

import { Card, Button, Badge, PageHeader, THead, TBody, TR, TH, TD, Modal, Input } from '../components/ui';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { formatKwacha } from '../data';
import { showNotification } from '../utils/clickHandlers';
import { logAudit } from '../utils/auditLogger';
import {
  getSystemCurrentMonth,
  getMonthLabel,
  getNextMonth,
  getPreviousMonth,
  getAvailableMonthsFromSystem,
  normalizeMonthKey
} from '../utils/currentMonth';
import { Pagination } from '../components/Pagination';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { getPayrollRates } from '../utils/payrollSettings';
import { calculateLivePayroll, AttendanceCount } from '../utils/payrollCalculations';

export function PaymentsPage() {
  // ===== ALL HOOKS AT TOP LEVEL =====
  const [payments, setPayments] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [systemMonth, setSystemMonth] = useState('');
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterRegion, setFilterRegion] = useState('all');
  const [filterCompany, setFilterCompany] = useState('');
  const [filterWorkstation, setFilterWorkstation] = useState('');
  const [filterPayPoint, setFilterPayPoint] = useState('all');
  const [userProfile, setUserProfile] = useState<any>(null);
  const [regions, setRegions] = useState<any[]>([]);
  const [companies, setCompanies] = useState<string[]>([]);
  const [workstations, setWorkstations] = useState<string[]>([]);
  const [editingPayment, setEditingPayment] = useState<any>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedEmployees, setSelectedEmployees] = useState<string[]>([]);
  const [processingBulk, setProcessingBulk] = useState(false);

  // Debounced so typing in these fields doesn't refetch the whole employees
  // table on every keystroke -- only once input settles for 300ms.
  const debouncedSearch = useDebouncedValue(search, 300);
  const debouncedFilterCompany = useDebouncedValue(filterCompany, 300);
  const debouncedFilterWorkstation = useDebouncedValue(filterWorkstation, 300);

  // ===== PAGINATION STATES =====
  const [paymentsPage, setPaymentsPage] = useState(1);
  const [paymentsItemsPerPage, setPaymentsItemsPerPage] = useState(20);

  const statusOptions = ['all', 'pending', 'processing', 'paid', 'confirmed', 'failed'];
  const payPointOptions = ['all', 'national_bank', 'standard_bank', 'nbs_bank', 'centenary_bank', 'fdh_bank', 'first_capital_bank', 'airtel_money', 'tnm_mpamba'];
  const statusOrder = ['pending', 'processing', 'paid', 'confirmed'];

  // ===== MEMOIZED VALUES =====
  const isCurrentMonth = useMemo(() => selectedMonth === systemMonth, [selectedMonth, systemMonth]);
  const isFutureMonthSelected = useMemo(() => selectedMonth > systemMonth, [selectedMonth, systemMonth]);
  const canEdit = useMemo(() => isCurrentMonth, [isCurrentMonth]);
  const isSuperAdmin = useMemo(() => userProfile?.is_super_admin, [userProfile]);
  const userRegion = useMemo(() => userProfile?.regions, [userProfile]);

  const stats = useMemo(() => ({
    total: payments.length,
    pending: payments.filter(p => p.status === 'pending').length,
    processing: payments.filter(p => p.status === 'processing').length,
    paid: payments.filter(p => p.status === 'paid').length,
    confirmed: payments.filter(p => p.status === 'confirmed').length,
    failed: payments.filter(p => p.status === 'failed').length,
    totalAmount: payments.reduce((sum, p) => sum + p.net_pay, 0)
  }), [payments]);

  const monthDisplayLabel = useMemo(() => getMonthLabel(selectedMonth), [selectedMonth]);

  // ===== PAGINATED PAYMENTS =====
  const paginatedPayments = useMemo(() => {
    const startIndex = (paymentsPage - 1) * paymentsItemsPerPage;
    const endIndex = Math.min(startIndex + paymentsItemsPerPage, payments.length);
    return payments.slice(startIndex, endIndex);
  }, [payments, paymentsPage, paymentsItemsPerPage]);

  // ===== RESET PAGE WHEN SEARCH OR FILTERS CHANGE =====
  useEffect(() => {
    setPaymentsPage(1);
  }, [search, filterStatus, filterRegion, filterCompany, filterWorkstation, filterPayPoint]);

  // ===== CALLBACKS =====
  const fetchUserProfile = useCallback(async () => {
    const profile = await getCurrentProfile();
    setUserProfile(profile);
  }, []);

  const fetchRegions = useCallback(async () => {
    const { data } = await supabase.from('regions').select('*');
    setRegions(data || []);
  }, []);

  // ===== FETCH PAYMENT DATA =====
  const fetchPaymentData = useCallback(async () => {
    setLoading(true);
    try {
      let employeesQuery = supabase
        .from('employees')
        .select('*')
        .eq('is_deleted', false); // <-- CRITICAL: Exclude deleted employees
      
      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        employeesQuery = employeesQuery.eq('region_id', userProfile.region_id);
      }
      if (filterRegion !== 'all' && userProfile?.is_super_admin) {
        employeesQuery = employeesQuery.eq('region_id', filterRegion);
      }
      if (debouncedFilterCompany) {
        employeesQuery = employeesQuery.ilike('company', `%${debouncedFilterCompany}%`);
      }
      if (debouncedFilterWorkstation) {
        employeesQuery = employeesQuery.ilike('workstation', `%${debouncedFilterWorkstation}%`);
      }
      if (filterPayPoint !== 'all') {
        employeesQuery = employeesQuery.eq('pay_point', filterPayPoint);
      }
      
      const { data: employeesData, error: empError } = await employeesQuery;
      if (empError) throw empError;

      // Approved payroll is the real source of truth for net pay. Only fall back
      // to a live calculated estimate when no approved payroll run exists yet
      // for this month (e.g. before Payroll has been processed/approved).
      // Matched by normalized month key rather than exact string equality --
      // payroll.month has historically been written in more than one format
      // ("YYYY-MM" vs "Month YYYY") depending on which code path wrote it.
      const { data: payrollData, error: payrollError } = await supabase
        .from('payroll')
        .select('employee_id, net_pay, month')
        .eq('approval_status', 'approved');

      if (payrollError) {
        console.error('Payroll table error:', payrollError);
      }
      const targetMonthKey = normalizeMonthKey(selectedMonth);
      const approvedNetPayByEmployee = new Map(
        (payrollData || [])
          .filter(r => normalizeMonthKey(r.month) === targetMonthKey)
          .map(r => [r.employee_id, r.net_pay])
      );

      // The estimate (when no approved payroll exists yet) uses the exact same
      // calculateLivePayroll formula Payroll.tsx uses, so this page never shows
      // a different number for the same unprocessed month.
      const payrollRates = await getPayrollRates();

      const { data: positionsData } = await supabase
        .from('positions')
        .select('name, requires_uniform');
      const positionsRequiringUniform = new Map(
        (positionsData || []).map(p => [p.name, p.requires_uniform !== false])
      );

      const [yearStr, monthStr] = selectedMonth.split('-');
      const year = parseInt(yearStr, 10);
      const monthNum = parseInt(monthStr, 10);
      const monthStart = `${selectedMonth}-01`;
      const lastDay = new Date(year, monthNum, 0).getDate();
      const monthEnd = `${selectedMonth}-${String(lastDay).padStart(2, '0')}`;
      const employeeIds = (employeesData || []).map(e => e.id);

      const liveAttendanceCounts = new Map<string, AttendanceCount>();
      if (employeeIds.length > 0) {
        const { data: attendanceData } = await supabase
          .from('attendance')
          .select('employee_id, status')
          .gte('date', monthStart)
          .lte('date', monthEnd)
          .in('employee_id', employeeIds);

        (attendanceData || []).forEach(record => {
          const existing = liveAttendanceCounts.get(record.employee_id) || { absentDays: 0, lateDays: 0 };
          if (record.status === 'A') existing.absentDays += 1;
          if (record.status === 'L') existing.lateDays += 1;
          liveAttendanceCounts.set(record.employee_id, existing);
        });
      }

      const { data: deductionsData } = await supabase
        .from('employee_deductions')
        .select('employee_id, lecture_deduction, appearance_deduction')
        .eq('month', selectedMonth);
      const deductionsByEmployee = new Map((deductionsData || []).map(d => [d.employee_id, d]));

      const employeesWithPay = (employeesData || []).map(emp => {
        const approvedNetPay = approvedNetPayByEmployee.get(emp.id);
        if (approvedNetPay !== undefined) {
          return { ...emp, net_pay: approvedNetPay, net_pay_is_estimate: false };
        }

        const deduction = deductionsByEmployee.get(emp.id);
        const live = calculateLivePayroll({
          basicSalary: emp.basic_salary || 0,
          position: emp.position,
          employeeUniformDeduction: emp.uniform_deduction,
          positionsRequiringUniform,
          payrollRates,
          attendance: liveAttendanceCounts.get(emp.id),
          lectureDeduction: deduction?.lecture_deduction,
          appearanceDeduction: deduction?.appearance_deduction,
        });

        return { ...emp, net_pay: live.netPay, net_pay_is_estimate: true };
      });

      setEmployees(employeesWithPay);

      const uniqueCompanies = [...new Set(employeesWithPay.map(e => e.company).filter(Boolean))];
      setCompanies(uniqueCompanies);

      const uniqueWorkstations = [...new Set(employeesWithPay.map(e => e.workstation).filter(Boolean))];
      setWorkstations(uniqueWorkstations);

      const monthParam = `${selectedMonth}-01`;
      const { data: paymentData, error: payError } = await supabase
        .from('payment_status')
        .select('*')
        .eq('month', monthParam);

      if (payError && payError.code !== '42P01') {
        console.error('Payment table error:', payError);
      }

      const merged = employeesWithPay.map(emp => {
        const existing = paymentData?.find(p => p.employee_id === emp.id);
        return {
          id: existing?.id || '',
          employee_id: emp.id,
          full_name: emp.full_name,
          employee_number: emp.employee_number,
          phone: emp.phone,
          region_id: emp.region_id,
          company: emp.company,
          workstation: emp.workstation,
          pay_point: emp.pay_point,
          account_number: existing?.account_number || emp.account_number || '',
          net_pay: existing?.net_pay ?? emp.net_pay,
          net_pay_is_estimate: existing?.net_pay === undefined && emp.net_pay_is_estimate,
          status: existing?.status || 'pending',
          payment_date: existing?.payment_date || '',
          transaction_id: existing?.transaction_id || '',
          notes: existing?.notes || '',
        };
      });

      let filtered = merged;
      if (filterStatus !== 'all') {
        filtered = merged.filter(p => p.status === filterStatus);
      }
      if (debouncedSearch) {
        filtered = filtered.filter(p =>
          p.full_name?.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          p.employee_number?.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          p.company?.toLowerCase().includes(debouncedSearch.toLowerCase())
        );
      }

      setPayments(filtered);
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  }, [userProfile, selectedMonth, filterStatus, filterRegion, debouncedFilterCompany, debouncedFilterWorkstation, filterPayPoint, debouncedSearch]);

  // ===== INITIALIZATION =====
  useEffect(() => {
    const init = async () => {
      const month = await getSystemCurrentMonth();
      setSystemMonth(month);
      setSelectedMonth(month);
      
      const months = getAvailableMonthsFromSystem(month);
      setAvailableMonths(months);
      
      await fetchUserProfile();
      await fetchRegions();
    };
    init();
  }, [fetchUserProfile, fetchRegions]);

  useEffect(() => {
    if (userProfile && selectedMonth) {
      fetchPaymentData();
    }
  }, [userProfile, selectedMonth, filterStatus, filterRegion, debouncedFilterCompany, debouncedFilterWorkstation, filterPayPoint, fetchPaymentData]);

  // ===== MONTH NAVIGATION =====
  const goToPreviousMonth = useCallback(() => {
    const prevMonth = getPreviousMonth(selectedMonth);
    if (prevMonth && availableMonths.includes(prevMonth)) {
      setSelectedMonth(prevMonth);
      setPaymentsPage(1);
    }
  }, [selectedMonth, availableMonths]);

  const goToNextMonth = useCallback(() => {
    const nextMonth = getNextMonth(selectedMonth);
    if (nextMonth && availableMonths.includes(nextMonth)) {
      setSelectedMonth(nextMonth);
      setPaymentsPage(1);
    }
  }, [selectedMonth, availableMonths]);

  const goToCurrentMonth = useCallback(() => {
    if (systemMonth && systemMonth !== selectedMonth) {
      setSelectedMonth(systemMonth);
      setPaymentsPage(1);
      showNotification(`Switched to ${getMonthLabel(systemMonth)}`, 'success');
    }
  }, [systemMonth, selectedMonth]);

  const handleMonthSelect = useCallback((month: string) => {
    if (month !== selectedMonth) {
      setSelectedMonth(month);
      setPaymentsPage(1);
    }
  }, [selectedMonth]);

  // ===== UPDATE PAYMENT STATUS =====
  const updatePaymentStatus = useCallback(async (employeeId: string, newStatus: string) => {
    if (!canEdit) {
      showNotification('Payments can only be edited for the current month.', 'error');
      return;
    }

    try {
      const existing = payments.find(p => p.employee_id === employeeId);
      const oldStatus = existing?.status || 'pending';
      const employeeName = existing?.full_name || 'Unknown';
      const employeeNumber = existing?.employee_number || 'N/A';
      
      const updateData: any = {
        status: newStatus,
        updated_at: new Date().toISOString()
      };
      
      if (newStatus === 'paid' && existing?.status !== 'paid') {
        updateData.payment_date = new Date().toISOString().split('T')[0];
      }
      
      const oldData = {
        status: oldStatus,
        payment_date: existing?.payment_date || null,
        transaction_id: existing?.transaction_id || null,
        account_number: existing?.account_number || null,
        employee_name: employeeName,
        employee_number: employeeNumber
      };
      
      const newData = {
        status: newStatus,
        payment_date: updateData.payment_date || null,
        employee_id: employeeId,
        month: selectedMonth,
        employee_name: employeeName,
        employee_number: employeeNumber
      };
      
      if (existing?.id) {
        const { error } = await supabase
          .from('payment_status')
          .update(updateData)
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('payment_status')
          .insert([{
            employee_id: employeeId,
            month: `${selectedMonth}-01`,
            net_pay: existing?.net_pay,
            status: newStatus,
            payment_date: newStatus === 'paid' ? new Date().toISOString().split('T')[0] : null,
          }]);
        if (error) throw error;
      }

      await logAudit({
        action: 'UPDATE',
        entity_type: 'payment_status',
        entity_id: existing?.id || employeeId,
        old_data: oldData,
        new_data: newData,
        region_id: userProfile?.region_id
      });
      
      const statusMessages: Record<string, string> = {
        pending: 'marked as Pending',
        processing: 'moved to Processing',
        paid: 'marked as Paid',
        confirmed: 'confirmed receipt',
        failed: 'marked as Failed'
      };
      
      showNotification(`Payment ${statusMessages[newStatus] || `updated to ${newStatus}`}`, 'success');
      fetchPaymentData();
    } catch (err) {
      console.error('Error updating status:', err);
      showNotification('Failed to update status', 'error');
    }
  }, [canEdit, payments, selectedMonth, userProfile, fetchPaymentData]);

  // ===== UPDATE PAYMENT DETAILS =====
  const updatePaymentDetails = useCallback(async (payment: any) => {
    if (!canEdit) {
      showNotification('Payments can only be edited for the current month.', 'error');
      return;
    }

    try {
      const existing = payments.find(p => p.employee_id === payment.employee_id);
      
      const oldData = existing ? { 
        account_number: existing.account_number, 
        notes: existing.notes, 
        transaction_id: existing.transaction_id 
      } : null;
      
      const updateData = {
        account_number: payment.account_number,
        notes: payment.notes,
        transaction_id: payment.transaction_id,
        updated_at: new Date().toISOString()
      };
      
      let entityId;
      let action: 'CREATE' | 'UPDATE' = 'UPDATE';
      
      if (existing?.id) {
        entityId = existing.id;
        const { error } = await supabase
          .from('payment_status')
          .update(updateData)
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        action = 'CREATE';
        entityId = payment.employee_id;
        const { error } = await supabase
          .from('payment_status')
          .insert([{
            employee_id: payment.employee_id,
            month: `${selectedMonth}-01`,
            net_pay: payment.net_pay,
            account_number: payment.account_number,
            notes: payment.notes,
            transaction_id: payment.transaction_id,
            status: 'pending',
          }]);
        if (error) throw error;
      }
      
      await logAudit({
        action: action,
        entity_type: 'payment_status',
        entity_id: entityId,
        old_data: oldData,
        new_data: updateData,
        region_id: userProfile?.region_id
      });
      
      showNotification('Payment details updated', 'success');
      setShowEditModal(false);
      setEditingPayment(null);
      fetchPaymentData();
    } catch (err) {
      console.error('Error updating:', err);
      showNotification('Failed to update payment details', 'error');
    }
  }, [canEdit, payments, selectedMonth, userProfile, fetchPaymentData]);

  // ===== BULK UPDATE STATUS =====
  const bulkUpdateStatus = useCallback(async (newStatus: string) => {
    if (!canEdit) {
      showNotification('Payments can only be edited for the current month.', 'error');
      return;
    }

    if (selectedEmployees.length === 0) {
      showNotification('Please select employees to process', 'error');
      return;
    }
    
    setProcessingBulk(true);
    let successCount = 0;
    const updatedEmployees: any[] = [];
    
    for (const employeeId of selectedEmployees) {
      const payment = payments.find(p => p.employee_id === employeeId);
      const oldStatus = payment?.status || 'pending';
      const employeeName = payment?.full_name || 'Unknown';
      const employeeNumber = payment?.employee_number || 'N/A';
      
      try {
        const updateData: any = { status: newStatus, updated_at: new Date().toISOString() };
        if (newStatus === 'paid' && payment?.status !== 'paid') {
          updateData.payment_date = new Date().toISOString().split('T')[0];
        }
        
        if (payment?.id) {
          const { error } = await supabase
            .from('payment_status')
            .update(updateData)
            .eq('id', payment.id);
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from('payment_status')
            .insert([{
              employee_id: employeeId,
              month: `${selectedMonth}-01`,
              net_pay: payment?.net_pay,
              status: newStatus,
              payment_date: newStatus === 'paid' ? new Date().toISOString().split('T')[0] : null,
            }]);
          if (error) throw error;
        }
        successCount++;
        updatedEmployees.push({
          employee_id: employeeId,
          employee_name: employeeName,
          employee_number: employeeNumber,
          old_status: oldStatus,
          new_status: newStatus
        });
      } catch (err) {
        console.error('Error in bulk update:', err);
      }
    }
    
    await logAudit({
      action: 'UPDATE',
      entity_type: 'payment_status',
      new_data: {
        bulk_update: true,
        count: successCount,
        employees: updatedEmployees,
        new_status: newStatus,
        month: selectedMonth
      },
      region_id: userProfile?.region_id
    });
    
    showNotification(`Updated ${successCount} of ${selectedEmployees.length} employees`, 'success');
    setSelectedEmployees([]);
    fetchPaymentData();
    setProcessingBulk(false);
  }, [canEdit, selectedEmployees, payments, selectedMonth, userProfile, fetchPaymentData]);

  // ===== EXPORT PAYMENTS =====
  const exportPayments = useCallback(() => {
    const csv = [
      ['Employee Name', 'Employee #', 'Region', 'Company', 'Workstation', 'Pay Point', 'Account Number', 'Transaction ID', 'Net Pay', 'Status', 'Payment Date', 'Notes'],
      ...payments.map(p => [
        p.full_name,
        p.employee_number,
        regions.find(r => r.id === p.region_id)?.name || '',
        p.company || '',
        p.workstation || '',
        p.pay_point || '',
        p.account_number || '',
        p.transaction_id || '',
        formatKwacha(p.net_pay),
        p.status,
        p.payment_date || '',
        p.notes || ''
      ])
    ].map(row => row.join(',')).join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payments_${selectedMonth}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    logAudit({
      action: 'EXPORT',
      entity_type: 'payment_status',
      new_data: { 
        month: selectedMonth,
        employeeCount: payments.length,
        filters: { 
          filterStatus, 
          filterRegion, 
          filterCompany, 
          filterWorkstation, 
          filterPayPoint 
        }
      },
      region_id: userProfile?.region_id
    });
    
    showNotification('Payments exported successfully', 'success');
  }, [payments, regions, selectedMonth, userProfile]);

  // ===== TOGGLE SELECT =====
  const toggleSelectAll = useCallback(() => {
    if (selectedEmployees.length === payments.length) {
      setSelectedEmployees([]);
    } else {
      setSelectedEmployees(payments.map(p => p.employee_id));
    }
  }, [selectedEmployees, payments]);

  const toggleSelectEmployee = useCallback((employeeId: string) => {
    if (selectedEmployees.includes(employeeId)) {
      setSelectedEmployees(selectedEmployees.filter(id => id !== employeeId));
    } else {
      setSelectedEmployees([...selectedEmployees, employeeId]);
    }
  }, [selectedEmployees]);

  // ===== GET STATUS BADGE =====
  const getStatusBadge = useCallback((status: string) => {
    const statusIcons: Record<string, string> = {
      pending: '⏰',
      processing: '⏳',
      paid: '💰',
      confirmed: '✓',
      failed: '❌'
    };
    
    const statusLabels: Record<string, string> = {
      pending: 'Pending',
      processing: 'Processing',
      paid: 'Paid',
      confirmed: 'Confirmed',
      failed: 'Failed'
    };
    
    return (
      <Badge color={
        status === 'confirmed' ? 'green' :
        status === 'paid' ? 'blue' :
        status === 'processing' ? 'gold' :
        status === 'pending' ? 'yellow' : 'red'
      }>
        {statusIcons[status]} {statusLabels[status]}
      </Badge>
    );
  }, []);

  const getPaymentMethodIcon = useCallback((method: string) => {
    if (!method) return <Wallet size={14} className="text-gray-400" />;
    if (method.includes('bank')) return <Banknote size={14} className="text-blue-500" />;
    if (method.includes('money')) return <Smartphone size={14} className="text-green-500" />;
    return <CreditCard size={14} className="text-purple-500" />;
  }, []);

  // ===== RENDER =====
  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin"></div></div>;
  }

  const totalPages = Math.ceil(payments.length / paymentsItemsPerPage);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader 
        title="Payment Management" 
        subtitle={`${monthDisplayLabel} ${isCurrentMonth ? '● Current Month' : ''} · ${payments.length} payment records`}
        actions={
          <div className="flex gap-2">
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
                    {getMonthLabel(month)} {month === systemMonth ? '●' : ''}
                  </option>
                ))}
              </select>
              
              <button
                onClick={goToNextMonth}
                className="p-1.5 rounded hover:bg-slate-100 disabled:opacity-50"
                disabled={loading || !availableMonths.includes(getNextMonth(selectedMonth))}
                title="Next Month"
              >
                <ChevronRight size={16} />
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

            <Button variant="secondary" onClick={exportPayments}>
              <Download size={16} className="mr-1" /> Export
            </Button>
          </div>
        }
      />

      {!isCurrentMonth && (
        <Card className={`p-3 border ${selectedMonth > systemMonth ? 'bg-blue-50 border-blue-200' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex items-start gap-3">
            <Calendar size={18} className={`shrink-0 mt-0.5 ${selectedMonth > systemMonth ? 'text-blue-600' : 'text-amber-600'}`} />
            <div>
              <p className={`text-sm font-medium ${selectedMonth > systemMonth ? 'text-blue-800' : 'text-amber-800'}`}>
                {selectedMonth > systemMonth ? 'Viewing Future Month' : 'Viewing Past Month'}
              </p>
              <p className={`text-sm ${selectedMonth > systemMonth ? 'text-blue-700' : 'text-amber-700'}`}>
                {selectedMonth > systemMonth 
                  ? 'You are viewing a future month. Payments can only be edited for the current month.' 
                  : 'You are viewing a past month. Payments can only be edited for the current month.'}
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

      {!isSuperAdmin && userRegion && (
        <Card className="p-3 bg-gradient-to-r from-[#081C3A]/5 to-transparent border-[#081C3A]/20">
          <p className="text-sm text-slate-600">
            Managing payments for <strong className="text-[#081C3A]">{userRegion.name}</strong> region
          </p>
        </Card>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
        <Card className="p-3 text-center">
          <p className="text-xs text-slate-500">Total</p>
          <p className="text-xl font-bold text-slate-800">{stats.total}</p>
          <p className="text-[10px] text-slate-400">{formatKwacha(stats.totalAmount)}</p>
        </Card>
        <Card className="p-3 text-center bg-yellow-50">
          <p className="text-xs text-yellow-600">Pending</p>
          <p className="text-xl font-bold text-yellow-700">{stats.pending}</p>
        </Card>
        <Card className="p-3 text-center bg-blue-50">
          <p className="text-xs text-blue-600">Processing</p>
          <p className="text-xl font-bold text-blue-700">{stats.processing}</p>
        </Card>
        <Card className="p-3 text-center bg-indigo-50">
          <p className="text-xs text-indigo-600">Paid</p>
          <p className="text-xl font-bold text-indigo-700">{stats.paid}</p>
        </Card>
        <Card className="p-3 text-center bg-emerald-50">
          <p className="text-xs text-emerald-600">Confirmed</p>
          <p className="text-xl font-bold text-emerald-700">{stats.confirmed}</p>
        </Card>
        <Card className="p-3 text-center bg-red-50">
          <p className="text-xs text-red-600">Failed</p>
          <p className="text-xl font-bold text-red-700">{stats.failed}</p>
        </Card>
        <Card className="p-3 text-center bg-[#FFF1CC]">
          <p className="text-xs text-[#D4A017]">Total Amount</p>
          <p className="text-sm font-bold text-[#D4A017]">{formatKwacha(stats.totalAmount)}</p>
        </Card>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
          <div className="relative md:col-span-2">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              id="searchPayments"
              name="searchPayments"
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, employee #..."
              className="w-full pl-10 pr-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>
          <select
            id="filterStatus"
            name="filterStatus"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
          >
            {statusOptions.map(s => <option key={s} value={s}>{s.toUpperCase()}</option>)}
          </select>
          <select
            id="filterPayPoint"
            name="filterPayPoint"
            value={filterPayPoint}
            onChange={e => setFilterPayPoint(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
          >
            {payPointOptions.map(p => <option key={p} value={p}>{p === 'all' ? 'All Pay Points' : p.replace('_', ' ').toUpperCase()}</option>)}
          </select>
          {isSuperAdmin && (
            <select
              id="filterRegion"
              name="filterRegion"
              value={filterRegion}
              onChange={e => setFilterRegion(e.target.value)}
              className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
            >
              <option value="all">All Regions</option>
              {regions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          <input
            id="filterCompany"
            name="filterCompany"
            type="text"
            value={filterCompany}
            onChange={e => setFilterCompany(e.target.value.toUpperCase())}
            placeholder="Company..."
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
          />
          <input
            id="filterWorkstation"
            name="filterWorkstation"
            type="text"
            value={filterWorkstation}
            onChange={e => setFilterWorkstation(e.target.value.toUpperCase())}
            placeholder="Workstation..."
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
          />
          <Button variant="outline" onClick={() => {
            setFilterCompany('');
            setFilterWorkstation('');
            setFilterStatus('all');
            setFilterPayPoint('all');
            if (isSuperAdmin) setFilterRegion('all');
            setSearch('');
            setPaymentsPage(1);
          }} className="text-sm">
            <RefreshCw size={14} className="mr-1" /> Clear
          </Button>
        </div>
      </Card>

      {/* Edit Mode Indicator */}
      {!canEdit && payments.length > 0 && (
        <Card className="p-3 bg-amber-50 border-amber-200 border">
          <div className="flex items-center gap-2">
            <Lock size={16} className="text-amber-600" />
            <p className="text-sm text-amber-700">
              <strong>View Only Mode:</strong> Payments can only be edited for the current month ({getMonthLabel(systemMonth)}).
            </p>
          </div>
        </Card>
      )}

      {/* Bulk Actions - Only show for current month */}
      {selectedEmployees.length > 0 && canEdit && (
        <Card className="p-3 bg-blue-50 border-blue-200">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-sm font-medium text-blue-700">
              {selectedEmployees.length} employee(s) selected
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setSelectedEmployees([])}>
                Clear
              </Button>
              <Button size="sm" onClick={() => bulkUpdateStatus('processing')} disabled={processingBulk}>
                <Clock size={14} className="mr-1" /> Mark Processing
              </Button>
              <Button size="sm" variant="secondary" onClick={() => bulkUpdateStatus('paid')} disabled={processingBulk}>
                <DollarSign size={14} className="mr-1" /> Mark Paid
              </Button>
            </div>
          </div>
        </Card>
      )}

  
<div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <THead>
        <TR hover={false}>
          <TH className="w-8">
            <input
              type="checkbox"
              checked={selectedEmployees.length === payments.length && payments.length > 0 && canEdit}
              onChange={toggleSelectAll}
              disabled={!canEdit}
              className="w-4 h-4 rounded border-slate-300 disabled:opacity-50"
            />
          </TH>
          <TH>Employee</TH>
          <TH className="hidden lg:table-cell">Company</TH>
          <TH className="hidden xl:table-cell">Workstation</TH>
          <TH>Pay Point</TH>
          <TH className="hidden md:table-cell">Account Number</TH> {/* NEW COLUMN */}
          <TH className="text-right">Net Pay</TH>
          <TH>Status</TH>
          <TH className="text-right">Actions</TH>
        </TR>
      </THead>
      <TBody>
        {paginatedPayments.map((p) => (
          <TR key={p.employee_id} className="hover:bg-slate-50">
            <TD className="w-8">
              <input
                type="checkbox"
                checked={selectedEmployees.includes(p.employee_id)}
                onChange={() => toggleSelectEmployee(p.employee_id)}
                disabled={!canEdit}
                className="w-4 h-4 rounded border-slate-300 disabled:opacity-50"
              />
            </TD>
            <TD>
              <div>
                <p className="font-medium text-slate-800">{p.full_name}</p>
                <p className="text-xs text-slate-500">{p.employee_number}</p>
                <p className="text-xs text-slate-400">{p.phone}</p>
              </div>
            </TD>
            <TD className="hidden lg:table-cell">
              <span className="text-xs">{p.company || '-'}</span>
            </TD>
            <TD className="hidden xl:table-cell">
              <span className="text-xs">{p.workstation || '-'}</span>
            </TD>
            <TD>
              <div className="flex items-center gap-1">
                {getPaymentMethodIcon(p.pay_point)}
                <span className="text-xs capitalize">
                  {p.pay_point?.replace('_', ' ') || '-'}
                </span>
              </div>
            </TD>
            <TD className="hidden md:table-cell"> {/* NEW COLUMN DATA */}
              <div className="flex flex-col">
                <span className="text-xs font-mono text-slate-700">
                  {p.account_number || '-'}
                </span>
                {!p.account_number && (
                  <span className="text-[10px] text-amber-500">No account set</span>
                )}
              </div>
            </TD>
            <TD className="text-right font-semibold text-[#D4A017]">
              {formatKwacha(p.net_pay)}
              {p.net_pay_is_estimate && (
                <span
                  className="ml-1 text-[10px] font-normal text-amber-500 align-top"
                  title="No approved payroll run found for this month yet — showing a live calculated estimate (same formula as the Payroll page), not the final approved net pay."
                >
                  (est.)
                </span>
              )}
            </TD>
            <TD>{getStatusBadge(p.status)}</TD>
            <TD className="text-right">
              <div className="flex items-center justify-end gap-1">
                {/* Edit button - only visible for current month */}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingPayment(p);
                      setShowEditModal(true);
                    }}
                    className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-600"
                    title="Edit Details"
                  >
                    <Edit2 size={14} />
                  </button>
                )}
                
                {/* Status change buttons - only for current month */}
                {canEdit && p.status === 'pending' && (
                  <button
                    type="button"
                    onClick={() => updatePaymentStatus(p.employee_id, 'processing')}
                    className="w-7 h-7 rounded-lg hover:bg-blue-100 text-blue-600"
                    title="Move to Processing"
                  >
                    <Clock size={14} />
                  </button>
                )}
                
                {canEdit && p.status === 'processing' && (
                  <>
                    <button
                      type="button"
                      onClick={() => updatePaymentStatus(p.employee_id, 'pending')}
                      className="w-7 h-7 rounded-lg hover:bg-yellow-100 text-yellow-600"
                      title="Move back to Pending"
                    >
                      <Undo size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => updatePaymentStatus(p.employee_id, 'paid')}
                      className="w-7 h-7 rounded-lg hover:bg-emerald-100 text-emerald-600"
                      title="Mark as Paid"
                    >
                      <DollarSign size={14} />
                    </button>
                  </>
                )}
                
                {canEdit && p.status === 'paid' && (
                  <>
                    <button
                      type="button"
                      onClick={() => updatePaymentStatus(p.employee_id, 'processing')}
                      className="w-7 h-7 rounded-lg hover:bg-blue-100 text-blue-600"
                      title="Move back to Processing"
                    >
                      <Undo size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => updatePaymentStatus(p.employee_id, 'confirmed')}
                      className="w-7 h-7 rounded-lg hover:bg-green-100 text-green-600"
                      title="Confirm Receipt"
                    >
                      <CheckCircle size={14} />
                    </button>
                  </>
                )}
                
                {canEdit && p.status === 'confirmed' && (
                  <>
                    <button
                      type="button"
                      onClick={() => updatePaymentStatus(p.employee_id, 'paid')}
                      className="w-7 h-7 rounded-lg hover:bg-indigo-100 text-indigo-600"
                      title="Move back to Paid"
                    >
                      <Undo size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => updatePaymentStatus(p.employee_id, 'failed')}
                      className="w-7 h-7 rounded-lg hover:bg-red-100 text-red-600"
                      title="Mark as Failed"
                    >
                      <XCircle size={14} />
                    </button>
                  </>
                )}
                
                {/* Failed status - can reset */}
                {canEdit && p.status === 'failed' && (
                  <button
                    type="button"
                    onClick={() => updatePaymentStatus(p.employee_id, 'pending')}
                    className="w-7 h-7 rounded-lg hover:bg-yellow-100 text-yellow-600"
                    title="Reset to Pending"
                  >
                    <Repeat size={14} />
                  </button>
                )}

                {/* View Only indicator */}
                {!canEdit && (
                  <span className="text-xs text-slate-400">🔒</span>
                )}
              </div>
            </TD>
          </TR>
        ))}
      </TBody>
    </table>
  </div>
  {payments.length === 0 && (
    <div className="text-center py-8 text-slate-500">
      <Wallet size={32} className="mx-auto mb-2 text-slate-300" />
      No payment records found for {getMonthLabel(selectedMonth)}
    </div>
  )}
</div>

      <Pagination
        currentPage={paymentsPage}
        totalPages={totalPages}
        totalItems={payments.length}
        itemsPerPage={paymentsItemsPerPage}
        onPageChange={setPaymentsPage}
        onItemsPerPageChange={setPaymentsItemsPerPage}
      />

      {/* Edit Payment Modal - Only show for current month */}
      {canEdit && (
        <Modal open={showEditModal} onClose={() => { setShowEditModal(false); setEditingPayment(null); }} title="Edit Payment Details" size="md">
          {editingPayment && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="editEmployeeName" className="block text-sm font-medium text-slate-700 mb-1">Employee</label>
                  <input
                    id="editEmployeeName"
                    name="editEmployeeName"
                    type="text"
                    value={editingPayment.full_name}
                    disabled
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50"
                  />
                </div>
                <div>
                  <label htmlFor="editEmployeeNumber" className="block text-sm font-medium text-slate-700 mb-1">Employee #</label>
                  <input
                    id="editEmployeeNumber"
                    name="editEmployeeNumber"
                    type="text"
                    value={editingPayment.employee_number}
                    disabled
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="editAccountNumber" className="block text-sm font-medium text-slate-700 mb-1">Account Number</label>
                <input
                  id="editAccountNumber"
                  name="editAccountNumber"
                  type="text"
                  value={editingPayment.account_number || ''}
                  onChange={(e) => setEditingPayment({...editingPayment, account_number: e.target.value})}
                  placeholder="Enter bank account number or mobile money number"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label htmlFor="editTransactionId" className="block text-sm font-medium text-slate-700 mb-1">Transaction ID (Optional)</label>
                <input
                  id="editTransactionId"
                  name="editTransactionId"
                  type="text"
                  value={editingPayment.transaction_id || ''}
                  onChange={(e) => setEditingPayment({...editingPayment, transaction_id: e.target.value})}
                  placeholder="Enter bank transaction reference"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label htmlFor="editNotes" className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea
                  id="editNotes"
                  name="editNotes"
                  value={editingPayment.notes || ''}
                  onChange={(e) => setEditingPayment({...editingPayment, notes: e.target.value})}
                  placeholder="Add notes about this payment..."
                  rows={3}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <Button variant="outline" onClick={() => { setShowEditModal(false); setEditingPayment(null); }}>
                  Cancel
                </Button>
                <Button variant="secondary" onClick={() => updatePaymentDetails(editingPayment)}>
                  <Save size={14} className="mr-1" /> Save Changes
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

export default PaymentsPage;