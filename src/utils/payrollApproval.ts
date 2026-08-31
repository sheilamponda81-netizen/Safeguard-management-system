import { supabase } from '../lib/supabase';
import { handleError } from './errorHandler';

export interface ApprovePayrollRunParams {
  month: string;
  status: 'approved' | 'rejected';
  notes: string | null;
  // The exact payroll row ids already loaded on screen (payrollRecords in
  // src/pages/Payroll.tsx) -- the on-screen snapshot, not a server-
  // recomputed population. Sent as an RPC body parameter (uuid[]), never
  // as a URL filter.
  payrollIds: string[];
}

export interface ApprovePayrollRunResult {
  success: boolean;
  updatedCount: number;
  error?: string;
  // Distinguishes *why* success is false, so callers can react correctly
  // without parsing `error`'s text:
  //   'scope_changed' -- the RPC's own all-or-nothing count check failed
  //                      server-side (see the migration) and raised,
  //                      which rolls back the ENTIRE update -- nothing
  //                      was approved. The on-screen snapshot no longer
  //                      matches reality (a record's month/tenant/region
  //                      changed, or it no longer exists) and needs a
  //                      refresh.
  //   'rpc_error'      -- any other failure (permission denied, invalid
  //                       status, unauthenticated, network error) --
  //                       nothing was touched either, no reason to
  //                       refetch.
  reason?: 'scope_changed' | 'rpc_error';
}

// PostgreSQL's default plpgsql-raised-exception SQLSTATE, used explicitly
// (rather than left implicit) by the migration's all-or-nothing count
// check -- see supabase/migrations/20260831000000_payroll_approval_rpc.sql.
const SCOPE_CHANGED_SQLSTATE = 'P0001';

// Wraps the approve_payroll_run RPC (see
// supabase/migrations/20260831000000_payroll_approval_rpc.sql) -- a single
// atomic server-side UPDATE, scoped to the exact payroll row ids the caller
// already had loaded on screen, sent as one uuid[] body parameter instead
// of a URL filter. Replaces the previous
// `.from('payroll').update(...).eq('month', ...)
// .in('employee_id', payrollRecords.map(...))` call, whose request URL grew
// large enough for a full month's payroll run (hundreds of employees) to be
// rejected outright with a bare 400 Bad Request. The RPC independently
// re-authorizes every supplied id against the caller's own tenant/region
// server-side -- this wrapper does not (and must not) trust the array as
// sufficient authorization on its own.
//
// The RPC itself guarantees all-or-nothing: it compares the distinct
// supplied-id count against the actual UPDATE row count in the SAME
// statement/transaction and RAISEs if they differ, which rolls back the
// whole UPDATE -- there is no server response shape representing "some
// rows were approved, some weren't". A successful RPC call (no `error`)
// therefore always means every supplied id was updated; this wrapper does
// not need to (and does not) independently re-check the returned count
// against what was requested.
//
// Never throws: any failure (permission denied, invalid status, a network
// error, or the RPC's own scope-changed rollback) comes back as a
// structured { success: false, error, reason } instead, so call sites can
// show it via showNotification() without their own try/catch -- the same
// pattern this codebase's own history used for processPayrollBatch() (see
// commit fab42e2, since reverted along with the RPC it wrapped).
//
// payroll.id is a PRIMARY KEY, so a supplied id can only ever match zero or
// one row -- deduplicating before sending only guards against a
// hypothetical client-side rendering bug (payrollRecords should never
// legitimately contain the same id twice), not a real data possibility;
// the RPC itself also recomputes its own distinct count server-side and
// does not depend on this deduplication for correctness.
export async function approvePayrollRun(params: ApprovePayrollRunParams): Promise<ApprovePayrollRunResult> {
  const uniqueIds = Array.from(new Set(params.payrollIds));

  try {
    const { data, error } = await supabase.rpc('approve_payroll_run', {
      p_month: params.month,
      p_status: params.status,
      p_notes: params.notes,
      p_payroll_ids: uniqueIds,
    });

    if (error) {
      if (error.code === SCOPE_CHANGED_SQLSTATE) {
        return {
          success: false,
          updatedCount: 0,
          error: 'Payroll data or approval scope changed. Refresh the payroll and try again.',
          reason: 'scope_changed',
        };
      }
      return { success: false, updatedCount: 0, error: handleError(error), reason: 'rpc_error' };
    }

    const updatedCount = typeof data === 'number' ? data : 0;
    return { success: true, updatedCount };
  } catch (err) {
    return { success: false, updatedCount: 0, error: handleError(err), reason: 'rpc_error' };
  }
}
