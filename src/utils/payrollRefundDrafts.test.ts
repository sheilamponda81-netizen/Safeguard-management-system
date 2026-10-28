import { describe, it, expect } from 'vitest';
import {
  emptyRefundDraft,
  mapRowToRefundDraft,
  validateRefundDraftInput,
  shouldApplyRefundSaveResponse,
  REFUND_REASON_CODES,
  REFUND_REFERENCE_CATEGORIES,
} from './payrollRefundDrafts';

describe('emptyRefundDraft', () => {
  it('returns a zero, reason-less, pending draft', () => {
    expect(emptyRefundDraft()).toEqual({
      amount: 0, reasonCode: null, reasonNotes: null, referenceMonth: null, referenceCategory: null,
      status: 'pending', updatedAt: null,
    });
  });
});

describe('mapRowToRefundDraft', () => {
  it('maps a full DB row, coercing a string amount to a number', () => {
    const draft = mapRowToRefundDraft({
      amount: '20000.00', reason_code: 'incorrect_lecture_deduction', reason_notes: 'Reimbursing Sept',
      reference_month: '2026-09', reference_category: 'lecture_deduction', status: 'applied', updated_at: '2026-10-28T08:00:00Z',
    });
    expect(draft).toEqual({
      amount: 20000, reasonCode: 'incorrect_lecture_deduction', reasonNotes: 'Reimbursing Sept',
      referenceMonth: '2026-09', referenceCategory: 'lecture_deduction', status: 'applied', updatedAt: '2026-10-28T08:00:00Z',
    });
  });

  it('defaults missing optional fields to null/pending rather than throwing', () => {
    const draft = mapRowToRefundDraft({ amount: 0 });
    expect(draft).toEqual({
      amount: 0, reasonCode: null, reasonNotes: null, referenceMonth: null, referenceCategory: null,
      status: 'pending', updatedAt: null,
    });
  });

  it('never produces NaN for a null/malformed amount', () => {
    expect(mapRowToRefundDraft({ amount: null }).amount).toBe(0);
  });
});

describe('validateRefundDraftInput', () => {
  it('accepts a zero amount with no reason -- a deliberate zero cancels, it does not need a reason', () => {
    expect(validateRefundDraftInput(0, null, null)).toBeNull();
  });

  it('rejects a negative amount', () => {
    expect(validateRefundDraftInput(-1, 'attendance_correction', null)).toMatch(/cannot be negative/i);
  });

  it('rejects a nonzero amount with no reason code', () => {
    expect(validateRefundDraftInput(20000, null, null)).toMatch(/reason is required/i);
  });

  it('accepts a nonzero amount with a non-"other" reason and no notes', () => {
    expect(validateRefundDraftInput(20000, 'incorrect_lecture_deduction', null)).toBeNull();
  });

  it('rejects reason "other" with empty/whitespace-only notes', () => {
    expect(validateRefundDraftInput(20000, 'other', null)).toMatch(/describe the reason/i);
    expect(validateRefundDraftInput(20000, 'other', '   ')).toMatch(/describe the reason/i);
  });

  it('accepts reason "other" once real notes are provided', () => {
    expect(validateRefundDraftInput(20000, 'other', 'Correcting a manual entry error')).toBeNull();
  });
});

describe('shouldApplyRefundSaveResponse (the async-race guard)', () => {
  it('applies a response whose sequence number matches the latest issued one', () => {
    expect(shouldApplyRefundSaveResponse(3, 3)).toBe(true);
  });

  it('discards a response from an OLDER save once a newer one has since been issued', () => {
    // Two saves fired back-to-back (seq 1 then seq 2); seq 1's slower
    // response must never be allowed to overwrite seq 2's result.
    expect(shouldApplyRefundSaveResponse(2, 1)).toBe(false);
  });

  it('never discards the single most recent response in a simple sequential case', () => {
    expect(shouldApplyRefundSaveResponse(1, 1)).toBe(true);
  });
});

describe('REFUND_REASON_CODES / REFUND_REFERENCE_CATEGORIES', () => {
  it('includes every reason code the business brief\'s own examples imply', () => {
    const values = REFUND_REASON_CODES.map(r => r.value);
    expect(values).toContain('incorrect_absence_deduction');
    expect(values).toContain('incorrect_lecture_deduction');
    expect(values).toContain('attendance_correction');
    expect(values).toContain('other');
  });

  it('matches the exact CHECK constraint vocabulary in 20261108000000_payroll_refund_adjustments.sql (reason_code)', () => {
    expect(REFUND_REASON_CODES.map(r => r.value).sort()).toEqual([
      'attendance_correction', 'incorrect_absence_deduction', 'incorrect_late_deduction',
      'incorrect_lecture_deduction', 'incorrect_uniform_deduction', 'other',
    ].sort());
  });

  it('matches the exact CHECK constraint vocabulary in 20261108000000_payroll_refund_adjustments.sql (reference_category)', () => {
    expect(REFUND_REFERENCE_CATEGORIES.map(r => r.value).sort()).toEqual([
      'absent_deduction', 'appearance_deduction', 'late_deduction', 'lecture_deduction', 'other', 'uniform_deduction',
    ].sort());
  });
});
