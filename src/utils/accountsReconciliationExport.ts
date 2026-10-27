// Phase 4A Part 2 -- the reconciled Accounts export package. Deliberately
// a NEW module rather than edits to payrollExport.ts/terminalDuesPayrollExport.ts:
// "preserve existing export formats wherever possible" means the existing
// exportPayrollReport()/buildPayrollReportCsv() (the ordinary payroll
// report Accounts already downloads) and buildTerminalDuePaymentsCsv()
// (the existing Terminal Dues payments CSV, reused here VERBATIM) are not
// touched at all. This module only adds the two things that were missing:
// an ordinary-payroll payments CSV carrying the SAME bank/pay-point/
// processing-reference detail the Terminal Dues export already has, and a
// genuinely reconciled combined summary (the previous
// buildCombinedAccountsSummaryCsv() showed only a bare ordinary-net figure
// -- no gross/deductions breakdown, no processing references, no
// historical-employee count).
//
// "Use only committed financial data, never pending or merely approved
// allocations" -- every input here must come from rows that actually exist
// in `payroll`/`terminal_due_allocations` (i.e. a processing RPC already
// ran and wrote them), never from a live/preview calculation. This module
// itself takes no fetch dependency and enforces nothing by itself; the
// caller (Payroll.tsx) is responsible for only ever passing it rows it
// fetched from those two tables for months it has confirmed are processed
// -- see that file's own guard before calling this.
import { formatKwacha } from '../data';
import { toCsvRow } from './csvExport';
import { getMonthLabel } from './currentMonth';

export interface OrdinaryPayrollPaymentRecord {
  employee_id: string;
  full_name: string;
  employee_number: string | null;
  pay_point: string | null;
  account_number: string | null;
  gross_pay: number;
  paye: number;
  pension: number;
  uniform_deduction: number;
  salary_advance_deduction: number;
  net_pay: number;
  processing_reference: string | null;
}

export const ORDINARY_PAYROLL_PAYMENTS_HEADER_ROW = [
  'Employee Name', 'Employee Number', 'Pay Point', 'Account Number',
  'Gross Pay', 'PAYE', 'Pension', 'Uniform Deduction', 'Salary Advance Deduction',
  'Net Pay', 'Processing Reference',
];

export function buildOrdinaryPayrollPaymentRow(record: OrdinaryPayrollPaymentRecord): (string | number)[] {
  return [
    record.full_name,
    record.employee_number || '',
    record.pay_point || '',
    record.account_number || '',
    formatKwacha(record.gross_pay),
    formatKwacha(record.paye),
    formatKwacha(record.pension),
    formatKwacha(record.uniform_deduction),
    formatKwacha(record.salary_advance_deduction),
    formatKwacha(record.net_pay),
    record.processing_reference || '(predates processing-reference tracking)',
  ];
}

export interface OrdinaryPayrollPaymentTotals {
  gross: number;
  paye: number;
  pension: number;
  uniformDeduction: number;
  salaryAdvanceDeduction: number;
  net: number;
}

export function computeOrdinaryPayrollPaymentTotals(records: OrdinaryPayrollPaymentRecord[]): OrdinaryPayrollPaymentTotals {
  return records.reduce((acc, r) => {
    acc.gross += r.gross_pay;
    acc.paye += r.paye;
    acc.pension += r.pension;
    acc.uniformDeduction += r.uniform_deduction;
    acc.salaryAdvanceDeduction += r.salary_advance_deduction;
    acc.net += r.net_pay;
    return acc;
  }, { gross: 0, paye: 0, pension: 0, uniformDeduction: 0, salaryAdvanceDeduction: 0, net: 0 });
}

/**
 * The ordinary-payroll leg of the Accounts export package -- only ever
 * built from rows the caller fetched from the committed `payroll` table
 * (never a live preview). Carries bank/pay-point and processing-reference
 * detail the existing exportPayrollReport() CSV does not, specifically so
 * Accounts can reconcile each payment to its source employee and run.
 */
export function buildOrdinaryPayrollPaymentsCsv(month: string, records: OrdinaryPayrollPaymentRecord[]): string {
  let csv = `Ordinary Payroll Payments - ${getMonthLabel(month)}\nGenerated: ${new Date().toLocaleString()}\n\n`;
  csv += toCsvRow(ORDINARY_PAYROLL_PAYMENTS_HEADER_ROW) + '\n';

  records.forEach(record => {
    csv += toCsvRow(buildOrdinaryPayrollPaymentRow(record)) + '\n';
  });

  const totals = computeOrdinaryPayrollPaymentTotals(records);
  csv += `\n\nSUMMARY\nEmployee Count,${records.length}\nTotal Gross Pay,${formatKwacha(totals.gross)}\nTotal PAYE,${formatKwacha(totals.paye)}\nTotal Pension,${formatKwacha(totals.pension)}\nTotal Uniform Deduction,${formatKwacha(totals.uniformDeduction)}\nTotal Salary Advance Deduction,${formatKwacha(totals.salaryAdvanceDeduction)}\nTotal Net Pay,${formatKwacha(totals.net)}\n`;

  return csv;
}

export interface AccountsReconciliationInput {
  month: string;
  ordinaryEmployeeCount: number;
  ordinaryGross: number;
  ordinaryDeductions: number;
  ordinaryNet: number;
  ordinaryProcessingReferences: string[];
  terminalDuesPaymentCount: number;
  terminalDuesCurrentEmployeeCount: number;
  terminalDuesHistoricalEmployeeCount: number;
  terminalDuesTotal: number;
  terminalDuesProcessingReferences: string[];
}

/**
 * The genuinely reconciled combined summary Phase 4A asks for -- month,
 * every distinct processing reference on each side, ordinary gross/
 * deductions/net (not just net), Terminal Dues total with its own
 * current-vs-historical-employee counts, and the final combined amount
 * payable. Ordinary and Terminal Dues figures are kept in clearly
 * separate rows/sections throughout, specifically so neither can be read
 * as double-counted into the other.
 */
export function buildAccountsReconciliationSummaryCsv(input: AccountsReconciliationInput): string {
  const combinedTotal = input.ordinaryNet + input.terminalDuesTotal;

  let csv = `Accounts Reconciliation Summary - ${getMonthLabel(input.month)}\nGenerated: ${new Date().toLocaleString()}\n\n`;

  csv += toCsvRow(['Section', 'Field', 'Value']) + '\n';
  csv += toCsvRow(['Ordinary Payroll', 'Employee Count', input.ordinaryEmployeeCount]) + '\n';
  csv += toCsvRow(['Ordinary Payroll', 'Gross Pay', formatKwacha(input.ordinaryGross)]) + '\n';
  csv += toCsvRow(['Ordinary Payroll', 'Total Deductions (PAYE + Pension + Uniform + Salary Advance)', formatKwacha(input.ordinaryDeductions)]) + '\n';
  csv += toCsvRow(['Ordinary Payroll', 'Net Pay', formatKwacha(input.ordinaryNet)]) + '\n';
  csv += toCsvRow(['Ordinary Payroll', 'Processing Reference(s)', input.ordinaryProcessingReferences.join('; ') || '(none)']) + '\n';

  csv += toCsvRow(['Terminal Dues', 'Payment Count', input.terminalDuesPaymentCount]) + '\n';
  csv += toCsvRow(['Terminal Dues', 'Current Employee Payments', input.terminalDuesCurrentEmployeeCount]) + '\n';
  csv += toCsvRow(['Terminal Dues', 'Historical Employee Payments', input.terminalDuesHistoricalEmployeeCount]) + '\n';
  csv += toCsvRow(['Terminal Dues', 'Processed Total', formatKwacha(input.terminalDuesTotal)]) + '\n';
  csv += toCsvRow(['Terminal Dues', 'Processing Reference(s)', input.terminalDuesProcessingReferences.join('; ') || '(none)']) + '\n';

  csv += toCsvRow(['Combined', 'Final Combined Amount Payable (Ordinary Net + Terminal Dues)', formatKwacha(combinedTotal)]) + '\n';

  return csv;
}
