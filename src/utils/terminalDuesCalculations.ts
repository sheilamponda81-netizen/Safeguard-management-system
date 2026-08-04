// Extracted from TerminalDues.tsx's calculateTerminalDues() so the pure
// math is unit-testable without rendering the component or touching
// Supabase. The component still owns selecting the employee, showing the
// validation notification when this returns null, and building the final
// TerminalDue record shape (employee_name/employee_number/position, IDs,
// timestamps) -- this only covers the deterministic calculation itself.

export interface TerminalDuesInputs {
  hireDate: string;
  dateLeft: string;
  /** Falls back to 150000 if not provided, matching the existing `?? 150000` in TerminalDues.tsx. */
  basicSalary?: number | null;
  uniformRefund?: number;
  otherBenefits?: number;
  deductions?: number;
}

export interface TerminalDuesResult {
  periodMonths: number;
  basicSalary: number;
  gratuity: number;
  annualLeave: number;
  uniformRefund: number;
  otherBenefits: number;
  subtotal: number;
  deductions: number;
  totalPayable: number;
}

/**
 * Whole calendar months between two dates, by year/month difference (NOT
 * exact day count) -- matches the existing implementation exactly: an
 * employee hired 2024-01-15 and leaving 2024-03-01 counts as 2 months,
 * not ~1.5.
 */
export function calculateMonthsDiff(hireDate: string, dateLeft: string): number {
  const dateJoined = new Date(hireDate);
  const dateLeftObj = new Date(dateLeft);
  return (
    (dateLeftObj.getFullYear() - dateJoined.getFullYear()) * 12 +
    (dateLeftObj.getMonth() - dateJoined.getMonth())
  );
}

/**
 * Returns null if dateLeft is not after hireDate (by whole-month
 * difference) -- the caller is responsible for showing a validation
 * message in that case, matching current behavior.
 */
export function calculateTerminalDues(inputs: TerminalDuesInputs): TerminalDuesResult | null {
  const periodMonths = calculateMonthsDiff(inputs.hireDate, inputs.dateLeft);
  if (periodMonths <= 0) return null;

  const basicSalary = inputs.basicSalary ?? 150000;
  // Gratuity: 10% of basic salary per month worked.
  const gratuity = Math.round((periodMonths * basicSalary * 10) / 100);
  // Annual leave payout is a flat one month's basic salary.
  const annualLeave = basicSalary;
  const uniformRefund = Number(inputs.uniformRefund) || 0;
  const otherBenefits = Number(inputs.otherBenefits) || 0;
  const subtotal = gratuity + annualLeave + uniformRefund + otherBenefits;
  const deductions = Number(inputs.deductions) || 0;
  const totalPayable = subtotal - deductions;

  return { periodMonths, basicSalary, gratuity, annualLeave, uniformRefund, otherBenefits, subtotal, deductions, totalPayable };
}
