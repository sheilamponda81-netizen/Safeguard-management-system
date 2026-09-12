// Pure helpers enforcing "one open (pending/approved) Terminal Due per
// employee" at the UI layer. The real authority is the database's partial
// unique index (migration 20260906000000_terminal_dues_one_open_per_employee.sql,
// idx_terminal_dues_one_open_per_employee) -- these functions only drive
// employee-selector disabling and duplicate-attempt messaging, and must
// never be relied on alone (a client-side check always has a race window;
// see that migration's header for why).

export interface OpenDueLookupRow {
  employee_id: string;
  status: string;
}

// Maps employee_id -> its open status, from whatever terminal_dues rows
// are currently loaded. An employee with only a Paid row (or no rows at
// all) is absent from the map -- Paid never blocks a new calculation,
// matching the database constraint's own WHERE clause exactly.
export function buildOpenDueStatusMap(rows: OpenDueLookupRow[]): Map<string, 'pending' | 'approved'> {
  const map = new Map<string, 'pending' | 'approved'>();
  for (const row of rows) {
    if (row.status === 'pending' || row.status === 'approved') {
      map.set(row.employee_id, row.status);
    }
  }
  return map;
}

export function getOpenDueLabel(status: 'pending' | 'approved' | undefined): string | null {
  if (status === 'pending') return 'Existing Pending Terminal Due';
  if (status === 'approved') return 'Existing Approved Terminal Due';
  return null;
}

export const DUPLICATE_OPEN_DUE_MESSAGE = 'This employee already has an open Terminal Due.';

// Recognizes the specific unique-index violation this feature depends on
// (Postgres SQLSTATE 23505, and the constraint name itself present in the
// error text) rather than any 23505 on this table in general -- deliberately
// narrow so an unrelated future unique constraint on terminal_dues doesn't
// get mislabeled with this message.
export function isOpenDueUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  if ((error as { code: unknown }).code !== '23505') return false;
  const message = 'message' in error ? String((error as { message: unknown }).message ?? '') : '';
  return message.includes('idx_terminal_dues_one_open_per_employee');
}
