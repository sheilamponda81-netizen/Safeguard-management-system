// HikCentral Attendance MVP -- Phase 2A: read-only Attendance Preview data access.
//
// Reuses fetchActiveHikCentralPersonMappings() / fetchAllEmployeesById()
// from hikcentralPersonMappingService.ts unchanged -- this file adds only
// what that one doesn't already provide: a date-range-bounded fetch of
// raw events (split client-side into mapped vs. identified-but-unmapped,
// since the mapping join itself happens client-side exactly like the
// Person Mapping page already does -- there is no DB view/RPC for this,
// and this phase makes no schema changes), plus the two aggregate counts
// (identified-unmapped, anonymous) for display-only context.
//
// BOUNDING (explicit requirement for this phase): every query here is
// scoped to a caller-supplied Africa/Blantyre date range (never an
// unbounded `select *`), and the raw-events fetch pages exhaustively via
// `.range()` using an exact first-page count -- so a date range that
// happens to contain more rows than one page never silently truncates --
// mirroring the anti-truncation discipline already established by
// src/utils/employeeBatchFetch.ts's fetchOneBatch, without needing that
// helper's employee-id-batching machinery (this query has no IN-list).
import { supabase } from '../lib/supabase';
import { RawIdentifiedEventRow } from './hikcentralAttendancePreview';

const PAGE_SIZE = 1000;

/**
 * Every raw event with a non-blank Person No. whose `event_time` falls in
 * `[fromUtcIso, toUtcIsoExclusive)`. Anonymous (null/blank Person No.)
 * events are never fetched here -- fetchAnonymousCountInRange below
 * returns only their count, for context, never their rows.
 */
export async function fetchIdentifiedEventsInRange(fromUtcIso: string, toUtcIsoExclusive: string): Promise<RawIdentifiedEventRow[]> {
  const records: RawIdentifiedEventRow[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const wantCount = total === Infinity;
    const { data, error, count } = await supabase
      .from('hikcentral_raw_events')
      .select('hikcentral_person_no, event_time, access_point', wantCount ? { count: 'exact' } : {})
      .not('hikcentral_person_no', 'is', null)
      .neq('hikcentral_person_no', '')
      .gte('event_time', fromUtcIso)
      .lt('event_time', toUtcIsoExclusive)
      .order('event_time', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;

    const page = data || [];
    if (wantCount) total = count ?? page.length;

    if (page.length === 0) {
      if (offset < total) {
        throw new Error(`fetchIdentifiedEventsInRange: expected more rows at offset ${offset} (known total ${total}) but none were returned`);
      }
      break;
    }

    for (const row of page) {
      records.push({
        hikcentralPersonNo: row.hikcentral_person_no as string,
        eventTimeIso: row.event_time,
        accessPoint: row.access_point,
      });
    }
    offset += page.length;
  }

  return records;
}

/** Count-only, for display context -- anonymous events never enter the preview's grouping. */
export async function fetchAnonymousCountInRange(fromUtcIso: string, toUtcIsoExclusive: string): Promise<number> {
  const { count, error } = await supabase
    .from('hikcentral_raw_events')
    .select('id', { count: 'exact', head: true })
    .or('hikcentral_person_no.is.null,hikcentral_person_no.eq.')
    .gte('event_time', fromUtcIso)
    .lt('event_time', toUtcIsoExclusive);
  if (error) throw error;
  return count ?? 0;
}

