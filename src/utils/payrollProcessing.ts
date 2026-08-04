// Wraps the process_payroll_batch(...) RPC (see
// supabase/migrations/20260803000002_payroll_atomic_process_rpc.sql) so
// Payroll.tsx's processPayroll()/copyFromPreviousMonth() call one atomic,
// server-side transaction instead of performing a separate client-side
// DELETE followed by a separate INSERT -- the non-atomicity that let a
// failed insert leave a month's payroll fully deleted with nothing
// re-inserted (Finding A8). The RPC itself validates authorization,
// blocks reprocessing an already-approved month, serializes concurrent
// callers for the same tenant+month, and writes the audit log entry in
// the same transaction as the payroll write.
import { supabase } from '../lib/supabase';

export interface PayrollRecordInput {
  employee_id: string;
  basic_salary: number;
  allowances: number;
  overtime: number;
  bonus: number;
  gross_pay: number;
  paye: number;
  pension: number;
  uniform_deduction: number;
  net_pay: number;
}

// Every outcome this RPC call can produce, named explicitly rather than
// collapsed into a single boolean -- see processPayrollBatch()'s doc
// comment for what triggers each one. `error` is always the message this
// function decided is safe to show a user (see the PGRST202 special case
// below); it is never the target of an unsafe assertion or blind pass-
// through of Postgrest's own internals.
export type ProcessPayrollBatchOutcome =
  | 'success'
  | 'validation_failed'    // e.g. duplicate employee_id in payload, negative amount, no records -- see the migration's own RAISE EXCEPTION list
  | 'approved_conflict'    // targeted month already has approved payroll rows for one or more employees
  | 'unauthorized'         // caller is not authenticated, or not Admin/super-admin
  | 'missing_rpc'          // process_payroll_batch() does not exist yet in this database (migration not applied)
  | 'network_error'        // the request itself never reached/returned from Supabase
  | 'unexpected_response'; // the RPC returned HTTP 200 but not the {success, month, ...} shape it's documented to return

export interface ProcessPayrollBatchResult {
  success: boolean;
  outcome: ProcessPayrollBatchOutcome;
  error?: string;
  month?: string;
  deletedCount?: number;
  insertedCount?: number;
}

// PostgREST's own code for "the RPC function you called does not exist in
// the schema cache" -- distinct from a validation exception the function
// itself raises (which surfaces as PGRST's generic wrapping of a Postgres
// RAISE EXCEPTION, with no fixed code specific to this function).
const RPC_NOT_FOUND_CODE = 'PGRST202';

// The exact RAISE EXCEPTION text this migration uses (see
// 20260803000002_payroll_atomic_process_rpc.sql) -- matched by substring so
// a caller gets the right `outcome` without this file needing to parse SQL.
// Postgres/PostgREST doesn't give each RAISE EXCEPTION its own error code,
// only a generic one, so text matching against messages THIS function
// itself authored (never user- or row-derived) is the only way to
// distinguish them, and is safe for exactly that reason.
function classifyPayrollError(message: string): Extract<ProcessPayrollBatchOutcome, 'unauthorized' | 'validation_failed' | 'approved_conflict'> {
  if (
    message.includes('Not authenticated') ||
    message.includes('No profile found for the current user') ||
    message.includes('Only Admins or super admins may process payroll')
  ) {
    return 'unauthorized';
  }
  if (message.includes('already have approved payroll for this month')) {
    return 'approved_conflict';
  }
  return 'validation_failed';
}

// Raw shape of the RPC's own successful JSONB return value (see the
// migration's final `RETURN jsonb_build_object(...)`).
interface ProcessPayrollBatchRpcSuccess {
  success: true;
  month: string;
  deletedCount: number;
  insertedCount: number;
}

function isProcessPayrollBatchRpcSuccess(data: unknown): data is ProcessPayrollBatchRpcSuccess {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { success?: unknown }).success === true &&
    typeof (data as { month?: unknown }).month === 'string' &&
    typeof (data as { deletedCount?: unknown }).deletedCount === 'number' &&
    typeof (data as { insertedCount?: unknown }).insertedCount === 'number'
  );
}

/**
 * Calls process_payroll_batch(). Resolves the caller's own email first
 * (via supabase.auth.getUser(), the same pattern src/utils/auditLogger.ts
 * already uses) since the RPC needs it for the audit_logs row it writes
 * itself -- it cannot read auth.users directly.
 *
 * Never throws: every failure mode (a validation/authorization/conflict
 * exception raised inside the function, the function not existing yet, a
 * network failure, or a response that isn't shaped the way the function is
 * documented to return) comes back as `{ success: false, outcome, error }`
 * so the caller can show `error` via the existing showNotification()
 * pattern and, if it ever needs to, branch on `outcome` -- rather than
 * treating "the HTTP request succeeded" as proof the RPC did what was
 * asked.
 */
export async function processPayrollBatch(
  month: string,
  records: PayrollRecordInput[],
  auditContext: Record<string, unknown> = {}
): Promise<ProcessPayrollBatchResult> {
  if (records.length === 0) {
    return { success: false, outcome: 'validation_failed', error: 'No payroll records supplied' };
  }

  try {
    const { data: { user } } = await supabase.auth.getUser();

    const { data, error } = await supabase.rpc('process_payroll_batch', {
      p_month: month,
      p_records: records,
      p_user_email: user?.email ?? null,
      p_audit_context: auditContext,
    });

    if (error) {
      if (error.code === RPC_NOT_FOUND_CODE) {
        return {
          success: false,
          outcome: 'missing_rpc',
          error: 'This feature is not yet available -- the required database function has not been installed. Contact your administrator.',
        };
      }
      return { success: false, outcome: classifyPayrollError(error.message), error: error.message };
    }

    if (!isProcessPayrollBatchRpcSuccess(data)) {
      return {
        success: false,
        outcome: 'unexpected_response',
        error: 'process_payroll_batch() returned an unexpected result',
      };
    }

    return {
      success: true,
      outcome: 'success',
      month: data.month,
      deletedCount: data.deletedCount,
      insertedCount: data.insertedCount,
    };
  } catch (err) {
    return {
      success: false,
      outcome: 'network_error',
      error: err instanceof Error ? err.message : 'Unknown error calling process_payroll_batch',
    };
  }
}
