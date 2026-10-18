// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage C, Step 4.
//
// Classifies attendance_preview_calculate's read-only results into what
// attendance_apply_automatic would actually do with them, WITHOUT
// writing anything -- and, once an operator has reviewed and explicitly
// confirmed, applies ONLY the rows classified 'eligible', one RPC call
// per (employeeId, date) pair. Both RPCs already exist (Stage C Step 1
// and Step 3); this file duplicates no calculation rule -- it reads
// their outputs and this round's OWN additional restriction (confirmed
// Present/Late only, never Absent, this round) on top.
import { supabase } from '../lib/supabase';

export type AutomaticEligibility =
  | 'eligible'
  | 'skipped_not_confirmed_present_late'
  | 'protected_manual'
  | 'protected_payroll_approved';

export interface EligibilityInput {
  employeeId: string;
  date: string;
  status: string;
  calculationBasis: string | null;
}

export interface ExistingAttendanceAndPayroll {
  attendanceByDate: Map<string, { status: string; source: string }>;
  payrollApprovedByMonth: Map<string, boolean>;
}

/** Read-only: the employee's own existing attendance rows in range (to detect manual protection) and existing payroll rows across all months (to detect the approved-payroll block). Never written to. */
export async function fetchExistingAttendanceAndPayroll(
  employeeId: string,
  dateFrom: string,
  dateTo: string
): Promise<ExistingAttendanceAndPayroll> {
  const [attendanceRes, payrollRes] = await Promise.all([
    supabase.from('attendance').select('date, status, source').eq('employee_id', employeeId).gte('date', dateFrom).lte('date', dateTo),
    supabase.from('payroll').select('month, approval_status').eq('employee_id', employeeId),
  ]);
  if (attendanceRes.error) throw attendanceRes.error;
  if (payrollRes.error) throw payrollRes.error;

  const attendanceByDate = new Map<string, { status: string; source: string }>();
  (attendanceRes.data || []).forEach((r: { date: string; status: string; source: string }) => attendanceByDate.set(r.date, { status: r.status, source: r.source }));

  const payrollApprovedByMonth = new Map<string, boolean>();
  (payrollRes.data || []).forEach((r: { month: string; approval_status: string | null }) => {
    if (r.approval_status === 'approved') payrollApprovedByMonth.set(r.month, true);
    else if (!payrollApprovedByMonth.has(r.month)) payrollApprovedByMonth.set(r.month, false);
  });

  return { attendanceByDate, payrollApprovedByMonth };
}

/**
 * Mirrors attendance_write_one's own protection order (manual priority
 * checked before the payroll block), PLUS this round's own additional,
 * stricter restriction: only a 'confirmed' (never 'check_in_only_
 * provisional') Present/Late result is ever classified 'eligible' --
 * Absent, Pending, Off, and Unassigned are never written automatically
 * at all, by design, regardless of this classification.
 */
export function classifyAutomaticEligibility(
  row: EligibilityInput,
  existing: ExistingAttendanceAndPayroll
): AutomaticEligibility {
  const existingRow = existing.attendanceByDate.get(row.date);
  if (existingRow?.source === 'manual') return 'protected_manual';

  const isConfirmedPresentOrLate = (row.status === 'present' || row.status === 'late') && row.calculationBasis === 'confirmed';
  if (!isConfirmedPresentOrLate) return 'skipped_not_confirmed_present_late';

  const month = row.date.slice(0, 7);
  if (existing.payrollApprovedByMonth.get(month)) return 'protected_payroll_approved';

  return 'eligible';
}

export interface ApplyOutcome {
  employeeId: string;
  date: string;
  outcome: string;
  oldStatus: string | null;
  newStatus: string | null;
  payrollFlag: string | null;
}

/**
 * Applies ONLY the exact (employeeId, date) pairs passed in -- never a
 * wider range -- one attendance_apply_automatic call per pair, with
 * p_date_from = p_date_to = that single date. This is deliberate: that
 * RPC would otherwise also write any Absent/Pending/Off/Unassigned
 * result it recalculates for every OTHER date in a wider range, and
 * this round restricts application to confirmed Present/Late only. The
 * RPC's own protections (manual priority, approved-payroll block,
 * Pending/Off/Unassigned never written) still apply underneath this on
 * every call regardless -- this is an additional restriction, not a
 * replacement for them. Never called except from an explicit operator
 * confirmation action -- there is no automatic/background invocation of
 * this function anywhere.
 */
export async function applyEligibleAutomaticResults(
  eligiblePairs: { employeeId: string; date: string }[]
): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];
  for (const pair of eligiblePairs) {
    const { data, error } = await supabase.rpc('attendance_apply_automatic', {
      p_employee_ids: [pair.employeeId],
      p_date_from: pair.date,
      p_date_to: pair.date,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    outcomes.push({
      employeeId: pair.employeeId,
      date: pair.date,
      outcome: row?.outcome ?? 'unknown',
      oldStatus: row?.old_status ?? null,
      newStatus: row?.new_status ?? null,
      payrollFlag: row?.payroll_flag ?? null,
    });
  }
  return outcomes;
}
