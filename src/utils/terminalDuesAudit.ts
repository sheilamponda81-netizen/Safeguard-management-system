// Pure formatting helpers for Terminal Dues' approval/payment audit trail
// (separation-of-duties migration, 20260905000000). A terminal due Approved
// or Paid BEFORE this audit trail existed legitimately has NULL
// approved_by/approved_at/payment_* columns -- these must read as an
// honest "not recorded", never a fabricated value and never a blank string
// that looks like a rendering bug.

export function formatAuditTimestamp(value: string | null): string {
  if (!value) return 'Recorded before payment audit trail';
  return new Date(value).toLocaleString();
}

export function formatAuditValue(value: string | null): string {
  if (!value) return '—';
  return value;
}
