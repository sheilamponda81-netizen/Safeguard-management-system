import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Search, FileText, Download, Printer, Eye, Shield, FileDown, User, Building2, Calendar, Clock, CheckCircle, XCircle, AlertCircle, ChevronLeft, ChevronRight, Settings, Upload, Save, RefreshCw, Archive, FileArchive } from '../utils/icons';
import { Archive as ArchiveIcon, FileArchive as FileArchiveIcon } from 'lucide-react';
import { Card, Button, Badge, PageHeader, THead, TBody, TR, TH, TD, Modal } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { showNotification } from '../utils/clickHandlers';
import { logAudit } from '../utils/auditLogger';
import { getPayrollRates, PayrollRates } from '../utils/payrollSettings';
import {
  getSystemCurrentMonth,
  getMonthLabel,
  getNextMonth,
  getPreviousMonth,
  getAvailableMonthsFromSystem
} from '../utils/currentMonth';
import { Pagination } from '../components/Pagination';
import JSZip from 'jszip';

// ===== PERFORMANCE: Lazy load PDF libraries only when needed =====
const loadPDFLibraries = async () => {
  const [html2canvasModule, jsPDFModule] = await Promise.all([
    import('html2canvas'),
    import('jspdf')
  ]);
  return { 
    html2canvas: html2canvasModule.default, 
    jsPDF: jsPDFModule.default 
  };
};

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
  uniform_deduction?: number;
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
  employee?: Employee;
}

interface PayslipData {
  employee: Employee;
  payroll: PayrollRecord;
  month: string;
  year: string;
}

// ===== Extended Payroll Record with breakdown =====
interface ExtendedPayrollRecord extends PayrollRecord {
  absent_days?: number;
  late_days?: number;
  absent_deduction?: number;
  late_deduction?: number;
  lecture_deduction?: number;
  appearance_deduction?: number;
  uniform_amount?: number;
}

interface PayslipTemplate {
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  showLogo: boolean;
  showPayPoint: boolean;
  showContractType: boolean;
  showAuthorizedBy: boolean;
  authorizedName: string;
  authorizedTitle: string;
  footerText: string;
  primaryColor: string;
  secondaryColor: string;
}

const defaultTemplate: PayslipTemplate = {
  companyName: 'SAFEGUARD SECURITY SERVICES',
  companyAddress: 'Head Office Tikumbe Building - Naperi, P.O.Box 30158, Chichiri, Blantyre 3, Malawi.',
  companyPhone: '0882014775 / 0999957834',
  companyEmail: 'headoffice@safeguardsecurity.mw',
  showLogo: true,
  showPayPoint: true,
  showContractType: true,
  showAuthorizedBy: true,
  authorizedName: 'William Banda',
  authorizedTitle: 'Admin',
  footerText: 'This is a system-generated payslip. No signature required.',
  primaryColor: '#081C3A',
  secondaryColor: '#D4A017'
};

export function PayslipsPage() {
  // ===== ALL HOOKS AT TOP LEVEL =====
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [payrollRecords, setPayrollRecords] = useState<ExtendedPayrollRecord[]>([]);
  const [employeeDeductions, setEmployeeDeductions] = useState<any[]>([]);
  const [payslips, setPayslips] = useState<PayslipData[]>([]);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<PayslipData | null>(null);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [selectedYear, setSelectedYear] = useState('');
  const [systemMonth, setSystemMonth] = useState('');
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [template, setTemplate] = useState<PayslipTemplate>(defaultTemplate);
  const [downloading, setDownloading] = useState(false);
  const [payrollRates, setPayrollRates] = useState<PayrollRates>({ payeRate: 0.30, payeThreshold: 50000, pensionEmployeeRate: 0.05 });

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

  // ===== LOAD TEMPLATE FROM LOCAL STORAGE =====
  useEffect(() => {
    const savedTemplate = localStorage.getItem('payslipTemplate');
    if (savedTemplate) {
      try {
        const parsed = JSON.parse(savedTemplate);
        setTemplate({ ...defaultTemplate, ...parsed });
      } catch (e) {
        console.error('Error loading template:', e);
      }
    }
  }, []);

  // ===== SHARED PAYROLL RATES (PAYE rate/threshold, pension rate) FROM SETTINGS =====
  // Same source of truth Payroll.tsx and Payments.tsx use, so the rate labels
  // printed on a payslip ("PAYE Tax (X%)") always match what was actually
  // configured/applied, instead of a hardcoded "30%"/"5%".
  useEffect(() => {
    getPayrollRates().then(setPayrollRates);
  }, []);

  // ===== CALLBACKS =====
  const fetchUserProfile = useCallback(async () => {
    const profile = await getCurrentProfile();
    setUserProfile(profile);
  }, []);

  const fetchPayslipData = useCallback(async () => {
    setLoading(true);
    try {
      const monthYear = `${selectedYear}-${String(months.indexOf(selectedMonth) + 1).padStart(2, '0')}`;
      
      // CRITICAL: Exclude deleted employees and include uniform_deduction
      let employeesQuery = supabase
        .from('employees')
        .select('id, employee_number, full_name, position, department, basic_salary, status, pay_point, contract_type, region_id, uniform_deduction')
        .eq('status', 'Active')
        .eq('is_deleted', false);

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
        region_id: emp.region_id,
        uniform_deduction: emp.uniform_deduction ?? 10000
      }));

      setEmployees(mappedEmployees);
      const employeesById = new Map(mappedEmployees.map(e => [e.id, e]));

      // Positions eligible for a uniform deduction -- same flag Payroll.tsx
      // gates on, so a senior/office position never shows a fabricated
      // "Uniform Deduction" line here just because their employee record
      // still has a leftover uniform_deduction value.
      const { data: positionsData, error: posError } = await supabase
        .from('positions')
        .select('name, requires_uniform');
      if (posError) throw posError;
      const positionMap = new Map((positionsData || []).map(p => [p.name, p.requires_uniform !== false]));

      // Fetch payroll records
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

      const { data: rawPayrollData, error: payError } = await payrollQuery;
      if (payError) throw payError;

      // A rejected payroll run isn't valid pay data -- it's flagged for
      // rework and its figures may still change, so no payslip should be
      // generated from it. Pending and approved runs both produce payslips;
      // only the badge differs (see render below).
      const payrollData = (rawPayrollData || []).filter((r: any) => r.approval_status !== 'rejected');

      // Fetch employee deductions for the month
      const { data: deductionsData, error: dedError } = await supabase
        .from('employee_deductions')
        .select('*')
        .eq('month', monthYear);

      if (dedError) throw dedError;
      setEmployeeDeductions(deductionsData || []);

      setPayrollRecords(payrollData);

      const payslipData: PayslipData[] = [];

      if (payrollData.length > 0) {
        payrollData.forEach((payroll: any) => {
          const employee = employeesById.get(payroll.employee_id);
          const deduction = deductionsData?.find((d: any) => d.employee_id === payroll.employee_id);

          if (employee) {
            // Calculate deduction breakdown
            const absentDays = deduction?.absent_days || 0;
            const lateDays = deduction?.late_days || 0;
            const absentDeduction = absentDays * 4200;
            const lateDeduction = lateDays * 4200;
            const lectureDeduction = deduction?.lecture_deduction || 0;
            const appearanceDeduction = deduction?.appearance_deduction || 0;
            const positionRequiresUniform = positionMap.get(employee.position) ?? true;
            const uniformAmount = positionRequiresUniform ? (employee.uniform_deduction ?? 10000) : 0;

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
                processed_at: payroll.processed_at,
                approval_status: payroll.approval_status || 'pending',
                absent_days: absentDays,
                late_days: lateDays,
                absent_deduction: absentDeduction,
                late_deduction: lateDeduction,
                lecture_deduction: lectureDeduction,
                appearance_deduction: appearanceDeduction,
                uniform_amount: uniformAmount
              } as ExtendedPayrollRecord,
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

  // ===== GENERATE PAYSLIP HTML with detailed deductions =====
  const generatePayslipHTML = useCallback((payslip: PayslipData, customTemplate?: PayslipTemplate) => {
    const employee = payslip.employee;
    const p = payslip.payroll as ExtendedPayrollRecord;
    const n = p.net_pay;
    const t = customTemplate || template;
    
    // Calculate deduction breakdowns. uniform_amount was already gated by the
    // employee's position eligibility in fetchPayslipData -- ?? 0, not ||,
    // so a legitimate MK 0 (position doesn't require a uniform) isn't
    // overwritten by a fabricated fallback.
    const uniformAmount = p.uniform_amount ?? 0;
    const absentDeduction = p.absent_deduction || 0;
    const lateDeduction = p.late_deduction || 0;
    const lectureDeduction = p.lecture_deduction || 0;
    const appearanceDeduction = p.appearance_deduction || 0;
    const absentDays = p.absent_days || 0;
    const lateDays = p.late_days || 0;
    const totalUniformAtt = p.uniform_deduction || 0;
    const payePct = Math.round(payrollRates.payeRate * 100);
    const pensionPct = Math.round(payrollRates.pensionEmployeeRate * 100);

    return `<!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Payslip - ${employee.fullName}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; color: #1a1a2e; }
          .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid ${t.primaryColor}; padding-bottom: 20px; margin-bottom: 20px; }
          .company-name { font-size: 24px; font-weight: bold; color: ${t.primaryColor}; }
          .company-sub { font-size: 12px; color: #666; }
          .payslip-title { font-size: 20px; font-weight: bold; color: ${t.primaryColor}; text-align: right; }
          .employee-info { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; padding: 15px 0; border-bottom: 1px solid #ddd; margin-bottom: 20px; font-size: 13px; }
          .employee-info .label { color: #666; font-size: 11px; }
          .employee-info .value { font-weight: 600; color: #1a1a2e; }
          .earnings-deductions { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-bottom: 20px; }
          .section-title { font-size: 13px; font-weight: bold; color: ${t.primaryColor}; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #ddd; padding-bottom: 8px; margin-bottom: 12px; }
          .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5; }
          .row .label { color: #555; }
          .row .amount { font-weight: 500; font-family: monospace; }
          .total-row { display: flex; justify-content: space-between; padding: 10px 0; font-size: 15px; font-weight: bold; border-top: 2px solid #ddd; margin-top: 8px; }
          .total-row .amount { color: ${t.primaryColor}; }
          .net-pay-section { background: linear-gradient(135deg, ${t.primaryColor} 0%, ${t.primaryColor}cc 100%); color: white; padding: 20px 25px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; margin-top: 20px; }
          .net-pay-section .label { font-size: 12px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px; }
          .net-pay-section .amount { font-size: 28px; font-weight: bold; color: ${t.secondaryColor}; }
          .footer { text-align: center; font-size: 11px; color: #999; margin-top: 20px; padding-top: 15px; border-top: 1px solid #eee; }
          .deduction-item .amount { color: #dc2626; }
          .deduction-breakdown { font-size: 11px; color: #dc2626; padding-left: 20px; }
          .company-logo { font-size: 28px; font-weight: bold; color: ${t.primaryColor}; }
          @media print { body { padding: 20px; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="company-name">${t.companyName}</div>
            <div class="company-sub">${t.companyAddress}</div>
            <div class="company-sub">Tel: ${t.companyPhone}</div>
            <div class="company-sub">Email: ${t.companyEmail}</div>
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
          ${t.showPayPoint ? `<div><div class="label">Pay Point</div><div class="value">${employee.payPoint || 'N/A'}</div></div>` : ''}
          ${t.showContractType ? `<div><div class="label">Contract</div><div class="value">${employee.contractType || 'Permanent'}</div></div>` : ''}
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
            <div class="row deduction-item"><span class="label">PAYE Tax (${payePct}%)</span><span class="amount">-${formatKwacha(p.paye)}</span></div>
            <div class="row deduction-item"><span class="label">Pension (${pensionPct}%)</span><span class="amount">-${formatKwacha(p.pension)}</span></div>
            <div class="row deduction-item" style="border-bottom: none;"><span class="label">Uniform & Attendance</span><span class="amount">-${formatKwacha(totalUniformAtt)}</span></div>
            <div class="deduction-breakdown">
              ${uniformAmount > 0 ? `<div>Uniform Deduction: -${formatKwacha(uniformAmount)}</div>` : ''}
              ${absentDays > 0 ? `<div>Absent (${absentDays} × MK4,200): -${formatKwacha(absentDeduction)}</div>` : ''}
              ${lateDays > 0 ? `<div>Late (${lateDays} × MK4,200): -${formatKwacha(lateDeduction)}</div>` : ''}
              ${lectureDeduction > 0 ? `<div>Lecture Deduction: -${formatKwacha(lectureDeduction)}</div>` : ''}
              ${appearanceDeduction > 0 ? `<div>Appearance Deduction: -${formatKwacha(appearanceDeduction)}</div>` : ''}
            </div>
            <div class="total-row" style="border-top-color: #dc2626; margin-top: 4px;"><span>Total Deductions</span><span class="amount" style="color: #dc2626;">-${formatKwacha(p.paye + p.pension + totalUniformAtt)}</span></div>
          </div>
        </div>
        <div class="net-pay-section">
          <div>
            <div class="label">Total Net Pay</div>
            <div class="amount">${formatKwacha(n)}</div>
          </div>
          ${t.showAuthorizedBy ? `<div style="text-align: right; font-size: 12px;">
            <div style="opacity: 0.8;">Authorized: ${t.authorizedName}</div>
            <div style="opacity: 0.8;">${t.authorizedTitle}</div>
          </div>` : ''}
        </div>
        <div class="footer">${t.footerText}</div>
      </body>
      </html>`;
  }, [selectedMonth, selectedYear, template, payrollRates]);

  // ===== GENERATE PDF (Lazy Loaded) =====
  const generatePDF = useCallback(async (payslip: PayslipData): Promise<Blob | null> => {
    try {
      const { html2canvas, jsPDF } = await loadPDFLibraries();
      
      const employee = payslip.employee;
      const p = payslip.payroll as ExtendedPayrollRecord;
      const n = p.net_pay;
      const t = template;

      // Calculate deduction breakdowns. uniform_amount was already gated by
      // the employee's position eligibility in fetchPayslipData -- ?? 0, not
      // ||, so a legitimate MK 0 isn't overwritten by a fabricated fallback.
      const uniformAmount = p.uniform_amount ?? 0;
      const absentDeduction = p.absent_deduction || 0;
      const lateDeduction = p.late_deduction || 0;
      const lectureDeduction = p.lecture_deduction || 0;
      const appearanceDeduction = p.appearance_deduction || 0;
      const absentDays = p.absent_days || 0;
      const lateDays = p.late_days || 0;
      const totalUniformAtt = p.uniform_deduction || 0;
      const payePct = Math.round(payrollRates.payeRate * 100);
      const pensionPct = Math.round(payrollRates.pensionEmployeeRate * 100);

      const container = document.createElement('div');
      container.style.position = 'absolute';
      container.style.left = '-9999px';
      container.style.top = '-9999px';
      container.style.width = '800px';
      container.style.padding = '40px';
      container.style.backgroundColor = '#ffffff';
      container.style.fontFamily = 'Arial, sans-serif';
      container.style.color = '#1a1a2e';
      
      container.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid ${t.primaryColor}; padding-bottom: 20px; margin-bottom: 20px;">
          <div>
            <div style="font-size: 24px; font-weight: bold; color: ${t.primaryColor};">${t.companyName}</div>
            <div style="font-size: 12px; color: #666;">${t.companyAddress}</div>
            <div style="font-size: 12px; color: #666;">Tel: ${t.companyPhone}</div>
            <div style="font-size: 12px; color: #666;">Email: ${t.companyEmail}</div>
          </div>
          <div>
            <div style="font-size: 20px; font-weight: bold; color: ${t.primaryColor}; text-align: right;">PAYSLIP</div>
            <div style="text-align: right; font-size: 12px; color: #666;">${selectedMonth} ${selectedYear}</div>
          </div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; padding: 15px 0; border-bottom: 1px solid #ddd; margin-bottom: 20px; font-size: 13px;">
          <div><div style="color: #666; font-size: 11px;">Employee</div><div style="font-weight: 600;">${employee.fullName}</div></div>
          <div><div style="color: #666; font-size: 11px;">Employee No.</div><div style="font-weight: 600;">${employee.employeeNumber}</div></div>
          <div><div style="color: #666; font-size: 11px;">Position</div><div style="font-weight: 600;">${employee.position}</div></div>
          <div><div style="color: #666; font-size: 11px;">Department</div><div style="font-weight: 600;">${employee.department}</div></div>
          <div><div style="color: #666; font-size: 11px;">Pay Period</div><div style="font-weight: 600;">${selectedMonth} 01 - ${selectedMonth} 30, ${selectedYear}</div></div>
          ${t.showPayPoint ? `<div><div style="color: #666; font-size: 11px;">Pay Point</div><div style="font-weight: 600;">${employee.payPoint || 'N/A'}</div></div>` : ''}
          ${t.showContractType ? `<div><div style="color: #666; font-size: 11px;">Contract</div><div style="font-weight: 600;">${employee.contractType || 'Permanent'}</div></div>` : ''}
          <div><div style="color: #666; font-size: 11px;">Date Paid</div><div style="font-weight: 600;">${selectedMonth} 30, ${selectedYear}</div></div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-bottom: 20px;">
          <div>
            <div style="font-size: 13px; font-weight: bold; color: ${t.primaryColor}; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #ddd; padding-bottom: 8px; margin-bottom: 12px;">Earnings</div>
            <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5;"><span style="color: #555;">Basic Salary</span><span style="font-weight: 500; font-family: monospace;">${formatKwacha(p.basic_salary)}</span></div>
            <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5;"><span style="color: #555;">Allowances</span><span style="font-weight: 500; font-family: monospace;">${formatKwacha(p.allowances)}</span></div>
            <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5;"><span style="color: #555;">Overtime</span><span style="font-weight: 500; font-family: monospace;">${formatKwacha(p.overtime)}</span></div>
            <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5;"><span style="color: #555;">Bonus</span><span style="font-weight: 500; font-family: monospace;">${formatKwacha(p.bonus)}</span></div>
            <div style="display: flex; justify-content: space-between; padding: 10px 0; font-size: 15px; font-weight: bold; border-top: 2px solid #ddd; margin-top: 8px;"><span>Gross Pay</span><span style="color: ${t.primaryColor};">${formatKwacha(p.gross_pay)}</span></div>
          </div>
          <div>
            <div style="font-size: 13px; font-weight: bold; color: ${t.primaryColor}; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #ddd; padding-bottom: 8px; margin-bottom: 12px;">Deductions</div>
            <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5;"><span style="color: #555;">PAYE Tax (${payePct}%)</span><span style="font-weight: 500; font-family: monospace; color: #dc2626;">-${formatKwacha(p.paye)}</span></div>
            <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5;"><span style="color: #555;">Pension (${pensionPct}%)</span><span style="font-weight: 500; font-family: monospace; color: #dc2626;">-${formatKwacha(p.pension)}</span></div>
            <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5; border-bottom: none;"><span style="color: #555;">Uniform & Attendance</span><span style="font-weight: 500; font-family: monospace; color: #dc2626;">-${formatKwacha(totalUniformAtt)}</span></div>
            <div style="font-size: 11px; color: #dc2626; padding-left: 20px; padding-bottom: 6px;">
              ${uniformAmount > 0 ? `<div>Uniform Deduction: -${formatKwacha(uniformAmount)}</div>` : ''}
              ${absentDays > 0 ? `<div>Absent (${absentDays} × MK4,200): -${formatKwacha(absentDeduction)}</div>` : ''}
              ${lateDays > 0 ? `<div>Late (${lateDays} × MK4,200): -${formatKwacha(lateDeduction)}</div>` : ''}
              ${lectureDeduction > 0 ? `<div>Lecture Deduction: -${formatKwacha(lectureDeduction)}</div>` : ''}
              ${appearanceDeduction > 0 ? `<div>Appearance Deduction: -${formatKwacha(appearanceDeduction)}</div>` : ''}
            </div>
            <div style="display: flex; justify-content: space-between; padding: 10px 0; font-size: 15px; font-weight: bold; border-top: 2px solid #ddd; margin-top: 4px; border-top-color: #dc2626;"><span>Total Deductions</span><span style="color: #dc2626;">-${formatKwacha(p.paye + p.pension + totalUniformAtt)}</span></div>
          </div>
        </div>
        <div style="background: linear-gradient(135deg, ${t.primaryColor} 0%, ${t.primaryColor}cc 100%); color: white; padding: 20px 25px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; margin-top: 20px;">
          <div>
            <div style="font-size: 12px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px;">Total Net Pay</div>
            <div style="font-size: 28px; font-weight: bold; color: ${t.secondaryColor};">${formatKwacha(n)}</div>
          </div>
          ${t.showAuthorizedBy ? `<div style="text-align: right; font-size: 12px;">
            <div style="opacity: 0.8;">Authorized: ${t.authorizedName}</div>
            <div style="opacity: 0.8;">${t.authorizedTitle}</div>
          </div>` : ''}
        </div>
        <div style="text-align: center; font-size: 11px; color: #999; margin-top: 20px; padding-top: 15px; border-top: 1px solid #eee;">${t.footerText}</div>
      `;

      document.body.appendChild(container);

      const canvas = await html2canvas(container, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false,
      });

      document.body.removeChild(container);

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      
      return pdf.output('blob');
    } catch (error: any) {
      console.error('PDF Generation Error:', error);
      showNotification('Failed to generate PDF: ' + error.message, 'error');
      return null;
    }
  }, [selectedMonth, selectedYear, template, payrollRates]);

  // ===== DOWNLOAD SINGLE PAYSLIP =====
  const handlePDFDownload = useCallback(async (payslip: PayslipData) => {
    try {
      const employee = payslip.employee;
      const pdfBlob = await generatePDF(payslip);
      
      if (pdfBlob) {
        const url = URL.createObjectURL(pdfBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `Payslip_${employee.fullName.replace(/\s/g, '_')}_${selectedMonth}_${selectedYear}.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 100);

        await logAudit({
          action: 'EXPORT',
          entity_type: 'payslip',
          new_data: { 
            employee_name: employee.fullName, 
            employee_number: employee.employeeNumber, 
            month: selectedMonth, 
            year: selectedYear, 
            net_pay: payslip.payroll.net_pay,
            format: 'PDF'
          },
          region_id: userProfile?.region_id
        });

        showNotification(`Payslip for ${employee.fullName} downloaded successfully`, 'success');
      }
    } catch (error: any) {
      console.error('PDF Download Error:', error);
      showNotification(`Failed to generate payslip: ${error.message || 'Unknown error'}`, 'error');
    }
  }, [selectedMonth, selectedYear, userProfile, generatePDF]);

  // ===== BULK DOWNLOAD ALL PAYSLIPS AS ZIP =====
  const handleBulkDownload = useCallback(async () => {
    if (payslips.length === 0) {
      showNotification('No payslips to download.', 'error');
      return;
    }

    setDownloading(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder(`Payslips_${selectedMonth}_${selectedYear}`);
      
      let successCount = 0;
      
      for (const payslip of payslips) {
        const pdfBlob = await generatePDF(payslip);
        if (pdfBlob) {
          const fileName = `Payslip_${payslip.employee.fullName.replace(/\s/g, '_')}_${selectedMonth}_${selectedYear}.pdf`;
          folder?.file(fileName, pdfBlob);
          successCount++;
        }
      }

      if (successCount === 0) {
        showNotification('Failed to generate any payslips.', 'error');
        setDownloading(false);
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Payslips_${selectedMonth}_${selectedYear}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 100);

      await logAudit({
        action: 'EXPORT',
        entity_type: 'payslip',
        new_data: { 
          month: selectedMonth, 
          year: selectedYear,
          count: successCount,
          format: 'ZIP'
        },
        region_id: userProfile?.region_id
      });

      showNotification(`Downloaded ${successCount} payslips as ZIP`, 'success');
    } catch (error: any) {
      console.error('Bulk Download Error:', error);
      showNotification('Failed to download payslips: ' + error.message, 'error');
    } finally {
      setDownloading(false);
    }
  }, [payslips, selectedMonth, selectedYear, userProfile, generatePDF]);

  // ===== SAVE TEMPLATE =====
  const saveTemplate = useCallback(() => {
    localStorage.setItem('payslipTemplate', JSON.stringify(template));
    showNotification('Payslip template saved successfully!', 'success');
    setShowTemplateModal(false);
  }, [template]);

  // ===== PRINT FUNCTION =====
  const handlePrint = useCallback((payslip: PayslipData) => {
    try {
      const employee = payslip.employee;
      
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

      const payslipHTML = generatePayslipHTML(payslip);
      printWindow.document.write(payslipHTML);
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => printWindow.print(), 500);
    } catch (error: any) {
      console.error('Print error:', error);
      showNotification('Failed to print payslip', 'error');
    }
  }, [selectedMonth, selectedYear, userProfile, generatePayslipHTML]);

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
                  id="monthSelect"
                  name="monthSelect"
                  value={selectedMonth} 
                  onChange={(e) => handleMonthSelect(e.target.value)}
                  className="bg-transparent border-none text-sm font-medium text-slate-700 focus:ring-0 py-1 min-w-[100px] text-center cursor-pointer"
                >
                  {months.map((month, index) => (
                    <option key={`month-${month}-${index}`} value={month}>{month}</option>
                  ))}
                </select>
                <select 
                  id="yearSelect"
                  name="yearSelect"
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

            {payslips.length > 0 && (
              <>
                <Button variant="outline" onClick={() => setShowTemplateModal(true)}>
                  <Settings size={16} className="mr-1" /> Template
                </Button>
                <Button variant="secondary" onClick={handleBulkDownload} disabled={downloading}>
                  {downloading ? (
                    <span className="flex items-center gap-2">
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Downloading...
                    </span>
                  ) : (
                    <>
                      <FileArchiveIcon size={16} className="mr-1" /> Bulk Download
                    </>
                  )}
                </Button>
              </>
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
                id="searchPayslips"
                name="searchPayslips"
                type="text"
                value={search} 
                onChange={e => setSearch(e.target.value)} 
                placeholder="Search employees..." 
                className="w-full pl-10 pr-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
              />
            </div>
            <div className="text-sm text-slate-500">{filtered.length} payslips found</div>
            <Button variant="outline" onClick={handleBulkDownload} disabled={downloading || payslips.length === 0} className="text-xs">
              {downloading ? (
                <span className="flex items-center gap-2">
                  <div className="w-3 h-3 border-2 border-[#081C3A] border-t-transparent rounded-full animate-spin" />
                  Downloading...
                </span>
              ) : (
                <><ArchiveIcon size={14} className="mr-1" /> Download All ({payslips.length})</>
              )}
            </Button>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {paginatedPayslips.map((payslip) => {
              const emp = payslip.employee;
              const p = payslip.payroll as ExtendedPayrollRecord;
              const n = p.net_pay;
              const totalDeductions = p.paye + p.pension + (p.uniform_deduction || 0);
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
                    <Badge color={p.approval_status === 'approved' ? 'green' : 'yellow'}>
                      {p.approval_status === 'approved' ? 'Processed' : 'Pending'}
                    </Badge>
                  </div>
                  <div className="border-t border-slate-100 pt-4">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>{selectedMonth} {selectedYear}</span>
                      <span>Gross: {formatKwacha(p.gross_pay)}</span>
                    </div>
                    <p className="text-2xl font-bold text-[#081C3A]">{formatKwacha(n)}</p>
                    <div className="flex justify-between text-xs text-slate-500 mt-1">
                      <span>Deductions: {formatKwacha(totalDeductions)}</span>
                      <span className="text-red-500">Uniform/Att: {formatKwacha(p.uniform_deduction || 0)}</span>
                    </div>
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
        {view && <PayslipPDF payslip={view} month={selectedMonth} year={selectedYear} template={template} payrollRates={payrollRates} onPrint={handlePrint} onDownload={handlePDFDownload} />}
      </Modal>

      {/* Template Customization Modal */}
      <Modal open={showTemplateModal} onClose={() => setShowTemplateModal(false)} title="Payslip Template Customization" size="lg">
        <div className="space-y-4">
          <div className="p-3 bg-[#E8EDF5] rounded-lg text-sm">
            <p className="text-slate-700">Customize the payslip layout and appearance. Changes will be saved locally.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="companyName" className="block text-sm font-medium text-slate-700 mb-1">Company Name</label>
              <input
                id="companyName"
                name="companyName"
                type="text"
                value={template.companyName}
                onChange={(e) => setTemplate({...template, companyName: e.target.value})}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label htmlFor="companyAddress" className="block text-sm font-medium text-slate-700 mb-1">Company Address</label>
              <input
                id="companyAddress"
                name="companyAddress"
                type="text"
                value={template.companyAddress}
                onChange={(e) => setTemplate({...template, companyAddress: e.target.value})}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="companyPhone" className="block text-sm font-medium text-slate-700 mb-1">Company Phone</label>
              <input
                id="companyPhone"
                name="companyPhone"
                type="text"
                value={template.companyPhone}
                onChange={(e) => setTemplate({...template, companyPhone: e.target.value})}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label htmlFor="companyEmail" className="block text-sm font-medium text-slate-700 mb-1">Company Email</label>
              <input
                id="companyEmail"
                name="companyEmail"
                type="text"
                value={template.companyEmail}
                onChange={(e) => setTemplate({...template, companyEmail: e.target.value})}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="primaryColor" className="block text-sm font-medium text-slate-700 mb-1">Primary Color</label>
              <input
                id="primaryColor"
                name="primaryColor"
                type="color"
                value={template.primaryColor}
                onChange={(e) => setTemplate({...template, primaryColor: e.target.value})}
                className="w-full h-10 px-2 py-1 border border-slate-200 rounded-lg cursor-pointer"
              />
            </div>
            <div>
              <label htmlFor="secondaryColor" className="block text-sm font-medium text-slate-700 mb-1">Secondary Color</label>
              <input
                id="secondaryColor"
                name="secondaryColor"
                type="color"
                value={template.secondaryColor}
                onChange={(e) => setTemplate({...template, secondaryColor: e.target.value})}
                className="w-full h-10 px-2 py-1 border border-slate-200 rounded-lg cursor-pointer"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="authorizedName" className="block text-sm font-medium text-slate-700 mb-1">Authorized Name</label>
              <input
                id="authorizedName"
                name="authorizedName"
                type="text"
                value={template.authorizedName}
                onChange={(e) => setTemplate({...template, authorizedName: e.target.value})}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label htmlFor="authorizedTitle" className="block text-sm font-medium text-slate-700 mb-1">Authorized Title</label>
              <input
                id="authorizedTitle"
                name="authorizedTitle"
                type="text"
                value={template.authorizedTitle}
                onChange={(e) => setTemplate({...template, authorizedTitle: e.target.value})}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          <div>
            <label htmlFor="footerText" className="block text-sm font-medium text-slate-700 mb-1">Footer Text</label>
            <input
              id="footerText"
              name="footerText"
              type="text"
              value={template.footerText}
              onChange={(e) => setTemplate({...template, footerText: e.target.value})}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={template.showLogo}
                onChange={(e) => setTemplate({...template, showLogo: e.target.checked})}
                className="w-4 h-4 rounded border-slate-300"
              />
              Show Logo
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={template.showPayPoint}
                onChange={(e) => setTemplate({...template, showPayPoint: e.target.checked})}
                className="w-4 h-4 rounded border-slate-300"
              />
              Show Pay Point
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={template.showContractType}
                onChange={(e) => setTemplate({...template, showContractType: e.target.checked})}
                className="w-4 h-4 rounded border-slate-300"
              />
              Show Contract Type
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={template.showAuthorizedBy}
                onChange={(e) => setTemplate({...template, showAuthorizedBy: e.target.checked})}
                className="w-4 h-4 rounded border-slate-300"
              />
              Show Authorized By
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
            <Button variant="outline" onClick={() => setShowTemplateModal(false)}>Cancel</Button>
            <Button variant="secondary" onClick={saveTemplate}>
              <Save size={14} className="mr-1" /> Save Template
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

interface PayslipPDFProps {
  payslip: PayslipData;
  month: string;
  year: string;
  template: PayslipTemplate;
  payrollRates: PayrollRates;
  onPrint: (payslip: PayslipData) => void;
  onDownload: (payslip: PayslipData) => void;
}

function PayslipPDF({ payslip, month, year, template, payrollRates, onPrint, onDownload }: PayslipPDFProps) {
  const employee = payslip.employee;
  const p = payslip.payroll as ExtendedPayrollRecord;
  const n = p.net_pay;
  const payePct = Math.round(payrollRates.payeRate * 100);
  const pensionPct = Math.round(payrollRates.pensionEmployeeRate * 100);

  return (
    <div className="space-y-5">
      <div className="p-6 rounded-lg border-2 border-slate-200 bg-white" id="payslip-content">
        <div className="flex items-start justify-between pb-4 border-b-2 border-[#081C3A]">
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-xl bg-[#081C3A] flex items-center justify-center">
              <Shield size={24} className="text-[#D4A017]" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-[#081C3A]">{template.companyName}</h1>
              <p className="text-xs text-slate-500">{template.companyAddress}</p>
              <p className="text-xs text-slate-500">Tel: {template.companyPhone} · Email: {template.companyEmail}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold text-[#081C3A]">PAYSLIP</p>
            <p className="text-xs text-slate-500">{month} {year}</p>
            <Badge color={p.approval_status === 'approved' ? 'green' : 'yellow'}>
              {p.approval_status === 'approved' ? 'Processed' : 'Pending'}
            </Badge>
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
                [`PAYE Tax (${payePct}%)`, p.paye],
                [`Pension (${pensionPct}%)`, p.pension],
                ['Uniform & Attendance', p.uniform_deduction]
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
          {template.showAuthorizedBy && (
            <div className="text-right text-xs">
              <p className="opacity-80">Payment Method: Bank Transfer</p>
              <p className="opacity-80">Authorized: {template.authorizedName} ({template.authorizedTitle})</p>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-slate-400 mt-4">{template.footerText}</p>
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