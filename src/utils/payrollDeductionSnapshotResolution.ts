// Salary Advances + Payroll & Payslip Financial Transparency audit --
// end-to-end completion pass. Shared by Payroll.tsx (management
// breakdown + drill-down) and Payslips.tsx (employee payslip) so both
// pages resolve a payroll row's itemized deduction breakdown via the
// EXACT SAME source-order rule, and can never disagree with each other.
//
// Source order, strictly in this priority:
//   1. A verified payroll_deduction_snapshots row set for this EXACT
//      payroll_id (supabase/migrations/
//      20261204000000_payroll_deduction_snapshot_capture.sql). Always
//      queried/joined by payroll_id, never by employee+month alone --
//      this is what guarantees a figure is never mixed in from a
//      different payroll run for the same employee/month (a
//      reprocessed, since-superseded run, for instance).
//   2. No snapshot exists for that payroll_id (any month processed
//      before this migration existed, or where the snapshot step itself
//      was skipped -- see that migration's own fail-closed gate) --
//      fall back to the PRE-EXISTING employee_deductions-row-based
//      logic (buildItemizedAttendanceBreakdown/
//      deriveItemizedAttendanceDeduction), completely unchanged.
//   3. Neither exists -- the existing honest "not itemized"/"itemized
//      breakdown not available" fallback, completely unchanged.
//
// A snapshot's own 'unallocated' category (see the migration's header)
// is surfaced here as `unallocatedAmount` -- genuinely unresolved
// evidence, never folded into 'uniform' or hidden. `complete` is false
// whenever any unallocated amount remains, so a caller can render it
// explicitly (e.g. "Unresolved: MK X -- composition not independently
// verifiable for this run") rather than silently dropping it.

export type SnapshotCategory = 'uniform' | 'absence' | 'late' | 'lecture' | 'appearance' | 'unallocated';

export interface PayrollDeductionSnapshotRow {
  category: SnapshotCategory;
  amount: number;
  quantity: number | null;
  rate: number | null;
  source: string;
}

export interface ResolvedDeductionSnapshot {
  /** Always true when this function returns non-null -- a snapshot row set exists for this exact payroll_id. */
  available: true;
  absenceDeduction: number;
  absenceDays: number | null;
  absenceRate: number | null;
  lateDeduction: number;
  lateDays: number | null;
  lateRate: number | null;
  lectureDeduction: number;
  appearanceDeduction: number;
  /** 0 when the position doesn't require one, or when nothing could be verified (see unallocatedAmount instead). */
  uniformDeduction: number;
  /** Genuinely unresolved evidence -- NOT a deduction type, never a legitimate "Uniform" amount. 0 when fully resolved. */
  unallocatedAmount: number;
  /** False whenever unallocatedAmount > 0 -- the caller must show that remainder explicitly, never hide it by only rendering the other categories. */
  complete: boolean;
}

/**
 * Resolves a payroll row's itemized breakdown strictly from its OWN
 * payroll_deduction_snapshots rows (the caller must have already
 * queried by that exact payroll_id -- this function does not and
 * cannot enforce that itself, it only shapes whatever rows it is
 * given). Returns null when no snapshot rows exist for this payroll_id
 * at all, so the caller falls through to its own employee_deductions-
 * based fallback (step 2 above) or the honest "not itemized" fallback
 * (step 3) -- this function deliberately never fabricates a result from
 * nothing.
 */
export function resolveDeductionSnapshot(
  rows: PayrollDeductionSnapshotRow[] | null | undefined
): ResolvedDeductionSnapshot | null {
  if (!rows || rows.length === 0) return null;

  const find = (category: SnapshotCategory) => rows.find(r => r.category === category);
  const absence = find('absence');
  const late = find('late');
  const lecture = find('lecture');
  const appearance = find('appearance');
  const uniform = find('uniform');
  const unallocated = find('unallocated');

  const unallocatedAmount = unallocated?.amount ?? 0;

  return {
    available: true,
    absenceDeduction: absence?.amount ?? 0,
    absenceDays: absence?.quantity ?? null,
    absenceRate: absence?.rate ?? null,
    lateDeduction: late?.amount ?? 0,
    lateDays: late?.quantity ?? null,
    lateRate: late?.rate ?? null,
    lectureDeduction: lecture?.amount ?? 0,
    appearanceDeduction: appearance?.amount ?? 0,
    uniformDeduction: uniform?.amount ?? 0,
    unallocatedAmount,
    complete: unallocatedAmount <= 0,
  };
}
