// Extracted from Employees.tsx's generateEmployeeNumber() so the pure
// computation (given a region and the highest existing matching number,
// what's the next one) is unit-testable without a database. The actual
// Supabase query (fetching the highest existing employee_number for a
// prefix) stays in Employees.tsx -- this only covers the deterministic
// part downstream of that fetch.

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
