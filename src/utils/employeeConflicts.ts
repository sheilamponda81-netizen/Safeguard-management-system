import { supabase } from '../lib/supabase';

export interface EmployeeConflictRow {
  id: string;
  full_name: string;
  employee_number: string;
  workstation: string | null;
  status: string | null;
  is_deleted: boolean;
}

export interface IdentifierConflict {
  label: string;
  column: string;
  value: string;
  rows: EmployeeConflictRow[];
}

interface IdentifierInput {
  column: string;
  label: string;
  value: string | null | undefined;
}

const CONFLICT_SELECT = 'id, full_name, employee_number, workstation, status, is_deleted';

// Blank/null identifiers are never a conflict -- Account Number, Phone, and
// National ID can all be left empty on this form, and an empty string must
// never be treated as a value every other blank-field employee "shares".
function isBlank(value: string | null | undefined): boolean {
  return value == null || String(value).trim() === '';
}

// Returns EVERY existing employee sharing a given identifier, not just the
// first one -- historical data (recorded before any conflict check existed)
// may already have more than one match, and silently showing only whichever
// row the database happens to return first would hide the rest.
async function findConflictRows(column: string, value: string, excludeEmployeeId?: string): Promise<EmployeeConflictRow[]> {
  let query = supabase.from('employees').select(CONFLICT_SELECT).eq(column, value);
  if (excludeEmployeeId) {
    query = query.neq('id', excludeEmployeeId);
  }
  const { data, error } = await query;
  if (error) {
    console.error(`Error checking ${column} conflicts:`, error);
    return [];
  }
  return (data || []) as EmployeeConflictRow[];
}

// Checked WITHOUT an is_deleted filter -- the RLS SELECT policy on
// `employees` is tenant-scoped only (see 20260727000000_reconstructed_base_schema.sql,
// "Users can view employees in their tenant"), with no is_deleted
// restriction, so soft-deleted/inactive owners are already visible to any
// authenticated tenant user who can reach this page. Excluding them from
// this lookup was the actual production bug: staff got a generic "already
// exists" message and could never find the person, because the normal
// employee search hides deleted rows even though the identifier itself was
// still taken.
//
// excludeEmployeeId preserves the existing "don't conflict with yourself"
// behavior during an edit -- an employee keeping their own unchanged
// National ID/Phone/Account Number must never be reported as its own
// conflict.
export async function checkEmployeeIdentifierConflicts(
  identifiers: { nationalId?: string | null; phone?: string | null; accountNumber?: string | null },
  excludeEmployeeId?: string
): Promise<IdentifierConflict[]> {
  const inputs: IdentifierInput[] = [
    { column: 'national_id', label: 'National ID', value: identifiers.nationalId },
    { column: 'phone', label: 'Phone number', value: identifiers.phone },
    { column: 'account_number', label: 'Account number', value: identifiers.accountNumber },
  ];

  const results = await Promise.all(
    inputs.map(async (input) => {
      if (isBlank(input.value)) return null;
      const value = String(input.value).trim();
      const rows = await findConflictRows(input.column, value, excludeEmployeeId);
      if (rows.length === 0) return null;
      return { label: input.label, column: input.column, value, rows } as IdentifierConflict;
    })
  );

  return results.filter((r): r is IdentifierConflict => r !== null);
}

function describeConflictRow(row: EmployeeConflictRow): string {
  const site = row.workstation && row.workstation.trim() !== '' ? row.workstation : 'no site on record';
  const statusLabel = row.status && row.status.trim() !== '' ? row.status : 'Unknown';
  const statusPart = row.is_deleted ? `${statusLabel} (Deleted)` : statusLabel;
  return `${row.full_name} (${row.employee_number}), ${site}, status ${statusPart}`;
}

// Renders every conflicting identifier AND every matching employee under
// each one -- never truncates to "the first match" on either axis. Both a
// single save having multiple simultaneous conflicts (e.g. National ID AND
// Phone both taken by different people) and a single field matching more
// than one historical record are real possibilities this message must
// surface, not hide.
export function formatIdentifierConflictMessage(conflicts: IdentifierConflict[]): string {
  return conflicts
    .map((conflict) => {
      const owners = conflict.rows.map(describeConflictRow).join('; ');
      return `${conflict.label} ${conflict.value} is already assigned to ${owners}.`;
    })
    .join(' ');
}

// Best-effort mapping from a raw Postgres unique_violation (23505) back to
// one of our known identifier columns, so a post-insert/update handler can
// show the same named message instead of the raw Postgres constraint text.
//
// IMPORTANT: as of this hotfix there is NO database-level UNIQUE constraint
// on national_id, phone, or account_number -- the only real constraint on
// `employees` is UNIQUE (tenant_id, employee_number) (see
// 20260727000000_reconstructed_base_schema.sql). So in production today
// this will only ever fire for employee_number (already handled separately
// by its own retry loop) or for a constraint a future migration adds. This
// function exists for forward-compatibility and defense in depth -- it does
// NOT make identifier uniqueness race-safe today. Closing that gap for real
// requires an additive unique index plus a production duplicate audit
// beforehand, which is a separate, deliberately out-of-scope follow-up for
// this hotfix.
export function identifierColumnFromUniqueViolation(error: { message?: string } | null | undefined): 'national_id' | 'phone' | 'account_number' | null {
  const message = error?.message || '';
  if (/national_id/i.test(message)) return 'national_id';
  if (/account_number/i.test(message)) return 'account_number';
  // Plain substring match, deliberately excluding `next_of_kin_phone` --
  // Postgres's default constraint-naming convention (<table>_<column>_key)
  // means "phone" sits between underscores either way, so a \b word-
  // boundary check (which underscores don't create) can't tell them apart;
  // an explicit exclusion is the simplest correct fix.
  if (/phone/i.test(message) && !/next_of_kin_phone/i.test(message)) return 'phone';
  return null;
}
