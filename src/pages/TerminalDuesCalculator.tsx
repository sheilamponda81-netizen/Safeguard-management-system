// Terminal Dues Modernization -- Phase 1/1.5: the new Calculator and
// Submitted tabs for the Terminal Dues page. The draft workbench
// (`historical_employees`, `terminal_due_calculations`) is isolated from
// the existing pending/approved/paid `terminal_dues` workflow, but a
// submitted calculation is promoted into it via submit_terminal_due_calculation()
// -- see that function's migration comment for why. This file never
// marks a case financially settled itself; the Submitted tab always
// shows the linked terminal_dues row's own live status.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Search, Save, CheckCircle, RotateCcw, ChevronDown, ChevronUp, Trash2, AlertTriangle, X } from '../utils/icons';
import { Card, Button, Badge, EmptyState, Modal } from '../components/ui';
import { formatKwacha } from '../data';
import { supabase } from '../lib/supabase';
import { showNotification } from '../utils/clickHandlers';
import { getErrorMessage } from '../utils/errorHandler';
import {
  calculateTerminalDuesBreakdown,
  isTerminalDuesValidationError,
  uniformRefundNeedsCorrectionReason,
  pensionMonthsOverrideNeedsCorrectionReason,
  findOutstandingSalaryDoubleCountWarnings,
  DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH,
  TerminalDuesBreakdown,
  OutstandingSalaryEntryInput,
  NoticeStatus,
} from '../utils/terminalDuesEngine';

// `terminal_dues_uniform_refund_rate` is an Admin-only system setting (same
// RLS as `current_payroll_month`/`uniform_deduction_default` -- INSERT/
// UPDATE restricted to Admins, SELECT open to the tenant). Read-only here;
// this page never writes it. Falls back to the current flat rate when no
// Admin has set it yet, so behaviour is unchanged until that setting exists.
async function fetchUniformRefundRate(): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'terminal_dues_uniform_refund_rate')
      .maybeSingle();
    if (error || !data) return DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH;
    const parsed = Number(data.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH;
  } catch {
    // Read-only, best-effort -- never block the Calculator on this lookup.
    return DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH;
  }
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface ExistingEmployeeOption {
  id: string;
  employeeNumber: string;
  fullName: string;
  position: string;
  basicSalary: number;
  hire_date: string;
  region_id: string;
  uniform_deduction?: number | null;
}

interface HistoricalEmployee {
  id: string;
  full_name: string;
  historical_reference: string | null;
  date_joined: string;
  date_left: string;
  reason_for_leaving: string;
  termination_type: string | null;
  final_salary: number;
  pay_point: string | null;
  account_number: string | null;
}

interface CalculationRow {
  id: string;
  employee_id: string | null;
  historical_employee_id: string | null;
  region_id: string | null;
  subject_name: string;
  subject_number: string | null;
  position: string | null;
  // 'submitted' means HR has locked this calculation and promoted it into
  // the existing terminal_dues approval workflow (see
  // submitted_terminal_due_id) -- it is NOT financial settlement. Whether
  // it has actually been paid is tracked exclusively by that linked row's
  // own status, fetched separately for display (see SubmittedRow below).
  status: 'draft' | 'submitted';
  calculation_version: number;
  inputs: CalculationInputsSnapshot;
  breakdown: TerminalDuesBreakdown;
  total_payable: number;
  revision_history: unknown[];
  submitted_terminal_due_id: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalculationInputsSnapshot {
  dateJoined: string;
  dateLeft: string;
  finalSalary: number;
  pensionMonthsOverride?: number | null;
  pensionMonthsOverrideReason?: string | null;
  unusedLeaveDays: number;
  uniformDeductionMonths: number;
  uniformDeductionPayrollEvidenceMonths: number | null;
  uniformDeductionCorrectionReason?: string | null;
  /** The CURRENT approved uniform refund rate actually used to compute this
   * snapshot's saved breakdown (see Row label=Uniform Refund). Populated at
   * save time from the live `terminal_dues_uniform_refund_rate` system
   * setting -- never a stale or client-chosen value; the backend re-checks
   * it against that same setting on every save/submit (see
   * 20261105000000_terminal_dues_calculator_safety_enforcement.sql). This is
   * what makes the applied rate auditable from the saved record alone. */
  uniformRefundRatePerMonth?: number;
  outstandingSalaryEntries: OutstandingSalaryEntryInput[];
  noticeStatus: NoticeStatus;
  requiredNoticeDays: number;
  lateNoticeDays?: number;
}

const terminationTypes = [
  { value: 'disciplinary', label: 'Disciplinary Hearing' },
  { value: 'redundancy', label: 'Redundancy / Retrenchment' },
  { value: 'resignation', label: 'Resignation' },
  { value: 'retirement', label: 'Retirement' },
  { value: 'medical', label: 'Medical Grounds' },
  { value: 'end_of_contract', label: 'End of Contract' },
];

function emptyInputs(): CalculationInputsSnapshot {
  return {
    dateJoined: '',
    dateLeft: new Date().toISOString().split('T')[0],
    finalSalary: 0,
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

// ---------------------------------------------------------------------------
// Calculator tab
// ---------------------------------------------------------------------------

export function TerminalDuesCalculatorTab({
  employees,
  canCreate,
  canEdit,
}: {
  employees: ExistingEmployeeOption[];
  canCreate: boolean;
  canEdit: boolean;
}) {
  const [historicalEmployees, setHistoricalEmployees] = useState<HistoricalEmployee[]>([]);
  const [drafts, setDrafts] = useState<CalculationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [subjectMode, setSubjectMode] = useState<'existing' | 'historical'>('existing');
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<ExistingEmployeeOption | null>(null);
  const [selectedHistorical, setSelectedHistorical] = useState<HistoricalEmployee | null>(null);
  const [showAddHistorical, setShowAddHistorical] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [inputs, setInputs] = useState<CalculationInputsSnapshot>(emptyInputs);
  const [reasonForLeaving, setReasonForLeaving] = useState('');
  const [terminationType, setTerminationType] = useState('resignation');
  const [saving, setSaving] = useState(false);

  // The CURRENT approved uniform refund rate -- fetched once per visit to
  // this tab, never refetched mid-edit, so a rate change made by an Admin
  // while this page is open never silently alters the live preview under
  // HR's hands. Only ever read here; see fetchUniformRefundRate() above.
  const [uniformRefundRate, setUniformRefundRate] = useState(DEFAULT_UNIFORM_REFUND_RATE_PER_MONTH);
  useEffect(() => {
    fetchUniformRefundRate().then(setUniformRefundRate);
  }, []);

  const canUse = canCreate || canEdit;

  const fetchHistoricalEmployees = useCallback(async () => {
    const { data, error } = await supabase.from('historical_employees').select('*').order('full_name');
    if (error) {
      console.error('Error fetching historical employees:', error);
      return;
    }
    setHistoricalEmployees(data || []);
  }, []);

  const fetchDrafts = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('terminal_due_calculations')
      .select('*')
      .eq('status', 'draft')
      .order('updated_at', { ascending: false });
    if (error) {
      console.error('Error fetching draft calculations:', error);
      showNotification('Failed to load draft calculations', 'error');
    } else {
      setDrafts((data as CalculationRow[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchHistoricalEmployees();
    fetchDrafts();
  }, [fetchHistoricalEmployees, fetchDrafts]);

  const filteredEmployees = useMemo(() => {
    if (!employeeSearch.trim()) return [];
    const q = employeeSearch.toLowerCase().trim();
    return employees
      .filter(e => e.fullName.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q))
      .slice(0, 20);
  }, [employeeSearch, employees]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setSubjectMode('existing');
    setSelectedEmployee(null);
    setSelectedHistorical(null);
    setEmployeeSearch('');
    setInputs(emptyInputs());
    setReasonForLeaving('');
    setTerminationType('resignation');
  }, []);

  // ===== Pick an existing employee: pull in dates/salary, fetch uniform
  // deduction evidence from payroll (read-only), and surface any months
  // already recorded as paid in payment_status (double-count warning). =====
  const selectExistingEmployee = useCallback(async (emp: ExistingEmployeeOption) => {
    setSelectedEmployee(emp);
    setSelectedHistorical(null);
    setEmployeeSearch(emp.fullName);

    let evidenceMonths: number | null = null;
    try {
      const { data, error } = await supabase
        .from('payroll')
        .select('uniform_deduction')
        .eq('employee_id', emp.id)
        .gt('uniform_deduction', 0);
      if (!error) evidenceMonths = (data || []).length;
    } catch {
      // Read-only, best-effort -- a failed lookup just means HR enters the count manually.
    }

    setInputs({
      ...emptyInputs(),
      dateJoined: emp.hire_date,
      finalSalary: emp.basicSalary,
      uniformDeductionMonths: evidenceMonths ?? 0,
      uniformDeductionPayrollEvidenceMonths: evidenceMonths,
    });
  }, []);

  const selectHistoricalEmployee = useCallback((he: HistoricalEmployee) => {
    setSelectedHistorical(he);
    setSelectedEmployee(null);
    setInputs({
      ...emptyInputs(),
      dateJoined: he.date_joined,
      dateLeft: he.date_left,
      finalSalary: he.final_salary,
      uniformDeductionMonths: 0,
      uniformDeductionPayrollEvidenceMonths: null, // no payroll trail for a historical subject
    });
    setReasonForLeaving(he.reason_for_leaving);
    setTerminationType(he.termination_type || 'resignation');
  }, []);

  // ===== Live breakdown preview (pure, client-side -- no round trip needed to see the numbers) =====
  const breakdownResult = useMemo(
    () =>
      calculateTerminalDuesBreakdown({
        dateJoined: inputs.dateJoined,
        dateLeft: inputs.dateLeft,
        finalSalary: inputs.finalSalary,
        pensionMonthsOverride: inputs.pensionMonthsOverride,
        unusedLeaveDays: inputs.unusedLeaveDays,
        uniformDeductionMonths: inputs.uniformDeductionMonths,
        uniformRefundRatePerMonth: uniformRefundRate,
        outstandingSalaryEntries: inputs.outstandingSalaryEntries,
        noticeStatus: inputs.noticeStatus,
        requiredNoticeDays: inputs.requiredNoticeDays,
        lateNoticeDays: inputs.lateNoticeDays,
      }),
    [inputs, uniformRefundRate]
  );

  const uniformNeedsReason = uniformRefundNeedsCorrectionReason(
    inputs.uniformDeductionPayrollEvidenceMonths,
    inputs.uniformDeductionMonths
  );
  const pensionNeedsReason =
    !isTerminalDuesValidationError(breakdownResult) &&
    pensionMonthsOverrideNeedsCorrectionReason(breakdownResult.completedMonths, inputs.pensionMonthsOverride);

  const [doubleCountWarnings, setDoubleCountWarnings] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const subjectEmployeeId = selectedEmployee?.id;
      if (!subjectEmployeeId || inputs.outstandingSalaryEntries.length === 0) {
        setDoubleCountWarnings([]);
        return;
      }
      const { data } = await supabase
        .from('payment_status')
        .select('month, status')
        .eq('employee_id', subjectEmployeeId)
        .in('status', ['paid', 'confirmed']);
      if (cancelled) return;
      const settledMonths = (data || []).map((r: { month: string }) => String(r.month).slice(0, 7));
      setDoubleCountWarnings(findOutstandingSalaryDoubleCountWarnings(inputs.outstandingSalaryEntries, settledMonths));
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedEmployee, inputs.outstandingSalaryEntries]);

  const addOutstandingEntry = () => {
    setInputs(prev => ({
      ...prev,
      outstandingSalaryEntries: [...prev.outstandingSalaryEntries, { month: '', amountOwed: 0, amountPaid: 0 }],
    }));
  };
  const updateOutstandingEntry = (index: number, patch: Partial<OutstandingSalaryEntryInput>) => {
    setInputs(prev => ({
      ...prev,
      outstandingSalaryEntries: prev.outstandingSalaryEntries.map((e, i) => (i === index ? { ...e, ...patch } : e)),
    }));
  };
  const removeOutstandingEntry = (index: number) => {
    setInputs(prev => ({ ...prev, outstandingSalaryEntries: prev.outstandingSalaryEntries.filter((_, i) => i !== index) }));
  };

  const loadDraftForEditing = (row: CalculationRow) => {
    setEditingId(row.id);
    setInputs(row.inputs);
    if (row.employee_id) {
      const emp = employees.find(e => e.id === row.employee_id) || null;
      setSubjectMode('existing');
      setSelectedEmployee(emp);
      setSelectedHistorical(null);
      setEmployeeSearch(row.subject_name);
    } else {
      const he = historicalEmployees.find(h => h.id === row.historical_employee_id) || null;
      setSubjectMode('historical');
      setSelectedHistorical(he);
      setSelectedEmployee(null);
    }
  };

  const saveDraft = async () => {
    if (isTerminalDuesValidationError(breakdownResult)) {
      showNotification(breakdownResult.error, 'error');
      return;
    }
    if (subjectMode === 'existing' && !selectedEmployee) {
      showNotification('Select an existing employee', 'error');
      return;
    }
    if (subjectMode === 'historical' && !selectedHistorical) {
      showNotification('Select or add a historical employee', 'error');
      return;
    }
    if (uniformNeedsReason && !inputs.uniformDeductionCorrectionReason?.trim()) {
      showNotification('A correction reason is required: the entered uniform-deduction months differ from payroll evidence', 'error');
      return;
    }
    if (pensionNeedsReason && !inputs.pensionMonthsOverrideReason?.trim()) {
      showNotification('A correction reason is required: the entered completed months differ from the system calculation', 'error');
      return;
    }

    // Save-time consistency check: re-fetch the live rate right before
    // saving so a change made by an Admin while this form was open (a
    // stale tab) is never silently baked into a saved calculation. The
    // backend enforces this same check independently, but failing here
    // gives HR a clear, immediate message instead of an RPC error.
    const latestRate = await fetchUniformRefundRate();
    if (latestRate !== uniformRefundRate) {
      setUniformRefundRate(latestRate);
      showNotification('The uniform refund rate has changed since this form was opened. Review the updated calculation, then save again.', 'error');
      return;
    }

    setSaving(true);
    try {
      const subjectName = subjectMode === 'existing' ? selectedEmployee!.fullName : selectedHistorical!.full_name;
      const subjectNumber = subjectMode === 'existing' ? selectedEmployee!.employeeNumber : selectedHistorical!.historical_reference;
      const position = subjectMode === 'existing' ? selectedEmployee!.position : null;
      // The rate actually used to compute breakdownResult (see the
      // breakdownResult useMemo above) is recorded alongside the inputs it
      // was applied to, so the saved record is self-auditing.
      const inputsToSave: CalculationInputsSnapshot = { ...inputs, uniformRefundRatePerMonth: uniformRefundRate };

      if (editingId) {
        const { error } = await supabase.rpc('update_terminal_due_calculation_draft', {
          p_id: editingId,
          p_subject_name: subjectName,
          p_subject_number: subjectNumber,
          p_position: position,
          p_inputs: inputsToSave,
          p_breakdown: breakdownResult,
          p_total_payable: breakdownResult.totalPayable,
        });
        if (error) throw error;
        showNotification('Draft calculation updated', 'success');
      } else {
        const { error } = await supabase.from('terminal_due_calculations').insert([
          {
            employee_id: subjectMode === 'existing' ? selectedEmployee!.id : null,
            historical_employee_id: subjectMode === 'historical' ? selectedHistorical!.id : null,
            region_id: subjectMode === 'existing' ? selectedEmployee!.region_id : null,
            subject_name: subjectName,
            subject_number: subjectNumber,
            position,
            inputs: inputsToSave,
            breakdown: breakdownResult,
            total_payable: breakdownResult.totalPayable,
          },
        ]);
        if (error) throw error;
        showNotification('Draft calculation saved', 'success');
      }
      resetForm();
      await fetchDrafts();
    } catch (err) {
      showNotification('Error saving draft: ' + getErrorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  // Submits the draft for Admin approval -- this promotes it into the
  // existing, hardened terminal_dues pending/approved/paid workflow
  // (see submit_terminal_due_calculation()'s migration comment). It is
  // NOT financial settlement: HR has no action anywhere that marks a
  // case paid.
  const submitDraft = async (id: string) => {
    const { error } = await supabase.rpc('submit_terminal_due_calculation', { p_id: id });
    if (error) {
      showNotification('Error submitting calculation: ' + getErrorMessage(error), 'error');
      return;
    }
    showNotification('Calculation submitted for Admin approval', 'success');
    await fetchDrafts();
  };

  if (!canUse) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="No access"
        description="You do not have permission to use the Terminal Dues calculator."
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setSubjectMode('existing'); setSelectedHistorical(null); }}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg ${subjectMode === 'existing' ? 'bg-[#081C3A] text-white' : 'bg-slate-100 text-slate-600'}`}
          >
            Existing Employee
          </button>
          <button
            onClick={() => { setSubjectMode('historical'); setSelectedEmployee(null); setEmployeeSearch(''); }}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg ${subjectMode === 'historical' ? 'bg-[#081C3A] text-white' : 'bg-slate-100 text-slate-600'}`}
          >
            Historical Employee
          </button>
        </div>

        {subjectMode === 'existing' ? (
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={employeeSearch}
              onChange={e => { setEmployeeSearch(e.target.value); setSelectedEmployee(null); }}
              placeholder="Search employee by name or number..."
              className="w-full pl-10 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
            {filteredEmployees.length > 0 && !selectedEmployee && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {filteredEmployees.map(emp => (
                  <button
                    key={emp.id}
                    onClick={() => selectExistingEmployee(emp)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-0"
                  >
                    <span className="font-medium">{emp.fullName}</span>{' '}
                    <span className="text-slate-400">({emp.employeeNumber})</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={selectedHistorical?.id || ''}
              onChange={e => {
                const he = historicalEmployees.find(h => h.id === e.target.value);
                if (he) selectHistoricalEmployee(he);
              }}
              className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            >
              <option value="">Select a historical employee...</option>
              {historicalEmployees.map(he => (
                <option key={he.id} value={he.id}>
                  {he.full_name} {he.historical_reference ? `(${he.historical_reference})` : ''}
                </option>
              ))}
            </select>
            {canCreate && (
              <Button variant="secondary" onClick={() => setShowAddHistorical(true)}>
                <Plus size={16} className="mr-1" /> Add Historical Employee
              </Button>
            )}
          </div>
        )}

        {(selectedEmployee || selectedHistorical) && (
          <div className="pt-4 border-t space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Date Joined</label>
                <input
                  type="date"
                  value={inputs.dateJoined}
                  onChange={e => setInputs(prev => ({ ...prev, dateJoined: e.target.value }))}
                  disabled={subjectMode === 'existing'}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Date Left</label>
                <input
                  type="date"
                  value={inputs.dateLeft}
                  onChange={e => setInputs(prev => ({ ...prev, dateLeft: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Final Monthly Salary (MWK)</label>
                <input
                  type="number"
                  value={inputs.finalSalary}
                  onChange={e => setInputs(prev => ({ ...prev, finalSalary: Number(e.target.value) || 0 }))}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">
                  Completed Months (system: {isTerminalDuesValidationError(breakdownResult) ? '--' : breakdownResult.completedMonths})
                </label>
                <input
                  type="number"
                  placeholder="Leave blank to use system count"
                  value={inputs.pensionMonthsOverride ?? ''}
                  onChange={e => setInputs(prev => ({ ...prev, pensionMonthsOverride: e.target.value === '' ? null : Number(e.target.value) }))}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              {pensionNeedsReason && (
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Reason for correction (required -- disagrees with system-calculated months) *</label>
                  <input
                    type="text"
                    value={inputs.pensionMonthsOverrideReason || ''}
                    onChange={e => setInputs(prev => ({ ...prev, pensionMonthsOverrideReason: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Unused Leave Days</label>
                <input
                  type="number"
                  value={inputs.unusedLeaveDays}
                  onChange={e => setInputs(prev => ({ ...prev, unusedLeaveDays: Number(e.target.value) || 0 }))}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">
                  Uniform Deduction Months
                  {inputs.uniformDeductionPayrollEvidenceMonths != null && (
                    <span className="text-slate-400"> (payroll evidence: {inputs.uniformDeductionPayrollEvidenceMonths})</span>
                  )}
                </label>
                <p className="text-xs font-medium text-slate-600 mb-1">
                  Current uniform refund rate: {formatKwacha(uniformRefundRate)} / month
                </p>
                <input
                  type="number"
                  value={inputs.uniformDeductionMonths}
                  onChange={e => setInputs(prev => ({ ...prev, uniformDeductionMonths: Number(e.target.value) || 0 }))}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              {uniformNeedsReason && (
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-500 mb-1">Correction reason (required -- disagrees with payroll evidence) *</label>
                  <input
                    type="text"
                    value={inputs.uniformDeductionCorrectionReason || ''}
                    onChange={e => setInputs(prev => ({ ...prev, uniformDeductionCorrectionReason: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-medium text-slate-500">Outstanding Salary -- unpaid months</label>
                <Button variant="outline" size="sm" onClick={addOutstandingEntry}>
                  <Plus size={14} className="mr-1" /> Add Month
                </Button>
              </div>
              {inputs.outstandingSalaryEntries.map((entry, idx) => (
                <div key={idx} className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-2 items-end">
                  <div>
                    <label className="block text-xs text-slate-400 mb-0.5">Month</label>
                    <input
                      type="text"
                      placeholder="e.g. 2026-03"
                      value={entry.month}
                      onChange={e => updateOutstandingEntry(idx, { month: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-0.5">Amount Owed</label>
                    <input
                      type="number"
                      value={entry.amountOwed}
                      onChange={e => updateOutstandingEntry(idx, { amountOwed: Number(e.target.value) || 0 })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-0.5">Amount Already Paid (reduces this month's outstanding amount)</label>
                    <input
                      type="number"
                      value={entry.amountPaid}
                      onChange={e => updateOutstandingEntry(idx, { amountPaid: Number(e.target.value) || 0 })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    />
                  </div>
                  <Button variant="outline" size="sm" onClick={() => removeOutstandingEntry(idx)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
              {doubleCountWarnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-600 flex items-center gap-1"><AlertTriangle size={12} /> {w}</p>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Notice (company policy: 26 working days)</label>
                <select
                  value={inputs.noticeStatus}
                  onChange={e => setInputs(prev => ({ ...prev, noticeStatus: e.target.value as NoticeStatus }))}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                >
                  <option value="on_time">Notice given on time</option>
                  <option value="late">Late notice</option>
                  <option value="none">No notice given</option>
                </select>
              </div>
              {inputs.noticeStatus === 'late' && (
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Late notice days (verified)</label>
                  <input
                    type="number"
                    value={inputs.lateNoticeDays ?? 0}
                    onChange={e => setInputs(prev => ({ ...prev, lateNoticeDays: Number(e.target.value) || 0 }))}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                </div>
              )}
            </div>

            {isTerminalDuesValidationError(breakdownResult) ? (
              <p className="text-sm text-red-600">{breakdownResult.error}</p>
            ) : (
              <BreakdownPreview breakdown={breakdownResult} />
            )}

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button variant="outline" onClick={resetForm}>Cancel</Button>
              <Button onClick={saveDraft} disabled={saving}>
                <Save size={14} className="mr-1" /> {editingId ? 'Update Draft' : 'Save Draft'}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Draft Calculations</h3>
        {loading ? (
          <p className="text-sm text-slate-400">Loading...</p>
        ) : drafts.length === 0 ? (
          <EmptyState title="No draft calculations" description="New calculations appear here before being submitted for Admin approval." />
        ) : (
          <div className="space-y-2">
            {drafts.map(row => (
              <div key={row.id} className="border border-slate-200 rounded-lg">
                <div className="flex items-center justify-between p-3">
                  <button onClick={() => setExpandedId(expandedId === row.id ? null : row.id)} className="flex items-center gap-2 text-left flex-1">
                    {expandedId === row.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    <span className="font-medium text-sm">{row.subject_name}</span>
                    {row.subject_number && <span className="text-xs text-slate-400">({row.subject_number})</span>}
                    <Badge color="gray">v{row.calculation_version}</Badge>
                  </button>
                  <span className="font-semibold text-sm text-[#081C3A] mr-3">{formatKwacha(row.total_payable)}</span>
                  {canEdit && (
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => loadDraftForEditing(row)}>Edit</Button>
                      <Button variant="secondary" size="sm" onClick={() => submitDraft(row.id)}>
                        <CheckCircle size={14} className="mr-1" /> Submit for Approval
                      </Button>
                    </div>
                  )}
                </div>
                {expandedId === row.id && (
                  <div className="p-3 border-t border-slate-100">
                    <BreakdownPreview breakdown={row.breakdown} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <AddHistoricalEmployeeModal
        open={showAddHistorical}
        onClose={() => setShowAddHistorical(false)}
        onCreated={async he => {
          await fetchHistoricalEmployees();
          setSubjectMode('historical');
          selectHistoricalEmployee(he);
          setShowAddHistorical(false);
        }}
        defaultTerminationType={terminationType}
        defaultReason={reasonForLeaving}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Submitted tab -- calculations promoted into the existing terminal_dues
// approval workflow. Shows that linked row's OWN live status
// (pending/approved/paid), never a self-reported "Settled" label, so this
// view can never show an unpaid case as though it were financially done.
// ---------------------------------------------------------------------------

interface SubmittedRow extends CalculationRow {
  terminal_dues: { status: 'pending' | 'approved' | 'paid' } | null;
}

function linkedStatusBadgeColor(status: string | undefined): 'gray' | 'yellow' | 'green' | 'blue' {
  if (status === 'paid') return 'green';
  if (status === 'approved') return 'blue';
  if (status === 'pending') return 'yellow';
  return 'gray';
}

export function TerminalDuesSubmittedTab({ canEdit }: { canEdit: boolean }) {
  const [submitted, setSubmitted] = useState<SubmittedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchSubmitted = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('terminal_due_calculations')
      .select('*, terminal_dues:submitted_terminal_due_id(status)')
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: false });
    if (error) {
      console.error('Error fetching submitted calculations:', error);
    } else {
      setSubmitted((data as SubmittedRow[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSubmitted();
  }, [fetchSubmitted]);

  const reopen = async (id: string) => {
    const { error } = await supabase.rpc('reopen_terminal_due_calculation', { p_id: id });
    if (error) {
      showNotification('Error reopening calculation: ' + getErrorMessage(error), 'error');
      return;
    }
    showNotification('Calculation reopened as a draft', 'success');
    await fetchSubmitted();
  };

  if (loading) return <p className="text-sm text-slate-400">Loading...</p>;

  if (submitted.length === 0) {
    return (
      <EmptyState
        title="No submitted calculations yet"
        description="A draft calculation submitted for Admin approval from the Calculator tab appears here, showing its real status in the existing Terminal Dues approval workflow -- this is never a payment record itself."
      />
    );
  }

  return (
    <div className="space-y-2">
      {submitted.map(row => (
        <Card key={row.id} className="p-0">
          <div className="flex items-center justify-between p-3">
            <button onClick={() => setExpandedId(expandedId === row.id ? null : row.id)} className="flex items-center gap-2 text-left flex-1">
              {expandedId === row.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              <span className="font-medium text-sm">{row.subject_name}</span>
              {row.subject_number && <span className="text-xs text-slate-400">({row.subject_number})</span>}
              <Badge color={linkedStatusBadgeColor(row.terminal_dues?.status)}>
                {row.terminal_dues?.status ? `Records: ${row.terminal_dues.status}` : 'Status unavailable'}
              </Badge>
            </button>
            <span className="font-semibold text-sm text-[#081C3A] mr-3">{formatKwacha(row.total_payable)}</span>
            {canEdit && row.terminal_dues?.status === 'pending' && (
              <Button variant="outline" size="sm" onClick={() => reopen(row.id)}>
                <RotateCcw size={14} className="mr-1" /> Reopen
              </Button>
            )}
          </div>
          {expandedId === row.id && (
            <div className="p-3 border-t border-slate-100">
              <BreakdownPreview breakdown={row.breakdown} />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared breakdown preview
// ---------------------------------------------------------------------------

export function BreakdownPreview({ breakdown }: { breakdown: TerminalDuesBreakdown }) {
  return (
    <div className="space-y-2 text-sm">
      <Row label={`Pension Arrears (${breakdown.effectiveMonths} months x 10%)`} value={breakdown.pensionArrears} />
      <Row label="Annual Leave Refund" value={breakdown.annualLeaveRefund} />
      <Row label="Uniform Refund" value={breakdown.uniformRefund} />
      <Row label="Outstanding Salary" value={breakdown.outstandingSalaryTotal} />
      <div className="flex justify-between font-medium border-t pt-2">
        <span>Total Entitlements</span>
        <span>{formatKwacha(breakdown.totalEntitlements)}</span>
      </div>
      <Row label="Less Notice Deduction" value={-breakdown.lessNoticeDeduction} />
      <div className="flex justify-between font-bold text-[#081C3A] border-t pt-2">
        <span>Total Payable</span>
        <span>{formatKwacha(breakdown.totalPayable)}</span>
      </div>
      {breakdown.excessDeduction > 0 && (
        <p className="text-xs text-amber-600 flex items-center gap-1">
          <AlertTriangle size={12} /> Deductions exceed entitlements by {formatKwacha(breakdown.excessDeduction)} -- preserved for review, not treated as employee debt.
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-slate-600">
      <span>{label}</span>
      <span>{formatKwacha(value)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Historical Employee modal
// ---------------------------------------------------------------------------

function AddHistoricalEmployeeModal({
  open,
  onClose,
  onCreated,
  defaultTerminationType,
  defaultReason,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (he: HistoricalEmployee) => void;
  defaultTerminationType: string;
  defaultReason: string;
}) {
  const [form, setForm] = useState({
    full_name: '',
    historical_reference: '',
    date_joined: '',
    date_left: '',
    reason_for_leaving: defaultReason,
    termination_type: defaultTerminationType,
    position: '',
    final_salary: 0,
    pay_point: '',
    account_number: '',
  });
  const [suggestedSalary, setSuggestedSalary] = useState<number | null>(null);
  const [confirmedSalary, setConfirmedSalary] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(f => ({ ...f, reason_for_leaving: defaultReason, termination_type: defaultTerminationType }));
  }, [open, defaultReason, defaultTerminationType]);

  const lookupSuggestedSalary = async (position: string) => {
    if (!position.trim()) {
      setSuggestedSalary(null);
      return;
    }
    const { data } = await supabase.from('positions').select('default_salary').ilike('name', position.trim()).maybeSingle();
    setSuggestedSalary(data?.default_salary ?? null);
    setConfirmedSalary(false);
  };

  const applySuggestedSalary = () => {
    if (suggestedSalary == null) return;
    setForm(f => ({ ...f, final_salary: suggestedSalary }));
    setConfirmedSalary(true);
  };

  const save = async () => {
    if (!form.full_name.trim() || !form.date_joined || !form.date_left || !form.reason_for_leaving.trim()) {
      showNotification('Name, dates joined/left, and reason for leaving are required', 'error');
      return;
    }
    if (!(form.final_salary > 0)) {
      showNotification('Final salary must be confirmed and greater than zero', 'error');
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from('historical_employees')
        .insert([
          {
            full_name: form.full_name.trim(),
            historical_reference: form.historical_reference.trim() || null,
            date_joined: form.date_joined,
            date_left: form.date_left,
            reason_for_leaving: form.reason_for_leaving.trim(),
            termination_type: form.termination_type,
            final_salary: form.final_salary,
            pay_point: form.pay_point.trim() || null,
            account_number: form.account_number.trim() || null,
          },
        ])
        .select()
        .single();
      if (error) throw error;
      showNotification('Historical employee added', 'success');
      onCreated(data as HistoricalEmployee);
    } catch (err) {
      showNotification('Error adding historical employee: ' + getErrorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add Historical Employee">
      <div className="space-y-3">
        <Field label="Full Name *">
          <input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
        </Field>
        <Field label="Historical Reference">
          <input value={form.historical_reference} onChange={e => setForm(f => ({ ...f, historical_reference: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date Joined *">
            <input type="date" value={form.date_joined} onChange={e => setForm(f => ({ ...f, date_joined: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
          </Field>
          <Field label="Date Left *">
            <input type="date" value={form.date_left} onChange={e => setForm(f => ({ ...f, date_left: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
          </Field>
        </div>
        <Field label="Reason for Leaving *">
          <input value={form.reason_for_leaving} onChange={e => setForm(f => ({ ...f, reason_for_leaving: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
        </Field>
        <Field label="Termination Type">
          <select value={form.termination_type} onChange={e => setForm(f => ({ ...f, termination_type: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg">
            {terminationTypes.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Position">
          <input
            value={form.position}
            onChange={e => setForm(f => ({ ...f, position: e.target.value }))}
            onBlur={e => lookupSuggestedSalary(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
          />
        </Field>
        <Field label="Final Salary (MWK) *">
          <div className="flex gap-2">
            <input
              type="number"
              value={form.final_salary}
              onChange={e => { setForm(f => ({ ...f, final_salary: Number(e.target.value) || 0 })); setConfirmedSalary(false); }}
              className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
            {suggestedSalary != null && !confirmedSalary && (
              <Button variant="outline" size="sm" onClick={applySuggestedSalary}>
                Use suggested {formatKwacha(suggestedSalary)}
              </Button>
            )}
          </div>
          {suggestedSalary != null && (
            <p className="text-xs text-slate-400 mt-1">
              Configured standard salary for this position: {formatKwacha(suggestedSalary)}. Confirm or edit before saving.
            </p>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pay Point">
            <input value={form.pay_point} onChange={e => setForm(f => ({ ...f, pay_point: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
          </Field>
          <Field label="Account Number">
            <input value={form.account_number} onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg" />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t">
          <Button variant="outline" onClick={onClose}><X size={14} className="mr-1" /> Cancel</Button>
          <Button onClick={save} disabled={saving}><Save size={14} className="mr-1" /> Save</Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
      {children}
    </div>
  );
}
