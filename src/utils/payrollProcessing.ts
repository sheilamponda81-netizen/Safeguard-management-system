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
//
// TERMINAL DUES PHASE 3B: process_payroll_batch() itself is UNCHANGED,
// but as of 20261027000000_terminal_dues_atomic_payroll_integration.sql
// it is no longer directly callable by `authenticated` at all -- calling
// processPayrollBatch() below from any live code path will now fail with
// a permission-denied error. Payroll.tsx calls
// processPayrollWithTerminalDues() exclusively (further down this file);
// processPayrollBatch()/describeProcessPayrollBatchError() are kept here,
// unmodified, only because process_payroll_with_terminal_dues() calls the
// underlying RPC internally under its own privileges, and because
// removing a function with its own existing, passing test suite was not
// necessary to fix the atomicity gap this phase addresses.
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
  /** How many employees in this batch had a salary advance deduction
   *  applied -- see supabase/migrations/20260813000001_payroll_salary_advance_integration.sql.
   *  Optional: undefined when process_payroll_batch() predates that
   *  migration, not a failure. */
  advanceDeductionsApplied?: number;
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

// The per-employee GLOBAL NET-PAY INVARIANT exception (see
// 20260813000001_payroll_salary_advance_integration.sql's own RAISE
// EXCEPTION text) identifies the affected employee by UUID, since that's
// all the database function itself has -- it never resolves a human name.
// This regex pulls that UUID back out so the UI can show an actual name
// instead. Deliberately narrow (matches only THIS function's own
// self-authored wording), so it only ever fires for the exact case it's
// meant to translate.
const NEGATIVE_NET_PAY_ERROR_RE = /for employee ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):.*negative net pay/i;

/**
 * Rewrites process_payroll_batch()'s own negative-net-pay exception (plain
 * English already, but keyed by employee UUID since the database has no
 * concept of a display name) into a message naming the actual employee,
 * when the caller can resolve that UUID to a name. Falls back to the raw
 * RPC message untouched for every other error, and for this one too if the
 * employee can't be resolved -- never worse than showing the original
 * message, never a raw SQL/Postgres internal either way (the RPC's own
 * exception text is already plain English, this only improves it further).
 */
export function describeProcessPayrollBatchError(
  error: string,
  getEmployeeName: (employeeId: string) => string | undefined
): string {
  const match = error.match(NEGATIVE_NET_PAY_ERROR_RE);
  if (match) {
    const name = getEmployeeName(match[1]);
    if (name) {
      return `Payroll cannot be processed because deductions would make net pay negative for ${name}. Review the deductions and try again.`;
    }
  }
  return error;
}

// Raw shape of the RPC's own successful JSONB return value (see the
// migration's final `RETURN jsonb_build_object(...)`).
interface ProcessPayrollBatchRpcSuccess {
  success: true;
  month: string;
  deletedCount: number;
  insertedCount: number;
  advanceDeductionsApplied?: number;
}

// Terminal Dues Phase 3B -- the atomic combined RPC (see
// supabase/migrations/20261027000000_terminal_dues_atomic_payroll_integration.sql).
// Replaces the Phase 3A pattern of two separate, non-atomic
// `supabase.rpc()` calls (processPayrollBatch() then a second direct
// `process_terminal_due_allocations_batch` call) with ONE call to
// process_payroll_with_terminal_dues(), which commits ordinary payroll
// and (when the caller holds terminal_dues.approve) Terminal Dues
// processing inside a single Postgres transaction -- if either half is
// invalid, NEITHER commits. process_payroll_batch() and
// process_terminal_due_allocations_batch() are no longer directly
// callable by `authenticated` at all (see that migration's PART 2) --
// this is now the only entry point for both.
export type ProcessPayrollWithTerminalDuesOutcome =
  | ProcessPayrollBatchOutcome
  | 'terminal_dues_validation_failed'; // an included (non-excluded) Terminal Dues allocation failed its own re-validation -- see process_terminal_due_allocations_batch()'s RAISE EXCEPTION list. Ordinary payroll in this SAME call was rolled back too.

export interface TerminalDuesBatchSummary {
  batchReference: string;
  processedCount: number;
  totalAmount: number;
  excludedCount: number;
}

export interface ProcessPayrollWithTerminalDuesResult {
  success: boolean;
  outcome: ProcessPayrollWithTerminalDuesOutcome;
  error?: string;
  month?: string;
  /** Links this run's own audit_logs entry (entity_type =
   *  'combined_payroll_run') -- the recovery object to check after a
   *  network interruption before assuming nothing committed. */
  combinedReference?: string;
  deletedCount?: number;
  insertedCount?: number;
  advanceDeductionsApplied?: number;
  /** null when the caller lacked terminal_dues.approve, or there was
   *  nothing eligible/excluded for this month -- Terminal Dues was never
   *  attempted at all, not merely a zero-count success. */
  terminalDues?: TerminalDuesBatchSummary | null;
  ordinaryPayrollTotal?: number;
  terminalDuesTotal?: number;
  combinedTotal?: number;
}

interface ProcessPayrollWithTerminalDuesRpcSuccess {
  success: true;
  month: string;
  combined_reference: string;
  payroll: ProcessPayrollBatchRpcSuccess;
  terminal_dues: {
    batch_reference: string;
    processed_count: number;
    total_amount: number;
    excluded_count: number;
  } | null;
  ordinary_payroll_total: number;
  terminal_dues_total: number;
  combined_total: number;
}

function isProcessPayrollWithTerminalDuesRpcSuccess(data: unknown): data is ProcessPayrollWithTerminalDuesRpcSuccess {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { success?: unknown }).success === true &&
    typeof (data as { month?: unknown }).month === 'string' &&
    typeof (data as { combined_reference?: unknown }).combined_reference === 'string' &&
    isProcessPayrollBatchRpcSuccess((data as { payroll?: unknown }).payroll)
  );
}

// Extends classifyPayrollError() with the two new exception families this
// RPC can additionally raise -- the authoritative-month mismatch (STEP 2
// of the migration) and every Terminal Dues re-validation failure (text
// owned by process_terminal_due_allocations_batch(), unchanged by this
// RPC, which just lets it propagate).
function classifyCombinedError(message: string): ProcessPayrollWithTerminalDuesOutcome {
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
  if (
    message.includes('Cannot process: allocation') ||
    message.includes('pending entitlement revision') ||
    message.includes('A reason is required to exclude an allocation')
  ) {
    return 'terminal_dues_validation_failed';
  }
  return 'validation_failed';
}

/**
 * Calls process_payroll_with_terminal_dues() -- see that RPC's own
 * migration header for the full architecture. `terminalDuesExcludedIds`/
 * `terminalDuesExclusionReason` are forwarded as-is; the RPC itself
 * decides whether Terminal Dues is even attempted (the caller's own
 * terminal_dues.approve permission, re-checked server-side every time).
 *
 * Never throws, same contract as processPayrollBatch(): every failure
 * comes back as `{ success: false, outcome, error }`, including the ONE
 * new failure mode this RPC introduces -- an included Terminal Dues
 * allocation failing validation, which also means ordinary payroll in
 * this SAME call did not commit either (never partially).
 */
export async function processPayrollWithTerminalDues(
  month: string,
  records: PayrollRecordInput[],
  auditContext: Record<string, unknown> = {},
  terminalDuesExcludedIds: string[] = [],
  terminalDuesExclusionReason: string | null = null
): Promise<ProcessPayrollWithTerminalDuesResult> {
  if (records.length === 0) {
    return { success: false, outcome: 'validation_failed', error: 'No payroll records supplied' };
  }

  try {
    const { data: { user } } = await supabase.auth.getUser();

    const { data, error } = await supabase.rpc('process_payroll_with_terminal_dues', {
      p_month: month,
      p_records: records,
      p_user_email: user?.email ?? null,
      p_audit_context: auditContext,
      p_td_excluded_ids: terminalDuesExcludedIds,
      p_td_exclusion_reason: terminalDuesExclusionReason,
    });

    if (error) {
      if (error.code === RPC_NOT_FOUND_CODE) {
        return {
          success: false,
          outcome: 'missing_rpc',
          error: 'This feature is not yet available -- the required database function has not been installed. Contact your administrator.',
        };
      }
      return { success: false, outcome: classifyCombinedError(error.message), error: error.message };
    }

    if (!isProcessPayrollWithTerminalDuesRpcSuccess(data)) {
      return {
        success: false,
        outcome: 'unexpected_response',
        error: 'process_payroll_with_terminal_dues() returned an unexpected result',
      };
    }

    return {
      success: true,
      outcome: 'success',
      month: data.month,
      combinedReference: data.combined_reference,
      deletedCount: data.payroll.deletedCount,
      insertedCount: data.payroll.insertedCount,
      advanceDeductionsApplied: data.payroll.advanceDeductionsApplied,
      terminalDues: data.terminal_dues
        ? {
            batchReference: data.terminal_dues.batch_reference,
            processedCount: data.terminal_dues.processed_count,
            totalAmount: data.terminal_dues.total_amount,
            excludedCount: data.terminal_dues.excluded_count,
          }
        : null,
      ordinaryPayrollTotal: data.ordinary_payroll_total,
      terminalDuesTotal: data.terminal_dues_total,
      combinedTotal: data.combined_total,
    };
  } catch (err) {
    return {
      success: false,
      outcome: 'network_error',
      error: err instanceof Error ? err.message : 'Unknown error calling process_payroll_with_terminal_dues',
    };
  }
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
      advanceDeductionsApplied: data.advanceDeductionsApplied,
    };
  } catch (err) {
    return {
      success: false,
      outcome: 'network_error',
      error: err instanceof Error ? err.message : 'Unknown error calling process_payroll_batch',
    };
  }
}
