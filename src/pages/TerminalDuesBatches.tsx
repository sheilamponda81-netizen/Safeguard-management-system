// Terminal Dues Phase 2 -- integrated batch management. Lets HR/Admin
// group departing employees (e.g. 50 at once) under one named batch and
// see their combined financial picture, while every amount still comes
// from the SAME existing settlement ledger (terminal_due_calculations/
// terminal_dues/terminal_due_allocations) the Calculator/Allocations/
// History tabs already use -- this file computes nothing new; it only
// filters those same rows by batch_id and feeds them into
// terminalDuesOverview.ts's existing, unmodified aggregation.
//
// Batch membership never, by itself, finalizes an exit, creates or
// submits a calculation, approves a settlement, or records a payment --
// every one of those stays the separate, explicitly-authorized action
// it already was.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Users, Plus, X, Search, ArrowRightCircle, Lock, AlertTriangle } from '../utils/icons';
import { Card, Button, Badge, EmptyState, Modal } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { showNotification } from '../utils/clickHandlers';
import { getErrorMessage } from '../utils/errorHandler';
import {
  computeEntitlementFinancials,
  summarizeTerminalDuesOverview,
  OverviewEntitlement,
  OverviewAllocation,
} from '../utils/terminalDuesOverview';

interface BatchEmployeeOption {
  id: string;
  employeeNumber: string;
  fullName: string;
  position: string;
}

interface Batch {
  id: string;
  name: string;
  status: 'active' | 'closed';
  created_at: string;
  closed_at: string | null;
}

interface BatchMember {
  id: string;
  employee_id: string;
  added_at: string;
}

interface ExitSummary {
  employee_id: string;
  status: 'scheduled' | 'finalized' | 'cancelled';
}

interface CalculationSummary {
  id: string;
  employee_id: string | null;
  status: string;
  total_payable: number;
}

function settlementStatusLabel(due: OverviewEntitlement | undefined, draft: CalculationSummary | undefined): { label: string; color: 'gray' | 'yellow' | 'blue' | 'green' } {
  if (due) {
    if (due.status === 'paid') return { label: 'Paid', color: 'green' };
    if (due.status === 'approved') return { label: 'Approved', color: 'blue' };
    return { label: 'Submitted (pending approval)', color: 'yellow' };
  }
  if (draft) return { label: 'Draft calculation', color: 'yellow' };
  return { label: 'No settlement yet', color: 'gray' };
}

export function TerminalDuesBatchesTab({
  employees,
  canCreate,
  canEdit,
}: {
  employees: BatchEmployeeOption[];
  canCreate: boolean;
  canEdit: boolean;
}) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  const [members, setMembers] = useState<BatchMember[]>([]);
  const [exits, setExits] = useState<ExitSummary[]>([]);
  const [drafts, setDrafts] = useState<CalculationSummary[]>([]);
  const [confirmedDues, setConfirmedDues] = useState<OverviewEntitlement[]>([]);
  const [allocations, setAllocations] = useState<OverviewAllocation[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newBatchName, setNewBatchName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [selectedToAdd, setSelectedToAdd] = useState<Set<string>>(new Set());
  const [addBusy, setAddBusy] = useState(false);

  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [removeBusy, setRemoveBusy] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);

  const employeeById = useMemo(() => {
    const map = new Map<string, BatchEmployeeOption>();
    for (const e of employees) map.set(e.id, e);
    return map;
  }, [employees]);

  const fetchBatches = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('terminal_due_batches')
      .select('id, name, status, created_at, closed_at')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Error fetching Terminal Dues batches:', error);
      showNotification('Failed to load Terminal Dues batches', 'error');
    } else {
      setBatches((data as Batch[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchBatches();
  }, [fetchBatches]);

  const selectedBatch = useMemo(() => batches.find(b => b.id === selectedBatchId) || null, [batches, selectedBatchId]);

  const fetchBatchDetail = useCallback(async (batchId: string) => {
    setDetailLoading(true);
    try {
      const [membersRes, draftsRes, duesRes] = await Promise.all([
        supabase.from('terminal_due_batch_members').select('id, employee_id, added_at').eq('batch_id', batchId).is('removed_at', null),
        supabase.from('terminal_due_calculations').select('id, employee_id, status, total_payable').eq('batch_id', batchId).eq('status', 'draft'),
        supabase.from('terminal_dues').select('id, status, total_payable, employee_id').eq('batch_id', batchId),
      ]);
      if (membersRes.error) throw membersRes.error;
      if (draftsRes.error) throw draftsRes.error;
      if (duesRes.error) throw duesRes.error;

      const memberRows = (membersRes.data as BatchMember[]) || [];
      setMembers(memberRows);
      setDrafts((draftsRes.data as CalculationSummary[]) || []);
      const dues = (duesRes.data as (OverviewEntitlement & { employee_id: string | null })[]) || [];
      setConfirmedDues(dues);

      const memberEmployeeIds = memberRows.map(m => m.employee_id);
      const [exitsRes, allocRes] = await Promise.all([
        memberEmployeeIds.length > 0
          ? supabase.from('employee_exits').select('employee_id, status').in('employee_id', memberEmployeeIds).neq('status', 'cancelled')
          : Promise.resolve({ data: [], error: null }),
        dues.length > 0
          ? supabase.from('terminal_due_allocations').select('terminal_due_id, status, proposed_amount, last_decided_amount').in('terminal_due_id', dues.map(d => d.id))
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (exitsRes.error) throw exitsRes.error;
      if (allocRes.error) throw allocRes.error;
      setExits((exitsRes.data as ExitSummary[]) || []);
      setAllocations((allocRes.data as OverviewAllocation[]) || []);
    } catch (err) {
      console.error('Error loading batch detail:', err);
      showNotification('Failed to load batch detail: ' + getErrorMessage(err), 'error');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedBatchId) fetchBatchDetail(selectedBatchId);
  }, [selectedBatchId, fetchBatchDetail]);

  const filteredEmployeeOptions = useMemo(() => {
    if (!employeeSearch.trim()) return [];
    const q = employeeSearch.toLowerCase().trim();
    const memberIds = new Set(members.map(m => m.employee_id));
    return employees
      .filter(e => !memberIds.has(e.id) && (e.fullName.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q)))
      .slice(0, 30);
  }, [employeeSearch, employees, members]);

  const createBatch = async () => {
    if (!newBatchName.trim()) {
      showNotification('Enter a batch name', 'error');
      return;
    }
    setCreateBusy(true);
    try {
      const { data, error } = await supabase.rpc('create_terminal_due_batch', { p_name: newBatchName.trim() });
      if (error) throw error;
      showNotification('Batch created', 'success');
      setShowCreateModal(false);
      setNewBatchName('');
      await fetchBatches();
      if (data?.id) setSelectedBatchId(data.id);
    } catch (err) {
      showNotification('Error creating batch: ' + getErrorMessage(err), 'error');
    } finally {
      setCreateBusy(false);
    }
  };

  const confirmAddSelected = async () => {
    if (!selectedBatchId || selectedToAdd.size === 0) return;
    setAddBusy(true);
    try {
      const { data, error } = await supabase.rpc('add_employees_to_batch', {
        p_batch_id: selectedBatchId,
        p_employee_ids: Array.from(selectedToAdd),
      });
      if (error) throw error;
      const skipped = (data?.skipped as { employee_id: string; reason: string }[]) || [];
      const addedCount = (data?.added as string[])?.length ?? 0;
      if (skipped.length > 0) {
        showNotification(`Added ${addedCount}; skipped ${skipped.length} (${skipped.map(s => s.reason).join('; ')})`, skipped.length === selectedToAdd.size ? 'error' : 'success');
      } else {
        showNotification(`Added ${addedCount} employee(s) to the batch`, 'success');
      }
      setShowAddModal(false);
      setSelectedToAdd(new Set());
      setEmployeeSearch('');
      await fetchBatchDetail(selectedBatchId);
    } catch (err) {
      showNotification('Error adding employees: ' + getErrorMessage(err), 'error');
    } finally {
      setAddBusy(false);
    }
  };

  const confirmRemove = async () => {
    if (!selectedBatchId || !removeTarget) return;
    if (!removeReason.trim()) {
      showNotification('A removal reason is required', 'error');
      return;
    }
    setRemoveBusy(true);
    try {
      const { error } = await supabase.rpc('remove_employee_from_batch', {
        p_batch_id: selectedBatchId,
        p_employee_id: removeTarget,
        p_reason: removeReason.trim(),
      });
      if (error) throw error;
      showNotification('Employee removed from batch', 'success');
      setRemoveTarget(null);
      setRemoveReason('');
      await fetchBatchDetail(selectedBatchId);
    } catch (err) {
      showNotification('Error removing employee: ' + getErrorMessage(err), 'error');
    } finally {
      setRemoveBusy(false);
    }
  };

  const closeBatch = async () => {
    if (!selectedBatchId) return;
    if (!confirm('Close this batch? Its roster will be frozen for history, but members can join a different batch afterward.')) return;
    setCloseBusy(true);
    try {
      const { error } = await supabase.rpc('close_terminal_due_batch', { p_batch_id: selectedBatchId });
      if (error) throw error;
      showNotification('Batch closed', 'success');
      await fetchBatches();
      await fetchBatchDetail(selectedBatchId);
    } catch (err) {
      showNotification('Error closing batch: ' + getErrorMessage(err), 'error');
    } finally {
      setCloseBusy(false);
    }
  };

  const draftTotal = useMemo(() => drafts.reduce((sum, d) => sum + (Number(d.total_payable) || 0), 0), [drafts]);
  const batchSummary = useMemo(() => summarizeTerminalDuesOverview(confirmedDues, allocations), [confirmedDues, allocations]);

  const exitByEmployee = useMemo(() => {
    const map = new Map<string, ExitSummary>();
    for (const e of exits) map.set(e.employee_id, e);
    return map;
  }, [exits]);
  const draftByEmployee = useMemo(() => {
    const map = new Map<string, CalculationSummary>();
    for (const d of drafts) map.set(d.employee_id || '', d);
    return map;
  }, [drafts]);
  const dueByEmployee = useMemo(() => {
    const map = new Map<string, OverviewEntitlement>();
    for (const d of confirmedDues as (OverviewEntitlement & { employee_id: string | null })[]) {
      if (d.employee_id) map.set(d.employee_id, d);
    }
    return map;
  }, [confirmedDues]);
  const allocationsByDue = useMemo(() => {
    const map = new Map<string, OverviewAllocation[]>();
    for (const a of allocations) {
      const list = map.get(a.terminal_due_id) || [];
      list.push(a);
      map.set(a.terminal_due_id, list);
    }
    return map;
  }, [allocations]);

  if (!canCreate && !canEdit) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="No access"
        description="You do not have permission to view Terminal Dues batches."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="p-4 md:col-span-1">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-700">Batches</h3>
            {canCreate && (
              <Button size="sm" onClick={() => setShowCreateModal(true)}>
                <Plus size={14} className="mr-1" /> New
              </Button>
            )}
          </div>
          {loading ? (
            <p className="text-sm text-slate-400">Loading...</p>
          ) : batches.length === 0 ? (
            <EmptyState icon={Users} title="No batches yet" description="Create a batch to group departing employees for processing together." />
          ) : (
            <div className="space-y-1">
              {batches.map(b => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setSelectedBatchId(b.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center justify-between ${selectedBatchId === b.id ? 'bg-[#081C3A]/10 font-medium' : 'hover:bg-slate-50'}`}
                >
                  <span>{b.name}</span>
                  <Badge color={b.status === 'active' ? 'green' : 'gray'}>{b.status}</Badge>
                </button>
              ))}
            </div>
          )}
        </Card>

        <div className="md:col-span-2 space-y-6">
          {!selectedBatch ? (
            <Card className="p-6">
              <EmptyState icon={Users} title="Select a batch" description="Choose a batch on the left, or create a new one, to manage its membership and see its combined financial picture." />
            </Card>
          ) : (
            <>
              <Card className="p-4">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-base font-semibold text-[#081C3A]">{selectedBatch.name}</h3>
                  <div className="flex items-center gap-2">
                    <Badge color={selectedBatch.status === 'active' ? 'green' : 'gray'}>{selectedBatch.status}</Badge>
                    {selectedBatch.status === 'active' && canEdit && (
                      <Button variant="outline" size="sm" disabled={closeBusy} onClick={closeBatch}>
                        <Lock size={14} className="mr-1" /> Close Batch
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-slate-500">{members.length} member(s) &middot; created {new Date(selectedBatch.created_at).toLocaleDateString()}</p>
              </Card>

              <Card className="p-4">
                <h4 className="text-sm font-semibold text-slate-700 mb-3">Combined Financial Picture</h4>
                <p className="text-xs text-slate-400 mb-3 flex items-center gap-1">
                  <AlertTriangle size={12} /> Derived entirely from each member's own settlement ledger -- nothing here is a new calculation.
                </p>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <Stat label="Draft estimates" value={draftTotal} />
                  <Stat label="Confirmed entitlement" value={batchSummary.confirmedEntitlementTotal} />
                  <Stat label="Approved, awaiting payroll" value={batchSummary.approvedForPayrollTotal} />
                  <Stat label="Actually paid" value={batchSummary.actuallyPaidTotal} highlight="green" />
                  <Stat label="Remaining liability" value={batchSummary.remainingLiabilityTotal} highlight="red" />
                </div>
              </Card>

              <Card className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-slate-700">Members</h4>
                  {selectedBatch.status === 'active' && canEdit && (
                    <Button variant="outline" size="sm" onClick={() => setShowAddModal(true)}>
                      <Plus size={14} className="mr-1" /> Add Employees
                    </Button>
                  )}
                </div>
                {detailLoading ? (
                  <p className="text-sm text-slate-400">Loading...</p>
                ) : members.length === 0 ? (
                  <EmptyState icon={Users} title="No members yet" description="Add departing employees to this batch." />
                ) : (
                  <div className="space-y-2">
                    {members.map(m => {
                      const emp = employeeById.get(m.employee_id);
                      const exit = exitByEmployee.get(m.employee_id);
                      const due = dueByEmployee.get(m.employee_id);
                      const draft = draftByEmployee.get(m.employee_id);
                      const settlement = settlementStatusLabel(due, draft);
                      const financials = due ? computeEntitlementFinancials(due, allocationsByDue.get(due.id) || []) : null;
                      return (
                        <div key={m.id} className="border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium">
                              {emp ? emp.fullName : 'Unknown employee'} <span className="text-slate-400 text-xs">({emp?.employeeNumber ?? m.employee_id})</span>
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              {exit ? (
                                <Badge color={exit.status === 'finalized' ? 'green' : 'yellow'}>Exit: {exit.status}</Badge>
                              ) : (
                                <Badge color="gray">No exit recorded</Badge>
                              )}
                              <Badge color={settlement.color}>{settlement.label}</Badge>
                              {financials && (
                                <span className="text-xs text-slate-500">
                                  {formatKwacha(financials.totalEntitlement)} total &middot; {formatKwacha(financials.actuallyPaid)} paid
                                </span>
                              )}
                              {!due && draft && (
                                <span className="text-xs text-slate-500">{formatKwacha(draft.total_payable)} (draft)</span>
                              )}
                            </div>
                          </div>
                          {selectedBatch.status === 'active' && canEdit && (
                            <Button variant="outline" size="sm" onClick={() => setRemoveTarget(m.employee_id)}>
                              <X size={14} />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </div>

      <Modal open={showCreateModal} onClose={() => setShowCreateModal(false)} title="New Terminal Dues Batch">
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-500">Batch Name</label>
            <input
              type="text"
              value={newBatchName}
              onChange={e => setNewBatchName(e.target.value)}
              placeholder="e.g. November 2026 Retrenchment Round"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg mt-1"
            />
          </div>
          <p className="text-xs text-slate-400">
            Creating a batch only sets up an empty roster -- it does not finalize any exit, calculate any amount, or approve or pay anything.
          </p>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={() => setShowCreateModal(false)}>Cancel</Button>
            <Button onClick={createBatch} disabled={createBusy}>{createBusy ? 'Creating...' : 'Create Batch'}</Button>
          </div>
        </div>
      </Modal>

      <Modal open={showAddModal} onClose={() => { setShowAddModal(false); setSelectedToAdd(new Set()); setEmployeeSearch(''); }} title="Add Employees to Batch">
        <div className="space-y-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={employeeSearch}
              onChange={e => setEmployeeSearch(e.target.value)}
              placeholder="Search employee by name or number..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>
          {filteredEmployeeOptions.length > 0 && (
            <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg divide-y">
              {filteredEmployeeOptions.map(emp => (
                <label key={emp.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={selectedToAdd.has(emp.id)}
                    onChange={e => {
                      setSelectedToAdd(prev => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(emp.id); else next.delete(emp.id);
                        return next;
                      });
                    }}
                  />
                  {emp.fullName} <span className="text-slate-400 text-xs">({emp.employeeNumber})</span>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-500">{selectedToAdd.size} employee(s) selected.</p>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={() => { setShowAddModal(false); setSelectedToAdd(new Set()); setEmployeeSearch(''); }}>Cancel</Button>
            <Button onClick={confirmAddSelected} disabled={addBusy || selectedToAdd.size === 0}>
              {addBusy ? 'Adding...' : <><ArrowRightCircle size={14} className="mr-1" /> Add Selected</>}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!removeTarget} onClose={() => setRemoveTarget(null)} title="Remove Employee from Batch">
        <div className="space-y-3">
          <p className="text-sm text-slate-600">This only removes them from the batch roster -- any linked settlement, exit record or payment is untouched.</p>
          <textarea
            value={removeReason}
            onChange={e => setRemoveReason(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            placeholder="Reason for removal..."
          />
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button onClick={confirmRemove} disabled={removeBusy}>{removeBusy ? 'Removing...' : 'Remove'}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: 'green' | 'red' }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-sm font-semibold ${highlight === 'green' ? 'text-green-600' : highlight === 'red' ? 'text-red-600' : 'text-[#081C3A]'}`}>
        {formatKwacha(value)}
      </p>
    </div>
  );
}
