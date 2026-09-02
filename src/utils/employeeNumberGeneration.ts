// Extracted from Employees.tsx's generateEmployeeNumber() so the pure
// computation (given a region and the highest existing matching number,
// what's the next one) is unit-testable without a database.
//
// generateEmployeeNumberServerSide() below supersedes the plain
// browser-only calculation for anything that actually persists an
// employee: it calls generate_employee_number() (see
// supabase/migrations/20260804000001_employee_number_generation.sql), a
// row-locked, per-prefix counter that's safe under concurrent calls to
// the function itself, then falls back to the old browser-side
// "highest existing + 1" query (still using buildEmployeeNumberPrefix/
// nextEmployeeNumber below) if the RPC call fails for any reason -- e.g.
// the migration hasn't been applied to this environment yet -- so
// employee creation never hard-fails because of this call. A residual
// race window still exists between "a number is generated" and "the
// browser's INSERT for that employee reaches the database" either way;
// that gap is guarded by the existing employees UNIQUE(tenant_id,
// employee_number) constraint plus Employees.tsx's own retry-on-conflict
// logic (see the migration file's own comment for why full atomicity
// would require folding employee creation itself into the RPC).
import { supabase } from '../lib/supabase';

export interface RegionForNumbering {
  code?: string | null;
  name?: string | null;
}

/**
 * The single letter used in an employee number's prefix: the region's own
 * `code` if one is set (Settings -> Regions), otherwise the first letter
 * of the region's name, so "Northern Region" still gets "N" even before
 * anyone sets an explicit one-letter code. Falls back to "X" if a region
 * has neither.
 */
export function getRegionLetter(region: RegionForNumbering): string {
  return (region.code?.trim() || region.name?.trim() || 'X').charAt(0).toUpperCase();
}

export function buildEmployeeNumberPrefix(region: RegionForNumbering): string {
  return `SFG-${getRegionLetter(region)}-`;
}

/**
 * Given the prefix and the highest existing employee_number that already
 * matches it (or null/undefined if none exist yet in that region), returns
 * the next employee number: increments the trailing digit run and
 * zero-pads to 3 digits, or starts at 001 if nothing exists yet or the
 * existing value has no trailing digits to increment.
 */
export function nextEmployeeNumber(prefix: string, highestExisting?: string | null): string {
  let nextNumber = 1;
  if (highestExisting) {
    const match = highestExisting.match(/\d+$/);
    if (match) {
      nextNumber = parseInt(match[0], 10) + 1;
    }
  }
  return `${prefix}${nextNumber.toString().padStart(3, '0')}`;
}

async function fetchNextEmployeeNumberFromBrowser(region: RegionForNumbering): Promise<string> {
  const prefix = buildEmployeeNumberPrefix(region);
  const { data } = await supabase
    .from('employees')
    .select('employee_number')
    .ilike('employee_number', `${prefix}%`)
    .order('employee_number', { ascending: false })
    .limit(1);
  return nextEmployeeNumber(prefix, data?.[0]?.employee_number);
}

/**
 * Calls the `generate_employee_number(region_id)` Postgres function (a
 * row-locked, per-prefix counter -- see the migration referenced above)
 * so the "next number for this prefix" calculation happens in the
 * database, serialized against other concurrent calls to the same
 * function, rather than solely as an unsynchronized read in the browser.
 * Falls back to the old browser-side calculation (logging the failure)
 * if the RPC call errors -- e.g. because the migration hasn't been
 * applied to this environment yet.
 */
export async function generateEmployeeNumberServerSide(regionId: string, region: RegionForNumbering): Promise<string> {
  try {
    const { data, error } = await supabase.rpc('generate_employee_number', { p_region_id: regionId });
    if (error) throw error;
    if (typeof data === 'string' && data.length > 0) return data;
    throw new Error('generate_employee_number() returned an unexpected value');
  } catch (err) {
    console.error('generate_employee_number() RPC failed, falling back to client-side calculation:', err);
    return fetchNextEmployeeNumberFromBrowser(region);
  }
}

/**
 * Whether AddEmployeeForm's (src/pages/Employees.tsx) region-driven
 * auto-generation effect should call generateEmployeeNumberServerSide()
 * for `regionId`, given which region_id (if any) a number was already
 * generated -- or is being generated -- for (`lastGeneratedForRegionId`).
 *
 * True exactly when there IS a region AND it's not the one already
 * covered. This single rule handles two real form states identically:
 * - Form just mounted with a PRE-ASSIGNED region (a non-super-admin's
 *   region, set directly into the form's initial state rather than
 *   picked from a dropdown) -- lastGeneratedForRegionId is still null,
 *   so this returns true and generation fires once on mount.
 * - A super admin manually changes the region <select> -- the caller
 *   resets lastGeneratedForRegionId to null on every such change (see
 *   Employees.tsx's onChange handler), so this again returns true and a
 *   fresh number is generated for the new region.
 *
 * False for a re-render that leaves regionId unchanged (including one
 * caused by the earlier generation call itself finishing and writing the
 * number into form state) -- a component whose effect depends only on
 * `[region_id]` and calls this function will therefore never generate
 * twice for the same region, and never regenerate on an unrelated field
 * edit.
 */
export function shouldGenerateEmployeeNumber(
  regionId: string | null | undefined,
  lastGeneratedForRegionId: string | null
): boolean {
  return !!regionId && regionId !== lastGeneratedForRegionId;
}
