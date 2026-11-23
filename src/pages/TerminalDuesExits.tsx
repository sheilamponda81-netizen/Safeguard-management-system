// Terminal Dues Phase 1 -- structured employee exit records. HR records
// a scheduled exit for a current employee (identity, effective date,
// category, optional notes); the record itself never changes
// employees.status. An explicit, separate "Finalize" action -- gated on
// terminal_dues.approve, the same permission that approves entitlements
// -- is the ONLY thing that flips employees.status to 'Exited'
// (record_employee_exit/finalize_employee_exit/cancel_employee_exit/
// correct_employee_exit in 20261127000000_terminal_dues_employee_exits.sql).
// This tab does not calculate, submit, approve or pay anything -- it only
// manages the exit record that the Calculator tab can optionally link to.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, UserMinus, CheckCircle, XCircle, Pencil, AlertTriangle, Clock } from '../utils/icons';
import { Card, Button, Badge, EmptyState, Modal } from '../components/ui';
import { supabase } from '../lib/supabase';
import { showNotification } from '../utils/clickHandlers';
import { getErrorMessage } from '../utils/errorHandler';

interface ExitEmployeeOption {
  id: string;
  employeeNumber: string;
  fullName: string;
  position: string;
}

interface ExitRow {
  id: string;
  employee_id: string;
  effective_exit_date: string;
  exit_category: string;
  notes: string | null;
  status: 'scheduled' | 'finalized' | 'cancelled';
  recorded_at: string;
  finalized_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

const EXIT_CATEGORIES = [
  { value: 'resignation', label: 'Resignation' },
  { value: 'contract_expiry', label: 'Contract Expiry' },
  { value: 'dismissal', label: 'Dismissal' },
  { value: 'redundancy', label: 'Redundancy' },
  { value: 'retirement', label: 'Retirement' },
  { value: 'death', label: 'Death' },
  { value: 'other', label: 'Other' },
] as const;

function categoryLabel(value: string): string {
  return EXIT_CATEGORIES.find(c => c.value === value)?.label ?? value;
}

function statusBadgeColor(status: ExitRow['status']): 'gray' | 'yellow' | 'green' | 'red' {
  if (status === 'finalized') return 'green';
  if (status === 'cancelled') return 'gray';
  return 'yellow';
}

export function TerminalDuesExitsTab({
  employees,
  canCreate,
  canEdit,
  canApprove,
}: {
  employees: ExitEmployeeOption[];
  canCreate: boolean;
  canEdit: boolean;
  canApprove: boolean;
}) {
  const [exits, setExits] = useState<ExitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<ExitEmployeeOption | null>(null);
  const [exitDate, setExitDate] = useState('');
  const [exitCategory, setExitCategory] = useState<string>('resignation');
  const [exitNotes, setExitNotes] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const [editingExit, setEditingExit] = useState<ExitRow | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editCategory, setEditCategory] = useState<string>('resignation');
  const [editNotes, setEditNotes] = useState('');
  const [editReason, setEditReason] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  const [cancelTarget, setCancelTarget] = useState<ExitRow | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);

  const employeeById = useMemo(() => {
    const map = new Map<string, ExitEmployeeOption>();
    for (const e of employees) map.set(e.id, e);
    return map;
  }, [employees]);

  const fetchExits = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('employee_exits')
      .select('id, employee_id, effective_exit_date, exit_category, notes, status, recorded_at, finalized_at, cancelled_at, cancellation_reason')
      .order('recorded_at', { ascending: false });
    if (error) {
      console.error('Error fetching employee exits:', error);
      showNotification('Failed to load employee exit records', 'error');
    } else {
      setExits((data as ExitRow[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchExits();
  }, [fetchExits]);

  const filteredEmployeeOptions = useMemo(() => {
    if (!employeeSearch.trim()) return [];
    const q = employeeSearch.toLowerCase().trim();
    return employees
      .filter(e => e.fullName.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q))
      .slice(0, 20);
  }, [employeeSearch, employees]);

  const filteredExits = useMemo(() => {
    if (!search.trim()) return exits;
    const q = search.toLowerCase().trim();
    return exits.filter(row => {
      const emp = employeeById.get(row.employee_id);
      return emp ? emp.fullName.toLowerCase().includes(q) || emp.employeeNumber.toLowerCase().includes(q) : false;
    });
  }, [exits, search, employeeById]);

  const resetCreateForm = () => {
    setSelectedEmployee(null);
    setEmployeeSearch('');
    setExitDate('');
    setExitCategory('resignation');
    setExitNotes('');
  };

  const submitCreate = async () => {
    if (!selectedEmployee) {
      showNotification('Select an employee', 'error');
      return;
    }
    if (!exitDate) {
      showNotification('Enter an effective exit date', 'error');
      return;
    }
    setCreateBusy(true);
    try {
      const { error } = await supabase.rpc('record_employee_exit', {
        p_employee_id: selectedEmployee.id,
        p_effective_exit_date: exitDate,
        p_exit_category: exitCategory,
        p_notes: exitNotes.trim() || null,
      });
      if (error) throw error;
      showNotification('Exit record created', 'success');
      setShowCreateModal(false);
      resetCreateForm();
      await fetchExits();
    } catch (err) {
      showNotification('Error recording exit: ' + getErrorMessage(err), 'error');
    } finally {
      setCreateBusy(false);
    }
  };

  const openEdit = (row: ExitRow) => {
    setEditingExit(row);
    setEditDate(row.effective_exit_date);
    setEditCategory(row.exit_category);
    setEditNotes(row.notes || '');
    setEditReason('');
  };

  const submitEdit = async () => {
    if (!editingExit) return;
    if (!editReason.trim()) {
      showNotification('A reason is required to correct an exit record', 'error');
      return;
    }
    setEditBusy(true);
    try {
      const { error } = await supabase.rpc('correct_employee_exit', {
        p_exit_id: editingExit.id,
        p_effective_exit_date: editDate,
        p_exit_category: editCategory,
        p_notes: editNotes.trim() || null,
        p_reason: editReason.trim(),
      });
      if (error) throw error;
      showNotification('Exit record corrected', 'success');
      setEditingExit(null);
      await fetchExits();
    } catch (err) {
      showNotification('Error correcting exit: ' + getErrorMessage(err), 'error');
    } finally {
      setEditBusy(false);
    }
  };

  const finalize = async (row: ExitRow) => {
    setBusyId(row.id);
    try {
      const { error } = await supabase.rpc('finalize_employee_exit', { p_exit_id: row.id });
      if (error) throw error;
      showNotification('Exit finalized -- employee status set to Exited', 'success');
      await fetchExits();
    } catch (err) {
      showNotification('Error finalizing exit: ' + getErrorMessage(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    if (!cancelReason.trim()) {
      showNotification('A reason is required to cancel an exit record', 'error');
      return;
    }
    setCancelBusy(true);
    try {
      const { error } = await supabase.rpc('cancel_employee_exit', { p_exit_id: cancelTarget.id, p_reason: cancelReason.trim() });
      if (error) throw error;
      showNotification('Exit record cancelled', 'success');
      setCancelTarget(null);
      setCancelReason('');
      await fetchExits();
    } catch (err) {
      showNotification('Error cancelling exit: ' + getErrorMessage(err), 'error');
    } finally {
      setCancelBusy(false);
    }
  };

  if (!canCreate && !canEdit && !canApprove) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="No access"
        description="You do not have permission to view employee exit records."
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
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
          {canCreate && (
            <Button size="sm" onClick={() => setShowCreateModal(true)}>
              <UserMinus size={14} className="mr-1" /> Record Exit
            </Button>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-slate-400">Loading...</p>
        ) : filteredExits.length === 0 ? (
          <EmptyState
            icon={UserMinus}
            title="No exit records"
            description="Recorded employee exits will appear here. Recording an exit does not by itself change the employee's status -- Finalize does that explicitly."
          />
        ) : (
          <div className="space-y-2">
            {filteredExits.map(row => {
              const emp = employeeById.get(row.employee_id);
              return (
                <div key={row.id} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">
                        {emp ? emp.fullName : 'Unknown employee'} <span className="text-slate-400 text-xs">({emp?.employeeNumber ?? row.employee_id})</span>
                      </p>
                      <p className="text-xs text-slate-500">
                        {categoryLabel(row.exit_category)} &middot; Effective {row.effective_exit_date}
                      </p>
                      {row.notes && <p className="text-xs text-slate-400 mt-1">{row.notes}</p>}
                      {row.status === 'cancelled' && row.cancellation_reason && (
                        <p className="text-xs text-red-500 mt-1">Cancelled: {row.cancellation_reason}</p>
                      )}
                    </div>
                    <Badge color={statusBadgeColor(row.status)}>{row.status}</Badge>
                  </div>

                  {row.status === 'scheduled' && (
                    <div className="flex gap-2 mt-2">
                      {canEdit && (
                        <Button variant="outline" size="sm" disabled={busyId === row.id} onClick={() => openEdit(row)}>
                          <Pencil size={14} className="mr-1" /> Correct
                        </Button>
                      )}
                      {canApprove && (
                        <Button variant="secondary" size="sm" disabled={busyId === row.id} onClick={() => finalize(row)}>
                          <CheckCircle size={14} className="mr-1" /> Finalize
                        </Button>
                      )}
                      {canApprove && (
                        <Button variant="outline" size="sm" disabled={busyId === row.id} onClick={() => setCancelTarget(row)}>
                          <XCircle size={14} className="mr-1" /> Cancel
                        </Button>
                      )}
                    </div>
                  )}

                  {row.status === 'finalized' && canApprove && (
                    <div className="flex gap-2 mt-2">
                      <p className="text-xs text-green-600 flex items-center gap-1">
                        <CheckCircle size={12} /> Employee status set to Exited on {row.finalized_at ? row.finalized_at.slice(0, 10) : ''}.
                      </p>
                      <Button variant="outline" size="sm" disabled={busyId === row.id} onClick={() => setCancelTarget(row)}>
                        <XCircle size={14} className="mr-1" /> Cancel (revert to Active)
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal open={showCreateModal} onClose={() => { setShowCreateModal(false); resetCreateForm(); }} title="Record Employee Exit">
        <div className="space-y-3">
          <div className="relative">
            <input
              type="text"
              value={employeeSearch}
              onChange={e => { setEmployeeSearch(e.target.value); setSelectedEmployee(null); }}
              placeholder="Search employee by name or number..."
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
            {filteredEmployeeOptions.length > 0 && !selectedEmployee && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {filteredEmployeeOptions.map(emp => (
                  <button
                    key={emp.id}
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                    onClick={() => { setSelectedEmployee(emp); setEmployeeSearch(emp.fullName); }}
                  >
                    {emp.fullName} <span className="text-slate-400 text-xs">({emp.employeeNumber})</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500">Effective Exit Date</label>
            <input
              type="date"
              value={exitDate}
              onChange={e => setExitDate(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg mt-1"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500">Exit Category</label>
            <select
              value={exitCategory}
              onChange={e => setExitCategory(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg mt-1"
            >
              {EXIT_CATEGORIES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500">Notes (optional)</label>
            <textarea
              value={exitNotes}
              onChange={e => setExitNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg mt-1"
            />
          </div>

          <p className="text-xs text-slate-400 flex items-center gap-1">
            <Clock size={12} /> This only creates a scheduled exit record. The employee's status is not changed until the record is explicitly Finalized.
          </p>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={() => { setShowCreateModal(false); resetCreateForm(); }}>Cancel</Button>
            <Button onClick={submitCreate} disabled={createBusy}>{createBusy ? 'Saving...' : 'Record Exit'}</Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!editingExit} onClose={() => setEditingExit(null)} title="Correct Exit Record">
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-500">Effective Exit Date</label>
            <input
              type="date"
              value={editDate}
              onChange={e => setEditDate(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Exit Category</label>
            <select
              value={editCategory}
              onChange={e => setEditCategory(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg mt-1"
            >
              {EXIT_CATEGORIES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Notes (optional)</label>
            <textarea
              value={editNotes}
              onChange={e => setEditNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Reason for correction (required, audited)</label>
            <textarea
              value={editReason}
              onChange={e => setEditReason(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg mt-1"
              placeholder="Why is this record being corrected?"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={() => setEditingExit(null)}>Cancel</Button>
            <Button onClick={submitEdit} disabled={editBusy}>{editBusy ? 'Saving...' : 'Save Correction'}</Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!cancelTarget} onClose={() => setCancelTarget(null)} title="Cancel Exit Record">
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {cancelTarget?.status === 'finalized'
              ? 'This exit was finalized -- cancelling it will revert the employee\'s status back to Active.'
              : 'This exit has not been finalized yet -- cancelling it leaves the employee\'s status untouched.'}
          </p>
          <textarea
            value={cancelReason}
            onChange={e => setCancelReason(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            placeholder="Reason for cancellation..."
          />
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={() => setCancelTarget(null)}>Keep Record</Button>
            <Button onClick={confirmCancel} disabled={cancelBusy}>{cancelBusy ? 'Cancelling...' : 'Cancel Exit'}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
