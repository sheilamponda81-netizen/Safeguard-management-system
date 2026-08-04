// Extracted from Attendance.tsx's calculateEmployeeDeductions() so the
// pure math is unit-testable without rendering the page. The original
// closed over `getAttendanceStatus` (a lookup keyed by `${employeeId}_
// ${date}` into a page-wide map); this version takes just the one
// employee's own attendance records directly and builds an equivalent
// per-date lookup internally, which is behaviorally identical since
// getAttendanceStatus only ever looked up entries for the same employee_id
// this function is already scoped to.

export interface AttendanceDeductionRecord {
  date: string;
  status: string;
}

export interface AttendanceDeductionRates {
  absentDeduction: number;
  lateDeduction: number;
  lectureDeduction: number;
  lectureFullMonthDeduction: number;
  appearanceDeduction: number;
}

export interface AttendanceDeductionResult {
  absentDays: number;
  lateDays: number;
  absentDeduction: number;
  lateDeduction: number;
  attendanceDeduction: number;
  lectureMissedCount: number;
  lectureDeduction: number;
  appearanceDeduction: number;
  totalDeductions: number;
}

/**
 * `datesInMonth` must be every calendar date string in the target month
 * (e.g. from getDatesForMonth) -- lecture days are Wednesdays/Thursdays
 * within that set, and "missed the full month" is judged against how many
 * of those lecture days actually exist in the month, not a fixed count.
 */
export function calculateAttendanceDeductions(
  employeeAttendance: AttendanceDeductionRecord[],
  datesInMonth: string[],
  rates: AttendanceDeductionRates
): AttendanceDeductionResult {
  const counts = { A: 0, L: 0 };
  employeeAttendance.forEach((record) => {
    if (record.status === 'A') counts.A++;
    if (record.status === 'L') counts.L++;
  });

  const statusByDate = new Map(employeeAttendance.map((r) => [r.date, r.status]));

  let lectureMissedCount = 0;
  datesInMonth.forEach((date) => {
    const dayOfWeek = new Date(date).getDay();
    if (dayOfWeek === 3 || dayOfWeek === 4) {
      const status = statusByDate.get(date) || '-';
      if (status === 'A') {
        lectureMissedCount++;
      }
    }
  });

  const absentDeduction = counts.A * rates.absentDeduction;
  const lateDeduction = counts.L * rates.lateDeduction;
  const attendanceDeduction = absentDeduction + lateDeduction;

  let lectureDeduction = 0;
  if (lectureMissedCount > 0) {
    const totalLectures = datesInMonth.filter((d) => {
      const dayOfWeek = new Date(d).getDay();
      return dayOfWeek === 3 || dayOfWeek === 4;
    }).length;

    lectureDeduction =
      lectureMissedCount === totalLectures && totalLectures > 0
        ? rates.lectureFullMonthDeduction
        : lectureMissedCount * rates.lectureDeduction;
  }

  const appearanceDeduction = rates.appearanceDeduction;
  const totalDeductions = attendanceDeduction + lectureDeduction + appearanceDeduction;

  return {
    absentDays: counts.A,
    lateDays: counts.L,
    absentDeduction,
    lateDeduction,
    attendanceDeduction,
    lectureMissedCount,
    lectureDeduction,
    appearanceDeduction,
    totalDeductions,
  };
}
