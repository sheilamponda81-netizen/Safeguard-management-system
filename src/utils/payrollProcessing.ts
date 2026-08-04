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

export interface ProcessPayrollBatchResult {
  success: boolean;
  error?: string;
  month?: string;
  deletedCount?: number;
  insertedCount?: number;
}

/**
 * Calls process_payroll_batch(). Resolves the caller's own email first
 * (via supabase.auth.getUser(), the same pattern src/utils/auditLogger.ts
 * already uses) since the RPC needs it for the audit_logs row it writes
 * itself -- it cannot read auth.users directly.
 *
 * Never throws: a failure (validation error raised inside the function,
 * e.g. "already approved", "not authenticated", or a network error) comes
 * back as `{ success: false, error }` so the caller can show it via the
 * existing showNotification() pattern rather than needing a try/catch at
 * every call site.
 */
export async function processPayrollBatch(
  month: string,
  records: PayrollRecordInput[],
  auditContext: Record<string, unknown> = {}
): Promise<ProcessPayrollBatchResult> {
  if (records.length === 0) {
    return { success: false, error: 'No payroll records supplied' };
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
      return { success: false, error: error.message };
    }

    if (!data || typeof data !== 'object' || data.success !== true) {
      return { success: false, error: 'process_payroll_batch() returned an unexpected result' };
    }

    return {
      success: true,
      month: data.month,
      deletedCount: data.deletedCount,
      insertedCount: data.insertedCount,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error calling process_payroll_batch' };
  }
}
