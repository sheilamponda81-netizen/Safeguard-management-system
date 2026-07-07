import { useState, useMemo, useEffect, useCallback } from 'react';
import { Search, FileText, Download, Printer, Eye, Shield, FileDown, User, Building2, Calendar, Clock, CheckCircle, XCircle, AlertCircle, ChevronLeft, ChevronRight } from '../utils/icons';

import { Card, Button, Badge, PageHeader, THead, TBody, TR, TH, TD, Modal } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { showNotification } from '../utils/clickHandlers';
import { logAudit } from '../utils/auditLogger';
import { 
  getSystemCurrentMonth, 
  getMonthLabel, 
  getNextMonth, 
  getPreviousMonth,
  getAvailableMonthsFromSystem
} from '../utils/currentMonth';
import { Pagination } from '../components/Pagination';

interface Employee {
  id: string;
  employeeNumber: string;
  fullName: string;
  position: string;
  department: string;
  basicSalary: number;
  status: string;
  payPoint?: string;
  contractType?: string;
  region_id?: string;
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
  employee?: Employee;
}

interface PayslipData {
  employee: Employee;
  payroll: PayrollRecord;
  month: string;
  year: string;
}

export function PayslipsPage() {
  // ===== ALL HOOKS AT TOP LEVEL =====
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [payrollRecords, setPayrollRecords] = useState<PayrollRecord[]>([]);
  const [payslips, setPayslips] = useState<PayslipData[]>([]);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<PayslipData | null>(null);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [selectedYear, setSelectedYear] = useState('');
  const [systemMonth, setSystemMonth] = useState('');
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // ===== PAGINATION STATES =====
  const [payslipsPage, setPayslipsPage] = useState(1);
  const [payslipsItemsPerPage, setPayslipsItemsPerPage] = useState(18);

  // ===== MEMOIZED VALUES =====
  const months = useMemo(() => ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], []);
  const years = useMemo(() => ['2023', '2024', '2025', '2026', '2027'], []);
  
  const currentMonthYear = useMemo(() => {
    return `${selectedYear}-${String(months.indexOf(selectedMonth) + 1).padStart(2, '0')}`;
  }, [selectedMonth, selectedYear, months]);

  const isCurrentMonth = useMemo(() => currentMonthYear === systemMonth, [currentMonthYear, systemMonth]);
  const monthDisplayLabel = useMemo(() => `${selectedMonth} ${selectedYear}`, [selectedMonth, selectedYear]);

  const filtered = useMemo(() => {
    return payslips.filter(p => 
      p.employee.fullName.toLowerCase().includes(search.toLowerCase()) || 
      p.employee.employeeNumber.toLowerCase().includes(search.toLowerCase())
    );
  }, [payslips, search]);

  // ===== PAGINATED PAYSLIPS =====
  const paginatedPayslips = useMemo(() => {
    const startIndex = (payslipsPage - 1) * payslipsItemsPerPage;
    const endIndex = Math.min(startIndex + payslipsItemsPerPage, filtered.length);
    return filtered.slice(startIndex, endIndex);
  }, [filtered, payslipsPage, payslipsItemsPerPage]);

  // ===== RESET PAGE WHEN SEARCH CHANGES =====
  useEffect(() => {
    setPayslipsPage(1);
  }, [search]);

  // ===== CALLBACKS =====
  const fetchUserProfile = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('*, regions(*)')
        .eq('id', user.id)
        .single();
      setUserProfile(profile);
    }
  }, []);

  const fetchPayslipData = useCallback(async () => {
    setLoading(true);
    try {
      const monthYear = `${selectedYear}-${String(months.indexOf(selectedMonth) + 1).padStart(2, '0')}`;
      
      let employeesQuery = supabase
        .from('employees')
        .select('id, employee_number, full_name, position, department, basic_salary, status, pay_point, contract_type, region_id')
        .eq('status', 'Active');

      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        employeesQuery = employeesQuery.eq('region_id', userProfile.region_id);
      }

      const { data: employeesData, error: empError } = await employeesQuery;
      if (empError) throw empError;

      const mappedEmployees = (employeesData || []).map((emp: any) => ({
        id: emp.id,
        employeeNumber: emp.employee_number,
        fullName: emp.full_name,
        position: emp.position,
        department: emp.department || 'Operations',
        basicSalary: emp.basic_salary || 0,
        status: emp.status || 'Active',
        payPoint: emp.pay_point || 'N/A',
        contractType: emp.contract_type || 'Permanent',
        region_id: emp.region_id
      }));

      setEmployees(mappedEmployees);

      let payrollQuery = supabase
        .from('payroll')
        .select('*')
        .eq('month', monthYear);

      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        const employeeIds = mappedEmployees.map(e => e.id);
        if (employeeIds.length > 0) {
          payrollQuery = payrollQuery.in('employee_id', employeeIds);
        }
      }

      const { data: payrollData, error: payError } = await payrollQuery;
      if (payError) throw payError;

      setPayrollRecords(payrollData || []);

      const payslipData: PayslipData[] = [];
      
      if (payrollData && payrollData.length > 0) {
        payrollData.forEach((payroll: any) => {
          const employee = mappedEmployees.find((e: Employee) => e.id === payroll.employee_id);
          if (employee) {
            payslipData.push({
              employee,
              payroll: {
                id: payroll.id,
                employee_id: payroll.employee_id,
                month: payroll.month,
                basic_salary: payroll.basic_salary,
                allowances: payroll.allowances || 0,
                overtime: payroll.overtime || 0,
                bonus: payroll.bonus || 0,
                gross_pay: payroll.gross_pay,
                paye: payroll.paye || 0,
                pension: payroll.pension || 0,
                uniform_deduction: payroll.uniform_deduction || 0,
                net_pay: payroll.net_pay,
                processed_at: payroll.processed_at
              },
              month: selectedMonth,
              year: selectedYear
            });
          }
        });
      }

      setPayslips(payslipData);
    } catch (err: any) {
      console.error('Error fetching payslip data:', err);
      showNotification('Failed to load payslips', 'error');
    } finally {
      setLoading(false);
    }
  }, [selectedMonth, selectedYear, userProfile, months]);

  // ===== INITIALIZATION =====
  useEffect(() => {
    const init = async () => {
      const month = await getSystemCurrentMonth();
      setSystemMonth(month);
      
      const [year, monthNum] = month.split('-');
      const monthName = months[parseInt(monthNum) - 1];
      setSelectedMonth(monthName);
      setSelectedYear(year);
      
      const monthsList = getAvailableMonthsFromSystem(month);
      setAvailableMonths(monthsList);
      
      await fetchUserProfile();
    };
    init();
  }, [fetchUserProfile, months]);

  useEffect(() => {
    if (userProfile && selectedMonth && selectedYear) {
      fetchPayslipData();
    }
  }, [selectedMonth, selectedYear, userProfile, fetchPayslipData]);

  // ===== MONTH NAVIGATION =====
  const goToPreviousMonth = useCallback(() => {
    const prevMonth = getPreviousMonth(currentMonthYear);
    if (prevMonth && availableMonths.includes(prevMonth)) {
      const [year, monthNum] = prevMonth.split('-');
      setSelectedYear(year);
      setSelectedMonth(months[parseInt(monthNum) - 1]);
      setPayslipsPage(1);
    }
  }, [currentMonthYear, availableMonths, months]);

  const goToNextMonth = useCallback(() => {
    const nextMonth = getNextMonth(currentMonthYear);
    if (nextMonth && availableMonths.includes(nextMonth)) {
      const [year, monthNum] = nextMonth.split('-');
      setSelectedYear(year);
      setSelectedMonth(months[parseInt(monthNum) - 1]);
      setPayslipsPage(1);
    } else {
      showNotification('Cannot go beyond available months.', 'error');
    }
  }, [currentMonthYear, availableMonths, months]);

  const goToCurrentMonth = useCallback(() => {
    if (systemMonth) {
      const [year, monthNum] = systemMonth.split('-');
      setSelectedYear(year);
      setSelectedMonth(months[parseInt(monthNum) - 1]);
      setPayslipsPage(1);
      showNotification(`Switched to ${getMonthLabel(systemMonth)}`, 'success');
    }
  }, [systemMonth, months]);

  const handleMonthSelect = useCallback((month: string) => {
    setSelectedMonth(month);
    setPayslipsPage(1);
  }, []);

  const handleYearSelect = useCallback((year: string) => {
    setSelectedYear(year);
    setPayslipsPage(1);
  }, []);

  // ===== PDF DOWNLOAD =====
  const handlePDFDownload = useCallback(async (payslip: PayslipData) => {
    try {
      const employee = payslip.employee;
      const p = payslip.payroll;
      const n = p.net_pay;
      
      const payslipHTML = `<!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Payslip - ${employee.fullName}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; color: #1a1a2e; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #081C3A; padding-bottom: 20px; margin-bottom: 20px; }
            .company-name { font-size: 24px; font-weight: bold; color: #081C3A; }
            .company-sub { font-size: 12px; color: #666; }
            .payslip-title { font-size: 20px; font-weight: bold; color: #081C3A; text-align: right; }
            .employee-info { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; padding: 15px 0; border-bottom: 1px solid #ddd; margin-bottom: 20px; font-size: 13px; }
            .employee-info .label { color: #666; font-size: 11px; }
            .employee-info .value { font-weight: 600; color: #1a1a2e; }
            .earnings-deductions { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-bottom: 20px; }
            .section-title { font-size: 13px; font-weight: bold; color: #081C3A; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #ddd; padding-bottom: 8px; margin-bottom: 12px; }
            .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5; }
            .row .label { color: #555; }
            .row .amount { font-weight: 500; font-family: monospace; }
            .total-row { display: flex; justify-content: space-between; padding: 10px 0; font-size: 15px; font-weight: bold; border-top: 2px solid #ddd; margin-top: 8px; }
            .total-row .amount { color: #081C3A; }
            .net-pay-section { background: linear-gradient(135deg, #081C3A 0%, #1a2f5c 100%); color: white; padding: 20px 25px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; margin-top: 20px; }
            .net-pay-section .label { font-size: 12px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px; }
            .net-pay-section .amount { font-size: 28px; font-weight: bold; color: #D4A017; }
            .footer { text-align: center; font-size: 11px; color: #999; margin-top: 20px; padding-top: 15px; border-top: 1px solid #eee; }
            .deduction-item .amount { color: #dc2626; }
            @media print { body { padding: 20px; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <div class="company-name">SAFEGUARD SECURITY SERVICES</div>
              <div class="company-sub">Lilongwe, Malawi · (+265) 1 234 567</div>
            </div>
            <div>
              <div class="payslip-title">PAYSLIP</div>
              <div style="text-align: right; font-size: 12px; color: #666;">${selectedMonth} ${selectedYear}</div>
            </div>
          </div>
          <div class="employee-info">
            <div><div class="label">Employee</div><div class="value">${employee.fullName}</div></div>
            <div><div class="label">Employee No.</div><div class="value">${employee.employeeNumber}</div></div>
            <div><div class="label">Position</div><div class="value">${employee.position}</div></div>
            <div><div class="label">Department</div><div class="value">${employee.department}</div></div>
            <div><div class="label">Pay Period</div><div class="value">${selectedMonth} 01 - ${selectedMonth} 30, ${selectedYear}</div></div>
            <div><div class="label">Pay Point</div><div class="value">${employee.payPoint || 'N/A'}</div></div>
            <div><div class="label">Contract</div><div class="value">${employee.contractType || 'Permanent'}</div></div>
            <div><div class="label">Date Paid</div><div class="value">${selectedMonth} 30, ${selectedYear}</div></div>
          </div>
          <div class="earnings-deductions">
            <div>
              <div class="section-title">Earnings</div>
              <div class="row"><span class="label">Basic Salary</span><span class="amount">${formatKwacha(p.basic_salary)}</span></div>
              <div class="row"><span class="label">Allowances</span><span class="amount">${formatKwacha(p.allowances)}</span></div>
              <div class="row"><span class="label">Overtime</span><span class="amount">${formatKwacha(p.overtime)}</span></div>
              <div class="row"><span class="label">Bonus</span><span class="amount">${formatKwacha(p.bonus)}</span></div>
              <div class="total-row"><span>Gross Pay</span><span class="amount">${formatKwacha(p.gross_pay)}</span></div>
            </div>
            <div>
              <div class="section-title">Deductions</div>
              <div class="row deduction-item"><span class="label">PAYE Tax</span><span class="amount">-${formatKwacha(p.paye)}</span></div>
              <div class="row deduction-item"><span class="label">Pension (5%)</span><span class="amount">-${formatKwacha(p.pension)}</span></div>
              <div class="row deduction-item"><span class="label">Uniform Deduction</span><span class="amount">-${formatKwacha(p.uniform_deduction)}</span></div>
              <div class="total-row" style="border-top-color: #dc2626;"><span>Total Deductions</span><span class="amount" style="color: #dc2626;">-${formatKwacha(p.paye + p.pension + p.uniform_deduction)}</span></div>
            </div>
          </div>
          <div class="net-pay-section">
            <div>
              <div class="label">Total Net Pay</div>
              <div class="amount">${formatKwacha(n)}</div>
            </div>
            <div style="text-align: right; font-size: 12px;">
              <div style="opacity: 0.8;">Payment Method: Bank Transfer</div>
              <div style="opacity: 0.8;">Authorized: William Banda (Admin)</div>
            </div>
          </div>
          <div class="footer">This is a system-generated payslip. No signature required.</div>
        </body>
        </html>`;

      const blob = new Blob([payslipHTML], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Payslip_${employee.fullName.replace(/\s/g, '_')}_${selectedMonth}_${selectedYear}.html`;
      
      document.body.appendChild(link);
      link.click();
      if (link.parentNode) link.parentNode.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 100);

      await logAudit({
        action: 'EXPORT',
        entity_type: 'payslip',
        new_data: { 
          employee_name: employee.fullName, 
          employee_number: employee.employeeNumber, 
          month: selectedMonth, 
          year: selectedYear, 
          net_pay: n 
        },
        region_id: userProfile?.region_id
      });

      showNotification(`Payslip for ${employee.fullName} downloaded successfully`, 'success');
    } catch (error: any) {
      console.error('PDF Download Error:', error);
      showNotification(`Failed to generate payslip: ${error.message || 'Unknown error'}`, 'error');
    }
  }, [selectedMonth, selectedYear, userProfile]);

  // ===== PRINT FUNCTION =====
  const handlePrint = useCallback((payslip: PayslipData) => {
    try {
      const employee = payslip.employee;
      const p = payslip.payroll;
      const n = p.net_pay;
      
      logAudit({
        action: 'VIEW',
        entity_type: 'payslip',
        new_data: { 
          employee_name: employee.fullName, 
          employee_number: employee.employeeNumber, 
          month: selectedMonth, 
          year: selectedYear, 
          action: 'print' 
        },
        region_id: userProfile?.region_id
      });

      const printWindow = window.open('', '_blank', 'width=800,height=600');
      if (!printWindow) {
        showNotification('Please allow pop-ups to print payslips', 'error');
        return;
      }

      const payslipHTML = `<!DOCTYPE html>
        <html>
        <head>
          <title>Payslip - ${employee.fullName}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; color: #1a1a2e; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #081C3A; padding-bottom: 20px; margin-bottom: 20px; }
            .company-name { font-size: 24px; font-weight: bold; color: #081C3A; }
            .company-sub { font-size: 12px; color: #666; }
            .payslip-title { font-size: 20px; font-weight: bold; color: #081C3A; text-align: right; }
            .employee-info { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; padding: 15px 0; border-bottom: 1px solid #ddd; margin-bottom: 20px; font-size: 13px; }
            .employee-info .label { color: #666; font-size: 11px; }
            .employee-info .value { font-weight: 600; color: #1a1a2e; }
            .earnings-deductions { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-bottom: 20px; }
            .section-title { font-size: 13px; font-weight: bold; color: #081C3A; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #ddd; padding-bottom: 8px; margin-bottom: 12px; }
            .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5; }
            .row .label { color: #555; }
            .row .amount { font-weight: 500; font-family: monospace; }
            .total-row { display: flex; justify-content: space-between; padding: 10px 0; font-size: 15px; font-weight: bold; border-top: 2px solid #ddd; margin-top: 8px; }
            .total-row .amount { color: #081C3A; }
            .net-pay-section { background: linear-gradient(135deg, #081C3A 0%, #1a2f5c 100%); color: white; padding: 20px 25px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; margin-top: 20px; }
            .net-pay-section .label { font-size: 12px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px; }
            .net-pay-section .amount { font-size: 28px; font-weight: bold; color: #D4A017; }
            .footer { text-align: center; font-size: 11px; color: #999; margin-top: 20px; padding-top: 15px; border-top: 1px solid #eee; }
            .deduction-item .amount { color: #dc2626; }
            @media print { body { padding: 20px; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <div class="company-name">SAFEGUARD SECURITY SERVICES</div>
              <div class="company-sub">Lilongwe, Malawi · (+265) 1 234 567</div>
            </div>
            <div>
              <div class="payslip-title">PAYSLIP</div>
              <div style="text-align: right; font-size: 12px; color: #666;">${selectedMonth} ${selectedYear}</div>
            </div>
          </div>
          <div class="employee-info">
            <div><div class="label">Employee</div><div class="value">${employee.fullName}</div></div>
            <div><div class="label">Employee No.</div><div class="value">${employee.employeeNumber}</div></div>
            <div><div class="label">Position</div><div class="value">${employee.position}</div></div>
            <div><div class="label">Department</div><div class="value">${employee.department}</div></div>
            <div><div class="label">Pay Period</div><div class="value">${selectedMonth} 01 - ${selectedMonth} 30, ${selectedYear}</div></div>
            <div><div class="label">Pay Point</div><div class="value">${employee.payPoint || 'N/A'}</div></div>
            <div><div class="label">Contract</div><div class="value">${employee.contractType || 'Permanent'}</div></div>
            <div><div class="label">Date Paid</div><div class="value">${selectedMonth} 30, ${selectedYear}</div></div>
          </div>
          <div class="earnings-deductions">
            <div>
              <div class="section-title">Earnings</div>
              <div class="row"><span class="label">Basic Salary</span><span class="amount">${formatKwacha(p.basic_salary)}</span></div>
              <div class="row"><span class="label">Allowances</span><span class="amount">${formatKwacha(p.allowances)}</span></div>
              <div class="row"><span class="label">Overtime</span><span class="amount">${formatKwacha(p.overtime)}</span></div>
              <div class="row"><span class="label">Bonus</span><span class="amount">${formatKwacha(p.bonus)}</span></div>
              <div class="total-row"><span>Gross Pay</span><span class="amount">${formatKwacha(p.gross_pay)}</span></div>
            </div>
            <div>
              <div class="section-title">Deductions</div>
              <div class="row deduction-item"><span class="label">PAYE Tax</span><span class="amount">-${formatKwacha(p.paye)}</span></div>
              <div class="row deduction-item"><span class="label">Pension (5%)</span><span class="amount">-${formatKwacha(p.pension)}</span></div>
              <div class="row deduction-item"><span class="label">Uniform Deduction</span><span class="amount">-${formatKwacha(p.uniform_deduction)}</span></div>
              <div class="total-row" style="border-top-color: #dc2626;"><span>Total Deductions</span><span class="amount" style="color: #dc2626;">-${formatKwacha(p.paye + p.pension + p.uniform_deduction)}</span></div>
            </div>
          </div>
          <div class="net-pay-section">
            <div>
              <div class="label">Total Net Pay</div>
              <div class="amount">${formatKwacha(n)}</div>
            </div>
            <div style="text-align: right; font-size: 12px;">
              <div style="opacity: 0.8;">Payment Method: Bank Transfer</div>
              <div style="opacity: 0.8;">Authorized: William Banda (Admin)</div>
            </div>
          </div>
          <div class="footer">This is a system-generated payslip. No signature required.</div>
        </body>
        </html>`;

      printWindow.document.write(payslipHTML);
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => printWindow.print(), 500);
    } catch (error: any) {
      console.error('Print error:', error);
      showNotification('Failed to print payslip', 'error');
    }
  }, [selectedMonth, selectedYear, userProfile]);

  // ===== RENDER =====
  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin"></div></div>;
  }

  const totalPages = Math.ceil(filtered.length / payslipsItemsPerPage);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader 
        title="Payslips" 
        subtitle={`${monthDisplayLabel} ${isCurrentMonth ? '● Current' : ''} · ${payslips.length} payslips available`} 
        actions={
          <>
            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2 py-1">
              <button
                onClick={goToPreviousMonth}
                className="p-1.5 rounded hover:bg-slate-100 disabled:opacity-50"
                disabled={loading || !availableMonths.includes(getPreviousMonth(currentMonthYear))}
                title="Previous Month"
              >
                <ChevronLeft size={16} />
              </button>
              
              <div className="flex items-center gap-1">
                <select 
                  value={selectedMonth} 
                  onChange={(e) => handleMonthSelect(e.target.value)}
                  className="bg-transparent border-none text-sm font-medium text-slate-700 focus:ring-0 py-1 min-w-[100px] text-center cursor-pointer"
                >
                  {months.map((month, index) => (
                    <option key={`month-${month}-${index}`} value={month}>{month}</option>
                  ))}
                </select>
                <select 
                  value={selectedYear} 
                  onChange={(e) => handleYearSelect(e.target.value)}
                  className="bg-transparent border-none text-sm font-medium text-slate-700 focus:ring-0 py-1 w-[80px] text-center cursor-pointer"
                >
                  {years.map((year, index) => (
                    <option key={`year-${year}-${index}`} value={year}>{year}</option>
                  ))}
                </select>
              </div>
              
              <button
                onClick={goToNextMonth}
                className="p-1.5 rounded hover:bg-slate-100 disabled:opacity-50"
                disabled={loading || !availableMonths.includes(getNextMonth(currentMonthYear))}
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
          </>
        } 
      />

      {!isCurrentMonth && (
        <Card className={`p-3 border ${currentMonthYear > systemMonth ? 'bg-blue-50 border-blue-200' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex items-start gap-3">
            <Calendar size={18} className={`shrink-0 mt-0.5 ${currentMonthYear > systemMonth ? 'text-blue-600' : 'text-amber-600'}`} />
            <div>
              <p className={`text-sm font-medium ${currentMonthYear > systemMonth ? 'text-blue-800' : 'text-amber-800'}`}>
                {currentMonthYear > systemMonth ? 'Viewing Future Month' : 'Viewing Past Month'}
              </p>
              <p className={`text-sm ${currentMonthYear > systemMonth ? 'text-blue-700' : 'text-amber-700'}`}>
                {payslips.length > 0 
                  ? `Showing ${payslips.length} payslip(s) for ${monthDisplayLabel}.`
                  : `No payslips found for ${monthDisplayLabel}. Payroll has not been processed for this month yet.`
                }
              </p>
            </div>
          </div>
        </Card>
      )}

      {payslips.length === 0 && (
        <Card className="p-12 text-center">
          <FileText size={48} className="mx-auto text-slate-300 mb-4" />
          <h3 className="text-lg font-semibold text-slate-800 mb-2">No Payslips Available</h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            No payslips found for {monthDisplayLabel}. 
            {isCurrentMonth 
              ? ' Payroll needs to be processed for this month first.'
              : ' Payroll was not processed for this month.'}
          </p>
          {isCurrentMonth && (
            <Button variant="secondary" className="mt-4" onClick={() => window.location.href = '/payroll'}>
              Go to Payroll
            </Button>
          )}
        </Card>
      )}

      {payslips.length > 0 && (
        <>
          <Card className="p-4 flex flex-col md:flex-row items-stretch md:items-center gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                value={search} 
                onChange={e => setSearch(e.target.value)} 
                placeholder="Search employees..." 
                className="w-full pl-10 pr-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
              />
            </div>
            <div className="text-sm text-slate-500">{filtered.length} payslips found</div>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {paginatedPayslips.map((payslip) => {
              const emp = payslip.employee;
              const p = payslip.payroll;
              const n = p.net_pay;
              return (
                <Card key={emp.id} className="p-5 hover:shadow-lg cursor-pointer transition-shadow" onClick={() => setView(payslip)}>
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-[#081C3A] text-white text-xs font-bold flex items-center justify-center">
                        {emp.fullName.split(' ').map(n => n[0]).join('').slice(0, 2)}
                      </div>
                      <div>
                        <p className="font-semibold text-slate-800 text-sm">{emp.fullName}</p>
                        <p className="text-xs text-slate-500">{emp.employeeNumber}</p>
                      </div>
                    </div>
                    <Badge color="green">Processed</Badge>
                  </div>
                  <div className="border-t border-slate-100 pt-4">
                    <p className="text-xs text-slate-500 mb-1">{selectedMonth} {selectedYear} · Net Pay</p>
                    <p className="text-2xl font-bold text-[#081C3A]">{formatKwacha(n)}</p>
                    <div className="flex gap-2 mt-4">
                      <Button variant="outline" className="text-xs py-1.5 flex-1" onClick={(e) => { e.stopPropagation(); handlePrint(payslip); }}>
                        <Printer size={12} /> Print
                      </Button>
                      <Button variant="secondary" className="text-xs py-1.5 flex-1" onClick={(e) => { e.stopPropagation(); handlePDFDownload(payslip); }}>
                        <Download size={12} /> PDF
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          <Pagination
            currentPage={payslipsPage}
            totalPages={totalPages}
            totalItems={filtered.length}
            itemsPerPage={payslipsItemsPerPage}
            onPageChange={setPayslipsPage}
            onItemsPerPageChange={setPayslipsItemsPerPage}
          />
        </>
      )}

      <Modal open={!!view} onClose={() => setView(null)} title={`Payslip Preview - ${selectedMonth} ${selectedYear}`} size="lg">
        {view && <PayslipPDF payslip={view} month={selectedMonth} year={selectedYear} onPrint={handlePrint} onDownload={handlePDFDownload} />}
      </Modal>
    </div>
  );
}

interface PayslipPDFProps {
  payslip: PayslipData;
  month: string;
  year: string;
  onPrint: (payslip: PayslipData) => void;
  onDownload: (payslip: PayslipData) => void;
}

function PayslipPDF({ payslip, month, year, onPrint, onDownload }: PayslipPDFProps) {
  const employee = payslip.employee;
  const p = payslip.payroll;
  const n = p.net_pay;

  return (
    <div className="space-y-5">
      <div className="p-6 rounded-lg border-2 border-slate-200 bg-white" id="payslip-content">
        <div className="flex items-start justify-between pb-4 border-b-2 border-[#081C3A]">
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-xl bg-[#081C3A] flex items-center justify-center">
              <Shield size={24} className="text-[#D4A017]" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-[#081C3A]">SAFEGUARD SECURITY SERVICES</h1>
              <p className="text-xs text-slate-500">Lilongwe, Malawi · (+265) 1 234 567</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold text-[#081C3A]">PAYSLIP</p>
            <p className="text-xs text-slate-500">{month} {year}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-4 text-xs border-b border-slate-100">
          <div><p className="text-slate-500">Employee</p><p className="font-semibold text-slate-800">{employee.fullName}</p></div>
          <div><p className="text-slate-500">Employee No.</p><p className="font-semibold text-slate-800">{employee.employeeNumber}</p></div>
          <div><p className="text-slate-500">Position</p><p className="font-semibold text-slate-800">{employee.position}</p></div>
          <div><p className="text-slate-500">Department</p><p className="font-semibold text-slate-800">{employee.department}</p></div>
          <div><p className="text-slate-500">Pay Period</p><p className="font-semibold text-slate-800">{month} 01 - {month} 30, {year}</p></div>
          <div><p className="text-slate-500">Pay Point</p><p className="font-semibold text-slate-800">{employee.payPoint || 'N/A'}</p></div>
          <div><p className="text-slate-500">Contract</p><p className="font-semibold text-slate-800">{employee.contractType || 'Permanent'}</p></div>
          <div><p className="text-slate-500">Date Paid</p><p className="font-semibold text-slate-800">{month} 30, {year}</p></div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-4">
          <div>
            <h3 className="text-xs font-bold text-[#081C3A] uppercase tracking-wider mb-3 pb-2 border-b border-slate-200">Earnings</h3>
            <div className="space-y-2 text-xs">
              {[
                ['Basic Salary', p.basic_salary],
                ['Allowances', p.allowances],
                ['Overtime', p.overtime],
                ['Bonus', p.bonus]
              ].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between">
                  <span className="text-slate-600">{k}</span>
                  <span className="font-mono text-slate-800">{formatKwacha(v as number)}</span>
                </div>
              ))}
              <div className="flex justify-between pt-2 mt-2 border-t border-slate-200 font-bold">
                <span>Gross Pay</span>
                <span className="font-mono text-[#081C3A]">{formatKwacha(p.gross_pay)}</span>
              </div>
            </div>
          </div>
          <div>
            <h3 className="text-xs font-bold text-[#081C3A] uppercase tracking-wider mb-3 pb-2 border-b border-slate-200">Deductions</h3>
            <div className="space-y-2 text-xs">
              {[
                ['PAYE Tax', p.paye],
                ['Pension (5%)', p.pension],
                ['Uniform Deduction', p.uniform_deduction]
              ].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between">
                  <span className="text-slate-600">{k}</span>
                  <span className="font-mono text-red-600">-{formatKwacha(v as number)}</span>
                </div>
              ))}
              <div className="flex justify-between pt-2 mt-2 border-t border-slate-200 font-bold">
                <span>Total Deductions</span>
                <span className="font-mono text-red-600">-{formatKwacha(p.paye + p.pension + p.uniform_deduction)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="p-5 rounded-lg bg-gradient-to-r from-[#081C3A] to-[#1a2f5c] text-white flex items-center justify-between">
          <div>
            <p className="text-xs opacity-80 uppercase tracking-wider">Total Net Pay</p>
            <p className="text-3xl font-bold text-[#D4A017]">{formatKwacha(n)}</p>
          </div>
          <div className="text-right text-xs">
            <p className="opacity-80">Payment Method: Bank Transfer</p>
            <p className="opacity-80">Authorized: William Banda (Admin)</p>
          </div>
        </div>

        <p className="text-center text-xs text-slate-400 mt-4">This is a system-generated payslip. No signature required.</p>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => onPrint(payslip)}>
          <Printer size={14} /> Print
        </Button>
        <Button variant="secondary" onClick={() => onDownload(payslip)}>
          <Download size={14} /> Download PDF
        </Button>
      </div>
    </div>
  );
}

export default PayslipsPage;