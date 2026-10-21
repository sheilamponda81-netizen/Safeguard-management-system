import { formatKwacha } from '../data';
import { toCsvRow } from './csvExport';
import { getMonthLabel } from './currentMonth';

// Terminal Dues Phase 3A -- Accounts export. Mirrors payrollExport.ts's
// shape deliberately: this codebase has no true multi-sheet .xlsx
// generation anywhere (no exceljs/xlsx-write dependency; the existing
// "Accounts Excel export" -- Payroll.tsx's exportPayrollReport() -- is
// itself a CSV download via toCsvRow, not a real workbook). Building
// genuine multi-worksheet .xlsx output would mean adding a new binary-
// generation dependency, a larger, separately-reviewable change this
// phase does not take on unasked. Terminal Dues payments are exported as
// their OWN separate CSV download instead -- the existing payroll CSV's
// own layout is completely untouched (not even an added column), and a
// combined-totals summary is shown on screen (see
// terminalDuesPayrollIntegration.ts) rather than spliced into either
// file.
//
// Only 'processed' allocations are ever exported here -- never submitted/
// approved/held/rejected/excluded -- so this can never report an
// unprocessed or excluded amount as payable (re-downloading the export
// is always safe: it only ever reads already-committed `processed` rows,
// never calls the processing RPC).

export interface TerminalDueExportRecord {
  employee_name: string;
  employee_number: string | null;
  pay_point: string | null;
  account_number: string | null;
  proposed_amount: number;
  processed_at: string;
  processing_reference: string | null;
  is_historical: boolean;
}

export const TERMINAL_DUES_EXPORT_HEADER_ROW = [
  'Employee Name', 'Employee Number', 'Employee Type', 'Pay Point', 'Account Number',
  'Amount', 'Processed Date', 'Processing Reference',
];

export function buildTerminalDueExportRow(record: TerminalDueExportRecord): (string | number)[] {
  return [
    record.employee_name,
    record.employee_number || '',
    record.is_historical ? 'Historical' : 'Current Employee',
    record.pay_point || '',
    record.account_number || '',
    formatKwacha(record.proposed_amount),
    new Date(record.processed_at).toLocaleDateString(),
    record.processing_reference || '',
  ];
}

export function computeTerminalDueExportTotal(records: TerminalDueExportRecord[]): number {
  return records.reduce((sum, r) => sum + r.proposed_amount, 0);
}

/**
 * The complete CSV content for a Terminal Dues payment export -- a
 * dedicated, separate download from the ordinary payroll report, never
 * spliced into it. Only ever built from `processed` allocations the
 * caller already fetched (never widens scope or re-fetches), so it can
 * never export an unprocessed or excluded amount as payable.
 */
export function buildTerminalDuePaymentsCsv(month: string, records: TerminalDueExportRecord[]): string {
  let csv = `Terminal Dues Payments - ${getMonthLabel(month)}\nGenerated: ${new Date().toLocaleString()}\n\n`;
  csv += toCsvRow(TERMINAL_DUES_EXPORT_HEADER_ROW) + '\n';

  records.forEach(record => {
    csv += toCsvRow(buildTerminalDueExportRow(record)) + '\n';
  });

  const total = computeTerminalDueExportTotal(records);
  csv += `\n\nSUMMARY\nPayment Count,${records.length}\nTotal Terminal Dues Amount,${formatKwacha(total)}\n`;

  return csv;
}

export interface CombinedAccountsSummary {
  ordinaryPayrollSubtotal: number;
  terminalDuesSubtotal: number;
  combinedTotal: number;
}

/**
 * The reconciled combined-summary block Section 5 asks for -- ordinary
 * salaries/deductions, Terminal Dues payments, each subtotal, and the
 * combined amount payable, kept as a clearly separate section so neither
 * figure is ever double-counted into the other's own total.
 */
export function buildCombinedAccountsSummaryCsv(month: string, ordinaryPayrollNetTotal: number, terminalDuesTotal: number): string {
  const combined: CombinedAccountsSummary = {
    ordinaryPayrollSubtotal: ordinaryPayrollNetTotal,
    terminalDuesSubtotal: terminalDuesTotal,
    combinedTotal: ordinaryPayrollNetTotal + terminalDuesTotal,
  };

  let csv = `Combined Accounts Summary - ${getMonthLabel(month)}\nGenerated: ${new Date().toLocaleString()}\n\n`;
  csv += toCsvRow(['Category', 'Amount']) + '\n';
  csv += toCsvRow(['Ordinary Payroll (Net Pay)', formatKwacha(combined.ordinaryPayrollSubtotal)]) + '\n';
  csv += toCsvRow(['Terminal Dues Payments', formatKwacha(combined.terminalDuesSubtotal)]) + '\n';
  csv += toCsvRow(['Combined Total Payable', formatKwacha(combined.combinedTotal)]) + '\n';

  return csv;
}
