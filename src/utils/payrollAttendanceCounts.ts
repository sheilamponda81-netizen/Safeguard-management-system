// Extracted from Payroll.tsx's fetchData() so the {absentDays, lateDays}
// per-employee shape the live payroll calculation consumes
// (calculateLivePayroll in payrollCalculations.ts) is independently
// unit-testable without rendering the page (this repo has no
// component-test infrastructure).
//
// Both Payroll branches now feed this from an already pre-aggregated
// {employee_id, absent_days, late_days} source -- never from raw
// `attendance` rows client-side:
//   - Historical (processed) months: the stored `employee_deductions` row
//     for that employee+month (has_permission('payslips.view') already
//     authorizes a functional-role Accountant to read this table -- see
//     20260817000002_functional_roles_indirect_region_tables.sql:252-264).
//   - Current/future (unprocessed) months: `get_payroll_attendance_counts()`
//     (supabase/migrations/20260901000000_payroll_attendance_aggregate_rpc.sql),
//     a narrow SECURITY DEFINER RPC returning the SAME
//     {employee_id, absent_days, late_days} shape, gated by payroll.view/
//     legacy role_level -- not attendance.view. This replaced a direct
//     `.from('attendance')` read that a functional-role Accountant (no
//     attendance.view grant in the seeded matrix) was silently denied by
//     RLS with zero rows and no error, understating deductions with
//     nothing in the UI indicating anything was wrong -- see
//     AUDIT_REPORT.md Findings A23/A24.

export interface AttendanceCount {
  absentDays: number;
  lateDays: number;
}

// Maps a pre-aggregated {employee_id, absent_days, late_days}[] source --
// either stored `employee_deductions` rows or
// `get_payroll_attendance_counts()` RPC rows, both share this exact shape
// -- into the Map<employeeId, AttendanceCount> the live calculation reads.
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

export interface AttendanceRpcResult {
  rows: { employee_id: string; absent_days: number; late_days: number }[];
  failed: boolean;
}

export interface AttendanceCountsState {
  counts: Map<string, AttendanceCount>;
  unavailable: boolean;
}

// Extracted from Payroll.tsx's fetchData() -- the exact decision of what
// to set attendanceCounts/attendanceCountsUnavailable to, given which
// branch this is and what the get_payroll_attendance_counts() RPC call
// returned. A historical month is ALWAYS unavailable: false, regardless
// of attendanceRpcResult -- it never depends on the live RPC (the RPC is
// not even called for a historical month; see Payroll.tsx). This is the
// fail-closed decision point: a failed RPC call for a current/future
// month must never be silently treated as "zero attendance" -- unavailable
// becomes true, which Payroll.tsx uses to block Process Payroll/Copy From
// Previous Month and show a blocking banner, rather than letting
// calculatePayroll() proceed against an empty counts map as if that were
// a legitimate zero.
export function deriveAttendanceCountsState(
  isHistoricalMonth: boolean,
  deductions: { employee_id: string; absent_days: number; late_days: number }[],
  attendanceRpcResult: AttendanceRpcResult
): AttendanceCountsState {
  if (isHistoricalMonth) {
    return { counts: countsFromDeductions(deductions), unavailable: false };
  }
  return {
    counts: countsFromDeductions(attendanceRpcResult.rows),
    unavailable: attendanceRpcResult.failed,
  };
}
