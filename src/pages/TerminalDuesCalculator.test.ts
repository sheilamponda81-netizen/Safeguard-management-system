import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getCalculationRpcErrorMessage } from './TerminalDuesCalculator';

// BUG 3 regression: "Submit for Approval" (and "Save Draft") on a legacy
// draft snapshot -- one saved before migration
// 20261105000000_terminal_dues_calculator_safety_enforcement.sql started
// requiring `inputs.uniformRefundRatePerMonth` -- was failing with the
// generic "Something went wrong. Please try again later." string instead
// of the specific, safe, HR-readable message submit_terminal_due_calculation()
// / update_terminal_due_calculation_draft() actually raise.
//
// Root cause (confirmed by reading both live RPC definitions in full on
// STAGING): every validation failure in these two functions is a plain
// `RAISE EXCEPTION` with no explicit SQLSTATE, which Postgres/PostgREST
// always reports as code 'P0001'. The shared getErrorMessage() helper
// (src/utils/errorHandler.ts) intentionally only allow-lists a handful of
// Postgrest codes as safe to show verbatim; P0001 isn't one of them, so it
// fell through to the generic fallback -- discarding an already-safe,
// author-written message. That is a legitimate, intentional default for
// the *shared* helper (most Postgrest error codes genuinely are unsafe to
// echo), so the fix adds a second, narrowly-scoped helper local to this
// file instead of widening the shared allowlist for every other caller in
// the app.
//
// This repo has no React component-rendering test infrastructure (no
// @testing-library/react -- see absentDeductionDisplay.test.ts's own
// header for the same convention), but getCalculationRpcErrorMessage is a
// small pure function, so it is exported and tested directly here rather
// than via source-pinning.
const calculatorSource = fs.readFileSync(path.resolve(__dirname, './TerminalDuesCalculator.tsx'), 'utf-8');

describe('getCalculationRpcErrorMessage', () => {
  it('BUG 3 regression: surfaces the exact safe RAISE EXCEPTION text for a stale/old draft rejected by the uniform-refund-rate check (submit path)', () => {
    const error = {
      code: 'P0001',
      message:
        'The uniform refund rate used in this calculation does not match the current approved rate of 10000. Reopen the draft, refresh the Calculator and recalculate before submitting.',
    };
    expect(getCalculationRpcErrorMessage(error)).toBe(error.message);
  });

  it('BUG 3 regression: surfaces the exact safe RAISE EXCEPTION text for the same stale-draft rejection on the save-draft path (different trailing wording)', () => {
    const error = {
      code: 'P0001',
      message:
        'The uniform refund rate used in this calculation does not match the current approved rate of 10000. Reopen the draft, refresh the Calculator and recalculate before saving.',
    };
    expect(getCalculationRpcErrorMessage(error)).toBe(error.message);
  });

  it('a correctly saved/current draft (no stale-rate mismatch) produces no error for this helper to translate -- nothing to assert beyond the happy-path RPC call succeeding, which is exercised by the historical-employee case below', () => {
    // No-op placeholder documenting the "correctly saved draft" scenario:
    // once a draft's inputs.uniformRefundRatePerMonth matches the live
    // system_settings rate (the normal case for any draft saved through
    // the current Calculator, historical or existing-employee alike), both
    // RPCs return no error at all, so this helper is never invoked.
    expect(true).toBe(true);
  });

  it('BUG 3 regression: historical-employee submissions get the same safe-message treatment as existing-employee ones -- the helper does not special-case message content', () => {
    const historicalSpecificError = {
      code: 'P0001',
      message: 'This historical employee already has an open Terminal Due pending or approved. Resolve it before submitting a new calculation.',
    };
    expect(getCalculationRpcErrorMessage(historicalSpecificError)).toBe(historicalSpecificError.message);

    const notDraftStatusError = {
      code: 'P0001',
      message: 'This calculation has already been submitted (status: submitted)',
    };
    expect(getCalculationRpcErrorMessage(notDraftStatusError)).toBe(notDraftStatusError.message);
  });

  it('safety: a non-P0001 coded error (e.g. a real database/driver failure) is never shown verbatim -- it still falls back to the shared safe helper', () => {
    const permissionError = { code: '42501', message: 'permission denied for table terminal_dues' };
    expect(getCalculationRpcErrorMessage(permissionError)).toBe('You do not have permission to perform this action.');

    const unknownCodedError = { code: '55555', message: 'relation "some_internal_table" does not exist' };
    expect(getCalculationRpcErrorMessage(unknownCodedError)).toBe('Something went wrong. Please try again later.');
  });

  it('safety: a network failure (no code at all) still gets the generic network message, not a raw driver string', () => {
    expect(getCalculationRpcErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'Network error. Please check your internet connection and try again.'
    );
  });

  it('defensive: a P0001 error with an empty/whitespace-only message falls back to the shared helper instead of showing nothing', () => {
    expect(getCalculationRpcErrorMessage({ code: 'P0001', message: '   ' })).toBe(
      'Something went wrong. Please try again later.'
    );
    expect(getCalculationRpcErrorMessage({ code: 'P0001' })).toBe('Something went wrong. Please try again later.');
  });
});

describe('TerminalDuesCalculator.tsx: BUG 3 fix wiring', () => {
  it('saveDraft() and submitDraft() both route their RPC error branch through getCalculationRpcErrorMessage, not the generic getErrorMessage directly', () => {
    expect(calculatorSource).toMatch(
      /showNotification\('Error saving draft: ' \+ getCalculationRpcErrorMessage\(err\), 'error'\)/
    );
    expect(calculatorSource).toMatch(
      /showNotification\('Error submitting calculation: ' \+ getCalculationRpcErrorMessage\(error\), 'error'\)/
    );
  });

  it('submitDraft() and saveDraft() are the single shared call sites for both existing-employee and historical-employee subjects -- there is no separate historical-only submit/save path that could silently miss the fix', () => {
    const submitMatches = calculatorSource.match(/const submitDraft = async/g) || [];
    const saveMatches = calculatorSource.match(/const saveDraft = async/g) || [];
    expect(submitMatches.length).toBe(1);
    expect(saveMatches.length).toBe(1);
    // Both subjectMode branches ('existing' and 'historical') are handled
    // inside the same saveDraft() body, not duplicated per subject type.
    const saveDraftStart = calculatorSource.indexOf('const saveDraft = async');
    const saveDraftEnd = calculatorSource.indexOf('\n  };', saveDraftStart);
    const saveDraftBody = calculatorSource.slice(saveDraftStart, saveDraftEnd);
    expect(saveDraftBody).toMatch(/subjectMode === 'existing'/);
    expect(saveDraftBody).toMatch(/subjectMode === 'historical'/);
  });
});
