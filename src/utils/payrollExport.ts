import { formatKwacha } from '../data';
import { toCsvRow } from './csvExport';
import { getMonthLabel } from './currentMonth';

// Extracted from Payroll.tsx's exportPayrollReport() so the row-shaping
// and monetary-totals math is independently unit-testable without
// rendering the page (this repo has no component-test infrastructure --
// no @testing-library, no .test.tsx files anywhere -- so a page-level
// render test would be a large new dependency for a narrow feature).
// Payroll.tsx supplies the already-fetched, already-authorized
// records/employees/regions/deductions; this module only shapes them
// into CSV rows and totals -- it never fetches anything itself, so it
// cannot leak data beyond whatever the caller already loaded.

export interface PayrollExportRecord {
  employee_id: string;
  gross_pay: number;
  paye: number;
  pension: number;
  uniform_deduction: number;
  salary_advance_deduction: number;
  net_pay: number;
  approval_status?: string | null;
}

export interface PayrollExportEmployee {
  full_name: string;
  employee_number: string;
  region_id?: string | null;
  company?: string | null;
  workstation?: string | null;
}

export interface PayrollExportRegion {
  id: string;
  name: string;
}

export interface PayrollExportDeduction {
  absent_deduction?: number;
  late_deduction?: number;
  lecture_deduction?: number;
  appearance_deduction?: number;
}

export interface PayrollExportTotals {
  gross: number;
  paye: number;
  pension: number;
  deductions: number;
  net: number;
}

export const PAYROLL_EXPORT_HEADER_ROW = [
  'Employee Name', 'Employee Number', 'Region', 'Company', 'Site/Workstation',
  'Gross Pay', 'PAYE', 'Pension', 'Uniform Deductions', 'Attendance Deductions',
  'Other Deductions', 'Total Deductions', 'Net Pay', 'Approval Status',
];

// Absent/late attendance-driven deductions, kept as their own report
// column separate from lecture/appearance/salary-advance ("Other") and
// from uniform (its own column) and from PAYE/Pension (statutory
// withholdings, not deductions in the colloquial sense this report uses).
export function computeAttendanceDeduction(deduction?: PayrollExportDeduction | null): number {
  return (deduction?.absent_deduction || 0) + (deduction?.late_deduction || 0);
}

export function computeOtherDeduction(record: PayrollExportRecord, deduction?: PayrollExportDeduction | null): number {
  return (deduction?.lecture_deduction || 0) + (deduction?.appearance_deduction || 0) + (record.salary_advance_deduction || 0);
}

export function computeTotalDeduction(record: PayrollExportRecord, deduction?: PayrollExportDeduction | null): number {
  return record.uniform_deduction + computeAttendanceDeduction(deduction) + computeOtherDeduction(record, deduction);
}

export function buildPayrollExportRow(
  record: PayrollExportRecord,
  employee: PayrollExportEmployee | undefined,
  region: PayrollExportRegion | undefined,
  deduction: PayrollExportDeduction | null | undefined
): (string | number)[] {
  return [
    employee?.full_name || '(employee not found)',
    employee?.employee_number || '',
    region?.name || '',
    employee?.company || '',
    employee?.workstation || '',
    formatKwacha(record.gross_pay),
    formatKwacha(record.paye),
    formatKwacha(record.pension),
    formatKwacha(record.uniform_deduction),
    formatKwacha(computeAttendanceDeduction(deduction)),
    formatKwacha(computeOtherDeduction(record, deduction)),
    formatKwacha(computeTotalDeduction(record, deduction)),
    formatKwacha(record.net_pay),
    record.approval_status || 'pending',
  ];
}

export function computePayrollExportTotals(
  records: PayrollExportRecord[],
  deductionsByEmployee: Map<string, PayrollExportDeduction>
): PayrollExportTotals {
  return records.reduce((acc, record) => {
    const deduction = deductionsByEmployee.get(record.employee_id);
    acc.gross += record.gross_pay;
    acc.paye += record.paye;
    acc.pension += record.pension;
    acc.deductions += computeTotalDeduction(record, deduction);
    acc.net += record.net_pay;
    return acc;
  }, { gross: 0, paye: 0, pension: 0, deductions: 0, net: 0 });
}

// The complete CSV content (title/generated-date preamble, header row,
// one row per record, trailing SUMMARY block) -- everything
// Payroll.tsx's exportPayrollReport() needs to hand straight to a Blob.
// Deliberately takes only the data already loaded for `selectedMonth` by
// fetchData() (the caller's own tenant/region-authorized payrollRecords)
// -- never re-fetches or widens scope on its own, so this can never
// export more than what the viewer was already shown on screen.
export function buildPayrollReportCsv(
  selectedMonth: string,
  records: PayrollExportRecord[],
  employeesById: Map<string, PayrollExportEmployee>,
  regionsById: Map<string, PayrollExportRegion>,
  deductionsByEmployee: Map<string, PayrollExportDeduction>
): string {
  let csv = `Payroll Report - ${getMonthLabel(selectedMonth)}\nGenerated: ${new Date().toLocaleString()}\n\n`;
  csv += toCsvRow(PAYROLL_EXPORT_HEADER_ROW) + '\n';

  records.forEach(record => {
    const employee = employeesById.get(record.employee_id);
    const region = employee?.region_id ? regionsById.get(employee.region_id) : undefined;
    const deduction = deductionsByEmployee.get(record.employee_id);
    csv += toCsvRow(buildPayrollExportRow(record, employee, region, deduction)) + '\n';
  });

  const totals = computePayrollExportTotals(records, deductionsByEmployee);
  csv += `\n\nSUMMARY\nEmployee Count,${records.length}\nTotal Gross Pay,${formatKwacha(totals.gross)}\nTotal PAYE,${formatKwacha(totals.paye)}\nTotal Pension,${formatKwacha(totals.pension)}\nTotal Deductions,${formatKwacha(totals.deductions)}\nTotal Net Pay,${formatKwacha(totals.net)}\n`;

  return csv;
}
