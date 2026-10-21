// Terminal Dues Phase 3D -- Accountant-initiated payroll with Admin
// approval. Wraps the four RPCs from
// supabase/migrations/20261028000000_payroll_accountant_admin_approval_workflow.sql:
// submit_payroll_processing_request() (Accountant/any payroll-process-
// authorized caller -- no financial write), approve_payroll_processing_
// request()/reject_payroll_processing_request() (Admin-class only --
// is_super_admin() OR is_business_admin(), never an Accountant, even one
// who holds the UNRELATED payroll.approve permission used by the
// existing post-commit "Review & Approve" feature -- see that
// migration's own header for why), and process_approved_payroll_request()
// (Admin-class only, the actual atomic commit via
// process_payroll_with_terminal_dues(), unchanged from Phase 3B).
import { supabase } from '../lib/supabase';
import { PayrollRecordInput, TerminalDuesBatchSummary } from './payrollProcessing';

export type PayrollProcessingRequestStatus = 'pending' | 'approved' | 'rejected' | 'processed';

export interface PayrollProcessingRequest {
  id: string;
  tenant_id: string;
  month: string;
  status: PayrollProcessingRequestStatus;
  initiated_by: string;
  initiated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  processing_reference: string | null;
  created_at: string;
}

// Every outcome these RPCs can produce -- named explicitly, same pattern
// as processPayrollBatch()/processPayrollWithTerminalDues()'s own outcome
// enums, rather than collapsed into a single boolean.
export type PayrollProcessingRequestOutcome =
  | 'success'
  | 'unauthorized'            // caller lacks the required authority (payroll.process to submit; Admin-class to approve/reject/process)
  | 'validation_failed'       // missing reason, stale month, no records, etc.
  | 'duplicate_live_request'  // a pending/approved request already exists for this tenant+month
  | 'not_found'                // request id doesn't exist, or belongs to another tenant
  | 'wrong_status'             // the request is no longer in the state this action requires (already decided/processed)
  | 'self_approval'            // caller is the same person who initiated the request
  | 'terminal_dues_validation_failed' // an included Terminal Dues allocation failed re-validation during actual processing
  | 'missing_rpc'
  | 'network_error'
  | 'unexpected_response';

export interface PayrollProcessingRequestResult {
  success: boolean;
  outcome: PayrollProcessingRequestOutcome;
  error?: string;
  requestId?: string;
  status?: PayrollProcessingRequestStatus;
  month?: string;
  /** Only populated by processApprovedPayrollRequest()'s success. */
  combinedReference?: string;
  insertedCount?: number;
  terminalDues?: TerminalDuesBatchSummary | null;
  ordinaryPayrollTotal?: number;
  terminalDuesTotal?: number;
  combinedTotal?: number;
}

const RPC_NOT_FOUND_CODE = 'PGRST202';

function classifyOutcome(message: string): PayrollProcessingRequestOutcome {
  if (
    message.includes('Not authenticated') ||
    message.includes('No profile found for the current user') ||
    message.includes('Only an Admin or super admin may') ||
    message.includes('Only Admins, super admins, or an account explicitly granted payroll.process')
  ) {
    return 'unauthorized';
  }
  if (message.includes('cannot approve your own')) {
    return 'self_approval';
  }
  if (message.includes('already pending or approved')) {
    return 'duplicate_live_request';
  }
  if (message.includes('request not found')) {
    return 'not_found';
  }
  if (message.includes('no longer pending') || message.includes('is not approved (status') || message.includes('may have already been')) {
    return 'wrong_status';
  }
  if (message.includes('Cannot process: allocation') || message.includes('pending entitlement revision') || message.includes('A reason is required to exclude an allocation')) {
    return 'terminal_dues_validation_failed';
  }
  return 'validation_failed';
}

// Raw shape of the RPCs' own successful JSONB return value -- the three
// decision RPCs return the first four fields only; process_approved_
// payroll_request() additionally spreads process_payroll_with_terminal_
// dues()'s own result (payroll/terminal_dues/totals/combined_reference)
// on top, via that migration's own `|| v_result`.
interface PayrollRequestRpcSuccess {
  success: true;
  request_id?: string;
  status?: PayrollProcessingRequestStatus;
  month?: string;
  combined_reference?: string;
  payroll?: { insertedCount?: number };
  terminal_dues?: { batch_reference: string; processed_count: number; total_amount: number; excluded_count: number } | null;
  ordinary_payroll_total?: number;
  terminal_dues_total?: number;
  combined_total?: number;
}

function isPayrollRequestRpcSuccess(data: unknown): data is PayrollRequestRpcSuccess {
  return typeof data === 'object' && data !== null && (data as { success?: unknown }).success === true;
}

async function callRequestRpc(
  rpcName: string,
  params: Record<string, unknown>
): Promise<PayrollProcessingRequestResult> {
  try {
    const { data, error } = await supabase.rpc(rpcName, params);

    if (error) {
      if (error.code === RPC_NOT_FOUND_CODE) {
        return {
          success: false,
          outcome: 'missing_rpc',
          error: 'This feature is not yet available -- the required database function has not been installed. Contact your administrator.',
        };
      }
      return { success: false, outcome: classifyOutcome(error.message), error: error.message };
    }

    if (!isPayrollRequestRpcSuccess(data)) {
      return { success: false, outcome: 'unexpected_response', error: `${rpcName}() returned an unexpected result` };
    }

    return {
      success: true,
      outcome: 'success',
      requestId: data.request_id,
      status: data.status,
      month: data.month,
      combinedReference: data.combined_reference,
      insertedCount: data.payroll?.insertedCount,
      terminalDues: data.terminal_dues
        ? {
            batchReference: data.terminal_dues.batch_reference,
            processedCount: data.terminal_dues.processed_count,
            totalAmount: data.terminal_dues.total_amount,
            excludedCount: data.terminal_dues.excluded_count,
          }
        : data.terminal_dues,
      ordinaryPayrollTotal: data.ordinary_payroll_total,
      terminalDuesTotal: data.terminal_dues_total,
      combinedTotal: data.combined_total,
    };
  } catch (err) {
    return { success: false, outcome: 'network_error', error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Accountant (or any payroll.process-authorized caller) submits a payroll
 * processing request -- writes NOTHING to `payroll`/
 * `terminal_due_allocations`, purely a durable, auditable record of
 * intent awaiting Admin approval.
 */
export async function submitPayrollProcessingRequest(
  month: string,
  records: PayrollRecordInput[],
  auditContext: Record<string, unknown> = {},
  terminalDuesExcludedIds: string[] = [],
  terminalDuesExclusionReason: string | null = null
): Promise<PayrollProcessingRequestResult> {
  if (records.length === 0) {
    return { success: false, outcome: 'validation_failed', error: 'No payroll records supplied' };
  }
  return callRequestRpc('submit_payroll_processing_request', {
    p_month: month,
    p_records: records,
    p_audit_context: auditContext,
    p_td_excluded_ids: terminalDuesExcludedIds,
    p_td_exclusion_reason: terminalDuesExclusionReason,
  });
}

/** Admin-class only. Pure decision -- no financial write yet. */
export async function approvePayrollProcessingRequest(requestId: string): Promise<PayrollProcessingRequestResult> {
  return callRequestRpc('approve_payroll_processing_request', { p_request_id: requestId });
}

/** Admin-class only. Requires a non-empty reason. */
export async function rejectPayrollProcessingRequest(requestId: string, reason: string): Promise<PayrollProcessingRequestResult> {
  if (!reason.trim()) {
    return { success: false, outcome: 'validation_failed', error: 'A reason is required to reject a payroll processing request' };
  }
  return callRequestRpc('reject_payroll_processing_request', { p_request_id: requestId, p_reason: reason.trim() });
}

/**
 * Admin-class only. The actual atomic commit -- calls
 * process_payroll_with_terminal_dues() internally, unchanged from Phase
 * 3B. Requires the request to be 'approved' (not 'pending') -- an
 * Accountant can never reach this state transition.
 */
export async function processApprovedPayrollRequest(requestId: string): Promise<PayrollProcessingRequestResult> {
  const { data: { user } } = await supabase.auth.getUser();
  return callRequestRpc('process_approved_payroll_request', { p_request_id: requestId, p_user_email: user?.email ?? null });
}
