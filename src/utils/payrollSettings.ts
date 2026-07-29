import { supabase } from '../lib/supabase';

// Default rates match what calculatePayroll previously hardcoded, so existing
// payroll math doesn't change until an admin actually edits these in Settings.
const DEFAULT_PAYE_RATE = 0.30;
const DEFAULT_PAYE_THRESHOLD = 50000;
const DEFAULT_PENSION_EMPLOYEE_RATE = 0.05;
const DEFAULT_UNIFORM_DEDUCTION = 10000;
const DEFAULT_ABSENT_DEDUCTION = 4200;
const DEFAULT_LATE_DEDUCTION = 4200;
const DEFAULT_LECTURE_DEDUCTION = 3000;
const DEFAULT_LECTURE_FULL_MONTH_DEDUCTION = 15000;
const DEFAULT_APPEARANCE_DEDUCTION = 2000;

export interface PayrollRates {
  payeRate: number;
  payeThreshold: number;
  pensionEmployeeRate: number;
  uniformDeduction: number;
  absentDeduction: number;
  lateDeduction: number;
  lectureDeduction: number;
  lectureFullMonthDeduction: number;
  appearanceDeduction: number;
}

const KEYS = {
  payeRate: 'paye_rate',
  payeThreshold: 'paye_threshold',
  pensionEmployeeRate: 'pension_employee_rate',
  uniformDeduction: 'uniform_deduction_default',
  absentDeduction: 'absent_day_deduction',
  lateDeduction: 'late_day_deduction',
  lectureDeduction: 'lecture_absence_deduction',
  lectureFullMonthDeduction: 'lecture_full_month_deduction',
  appearanceDeduction: 'appearance_deduction',
} as const;

export const DEFAULT_RATES: PayrollRates = {
  payeRate: DEFAULT_PAYE_RATE,
  payeThreshold: DEFAULT_PAYE_THRESHOLD,
  pensionEmployeeRate: DEFAULT_PENSION_EMPLOYEE_RATE,
  uniformDeduction: DEFAULT_UNIFORM_DEDUCTION,
  absentDeduction: DEFAULT_ABSENT_DEDUCTION,
  lateDeduction: DEFAULT_LATE_DEDUCTION,
  lectureDeduction: DEFAULT_LECTURE_DEDUCTION,
  lectureFullMonthDeduction: DEFAULT_LECTURE_FULL_MONTH_DEDUCTION,
  appearanceDeduction: DEFAULT_APPEARANCE_DEDUCTION,
};

// Shared, per-tenant payroll rates -- stored in `system_settings` (the same table
// and upsert pattern already proven by getSystemCurrentMonth/setSystemCurrentMonth
// in currentMonth.ts) so every admin's browser sees the same configured rates,
// instead of the Settings page's previous localStorage-only values that Payroll
// never actually read.
export const getPayrollRates = async (): Promise<PayrollRates> => {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', Object.values(KEYS));

    if (error) {
      console.error('Error fetching payroll rates:', error);
      return { ...DEFAULT_RATES };
    }

    const byKey = new Map((data || []).map(row => [row.key, row.value]));
    const parsedOrDefault = (key: string, fallback: number) => {
      const raw = byKey.get(key);
      const parsed = raw !== undefined ? parseFloat(raw) : NaN;
      return isNaN(parsed) ? fallback : parsed;
    };

    return {
      payeRate: parsedOrDefault(KEYS.payeRate, DEFAULT_PAYE_RATE),
      payeThreshold: parsedOrDefault(KEYS.payeThreshold, DEFAULT_PAYE_THRESHOLD),
      pensionEmployeeRate: parsedOrDefault(KEYS.pensionEmployeeRate, DEFAULT_PENSION_EMPLOYEE_RATE),
      uniformDeduction: parsedOrDefault(KEYS.uniformDeduction, DEFAULT_UNIFORM_DEDUCTION),
      absentDeduction: parsedOrDefault(KEYS.absentDeduction, DEFAULT_ABSENT_DEDUCTION),
      lateDeduction: parsedOrDefault(KEYS.lateDeduction, DEFAULT_LATE_DEDUCTION),
      lectureDeduction: parsedOrDefault(KEYS.lectureDeduction, DEFAULT_LECTURE_DEDUCTION),
      lectureFullMonthDeduction: parsedOrDefault(KEYS.lectureFullMonthDeduction, DEFAULT_LECTURE_FULL_MONTH_DEDUCTION),
      appearanceDeduction: parsedOrDefault(KEYS.appearanceDeduction, DEFAULT_APPEARANCE_DEDUCTION),
    };
  } catch (err) {
    console.error('Unexpected error in getPayrollRates:', err);
    return { ...DEFAULT_RATES };
  }
};

const upsertSetting = async (key: string, value: string, userId: string): Promise<boolean> => {
  const { data: existing, error: checkError } = await supabase
    .from('system_settings')
    .select('id')
    .eq('key', key)
    .maybeSingle();

  if (checkError) {
    console.error(`Error checking existing setting ${key}:`, checkError);
    return false;
  }

  const result = existing
    ? await supabase
        .from('system_settings')
        .update({ value, updated_at: new Date().toISOString(), updated_by: userId })
        .eq('id', existing.id)
    : await supabase
        .from('system_settings')
        .insert([{ key, value, updated_by: userId }]);

  if (result.error) {
    console.error(`Error saving setting ${key}:`, result.error);
    return false;
  }
  return true;
};

export const setPayrollRates = async (rates: PayrollRates, userId: string): Promise<boolean> => {
  const results = await Promise.all(
    (Object.keys(KEYS) as (keyof typeof KEYS)[]).map(field =>
      upsertSetting(KEYS[field], String(rates[field]), userId)
    )
  );
  return results.every(Boolean);
};
