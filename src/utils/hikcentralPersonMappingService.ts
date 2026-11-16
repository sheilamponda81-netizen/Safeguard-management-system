// HikCentral Attendance MVP -- Phase 2: Person Mapping data access.
//
// All counts/classifications shown by the Person Mapping page are
// derived from LIVE data fetched here, never hardcoded -- see
// hikcentralPersonMapping.ts for the pure classification logic this
// feeds into. Follows the same patterns already established by
// hikcentralImportService.ts (never-throws, discriminated-outcome RPC
// wrapper) and the rest of this app's direct supabase.from() queries.
import { supabase } from '../lib/supabase';
import { fetchAllPages } from './employeeBatchFetch';
import {
  IdentifiedRawEventRow,
  EmployeeLite,
  ActiveMappingRow,
} from './hikcentralPersonMapping';

/**
 * Every identified (non-blank Person No.) raw event for the caller's
 * tenant. Anonymous events are deliberately never fetched here -- this
 * function's result can never produce a mappable identity for one.
 */
export async function fetchIdentifiedRawEvents(): Promise<IdentifiedRawEventRow[]> {
  const { data, error } = await supabase
    .from('hikcentral_raw_events')
    .select('hikcentral_person_no, first_name, last_name, access_point, event_time')
    .not('hikcentral_person_no', 'is', null)
    .neq('hikcentral_person_no', '');
  if (error) throw error;
  return (data || []).map((row) => ({
    hikcentralPersonNo: row.hikcentral_person_no as string,
    firstName: row.first_name,
    lastName: row.last_name,
    accessPoint: row.access_point,
    eventTimeIso: row.event_time,
  }));
}

/** Count of anonymous (null/blank Person No.) successful raw events -- informational only, never enters mapping. */
export async function fetchAnonymousEventCount(): Promise<number> {
  const { count, error } = await supabase
    .from('hikcentral_raw_events')
    .select('id', { count: 'exact', head: true })
    .or('hikcentral_person_no.is.null,hikcentral_person_no.eq.');
  if (error) throw error;
  return count ?? 0;
}

interface EmployeeLiteRow {
  id: string;
  employee_number: string;
  full_name: string;
  workstation: string | null;
  status: string | null;
  is_deleted: boolean | null;
}

const EMPLOYEE_LITE_COLUMNS = 'id, employee_number, full_name, workstation, status, is_deleted';

function toEmployeeLite(row: EmployeeLiteRow): EmployeeLite {
  return {
    id: row.id,
    employeeNumber: row.employee_number,
    fullName: row.full_name,
    workstation: row.workstation,
    status: row.status,
    isDeleted: row.is_deleted,
  };
}

export async function fetchActiveNonDeletedEmployees(): Promise<EmployeeLite[]> {
  // PRODUCTION HOTFIX: was a single unpaginated query -- PostgREST's
  // 1000-row cap silently truncated the Active employee population
  // (already past 1000), meaning some employees' real fingerprint scans
  // could never be matched against this candidate pool. fetchAllPages()
  // (see Employees.tsx's identical fix) pages through `.range()` until
  // the server's own exact count is fully met. `id` is a unique,
  // deterministic order for stable page boundaries.
  const rows = await fetchAllPages<EmployeeLiteRow>((rangeFrom, rangeTo, withExactCount) => {
    const q = withExactCount
      ? supabase.from('employees').select(EMPLOYEE_LITE_COLUMNS, { count: 'exact' })
      : supabase.from('employees').select(EMPLOYEE_LITE_COLUMNS);
    return q
      .eq('status', 'Active')
      .or('is_deleted.is.null,is_deleted.eq.false')
      .order('id')
      .range(rangeFrom, rangeTo);
  });
  return rows.map(toEmployeeLite);
}

/**
 * ALL employees (not just active/non-deleted) keyed by id, for display
 * purposes only (e.g. the Mapped view must still show an employee whose
 * status later changed) -- never used as a candidate pool for new
 * matches, which always uses fetchActiveNonDeletedEmployees() above.
 */
export async function fetchAllEmployeesById(): Promise<Map<string, EmployeeLite>> {
  // PRODUCTION HOTFIX: was a single unpaginated query -- PostgREST's
  // 1000-row cap silently truncated the full employee population
  // (already past 1000, with no filter at all), meaning lookups for an
  // arbitrary subset of employee ids (Postgres's default row order is
  // unspecified without an explicit sort) would silently come back
  // undefined. fetchAllPages() (see Employees.tsx's identical fix) pages
  // through `.range()` until the server's own exact count is fully met.
  // `id` is a unique, deterministic order for stable page boundaries.
  const rows = await fetchAllPages<EmployeeLiteRow>((rangeFrom, rangeTo, withExactCount) => {
    const q = withExactCount
      ? supabase.from('employees').select(EMPLOYEE_LITE_COLUMNS, { count: 'exact' })
      : supabase.from('employees').select(EMPLOYEE_LITE_COLUMNS);
    return q.order('id').range(rangeFrom, rangeTo);
  });
  return new Map(rows.map((row) => [row.id, toEmployeeLite(row)]));
}

export async function fetchActiveHikCentralPersonMappings(): Promise<ActiveMappingRow[]> {
  const { data, error } = await supabase
    .from('hikcentral_person_mappings')
    .select('id, hikcentral_person_no, employee_id, match_method, confirmed_by, confirmed_at, created_at')
    .eq('is_active', true);
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    hikcentralPersonNo: row.hikcentral_person_no,
    employeeId: row.employee_id,
    matchMethod: row.match_method,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
  }));
}

/**
 * Best-effort id -> full_name lookup for the "confirmed by" display on
 * the Mapped view. profiles' own SELECT RLS only allows a caller to see
 * their OWN profile, or (as a Business Admin) their tenant's profiles --
 * a non-admin confirmer's name may therefore be invisible to a different
 * non-admin viewer, in which case that id is simply absent from the
 * returned map and the UI falls back to showing nothing rather than
 * treating this as an error.
 */
export async function fetchProfileFullNamesById(ids: string[]): Promise<Map<string, string>> {
  const distinctIds = Array.from(new Set(ids.filter(Boolean)));
  if (distinctIds.length === 0) return new Map();
  const { data, error } = await supabase.from('profiles').select('id, full_name').in('id', distinctIds);
  if (error) return new Map(); // best-effort only -- never block the page on this
  return new Map((data || []).filter((r) => r.full_name).map((r) => [r.id as string, r.full_name as string]));
}

export interface MappingConfirmationInput {
  hikcentralPersonNo: string;
  employeeId: string;
  matchMethod: 'manual' | 'suggested_name' | 'suggested_employee_number';
}

export type ConfirmMappingsOutcome = 'success' | 'unauthorized' | 'missing_rpc' | 'network_error' | 'unexpected_response';

export interface ConfirmMappingsResult {
  success: boolean;
  outcome: ConfirmMappingsOutcome;
  error?: string;
  confirmedCount?: number;
  alreadyMappedCount?: number;
}

const RPC_NOT_FOUND_CODE = 'PGRST202';

function isConfirmRpcSuccess(data: unknown): data is { confirmed_count: number; already_mapped_count: number } {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { confirmed_count?: unknown }).confirmed_count === 'number' &&
    typeof (data as { already_mapped_count?: unknown }).already_mapped_count === 'number'
  );
}

/**
 * Confirms one or more HikCentral Person No. -> employee mappings in a
 * single transactional RPC call (see
 * supabase/migrations/20261007140000_hikcentral_person_mapping_confirm_rpc.sql).
 * Every item here corresponds to an EXPLICIT human confirmation action
 * in the UI -- this function never selects or invents a mapping on its
 * own.
 */
export async function confirmHikCentralPersonMappings(
  confirmations: MappingConfirmationInput[]
): Promise<ConfirmMappingsResult> {
  try {
    const { data, error } = await supabase.rpc('confirm_hikcentral_person_mappings', {
      p_confirmations: confirmations.map((c) => ({
        hikcentral_person_no: c.hikcentralPersonNo,
        employee_id: c.employeeId,
        match_method: c.matchMethod,
      })),
    });

    if (error) {
      if (error.code === RPC_NOT_FOUND_CODE) {
        return {
          success: false,
          outcome: 'missing_rpc',
          error: 'Person Mapping confirmation is not available yet in this environment (database migration not applied).',
        };
      }
      return { success: false, outcome: 'unauthorized', error: error.message };
    }

    if (!isConfirmRpcSuccess(data)) {
      return { success: false, outcome: 'unexpected_response', error: 'Unexpected response from the server while confirming mappings.' };
    }

    return {
      success: true,
      outcome: 'success',
      confirmedCount: data.confirmed_count,
      alreadyMappedCount: data.already_mapped_count,
    };
  } catch {
    return { success: false, outcome: 'network_error', error: 'Network error while confirming mappings. Please try again.' };
  }
}
