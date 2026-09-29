// HikCentral Attendance MVP -- Phase 1: the payload shape sent to the
// server-authoritative ingestion RPC (import_hikcentral_raw_events, see
// supabase/migrations/20260929000000_hikcentral_attendance_ingestion_foundation.sql).
//
// SECURITY: event_fingerprint is NOT computed here and NOT sent to the
// RPC. It used to be -- a prior version of this file computed it
// client-side and the RPC inserted that value as-is, which meant any
// caller could submit an arbitrary fingerprint per row: a fresh random
// value on every row would defeat the database's ON CONFLICT dedup
// entirely (a re-import would insert fresh duplicates every time), or a
// fixed value across genuinely distinct rows would make the database
// silently discard real events. The database is now the SOLE authority
// over event_fingerprint -- see the migration's PART 5 header comment
// for the exact two-branch algorithm it computes (identified events use
// person_no directly; anonymous events -- no Person No. -- are scoped to
// the specific import file's own content hash plus the row's stable
// position within it, via source_row_ordinal below, never inventing an
// identity for an anonymous person).
//
// This module's job is only to build the payload the RPC needs to
// compute that fingerprint itself: the row's own fields, plus
// source_row_ordinal (this row's stable position within the parsed
// file -- see ParsedHikCentralRow.rowNumber, deterministic for a given
// file's bytes).

import { ParsedHikCentralRow, isEligibleSuccessfulEvent } from './hikcentralExcelParser';

export interface RawEventInsertPayload {
  source: 'excel' | 'api';
  hikcentral_person_no: string | null;
  first_name: string | null;
  last_name: string | null;
  event_time: string;
  access_point: string | null;
  card_reader: string | null;
  authentication_result: string;
  event_type: string;
  attendance_type: string | null;
  /** This row's stable position within the parsed file -- used by the RPC ONLY for the anonymous-event fingerprint branch (hikcentral_person_no is null/blank). Meaningless, and unused, for an identified row. */
  source_row_ordinal: number;
  raw_payload: Record<string, unknown>;
}

/**
 * Builds the exact payload sent to import_hikcentral_raw_events for every
 * ELIGIBLE successful row (Authorization + "Access Granted by
 * Fingerprint") in a parsed file -- Failed rows and any other event type
 * are never included here; they only ever contribute to the batch
 * summary counts (see summarizeHikCentralParseResult), never to
 * hikcentral_raw_events. No fingerprint is computed here -- see this
 * file's header comment.
 */
export function buildRawEventInsertPayloads(
  rows: ParsedHikCentralRow[],
  source: 'excel' | 'api' = 'excel'
): RawEventInsertPayload[] {
  return rows.filter(isEligibleSuccessfulEvent).map((row) => ({
    source,
    hikcentral_person_no: row.hikcentralPersonNo,
    first_name: row.firstName,
    last_name: row.lastName,
    event_time: row.eventTimeIso,
    access_point: row.accessPoint,
    card_reader: row.cardReader,
    authentication_result: row.authenticationResult,
    event_type: row.eventType,
    attendance_type: row.attendanceType,
    source_row_ordinal: row.rowNumber,
    raw_payload: row.rawPayload as Record<string, unknown>,
  }));
}

/**
 * REFERENCE IMPLEMENTATION ONLY -- mirrors the canonical algorithm the
 * database actually computes (see the migration's PART 5 header
 * comment), for tests/documentation/future client-side "would this be a
 * duplicate" preview UX. This function's return value is NEVER sent to
 * or trusted by the server -- see this file's header comment. If this
 * ever drifts from the SQL expression, the SQL expression is correct and
 * this function is what's wrong; there is no other consumer of its
 * output that could mask that.
 */
export async function computeReferenceEventFingerprint(
  tenantId: string,
  row: Pick<ParsedHikCentralRow, 'hikcentralPersonNo' | 'eventTimeIso' | 'accessPoint' | 'cardReader' | 'authenticationResult' | 'eventType' | 'rowNumber'>,
  fileFingerprint: string
): Promise<string> {
  const isIdentified = row.hikcentralPersonNo !== null && row.hikcentralPersonNo !== '';
  const parts = isIdentified
    ? ['ID', tenantId, row.hikcentralPersonNo, row.eventTimeIso, row.accessPoint ?? '', row.cardReader ?? '', row.authenticationResult, row.eventType]
    : ['ANON', tenantId, fileFingerprint, String(row.rowNumber), row.accessPoint ?? '', row.cardReader ?? '', row.authenticationResult, row.eventType];
  const input = parts.join('|');
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
