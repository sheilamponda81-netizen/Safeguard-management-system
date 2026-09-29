// Wraps the two-step HikCentral raw-event ingestion flow: (1) create the
// hikcentral_import_batches row via a normal RLS-gated insert (tenant_id
// resolved server-side by its own DEFAULT get_current_tenant_id(), same
// as every other tenant-scoped table -- never set explicitly from this
// file), then (2) call import_hikcentral_raw_events(), the
// SECURITY DEFINER RPC that re-derives the caller's tenant/permission
// server-side, bulk-inserts only the eligible successful events with
// exact-duplicate protection, and writes the batch's final summary
// counts -- see
// supabase/migrations/20260929000000_hikcentral_attendance_ingestion_foundation.sql.
//
// Follows the same never-throws, discriminated-outcome convention as
// src/utils/payrollProcessing.ts's processPayrollBatch().
import { supabase } from '../lib/supabase';
import { HikCentralParseResult, summarizeHikCentralParseResult } from './hikcentralExcelParser';
import { buildRawEventInsertPayloads } from './hikcentralIngestion';

const RPC_NOT_FOUND_CODE = 'PGRST202';

export type HikCentralImportOutcome =
  | 'success'
  | 'batch_create_failed'
  | 'unauthorized'
  | 'missing_rpc'
  | 'network_error'
  | 'unexpected_response';

export interface HikCentralImportResult {
  success: boolean;
  outcome: HikCentralImportOutcome;
  error?: string;
  batchId?: string;
  insertedCount?: number;
  duplicatesIgnored?: number;
}

interface ImportRpcSuccess {
  batch_id: string;
  submitted_count: number;
  inserted_count: number;
  duplicates_ignored: number;
}

function isImportRpcSuccess(data: unknown): data is ImportRpcSuccess {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { batch_id?: unknown }).batch_id === 'string' &&
    typeof (data as { inserted_count?: unknown }).inserted_count === 'number' &&
    typeof (data as { duplicates_ignored?: unknown }).duplicates_ignored === 'number'
  );
}

export async function importHikCentralRawEvents(
  filename: string,
  fileFingerprint: string | null,
  parseResult: HikCentralParseResult,
  tenantId: string
): Promise<HikCentralImportResult> {
  const { data: batch, error: batchError } = await supabase
    .from('hikcentral_import_batches')
    .insert({ filename, file_fingerprint: fileFingerprint, source: 'excel' })
    .select('id')
    .single();

  if (batchError || !batch) {
    return {
      success: false,
      outcome: 'batch_create_failed',
      error: batchError?.message ?? 'Could not create the import batch record.',
    };
  }

  const summary = summarizeHikCentralParseResult(parseResult);
  const events = await buildRawEventInsertPayloads(tenantId, parseResult.rows, 'excel');

  try {
    const { data, error } = await supabase.rpc('import_hikcentral_raw_events', {
      p_batch_id: batch.id,
      p_events: events,
      p_summary_counts: {
        total_rows: summary.totalRows,
        authorization_count: summary.authorizationCount,
        failed_count: summary.failedCount,
        with_person_no_count: summary.withPersonNoCount,
        without_person_no_count: summary.withoutPersonNoCount,
        unique_person_no_count: summary.uniquePersonNoCount,
      },
    });

    if (error) {
      if (error.code === RPC_NOT_FOUND_CODE) {
        return {
          success: false,
          outcome: 'missing_rpc',
          error: 'HikCentral import is not available yet in this environment (database migration not applied).',
          batchId: batch.id,
        };
      }
      return { success: false, outcome: 'unauthorized', error: error.message, batchId: batch.id };
    }

    if (!isImportRpcSuccess(data)) {
      return {
        success: false,
        outcome: 'unexpected_response',
        error: 'Unexpected response from the server while importing HikCentral events.',
        batchId: batch.id,
      };
    }

    return {
      success: true,
      outcome: 'success',
      batchId: data.batch_id,
      insertedCount: data.inserted_count,
      duplicatesIgnored: data.duplicates_ignored,
    };
  } catch {
    return {
      success: false,
      outcome: 'network_error',
      error: 'Network error while importing HikCentral events. Please try again.',
      batchId: batch.id,
    };
  }
}

/** SHA-256 of the raw file bytes, hex-encoded -- see hikcentral_import_batches.file_fingerprint's own comment for why this is diagnostic-only, not the real dedup mechanism. */
export async function computeFileFingerprint(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
