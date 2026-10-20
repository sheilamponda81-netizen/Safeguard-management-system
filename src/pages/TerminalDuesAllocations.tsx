// Terminal Dues Modernization -- Phase 2A: the monthly payment
// allocation ledger UI. HR proposes a partial-payment allocation
// against an Admin-approved entitlement for the system's existing
// active payroll month (system_settings.current_payroll_month, the
// same source Payroll.tsx uses -- there is no independent Terminal
// Dues month selector here); a distinct Admin permission
// (terminal_dues.approve) must approve or reject it. Nothing on this
// tab ever marks an entitlement paid/processed, moves it to a
// "Settled" state, or touches Process Payroll -- it only tracks
// allocations awaiting that future integration (see
// 20261023000000_terminal_dues_allocation_ledger.sql's header for the
// full scope boundary).
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Send, CheckCircle, XCircle, Clock, AlertTriangle, Pencil } from '../utils/icons';
import { Card, Button, Badge, EmptyState, Modal } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { showNotification } from '../utils/clickHandlers';
import { getErrorMessage } from '../utils/errorHandler';
import { getSystemCurrentMonth, getMonthLabel } from '../utils/currentMonth';

interface ApprovedEntitlement {
  id: string;
  employee_id: string | null;
  historical_employee_id: string | null;
  employee_name: string;
  employee_number: string;
  total_payable: number;
  status: string;
}

interface AllocationRow {
  id: string;
  terminal_due_id: string;
  payroll_month: string;
  status: 'submitted' | 'approved' | 'rejected' | 'held' | 'processed';
  proposed_amount: number;
  last_decided_amount: number | null;
  hold_reason: 'hr_correction' | 'entitlement_revised' | null;
  rejection_reason: string | null;
  submitted_at: string;
  decided_at: string | null;
}

function statusBadgeColor(status: AllocationRow['status']): 'gray' | 'yellow' | 'green' | 'red' | 'blue' {
  if (status === 'approved') return 'green';
  if (status === 'rejected') return 'red';
  if (status === 'held') return 'blue';
  if (status === 'processed') return 'green';
  return 'yellow';
}

export function TerminalDuesAllocationsTab({
  approvedEntitlements,
  canPropose,
  canApprove,
}: {
  approvedEntitlements: ApprovedEntitlement[];
  canPropose: boolean;
  canApprove: boolean;
}) {
  const [currentMonth, setCurrentMonth] = useState<string>('');
  const [allocations, setAllocations] = useState<AllocationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AllocationRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const entitlementIds = useMemo(() => approvedEntitlements.map(e => e.id), [approvedEntitlements]);

  const fetchAllocations = useCallback(async () => {
    setLoading(true);
    if (entitlementIds.length === 0) {
      setAllocations([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('terminal_due_allocations')
      .select('*')
      .in('terminal_due_id', entitlementIds);
    if (error) {
      console.error('Error fetching allocations:', error);
      showNotification('Failed to load payment allocations', 'error');
    } else {
      setAllocations((data as AllocationRow[]) || []);
    }
    setLoading(false);
  }, [entitlementIds]);

  useEffect(() => {
    getSystemCurrentMonth().then(setCurrentMonth);
  }, []);

  useEffect(() => {
    fetchAllocations();
  }, [fetchAllocations]);

  // Approved-but-unprocessed reserved total per entitlement, across EVERY
  // month it has ever had an approved allocation -- this phase never
  // processes anything, so this IS the full amount already committed
  // against the entitlement's balance (task Section 3: must never be
  // reduced merely by proposing/approving).
  const reservedByEntitlement = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of allocations) {
      if (a.status === 'approved' || a.status === 'processed') {
        map.set(a.terminal_due_id, (map.get(a.terminal_due_id) || 0) + Number(a.last_decided_amount ?? a.proposed_amount));
      }
    }
    return map;
  }, [allocations]);

  const thisMonthByEntitlement = useMemo(() => {
    const map = new Map<string, AllocationRow>();
    for (const a of allocations) {
      if (a.payroll_month === currentMonth) map.set(a.terminal_due_id, a);
    }
    return map;
  }, [allocations, currentMonth]);

  const distinctThisMonth = thisMonthByEntitlement.size;
  const remainingCapacity = Math.max(0, 50 - distinctThisMonth);

  const filteredEntitlements = useMemo(() => {
    if (!search.trim()) return approvedEntitlements;
    const q = search.toLowerCase().trim();
    return approvedEntitlements.filter(
      e => e.employee_name.toLowerCase().includes(q) || (e.employee_number || '').toLowerCase().includes(q)
    );
  }, [approvedEntitlements, search]);

  const submitThisMonth = (entitlement: ApprovedEntitlement, existing: AllocationRow | undefined) => {
    setBusyId(entitlement.id);
    const raw = amountDrafts[entitlement.id];
    const amount = Number(raw);
    (async () => {
      try {
        if (!raw || !(amount > 0)) {
          showNotification('Enter a proposed allocation amount greater than zero', 'error');
          return;
        }
        if (existing && existing.status === 'approved') {
          const { error } = await supabase.rpc('correct_terminal_due_allocation', { p_id: existing.id, p_new_amount: amount });
          if (error) throw error;
          showNotification('Correction submitted -- awaiting Admin re-approval', 'success');
        } else {
          const { error } = await supabase.rpc('propose_terminal_due_allocation', {
            p_terminal_due_id: entitlement.id,
            p_amount: amount,
          });
          if (error) throw error;
          showNotification('Allocation proposed for Admin review', 'success');
        }
        setAmountDrafts(prev => ({ ...prev, [entitlement.id]: '' }));
        await fetchAllocations();
      } catch (err) {
        showNotification('Error submitting allocation: ' + getErrorMessage(err), 'error');
      } finally {
        setBusyId(null);
      }
    })();
  };

  const approve = async (row: AllocationRow) => {
    setBusyId(row.id);
    try {
      const { error } = await supabase.rpc('approve_terminal_due_allocation', { p_id: row.id });
      if (error) throw error;
      showNotification('Allocation approved', 'success');
      await fetchAllocations();
    } catch (err) {
      showNotification('Error approving allocation: ' + getErrorMessage(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmReject = async () => {
    if (!rejectTarget) return;
    if (!rejectReason.trim()) {
      showNotification('A reason is required to reject an allocation', 'error');
      return;
    }
    setBusyId(rejectTarget.id);
    try {
      const { error } = await supabase.rpc('reject_terminal_due_allocation', { p_id: rejectTarget.id, p_reason: rejectReason.trim() });
      if (error) throw error;
      showNotification('Allocation rejected', 'success');
      setRejectTarget(null);
      setRejectReason('');
      await fetchAllocations();
    } catch (err) {
      showNotification('Error rejecting allocation: ' + getErrorMessage(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const pendingForAdmin = useMemo(
    () => allocations.filter(a => a.payroll_month === currentMonth && (a.status === 'submitted' || a.status === 'held')),
    [allocations, currentMonth]
  );

  const monthTotals = useMemo(() => {
    const thisMonth = allocations.filter(a => a.payroll_month === currentMonth);
    const sum = (predicate: (a: AllocationRow) => boolean) =>
      thisMonth.filter(predicate).reduce((acc, a) => acc + Number(a.proposed_amount), 0);
    return {
      submitted: sum(a => a.status === 'submitted' || a.status === 'held'),
      approved: sum(a => a.status === 'approved'),
      rejected: sum(a => a.status === 'rejected'),
    };
  }, [allocations, currentMonth]);

  if (!canPropose && !canApprove) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="No access"
        description="You do not have permission to view Terminal Dues payment allocations."
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-slate-500">Active Payroll Month</p>
            <p className="text-lg font-semibold text-[#081C3A]">{currentMonth ? getMonthLabel(currentMonth) : 'Loading...'}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Monthly Capacity</p>
            <p className={`text-lg font-semibold ${remainingCapacity === 0 ? 'text-red-600' : 'text-[#081C3A]'}`}>
              {distinctThisMonth} / 50 employees selected ({remainingCapacity} remaining)
            </p>
          </div>
          {canApprove && (
            <div className="flex gap-4">
              <Stat label="Submitted this month" value={monthTotals.submitted} />
              <Stat label="Approved this month" value={monthTotals.approved} />
              <Stat label="Rejected this month" value={monthTotals.rejected} />
            </div>
          )}
        </div>
      </Card>

      {canApprove && pendingForAdmin.length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Awaiting Admin Review -- {getMonthLabel(currentMonth)}</h3>
          <div className="space-y-2">
            {pendingForAdmin.map(row => {
              const entitlement = approvedEntitlements.find(e => e.id === row.terminal_due_id);
              if (!entitlement) return null;
              return (
                <div key={row.id} className="flex items-center justify-between border border-slate-200 rounded-lg p-3">
                  <div>
                    <p className="text-sm font-medium">
                      {entitlement.employee_name} <span className="text-slate-400 text-xs">({entitlement.employee_number})</span>
                    </p>
                    <p className="text-xs text-slate-500">
                      Entitlement: {formatKwacha(entitlement.total_payable)} &middot; Proposed: {formatKwacha(row.proposed_amount)}
                      {row.hold_reason === 'hr_correction' && ' (HR correction awaiting re-approval)'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" disabled={busyId === row.id} onClick={() => approve(row)}>
                      <CheckCircle size={14} className="mr-1" /> Approve
                    </Button>
                    <Button variant="outline" size="sm" disabled={busyId === row.id} onClick={() => setRejectTarget(row)}>
                      <XCircle size={14} className="mr-1" /> Reject
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {canPropose && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-700">Approved Entitlements -- Monthly Allocation</h3>
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
            <div className="space-y-2">
              {filteredEntitlements.map(entitlement => {
                const existing = thisMonthByEntitlement.get(entitlement.id);
                const reserved = reservedByEntitlement.get(entitlement.id) || 0;
                const available = entitlement.total_payable - reserved;
                const isFull = remainingCapacity === 0 && !existing;
                return (
                  <div key={entitlement.id} className="border border-slate-200 rounded-lg p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">
                          {entitlement.employee_name} <span className="text-slate-400 text-xs">({entitlement.employee_number})</span>
                          {entitlement.historical_employee_id && <Badge color="gray" className="ml-2">Historical</Badge>}
                        </p>
                        <p className="text-xs text-slate-500">
                          Entitlement: {formatKwacha(entitlement.total_payable)} &middot; Processed: {formatKwacha(0)} &middot;
                          {' '}Approved reserved: {formatKwacha(reserved)} &middot; Available: {formatKwacha(available)}
                        </p>
                      </div>
                      {existing ? (
                        <Badge color={statusBadgeColor(existing.status)}>
                          {existing.status === 'held' ? 'Held (correction pending)' : existing.status}
                        </Badge>
                      ) : (
                        <Badge color={isFull ? 'red' : 'gray'}>{isFull ? 'Month full' : 'Not yet allocated'}</Badge>
                      )}
                    </div>

                    {existing?.rejection_reason && (
                      <p className="text-xs text-red-600 mt-2 flex items-center gap-1">
                        <AlertTriangle size={12} /> Rejected: {existing.rejection_reason}. Correct the amount and resubmit below.
                      </p>
                    )}

                    {existing?.status === 'held' && (
                      <p className="text-xs text-blue-600 mt-2 flex items-center gap-1">
                        <Clock size={12} /> Correction submitted ({formatKwacha(existing.proposed_amount)}) -- awaiting Admin re-approval.
                      </p>
                    )}

                    {(!existing || existing.status === 'submitted' || existing.status === 'rejected' || existing.status === 'approved') && !isFull && (
                      <div className="flex items-center gap-2 mt-2">
                        <input
                          type="number"
                          placeholder={existing ? `Correct amount (currently ${existing.proposed_amount})` : 'Proposed amount (MWK)'}
                          value={amountDrafts[entitlement.id] ?? ''}
                          onChange={e => setAmountDrafts(prev => ({ ...prev, [entitlement.id]: e.target.value }))}
                          className="w-48 px-3 py-1.5 text-sm border border-slate-200 rounded-lg"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyId === entitlement.id}
                          onClick={() => submitThisMonth(entitlement, existing)}
                        >
                          {existing?.status === 'approved' ? (
                            <><Pencil size={14} className="mr-1" /> Submit Correction</>
                          ) : existing?.status === 'rejected' ? (
                            <><Send size={14} className="mr-1" /> Resubmit</>
                          ) : (
                            <><Send size={14} className="mr-1" /> Propose Allocation</>
                          )}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      <Modal open={!!rejectTarget} onClose={() => setRejectTarget(null)} title="Reject Allocation">
        <div className="space-y-3">
          <p className="text-sm text-slate-600">A reason is required and will be visible to HR for correction.</p>
          <textarea
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            placeholder="Reason for rejection..."
          />
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={() => setRejectTarget(null)}>Cancel</Button>
            <Button onClick={confirmReject} disabled={busyId === rejectTarget?.id}>Reject</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-right">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-sm font-semibold text-[#081C3A]">{formatKwacha(value)}</p>
    </div>
  );
}
