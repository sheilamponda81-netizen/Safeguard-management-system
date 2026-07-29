import { PayrollRates } from './payrollSettings';

export interface AttendanceCount {
  absentDays: number;
  lateDays: number;
}

export interface LivePayrollInputs {
  basicSalary: number;
  allowances?: number;
  overtime?: number;
  bonus?: number;
  position: string;
  employeeUniformDeduction?: number | null;
  positionsRequiringUniform: Map<string, boolean>;
  payrollRates: PayrollRates;
  attendance?: AttendanceCount;
  lectureDeduction?: number;
  appearanceDeduction?: number;
}

export interface LivePayrollResult {
  grossPay: number;
  paye: number;
  pension: number;
  uniformDeduction: number;
  netPay: number;
}

// Single source of truth for "what would this employee's payroll look like right
// now" -- used by Payroll.tsx (before a month is processed) and by Payments.tsx
// (as the live estimate shown before an approved payroll run exists), so the two
// pages never disagree about an unprocessed month's numbers.
export function calculateLivePayroll(inputs: LivePayrollInputs): LivePayrollResult {
  const allowances = inputs.allowances ?? 0;
  const overtime = inputs.overtime ?? 0;
  const bonus = inputs.bonus ?? 0;
  const grossPay = inputs.basicSalary + allowances + overtime + bonus;

  const paye = Math.round(Math.max(0, grossPay - inputs.payrollRates.payeThreshold) * inputs.payrollRates.payeRate);
  const pension = Math.round(grossPay * inputs.payrollRates.pensionEmployeeRate);

  const positionRequiresUniform = inputs.positionsRequiringUniform.get(inputs.position) ?? true;
  const uniformDeductionValue = positionRequiresUniform ? (inputs.employeeUniformDeduction ?? inputs.payrollRates.uniformDeduction) : 0;

  const absentDays = inputs.attendance?.absentDays || 0;
  const lateDays = inputs.attendance?.lateDays || 0;
  const absentDeduction = absentDays * inputs.payrollRates.absentDeduction;
  const lateDeduction = lateDays * inputs.payrollRates.lateDeduction;
  const lectureDeduction = inputs.lectureDeduction || 0;
  const appearanceDeduction = inputs.appearanceDeduction || 0;
  const totalAttendanceDeductions = absentDeduction + lateDeduction + lectureDeduction + appearanceDeduction;
  const totalUniformDeduction = uniformDeductionValue + totalAttendanceDeductions;

  const netPay = grossPay - paye - pension - totalUniformDeduction;

  return { grossPay, paye, pension, uniformDeduction: totalUniformDeduction, netPay };
}
