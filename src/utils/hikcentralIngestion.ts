// HikCentral Attendance MVP -- Phase 1: event fingerprinting + the payload
// shape sent to the server-authoritative ingestion RPC
// (import_hikcentral_raw_events, see
// supabase/migrations/20260929000000_hikcentral_attendance_ingestion_foundation.sql).
//
// This is the ONE place the canonical event-fingerprint algorithm is
// implemented for Stage 1 (Excel). A future Stage 2 (live API/webhook
// adapter) MUST reuse this exact function for the two sources to
// deduplicate against each other correctly -- see the migration's PART 5
// header comment for the full algorithm definition and its one
// documented limit (same-second duplicate punches are indistinguishable
// from a re-imported duplicate, since the export has 1-second time
// resolution and no trusted per-event id).

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
  event_fingerprint: string;
  raw_payload: Record<string, unknown>;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * sha256(tenant_id || '|' || person_no || '|' || event_time (UTC ISO) ||
 * '|' || access_point || '|' || card_reader || '|' || authentication_result
 * || '|' || event_type)
 *
 * Missing/optional fields (person_no, access_point, card_reader) use ''
 * in the hashed string, matching the SQL-side COALESCE(..., '') the
 * migration documents, so a client-computed fingerprint and a
 * hypothetically server-recomputed one would always agree.
 */
export async function computeEventFingerprint(
  tenantId: string,
  row: Pick<ParsedHikCentralRow, 'hikcentralPersonNo' | 'eventTimeIso' | 'accessPoint' | 'cardReader' | 'authenticationResult' | 'eventType'>
): Promise<string> {
  const parts = [
    tenantId,
    row.hikcentralPersonNo ?? '',
    row.eventTimeIso,
    row.accessPoint ?? '',
    row.cardReader ?? '',
    row.authenticationResult,
    row.eventType,
  ];
  const input = parts.join('|');
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return toHex(digest);
}

/**
 * Builds the exact payload sent to import_hikcentral_raw_events for every
 * ELIGIBLE successful row (Authorization + "Access Granted by
 * Fingerprint") in a parsed file -- Failed rows and any other event type
 * are never included here; they only ever contribute to the batch
 * summary counts (see summarizeHikCentralParseResult), never to
 * hikcentral_raw_events.
 */
export async function buildRawEventInsertPayloads(
  tenantId: string,
  rows: ParsedHikCentralRow[],
  source: 'excel' | 'api' = 'excel'
): Promise<RawEventInsertPayload[]> {
  const eligible = rows.filter(isEligibleSuccessfulEvent);
  return Promise.all(
    eligible.map(async (row) => ({
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
      event_fingerprint: await computeEventFingerprint(tenantId, row),
      raw_payload: row.rawPayload as Record<string, unknown>,
    }))
  );
}
