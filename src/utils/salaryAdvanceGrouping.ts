// Pure helpers for SalaryAdvances.tsx's employee-grouped main list.
// Advances themselves stay independent database records -- these only
// decide (a) which employees qualify for a row given the current
// search/status filter, and (b) how to summarize a truthful MIX of
// per-advance statuses into one label, without ever collapsing an
// employee's real financial state (that stays getEmployeeAdvanceSummary()'s
// job, unchanged, computed from the FULL advances set, never the filtered
// one -- see SalaryAdvances.tsx's own qualifyingEmployeeIds usage).

// Preserves first-seen order (the underlying `advances` fetch is already
// created_at DESC, so this naturally surfaces an employee at the position
// of their MOST RECENT matching advance) while ensuring one employee_id
// appears exactly once, however many of their advances matched the
// current search/status filter.
export function getQualifyingEmployeeIds<T extends { employee_id: string }>(filteredRows: T[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  filteredRows.forEach(row => {
    if (!seen.has(row.employee_id)) {
      seen.add(row.employee_id);
      order.push(row.employee_id);
    }
  });
  return order;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildStatusLabel(statuses: string[], order: readonly string[]): string {
  const counts = new Map<string, number>();
  statuses.forEach(s => counts.set(s, (counts.get(s) || 0) + 1));
  return order
    .filter(s => counts.has(s))
    .map(s => {
      const n = counts.get(s) as number;
      const label = capitalize(s);
      return n > 1 ? `${n} ${label}` : label;
    })
    .join(' + ');
}

const OPEN_STATUS_ORDER = ['active', 'pending'] as const;
const CLOSED_STATUS_ORDER = ['paid', 'rejected', 'cancelled'] as const;

// Truthfully represents a MIX of an employee's advance statuses -- never
// picks one status and silently hides another open one. An employee with
// one active and one pending advance reads "Active + Pending", not just
// "Pending" or just "Active"; two active advances read "2 Active". Once
// an employee has zero OPEN (pending/active) advances left, falls back to
// summarizing whatever closed statuses (paid/rejected/cancelled) are
// present, using the exact same pattern -- so filtering the main table by
// e.g. "Rejected" and finding an employee whose only advance was rejected
// still shows a truthful, non-empty label.
export function summarizeAdvanceStatuses(statuses: string[]): string {
  const openLabel = buildStatusLabel(statuses, OPEN_STATUS_ORDER);
  if (openLabel) return openLabel;
  return buildStatusLabel(statuses, CLOSED_STATUS_ORDER) || 'No Advances';
}

// A single "dominant" status used ONLY to pick one badge accent color for
// the mixed-status label above -- never used to decide the label's TEXT,
// which must show the real mix. Priority puts whatever most needs
// attention first (a pending request, then active debt) ahead of terminal
// states.
export function getDominantStatusForColor(statuses: string[]): string {
  const priority = ['pending', 'active', 'paid', 'rejected', 'cancelled'];
  const present = new Set(statuses);
  return priority.find(s => present.has(s)) || 'cancelled';
}

// "No slots available" (0 remaining) / "1 slot available" / "N slots
// available" -- derived from the SAME open-advance definition
// create_salary_advance() enforces server-side (pending + active count
// toward the max), never a separately-invented rule. A closed (paid/
// rejected/cancelled) advance never occupies a slot.
export function getSlotsAvailableLabel(openCount: number, maxSlots: number): string {
  const available = Math.max(0, maxSlots - openCount);
  if (available === 0) return 'No slots available';
  return `${available} slot${available === 1 ? '' : 's'} available`;
}
