// Phase 4A Part 3 -- read-only per-employee/per-entitlement Terminal Dues
// payment history. Purely a new view over data the Allocations tab
// (TerminalDuesAllocations.tsx) already writes and partially surfaces
// (its own `processedByEntitlement`/`settledEntitlements` derivations) --
// no new RPC, no new migration, no mutation anywhere in this file. Built
// as its own tab/component rather than folded into the Allocations tab
// because that tab's own scope is the CURRENT month's proposal/approval
// workflow; this one reports the FULL history of an entitlement across
// every month it has ever had a processed payment, for both current and
// historical employees.
//
// "Do not introduce bank-payment confirmation unless the current
// architecture already provides reliable evidence of it" -- it does not
// (see TerminalDuesAllocations.tsx's own "Settled" section comment:
// "confirmed bank payment is tracked separately and is not yet shown
// here"). This view is explicit about that boundary too: "settled" here
// means "Terminal Dues processing has run for the full entitlement
// amount," never a claim that a bank transfer has cleared.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, History, FileText, Printer, Download } from '../utils/icons';
import { Card, Badge, EmptyState, Modal, Button } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { showNotification } from '../utils/clickHandlers';
import { getErrorMessage } from '../utils/errorHandler';
import { getMonthLabel, getSystemCurrentMonth } from '../utils/currentMonth';
import { summarizeTerminalDuesStatement, StatementAllocation } from '../utils/terminalDuesStatement';
import { buildTerminalDuesStatementHtml } from '../utils/terminalDuesStatementHtml';

interface Entitlement {
  id: string;
  employee_id: string | null;
  historical_employee_id: string | null;
  employee_name: string;
  employee_number: string;
  date_joined: string;
  date_left: string;
  reason_for_termination: string;
  gratuity: number;
  annual_leave: number;
  uniform_refund: number;
  other_benefits: number;
  deductions: number;
  subtotal: number;
  total_payable: number;
  approved_at: string | null;
  status: string;
}

interface AllocationHistoryRow {
  id: string;
  terminal_due_id: string;
  payroll_month: string;
  status: 'submitted' | 'approved' | 'rejected' | 'held' | 'processed' | 'excluded';
  proposed_amount: number;
  last_decided_amount: number | null;
  processing_reference: string | null;
  processed_at: string | null;
}

interface PayDetails {
  pay_point: string | null;
  account_number: string | null;
}

export function TerminalDuesPaymentHistoryTab({
  approvedEntitlements,
  canView,
}: {
  approvedEntitlements: Entitlement[];
  canView: boolean;
}) {
  const [allocations, setAllocations] = useState<AllocationHistoryRow[]>([]);
  const [payDetailsByEmployee, setPayDetailsByEmployee] = useState<Map<string, PayDetails>>(new Map());
  const [payDetailsByHistorical, setPayDetailsByHistorical] = useState<Map<string, PayDetails>>(new Map());
  const [versionByEntitlement, setVersionByEntitlement] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statementTarget, setStatementTarget] = useState<Entitlement | null>(null);
  const [statementMonth, setStatementMonth] = useState('');

  const entitlementIds = useMemo(() => approvedEntitlements.map(e => e.id), [approvedEntitlements]);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    if (entitlementIds.length === 0) {
      setAllocations([]);
      setLoading(false);
      return;
    }
    try {
      const { data, error } = await supabase
        .from('terminal_due_allocations')
        .select('id, terminal_due_id, payroll_month, status, proposed_amount, last_decided_amount, processing_reference, processed_at')
        .in('terminal_due_id', entitlementIds);
      if (error) throw error;
      setAllocations((data as AllocationHistoryRow[]) || []);

      const employeeIds = Array.from(new Set(approvedEntitlements.map(e => e.employee_id).filter((id): id is string => !!id)));
      const historicalIds = Array.from(new Set(approvedEntitlements.map(e => e.historical_employee_id).filter((id): id is string => !!id)));

      if (employeeIds.length > 0) {
        const { data: empRows, error: empError } = await supabase
          .from('employees')
          .select('id, pay_point, account_number')
          .in('id', employeeIds);
        if (empError) throw empError;
        setPayDetailsByEmployee(new Map((empRows || []).map((e: { id: string; pay_point: string | null; account_number: string | null }) => [e.id, e])));
      } else {
        setPayDetailsByEmployee(new Map());
      }

      if (historicalIds.length > 0) {
        const { data: histRows, error: histError } = await supabase
          .from('historical_employees')
          .select('id, pay_point, account_number')
          .in('id', historicalIds);
        if (histError) throw histError;
        setPayDetailsByHistorical(new Map((histRows || []).map((e: { id: string; pay_point: string | null; account_number: string | null }) => [e.id, e])));
      } else {
        setPayDetailsByHistorical(new Map());
      }

      // "Version" (Phase 4B Part 3) -- the highest approved revision
      // version for this entitlement, same field/labeling convention
      // TerminalDuesRevision.tsx already uses ("v{version}"). An
      // entitlement never revised has no row here at all -- version 1
      // (its original, un-revised approval) is the correct default.
      const { data: revisionRows, error: revisionError } = await supabase
        .from('terminal_due_revisions')
        .select('terminal_due_id, version')
        .in('terminal_due_id', entitlementIds)
        .eq('status', 'approved');
      if (revisionError) throw revisionError;
      const versions = new Map<string, number>();
      (revisionRows || []).forEach((r: { terminal_due_id: string; version: number }) => {
        versions.set(r.terminal_due_id, Math.max(versions.get(r.terminal_due_id) || 1, r.version));
      });
      setVersionByEntitlement(versions);
    } catch (err) {
      showNotification('Failed to load Terminal Dues payment history: ' + getErrorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [entitlementIds, approvedEntitlements]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    getSystemCurrentMonth().then(setStatementMonth);
  }, []);

  const processedByEntitlement = useMemo(() => {
    const map = new Map<string, AllocationHistoryRow[]>();
    for (const a of allocations) {
      if (a.status !== 'processed') continue;
      const list = map.get(a.terminal_due_id) || [];
      list.push(a);
      map.set(a.terminal_due_id, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.payroll_month.localeCompare(b.payroll_month));
    }
    return map;
  }, [allocations]);

  const buildStatementData = useCallback((entitlement: Entitlement) => {
    const entitlementAllocations = allocations
      .filter(a => a.terminal_due_id === entitlement.id && a.status === 'processed')
      .sort((a, b) => a.payroll_month.localeCompare(b.payroll_month));
    const processedAllocations: StatementAllocation[] = entitlementAllocations.map(a => ({
      payrollMonth: a.payroll_month,
      amount: Number(a.last_decided_amount ?? a.proposed_amount),
      processingReference: a.processing_reference,
      processedAt: a.processed_at,
    }));
    const currentMonthAllocation = processedAllocations.find(a => a.payrollMonth === statementMonth) || null;
    const payDetails = entitlement.employee_id
      ? payDetailsByEmployee.get(entitlement.employee_id)
      : entitlement.historical_employee_id
        ? payDetailsByHistorical.get(entitlement.historical_employee_id)
        : undefined;

    return {
      subject: {
        name: entitlement.employee_name,
        reference: entitlement.employee_number,
        isHistorical: !!entitlement.historical_employee_id,
        dateJoined: entitlement.date_joined,
        dateLeft: entitlement.date_left,
        reasonForLeaving: entitlement.reason_for_termination,
        payPoint: payDetails?.pay_point ?? null,
        accountNumber: payDetails?.account_number ?? null,
      },
      entitlement: {
        version: versionByEntitlement.get(entitlement.id) || 1,
        pensionArrears: entitlement.gratuity,
        annualLeaveRefund: entitlement.annual_leave,
        uniformRefund: entitlement.uniform_refund,
        outstandingSalary: entitlement.other_benefits,
        lessNoticeDeduction: entitlement.deductions,
        totalEntitlements: entitlement.subtotal,
        finalApprovedEntitlement: entitlement.total_payable,
        approvedAt: entitlement.approved_at,
      },
      processedAllocations,
      currentMonthAllocation,
      statementMonth,
    };
  }, [allocations, payDetailsByEmployee, payDetailsByHistorical, versionByEntitlement, statementMonth]);

  const printStatement = useCallback((entitlement: Entitlement) => {
    const input = buildStatementData(entitlement);
    const summary = summarizeTerminalDuesStatement(input);
    const printWindow = window.open('', '_blank', 'width=800,height=600');
    if (!printWindow) {
      showNotification('Please allow pop-ups to print statements', 'error');
      return;
    }
    printWindow.document.write(buildTerminalDuesStatementHtml(input, summary));
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => { printWindow.print(); }, 250);
  }, [buildStatementData]);

  const downloadStatement = useCallback(async (entitlement: Entitlement) => {
    try {
      const input = buildStatementData(entitlement);
      const summary = summarizeTerminalDuesStatement(input);
      const [html2canvasModule, jsPDFModule] = await Promise.all([import('html2canvas'), import('jspdf')]);
      const html2canvas = html2canvasModule.default;
      const jsPDF = jsPDFModule.default;

      const container = document.createElement('div');
      container.style.position = 'absolute';
      container.style.left = '-9999px';
      container.style.width = '800px';
      container.innerHTML = buildTerminalDuesStatementHtml(input, summary).replace(/<!DOCTYPE[\s\S]*?<body>/, '').replace('</body></html>', '');
      document.body.appendChild(container);

      const canvas = await html2canvas(container, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
      document.body.removeChild(container);

      const pdf = new jsPDF('p', 'mm', 'a4');
      const imgWidth = 210;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, imgWidth, imgHeight);
      pdf.save(`terminal_dues_statement_${entitlement.employee_number}_${statementMonth}.pdf`);
    } catch (err) {
      showNotification('Failed to generate statement PDF: ' + getErrorMessage(err), 'error');
    }
  }, [buildStatementData, statementMonth]);

  const filteredEntitlements = useMemo(() => {
    if (!search.trim()) return approvedEntitlements;
    const q = search.toLowerCase().trim();
    return approvedEntitlements.filter(
      e => e.employee_name.toLowerCase().includes(q) || (e.employee_number || '').toLowerCase().includes(q)
    );
  }, [approvedEntitlements, search]);

  if (!canView) {
    return (
      <EmptyState
        icon={History}
        title="No access"
        description="You do not have permission to view Terminal Dues payment history."
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-700">Payment History -- Approved Entitlements</h3>
          <div className="relative w-64">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search employee..."
              className="w-full pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg"
            />
          </div>
        </div>
        {loading ? (
          <p className="text-sm text-slate-400">Loading...</p>
        ) : filteredEntitlements.length === 0 ? (
          <EmptyState title="No approved entitlements" description="Entitlements become available here once Admin has approved them in Records." />
        ) : (
          <div className="space-y-3">
            {filteredEntitlements.map(entitlement => {
              const processed = processedByEntitlement.get(entitlement.id) || [];
              const totalProcessed = processed.reduce((sum, a) => sum + Number(a.last_decided_amount ?? a.proposed_amount), 0);
              const outstanding = Math.max(0, entitlement.total_payable - totalProcessed);
              const isFullySettled = totalProcessed > 0 && totalProcessed >= entitlement.total_payable;
              const payDetails = entitlement.employee_id
                ? payDetailsByEmployee.get(entitlement.employee_id)
                : entitlement.historical_employee_id
                  ? payDetailsByHistorical.get(entitlement.historical_employee_id)
                  : undefined;
              const lastProcessed = processed[processed.length - 1];

              return (
                <div key={entitlement.id} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                    <div>
                      <p className="text-sm font-medium">
                        {entitlement.employee_name} <span className="text-slate-400 text-xs">({entitlement.employee_number})</span>
                        {entitlement.historical_employee_id && <Badge color="gray" className="ml-2">Historical</Badge>}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {payDetails?.pay_point ? `Pay Point: ${payDetails.pay_point}` : 'Pay Point: (not on file)'}
                        {' '}&middot;{' '}
                        {payDetails?.account_number ? `Account: ${payDetails.account_number}` : 'Account: (not on file)'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge color={isFullySettled ? 'green' : totalProcessed > 0 ? 'blue' : 'yellow'}>
                        {isFullySettled ? 'Fully Settled' : totalProcessed > 0 ? 'Partially Processed' : 'Not Yet Processed'}
                      </Badge>
                      <Button variant="outline" size="sm" onClick={() => setStatementTarget(entitlement)}>
                        <FileText size={12} className="mr-1" /> Statement
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs border-t border-slate-100 pt-2 mb-2">
                    <div><span className="text-slate-500">Approved entitlement:</span> <span className="font-medium">{formatKwacha(entitlement.total_payable)}</span></div>
                    <div><span className="text-slate-500">Total processed:</span> <span className="font-medium">{formatKwacha(totalProcessed)}</span></div>
                    <div><span className="text-slate-500">Outstanding balance:</span> <span className="font-medium">{formatKwacha(outstanding)}</span></div>
                    <div>
                      <span className="text-slate-500">Settlement basis:</span>{' '}
                      <span className="font-medium">
                        {isFullySettled && lastProcessed
                          ? `Fully settled via ${lastProcessed.processing_reference || '(no reference)'} (${getMonthLabel(lastProcessed.payroll_month)})`
                          : totalProcessed > 0
                            ? 'Partially processed -- further payments expected'
                            : 'No payment processed yet'}
                      </span>
                    </div>
                  </div>

                  {processed.length > 0 ? (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-slate-400">
                          <th className="py-1 pr-2">Month</th>
                          <th className="py-1 pr-2">Amount</th>
                          <th className="py-1 pr-2">Processing Reference</th>
                          <th className="py-1 pr-2">Processed At</th>
                        </tr>
                      </thead>
                      <tbody>
                        {processed.map(a => (
                          <tr key={a.id} className="border-t border-slate-100">
                            <td className="py-1 pr-2">{getMonthLabel(a.payroll_month)}</td>
                            <td className="py-1 pr-2">{formatKwacha(Number(a.last_decided_amount ?? a.proposed_amount))}</td>
                            <td className="py-1 pr-2">{a.processing_reference || '(none)'}</td>
                            <td className="py-1 pr-2">{a.processed_at ? new Date(a.processed_at).toLocaleDateString() : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-xs text-slate-400">No payroll-processed payments for this entitlement yet.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <p className="text-xs text-slate-400">
        "Fully Settled"/"Partially Processed" reflects that Terminal Dues processing has run via Process Payroll -- confirmed bank payment is tracked separately and is not shown here.
      </p>

      <Modal open={!!statementTarget} onClose={() => setStatementTarget(null)} title="Terminal Dues Payment Statement" size="lg">
        {statementTarget && (() => {
          const input = buildStatementData(statementTarget);
          const summary = summarizeTerminalDuesStatement(input);
          return (
            <div className="space-y-4">
              <div className="p-4 border border-slate-200 rounded-lg text-sm space-y-2">
                <p className="font-semibold">{input.subject.name} <span className="text-slate-400 text-xs">({input.subject.reference})</span> -- v{input.entitlement.version}</p>
                <p className="text-xs text-slate-500">
                  {input.subject.dateJoined || 'N/A'} to {input.subject.dateLeft || 'N/A'} &middot; {input.subject.reasonForLeaving || 'Reason not recorded'}
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-slate-100">
                  <div>Pension Arrears: {formatKwacha(input.entitlement.pensionArrears)}</div>
                  <div>Annual Leave Refund: {formatKwacha(input.entitlement.annualLeaveRefund)}</div>
                  <div>Uniform Refund: {formatKwacha(input.entitlement.uniformRefund)}</div>
                  <div>Verified Outstanding Salary: {formatKwacha(input.entitlement.outstandingSalary)}</div>
                  <div>Less Notice Deduction: -{formatKwacha(input.entitlement.lessNoticeDeduction)}</div>
                  <div className="font-semibold">Final Approved Entitlement: {formatKwacha(input.entitlement.finalApprovedEntitlement)}</div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-slate-100">
                  <div>Total Processed To Date: {formatKwacha(summary.totalProcessedToDate)}</div>
                  <div className="font-semibold">Outstanding Balance: {formatKwacha(summary.outstandingBalance)}</div>
                </div>
                <p className="text-xs"><strong>Settlement status:</strong> {summary.settlementBasis}</p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button variant="outline" onClick={() => printStatement(statementTarget)}>
                  <Printer size={14} className="mr-1" /> Print
                </Button>
                <Button variant="secondary" onClick={() => downloadStatement(statementTarget)}>
                  <Download size={14} className="mr-1" /> Download PDF
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
