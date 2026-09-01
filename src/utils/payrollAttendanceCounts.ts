// Extracted from Payroll.tsx's fetchData() so the two sources of
// {absentDays, lateDays} per employee -- live raw `attendance` rows for
// the current/future branch, and stored `employee_deductions` rows for
// the historical branch -- are independently unit-testable without
// rendering the page (this repo has no component-test infrastructure).
//
// Why two sources exist at all: a historical/processed month's payroll
// figures are already frozen in the `payroll` row itself; this shape is
// used only for the decorative "Absent: N x MK4,200" breakdown tooltip
// next to that already-correct figure, never to recompute it. For that
// tooltip, employee_deductions.absent_days/late_days is available to a
// functional-role Accountant (via has_permission('payslips.view'), see
// 20260817000002_functional_roles_indirect_region_tables.sql:252-264),
// while raw `attendance` is not (Accountant has no attendance.view grant
// in the seeded matrix, 20260817000000:315-333). For the current/future
// (unprocessed) branch, this shape instead DRIVES the live-preview
// deduction calculation itself (see calculateLivePayroll in
// payrollCalculations.ts), so it still reads raw `attendance` there --
// switching that branch to employee_deductions would trade correctness
// for authorization convenience, see this repo's AUDIT_REPORT.md Finding
// A23 for why that tradeoff is deliberately NOT made here.

export interface AttendanceCount {
  absentDays: number;
  lateDays: number;
}

// Current/future branch: one row per attendance-marked day, `status`
// 'A' (absent) or 'L' (late) among others -- summed into a day count per
// employee. An RLS-denied read (Accountant, current month) resolves to
// an empty array here, not an error -- see this function's caller in
// Payroll.tsx and AUDIT_REPORT.md Finding A23 for the resulting
// silently-zeroed-deduction risk this does NOT protect against on its
// own; this function only shapes whatever rows it's given.
export function countsFromRawAttendance(rows: { employee_id: string; status: string }[]): Map<string, AttendanceCount> {
  const counts = new Map<string, AttendanceCount>();
  rows.forEach(record => {
    const existing = counts.get(record.employee_id) || { absentDays: 0, lateDays: 0 };
    if (record.status === 'A') existing.absentDays += 1;
    if (record.status === 'L') existing.lateDays += 1;
    counts.set(record.employee_id, existing);
  });
  return counts;
}

// Historical branch: one row per employee+month, already carrying the
// day counts directly (employee_deductions.absent_days/late_days) --
// no per-day rows to sum, just a direct mapping.
export function countsFromDeductions(deductions: { employee_id: string; absent_days: number; late_days: number }[]): Map<string, AttendanceCount> {
  const counts = new Map<string, AttendanceCount>();
  deductions.forEach(deduction => {
    counts.set(deduction.employee_id, {
      absentDays: deduction.absent_days || 0,
      lateDays: deduction.late_days || 0,
    });
  });
  return counts;
}
