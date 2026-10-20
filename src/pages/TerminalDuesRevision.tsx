// Terminal Dues Modernization -- Phase 2B: the entitlement revision
// panel, rendered inside the Records detail modal for an APPROVED
// terminal_dues row. This is deliberately NOT the same thing as
// return_terminal_due_for_correction() (Admin-initiated, flips the row
// back to 'pending' with no preserved snapshot) -- an already-approved
// entitlement here is never reopened or overwritten as an ordinary
// editable draft. HR proposes a revision; the original entitlement
// stays authoritative (status/total_payable unchanged) until Admin
// approves it; every past revision (accepted or not) remains a
// permanent, readable row.
//
// Revision proposals require a linked modern calculation to seed the
// engine's structured inputs (dateJoined/dateLeft/finalSalary/etc) --
// an entitlement created through the legacy Records "New Calculation"
// flow has no such structured history to revise safely through the same
// engine, so this panel does not offer a revision action for it.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Pencil, Send, CheckCircle, XCircle, AlertTriangle, Clock, Plus, Trash2 } from '../utils/icons';
import { Card, Button, Badge, Modal } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { showNotification } from '../utils/clickHandlers';
import { getErrorMessage } from '../utils/errorHandler';
import { formatAuditTimestamp } from '../utils/terminalDuesAudit';
import {
  calculateTerminalDuesBreakdown,
  isTerminalDuesValidationError,
  OutstandingSalaryEntryInput,
  NoticeStatus,
} from '../utils/terminalDuesEngine';
import { BreakdownPreview, CalculationInputsSnapshot } from './TerminalDuesCalculator';

interface RevisionRow {
  id: string;
  version: number;
  status: 'pending' | 'approved' | 'rejected';
  original_snapshot: { total_payable: number };
  proposed_total_payable: number;
  reason: string;
  rejection_reason: string | null;
  submitted_at: string;
  decided_at: string | null;
}

interface SeedSource {
  inputs: CalculationInputsSnapshot;
}

function emptyInputsFrom(entitlement: { date_joined: string; date_left: string; basic_salary: number }): CalculationInputsSnapshot {
  return {
    dateJoined: entitlement.date_joined,
    dateLeft: entitlement.date_left,
    finalSalary: entitlement.basic_salary,
    pensionMonthsOverride: null,
    pensionMonthsOverrideReason: '',
    unusedLeaveDays: 0,
    uniformDeductionMonths: 0,
    uniformDeductionPayrollEvidenceMonths: null,
    uniformDeductionCorrectionReason: '',
    outstandingSalaryEntries: [],
    noticeStatus: 'on_time',
    requiredNoticeDays: 26,
    lateNoticeDays: 0,
  };
}

export function EntitlementRevisionPanel({
  terminalDue,
  canPropose,
  canApprove,
}: {
  terminalDue: { id: string; status: string; total_payable: number; date_joined: string; date_left: string; basic_salary: number };
  canPropose: boolean;
  canApprove: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [seedSource, setSeedSource] = useState<SeedSource | null>(null);
  const [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [inputs, setInputs] = useState<CalculationInputsSnapshot | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: revRows, error: revErr }, { data: calcRows, error: calcErr }] = await Promise.all([
      supabase
        .from('terminal_due_revisions')
        .select('id, version, status, original_snapshot, proposed_inputs, proposed_total_payable, reason, rejection_reason, submitted_at, decided_at')
        .eq('terminal_due_id', terminalDue.id)
        .order('version', { ascending: false }),
      supabase
        .from('terminal_due_calculations')
        .select('inputs')
        .eq('submitted_terminal_due_id', terminalDue.id)
        .maybeSingle(),
    ]);
    if (revErr) console.error('Error fetching revisions:', revErr);
    if (calcErr) console.error('Error fetching linked calculation:', calcErr);

    const rows = (revRows as RevisionRow[]) || [];
    setRevisions(rows);

    // Seed from the most recent APPROVED revision's proposed inputs (so
    // revising-a-revision builds on the latest accepted state), falling
    // back to the original modern calculation's inputs.
    const latestApproved = rows.find(r => r.status === 'approved');
    if (latestApproved) {
      const { data: fullRow } = await supabase
        .from('terminal_due_revisions')
        .select('proposed_inputs')
        .eq('id', latestApproved.id)
        .maybeSingle();
      if (fullRow?.proposed_inputs) {
        setSeedSource({ inputs: fullRow.proposed_inputs as CalculationInputsSnapshot });
        setLoading(false);
        return;
      }
    }
    if (calcRows?.inputs) {
      setSeedSource({ inputs: calcRows.inputs as CalculationInputsSnapshot });
    } else {
      setSeedSource(null);
    }
    setLoading(false);
  }, [terminalDue.id]);

  useEffect(() => {
    load();
  }, [load]);

  const pendingRevision = revisions.find(r => r.status === 'pending');

  const breakdownResult = useMemo(() => {
    if (!inputs) return null;
    return calculateTerminalDuesBreakdown({
      dateJoined: inputs.dateJoined,
      dateLeft: inputs.dateLeft,
      finalSalary: inputs.finalSalary,
      pensionMonthsOverride: inputs.pensionMonthsOverride,
      unusedLeaveDays: inputs.unusedLeaveDays,
      uniformDeductionMonths: inputs.uniformDeductionMonths,
      outstandingSalaryEntries: inputs.outstandingSalaryEntries,
      noticeStatus: inputs.noticeStatus,
      requiredNoticeDays: inputs.requiredNoticeDays,
      lateNoticeDays: inputs.lateNoticeDays,
    });
  }, [inputs]);

  const openForm = () => {
    const seed = seedSource?.inputs || emptyInputsFrom(terminalDue);
    setInputs(seed);
    setReason('');
    setShowForm(true);
  };

  const addOutstandingEntry = () => {
    setInputs(prev => prev && { ...prev, outstandingSalaryEntries: [...prev.outstandingSalaryEntries, { month: '', amountOwed: 0, amountPaid: 0 }] });
  };
  const updateOutstandingEntry = (index: number, patch: Partial<OutstandingSalaryEntryInput>) => {
    setInputs(prev => prev && { ...prev, outstandingSalaryEntries: prev.outstandingSalaryEntries.map((e, i) => (i === index ? { ...e, ...patch } : e)) });
  };
  const removeOutstandingEntry = (index: number) => {
    setInputs(prev => prev && { ...prev, outstandingSalaryEntries: prev.outstandingSalaryEntries.filter((_, i) => i !== index) });
  };

  const submitRevision = async () => {
    if (!inputs || !breakdownResult) return;
    if (isTerminalDuesValidationError(breakdownResult)) {
      showNotification(breakdownResult.error, 'error');
      return;
    }
    if (!reason.trim()) {
      showNotification('A reason is required to propose a revision', 'error');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc('propose_terminal_due_revision', {
        p_terminal_due_id: terminalDue.id,
        p_inputs: inputs,
        p_breakdown: breakdownResult,
        p_total_payable: breakdownResult.totalPayable,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      showNotification('Revision proposed for Admin review -- unprocessed allocations are now on hold', 'success');
      setShowForm(false);
      await load();
    } catch (err) {
      showNotification('Error proposing revision: ' + getErrorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const approve = async () => {
    if (!pendingRevision) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('approve_terminal_due_revision', { p_id: pendingRevision.id });
      if (error) throw error;
      showNotification('Revision approved -- entitlement updated', 'success');
      await load();
    } catch (err) {
      showNotification('Error approving revision: ' + getErrorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirmReject = async () => {
    if (!pendingRevision) return;
    if (!rejectReason.trim()) {
      showNotification('A reason is required to reject a revision', 'error');
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc('reject_terminal_due_revision', { p_id: pendingRevision.id, p_reason: rejectReason.trim() });
      if (error) throw error;
      showNotification('Revision rejected -- entitlement unchanged', 'success');
      setRejectOpen(false);
      setRejectReason('');
      await load();
    } catch (err) {
      showNotification('Error rejecting revision: ' + getErrorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (terminalDue.status !== 'approved') return null;
  if (loading) return <p className="text-xs text-slate-400">Loading revision history...</p>;

  return (
    <div className="pt-3 border-t space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Entitlement Revisions</h4>
        {canPropose && !pendingRevision && seedSource && (
          <Button variant="outline" size="sm" onClick={openForm}>
            <Pencil size={14} className="mr-1" /> Request Revision
          </Button>
        )}
      </div>

      {canPropose && !seedSource && (
        <p className="text-xs text-slate-400">Revision is not available for a record created outside the modern Calculator workflow.</p>
      )}

      {pendingRevision && (
        <Card className="p-3 bg-amber-50 border-amber-200">
          <div className="flex items-center gap-2 mb-1">
            <Clock size={14} className="text-amber-600" />
            <span className="text-sm font-medium text-amber-800">Pending Admin review (v{pendingRevision.version})</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs text-slate-600 mb-2">
            <div><p className="text-slate-400">Current</p><p className="font-semibold">{formatKwacha(terminalDue.total_payable)}</p></div>
            <div><p className="text-slate-400">Proposed</p><p className="font-semibold">{formatKwacha(pendingRevision.proposed_total_payable)}</p></div>
            <div><p className="text-slate-400">Difference</p><p className="font-semibold">{formatKwacha(pendingRevision.proposed_total_payable - terminalDue.total_payable)}</p></div>
          </div>
          <p className="text-xs text-slate-600 mb-2">Reason: {pendingRevision.reason}</p>
          <p className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle size={12} /> All unprocessed allocations for this entitlement are on hold until this is decided.</p>
          {canApprove && (
            <div className="flex gap-2 mt-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={approve}>
                <CheckCircle size={14} className="mr-1" /> Approve Revision
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setRejectOpen(true)}>
                <XCircle size={14} className="mr-1" /> Reject
              </Button>
            </div>
          )}
        </Card>
      )}

      {revisions.length > 0 && (
        <div className="space-y-1">
          {revisions.map(r => (
            <div key={r.id} className="flex items-center justify-between text-xs border border-slate-100 rounded-lg p-2">
              <div>
                <span className="font-medium">v{r.version}</span>{' '}
                <span className="text-slate-400">{formatAuditTimestamp(r.submitted_at)}</span>{' '}
                {formatKwacha(r.original_snapshot?.total_payable)} &rarr; {formatKwacha(r.proposed_total_payable)}
                {r.status === 'rejected' && r.rejection_reason && <span className="text-red-600"> -- {r.rejection_reason}</span>}
              </div>
              <Badge color={r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'yellow'}>{r.status}</Badge>
            </div>
          ))}
        </div>
      )}

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Request Entitlement Revision" size="lg">
        {inputs && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Date Joined</label>
                <input type="date" value={inputs.dateJoined} onChange={e => setInputs(prev => prev && { ...prev, dateJoined: e.target.value })} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Date Left</label>
                <input type="date" value={inputs.dateLeft} onChange={e => setInputs(prev => prev && { ...prev, dateLeft: e.target.value })} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Final Monthly Salary (MWK)</label>
                <input type="number" value={inputs.finalSalary} onChange={e => setInputs(prev => prev && { ...prev, finalSalary: Number(e.target.value) || 0 })} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Unused Leave Days</label>
                <input type="number" value={inputs.unusedLeaveDays} onChange={e => setInputs(prev => prev && { ...prev, unusedLeaveDays: Number(e.target.value) || 0 })} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Uniform Deduction Months</label>
                <input type="number" value={inputs.uniformDeductionMonths} onChange={e => setInputs(prev => prev && { ...prev, uniformDeductionMonths: Number(e.target.value) || 0 })} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-medium text-slate-500">Outstanding Salary -- unpaid months</label>
                <Button variant="outline" size="sm" onClick={addOutstandingEntry}>
                  <Plus size={14} className="mr-1" /> Add Month
                </Button>
              </div>
              {inputs.outstandingSalaryEntries.map((entry, idx) => (
                <div key={idx} className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-2 items-center">
                  <input type="text" placeholder="Month (e.g. 2026-03)" value={entry.month} onChange={e => updateOutstandingEntry(idx, { month: e.target.value })} className="px-3 py-2 text-sm border border-slate-200 rounded-lg" />
                  <input type="number" placeholder="Amount owed" value={entry.amountOwed} onChange={e => updateOutstandingEntry(idx, { amountOwed: Number(e.target.value) || 0 })} className="px-3 py-2 text-sm border border-slate-200 rounded-lg" />
                  <input type="number" placeholder="Amount already paid" value={entry.amountPaid} onChange={e => updateOutstandingEntry(idx, { amountPaid: Number(e.target.value) || 0 })} className="px-3 py-2 text-sm border border-slate-200 rounded-lg" />
                  <Button variant="outline" size="sm" onClick={() => removeOutstandingEntry(idx)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Notice</label>
                <select value={inputs.noticeStatus} onChange={e => setInputs(prev => prev && { ...prev, noticeStatus: e.target.value as NoticeStatus })} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg">
                  <option value="on_time">Notice given on time</option>
                  <option value="late">Late notice</option>
                  <option value="none">No notice given</option>
                </select>
              </div>
              {inputs.noticeStatus === 'late' && (
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Late notice days</label>
                  <input type="number" value={inputs.lateNoticeDays ?? 0} onChange={e => setInputs(prev => prev && { ...prev, lateNoticeDays: Number(e.target.value) || 0 })} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
                </div>
              )}
            </div>

            {breakdownResult && (
              isTerminalDuesValidationError(breakdownResult) ? (
                <p className="text-sm text-red-600">{breakdownResult.error}</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-4 p-3 bg-slate-50 rounded-lg text-sm">
                    <div><p className="text-slate-400">Current Total Payable</p><p className="font-semibold">{formatKwacha(terminalDue.total_payable)}</p></div>
                    <div><p className="text-slate-400">Proposed Total Payable</p><p className="font-semibold text-[#081C3A]">{formatKwacha(breakdownResult.totalPayable)}</p></div>
                  </div>
                  <BreakdownPreview breakdown={breakdownResult} />
                </>
              )
            )}

            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Reason for revision *</label>
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" placeholder="Why is this correction needed?" />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button onClick={submitRevision} disabled={saving}>
                <Send size={14} className="mr-1" /> Submit for Admin Review
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={rejectOpen} onClose={() => setRejectOpen(false)} title="Reject Revision">
        <div className="space-y-3">
          <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" placeholder="Reason for rejection..." />
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button onClick={confirmReject} disabled={busy}>Reject</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
