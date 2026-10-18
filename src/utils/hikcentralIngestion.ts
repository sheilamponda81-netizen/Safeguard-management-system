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
// over event_fingerprint -- see the ingestion migration's PART 5 header
// comment for the exact two-branch algorithm it computes.
//
// CROSS-FILE ANONYMOUS DEDUP (2026-10-07): identified events use
// person_no directly, which is already stable across files. Anonymous
// events (no Person No.) were ORIGINALLY scoped to the specific import
// file's own content hash plus the row's stable position within it
// (source_row_ordinal) -- this made same-file re-import dedup work, but
// meant the SAME physical anonymous event appearing in a different,
// overlapping export (e.g. a combined multi-terminal workbook that
// re-exports an already-imported date range) was treated as a brand new
// event, since the file identity/row position differ across exports.
// Confirmed as a real risk (not theoretical) against the real HEAD
// OFFICE dataset's 48 anonymous successful events once a combined
// export covering the same date range was obtained. Fixed: the
// anonymous branch is now scoped to the event's own intrinsic,
// file-independent fields (event_time/access_point/card_reader/
// authentication_result/event_type) instead -- see the migration's
// collision-analysis header for why this is safe (empirically, no two
// real events at this access point/reader ever share an identical
// second, which is also physically expected of a sequential
// fingerprint/card reader device).
//
// source_row_ordinal is still sent below and still REQUIRED by the RPC
// for an anonymous row to be admitted at all (an anonymous row with no
// recorded file position is rejected, same as before) -- it is simply no
// longer part of the fingerprint's hash input.
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
  /** This row's stable position within the parsed file -- REQUIRED by the RPC for an anonymous row (hikcentral_person_no null/blank) to be admitted at all, but (as of 2026-10-07) no longer part of the anonymous event_fingerprint's hash input -- see this file's header comment. Meaningless, and unused, for an identified row. */
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
 *
 * As of 2026-10-07, neither branch takes a file identity/row-position
 * input: the identified branch never did (person_no was always
 * sufficient), and the anonymous branch no longer does either (see this
 * file's header comment for why) -- the two branches now differ only in
 * their tag ('ID|' vs 'ANON|') and whether hikcentral_person_no is
 * included, both keyed on the same intrinsic event fields otherwise.
 */
export async function computeReferenceEventFingerprint(
  tenantId: string,
  row: Pick<ParsedHikCentralRow, 'hikcentralPersonNo' | 'eventTimeIso' | 'accessPoint' | 'cardReader' | 'authenticationResult' | 'eventType'>
): Promise<string> {
  const isIdentified = row.hikcentralPersonNo !== null && row.hikcentralPersonNo !== '';
  const parts = isIdentified
    ? ['ID', tenantId, row.hikcentralPersonNo, row.eventTimeIso, row.accessPoint ?? '', row.cardReader ?? '', row.authenticationResult, row.eventType]
    : ['ANON', tenantId, row.eventTimeIso, row.accessPoint ?? '', row.cardReader ?? '', row.authenticationResult, row.eventType];
  const input = parts.join('|');
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
