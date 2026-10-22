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
import { Search, History } from '../utils/icons';
import { Card, Badge, EmptyState } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { showNotification } from '../utils/clickHandlers';
import { getErrorMessage } from '../utils/errorHandler';
import { getMonthLabel } from '../utils/currentMonth';

interface Entitlement {
  id: string;
  employee_id: string | null;
  historical_employee_id: string | null;
  employee_name: string;
  employee_number: string;
  total_payable: number;
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
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

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
    } catch (err) {
      showNotification('Failed to load Terminal Dues payment history: ' + getErrorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [entitlementIds, approvedEntitlements]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

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
                    <Badge color={isFullySettled ? 'green' : totalProcessed > 0 ? 'blue' : 'yellow'}>
                      {isFullySettled ? 'Fully Settled' : totalProcessed > 0 ? 'Partially Processed' : 'Not Yet Processed'}
                    </Badge>
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
    </div>
  );
}
