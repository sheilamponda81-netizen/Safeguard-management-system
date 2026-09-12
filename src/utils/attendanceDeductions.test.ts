import { describe, it, expect } from 'vitest';
import { calculateAttendanceDeductions } from './attendanceDeductions';

const rates = {
  absentDeduction: 5000,
  lateDeduction: 1000,
  lectureDeduction: 2000,
  lectureFullMonthDeduction: 15000,
  appearanceDeduction: 3000,
};

// 2024-01: Wed = 3,10,17,24,31; Thu = 4,11,18,25 -> 9 lecture days total
const januaryDates = Array.from({ length: 31 }, (_, i) => {
  const day = i + 1;
  return `2024-01-${String(day).padStart(2, '0')}`;
});

describe('calculateAttendanceDeductions', () => {
  it('counts absent and late days and multiplies by their respective rates', () => {
    const attendance = [
      { date: '2024-01-02', status: 'A' },
      { date: '2024-01-05', status: 'A' },
      { date: '2024-01-08', status: 'L' },
    ];
    const result = calculateAttendanceDeductions(attendance, januaryDates, rates);
    expect(result.absentDays).toBe(2);
    expect(result.lateDays).toBe(1);
    expect(result.absentDeduction).toBe(2 * rates.absentDeduction);
    expect(result.lateDeduction).toBe(1 * rates.lateDeduction);
    expect(result.attendanceDeduction).toBe(result.absentDeduction + result.lateDeduction);
  });

  it('ignores statuses other than A/L for absent/late counting (e.g. present, half-day, unmarked)', () => {
    const attendance = [
      { date: '2024-01-02', status: 'P' },
      { date: '2024-01-03', status: 'H' },
    ];
    const result = calculateAttendanceDeductions(attendance, januaryDates, rates);
    expect(result.absentDays).toBe(0);
    expect(result.lateDays).toBe(0);
    expect(result.attendanceDeduction).toBe(0);
  });

  it('only counts lecture-missed days that fall on Wednesday or Thursday and are marked absent', () => {
    const attendance = [
      { date: '2024-01-03', status: 'A' }, // Wed - lecture day, absent
      { date: '2024-01-02', status: 'A' }, // Tue - not a lecture day
      { date: '2024-01-04', status: 'L' }, // Thu - lecture day, but late not absent
    ];
    const result = calculateAttendanceDeductions(attendance, januaryDates, rates);
    expect(result.lectureMissedCount).toBe(1);
  });

  it('charges per-lecture-day rate when some but not all lecture days are missed', () => {
    const attendance = [
      { date: '2024-01-03', status: 'A' }, // 1 of 9 lecture days in January 2024
    ];
    const result = calculateAttendanceDeductions(attendance, januaryDates, rates);
    expect(result.lectureMissedCount).toBe(1);
    expect(result.lectureDeduction).toBe(1 * rates.lectureDeduction);
  });

  it('charges the flat full-month lecture rate instead of per-day when every lecture day in the month is missed', () => {
    const lectureDates = januaryDates.filter((d) => {
      const dow = new Date(d).getDay();
      return dow === 3 || dow === 4;
    });
    expect(lectureDates.length).toBe(9);
    const attendance = lectureDates.map((date) => ({ date, status: 'A' }));
    const result = calculateAttendanceDeductions(attendance, januaryDates, rates);
    expect(result.lectureMissedCount).toBe(9);
    expect(result.lectureDeduction).toBe(rates.lectureFullMonthDeduction);
  });

  it('charges no lecture deduction when no lecture days are missed', () => {
    const result = calculateAttendanceDeductions([], januaryDates, rates);
    expect(result.lectureMissedCount).toBe(0);
    expect(result.lectureDeduction).toBe(0);
  });

  it('applies the flat appearance deduction regardless of attendance', () => {
    const result = calculateAttendanceDeductions([], januaryDates, rates);
    expect(result.appearanceDeduction).toBe(rates.appearanceDeduction);
  });

  it('sums attendance + lecture + appearance deductions into totalDeductions', () => {
    const attendance = [
      { date: '2024-01-02', status: 'A' },
      { date: '2024-01-08', status: 'L' },
      { date: '2024-01-03', status: 'A' }, // also a lecture day
    ];
    const result = calculateAttendanceDeductions(attendance, januaryDates, rates);
    expect(result.totalDeductions).toBe(
      result.attendanceDeduction + result.lectureDeduction + result.appearanceDeduction
    );
  });

  it('handles an employee with no attendance records at all (only fixed appearance deduction applies)', () => {
    const result = calculateAttendanceDeductions([], januaryDates, rates);
    expect(result.absentDays).toBe(0);
    expect(result.lateDays).toBe(0);
    expect(result.attendanceDeduction).toBe(0);
    expect(result.lectureDeduction).toBe(0);
    expect(result.totalDeductions).toBe(rates.appearanceDeduction);
  });

  it('handles a month with no Wednesdays or Thursdays in datesInMonth without dividing by zero', () => {
    // A single Monday -- no lecture days present in the range at all.
    const result = calculateAttendanceDeductions([], ['2024-01-01'], rates);
    expect(result.lectureMissedCount).toBe(0);
    expect(result.lectureDeduction).toBe(0);
  });
});
