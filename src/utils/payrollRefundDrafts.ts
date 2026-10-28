// SAFEGUARD -- urgent refund persistence hotfix.
//
// Pure, source-independent helpers for the payroll refund-draft feature.
// The actual persistence RPC (upsert_payroll_refund_draft, see
// supabase/migrations/20261108000000_payroll_refund_adjustments.sql) is
// the sole source of truth and re-validates everything itself -- these
// helpers exist only so Payroll.tsx's wiring (debounced auto-save,
// optimistic-concurrency bookkeeping, immediate client-side feedback) has
// a small, independently testable core instead of being buried inline in
// a large page component.

export interface RefundDraft {
  amount: number;
  reasonCode: string | null;
  reasonNotes: string | null;
  referenceMonth: string | null;
  referenceCategory: string | null;
  status: 'pending' | 'applied' | 'cancelled';
  updatedAt: string | null;
}

export const REFUND_REASON_CODES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'incorrect_absence_deduction', label: 'Incorrect absence deduction' },
  { value: 'incorrect_lecture_deduction', label: 'Incorrect lecture deduction' },
  { value: 'incorrect_late_deduction', label: 'Incorrect late deduction' },
  { value: 'incorrect_uniform_deduction', label: 'Incorrect uniform deduction' },
  { value: 'attendance_correction', label: 'Attendance correction' },
  { value: 'other', label: 'Other (describe in notes)' },
];

export const REFUND_REFERENCE_CATEGORIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'absent_deduction', label: 'Absence deduction' },
  { value: 'late_deduction', label: 'Late deduction' },
  { value: 'lecture_deduction', label: 'Lecture deduction' },
  { value: 'appearance_deduction', label: 'Appearance deduction' },
  { value: 'uniform_deduction', label: 'Uniform deduction' },
  { value: 'other', label: 'Other' },
];

export function emptyRefundDraft(): RefundDraft {
  return { amount: 0, reasonCode: null, reasonNotes: null, referenceMonth: null, referenceCategory: null, status: 'pending', updatedAt: null };
}

export interface RefundDraftRow {
  amount: number | string | null;
  reason_code?: string | null;
  reason_notes?: string | null;
  reference_month?: string | null;
  reference_category?: string | null;
  status?: string | null;
  updated_at?: string | null;
}

export function mapRowToRefundDraft(row: RefundDraftRow): RefundDraft {
  return {
    amount: Number(row.amount) || 0,
    reasonCode: row.reason_code ?? null,
    reasonNotes: row.reason_notes ?? null,
    referenceMonth: row.reference_month ?? null,
    referenceCategory: row.reference_category ?? null,
    status: (row.status as RefundDraft['status']) ?? 'pending',
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Client-side-only pre-check, purely for immediate UI feedback before a
 * debounced save round-trips -- the server (upsert_payroll_refund_draft)
 * independently re-validates every one of these rules and is the only
 * thing that can actually accept or reject a save.
 */
export function validateRefundDraftInput(amount: number, reasonCode: string | null, reasonNotes: string | null): string | null {
  if (!Number.isFinite(amount) || amount < 0) return 'Refund amount cannot be negative';
  if (amount > 0) {
    if (!reasonCode) return 'A refund reason is required for a nonzero amount';
    if (reasonCode === 'other' && !(reasonNotes && reasonNotes.trim())) {
      return 'Please describe the reason in the notes when "Other" is selected';
    }
  }
  return null;
}

/**
 * Race guard for out-of-order async save responses: a response must only
 * be applied to UI state if no NEWER save for the same employee has been
 * issued since this one was sent. Each outgoing save is tagged with a
 * monotonically increasing per-employee sequence number (the caller owns
 * incrementing it); a response whose sequence number no longer matches
 * the latest issued one is stale and must be discarded, never applied.
 */
export function shouldApplyRefundSaveResponse(latestIssuedSeq: number, responseSeq: number): boolean {
  return responseSeq === latestIssuedSeq;
}
