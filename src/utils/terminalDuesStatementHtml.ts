// Phase 4B Part 3 -- HTML document builder for the Terminal Dues Payment
// Statement, consumed by TerminalDuesPaymentHistory.tsx for both print
// (a popup window + window.print(), same pattern as Payslips.tsx's
// generatePayslipHTML()) and PDF download (rendered offscreen, same
// html2canvas+jsPDF pattern as Payslips.tsx's generatePDF()). Kept
// separate from terminalDuesStatement.ts's pure summary derivation so
// that module stays DOM-free and independently testable.
import { formatKwacha } from '../data';
import { getMonthLabel } from './currentMonth';
import { TerminalDuesStatementInput, TerminalDuesStatementSummary } from './terminalDuesStatement';

export function buildTerminalDuesStatementHtml(
  input: TerminalDuesStatementInput,
  summary: TerminalDuesStatementSummary
): string {
  const { subject, entitlement } = input;
  const rows = (allocations: typeof input.processedAllocations) => allocations.map(a => `
    <tr>
      <td>${getMonthLabel(a.payrollMonth)}</td>
      <td style="text-align:right;">${formatKwacha(a.amount)}</td>
      <td>${a.processingReference || '(none)'}</td>
      <td>${a.processedAt ? new Date(a.processedAt).toLocaleDateString() : '-'}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Terminal Dues Payment Statement - ${subject.name}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; color: #1a1a2e; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #081C3A; padding-bottom: 20px; margin-bottom: 20px; }
        .title { font-size: 20px; font-weight: bold; color: #081C3A; }
        .section-title { font-size: 13px; font-weight: bold; color: #081C3A; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #ddd; padding-bottom: 8px; margin: 16px 0 10px; }
        .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5; }
        .row.deduction span.amount { color: #dc2626; }
        .total-row { display: flex; justify-content: space-between; padding: 8px 0; font-size: 14px; font-weight: bold; border-top: 2px solid #ddd; margin-top: 6px; }
        table { width: 100%; font-size: 12px; border-collapse: collapse; margin-top: 6px; }
        th { text-align: left; color: #888; font-weight: 600; padding: 4px 0; border-bottom: 1px solid #ddd; }
        td { padding: 4px 0; border-bottom: 1px solid #f5f5f5; }
        .net-pay-section { background: linear-gradient(135deg, #081C3A 0%, #081C3Acc 100%); color: white; padding: 18px 22px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; margin-top: 18px; }
        .net-pay-section .amount { font-size: 24px; font-weight: bold; color: #D4A017; }
        .footer { text-align: center; font-size: 11px; color: #999; margin-top: 20px; padding-top: 15px; border-top: 1px solid #eee; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; background: #e2e8f0; color: #334155; }
        @media print { body { padding: 20px; } }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <div class="title">TERMINAL DUES PAYMENT STATEMENT</div>
          <div style="font-size: 12px; color: #666;">Statement Date: ${new Date().toLocaleDateString()} &middot; Payroll Month: ${getMonthLabel(input.statementMonth)}</div>
        </div>
        <div class="badge">Version v${entitlement.version}</div>
      </div>

      <div class="section-title">Subject</div>
      <div class="row"><span>Name</span><span>${subject.name}${subject.isHistorical ? ' (Historical Employee)' : ''}</span></div>
      <div class="row"><span>Reference</span><span>${subject.reference || 'N/A'}</span></div>
      <div class="row"><span>Employment Dates</span><span>${subject.dateJoined || 'N/A'} to ${subject.dateLeft || 'N/A'}</span></div>
      <div class="row"><span>Reason for Leaving</span><span>${subject.reasonForLeaving || 'Not recorded'}</span></div>
      <div class="row"><span>Pay Point</span><span>${subject.payPoint || 'Not on file'}</span></div>
      <div class="row"><span>Account Number</span><span>${subject.accountNumber || 'Not on file'}</span></div>

      <div class="section-title">Approved Entitlement (v${entitlement.version})</div>
      <div class="row"><span>Pension Arrears</span><span>${formatKwacha(entitlement.pensionArrears)}</span></div>
      <div class="row"><span>Unused Annual Leave Refund</span><span>${formatKwacha(entitlement.annualLeaveRefund)}</span></div>
      <div class="row"><span>Uniform Refund</span><span>${formatKwacha(entitlement.uniformRefund)}</span></div>
      <div class="row"><span>Verified Outstanding Salary</span><span>${formatKwacha(entitlement.outstandingSalary)}</span></div>
      <div class="row"><span>Total Entitlements</span><span>${formatKwacha(entitlement.totalEntitlements)}</span></div>
      <div class="row deduction"><span>Less Notice Deduction</span><span class="amount">-${formatKwacha(entitlement.lessNoticeDeduction)}</span></div>
      <div class="total-row"><span>Final Approved Entitlement</span><span>${formatKwacha(entitlement.finalApprovedEntitlement)}</span></div>
      <div style="font-size: 11px; color: #888; margin-top: 4px;">Approved: ${entitlement.approvedAt ? new Date(entitlement.approvedAt).toLocaleDateString() : 'Not recorded'}</div>

      <div class="section-title">Payroll-Processed Payments</div>
      ${summary.priorProcessedAllocations.length > 0 ? `
      <p style="font-size: 12px; color: #666; margin: 4px 0;">Earlier payroll-processed payments:</p>
      <table>
        <thead><tr><th>Month</th><th style="text-align:right;">Amount</th><th>Processing Reference</th><th>Processed At</th></tr></thead>
        <tbody>${rows(summary.priorProcessedAllocations)}</tbody>
      </table>` : '<p style="font-size: 12px; color: #999;">No earlier payroll-processed payments.</p>'}

      ${input.currentMonthAllocation ? `
      <p style="font-size: 12px; color: #666; margin: 10px 0 4px;">This statement's payroll month:</p>
      <table>
        <thead><tr><th>Month</th><th style="text-align:right;">Amount</th><th>Processing Reference</th><th>Processed At</th></tr></thead>
        <tbody>${rows([input.currentMonthAllocation])}</tbody>
      </table>` : ''}

      <div class="net-pay-section">
        <div>
          <div style="font-size: 11px; opacity: 0.8; text-transform: uppercase;">Total Processed To Date</div>
          <div class="amount">${formatKwacha(summary.totalProcessedToDate)}</div>
        </div>
        <div style="text-align: right;">
          <div style="font-size: 11px; opacity: 0.8; text-transform: uppercase;">Remaining Outstanding Balance</div>
          <div style="font-size: 20px; font-weight: bold;">${formatKwacha(summary.outstandingBalance)}</div>
        </div>
      </div>
      <p style="font-size: 12px; margin-top: 10px;"><strong>Settlement status:</strong> ${summary.settlementBasis}</p>

      <div class="footer">
        "Payroll Processed" reflects that Terminal Dues processing has run via Process Payroll for the stated amount(s) -- confirmed bank payment is tracked separately and is not represented by this statement. This is a system-generated statement.
      </div>
    </body>
    </html>`;
}
